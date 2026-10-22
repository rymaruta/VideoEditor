import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * 【レグレッション 2026-10】標準の書き出しが、素材のメタデータとチャプターを出力へ写していた。
 *
 * - スマホ(Android)の MP4 の位置情報(`location` / `location-eng`)と題名(`title`)が、書き出した動画に残った
 * - チャプター6個付きの m4a を BGM に置くと、4 秒の動画にチャプター6個と 1650 秒のテキストトラックが付き、
 *   同梱の ffprobe 4.0.2 が長さを 1650 秒と読み、QC が「1646 秒の止まり・無音」と誤検知した
 *
 * 出力には素材のメタデータ・チャプター・データ/字幕のトラックを持ち込まない。標準・区間ごと・
 * 試聴用素材(プロキシ)の3つで確かめる。
 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { exportProject, ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { ensurePreviewProxy } from '@main/previewProxyService'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

const work = mkdtempSync(join(tmpdir(), 've-meta-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): void => {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
}

interface ProbeOut {
  format: { duration?: string; tags?: Record<string, string> }
  streams: { codec_type: string; duration?: string; tags?: Record<string, string> }[]
  chapters: unknown[]
}

/** 同梱の ffprobe(4.0.2。アプリの QC・取り込みが使うもの)で読む */
function probe(path: string): ProbeOut {
  return JSON.parse(
    execFileSync(ffprobePath, [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      '-of',
      'json',
      path
    ]).toString()
  ) as ProbeOut
}

/** 出力に素材の情報が残っていないか。残っていたものを文字で返す(無ければ空) */
function leaks(path: string): string[] {
  const p = probe(path)
  const out: string[] = []
  const tagText = JSON.stringify([p.format.tags ?? {}, ...p.streams.map((s) => s.tags ?? {})])
  for (const needle of ['+35.6895+139.6917', 'secret-title', 'Chapter-'])
    if (tagText.includes(needle)) out.push(`tag:${needle}`)
  if (p.chapters.length > 0) out.push(`chapters:${p.chapters.length}`)
  const kinds = p.streams.map((s) => s.codec_type)
  for (const k of kinds) if (k !== 'video' && k !== 'audio') out.push(`stream:${k}`)
  const dur = Number(p.format.duration)
  if (!(dur < 10)) out.push(`duration:${dur}`)
  return out
}

async function asset(id: string, path: string): Promise<MediaAsset> {
  const p = await probeMedia(path)
  return {
    id,
    filePath: path,
    fileName: id,
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: p.hasAudio,
    hasVideo: p.hasVideo
  }
}

describe.skipIf(!existsSync(ffmpegPath))(
  '書き出しに素材のメタデータ・チャプターを持ち込まない',
  () => {
    it('位置情報付きの動画 + チャプター6個の BGM で、標準・区間ごと・プロキシに何も残らない', async () => {
      // 位置情報と題名を持つスマホ風の動画(4秒)
      const phone = join(work, 'phone.mp4')
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=160x90:r=30:d=4',
        '-f',
        'lavfi',
        '-i',
        'sine=f=440:d=4:sample_rate=48000',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-metadata',
        'location=+35.6895+139.6917/',
        '-metadata',
        'location-eng=+35.6895+139.6917/',
        '-metadata',
        'title=secret-title',
        '-shortest',
        phone
      ])
      // 1650 秒ぶんのチャプター6個を持つ短い m4a(チャプターの終わりは実際の長さより後ろ)
      const meta = join(work, 'chapters.txt')
      const chapters = Array.from(
        { length: 6 },
        (_, i) =>
          `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${i * 275000}\nEND=${(i + 1) * 275000}\ntitle=Chapter-${i + 1}\n`
      ).join('')
      writeFileSync(meta, `;FFMETADATA1\ntitle=secret-title\n${chapters}`, 'utf-8')
      const bgm = join(work, 'bgm.m4a')
      ff([
        '-f',
        'lavfi',
        '-i',
        'sine=f=220:d=6:sample_rate=48000',
        '-i',
        meta,
        '-map_metadata',
        '1',
        '-map_chapters',
        '1',
        '-c:a',
        'aac',
        bgm
      ])
      // 素材のほうには残っている(計器の対照)
      expect(leaks(phone)).toContain('tag:+35.6895+139.6917')
      expect(leaks(bgm)).toContain('chapters:6')

      const a = await asset('phone', phone)
      const b = await asset('bgm', bgm)
      const project = {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [a, b],
        clips: [{ id: 'c', assetId: 'phone', inPoint: 0, outPoint: 4, speed: 1 }],
        audioTracks: [
          {
            id: 'bgm',
            name: 'BGM',
            volume: 1,
            muted: false,
            clips: [{ id: 'b1', assetId: 'bgm', startTime: 0, inPoint: 0, outPoint: 4 }]
          }
        ],
        videoOverlayTracks: [],
        textOverlays: []
      } as unknown as Project

      const std = join(work, 'std.mp4')
      await exportProject({
        project,
        aspectRatio: '16:9',
        resolutionHeight: 360 as never,
        quality: 'standard',
        outputPath: std,
        telopLayer: null,
        onProgress: () => {}
      })
      const seg = join(work, 'seg.mp4')
      await exportSequenceSegmented({
        project: projectV1ToV2(project, { resolution: 360 as never }),
        outputPath: seg,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null
      })
      const proxy = await ensurePreviewProxy(phone)
      // 修正前(実測): 標準は location・title が残り、チャプター6個・data(text)トラック・長さ 1650 秒
      expect({ std: leaks(std), seg: leaks(seg), proxy: leaks(proxy) }).toEqual({
        std: [],
        seg: [],
        proxy: []
      })
    }, 120_000)
  }
)
