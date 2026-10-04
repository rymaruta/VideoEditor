import type { Sequence } from '@shared/sequence/types'
import type { AspectRatio, Project } from '@shared/types'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import {
  planTelopRuns,
  telopItemSource,
  visibleTelops,
  type TelopLayerPayload
} from '@shared/telop/layer'
import { drawTelop, type TelopContext } from '@shared/telop/render'
import { textCanvasSize } from '@shared/resolution'

/**
 * 書き出しに重ねる「テロップの層」を、**画面と同じ描画関数**で画像にする。
 *
 * 描くのはこのプロセス(Chromium の Canvas)。画面のプレビューと同じ文字の描き方・同じフォントで
 * 描けるので、書き出したテロップが画面と食い違わない。main プロセスはこの画像を時刻どおりに
 * 重ねるだけで、文字を描かない。
 *
 * 画像は枠と同じ大きさの透明 PNG。0番は「何も無い」透明の1枚で、区間の無い時間に使う。
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
  signal?: AbortSignal
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
  // 書き出しで使うフォントが読み込み済みであることを待つ(未読込だと代わりの字形で描かれる)
  await document.fonts?.ready

  const images: Uint8Array[] = [await canvasToPng(canvas)]
  const imageByKey = new Map<string, number>()
  const out: TelopLayerPayload['runs'] = []
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
      image = images.length
      images.push(await canvasToPng(canvas))
      imageByKey.set(run.imageKey, image)
    }
    out.push({ startFrame: run.startFrame, endFrame: run.endFrame, image })
    if (signal?.aborted) throw new Error('EXPORT_CANCELED')
    if (onProgress && i % 20 === 0) onProgress(i, runs.length)
  }
  onProgress?.(runs.length, runs.length)
  return { width: seq.width, height: seq.height, images, runs: out }
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
