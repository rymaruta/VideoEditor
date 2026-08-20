import { describe, expect, it } from 'vitest'
import { sameProjectContent } from '@renderer/lib/projectEquality'
import { formatIpcError } from '@renderer/lib/ipcError'
import { shortsSafeAreaInset } from '@renderer/lib/shortsSafeArea'
import type { Project } from '@shared/types'
import { seeded } from '../helpers/boundary'

const base = (): Project =>
  ({
    id: 'p',
    name: 'x',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'A',
        filePath: '/a.mp4',
        fileName: 'a.mp4',
        duration: 10,
        width: 1,
        height: 1,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      }
    ],
    clips: [{ id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 }],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [{ id: 'o1', text: 'あ', startTime: 0, endTime: 2, style: {}, source: 'manual' }],
    beatGrid: null
  }) as unknown as Project

describe('sameProjectContent — 「同じ値を入れ直しただけ」の判定', () => {
  it('同じ参照は同じ', () => {
    const p = base()
    expect(sameProjectContent(p, p)).toBe(true)
  })

  it('作り直した同じ中身も同じ', () => {
    expect(sameProjectContent(base(), base())).toBe(true)
  })

  it('1つでも値が違えば違う', () => {
    const a = base()
    const b = base()
    b.clips[0].outPoint = 4.0001
    expect(sameProjectContent(a, b)).toBe(false)
  })

  it('配列の長さが違えば違う', () => {
    const a = base()
    const b = base()
    b.clips.push({ ...b.clips[0], id: 'c2' })
    expect(sameProjectContent(a, b)).toBe(false)
  })

  it('並び順が違えば違う', () => {
    const a = base()
    a.clips.push({ ...a.clips[0], id: 'c2' })
    const b = base()
    b.clips.push({ ...b.clips[0], id: 'c2' })
    b.clips.reverse()
    expect(sameProjectContent(a, b)).toBe(false)
  })

  it('undefined のキーは「無い」と同じ(JSON にすると消えるため)', () => {
    const a = base()
    const b = base()
    ;(b.clips[0] as unknown as Record<string, unknown>).colorLabel = undefined
    expect(sameProjectContent(a, b)).toBe(true)
  })

  it('NaN 同士は「同じ」(NaN は『値が変わった』ではない)', () => {
    const a = base()
    const b = base()
    a.clips[0].outPoint = NaN
    b.clips[0].outPoint = NaN
    expect(sameProjectContent(a, b)).toBe(true)
  })

  it('null と undefined は区別する', () => {
    const a = base()
    const b = base()
    ;(a as unknown as Record<string, unknown>).beatGrid = null
    ;(b as unknown as Record<string, unknown>).beatGrid = undefined
    expect(sameProjectContent(a, b)).toBe(false)
  })

  it('【不変条件】どこか1つ数値をいじれば必ず「違う」と分かる', () => {
    const rnd = seeded(90210)
    for (let i = 0; i < 500; i++) {
      const a = base()
      const b = base()
      const target = [
        () => (b.clips[0].inPoint += 1e-7),
        () => (b.clips[0].speed = 2),
        () => (b.textOverlays[0].startTime = 0.5),
        () => (b.textOverlays[0].text = 'い'),
        () => (b.assets[0].duration = 11),
        () => (b.name = 'y'),
        () => (b.aspectRatio = '9:16')
      ][Math.floor(rnd() * 7)]
      target()
      expect(sameProjectContent(a, b), `i=${i}`).toBe(false)
    }
  })
})

describe('formatIpcError — main が投げたエラーを画面の文言にする', () => {
  it('Electron が付ける前置きを剥がす', () => {
    expect(
      formatIpcError(
        new Error("Error invoking remote method 'project:load': Error: ファイルが見つかりません")
      )
    ).toBe('ファイルが見つかりません')
  })

  it('前置きが無ければそのまま', () => {
    expect(formatIpcError(new Error('書き出しに失敗しました'))).toBe('書き出しに失敗しました')
  })

  it('Error でないものも文字にする', () => {
    expect(formatIpcError('ただの文字列')).toBe('ただの文字列')
    expect(formatIpcError(undefined)).toBe('undefined')
    expect(formatIpcError(null)).toBe('null')
    expect(formatIpcError(123)).toBe('123')
  })

  it('【不変条件】必ず文字列を返し、前置きを残さない', () => {
    const samples: unknown[] = [
      new Error("Error invoking remote method 'x:y': Error: あ"),
      new Error("Error invoking remote method 'x:y': あ"),
      new Error(''),
      '',
      {},
      []
    ]
    for (const s of samples) {
      const r = formatIpcError(s)
      expect(typeof r).toBe('string')
      expect(r.startsWith('Error invoking remote method')).toBe(false)
    }
  })
})

describe('shortsSafeAreaInset — セーフエリアの目安線', () => {
  it('実測どおりの比で返す(上5% / 下84% / 左右88%)', () => {
    // 文字列そのままでは比べない。`(1 - 0.84) * 100` は倍精度で
    // **16.000000000000004** になるので、数として見る(CSS には影響しない)。
    const inset = shortsSafeAreaInset()
    const pct = (v: string): number => Number(v.slice(0, -1))
    expect(pct(inset.top)).toBeCloseTo(5, 9)
    expect(pct(inset.right)).toBeCloseTo(12, 9)
    expect(pct(inset.bottom)).toBeCloseTo(16, 9)
    expect(pct(inset.left)).toBeCloseTo(12, 9)
    // 左右は同じ幅(見た目を揃えるため)
    expect(inset.left).toBe(inset.right)
  })

  it('既定のテロップの字面(高さ 89.3〜91.4%)は、下の線(84%)を越える', () => {
    // 2026-09-07 の実測。ここが逆転したら目安線の意味が失われるので固定する。
    const bottomLine = 100 - Number(shortsSafeAreaInset().bottom.slice(0, -1))
    expect(bottomLine).toBeCloseTo(84, 9)
    expect(89.3).toBeGreaterThan(bottomLine)
  })

  it('【不変条件】4辺とも % 表記で 0〜100 に収まる', () => {
    const inset = shortsSafeAreaInset()
    for (const [side, v] of Object.entries(inset)) {
      expect(v.endsWith('%'), `${side}=${v}`).toBe(true)
      const n = Number(v.slice(0, -1))
      expect(Number.isFinite(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(100)
    }
  })
})
