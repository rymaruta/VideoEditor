/**
 * 素の値のサービス(`createWaveformPeaksService`)を本物の ffmpeg で確かめる(監査 58f85e1 の中1〜3)。
 * - 素の値を作る ffmpeg は同時に 2 本まで。待っている頼みが全部止められたら作らない・止める
 * - 作れなかった素材は短い間覚え、見えるたびに読み直さない
 * - 同じパスに上書きした素材は、新しい中身で返し、素材の鍵(sourceKey)も変わる
 * - ディスク: 書きかけ(.tmp)を起動時に消す・合計の上限で古いものから消す・上書き前の素の値を消す
 * ffmpeg の起動を数えるため、ffmpeg を呼ぶたびに 1 行書く小さな包み(シェル)を挟む。
 * ffmpeg(node_modules/ffmpeg-static)が無ければ飛ばす。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegStatic from 'ffmpeg-static'
import { ffprobePath } from '@main/ffmpegService'
import { createWaveformPeaksService, wavePathPrefix } from '@main/waveformPeaks'

const ffmpeg = ffmpegStatic as unknown as string
const has = typeof ffmpeg === 'string' && existsSync(ffmpeg) && process.platform !== 'win32'
const dir = mkdtempSync(join(tmpdir(), 've-wbase-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const log = join(dir, 'spawns.log')
const wrapper = join(dir, 'ffmpeg-counting.sh')
function spawns(): number {
  try {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function tone(file: string, freq: number, seconds: number): void {
  execFileSync(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=f=${freq}:d=${seconds}:sample_rate=48000`,
    '-af',
    'volume=4',
    '-ac',
    '1',
    file
  ])
}

describe.skipIf(!has)('素の値のサービス(本物の ffmpeg)', () => {
  writeFileSync(wrapper, `#!/bin/sh\necho x >> "${log}"\nexec "${ffmpeg}" "$@"\n`)
  chmodSync(wrapper, 0o755)
  const media = join(dir, 'media')
  mkdirSync(media, { recursive: true })

  it('素の値を作る ffmpeg は、たくさん頼まれても同時に 2 本まで', async () => {
    const files = Array.from({ length: 8 }, (_, i) => join(media, `m${i}.wav`))
    files.forEach((f, i) => tone(f, 200 + i * 50, 30))
    const svc = createWaveformPeaksService({
      ffmpegPath: wrapper,
      ffprobePath,
      cacheDir: join(dir, 'cache-many'),
      directMaxSec: 0
    })
    let peakRunning = 0
    const timer = setInterval(() => {
      peakRunning = Math.max(peakRunning, svc.building.running)
    }, 5)
    const results = await Promise.all(files.map((f) => svc.get(f, 0, 30, 300)))
    clearInterval(timer)
    expect(results.every((p) => p.channels[0].max[100] > 0.45)).toBe(true)
    expect(svc.building.peak).toBeLessThanOrEqual(2)
    expect(peakRunning).toBeLessThanOrEqual(2)
  }, 120_000)

  it('待っている頼みが全部止められたら、作らない・作っていれば止める', async () => {
    const files = Array.from({ length: 6 }, (_, i) => join(media, `a${i}.wav`))
    files.forEach((f, i) => tone(f, 300 + i * 40, 60))
    const svc = createWaveformPeaksService({
      ffmpegPath: wrapper,
      ffprobePath,
      cacheDir: join(dir, 'cache-abort'),
      directMaxSec: 0
    })
    const before = spawns()
    const acs = files.map(() => new AbortController())
    const all = files.map((f, i) => svc.get(f, 0, 60, 600, acs[i].signal))
    await new Promise((r) => setTimeout(r, 50))
    for (const ac of acs) ac.abort()
    const settled = await Promise.allSettled(all)
    expect(settled.every((s) => s.status === 'rejected')).toBe(true)
    // 走っていた 2 本が止まり、待っていた 4 本は起こさない
    // 走っているものは頼み直しを待つ猶予(2 秒)のあとで止まる
    await new Promise((r) => setTimeout(r, 2600))
    expect(svc.building).toMatchObject({ running: 0, waiting: 0 })
    expect(spawns() - before).toBeLessThanOrEqual(2)
    // 止めた素材は「作れなかった」として覚えない(また見えたら作る)
    const again = await svc.get(files[0], 0, 60, 600)
    expect(again.channels[0].max[10]).toBeGreaterThan(0.45)
  }, 120_000)

  it('作れなかった素材は短い間覚え、見えるたびに ffmpeg を起こさない', async () => {
    const bad = join(media, 'not-audio.wav')
    writeFileSync(bad, 'this is not audio')
    const svc = createWaveformPeaksService({
      ffmpegPath: wrapper,
      ffprobePath,
      cacheDir: join(dir, 'cache-fail'),
      failureMs: 60_000
    })
    await expect(svc.get(bad, 0, 10, 100)).rejects.toBeTruthy()
    const after1 = spawns()
    for (let i = 0; i < 5; i++) await expect(svc.get(bad, 0, 10, 100)).rejects.toBeTruthy()
    expect(spawns()).toBe(after1)
  }, 60_000)

  it('同じパスに上書きした素材は新しい中身で返し、素材の鍵も上書き前の素の値も替わる', async () => {
    const a = join(media, 'swapA.wav')
    const b = join(media, 'swapB.wav')
    const target = join(media, 'swap.wav')
    tone(a, 220, 10)
    // B は前半が無音(A と見分ける)
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=220:d=10:sample_rate=48000',
      '-af',
      "volume=4,volume='if(lt(t,5),0,1)':eval=frame",
      '-ac',
      '1',
      b
    ])
    copyFileSync(a, target)
    const cacheDir = join(dir, 'cache-swap')
    const svc = createWaveformPeaksService({
      ffmpegPath: ffmpeg,
      ffprobePath,
      cacheDir,
      directMaxSec: 0
    })
    const first = await svc.get(target, 0, 10, 100)
    expect(first.channels[0].max[10]).toBeGreaterThan(0.45)
    const st = statSync(target)
    copyFileSync(b, target)
    // 更新時刻も大きさも同じにする(録音機が名前を使い回す・時刻を保つコピー)
    utimesSync(target, st.atime, st.mtime)
    const second = await svc.get(target, 0, 10, 100)
    expect(second.channels[0].max[10]).toBeLessThan(0.01)
    expect(second.sourceKey).toBeDefined()
    expect(second.sourceKey).not.toBe(first.sourceKey)
    const prefix = `${wavePathPrefix(target)}-`
    expect(readdirSync(cacheDir).filter((f) => f.startsWith(prefix))).toHaveLength(1)
  }, 60_000)

  it('ディスク: 起動時に書きかけを消し、合計の上限を越えたら使っていないものから消す', async () => {
    const cacheDir = join(dir, 'cache-disk')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'left.wpk.123-abc.tmp'), 'x')
    const files = Array.from({ length: 3 }, (_, i) => join(media, `d${i}.wav`))
    files.forEach((f, i) => tone(f, 400 + i * 30, 20))
    // 20 秒のモノラルの素の値は 20×100×6 + 24 = 12,024 バイト。2 つぶんまで
    const svc = createWaveformPeaksService({
      ffmpegPath: ffmpeg,
      ffprobePath,
      cacheDir,
      diskBytes: 25_000,
      directMaxSec: 0
    })
    expect(readdirSync(cacheDir).some((f) => f.endsWith('.tmp'))).toBe(false)
    await svc.get(files[0], 0, 20, 100)
    await new Promise((r) => setTimeout(r, 20))
    await svc.get(files[1], 0, 20, 100)
    await new Promise((r) => setTimeout(r, 20))
    await svc.get(files[2], 0, 20, 100)
    const left = readdirSync(cacheDir).filter((f) => f.endsWith('.wpk'))
    expect(left).toHaveLength(2)
    expect(left.some((f) => f.startsWith(wavePathPrefix(files[0])))).toBe(false)
  }, 60_000)

  it('短い範囲は素の値を作らずに、その範囲だけ読む(素材全体を読まない)', async () => {
    const long = join(media, 'long.wav')
    tone(long, 330, 200)
    const cacheDir = join(dir, 'cache-direct')
    const svc = createWaveformPeaksService({
      ffmpegPath: wrapper,
      ffprobePath,
      cacheDir
    })
    const t0 = Date.now()
    const p = await svc.get(long, 50, 54, 400)
    expect(p.columns).toBe(400)
    expect(p.channels).toHaveLength(1)
    expect(p.channels[0].max[100]).toBeGreaterThan(0.45)
    expect(p.sourceKey).toBeDefined()
    expect(svc.memoryBytes).toBe(0)
    expect(
      existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.endsWith('.wpk')) : []
    ).toHaveLength(0)
    expect(Date.now() - t0).toBeLessThan(10_000)
    // 長い範囲を頼んだら素の値を作る
    await svc.get(long, 0, 200, 400)
    expect(readdirSync(cacheDir).filter((f) => f.endsWith('.wpk'))).toHaveLength(1)
  }, 60_000)

  it('拡大・縮小で止められてもすぐ頼み直されたら、作っている素の値を止めずに使う', async () => {
    const f = join(media, 'regrace.wav')
    tone(f, 260, 120)
    const svc = createWaveformPeaksService({
      ffmpegPath: wrapper,
      ffprobePath,
      cacheDir: join(dir, 'cache-grace'),
      directMaxSec: 0
    })
    const before = spawns()
    const ac = new AbortController()
    const first = svc.get(f, 0, 120, 600, ac.signal)
    await new Promise((r) => setTimeout(r, 50))
    ac.abort()
    await expect(first).rejects.toThrow('PCM_ABORTED')
    // 前の段の頼みが止められた直後に、次の段で同じ素材を頼む
    const second = await svc.get(f, 0, 120, 1200)
    expect(second.channels[0].max[100]).toBeGreaterThan(0.45)
    // 素の値を作る ffmpeg は 1 回だけ(止めて作り直さない)
    expect(spawns() - before).toBe(1)
  }, 60_000)

  it('素の値が無い短い範囲でも、同じ素材のタイルの 1 段 / 2 段は食い違わない', async () => {
    // L: 大きい所と 1/10 の静かな所が 20 秒ごとに入れ替わる話し声ふう、R: -50dBFS ほどの弱いノイズ
    for (const [name, right] of [
      ['lr_quiet.wav', 'anoisesrc=d=120:c=white:a=0.003:r=48000'],
      ['lr_hiss.wav', 'anoisesrc=d=120:c=white:a=0.0003:r=48000']
    ]) {
      const f = join(media, name)
      execFileSync(ffmpeg, [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=f=220:d=120:sample_rate=48000',
        '-f',
        'lavfi',
        '-i',
        right,
        '-filter_complex',
        "[0]volume='if(mod(floor(t/20),2),0.28,2.8)':eval=frame[l];[l][1]join=inputs=2:channel_layout=stereo",
        '-c:a',
        'pcm_f32le',
        f
      ])
      const svc = createWaveformPeaksService({
        ffmpegPath: ffmpeg,
        ffprobePath,
        cacheDir: join(dir, `cache-pick-${name}`)
      })
      const lanes: number[] = []
      for (let a = 0; a + 6.4 <= 120; a += 6.4) {
        const p = await svc.get(f, a, a + 6.4, 2048)
        lanes.push(p.channels.length)
      }
      expect(new Set(lanes).size).toBe(1)
    }
  }, 120_000)

  it('メモリから使ったときも .wpk の更新時刻を触る(1GB の片付けで使用中を消さない)', async () => {
    const f = join(media, 'touch.wav')
    tone(f, 280, 10)
    const cacheDir = join(dir, 'cache-touch')
    const svc = createWaveformPeaksService({
      ffmpegPath: ffmpeg,
      ffprobePath,
      cacheDir,
      directMaxSec: 0
    })
    await svc.get(f, 0, 10, 100)
    const wpk = join(
      cacheDir,
      readdirSync(cacheDir).find((x) => x.endsWith('.wpk'))!
    )
    utimesSync(wpk, new Date(0), new Date(0))
    await svc.get(f, 0, 10, 200)
    expect(statSync(wpk).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  }, 60_000)
})
