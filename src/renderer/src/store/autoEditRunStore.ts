import { create } from 'zustand'
import type { AudioTrack, AutoEditPattern, MediaAsset } from '@shared/types'
import { generateAutoEditPatterns } from '../lib/autoEdit'
import { autoFinishTimeline, type AutoFinishResult } from '../lib/autoFinish'
import { formatIpcError } from '../lib/ipcError'

/**
 * AIおまかせ全自動編集の実行状態。
 *
 * 生成はハイライト検出・Geminiへの採点依頼・サムネイル抽出を挟むため数分かかることがある。
 * これをモーダルのコンポーネント内で持つと、**モーダルを閉じた瞬間に結果が捨てられる**ため、
 * 利用者は生成が終わるまで他の作業が一切できなかった(閉じてやり直しても、また同じ時間待つ)。
 * 実行状態をストアへ出し、モーダルは「今の状態を映すだけ」にすることで、閉じても処理が続く。
 */
export type AutoEditRunStatus = 'idle' | 'running' | 'ready' | 'error'

export interface AutoEditRunInput {
  assets: MediaAsset[]
  audioTracks: AudioTrack[]
  geminiApiKey?: string
}

/**
 * 生成結果がどの素材から作られたかの指紋。素材を足した/消した状態で開き直したときに、
 * 前回の(もう合わない)結果をそのまま見せてしまわないよう、開いた時点で照合する。
 */
export function autoEditSourceKey(assets: MediaAsset[], referencePath: string | null): string {
  return `${assets
    .filter((a) => a.hasVideo)
    .map((a) => a.id)
    .join(',')}|${referencePath ?? ''}`
}

interface AutoEditRunState {
  status: AutoEditRunStatus
  patterns: AutoEditPattern[]
  thumbnails: Record<string, string>
  recommendedId?: string
  aiScoredCount: number
  bgmBeat: { bpm: number; assetName: string } | null
  referenceStyle: { avgCutSeconds: number; cutCount: number } | null
  error: string | null
  sourceKey: string
  /** 生成のたびに選び直せる設定。モーダルを閉じても保つ */
  useGemini: boolean
  referencePath: string | null
  /** 生成結果に対する操作の記録。開き直しても「適用済み」「評価済み」が残る */
  feedback: Record<string, 'liked' | 'disliked'>
  appliedId: string | null
  /** 「適用して自動で仕上げる」も長いので、同じくストア側で走らせる */
  finishingId: string | null
  finishResult: AutoFinishResult | null
  finishError: string | null

  start: (input: AutoEditRunInput) => Promise<void>
  setUseGemini: (value: boolean) => void
  setReferencePath: (path: string | null) => void
  setFeedback: (patternId: string, liked: boolean) => void
  markApplied: (patternId: string) => void
  startFinish: (patternId: string, geminiApiKey: string | undefined) => Promise<void>
}

// 走っている生成の世代番号。再生成や参考動画の切り替えで先に投げた生成が後から
// 返ってきても、古い結果で新しい結果を上書きしないようにする。
let runToken = 0

export const useAutoEditRunStore = create<AutoEditRunState>((set, get) => ({
  status: 'idle',
  patterns: [],
  thumbnails: {},
  recommendedId: undefined,
  aiScoredCount: 0,
  bgmBeat: null,
  referenceStyle: null,
  error: null,
  sourceKey: '',
  useGemini: false,
  referencePath: null,
  feedback: {},
  appliedId: null,
  finishingId: null,
  finishResult: null,
  finishError: null,

  start: async (input) => {
    const token = ++runToken
    const referencePath = get().referencePath
    set({
      status: 'running',
      error: null,
      patterns: [],
      thumbnails: {},
      recommendedId: undefined,
      aiScoredCount: 0,
      bgmBeat: null,
      referenceStyle: null,
      feedback: {},
      appliedId: null,
      finishingId: null,
      finishResult: null,
      finishError: null,
      sourceKey: autoEditSourceKey(input.assets, referencePath)
    })
    try {
      const result = await generateAutoEditPatterns(input.assets, {
        seed: Date.now(),
        geminiApiKey: get().useGemini ? input.geminiApiKey : undefined,
        audioTracks: input.audioTracks,
        referenceFilePath: referencePath ?? undefined
      })
      if (token !== runToken) return
      set({
        status: 'ready',
        patterns: result.patterns,
        thumbnails: result.thumbnails,
        recommendedId: result.recommendedPatternId,
        aiScoredCount: result.aiScoredCandidateCount,
        bgmBeat: result.bgmBeat,
        referenceStyle: result.referenceStyle
      })
    } catch (e) {
      if (token !== runToken) return
      set({ status: 'error', error: formatIpcError(e) })
    }
  },

  setUseGemini: (value) => set({ useGemini: value }),

  setReferencePath: (path) => set({ referencePath: path }),

  setFeedback: (patternId, liked) =>
    set((s) => ({ feedback: { ...s.feedback, [patternId]: liked ? 'liked' : 'disliked' } })),

  markApplied: (patternId) => set({ appliedId: patternId }),

  startFinish: async (patternId, geminiApiKey) => {
    set({ finishingId: patternId, finishError: null, finishResult: null })
    try {
      const result = await autoFinishTimeline(geminiApiKey || undefined, 'japanese')
      set({ finishResult: result })
    } catch (e) {
      set({ finishError: formatIpcError(e) })
    } finally {
      set({ finishingId: null })
    }
  }
}))
