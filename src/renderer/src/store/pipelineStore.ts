import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { FootageScan, FootageSource, ProbedFile, SourceKind } from '@shared/ingest/classify'
import type { SyncInputFile, SyncReport } from '@shared/sync/report'
import { buildMulticamLayout } from '@shared/sync/multicamLayout'
import type { MediaAsset } from '@shared/types'
import { useProjectStore } from './projectStore'
import { formatIpcError } from '../lib/ipcError'
import { emitMenuCommand } from '../lib/menuCommands'

/**
 * 自動編集の工程(計画書 §5)の状態。「新しい回を作る」と「自動編集」の画面が同じものを見る。
 * 画面を閉じても工程は止まらない(状態はここにある)。
 *
 * 今ある工程: 取り込み・整理 → カメラの同期 → タイムラインに並べる。
 * 文字起こし・話者分離などは、できたものから順にここへ足していく。
 */

export type StepId = 'ingest' | 'sync' | 'timeline'
export type StepState = 'wait' | 'run' | 'done' | 'error' | 'skipped'

export interface StepStatus {
  state: StepState
  percent: number
  note?: string
}

/** 画面で直せる振り分け。kind が skip なら使わない */
export interface EditableSource {
  id: string
  name: string
  kind: SourceKind | 'skip'
  basis: string
  files: ProbedFile[]
}

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'ingest', label: '取り込み・整理' },
  { id: 'sync', label: 'カメラ・マイクの同期' },
  { id: 'timeline', label: 'タイムラインに並べる' }
]

interface PipelineState {
  root: string | null
  scan: FootageScan | null
  sources: EditableSource[]
  steps: Record<StepId, StepStatus>
  report: SyncReport | null
  /** 同期にかけた素材(ID → 素材)。結果の表示に使う */
  syncedFiles: SyncInputFile[]
  log: { time: number; text: string }[]
  /** 「このままでよい」とした要確認の印 */
  reviewed: string[]
  running: boolean
  screenOpen: boolean

  setScreenOpen: (open: boolean) => void
  scanFolder: (root: string) => Promise<void>
  updateSource: (id: string, patch: Partial<Pick<EditableSource, 'name' | 'kind'>>) => void
  runPipeline: () => Promise<void>
  cancel: () => void
  markReviewed: (key: string, reviewed: boolean) => void
  reset: () => void
}

const initialSteps = (): Record<StepId, StepStatus> => ({
  ingest: { state: 'wait', percent: 0 },
  sync: { state: 'wait', percent: 0 },
  timeline: { state: 'wait', percent: 0 }
})

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

