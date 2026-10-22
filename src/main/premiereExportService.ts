import { spawn } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync
} from 'fs'
import { copyFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, extname, join } from 'path'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { sequenceDurationFrames } from '@shared/sequence/segmentPlan'
import { telopConcatList } from '@shared/telop/layer'
import { buildPremiereXml, type PremiereOverlayClip } from '@shared/export/premiereXml'
import { premiereMarkers, premiereSrt } from '@shared/export/premiereMarkers'
import type { PremiereExportPayload, PremiereExportResult } from '@shared/export/premiereTypes'
import { safeFileBaseName } from '@shared/fileName'
import { materializeTelopLayer } from './telopLayerStage'
import { trackProcess } from './liveProcesses'
import { describeFfmpegExit } from './ffmpegError'

/**
 * Premiere 用 XML(FCP7 xmeml)の書き出し。XML の中身は `@shared/export/premiereXml` が作り、
 * ここはファイルを並べて書く:
 *
 * - `名前.xml` … シーケンス(本編・重ね・音声・マーカー)
 * - `名前.srt` … テロップの文字(シーケンスの時刻)。Premiere の「キャプション」に読み込める
 * - 見た目どおりのテロップ(選んだときだけ):
 *   - `png`: `名前_telop/telop_000001.png` …(絵が変わる区間ごとの透過 PNG。XML の一番上のトラックに並ぶ)
 *   - `prores`: `名前_telop.mov`(ProRes 4444・透過付きの 1 本。頭から全体に置く)
 *
 * どちらも画面のプロセスが共通レンダラで描いたテロップの層(`TelopLayerPayload`)をそのまま使う。
 */

export type { PremiereExportPayload, PremiereExportResult }

export interface PremiereExportDeps {
  ffmpegPath: string
  onProgress?: (percent: number, stage: string) => void
  signal?: AbortSignal
  /** 素材の音声のチャンネル数を調べる(無ければステレオとして書く) */
  probeChannels?: (filePath: string) => Promise<number | undefined>
  /** 書き出し先の空き容量(バイト)。試験で差し替える */
  freeBytes?: (dir: string) => number
}

/** 透過の PNG を写すとき、何枚ごとに中止を見て進み具合を出すか */
const COPY_BATCH = 32

/**
 * ProRes 4444(透過)の大きさの見積もり(1 画素・1 フレームあたりのバイト)。テロップの出ていない
 * 透明のフレームが大半でも 1 フレームずつ書くので、尺に比例する(実測: 1080p・3 時間で約 12GB =
 * 0.018。余裕を見て 0.025)
 */
const PRORES_BYTES_PER_PIXEL_FRAME = 0.025

/** 並べて書くファイル・フォルダ(XML の名前から決まる) */
export function premiereSidecarPaths(xmlPath: string): {
  srt: string
  telopDir: string
  telopMov: string
} {
  const base = premiereSidecarBase(xmlPath)
  return { srt: `${base}.srt`, telopDir: `${base}_telop`, telopMov: `${base}_telop.mov` }
}

/** 並べて書くもののうち、もうあるもの(上書きしてよいか確かめるのに使う) */
export function existingPremiereSidecars(xmlPath: string): string[] {
  const p = premiereSidecarPaths(xmlPath)
  return [p.srt, p.telopDir, p.telopMov].filter((x) => existsSync(x))
}

/** 前回の書き出しの PNG(この書き出しが付ける名前のものだけ)を消す */
function clearOldTelopPngs(dir: string): void {
  for (const name of readdirSync(dir))
    if (/^telop_\d{6}\.png$/.test(name)) rmSync(join(dir, name), { force: true })
}

function defaultFreeBytes(dir: string): number {
  const st = statfsSync(dir)
  return Number(st.bavail) * Number(st.bsize)
}

/** 書き出し先の名前から、並べて書くファイルの頭(拡張子を除いた所) */
export function premiereSidecarBase(xmlPath: string): string {
  const ext = extname(xmlPath)
  return ext.toLowerCase() === '.xml' ? xmlPath.slice(0, -ext.length) : xmlPath
}

