import { execFileSync, spawnSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ffmpegPath, probeMedia } from '@main/ffmpegService'
import {
  cleanupOutsideWorkDirs,
  exportSequenceSegmented,
  setOutsideWorkRegistryPath
} from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 【レグレッション 2026-10】区間ごとの書き出しの一時ファイルが、ディスクを使い尽くしていた。
 *
 * 区間ごとの音を無圧縮の 32bit WAV(1 秒 384KB)にし、さらに全体を1本の full.wav に写していたので、
 * 音だけで 1 秒 768KB が同時に残った(実地テスト: 95 分で一時フォルダ 4.2GB・full.wav 2.2GB、
 * 3時間なら 8GB 超。full.wav は 4GiB を越えると WAV の大きさの欄があふれる)。
 * 空きが足りないかを始める前に見ておらず、途中で止めても理由が分からなかった。
 *
 * 短い素材でも比率で確かめられる: 仕上げ(映像と音をまとめる)の直前の一時フォルダの音の大きさ、
 * 一番大きな音のファイルが区間1つ分より大きくないこと(全体の1本を作らない)、空きが足りないとき・
 * 途中で減りすぎたとき・取り消したときに一時ファイルと作りかけの出力が残らないこと
 */
const work = mkdtempSync(join(tmpdir(), 've-segtmp-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const DUR = 12
/** 区間は 3〜4 秒(4区間前後) */
const SEG = { targetFrames: 105, minFrames: 90, maxFrames: 120 }
/** 32bit 浮動小数・2ch・48kHz の 1 秒(前の区間の WAV と full.wav は、それぞれこの大きさ) */
const F32_BYTES_PER_SEC = 48000 * 2 * 4

let project: Project

beforeAll(async () => {
  const src = join(work, 'talk.mp4')
  // 話し声らしい音(揺れる音程に小さな雑音)。撮影した素材と同じく AAC で持つ
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=160x90:r=30:d=${DUR}`,
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='0.3*sin(2*PI*(200+40*sin(2*PI*3*t))*t)*(0.6+0.4*sin(2*PI*2*t))+0.01*(2*random(0)-1)|` +
      `0.3*sin(2*PI*(210+40*sin(2*PI*3*t))*t)*(0.6+0.4*sin(2*PI*2*t))+0.01*(2*random(1)-1)':d=${DUR}:s=48000`,
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    src
  ])
  const p = await probeMedia(src)
  const asset: MediaAsset = {
    id: 'A',
    filePath: src,
    fileName: 'talk',
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: true,
    hasVideo: true
  }
  project = {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [asset],
    clips: [{ id: 'c', assetId: 'A', inPoint: 0, outPoint: DUR, speed: 1 }],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  } as unknown as Project
}, 60_000)

/** フォルダの下のファイル(名前と大きさ) */
function filesUnder(dir: string): { name: string; size: number }[] {
  const out: { name: string; size: number }[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...filesUnder(p))
    else out.push({ name: e.name, size: statSync(p).size })
  }
  return out
}

function freshDirs(name: string): { temp: string; out: string } {
  const temp = join(work, `${name}-tmp`)
  mkdirSync(temp)
  return { temp, out: join(work, `${name}.mp4`) }
}

const v2 = (): ReturnType<typeof projectV1ToV2> =>
  projectV1ToV2(project, { resolution: 360 as never })

