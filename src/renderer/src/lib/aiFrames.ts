import { targetResolution } from '@shared/resolution'
import type { AspectRatio } from '@shared/types'
import { findTimedClipAt, type TimedClip } from './timelineMath'

/**
 * 生成AIに「この動画はこういう絵です」と見せるための静止画を作る。
 *
 * **書き出しと同じ画角で撮ること**がここの役目。寸法を決め打ちにすると、
 * 16:9 のプロジェクトでも 9:16 の枠に入れられて上下が黒帯になり、AIは
 * **絵の 3 割しか見ないまま**タイトルや概要欄を書くことになる。
 * クリップの切り抜き設定(`fillCrop` / `cropCenter` / `blurBackground`)も
 * 同じ理由で渡す — スマートクロップで寄せた被写体が、AIに渡す絵にだけ
 * 反映されないと、出来上がる動画と違う絵を見て文章を書かせることになる。
 *
 * サムネイル候補(`ThumbnailPanel`)と同じ規則で撮るが、あちらは利用者が
 * 受け取る成果物なので短辺 720。こちらはプロンプトに base64 で載るため小さくする。
 */
export const AI_FRAME_SHORT_SIDE = 320

/** 尺のどこを撮るか。頭・中・終盤の3枚で全体の雰囲気を伝える */
export const AI_FRAME_FRACTIONS = [0.15, 0.5, 0.85]

export interface AiFrameSpec {
  filePath: string
  /** 素材の秒(クリップの速度で戻したもの) */
  localTime: number
  width: number
  height: number
  fillCrop?: boolean
  cropCenter?: { x: number; y: number }
  blurBackground?: boolean
}

/**
 * 撮る枚数ぶんの引数を組み立てる。ffmpeg を呼ばない純粋な計算なので単体で測れる。
 * 映像を持たないクリップ(音声のみ)に当たった位置は撮らない。
 */
export function aiFrameSpecs(
  timedClips: TimedClip[],
  total: number,
  aspectRatio: AspectRatio,
  fractions: number[] = AI_FRAME_FRACTIONS
): AiFrameSpec[] {
  if (!Number.isFinite(total) || total <= 0) return []
  const { w, h } = targetResolution(aspectRatio, AI_FRAME_SHORT_SIDE)
  const specs: AiFrameSpec[] = []
  for (const fraction of fractions) {
    if (!Number.isFinite(fraction)) continue
    const globalTime = Math.min(total - 0.05, total * fraction)
    const tc = findTimedClipAt(timedClips, globalTime)
    if (!tc || !tc.asset.hasVideo) continue
    const rawSpeed = tc.clip.speed
    const speed = Number.isFinite(rawSpeed) && (rawSpeed as number) > 0 ? (rawSpeed as number) : 1
    specs.push({
      filePath: tc.asset.filePath,
      localTime: Math.max(0, tc.clip.inPoint + (globalTime - tc.start) * speed),
      width: w,
      height: h,
      fillCrop: tc.clip.fillCrop,
      cropCenter: tc.clip.cropCenter,
      blurBackground: tc.clip.blurBackground
    })
  }
  return specs
}

/** 組み立てた引数で実際に撮る。失敗した1枚は飛ばす(残りの絵でも十分伝わる)。 */
export async function captureAiFrames(
  timedClips: TimedClip[],
  total: number,
  aspectRatio: AspectRatio
): Promise<string[]> {
  const frames: string[] = []
  for (const spec of aiFrameSpecs(timedClips, total, aspectRatio)) {
    try {
      frames.push(
        await window.api.generateFrame(
          spec.filePath,
          spec.localTime,
          spec.width,
          spec.height,
          spec.fillCrop,
          spec.cropCenter,
          spec.blurBackground
        )
      )
    } catch {
      // クリップの境目などで取れないことがある。1枚欠けても残りで足りる。
    }
  }
  return frames
}
