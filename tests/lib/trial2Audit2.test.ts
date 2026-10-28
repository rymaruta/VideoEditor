import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import {
  framesOnFaces,
  MAX_FACE_FRAMES,
  planFaceFrames,
  prepareVerticalFill,
  verticalSampleKey
} from '@renderer/lib/verticalFraming'
import { dropPolicyFor, droppedSceneReason } from '@renderer/lib/autoEditView'
import { normalizeAutoEdit } from '@shared/autoEdit'
import { useProjectStore } from '@renderer/store/projectStore'
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import type { Scene, SceneJudgement } from '@shared/structure/scenes'
import type { Clip, Project } from '@shared/types'
import { runEpisode } from '../helpers/episodeHarness'

/** 2回目の見直しの指摘(C3・C3'・C4・C5・D2) */

const asset = (id: string): Record<string, unknown> => ({
  id,
  filePath: `/r/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration: 3600,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true
})
const projectOf = (clips: Partial<Clip>[], extra: Record<string, unknown> = {}): Project =>
  ({
    id: 'p',
    name: 'p',
    aspectRatio: '9:16',
    assets: [asset('A')],
    clips: clips.map((c, i) => ({ id: `c${i + 1}`, assetId: 'A', speed: 1, ...c })),
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    ...extra
  }) as unknown as Project

describe('C3: ゲーム実況の縦の書き出しは、顔は探さずに真ん中で埋める(黒帯にしない)', () => {
  it('顔を探さずに、枠を埋めて真ん中で切り出す', async () => {
    let asked = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        faceDetect: async (req: unknown[]) => {
          asked++
          return req.map(() => [])
        }
      }
    }
    const p = projectOf([{ inPoint: 0, outPoint: 10 }], { autoEdit: { kind: 'game' } })
    expect(framesOnFaces(p)).toBe(false)
    const r = await prepareVerticalFill(p, { findFaces: framesOnFaces(p) })
    expect(asked).toBe(0)
    expect(r.project.clips[0].fillCrop).toBe(true)
    expect(r.project.clips[0].cropCenter).toEqual({ x: 0.5, y: 0.5 })
  })
})

describe("C3': 古い企画(企画に種類が無い)は、自動編集の画面 → 設定の順で決める", () => {
  it('書き出しと自動のショートで同じ決め方', () => {
    const old = projectOf([])
    expect(framesOnFaces(old, 'game')).toBe(false)
    expect(framesOnFaces(old, 'location')).toBe(true)
    // 企画に種類があれば、それが先
    expect(framesOnFaces(projectOf([], { autoEdit: { kind: 'location' } }), 'game')).toBe(true)
  })
})

describe('C4: 顔を探す画の全体の上限を必ず守る', () => {
  it('60 素材でも上限まで(素材ごと1枚、多すぎれば長く使う素材から)', () => {
    const assets = Array.from({ length: 60 }, (_, i) => asset(`A${i}`))
    const clips = assets.flatMap((a, i) =>
      Array.from({ length: 3 }, (_, k) => ({
        inPoint: k * 100,
        // 後ろの素材ほど長く使う
        outPoint: k * 100 + 1 + i,
        assetId: a.id as string
      }))
    )
    const p = { ...projectOf(clips), assets } as unknown as Project
    const plan = planFaceFrames(p)
    expect(plan.requests.length).toBeLessThanOrEqual(MAX_FACE_FRAMES)
    expect(plan.requests.length).toBe(MAX_FACE_FRAMES)
    // 長く使う素材が選ばれる(いちばん短い素材は外れる)
    expect(plan.requests.some((r) => r.path === '/r/A59.mp4')).toBe(true)
    expect(plan.requests.some((r) => r.path === '/r/A0.mp4')).toBe(false)
  })
})

describe('C5: 見本の覚え方の鍵に、企画とクリップの中身を入れる', () => {
  it('別の企画・直したクリップでは鍵が変わる', () => {
    const p = projectOf([{ inPoint: 0, outPoint: 10 }])
    const k = verticalSampleKey(p, [1, 5], true, true)
    expect(verticalSampleKey({ ...p, id: 'q' }, [1, 5], true, true)).not.toBe(k)
    const moved = { ...p, clips: [{ ...p.clips[0], inPoint: 2 }] }
    expect(verticalSampleKey(moved, [1, 5], true, true)).not.toBe(k)
    const looked = { ...p, clips: [{ ...p.clips[0], blurBackground: true }] }
    expect(verticalSampleKey(looked, [1, 5], true, true)).not.toBe(k)
    expect(verticalSampleKey(p, [1, 5], true, true)).toBe(k)
  })
})

describe('D2: 落とした理由は、仮編集を作った時の方針で決める', () => {
  const j: SceneJudgement[] = [{ sceneId: 's1', score: 30, kind: 'normal', reason: '' }]
  const scene: Scene = { id: 's1', start: 0, end: 60, lines: [], speech: 20 }

  it('作った後に設定を変えても、文言は作った時の方針のまま(記録の無い古い企画は今の設定)', () => {
    const basis = {
      dropUnneeded: true,
      targetSec: 480,
      minScore: null,
      relaxed: false,
      replaced: false
    }
    // 作った時は「テンポよく・8分」(長さ)。今の設定は「面白い所だけ・目標なし」
    expect(
      droppedSceneReason(scene, j[0], j, false, dropPolicyFor(basis, 'highlights', 0))
    ).toContain('長さに合わせて')
    expect(
      droppedSceneReason(scene, j[0], j, false, dropPolicyFor(undefined, 'highlights', 0))
    ).toContain('下限')
    // 下げた下限(静かな回)は、下げた値で書く
    const relaxed = {
      dropUnneeded: true,
      targetSec: 0,
      minScore: 35,
      relaxed: true,
      replaced: false
    }
    expect(droppedSceneReason(scene, j[0], j, false, dropPolicyFor(relaxed, 'tempo', 8))).toContain(
      '下限(35 点)'
    )
  })

  it('仮編集を作ると、方針を企画に覚え、開き直しても戻る', async () => {
    await runEpisode(() => {
      useSettingsStore.setState({ editPolicy: 'tempo' } as never)
      usePipelineStore.setState({ targetMinutes: 1.5 } as never)
    })
    const saved = useProjectStore.getState().project.autoEdit!
    expect(saved.dropBasis).toBeDefined()
    expect(saved.dropBasis!.dropUnneeded).toBe(true)
    expect(normalizeAutoEdit(JSON.parse(JSON.stringify(saved)))?.dropBasis).toEqual(saved.dropBasis)
    expect(usePipelineStore.getState().roughCut?.basis).toEqual(saved.dropBasis)
  })
})
