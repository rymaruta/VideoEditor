import { describe, expect, it } from 'vitest'
import { restorePipelineFromProject } from '@renderer/lib/pipelineRestore'
import { scenesFor } from '@renderer/lib/roughCutPlan'
import { normalizeAutoEdit } from '@shared/autoEdit'
import { buildReviewItems } from '@renderer/lib/reviewItems'
import { buildScenes } from '@shared/structure/scenes'
import type { SceneMove } from '@shared/structure/boundaryAi'
import type { Project } from '@shared/types'
import { TRIAL4_TRANSCRIPT } from '../shared/fixtures/trial4Transcript'

/**
 * AI が直した場面の区切り(`autoEdit.sceneMoves`)を企画に保存し、開き直しでは保存した直しをそのまま当てる
 * (AI に聞き直さない)。作った時と開き直しで区切りがずれない・判定と人の残す/落とすが同じ場面に付く。
 * 前の版の開き直し(直しを読まない)では、区切りが作った時とずれていた
 */

const project = (autoEdit?: unknown): Project =>
  ({
    id: 'p',
    name: '第4回',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'A',
        filePath: '/r/a.mp4',
        fileName: 'a.mp4',
        duration: 660,
        hasAudio: true,
        hasVideo: true
      },
      {
        id: 'M',
        filePath: '/r/m.wav',
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
    transcript: TRIAL4_TRANSCRIPT.map(([start, end, text], i) => ({
      id: `u${i}`,
      assetId: 'M',
      speaker: 'マイク1',
      sourceStart: start,
      sourceEnd: end,
      text,
      words: [],
      overlap: false
    })),
    ...(autoEdit ? { autoEdit } : {})
  }) as unknown as Project

/** 第4回 N4 の直し(9 秒の場面を前の場面へ)と、区切りを前へ動かす直し */
const MOVES: SceneMove[] = [{ at: 527.18, to: 535.87 }]

describe('AI が直した区切りの保存と開き直し', () => {
  const base = project()
  const info = base.multicam!
  const plain = scenesFor(base, info)
  const s7 = plain.find((s) => Math.abs(s.end - 527.18) < 0.01)!
  const s8 = plain.find((s) => Math.abs(s.start - 527.18) < 0.01)!
  const moves: SceneMove[] = [{ at: s7.end, to: s8.end }]
  const made = scenesFor(base, info, { moves })

  it('作った時: 直しを当てた場面(9 秒の場面が前の場面に入る)', () => {
    expect(MOVES[0].at).toBeCloseTo(s7.end, 2)
    expect(made).toHaveLength(plain.length - 1)
    expect(made.find((s) => s.id === s7.id)!.end).toBe(s8.end)
  })

  const saved = (): unknown =>
    normalizeAutoEdit(
      JSON.parse(
        JSON.stringify({
          kind: 'location',
          sceneMoves: moves,
          scenes: made.map((s) => ({ id: s.id, start: s.start, end: s.end })),
          judgements: made.map((s, i) => ({
            sceneId: s.id,
            score: 40 + i,
            kind: 'normal',
            reason: `判定 ${i}`
          })),
          judgeSource: 'ai',
          keep: { [s7.id]: true, [made[made.length - 1].id]: false },
          keptIds: made.map((s) => s.id),
          targetMinutes: 8,
          editNote: '',
          effects: [],
          effectChosen: []
        })
      )
    )

  it('保存: 直しは企画に残る(読み込みの検証を通る)', () => {
    expect(saved()).toMatchObject({ sceneMoves: moves })
    expect(
      (
        normalizeAutoEdit({ scenes: [], sceneMoves: [{ at: 'x' }, { at: 1, to: 2 }, null] }) as {
          sceneMoves?: unknown
        }
      ).sceneMoves
    ).toEqual([{ at: 1, to: 2 }])
  })

  it('開き直し: 保存した直しを当て、作った時と同じ区切り・判定・残す/落とす(区切りが変わった知らせは出ない)', () => {
    const r = restorePipelineFromProject(project(saved()), 'location')!
    expect(r.scenes.map((s) => [s.id, s.start, s.end])).toEqual(
      made.map((s) => [s.id, s.start, s.end])
    )
    expect(r.sceneMoves).toEqual(moves)
    expect(r.missing.some((m) => m.includes('場面の区切りが変わりました'))).toBe(false)
    expect(r.judgements.map((j) => j.reason)).toEqual(made.map((_, i) => `判定 ${i}`))
    expect(r.keep).toEqual({ [s7.id]: true, [made[made.length - 1].id]: false })
  })

  it('直しを読まずに切り直すと(前の版の開き直し)、区切りが作った時とずれる', () => {
    const again = buildScenes(
      base.transcript!.map((u) => ({
        id: u.id,
        speaker: u.speaker,
        start: u.sourceStart,
        end: u.sourceEnd,
        text: u.text,
        overlap: false
      })),
      { start: 0, end: 660 }
    )
    expect(again.map((s) => [s.start, s.end])).not.toEqual(made.map((s) => [s.start, s.end]))
  })

  it('直しが当たらなくなった(文字起こしを直した)ときは、大半を占める前の場面の判定・印を引き継ぐ', () => {
    const p = project(saved())
    // 527 秒の区切りを作っていた発話を消す(区切りが変わり、直しが当たらなくなる)
    p.transcript = p.transcript!.filter((u) => u.text !== 'あとやはり我々は')
    const r = restorePipelineFromProject(p, 'location')!
    expect(r.missing.some((m) => m.includes('場面の区切りが変わりました'))).toBe(true)
    // 人が「残す」にした場面(直した場面)の大半を占める今の場面は「残す」のまま
    const kept = Object.entries(r.keep)
      .filter(([, v]) => v)
      .map(([id]) => id)
    expect(kept.length).toBeGreaterThan(0)
    for (const id of kept) {
      const s = r.scenes.find((x) => x.id === id)!
      const owner = made.find((x) => x.start <= s.start + 1e-6 && s.end <= x.end + 1e-6)
      expect(owner?.id).toBe(s7.id)
    }
  })

  it('要確認: AI が直した区切りの数と所を出す(開き直しても出る)。直していなければ出さない', () => {
    const sources = {
      syncIssues: [],
      fileLabel: (id: string) => id,
      placedStart: () => undefined,
      telopReviews: [],
      colorIssues: [],
      denoiseFailures: [],
      effects: [],
      effectChosen: [],
      qc: null
    }
    const items = buildReviewItems({ ...sources, project: project(saved()) })
    const item = items.find((i) => i.key === 'structure-boundaries')!
    expect(item.text).toContain('AI が 1 か所の場面の区切りを直しました')
    expect(item.text).toContain('8:47→8:56')
    expect(item.tab).toBe('structure')
    const none = buildReviewItems({ ...sources, project: project() })
    expect(none.some((i) => i.key === 'structure-boundaries')).toBe(false)
  })
})
