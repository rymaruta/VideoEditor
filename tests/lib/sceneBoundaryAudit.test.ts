import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildScenes } from '@shared/structure/scenes'
import type { LlmRequest } from '@shared/llm'
import { checkSceneBoundaries, retryLocalAi } from '@renderer/lib/roughCutPlan'
import { matchScenesAcrossMoves, restorePipelineFromProject } from '@renderer/lib/pipelineRestore'
import { buildReviewItems } from '@renderer/lib/reviewItems'
import { normalizeAutoEdit } from '@shared/autoEdit'
import type { Project } from '@shared/types'
import { TRIAL4_TRANSCRIPT } from '../shared/fixtures/trial4Transcript'

/**
 * 区切りの確認(試験的な後段)の監査の直し(e72feba)。
 * 1 既定は OFF / 2 中止が効く / 3 上限時間 / 5 読み込めなかった記録に残さない / 6 直しに関わる場面だけ 5 割・
 * 当たらなくなった直しを捨てる / 7 もう一度試すで外した回数を消す・答えが無い回は数えない
 * (4 Gemini で行わないは `sceneBoundarySmallModel.test.ts`。main の側は `tests/main/llmPlan.test.ts`)
 */

afterEach(() => vi.unstubAllGlobals())

const lines = TRIAL4_TRANSCRIPT.map(([start, end, text], i) => ({
  id: `u${i}`,
  speaker: 'マイク1',
  start,
  end,
  text,
  overlap: false
}))
const scenes = buildScenes(lines, { start: 0, end: 660 })
const local = { provider: 'local' as const, apiKey: '' }

function answer(r: LlmRequest): unknown {
  const head = r.prompt.split('──── ここ ────')[0]
  const all = [...head.matchAll(/「([^「」]*)」/gu)]
  const tail = all.length > 0 ? all[all.length - 1][1] : ''
  return {
    reason: '',
    answer: ['あとやはり我々は', 'この坂道を', 'スープが'].includes(tail)
      ? '話の途中'
      : '話の切れ目'
  }
}

function stubApi(api: Record<string, unknown>): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  })
  vi.stubGlobal('window', { api: { onLlmProgress: () => () => {}, ...api } })
  return store
}

describe('1 既定は OFF(試験的な機能)', () => {
  it('設定を触っていなければ区切りの確認は行わない', async () => {
    stubApi({})
    vi.resetModules()
    const { useSettingsStore } = await import('../../src/renderer/src/store/settingsStore')
    expect(useSettingsStore.getState().sceneBoundaryAi).toBe(false)
    useSettingsStore.getState().setSceneBoundaryAi(true)
    expect(useSettingsStore.getState().sceneBoundaryAi).toBe(true)
  })
})

describe('2 中止が効く', () => {
  it('モデルの確かめを中止したら、中止のまま投げてモデルを読み込まない', async () => {
    const llmRun = vi.fn(async (r: LlmRequest[]) => r.map(answer))
    stubApi({ llmRun, llmPlan: async () => Promise.reject(new Error('LLM_CANCELED')) })
    await expect(checkSceneBoundaries(scenes, local)).rejects.toThrow('LLM_CANCELED')
    expect(llmRun).not.toHaveBeenCalled()
  })

  it('確かめの後で中止が押されていたら、頼まずに抜ける', async () => {
    const llmRun = vi.fn(async (r: LlmRequest[]) => r.map(answer))
    let canceled = false
    stubApi({
      llmRun,
      llmPlan: async () => {
        canceled = true
        return { model: 'Qwen2.5 7B', device: 'cuda' }
      }
    })
    await expect(
      checkSceneBoundaries(scenes, { ...local, isCanceled: () => canceled })
    ).rejects.toThrow('LLM_CANCELED')
    expect(llmRun).not.toHaveBeenCalled()
  })

  it('例文の答えの後で中止が押されていたら、続きを頼まずに抜ける', async () => {
    let canceled = false
    const llmRun = vi.fn(async (r: LlmRequest[]) => {
      canceled = true
      return r.map(answer)
    })
    stubApi({ llmRun, llmPlan: async () => ({ model: 'Qwen2.5 7B', device: 'cuda' }) })
    await expect(
      checkSceneBoundaries(scenes, { ...local, isCanceled: () => canceled })
    ).rejects.toThrow('LLM_CANCELED')
    expect(llmRun).toHaveBeenCalledTimes(1)
  })
})

