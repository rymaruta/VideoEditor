import faceWorkerPath from './faceWorker?modulePath'
import modelPath from '../../resources/models/face_detection_yunet_2023mar.onnx?asset'
import { ffmpegPath } from './ffmpegService'
import { runChild } from './childRunner'
import type { FaceBox } from '@shared/telop/avoidFaces'

/** 顔の検出の呼び出し口(計算は faceWorker、別プロセス)。読めなかった画は null */
export function detectFaces(
  requests: { path: string; time: number; width: number; height: number }[],
  onProgress: (done: number, total: number) => void
): Promise<(FaceBox[] | null)[]> {
  return new Promise((resolve, reject) => {
    runChild(
      faceWorkerPath,
      { requests, ffmpegPath, modelPath: modelPath.replace('app.asar', 'app.asar.unpacked') },
      (m) => {
        if (m.type === 'progress') onProgress(m.done as number, m.total as number)
        else if (m.type === 'done') {
          resolve(m.results as (FaceBox[] | null)[])
          return true
        } else if (m.type === 'error') {
          reject(new Error(String(m.message)))
          return true
        }
        return false
      },
      (code) => reject(new Error(`顔の検出が止まりました(${code})`))
    )
  })
}
