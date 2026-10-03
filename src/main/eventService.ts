import { app, type UtilityProcess } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import eventWorkerPath from './eventWorker?modulePath'
import { ffmpegPath } from './ffmpegService'
import { runChild } from './childRunner'
import type { EventWorkerMessage } from './eventWorker'
import type { AudioEventWindow } from '@shared/events/audioEvents'

/** 笑い・歓声の検出の呼び出し口(計算は eventWorker、別プロセス) */
let running: UtilityProcess | null = null
let canceled = false

export function detectAudioEvents(
  files: { path: string; start: number; rate: number; duration: number }[],
  onMessage: (m: Exclude<EventWorkerMessage, { type: 'done' | 'error' }>) => void
): Promise<AudioEventWindow[]> {
  if (running) return Promise.reject(new Error('笑い・歓声の検出はすでに実行中です'))
  const cacheDir = join(app.getPath('userData'), 'models')
  mkdirSync(cacheDir, { recursive: true })
  canceled = false
  return new Promise((resolve, reject) => {
    running = runChild(
      eventWorkerPath,
      { files, ffmpegPath, cacheDir },
      (raw) => {
        const m = raw as unknown as EventWorkerMessage
        if (m.type === 'done') {
          running = null
          resolve(m.events)
          return true
        }
        if (m.type === 'error') {
          running = null
          reject(new Error(m.message))
          return true
        }
        onMessage(m)
        return false
      },
      (code, stderr) => {
        running = null
        reject(
          new Error(
            canceled || code === 0 || !stderr
              ? 'EVENTS_CANCELED'
              : `笑い・歓声の検出が止まりました: ${stderr}`
          )
        )
      }
    )
  })
}

export function cancelAudioEvents(): void {
  canceled = true
  running?.kill()
}