describe('3 上限時間', () => {
  it('モデルの確かめが上限時間を超えたら、区切りの確認だけ省く(理由つき・AI は呼ばない)', async () => {
    const llmRun = vi.fn(async (r: LlmRequest[]) => r.map(answer))
    stubApi({
      llmRun,
      llmPlan: async () =>
        Promise.reject(new Error('AI のモデルを確かめるのに時間がかかりすぎました(30 秒)'))
    })
    const r = await checkSceneBoundaries(scenes, local)
    expect(r.moves).toEqual([])
    expect(r.failure).toMatch(/時間がかかりすぎました/u)
    expect(llmRun).not.toHaveBeenCalled()
  })

  it('頼みが上限時間を超えたら止めて(閉じるまで待ち)、区切りの確認だけ省く', async () => {
    let reject: ((e: Error) => void) | undefined
    const llmRun = vi.fn(
      () =>
        new Promise((_, rej) => {
          reject = rej
        })
    )
    const llmCancel = vi.fn(async () => reject?.(new Error('LLM_CANCELED')))
    stubApi({ llmRun, llmCancel, llmPlan: async () => ({ model: 'Qwen2.5 7B', device: 'cuda' }) })
    const r = await checkSceneBoundaries(scenes, { ...local, askTimeoutMs: () => 20 })
    expect(llmCancel).toHaveBeenCalled()
    expect(r.moves).toEqual([])
    expect(r.failure).toMatch(/上限時間/u)
  })
})

describe('5 区切りの確認での読み込みの失敗は覚えない', () => {
  it('このPCの AI に「読み込めなかったモデルを覚えない」で頼む', async () => {
    const llmRun = vi.fn(async (r: LlmRequest[]) => r.map(answer))
    stubApi({ llmRun, llmPlan: async () => ({ model: 'Qwen2.5 7B', device: 'cuda' }) })
    await checkSceneBoundaries(scenes, local)
    expect(llmRun).toHaveBeenCalled()
    for (const call of llmRun.mock.calls)
      expect(call[1 as 0]).toEqual({ recordLoadFailures: false })
  })
})

describe('7 外した回数', () => {
  it('答えが読めなかった回(全部壊れた)は数えない', async () => {
    const llmRun = vi.fn(async (r: LlmRequest[]) => r.map(() => null))
    stubApi({ llmRun, llmPlan: async () => ({ model: 'Qwen2.5 7B', device: 'cuda' }) })
    for (let i = 0; i < 3; i++)
      expect((await checkSceneBoundaries(scenes, local)).untrusted).toBe('no-answer')
    expect(llmRun).toHaveBeenCalledTimes(3)
  })

  it('「このPCの AI をもう一度試す」で外した回数も消え、また確かめる', async () => {
    const biased = vi.fn(async (r: LlmRequest[]) =>
      r.map(() => ({ reason: '', answer: '話の途中' }))
    )
    const llmClearLoadFailures = vi.fn(async () => undefined)
    stubApi({
      llmRun: biased,
      llmClearLoadFailures,
      llmPlan: async () => ({ model: 'Qwen2.5 7B', device: 'cuda' })
    })
    await checkSceneBoundaries(scenes, local)
    await checkSceneBoundaries(scenes, local)
    expect((await checkSceneBoundaries(scenes, local)).skipped?.reason).toBe('missed-before')
    await retryLocalAi()
    expect(llmClearLoadFailures).toHaveBeenCalled()
    const calls = biased.mock.calls.length
    const r = await checkSceneBoundaries(scenes, local)
    expect(r.skipped).toBeUndefined()
    expect(biased.mock.calls.length).toBeGreaterThan(calls)
  })
})

