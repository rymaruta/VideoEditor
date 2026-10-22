import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 【レグレッション 2026-10】書き出しの失敗の文面が、原因の分からないものだった。
 *
 * - 入点が素材の長さより後ろのクリップ: 標準は「メディアファイルを処理できませんでした」だけ、
 *   区間ごとは英語の生の文「…: Error opening output files: Invalid argument」
 * - 書き出し先のフォルダが無い: 「ファイルが見つかりません。移動または削除された可能性があります」で、
 *   素材が消えたと誤解させた
 *
 * どのクリップか・何をすればよいかが分かる日本語にする。
 */
const work = mkdtempSync(join(tmpdir(), 've-experr-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

async function source(): Promise<MediaAsset> {
  const path = join(work, 'cam1.mp4')
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=160x90:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=d=2:sample_rate=48000',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    path
  ])
  const p = await probeMedia(path)
  return {
    id: 'cam1',
    filePath: path,
    fileName: 'cam1.mp4',
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: true,
    hasVideo: true
  }
}

function project(a: MediaAsset, inPoint: number, outPoint: number): Project {
  return {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [a],
    clips: [
      { id: 'c0', assetId: a.id, inPoint: 0, outPoint: 1, speed: 1 },
      { id: 'c1', assetId: a.id, inPoint, outPoint, speed: 1 }
    ],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  } as unknown as Project
}

async function messages(p: Project, outDir: string): Promise<{ std: string; seg: string }> {
  const std = await exportProject({
    project: p,
    aspectRatio: '16:9',
    resolutionHeight: 360 as never,
    quality: 'standard',
    outputPath: join(outDir, 'std.mp4'),
    telopLayer: null,
    onProgress: () => {}
  }).then(
    () => '(成功)',
    (e: Error) => e.message
  )
  const seg = await exportSequenceSegmented({
    project: projectV1ToV2(p, { resolution: 360 as never }),
    outputPath: join(outDir, 'seg.mp4'),
    quality: 'standard',
    encoder: 'libx264',
    telopLayer: null
  }).then(
    () => '(成功)',
    (e: Error) => e.message
  )
  return { std, seg }
}

describe.skipIf(!existsSync(ffmpegPath))('書き出しの失敗の文面', () => {
  it('入点が素材の長さより後ろのクリップは、どのクリップか・どうすればよいかを日本語で言う', async () => {
    const a = await source()
    const { std, seg } = await messages(project(a, 5, 7), work)
    // 修正前(実測): このクリップ1本だけの企画では std「メディアファイルを処理できませんでした」、
    // seg「メディアファイルを処理できませんでした: Error opening output files: Invalid argument」。
    // 前に別のクリップがあると、どちらもエラー無しで2本目の絵と音が無いまま書き出していた
    for (const m of [std, seg]) {
      expect(m).toContain('cam1.mp4')
      expect(m).toContain('2本目')
      expect(m).toContain('入点')
      expect(m).not.toMatch(/[A-Za-z]{4,} [A-Za-z]{4,}/)
    }
  }, 60_000)

  it('書き出し先のフォルダが無いときは、素材ではなく書き出し先の問題だと言う', async () => {
    const a = await source()
    const { std, seg } = await messages(project(a, 0, 1), join(work, 'no-such-folder'))
    // 修正前(実測): どちらも「ファイルが見つかりません。移動または削除された可能性があります」
    for (const m of [std, seg]) {
      expect(m).toContain('書き出し先のフォルダ')
      expect(m).not.toContain('移動または削除')
    }
  }, 60_000)
})