export const usePipelineStore = create<PipelineState>((set, get) => {
  const log = (text: string): void =>
    set((s) => ({ log: [...s.log, { time: Date.now(), text }].slice(-500) }))
  const setStep = (id: StepId, status: Partial<StepStatus>): void =>
    set((s) => ({ steps: { ...s.steps, [id]: { ...s.steps[id], ...status } } }))

  return {
    root: null,
    scan: null,
    sources: [],
    steps: initialSteps(),
    report: null,
    syncedFiles: [],
    log: [],
    reviewed: [],
    running: false,
    screenOpen: false,

    setScreenOpen: (open) => set({ screenOpen: open }),

    reset: () =>
      set({
        root: null,
        scan: null,
        sources: [],
        steps: initialSteps(),
        report: null,
        syncedFiles: [],
        log: [],
        reviewed: []
      }),

    scanFolder: async (root) => {
      set({ root, scan: null, sources: [], steps: initialSteps(), report: null, reviewed: [] })
      setStep('ingest', { state: 'run', percent: 0, note: 'ファイルを探しています' })
      log(`収録フォルダを読み込みます: ${root}`)
      const off = window.api.onFootageScanProgress(({ done, total }) =>
        setStep('ingest', { percent: (done / Math.max(1, total)) * 100, note: `${done}/${total}` })
      )
      try {
        const scan = await window.api.footageScan(root)
        const sources: EditableSource[] = scan.sources.map((s: FootageSource) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          basis: s.basis,
          files: s.files
        }))
        set({ scan, sources })
        const count = sources.reduce((n, s) => n + s.files.length, 0)
        setStep('ingest', {
          state: 'done',
          percent: 100,
          note: `${sources.length} 系統 · ${count} 本${scan.skipped.length ? ` · 読めない ${scan.skipped.length} 本` : ''}`
        })
        log(
          `見つかった素材: ${sources.map((s) => `${s.name}(${s.files.length}本)`).join('、') || 'なし'}`
        )
        for (const sk of scan.skipped) log(`読み込めない: ${sk.path}(${sk.reason})`)
      } catch (e) {
        setStep('ingest', { state: 'error', note: formatIpcError(e) })
        log(`取り込みに失敗: ${formatIpcError(e)}`)
      } finally {
        off()
      }
    },

    updateSource: (id, patch) =>
      set((s) => ({ sources: s.sources.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),

    runPipeline: async () => {
      const { scan, sources, running } = get()
      if (running || !scan) return
      const used = sources.filter((s) => s.kind !== 'skip')
      const files: SyncInputFile[] = used.flatMap((s) =>
        s.files.map((f) => ({
          id: f.path,
          path: f.path,
          sourceId: s.id,
          sourceKind: s.kind as SourceKind,
          duration: f.duration,
          recordedAt: f.recordedAt,
          size: f.size,
          mtimeMs: scan.stats[f.path]?.mtimeMs ?? 0
        }))
      )
      if (!used.some((s) => s.kind === 'camera')) {
        setStep('sync', { state: 'error', note: 'カメラの素材がありません' })
        return
      }
      set({ running: true, report: null, syncedFiles: files, reviewed: [] })

      // --- 同期
      setStep('sync', { state: 'run', percent: 0, note: '準備中' })
      setStep('timeline', { state: 'wait', percent: 0, note: undefined })
      log(`同期を始めます(${files.length} 本)`)
      const off = window.api.onSyncProgress(({ percent, stage }) =>
        setStep('sync', { percent, note: stage })
      )
      let report: SyncReport
      try {
        report = await window.api.syncRun(files)
      } catch (e) {
        const msg = formatIpcError(e)
        const canceled = msg.includes('SYNC_CANCELED')
        setStep('sync', {
          state: canceled ? 'wait' : 'error',
          note: canceled ? '中止しました' : msg
        })
        log(canceled ? '同期を中止しました' : `同期に失敗: ${msg}`)
        set({ running: false })
        return
      } finally {
        off()
      }
      const synced = report.placements.filter((p) => p.method !== 'none').length
      set({ report })
      setStep('sync', {
        state: 'done',
        percent: 100,
        note: `${synced}/${files.length} 本を同期 · ${(report.elapsedMs / 1000).toFixed(1)} 秒`
      })
      log(`同期が終わりました: ${synced}/${files.length} 本(要確認 ${report.issues.length} 件)`)
      for (const p of report.pairs) {
        if (p.driftPpm !== undefined && Math.abs(p.driftPpm) >= 20) {
          log(
            `時計のずれ: ${fileName(p.b)} は ${fileName(p.a)} に対して ${p.driftPpm.toFixed(0)}ppm(1時間で ${(((Math.abs(p.driftPpm) * 3600) / 1e6) * 1000).toFixed(0)}ms)`
          )
        }
      }

      // --- タイムラインに並べる
      setStep('timeline', { state: 'run', percent: 0, note: '素材を読み込み中' })
      try {
        const layout = buildMulticamLayout(
          used.map((s) => ({ id: s.id, name: s.name, kind: s.kind as SourceKind })),
          files.map((f) => ({ id: f.id, sourceId: f.sourceId, duration: f.duration })),
          report.placements
        )
        if (!layout) throw new Error('同期できたカメラがありません')
        const assets: MediaAsset[] = []
        const assetIdOf: Record<string, string> = {}
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          const meta = await window.api.probeMedia(f.path)
          let thumbnailDataUrl: string | undefined
          if (meta.hasVideo) {
            thumbnailDataUrl = await window.api
              .generateThumbnail(f.path, Math.min(1, meta.duration / 2))
              .catch(() => undefined)
          }
          const id = uuid()
          assetIdOf[f.id] = id
          assets.push({
            id,
            filePath: f.path,
            fileName: fileName(f.path),
            duration: meta.duration,
            width: meta.width,
            height: meta.height,
            fps: meta.fps,
            hasAudio: meta.hasAudio,
            hasVideo: meta.hasVideo,
            thumbnailDataUrl
          })
          setStep('timeline', { percent: ((i + 1) / files.length) * 90 })
        }
        // 縦横比は基準カメラに合わせる(新しい回は既定の縦型のままだと、全素材が「縦横比が違う」になる)
        const anchorAsset = assets.find((a) => a.id === assetIdOf[layout.main[0]?.fileId ?? ''])
        const aspect =
          anchorAsset && anchorAsset.width > 0 && anchorAsset.height > 0
            ? anchorAsset.width >= anchorAsset.height
              ? '16:9'
              : '9:16'
            : undefined
        useProjectStore.getState().addMulticamTimeline(assets, layout, assetIdOf, aspect)
        // 再生できない形式(HEVC など)は、素材一覧の側でプレビュー用の変換を始める
        emitMenuCommand('assets.checkPreview')
        void window.api.libraryRemember(assets.map((a) => a.filePath)).catch(() => {})
        setStep('timeline', {
          state: 'done',
          percent: 100,
          note: `本編 ${layout.main.length} 本 · カメラ ${layout.cameras.length} · マイク ${layout.mics.length}${layout.leftOut.length ? ` · 並べなかった ${layout.leftOut.length} 本` : ''}`
        })
        log(
          `タイムラインに並べました(基準カメラ: ${used.find((s) => s.id === layout.anchorSourceId)?.name ?? ''})`
        )
      } catch (e) {
        setStep('timeline', { state: 'error', note: formatIpcError(e) })
        log(`タイムラインに並べられませんでした: ${formatIpcError(e)}`)
      } finally {
        set({ running: false })
      }
    },

    cancel: () => {
      void window.api.syncCancel()
    },

    markReviewed: (key, reviewed) =>
      set((s) => ({
        reviewed: reviewed
          ? [...new Set([...s.reviewed, key])]
          : s.reviewed.filter((k) => k !== key)
      }))
  }
})
