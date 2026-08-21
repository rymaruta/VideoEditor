import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTextStyle } from '@shared/textStyle'
import { NASTY_VALUES, seeded } from '../helpers/boundary'

/**
 * `presetStore` は**読み込み時に1回だけ** localStorage を読む(zustand の初期値)。
 * だから「途中で書き換えて読み直す」では試せない。毎回モジュールを捨てて、
 * 種を撒いてから読み込み直す。
 */
const store = new Map<string, string>()

async function loadWith(key: string, raw: string): Promise<typeof import('@renderer/store/presetStore')> {
  store.clear()
  store.set(key, raw)
  vi.resetModules()
  return import('@renderer/store/presetStore')
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear()
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const KEY = 've-caption-presets'
const KEYS = Object.keys(defaultTextStyle())

describe('【レグレッション】お気に入りのテロップは、項目が欠けていても直して残す (2026-09-13)', () => {
  /**
   * `isCaptionPreset` は `style` が**オブジェクトであること**しか見ていなかった。
   * 通ったお気に入りは `PresetPanel` が `style: { ...preset.style }` でそのまま
   * テロップにするので、項目の欠けたテロップがプロジェクトへ入り、
   * **押した時点では何も起きず、書き出しで初めて落ちる**。
   *
   * 実測(xvfb で実機、`style: {}` を localStorage に置いてから起動):
   * - 修正前: 一覧の見本が既定色、字の大きさ欄が「px ・ 」(数字が無い)。
   *   追加すると `style` の鍵が **0個**のテロップができ、プレビューのクラスは
   *   `overlay-text overlay-undefined anim-undefined`、字の大きさ 16px。
   *   その企画を書き出すと「Cannot read properties of undefined (reading 'replace')」。
   * - 修正後: 見本が `40px ・ アニメーションなし`、テロップの `style` は鍵 **19個**、
   *   クラスは `overlay-text overlay-bottom anim-none`。書き出しは成功し、
   *   1.5秒地点の白い画素の縦の重心は枠高の **90.1%**(=下寄せ)。
   */
  it('style が空でも捨てず、既定値で埋めて残す', async () => {
    const m = await loadWith(KEY, JSON.stringify([{ id: 'a', name: '古い版', style: {} }]))
    const presets = m.usePresetStore.getState().captionPresets
    expect(presets).toHaveLength(1)
    expect(presets[0].name).toBe('古い版')
    expect(presets[0].style).toEqual(defaultTextStyle())
  })

  it('一部だけ欠けているときは、**書いてある値のほうを残す**', async () => {
    const m = await loadWith(
      KEY,
      JSON.stringify([{ id: 'b', name: '色だけ欠け', style: { fontSize: 80, bold: true, position: 'top' } }])
    )
    const s = m.usePresetStore.getState().captionPresets[0].style
    expect(s.fontSize).toBe(80) // 利用者が決めた値
    expect(s.bold).toBe(true)
    expect(s.position).toBe('top')
    expect(s.color).toBe('#ffffff') // 欠けていた分だけ既定
    expect(s.outlineColor).toBe('#000000')
  })

  it('【不変条件】どんな中身を置いても、通ったお気に入りは全項目が揃っている', async () => {
    const rnd = seeded(913)
    const pool = [...NASTY_VALUES, 'top', 40, '#123456', true]
    const raw: unknown[] = []
    for (let i = 0; i < 200; i++) {
      const style: Record<string, unknown> = {}
      for (const k of KEYS) if (rnd() < 0.5) style[k] = pool[Math.floor(rnd() * pool.length)]
      raw.push({ id: 'p' + i, name: 'お気に入り' + i, style })
    }
    const m = await loadWith(KEY, JSON.stringify(raw))
    const presets = m.usePresetStore.getState().captionPresets
    expect(presets).toHaveLength(200)
    for (const p of presets) {
      for (const k of KEYS) {
        expect((p.style as unknown as Record<string, unknown>)[k], `${p.name}.${k}`).not.toBe(undefined)
      }
    }
  })

  it('境界: 壊れた localStorage は今までどおり空にする(直せるものだけ直す)', async () => {
    for (const bad of ['', 'null', '5', '{}', '[', '[null]', '["a"]', '[{"id":1}]']) {
      const m = await loadWith(KEY, bad)
      expect(m.usePresetStore.getState().captionPresets, bad).toEqual([])
    }
  })

  it('境界: style がオブジェクトでないお気に入りは、今までどおり捨てる', async () => {
    // 名前しか無いものは「テロップの見た目のお気に入り」として意味を成さない
    const m = await loadWith(
      KEY,
      JSON.stringify([
        { id: 'a', name: '形なし' },
        { id: 'b', name: '文字列', style: 'ゴシック' },
        { id: 'c', name: '正しい', style: {} }
      ])
    )
    expect(m.usePresetStore.getState().captionPresets.map((p) => p.name)).toEqual(['正しい'])
  })

  it('書き込む側も同じ規則を通る(次に開いたときだけ直る、を作らない)', async () => {
    const m = await loadWith(KEY, '[]')
    m.usePresetStore.getState().addCaptionPreset('手書き', { fontSize: 30 } as never)
    const s = m.usePresetStore.getState().captionPresets[0].style
    expect(s.fontSize).toBe(30)
    expect(s.color).toBe('#ffffff')
    // localStorage に書いた中身も揃っている
    const written = JSON.parse(store.get(KEY) as string)
    for (const k of KEYS) expect(written[0].style[k], k).not.toBe(undefined)
  })

  it('対照: 効果音と書き出し設定のお気に入りは今までどおり', async () => {
    store.clear()
    store.set('ve-se-presets', JSON.stringify([{ id: 's', name: 'ドン', filePath: '/a.wav', fileName: 'a.wav' }]))
    store.set(
      've-export-presets',
      JSON.stringify([
        { id: 'e', name: '配信用', resolutionHeight: 1080, quality: 'high', loudnessNormalization: true },
        { id: 'x', name: '知らない画質', resolutionHeight: 1080, quality: 'ultra', loudnessNormalization: true }
      ])
    )
    vi.resetModules()
    const m = await import('@renderer/store/presetStore')
    expect(m.usePresetStore.getState().sePresets).toHaveLength(1)
    expect(m.usePresetStore.getState().exportPresets.map((p) => p.name)).toEqual(['配信用'])
  })
})
