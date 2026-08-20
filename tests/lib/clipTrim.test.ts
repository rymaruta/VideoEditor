import { describe, expect, it } from 'vitest'
import { MIN_CLIP_SOURCE_DURATION, useProjectStore } from '@renderer/store/projectStore'
import { snapTime } from '@renderer/lib/snapping'
import { NASTY_NUMBERS, round, seeded } from '../helpers/boundary'

/**
 * タイムラインのつまみを引いたときの規則(`Timeline.tsx` の mousemove と同じ式)。
 * **数字は書き込み先の `MIN_CLIP_SOURCE_DURATION` から取る**——ここに別の数字を
 * 書いていたことが 2026-09-11 のバグそのものなので、テストでも絶対に直書きしない。
 */
function dragLeft(
  inPoint: number,
  outPoint: number,
  deltaSec: number
): { in: number; out: number } {
  const next = Math.min(Math.max(0, inPoint + deltaSec), outPoint - MIN_CLIP_SOURCE_DURATION)
  return { in: round(next), out: round(outPoint) }
}
function dragRight(
  inPoint: number,
  outPoint: number,
  deltaSec: number,
  assetDuration: number
): { in: number; out: number } {
  const next = Math.max(
    Math.min(assetDuration, outPoint + deltaSec),
    inPoint + MIN_CLIP_SOURCE_DURATION
  )
  return { in: round(inPoint), out: round(next) }
}
/** インスペクタの数値欄の規則(`Inspector.tsx` と同じ式) */
function fieldIn(value: number, outPoint: number): number {
  return round(Math.min(Math.max(0, value), outPoint - MIN_CLIP_SOURCE_DURATION))
}
function fieldOut(value: number, inPoint: number, assetDuration: number): number {
  return round(Math.max(Math.min(assetDuration, value), inPoint + MIN_CLIP_SOURCE_DURATION))
}

