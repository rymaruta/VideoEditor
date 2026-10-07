import { create } from 'zustand'
import { mediaIssues, type QcMeasurement } from '@shared/qc/media'
import { sortIssues, telopIssues } from '@shared/qc/telop'
import type { QcIssue } from '@shared/qc/types'
import { parseDictionary } from '@shared/telop/polish'
import { textCanvasSize } from '@shared/resolution'
import type { LoudnessTarget } from '@shared/loudness'
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
  run: (path: string, loudness: LoudnessTarget | 'off') => Promise<void>
  cancel: () => void
}

function telopCheck(): QcIssue[] {
  const project = useProjectStore.getState().project
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

export const useQcStore = create<QcState>((set, get) => ({
  report: null,
  run: async (path, loudness) => {
    const token = runToken
    // 文字の幅を測るので、書き出しと同じ書体が読み込まれてから
    await document.fonts?.ready
    if (token !== runToken) return
    const telop = telopCheck()
    set({
      report: { path, state: 'run', percent: 0, issues: sortIssues(telop), measurement: null }
    })
    const off = window.api.onQcProgress((percent) => {
      const r = get().report
      if (r?.path === path && r.state === 'run') set({ report: { ...r, percent } })
    })
    try {
      const measurement = await window.api.qcMeasure(path)
      // 測っている間に別のプロジェクトを開いたなら、前のプロジェクトの結果を書かない
      if (token !== runToken) return
      set({
        report: {
          path,
          state: 'done',
          percent: 100,
          issues: sortIssues([...mediaIssues(measurement, loudness), ...telop]),
          measurement
        }
      })
    } catch (e) {
      const message = formatIpcError(e)
      const r = get().report
      if (token !== runToken || r?.path !== path) return
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