function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('EXPORT_CANCELED'))
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], {
      windowsHide: true
    })
    const untrack = trackProcess(child)
    const tail: string[] = []
    child.stderr.on('data', (chunk: Buffer) => {
      tail.push(chunk.toString('utf-8'))
      if (tail.length > 200) tail.shift()
    })
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => {
      untrack()
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      untrack()
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('EXPORT_CANCELED'))
      if (code === 0) resolve()
      else reject(describeFfmpegExit(code, tail.join('')))
    })
  })
}

/**
 * XML・SRT・(選べば)見た目どおりのテロップを書く。`xmlWritePath` は XML を実際に書く場所
 * (途中で失敗しても完成品の名前で残らないよう、呼び出し側が仮の名前を渡す)。
 * 並べて書くファイルの名前は `payload.outputPath` から決める。
 */
export async function exportPremiereXml(
  payload: PremiereExportPayload,
  xmlWritePath: string,
  deps: PremiereExportDeps
): Promise<PremiereExportResult> {
  const progress = deps.onProgress ?? ((): void => {})
  progress(0, 'シーケンスを組み立て中')
  const v2 = projectV1ToV2(
    { ...payload.project, aspectRatio: payload.aspectRatio },
    { resolution: payload.resolutionHeight }
  )
  const fps = v2.sequence.fps
  const total = sequenceDurationFrames(v2.sequence)
  const base = premiereSidecarBase(payload.outputPath)
  const sidecars = premiereSidecarPaths(payload.outputPath)
  const srtPath = sidecars.srt
  const markers = premiereMarkers(payload.project, v2, {
    telops: payload.telopMarkers !== false,
    reviews: payload.reviews
  })

  let telopMedia: { width: number; height: number; clips: PremiereOverlayClip[] } | undefined
  let telopPath: string | undefined
  const layer = payload.telopLayer
  if (payload.telopMode !== 'text' && layer && layer.runs.length > 0) {
    if (layer.width !== v2.sequence.width || layer.height !== v2.sequence.height)
      throw new Error('テロップの層の大きさがシーケンスと食い違っています')
    const scratch = mkdtempSync(join(tmpdir(), 've-premiere-'))
    try {
      const imagePaths = materializeTelopLayer(layer, () => scratch)?.imagePaths ?? []
      if (payload.telopMode === 'png') {
        // フォルダの名前は ASCII の決まった後ろ(素材のフォルダに日本語があっても、PNG の名前は短く)
        const dir = sidecars.telopDir
        mkdirSync(dir, { recursive: true })
        // 前回の余り(今回より枚数の多かった書き出しの PNG)を残さない。上書きは保存先を選ぶときに確かめてある
        clearOldTelopPngs(dir)
        telopPath = dir
        // 先に並べ方と写す画像を決め、写すのは後でまとめて(非同期・中止が効くように)
        const copied = new Map<number, string>()
        const copies: { src: string; dst: string }[] = []
        const clips: PremiereOverlayClip[] = []
        const runs = [...layer.runs].sort((a, b) => a.startFrame - b.startFrame)
        for (const r of runs) {
          if (r.image <= 0 || r.endFrame <= r.startFrame) continue
          let path = copied.get(r.image)
          if (!path) {
            const src = imagePaths[r.image]
            if (!src) throw new Error('テロップの層の画像が見つかりません')
            path = join(dir, `telop_${String(copied.size + 1).padStart(6, '0')}.png`)
            copies.push({ src, dst: path })
            copied.set(r.image, path)
          }
          const last = clips[clips.length - 1]
          // 同じ画像が続く区間は 1 本にまとめる
          if (last && last.path === path && last.startFrame + last.durationFrames === r.startFrame)
            last.durationFrames += r.endFrame - r.startFrame
          else
            clips.push({
              path,
              startFrame: r.startFrame,
              durationFrames: r.endFrame - r.startFrame,
              still: true
            })
        }
        for (let i = 0; i < copies.length; i += COPY_BATCH) {
          if (deps.signal?.aborted) throw new Error('EXPORT_CANCELED')
          await Promise.all(copies.slice(i, i + COPY_BATCH).map((c) => copyFile(c.src, c.dst)))
          const n = Math.min(copies.length, i + COPY_BATCH)
          progress((n / copies.length) * 90, `テロップの画像を書き出し中(${n}/${copies.length} 枚)`)
        }
        if (deps.signal?.aborted) throw new Error('EXPORT_CANCELED')
        telopMedia = { width: layer.width, height: layer.height, clips }
      } else {
        const movPath = sidecars.telopMov
        const list = telopConcatList(layer.runs, imagePaths, 0, total, fps)
        if (list) {
          // 尺に比例して大きくなる(1080p・3 時間で約 12GB)。書き始める前に空きを確かめる
          const need = Math.ceil(
            total * layer.width * layer.height * PRORES_BYTES_PER_PIXEL_FRAME + 256 * 1024 * 1024
          )
          const free = (deps.freeBytes ?? defaultFreeBytes)(dirname(movPath))
          if (free < need)
            throw new Error(
              `テロップの ProRes 4444 には約 ${(need / 1024 ** 3).toFixed(1)}GB 必要ですが、` +
                `書き出し先の空きは ${(free / 1024 ** 3).toFixed(1)}GB です。` +
                '空きを作るか、「透過 PNG」か「文字だけ」を選んでください'
            )
          const listPath = join(scratch, 'telop.ffconcat')
          writeFileSync(listPath, list, 'utf-8')
          progress(5, 'テロップを ProRes 4444(透過)に書き出し中')
          const partial = join(dirname(movPath), `.${basename(movPath)}.partial.mov`)
          try {
            await runFfmpeg(
              deps.ffmpegPath,
              [
                '-f',
                'concat',
                '-safe',
                '0',
                '-i',
                listPath,
                '-vf',
                `fps=${fps.num}/${fps.den},format=yuva444p10le`,
                '-frames:v',
                String(total),
                '-c:v',
                'prores_ks',
                '-profile:v',
                '4444',
                '-alpha_bits',
                '16',
                '-vendor',
                'apl0',
                '-pix_fmt',
                'yuva444p10le',
                '-an',
                partial
              ],
              deps.signal
            )
            renameSync(partial, movPath)
          } finally {
            rmSync(partial, { force: true })
          }
          telopPath = movPath
          telopMedia = {
            width: layer.width,
            height: layer.height,
            clips: [
              {
                path: movPath,
                startFrame: 0,
                durationFrames: total,
                still: false,
                sourceInFrame: 0,
                fileFrames: total
              }
            ]
          }
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  progress(95, 'XML を書き出し中')
  // 音声のチャンネル数(モノラルは 1 本、ステレオは L・R の 2 本のトラックに書く)
  const audioChannels = new Map<string, number>()
  if (deps.probeChannels) {
    const used = new Set(v2.sequence.audioTracks.flatMap((t) => t.items.map((i) => i.assetId)))
    const assets = v2.assets.filter((a) => used.has(a.id) && a.hasAudio)
    const counts = await Promise.all(
      assets.map((a) => deps.probeChannels!(a.filePath).catch(() => undefined))
    )
    assets.forEach((a, i) => {
      const n = counts[i]
      if (n !== undefined) audioChannels.set(a.id, n)
    })
  }
  const result = buildPremiereXml(v2, {
    audioChannels,
    name: payload.project.name || safeFileBaseName(basename(base)),
    dropFrame: payload.dropFrame !== false,
    markers,
    ...(telopMedia ? { telopMedia } : {})
  })
  writeFileSync(xmlWritePath, result.xml, 'utf-8')
  // 既存の字幕の書き出しと同じく BOM 付き(Windows の Premiere・メモ帳で文字化けしない)
  writeFileSync(srtPath, '﻿' + premiereSrt(v2), 'utf-8')
  progress(100, '完了')
  return {
    xmlPath: payload.outputPath,
    srtPath,
    ...(telopPath ? { telopPath } : {}),
    warnings: result.warnings,
    stats: result.stats
  }
}
