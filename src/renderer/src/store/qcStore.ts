import { create } from 'zustand'
import { mediaIssues, type QcMeasurement } from '@shared/qc/media'
import { sortIssues, telopIssues } from '@shared/qc/telop'
import type { QcIssue } from '@shared/qc/types'
import { parseDictionary } from '@shared/telop/polish'
import { textCanvasSize } from '@shared/resolution'
import type { LoudnessTarget } from '@shared/loudness'
import { exportToTimelineTime } from '@shared/exportTimeline'
import { computeMainTrackLayout } from '@shared/mainTrackLayout'
import { projectFrameRate } from '@shared/frameRate'
import type { Project } from '@shared/types'
import { onProjectSwitch, useProjectStore } from './projectStore'
import { useSettingsStore } from './settingsStore'
import { formatIpcError } from '../lib/ipcError'

/**
 * 書き出し後の自動確認(計画書 §5.12)。結果は覚えておき、書き出しダイアログを開き直しても見られる。
 * 項目を押すとその位置へ移る(ダイアログの外で直してから、また書き出す流れ)。
 */

export interface QcReport {
  path: string
  state: 'run' | 'done' | 'error'
  percent: number
  issues: QcIssue[]
  measurement: QcMeasurement | null
  error?: string
}

interface QcState {
  report: QcReport | null
  /** `project`: 書き出したときのプロジェクト(書き出しの最中に直したテロップで確認しない) */
  run: (path: string, loudness: LoudnessTarget | 'off', project?: Project) => Promise<void>
  cancel: () => void
}

function telopCheck(project: Project): QcIssue[] {
  const settings = useSettingsStore.getState()
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return []
  return telopIssues(project.textOverlays, ctx, textCanvasSize(project.aspectRatio), {
    bannedWords: settings.qcWords.split(/\r?\n/),
    dictionary: parseDictionary(settings.telopDictionary)
  })
}

/** プロジェクトを替えるたびに増やす(前のプロジェクトの確認結果を、替えた後に書かない) */
let runToken = 0
/** 確認を始めるたびに増やす(前の確認の結果を、後から始めた確認の上に書かない) */
let runCall = 0
/** 測っている最中の確認(次の確認は、これを止めて終わるのを待ってから始める) */
let measuring: Promise<unknown> | null = null

/**
 * ファイルの秒で返る映像・音声の指摘を、タイムラインの秒へ直す(テロップの指摘・移る先と同じ秒)。
 * 繋ぎのぶんファイルが短いので、直さないと押したときに手前へずれていた
 */
function toTimelineIssues(issues: QcIssue[], project: Project): QcIssue[] {
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const clips = project.clips.filter((c) => assets.has(c.assetId))
  if (clips.length === 0) return issues
  const layout = computeMainTrackLayout(
    clips,
    projectFrameRate(
      clips,
      clips.map((c) => assets.get(c.assetId)!)
    )
  )
  const map = (t: number): number =>
    exportToTimelineTime(t, layout.timelineStarts, layout.exportStarts)
  return issues.map((i) => ({ ...i, start: map(i.start), end: Math.max(map(i.start), map(i.end)) }))
}

/**
 * 全面に重ねた静止画(版面CG など)を出している間の「画が止まっています」は外す。静止画を出しているので
 * 止まって見えるのは当たり前で、自動の CG を置くたびにその数だけ誤った指摘が出ていた。
 * 止まっている時間の半分以上を、表示中の全面の静止画が覆っていれば外す
 */
export function withoutStillOverlayFreezes(issues: QcIssue[], project: Project): QcIssue[] {
  const stills = new Set(project.assets.filter((a) => a.still).map((a) => a.id))
  const spans = project.videoOverlayTracks
    .filter((t) => !t.hidden && t.position === 'full')
    .flatMap((t) => t.clips)
    .filter((c) => stills.has(c.assetId))
    .map((c) => [c.startTime, c.startTime + (c.outPoint - c.inPoint)] as const)
  if (spans.length === 0) return issues
  return issues.filter((i) => {
    if (i.kind !== 'freeze') return true
    const len = i.end - i.start
    const covered = spans.reduce(
      (sum, [a, b]) => sum + Math.max(0, Math.min(b, i.end) - Math.max(a, i.start)),
      0
    )
    return !(len > 0 && covered >= len / 2)
  })
}

export const useQcStore = create<QcState>((set, get) => ({
  report: null,
  run: async (path, loudness, exported) => {
    // 書き出したプロジェクトが、もう開いているプロジェクトでなければ確かめない(前のプロジェクトの
    // 結果を今のプロジェクトに出さない)
    if (exported && exported.id !== useProjectStore.getState().project.id) return
    const token = runToken
    const call = ++runCall
    const project = exported ?? useProjectStore.getState().project
    // 前の書き出しの確認がまだ測っているなら止めて、終わるのを待つ(main は1つずつしか測らないので、
    // 新しい確認は「実行中です」で失敗し、あとから前のファイルの結果で上書きされていた)
    if (measuring) {
      void window.api.qcCancel()
      await measuring.catch(() => {})
    }
    // 文字の幅を測るので、書き出しと同じ書体が読み込まれてから
    await document.fonts?.ready
    if (token !== runToken || call !== runCall) return
    const telop = telopCheck(project)
    set({
      report: { path, state: 'run', percent: 0, issues: sortIssues(telop), measurement: null }
    })
    const off = window.api.onQcProgress((percent) => {
      if (call !== runCall) return
      const r = get().report
      if (r?.path === path && r.state === 'run') set({ report: { ...r, percent } })
    })
    try {
      const pending = window.api.qcMeasure(path)
      measuring = pending
      let measurement: QcMeasurement
      try {
        measurement = await pending
      } finally {
        if (measuring === pending) measuring = null
      }
      // 測っている間に別のプロジェクトを開いた・次の確認が始まったなら、前の結果を書かない
      if (token !== runToken || call !== runCall) return
      set({
        report: {
          path,
          state: 'done',
          percent: 100,
          issues: sortIssues([
            ...withoutStillOverlayFreezes(
              toTimelineIssues(mediaIssues(measurement, loudness), project),
              project
            ),
            ...telop
          ]),
          measurement
        }
      })
    } catch (e) {
      const message = formatIpcError(e)
      const r = get().report
      if (token !== runToken || call !== runCall || r?.path !== path) return
      set({
        report: message.includes('QC_CANCELED')
          ? null
          : { ...r, state: 'error', error: `映像・音声の確認ができませんでした: ${message}` }
      })
    } finally {
      off()
    }
  },
  cancel: () => {
    void window.api.qcCancel()
  }
}))

// 確認の結果はそのプロジェクトの書き出しのもの。別のプロジェクトを開いたら捨てる
// (残すと、書き出しの画面に前のプロジェクトの指摘が出て、押すと今のプロジェクトの別の時刻へ飛んでいた)
onProjectSwitch(() => {
  runToken++
  if (useQcStore.getState().report?.state === 'run') void window.api.qcCancel()
  useQcStore.setState({ report: null })
})
