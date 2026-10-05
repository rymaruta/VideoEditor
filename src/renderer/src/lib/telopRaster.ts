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

/**
 * 同時に PNG にしておく枚数。描く(1枚 1ms 未満)と PNG にする(1080p で約 10ms、4K で約 37ms。
 * ほぼ全部が GPU からの読み戻しと圧縮)・main へ送る・ディスクへ書くを重ねて、待ち時間を詰める
 */
const ENCODE_AHEAD = 1

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png')).then(
    async (blob) => {
      if (!blob) throw new Error('テロップの画像を作れませんでした')
      return new Uint8Array(await blob.arrayBuffer())
    }
  )
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
    /** PNG にしている途中の絵(描いた順)。`imageKey` ごとに1つ */
    const encoding: { key: string; png: Promise<Uint8Array> }[] = []
    const T = ((globalThis as any).__T = { draw: 0, png: 0, add: 0, n: 0, t0: performance.now(), plan: 0 })
    const settleOldest = async (): Promise<void> => {
      const e = encoding.shift()!
      let t = performance.now()
      const b = await e.png
      T.png += performance.now() - t
      t = performance.now()
      imageByKey.set(e.key, await writer.add(b))
      T.add += performance.now() - t
    }
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]
      if (!imageByKey.has(run.imageKey) && !encoding.some((e) => e.key === run.imageKey)) {
        if (encoding.length >= ENCODE_AHEAD) await settleOldest()
        const td = performance.now()
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
        T.draw += performance.now() - td; T.n++
        // `toBlob` は呼んだ時点の絵の写しを PNG にする(仕様)ので、同じ Canvas へすぐ次を描いてよい
        const png = canvasToPng(canvas)
        // 待つのは順番が来たとき。それまでに失敗しても、未処理の拒否にしない
        png.catch(() => {})
        encoding.push({ key: run.imageKey, png })
      }
      if (signal?.aborted) throw new Error('EXPORT_CANCELED')
      if (onProgress && i % 20 === 0) onProgress(i, runs.length)
    }
    while (encoding.length > 0) await settleOldest()
    // 番号は PNG にし終えた順に決まるので、区間へ割り当てるのは全部が済んでから
    for (const run of runs) {
      out.push({
        startFrame: run.startFrame,
        endFrame: run.endFrame,
        image: imageByKey.get(run.imageKey)!
      })
    }
    await writer.finish()
    ;(T as any).total = performance.now() - T.t0; console.log('TIMING', JSON.stringify(T))
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