describe.skipIf(!existsSync(ffmpegPath))('区間ごとの書き出しの一時ファイル', () => {
  it('音の一時ファイルは前の4割より小さく、全体を1本にしたファイルを作らない(出来上がりは同じ長さ)', async () => {
    const { temp, out } = freshDirs('size')
    let atFinish: { name: string; size: number }[] | null = null
    let peakAudio = 0
    const audioOf = (files: { name: string; size: number }[]): number =>
      files
        .filter((f) => !f.name.endsWith('.mp4') && !f.name.endsWith('.txt'))
        .reduce((n, f) => n + f.size, 0)
    const r = await exportSequenceSegmented({
      project: v2(),
      outputPath: out,
      quality: 'standard',
      encoder: 'libx264',
      telopLayer: null,
      loudnessNormalization: true,
      segmentOptions: SEG,
      tempDir: temp,
      onProgress: (_p, stage) => {
        // 進みの知らせは書き出しの中から同期で呼ばれるので、その時の一時フォルダをそのまま見られる
        const files = filesUnder(temp)
        peakAudio = Math.max(peakAudio, audioOf(files))
        if (stage === '仕上げ中') atFinish = files
      }
    })
    expect(r.segments).toBeGreaterThanOrEqual(3)
    expect(atFinish, '仕上げの直前の一時フォルダ').not.toBeNull()
    const files = atFinish as unknown as { name: string; size: number }[]
    const audio = files.filter((f) => !f.name.endsWith('.mp4') && !f.name.endsWith('.txt'))
    const audioBytes = audio.reduce((n, f) => n + f.size, 0)
    const largest = Math.max(...audio.map((f) => f.size))
    const label = files.map((f) => `${f.name} ${f.size}`).join('\n')
    // 一時フォルダを本当に見ている(空のフォルダだと比率の確かめが素通りする): 区間ごとの音が区間の数だけあり、
    // 映像も区間の数だけある
    expect(audio.filter((f) => f.size > 0).length, label).toBeGreaterThanOrEqual(r.segments)
    expect(files.filter((f) => f.name.endsWith('.mp4')).length, label).toBe(r.segments)
    expect(audioBytes, label).toBeGreaterThan(0)
    // 前は区間の WAV + full.wav で 1 秒あたり 768KB(32bit の 2 倍)。いまは 32bit の 0.8 倍より小さい
    // (AAC から戻した音は縮みにくい。この素材で約 0.67、記録映像の話し声で約 0.37)
    expect(audioBytes / DUR / F32_BYTES_PER_SEC, label).toBeLessThan(0.8)
    expect(peakAudio / DUR / F32_BYTES_PER_SEC, label).toBeLessThan(0.8)
    // 全体の1本(4GiB を越えると壊れうる)を作らない: 一番大きな音のファイルは区間1つ分以下
    expect(largest, label).toBeLessThanOrEqual((SEG.maxFrames / 30) * F32_BYTES_PER_SEC)
    expect(
      files.some((f) => f.name === 'full.wav'),
      label
    ).toBe(false)
    // 終わったら一時フォルダは空
    expect(readdirSync(temp)).toEqual([])
    // 出来上がり: 映像のフレーム数と音の長さが尺どおり
    const decode = spawnSync(ffmpegPath, ['-v', 'error', '-i', out, '-f', 'null', '-'], {
      encoding: 'utf8'
    })
    expect(decode.stderr).toBe('')
    const m = await probeMedia(out)
    expect(Math.abs(m.duration - DUR)).toBeLessThan(0.05)
  }, 180_000)

  it('空きが見込みに足りなければ、始める前に分かる文面で止める(何も残さない)', async () => {
    const { temp, out } = freshDirs('nospace')
    // 見込み(一時ファイル約 4.7MB + 出力)と、空きを残す分 512MB を足すと届かない
    const free = 514 * 1024 * 1024
    await expect(
      exportSequenceSegmented({
        project: v2(),
        outputPath: out,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null,
        segmentOptions: SEG,
        tempDir: temp,
        diskFree: () => free
      })
    ).rejects.toThrow(/ディスクの空きが足りないため、書き出しを始めませんでした。.*空きは 514 MB/)
    expect(readdirSync(temp)).toEqual([])
    expect(existsSync(out)).toBe(false)
  }, 60_000)

  it('書き出しの途中で空きが減りすぎたら止め、一時ファイルと作りかけの出力を消す', async () => {
    const { temp, out } = freshDirs('lowdisk')
    let calls = 0
    // 始める前の見積もり(一時フォルダ・書き出し先)では十分、その後は残り 100MB
    const diskFree = (): number => (calls++ < 2 ? 1e12 : 100 * 1024 * 1024)
    await expect(
      exportSequenceSegmented({
        project: v2(),
        outputPath: out,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null,
        segmentOptions: SEG,
        tempDir: temp,
        diskFree
      })
    ).rejects.toThrow(/書き出しの途中でディスクの空きが残り 100 MB になったため、止めました/)
    expect(readdirSync(temp)).toEqual([])
    expect(existsSync(out)).toBe(false)
  }, 60_000)

  it('取り消したら、一時ファイルと作りかけの出力を消す', async () => {
    const { temp, out } = freshDirs('cancel')
    const ac = new AbortController()
    await expect(
      exportSequenceSegmented({
        project: v2(),
        outputPath: out,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null,
        segmentOptions: SEG,
        tempDir: temp,
        maxParallel: 1,
        signal: ac.signal,
        // 区間が1つ書けたところで取り消す
        onProgress: (p) => {
          if (p > 0 && readdirSync(temp).length > 0) ac.abort()
        }
      })
    ).rejects.toThrow('EXPORT_CANCELED')
    expect(readdirSync(temp)).toEqual([])
    expect(existsSync(out)).toBe(false)
  }, 60_000)

  it('書き出し先に作った作業場(.ve-seg-*)が落ちて残っても、記録から次の起動で消す(利用者のフォルダは消さない)', async () => {
    const dir = join(work, 'registry')
    mkdirSync(dir)
    const registry = join(dir, 'export-work-dirs.json')
    setOutsideWorkRegistryPath(registry)
    try {
      const left = join(dir, 'out', '.ve-seg-abc')
      const user = join(dir, 'out', 'my-videos')
      for (const d of [left, user]) mkdirSync(d, { recursive: true })
      writeFileSync(join(left, 'seg_00000.mp4'), 'x')
      const gone = join(dir, 'gone', '.ve-seg-x')
      writeFileSync(registry, JSON.stringify([left, user, gone]))
      // 起動時の片付けは、書き出し先のぶんを非同期で後回しにする(切れたドライブで main を止めない)
      await cleanupOutsideWorkDirs(Date.now() + 13 * 3600 * 1000)
      expect(existsSync(left)).toBe(false)
      // 名前が .ve-seg- でないものは消さない(記録からは外す)。もう無いものも記録から外す
      expect(existsSync(user)).toBe(true)
      expect(JSON.parse(readFileSync(registry, 'utf-8'))).toEqual([])
      // 半日経っていないものは残し、記録にも残す
      const recent = join(dir, 'out', '.ve-seg-recent')
      mkdirSync(recent)
      writeFileSync(registry, JSON.stringify([recent]))
      await cleanupOutsideWorkDirs(Date.now())
      expect(existsSync(recent)).toBe(true)
      expect(JSON.parse(readFileSync(registry, 'utf-8'))).toEqual([recent])
      // 消せなかったもの(ここでは消す前の stat が失敗する、ENOENT 以外)は記録に残す
      const blocked = join(dir, 'out', 'file-not-dir', '.ve-seg-y')
      writeFileSync(join(dir, 'out', 'file-not-dir'), 'x')
      writeFileSync(registry, JSON.stringify([blocked]))
      await cleanupOutsideWorkDirs(Date.now() + 13 * 3600 * 1000)
      expect(JSON.parse(readFileSync(registry, 'utf-8'))).toEqual([blocked])
    } finally {
      setOutsideWorkRegistryPath(null)
    }
  })
})
