import { useProjectStore } from '../store/projectStore'
import { buildTimedClips, totalTimelineDuration } from './timelineMath'
import { captureAiFrames } from './aiFrames'
import { defaultTextStyle } from '@shared/textStyle'
import { generateVideoMetadata, type VideoMetadata } from './metadataGeneration'
import { formatIpcError } from './ipcError'
import type { TextOverlay } from '@shared/types'

export interface AutoFinishResult {
  captionCount: number
  /** 文字起こしを試したクリップ数(音声のある本編クリップだけ) */
  transcribeAttempted: number
  /** 文字起こしに失敗したクリップ数。0件追加が「喋っていない」のか「全部失敗」なのかを分ける */
  transcribeFailed: number
  /** 最初の失敗の理由(日本語化済み)。failed が 0 のときは null */
  transcribeFailureReason: string | null
  metadata: VideoMetadata | null
  /** メタデータ生成の失敗理由。鍵が無くて試していないとき・成功したときは null */
  metadataError: string | null
}

export async function autoFinishTimeline(
  geminiApiKey: string | undefined,
  language: string
): Promise<AutoFinishResult> {
  const store = useProjectStore.getState()
  const timedClips = buildTimedClips(store.project)

  const overlays: Omit<TextOverlay, 'id'>[] = []
  // 失敗は握りつぶさずに数える。全クリップが失敗しても、以前は「字幕を0件追加しました」
  // という成功と同じ表示になり、喋っていない動画と区別が付かなかった
  let attempted = 0
  let failed = 0
  let firstFailure: string | null = null
  for (const tc of timedClips) {
    if (!tc.asset.hasAudio) continue
    attempted++
    try {
      const segments = await window.api.transcribe(
        tc.asset.filePath,
        tc.clip.inPoint,
        tc.clip.outPoint,
        language
      )
      const speed = tc.clip.speed || 1
      for (const seg of segments) {
        const text = seg.text.trim()
        if (!text) continue
        const startTime = tc.start + (seg.start - tc.clip.inPoint) / speed
        const endTime = tc.start + (seg.end - tc.clip.inPoint) / speed
        overlays.push({
          text,
          startTime,
          endTime,
          style: defaultTextStyle(),
          source: 'auto'
        })
      }
    } catch (e) {
      // 1クリップの失敗で全体は止めない(残りのクリップの字幕は付けられる)
      failed++
      if (firstFailure === null) firstFailure = formatIpcError(e)
    }
  }
  store.addTextOverlays(overlays)
  const captionCount = overlays.length

  let metadata: VideoMetadata | null = null
  let metadataError: string | null = null
  if (geminiApiKey) {
    try {
      const latestProject = useProjectStore.getState().project
      const transcript = latestProject.textOverlays
        .slice()
        .sort((a, b) => a.startTime - b.startTime)
        .map((o) => o.text)
        .join('\n')
      const total = totalTimelineDuration(timedClips)
      const frames = await captureAiFrames(timedClips, total, latestProject.aspectRatio)
      metadata = await generateVideoMetadata(geminiApiKey, transcript, '', language, frames)
    } catch (e) {
      // メタデータは無くても字幕は残せるので中断しないが、理由は画面へ持ち帰る
      metadataError = formatIpcError(e)
    }
  }

  return {
    captionCount,
    transcribeAttempted: attempted,
    transcribeFailed: failed,
    transcribeFailureReason: firstFailure,
    metadata,
    metadataError
  }
}
