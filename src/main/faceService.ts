import { Worker } from 'worker_threads'
import faceWorkerPath from './faceWorker?modulePath'
import modelPath from '../../resources/models/face_detection_yunet_2023mar.onnx?asset'
import { ffmpegPath } from './ffmpegService'
import type { FaceBox } from '@shared/telop/avoidFaces'

/** 顔の検出の呼び出し口(計算は faceWorker)。読めなかった画は null */
export function detectFaces(
  requests: { path: string; time: number; width: number; height: number }[],
  onProgress: (done: number, total: number) => void
): Promise<(FaceBox[] | null)[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(faceWorkerPath, {
      workerData: {
        requests,
        ffmpegPath,
        modelPath: modelPath.replace('app.asar', 'app.asar.unpacked')
      }
    })
    worker.on(
      'message',
      (m: {
        type: string
        done?: number
        total?: number
        results?: (FaceBox[] | null)[]
        message?: string
      }) => {
        if (m.type === 'progress') onProgress(m.done!, m.total!)
        else if (m.type === 'done') {
          resolve(m.results!)
          void worker.terminate()
        } else if (m.type === 'error') reject(new Error(m.message))
      }
    )
    worker.on('error', reject)
  })
}
