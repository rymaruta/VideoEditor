import { create } from 'zustand'
import { mediaIssues, type QcMeasurement } from '@shared/qc/media'
import { sortIssues, telopIssues } from '@shared/qc/telop'
import type { QcIssue } from '@shared/qc/types'
import { parseDictionary } from '@shared/telop/polish'
import { textCanvasSize } from '@shared/resolution'
import type { LoudnessTarget } from '@shared/loudness'
import { exportToTimelineTime } from '@shared/exportTimeline'
import { computeMainTrackLayout } from '@shared/mainTrackLayout'
import { overlayClipEnd } from '@shared/overlayClip'
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
  /**
   * この確認を始めるために止めた、前の書き出しの確認のファイル(書き出しの直後に次の書き出しを始めたとき)。
   * 止めた確認の結果は出ないので、止めたことを画面に残す
   */
  stopped?: string
}

interface QcState {
  report: QcReport | null
  /**
   * `project`: 書き出したときのプロジェクト(書き出しの最中に直したテロップで確認しない)。
   * `range`: 範囲だけを書き出したときの範囲(タイムラインの秒)と、書き出しの中での始まり(秒)。
   * ファイルの 0 秒は範囲の始まりなので、指摘の時刻をそのぶん後ろへずらし、テロップは範囲の中だけを見る
   */
  run: (
    path: string,
    loudness: LoudnessTarget | 'off',
    project?: Project,
    range?: QcRange
  ) => Promise<void>
  cancel: () => void
  /**
   * 次の書き出しを始める前に、前の書き出しの確認を止める(終わるまで待つ)。確認は結果を捨てるのに、
   * 次の書き出しと CPU を取り合い、書き出しが遅くなっていた(試し編集 第3回: ショート 24.1 → 40.6 秒)。
   * 止めたことは、次の書き出しの確認の欄に「止めました」と出す(続けて書き出したときと同じ)
   */
  stopForExport: (options?: {
    /**
     * 止めたことを次の確認の欄に出す(既定)。自動のショート(確認をしない書き出し)は false にする
     * (出すと、次の手動の書き出しの確認に、関係の無い「止めました」が残っていた)
     */
    note?: boolean
  }) => Promise<void>
}

/** 範囲だけを書き出したときの範囲 */
export interface QcRange {
  start: number
  end: number
  /** 書き出し(繋ぎのぶん縮んだ秒)の中での範囲の始まり */
  exportStart: number
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
/** 測っている最中の確認のファイル */
let measuringPath: string | null = null
/** 次の書き出しを始めるために止めた確認のファイル(次の確認の欄に「止めました」と出す) */
let stoppedForExport: string | null = null
/**
 * 始めたが、まだ測り始めていない確認のファイル(書体の読み込み・前の確認の終わりを待っている間)。
 * この間に次の書き出しを始めたら、測り始める前に止める(前は測っている最中しか止められず、待っている間に
 * 止めようとすると、書き出しの最中に測り始めていた)
 */
let startingPath: string | null = null

/**
 * ファイルの秒で返る映像・音声の指摘を、タイムラインの秒へ直す(テロップの指摘・移る先と同じ秒)。
 * 繋ぎのぶんファイルが短いので、直さないと押したときに手前へずれていた
 */
function toTimelineIssues(issues: QcIssue[], project: Project, fileOffset = 0): QcIssue[] {
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
    exportToTimelineTime(t + fileOffset, layout.timelineStarts, layout.exportStarts)
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
    .map((c) => [c.startTime, overlayClipEnd(c)] as const)
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
  run: async (path, loudness, exported, range) => {
    // 書き出したプロジェクトが、もう開いているプロジェクトでなければ確かめない(前のプロジェクトの
    // 結果を今のプロジェクトに出さない)
    if (exported && exported.id !== useProjectStore.getState().project.id) return
    const token = runToken
    const call = ++runCall
    startingPath = path
    const project = exported ?? useProjectStore.getState().project
    // 前の書き出しの確認がまだ測っているなら止めて、終わるのを待つ(main は1つずつしか測らないので、
    // 新しい確認は「実行中です」で失敗し、あとから前のファイルの結果で上書きされていた)
    let stopped: string | undefined = stoppedForExport ?? undefined
    stoppedForExport = null
    if (measuring) {
      stopped = measuringPath ?? stopped
      void window.api.qcCancel()
      await measuring.catch(() => {})
    }
    // 文字の幅を測るので、書き出しと同じ書体が読み込まれてから
    await document.fonts?.ready
    if (token !== runToken || call !== runCall) return
    startingPath = null
    const telop = telopCheck(project).filter(
      (i) => !range || (i.end > range.start && i.start < range.end)
    )
    set({
      report: {
        path,
        state: 'run',
        percent: 0,
        issues: sortIssues(telop),
        measurement: null,
        ...(stopped && stopped !== path ? { stopped } : {})
      }
    })
    const off = window.api.onQcProgress((percent) => {
      if (call !== runCall) return
      const r = get().report
      if (r?.path === path && r.state === 'run') set({ report: { ...r, percent } })
    })
    try {
      const pending = window.api.qcMeasure(path)
      measuring = pending
      measuringPath = path
      let measurement: QcMeasurement
      try {
        measurement = await pending
      } finally {
        if (measuring === pending) {
          measuring = null
          measuringPath = null
        }
      }
      // 測っている間に別のプロジェクトを開いた・次の確認が始まったなら、前の結果を書かない
      if (token !== runToken || call !== runCall) return
      const stoppedNote = get().report?.stopped
      set({
        report: {
          ...(stoppedNote ? { stopped: stoppedNote } : {}),
          path,
          state: 'done',
          percent: 100,
          issues: sortIssues([
            ...withoutStillOverlayFreezes(
              toTimelineIssues(mediaIssues(measurement, loudness), project, range?.exportStart),
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
  },
  stopForExport: async (options = {}) => {
    const pending = measuring
    const starting = startingPath
    if (!pending && !starting) return
    if (options.note !== false) stoppedForExport = measuringPath ?? starting
    // 止めた確認の欄は残さない(結果は出ない。次の確認の欄に止めたことを出す)。測り始める前の確認は、
    // 番号が替わったので測り始めない
    runCall++
    startingPath = null
    set({ report: null })
    if (!pending) return
    void window.api.qcCancel()
    await pending.catch(() => {})
  }
}))

// 確認の結果はそのプロジェクトの書き出しのもの。別のプロジェクトを開いたら捨てる
// (残すと、書き出しの画面に前のプロジェクトの指摘が出て、押すと今のプロジェクトの別の時刻へ飛んでいた)
onProjectSwitch(() => {
  runToken++
  stoppedForExport = null
  startingPath = null
  if (useQcStore.getState().report?.state === 'run') void window.api.qcCancel()
  useQcStore.setState({ report: null })
})
