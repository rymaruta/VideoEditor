import { loadTelopFonts } from './telopFonts'
import type { Sequence } from '@shared/sequence/types'
import type { AspectRatio, Project } from '@shared/types'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import {
  planTelopRuns,
  telopItemSource,
  visibleTelops,
  type TelopLayerPayload,
  type TelopLayerStageApi
} from '@shared/telop/layer'
import { drawTelop, type TelopContext } from '@shared/telop/render'
import { textCanvasSize } from '@shared/resolution'
import { TelopImageWriter } from './telopImageWriter'

/**
 * 書き出しに重ねる「テロップの層」を、**画面と同じ描画関数**で画像にする。
 *
 * 描くのはこのプロセス(Chromium の Canvas)。画面のプレビューと同じ文字の描き方・同じフォントで
 * 描けるので、書き出したテロップが画面と食い違わない。main プロセスはこの画像を時刻どおりに
 * 重ねるだけで、文字を描かない。
 *
 * 画像は枠と同じ大きさの透明 PNG。0番は「何も無い」透明の1枚で、区間の無い時間に使う。
 *
 * 画像は**描きながら数 MB ずつ main へ送り、main がすぐディスクへ書く**(`TelopImageWriter`)。
 * 全部をメモリに溜めて書き出しの IPC 1回で送ると、長尺・ループの動きでは数万枚・数 GB になり
 * 画面のプロセスが落ちる(実測は `TelopLayerPayload` のコメント)。
 */

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('テロップの画像を作れませんでした')
  return new Uint8Array(await blob.arrayBuffer())
}

export async function rasterizeTelopLayer(
  seq: Sequence,
  onProgress?: (done: number, total: number) => void,
  /** 書き出しの中止(長尺の 4K だと描画だけで数分かかる) */
  signal?: AbortSignal,
  /** 画像の送り先(既定は main。テストで差し替える) */
  stage: TelopLayerStageApi = window.api.telopLayer
): Promise<TelopLayerPayload | null> {
  const textCanvas = textCanvasSize(seq.width >= seq.height ? '16:9' : '9:16')
  const runs = planTelopRuns(seq, textCanvas.h)
  if (runs.length === 0) return null
  const fps = seq.fps.num / seq.fps.den
  const sources = new Map(visibleTelops(seq).map((t) => [t.id, telopItemSource(t, fps)]))

  const canvas = document.createElement('canvas')
  canvas.width = seq.width
  canvas.height = seq.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('テロップを描く Canvas を用意できませんでした')
  // 書き出しで使うフォントを読み込んでから描く(未読込だと代わりの字形で焼かれる)
  await loadTelopFonts([...sources.values()])
  await document.fonts?.ready

  const stagedId = await stage.begin(seq.width, seq.height)
  const writer = new TelopImageWriter(stage, stagedId)
  try {
    // 0番は透明の1枚
    await writer.add(await canvasToPng(canvas))
    const imageByKey = new Map<string, number>()
    const out: TelopLayerPayload['runs'] = []
    // PNG は1枚ずつ作る。何枚か重ねて作らせても速くならず、かえって遅くなった
    // (実測 1080p・テロップ100枚・2,149枚: 1枚ずつ 33.8秒 / 3枚重ね 43.4秒。
    //  PNG にする時間がほぼ全部で 1枚 12.9ms、描くのは 0.2ms、中身の照合と main への送りは 1.2ms)
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]
      let image = imageByKey.get(run.imageKey)
      if (image === undefined) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const time = (run.startFrame + 1e-9) / fps
        for (const id of run.itemIds) {
          const source = sources.get(id)
          if (source)
            drawTelop(
              ctx as TelopContext,
              source,
              time,
              { width: seq.width, height: seq.height },
              textCanvas
            )
        }
        image = await writer.add(await canvasToPng(canvas))
        imageByKey.set(run.imageKey, image)
      }
      out.push({ startFrame: run.startFrame, endFrame: run.endFrame, image })
      if (signal?.aborted) throw new Error('EXPORT_CANCELED')
      if (onProgress && i % 20 === 0) onProgress(i, runs.length)
    }
    await writer.finish()
    if (signal?.aborted) throw new Error('EXPORT_CANCELED')
    onProgress?.(runs.length, runs.length)
    return {
      width: seq.width,
      height: seq.height,
      stagedId,
      imageCount: writer.count,
      runs: out
    }
  } catch (e) {
    await writer.abandon()
    await stage.release(stagedId).catch(() => {})
    throw e
  }
}

/**
 * 書き出しの指定(縦横比・解像度)から、長尺向けの書き出しへ渡すテロップの層を作る。
 * main プロセスも**同じ関数・同じ引数**で v2 へ写すので、テロップの位置(フレーム)は一致する。
 */
export async function prepareTelopLayerForExport(
  project: Project,
  aspectRatio: AspectRatio,
  resolutionHeight: number,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<TelopLayerPayload | null> {
  const v2 = projectV1ToV2({ ...project, aspectRatio }, { resolution: resolutionHeight })
  return rasterizeTelopLayer(v2.sequence, onProgress, signal)
}
