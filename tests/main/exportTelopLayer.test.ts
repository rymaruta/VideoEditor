import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath } from '@main/ffmpegService'
import type { TelopLayerPayload } from '@shared/telop/layer'
import {
  appendTelopLayerImages,
  beginTelopLayer,
  releaseTelopLayer,
  withTelopLayer
} from '@main/telopLayerStage'
import type { Project } from '@shared/types'
import { defaultTextStyle } from '@shared/textStyle'

/**
 * 標準の書き出しが、画面のプロセスが描いたテロップの層(透明 PNG の並び)を
 * 時刻どおりに重ねるか。**同梱の ffmpeg で実際に書き出して**、画素を読んで確かめる
 * (フィルタグラフの文字列を見るだけだと、ffmpeg が受け付けるか・透明が効くかが分からない)。
 */

const W = 854
const H = 480
let work = ''

function ff(args: string[]): Buffer {
  return execFileSync(ffmpegPath, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 26 })
}

/** 枠と同じ大きさの PNG。`leftRed` なら左半分だけ不透明の赤、ほかは透明 */
function layerPng(name: string, leftRed: boolean, w = W, h = H): Uint8Array {
  const path = join(work, name)
  const alpha = leftRed ? 'if(lt(X,W/2),255,0)' : '0'
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${w}x${h}:d=0.04,format=rgba,geq=r=255:g=0:b=0:a='${alpha}'`,
    '-frames:v',
    '1',
    path
  ])
  return new Uint8Array(readFileSync(path))
}

/** 書き出した動画の全フレームについて、点 (x, y) の色(RGB)を頭から順に */
function pixels(file: string, x: number, y: number): number[][] {
  const raw = ff([
    '-i',
    file,
    '-vf',
    // yuv420p のままだと 1x1 に切れない(色差が2画素単位)ので、先に RGB にする
    `format=rgb24,crop=1:1:${x}:${y}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-'
  ])
  const out: number[][] = []
  for (let k = 0; k + 3 <= raw.length; k += 3) out.push([raw[k], raw[k + 1], raw[k + 2]])
  return out
}

function project(clipPath: string): Project {
  return {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'a',
        filePath: clipPath,
        fileName: 'clip.mp4',
        duration: 1,
        width: W,
        height: H,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      }
    ],
    clips: [{ id: 'c', assetId: 'a', inPoint: 0, outPoint: 1, speed: 1 }],
    audioTracks: [],
    videoOverlayTracks: [],
    // 層を渡したときは ASS を使わない(文字を焼くなら層の赤とは別の色になる)
    textOverlays: [
      {
        id: 't',
        text: '**テスト**',
        startTime: 0,
        endTime: 1,
        style: defaultTextStyle()
      } as Project['textOverlays'][number]
    ]
  }
}

async function exportWith(
  layer: TelopLayerPayload,
  name: string,
  loudnessNormalization = false
): Promise<string> {
  const out = join(work, name)
  await exportProject({
    project: project(join(work, 'clip.mp4')),
    aspectRatio: '16:9',
    resolutionHeight: 480,
    quality: 'standard',
    outputPath: out,
    telopLayer: layer,
    loudnessNormalization,
    onProgress: () => {}
  })
  return out
}

const isRed = (p: number[]): boolean => p[0] > 200 && p[1] < 60 && p[2] < 60
const isBlue = (p: number[]): boolean => p[2] > 200 && p[0] < 60 && p[1] < 60

describe('標準の書き出しにテロップの層を重ねる', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 've-telop-test-'))
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=c=blue:s=${W}x${H}:r=30:d=1`,
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(work, 'clip.mp4')
    ])
  })
  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  it('区間のあいだだけ、透明を保ったまま重なる', async () => {
    const out = await exportWith(
      {
        width: W,
        height: H,
        images: [layerPng('empty.png', false), layerPng('red.png', true)],
        runs: [{ startFrame: 0, endFrame: 15, image: 1 }]
      },
      'out.mp4'
    )
    const left = pixels(out, 100, 240)
    const right = pixels(out, 700, 240)
    // 長さは本編のまま(層の一覧で伸び縮みしない)
    expect(left).toHaveLength(30)
    // 区間 [0, 15) だけ左は層の赤。境目はフレームちょうどで、その後は透明の0番に戻る
    expect(left.map(isRed)).toEqual(Array.from({ length: 30 }, (_, f) => f < 15))
    // 層の透明な所は元の映像(青)が見える
    expect(right.every(isBlue)).toBe(true)
  }, 20000)

  it('描きながら main の置き場へ送った層(`stagedId`)も同じに重なり、終われば置き場は消える', async () => {
    // 書き出しの本番の渡し方。画像は IPC の1回に載せず、少しずつ送ってディスクへ書いてある
    const id = beginTelopLayer(W, H)
    try {
      await appendTelopLayerImages(id, 0, [layerPng('empty-st.png', false)])
      await appendTelopLayerImages(id, 1, [layerPng('red-st.png', true)])
      const layer: TelopLayerPayload = {
        width: W,
        height: H,
        stagedId: id,
        imageCount: 2,
        runs: [{ startFrame: 0, endFrame: 15, image: 1 }]
      }
      const out = await withTelopLayer(layer, () => exportWith(layer, 'out-staged.mp4'))
      const left = pixels(out, 100, 240)
      expect(left).toHaveLength(30)
      expect(left.map(isRed)).toEqual(Array.from({ length: 30 }, (_, f) => f < 15))
      await expect(appendTelopLayerImages(id, 2, [new Uint8Array(1)])).rejects.toThrow(
        '見つかりません'
      )
    } finally {
      releaseTelopLayer(id)
    }
  }, 20000)

  it('層の大きさが出力と違っても、枠に合わせて重なる', async () => {
    const out = await exportWith(
      {
        width: W / 2,
        height: H / 2,
        images: [
          layerPng('empty-s.png', false, W / 2, H / 2),
          layerPng('red-s.png', true, W / 2, H / 2)
        ],
        runs: [{ startFrame: 0, endFrame: 30, image: 1 }]
      },
      'out-scaled.mp4',
      // 音量の測定パス(映像の枝を持たない)を通っても、層の入力がずれない
      true
    )
    // 最後のフレームまで出ているテロップでも、長さは本編のまま
    const left = pixels(out, 100, 240)
    expect(left).toHaveLength(30)
    expect(left.every(isRed)).toBe(true)
    expect(pixels(out, 700, 240).every(isBlue)).toBe(true)
  }, 20000)
})