describe('6 直しに関わる場面だけ 5 割・当たらなくなった直しは捨てる', () => {
  it('直しと関係の無い場面は今までどおり 8 割で見る', () => {
    const prev = [
      { id: 's1', start: 0, end: 100 },
      { id: 's2', start: 100, end: 200 },
      { id: 's3', start: 200, end: 300 }
    ]
    // 直しは 200 秒の区切り(s2・s3 に関わる)。s1 は文字起こしの直しで 0〜160 秒に変わった(重なり 6 割)
    const next = [
      { id: 's1', start: 0, end: 160 },
      { id: 's2', start: 160, end: 215 },
      { id: 's3', start: 215, end: 300 }
    ]
    const m = matchScenesAcrossMoves(prev, next, [{ at: 200, to: 215 }])
    expect(m.get('s1')).toBeUndefined()
    expect(m.get('s3')).toBe('s3')
  })

  const project = (autoEdit?: unknown): Project =>
    ({
      id: 'p',
      name: '第4回',
      aspectRatio: '16:9',
      assets: [
        {
          id: 'A',
          filePath: '/a.mp4',
          fileName: 'a.mp4',
          duration: 660,
          hasAudio: true,
          hasVideo: true
        },
        {
          id: 'M',
          filePath: '/m.wav',
          fileName: 'm.wav',
          duration: 660,
          hasAudio: true,
          hasVideo: false
        }
      ],
      clips: [],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: [],
      multicam: {
        anchorSourceId: 'camA',
        sources: [
          { id: 'camA', name: 'カメラA', kind: 'camera' },
          { id: 'mic', name: 'マイク1', kind: 'mic' }
        ],
        files: [
          { assetId: 'A', sourceId: 'camA', start: 0, rate: 1, duration: 660 },
          { assetId: 'M', sourceId: 'mic', start: 0, rate: 1, duration: 660 }
        ]
      },
      transcript: lines.map((l) => ({
        id: l.id,
        assetId: 'M',
        speaker: l.speaker,
        sourceStart: l.start,
        sourceEnd: l.end,
        text: l.text,
        words: [],
        overlap: false
      })),
      ...(autoEdit ? { autoEdit } : {})
    }) as unknown as Project

  it('開き直しで当たらなかった直しは捨て、要確認は実際に当たった数で出す', () => {
    const i = scenes.findIndex((s) => Math.abs(s.end - 527.18) < 0.01)
    const good = { at: scenes[i].end, to: scenes[i + 1].end }
    const stale = { at: 12.34, to: 20 }
    const autoEdit = normalizeAutoEdit({
      kind: 'location',
      sceneMoves: [stale, good],
      scenes: scenes.map((s) => ({ id: s.id, start: s.start, end: s.end })),
      judgements: [],
      judgeSource: 'heuristic',
      keep: {},
      targetMinutes: 0,
      editNote: '',
      effects: [],
      effectChosen: []
    })
    const r = restorePipelineFromProject(project(autoEdit), 'location')!
    expect(r.sceneMoves).toHaveLength(1)
    expect(r.sceneMoves[0].at).toBeCloseTo(527.18, 2)
    const items = buildReviewItems({
      project: project(autoEdit),
      syncIssues: [],
      fileLabel: (id) => id,
      placedStart: () => undefined,
      telopReviews: [],
      colorIssues: [],
      denoiseFailures: [],
      effects: [],
      effectChosen: [],
      qc: null,
      sceneMoves: r.sceneMoves
    })
    expect(items.find((i) => i.key === 'structure-boundaries')!.text).toContain(
      'AI が 1 か所の場面の区切りを直しました'
    )
  })
})
