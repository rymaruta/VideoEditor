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

let qcRunToken = 0

export const useQcStore = create<QcState>((set, get) => ({
  report: null,
  run: async (path, loudness) => {
    const token = ++qcRunToken
    // 文字の幅を測るので、書き出しと同じ書体が読み込まれてから
    await document.fonts?.ready
    if (token !== qcRunToken) return
    const telop = telopCheck()
    set({
      report: { path, state: 'run', percent: 0, issues: sortIssues(telop), measurement: null }
    })
    const off = window.api.onQcProgress((percent) => {
      const r = get().report
      if (token === qcRunToken && r?.path === path && r.state === 'run') set({ report: { ...r, percent } })
    })
    try {
      const measurement = await window.api.qcMeasure(path)
      if (token !== qcRunToken) return
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
      if (token !== qcRunToken) return
      const message = formatIpcError(e)
      const r = get().report
      if (r?.path !== path) return
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
    qcRunToken++
    void window.api.qcCancel()
    set({ report: null })
  }
}))

// A previous project's export QC must not overwrite the new project's report.
onProjectSwitch(() => {
  qcRunToken++
  useQcStore.setState({ report: null })
})
