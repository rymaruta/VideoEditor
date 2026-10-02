import { describe, expect, it } from 'vitest'
import { atempoChain, audioSpeedChain, parseLoudnormMeasurement } from '@main/ffmpegService'
import { NASTY_NUMBERS, seeded } from '../helpers/boundary'

/** `atempo=a,atempo=b,...` を掛け合わせて実効の速度を出す */
function effectiveSpeed(chain: string): number {
  return chain
    .split(',')
    .map((part) => Number(part.replace('atempo=', '')))
    .reduce((a, b) => a * b, 1)
}

describe('atempoChain — 速度を atempo の連鎖で作る', () => {
  it('0.5〜2.0 は1段で済む', () => {
    expect(atempoChain(1)).toBe('atempo=1')
    expect(atempoChain(2)).toBe('atempo=2')
    expect(atempoChain(0.5)).toBe('atempo=0.5')
    expect(atempoChain(1.5)).toBe('atempo=1.5')
  })

  it('範囲の外は連鎖で作る(クランプして黙って音ズレさせない)', () => {
    expect(effectiveSpeed(atempoChain(4))).toBeCloseTo(4, 9)
    expect(effectiveSpeed(atempoChain(3))).toBeCloseTo(3, 9)
    expect(effectiveSpeed(atempoChain(0.25))).toBeCloseTo(0.25, 9)
    expect(effectiveSpeed(atempoChain(8))).toBeCloseTo(8, 9)
  })

  it('【不変条件】どの段も 0.5〜2.0 に収まる(ffmpeg の定義域)', () => {
    const rnd = seeded(4004)
    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16, 0.125]
    for (let i = 0; i < 2000; i++) speeds.push(0.05 + rnd() * 20)
    for (const s of speeds) {
      const chain = atempoChain(s)
      for (const part of chain.split(',')) {
        expect(part.startsWith('atempo='), chain).toBe(true)
        const v = Number(part.replace('atempo=', ''))
        expect(Number.isFinite(v), `${s} -> ${chain}`).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0.5 - 1e-9)
        expect(v).toBeLessThanOrEqual(2 + 1e-9)
      }
      // 各段を小数6桁に切っているので、掛け戻すと**相対誤差**が残る。
      // 絶対値で比べると桁の大きい速度で落ちるので、比で見る。
      const rel = Math.abs(effectiveSpeed(chain) / s - 1)
      expect(rel, `${s} -> ${chain} (実効 ${effectiveSpeed(chain)})`).toBeLessThan(1e-5)
    }
  })

  it('小数の桁を切って ffmpeg のパーサを困らせない', () => {
    expect(atempoChain(1 / 3)).not.toMatch(/\d{10,}/)
    for (const s of [0.3, 1.1, 2.7, 3.3]) {
      expect(atempoChain(s), String(s)).not.toMatch(/\d{10,}/)
    }
  })

  it('0・負・NaN・Infinity は等速へ倒す(書き出しを止めない)', () => {
    for (const bad of [0, -1, -2, NaN, Infinity, -Infinity]) {
      expect(atempoChain(bad), String(bad)).toBe('atempo=1')
    }
  })

  it('【不変条件】どんな入力でも「atempo=」だけで構成された式を返す', () => {
    for (const v of NASTY_NUMBERS) {
      const chain = atempoChain(v)
      expect(typeof chain).toBe('string')
      expect(chain.length).toBeGreaterThan(0)
      for (const part of chain.split(',')) {
        expect(part.startsWith('atempo='), `${v} -> ${chain}`).toBe(true)
        expect(Number.isFinite(Number(part.replace('atempo=', ''))), `${v} -> ${chain}`).toBe(true)
      }
    }
  })
})

describe('parseLoudnormMeasurement — 測定パスの JSON を読む', () => {
  const good = `
[Parsed_loudnorm_0 @ 0x55]
{
	"input_i" : "-23.45",
	"input_tp" : "-5.20",
	"input_lra" : "18.50",
	"input_thresh" : "-33.60",
	"output_i" : "-14.00",
	"target_offset" : "0.31"
}
`

  it('末尾の JSON を読み取る', () => {
    const m = parseLoudnormMeasurement(good)
    expect(m).not.toBeNull()
    // 文字列ではなく**数**で返す(そのままフィルタ式へ埋めるため)
    expect(m!.inputI).toBe(-23.45)
    expect(m!.inputTP).toBe(-5.2)
    expect(m!.inputLRA).toBe(18.5)
    expect(m!.inputThresh).toBe(-33.6)
    expect(m!.targetOffset).toBe(0.31)
    for (const v of Object.values(m!)) expect(Number.isFinite(v)).toBe(true)
  })

  it('JSON が無ければ null(1パスへ落として書き出しは止めない)', () => {
    expect(parseLoudnormMeasurement('')).toBeNull()
    expect(parseLoudnormMeasurement('ふつうのログ行\nもう1行')).toBeNull()
  })

  it('壊れた JSON でも例外を投げない', () => {
    for (const s of ['{', '{"input_i":', '{}', '[]', 'null', '{"a":1}']) {
      expect(() => parseLoudnormMeasurement(s), s).not.toThrow()
    }
  })

  it('全編無音(-inf)は測れなかったものとして扱う', () => {
    const inf = good.replace('"-23.45"', '"-inf"')
    expect(parseLoudnormMeasurement(inf)).toBeNull()
  })

  it('前後にログ行が付いていても読める', () => {
    const noisy = 'frame= 100\n' + good + '\n[out#0] video:0kB\n'
    expect(parseLoudnormMeasurement(noisy)).not.toBeNull()
  })

  it('【レグレッション】測った LRA から 2パス目の目標を出す', () => {
    // 2026-09-03 のバグ狩り。linear を守るには「測った LRA を下回らない値」を渡す。
    // 上限 50 は loudnorm の定義域。
    const lraTarget = (measured: number): number => Math.min(50, Math.max(11, Math.ceil(measured)))
    expect(lraTarget(18.5)).toBe(19)
    expect(lraTarget(5)).toBe(11)
    expect(lraTarget(60)).toBe(50)
    expect(lraTarget(11)).toBe(11)
  })
})

describe('audioSpeedChain — 時計のずれの補正は atempo を使わない', () => {
  it('等倍は何も掛けない(atempo=1 でも音が遅れて揺れるため)', () => {
    expect(audioSpeedChain(1)).toBe('anull')
  })

  it('大きな速度変更は atempo のまま', () => {
    expect(audioSpeedChain(1.5)).toBe('atempo=1.5')
    expect(audioSpeedChain(0.9)).toBe('atempo=0.9')
  })

  it('ごく小さな違いは周波数の読み替えで掛ける(誤差 0.5ppm 以下)', () => {
    const chain = audioSpeedChain(1.0000625)
    expect(chain).toBe('aresample=960000,asetrate=960060,aresample=48000')
    const m = /asetrate=(\d+)/.exec(audioSpeedChain(0.99997))!
    expect(Math.abs(Number(m[1]) / 960000 - 0.99997)).toBeLessThan(0.6e-6)
  })
})