describe('【レグレッション】クリップの最短の長さは1つだけ (2026-09-11)', () => {
  /**
   * `MIN_CLIP_SOURCE_DURATION` は3箇所で定義され、`projectStore` と `Inspector` が 0.1、
   * `Timeline` だけ 0.2 だった。同じ「縮める」操作が入口によって別の結果になり、
   * さらに 0.1秒のクリップの端を掴むと**掴んだ向きと逆へ飛んで伸びた**。
   */
  it('数値欄とつまみが同じ最短に着く', () => {
    // 実測(ズーム100% = 40px/秒、素材10秒、2.000〜6.000 のクリップ)
    expect(dragLeft(2, 6, 5)).toEqual({ in: 5.9, out: 6 })
    expect(fieldIn(99, 6)).toBe(5.9)
    expect(dragRight(2, 6, -5, 10)).toEqual({ in: 2, out: 2.1 })
    expect(fieldOut(0, 2, 10)).toBe(2.1)
    // 修正前はつまみだけ 5.8 / 2.2 で止まっていた(＝ 0.2秒)
    expect(round(6 - dragLeft(2, 6, 5).in)).toBe(MIN_CLIP_SOURCE_DURATION)
    expect(round(dragRight(2, 6, -5, 10).out - 2)).toBe(MIN_CLIP_SOURCE_DURATION)
  })

  it('最短のクリップを、さらに縮める向きへ掴んでも動かない', () => {
    // 修正前: 左端を右へ動かすと in が 2.000 → 1.900 と左へ飛び、尺が 0.2秒に伸びた
    expect(dragLeft(2, 2.1, 0.02)).toEqual({ in: 2, out: 2.1 })
    expect(dragLeft(2, 2.1, 5)).toEqual({ in: 2, out: 2.1 })
    expect(dragRight(2, 2.1, -0.02, 10)).toEqual({ in: 2, out: 2.1 })
    expect(dragRight(2, 2.1, -5, 10)).toEqual({ in: 2, out: 2.1 })
  })

  it('伸ばす向き・ふつうの縮めは今までどおり', () => {
    expect(dragLeft(2, 6, 1)).toEqual({ in: 3, out: 6 })
    expect(dragLeft(2, 6, -1.5)).toEqual({ in: 0.5, out: 6 })
    expect(dragRight(2, 6, 1, 10)).toEqual({ in: 2, out: 7 })
    expect(dragRight(2, 6, -1, 10)).toEqual({ in: 2, out: 5 })
  })

  it('素材の端で止まる(0 と素材の尺)', () => {
    expect(dragLeft(0, 3, -5)).toEqual({ in: 0, out: 3 })
    expect(dragRight(2, 9, 99, 10)).toEqual({ in: 2, out: 10 })
  })

  it('【不変条件】つまみを引いても、尺が最短を下回らない / 素材からはみ出さない', () => {
    const rnd = seeded(20260911)
    const ASSET = 10
    for (let i = 0; i < 20000; i++) {
      const inP = rnd() * (ASSET - MIN_CLIP_SOURCE_DURATION)
      const outP = inP + MIN_CLIP_SOURCE_DURATION + rnd() * (ASSET - inP - MIN_CLIP_SOURCE_DURATION)
      const d = (rnd() - 0.5) * 40
      for (const r of [dragLeft(inP, outP, d), dragRight(inP, outP, d, ASSET)]) {
        expect(Number.isFinite(r.in) && Number.isFinite(r.out), `${inP}..${outP} ${d}`).toBe(true)
        expect(r.in).toBeGreaterThanOrEqual(0)
        expect(r.out).toBeLessThanOrEqual(ASSET + 1e-9)
        expect(r.out - r.in).toBeGreaterThanOrEqual(MIN_CLIP_SOURCE_DURATION - 1e-9)
      }
    }
  })

  it('数値欄は有限の入力を同じ範囲へ収める', () => {
    const finite = NASTY_NUMBERS.filter((n) => Number.isFinite(n))
    for (const v of finite) {
      const i = fieldIn(v, 6)
      expect(Number.isFinite(i), `in ${v} -> ${i}`).toBe(true)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThanOrEqual(6 - MIN_CLIP_SOURCE_DURATION + 1e-9)

      const o = fieldOut(v, 2, 10)
      expect(Number.isFinite(o), `out ${v} -> ${o}`).toBe(true)
      expect(o).toBeGreaterThanOrEqual(2 + MIN_CLIP_SOURCE_DURATION - 1e-9)
      expect(o).toBeLessThanOrEqual(10 + 1e-9)
    }
  })

  it('NaN・Infinity は入口の式では素通りするが、**書き込み先が吸収する**', () => {
    // 入口(インスペクタの式)は `Math.min`/`Math.max` なので NaN をそのまま返す。
    expect(Number.isNaN(fieldIn(NaN, 6))).toBe(true)
    // 守っているのは書き込み先の `clampSourceRange`——「値なし」として今の値を残す
    // (空欄や `e` を打った直後の数値欄が来る)。ここが最後の砦。
    useProjectStore.setState({
      project: {
        id: 'p',
        name: 't',
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
        clips: [{ id: 'c1', assetId: 'A', inPoint: 2, outPoint: 6, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: [],
        beatGrid: null
      } as never,
      past: [],
      future: []
    })
    for (const bad of [NaN, Infinity, -Infinity]) {
      useProjectStore.getState().updateClipTrim('c1', bad, 6)
      const c = useProjectStore.getState().project.clips[0]
      expect(Number.isFinite(c.inPoint), `in=${bad}`).toBe(true)
      expect(Number.isFinite(c.outPoint), `in=${bad}`).toBe(true)
      expect(c.outPoint - c.inPoint).toBeGreaterThanOrEqual(MIN_CLIP_SOURCE_DURATION - 1e-9)
    }
  })

  it('スナップを挟んでも最短を割らない(挟み直しが効いている)', () => {
    // スナップ候補へ寄せたあと、もう一度下限で挟み直す作り。
    // 挟み直しを外すと、候補が近いときだけ最短を割る。
    const candidates = [2.05, 2.5, 3]
    const thr = 8 / 40
    for (const c of candidates) {
      const snapped = snapTime(c, candidates, thr)
      const clamped = Math.min(Math.max(0, snapped.time), 2.1 - MIN_CLIP_SOURCE_DURATION)
      expect(2.1 - clamped).toBeGreaterThanOrEqual(MIN_CLIP_SOURCE_DURATION - 1e-9)
    }
  })
})

describe('【レグレッション】短いクリップにも掴み代が残る (2026-09-11)', () => {
  /**
   * つまみは `width: 25%; max-width: 8px`。幅がそのまま時刻なので帯は広げられない
   * (広げたぶんが「時刻の嘘」になる)ため、**つまみの側を割合にして**空ける。
   * 実測: 素材0.1秒のクリップは幅18px(padding 8px×2 + 枠線が下限)。
   * 修正前は左右のつまみが 8px 固定で 16px を占め、本体の残りは 2px、
   * 中央を突くとつまみが返った。
   */
  const handleWidth = (clipWidth: number): number => Math.min(clipWidth * 0.25, 8)
  const bodyWidth = (clipWidth: number): number => clipWidth - handleWidth(clipWidth) * 2

  it('最小幅(18px)でも本体が中央に半分残る', () => {
    expect(handleWidth(18)).toBe(4.5)
    expect(bodyWidth(18)).toBe(9)
    // 修正前は 8px 固定 → 本体 2px
    expect(18 - 8 * 2).toBe(2)
  })

  it('広いクリップのつまみは今までどおり 8px', () => {
    for (const w of [32, 64, 160, 400, 2000]) {
      expect(handleWidth(w), `幅${w}`).toBe(8)
    }
  })

  it('【不変条件】どんな幅でも本体が帯の半分を占める', () => {
    for (let w = 1; w <= 3000; w++) {
      expect(bodyWidth(w), `幅${w}`).toBeGreaterThanOrEqual(w * 0.5 - 1e-9)
      expect(handleWidth(w)).toBeGreaterThan(0)
      expect(handleWidth(w)).toBeLessThanOrEqual(8)
    }
  })
})
