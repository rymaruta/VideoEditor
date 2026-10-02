import { app } from 'electron'
import { execFile } from 'child_process'
import { readdir, stat } from 'fs/promises'
import { join, relative } from 'path'
import { Worker } from 'worker_threads'
import syncWorkerPath from './syncWorker?modulePath'
import { ffmpegPath, ffprobePath } from './ffmpegService'
import { MEDIA_EXTENSIONS } from '@shared/mediaExtensions'
import { classifyFootage, type FootageScan, type ProbedFile } from '@shared/ingest/classify'
import type { SyncInputFile, SyncReport, SyncWorkerMessage } from '@shared/sync/report'

/**
 * 収録フォルダの取り込み・整理(計画書 §5.1)と、同期(§5.2)の呼び出し口。
 * 振り分けの規則は `@shared/ingest/classify`、同期の計算は `syncWorker`(別スレッド)。
 */

const MAX_DEPTH = 8
const MAX_FILES = 5000
const PROBE_PARALLEL = 6

async function listMediaFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (
        e.name.startsWith('.') ||
        e.name === '$RECYCLE.BIN' ||
        e.name === 'System Volume Information'
      )
        continue
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full, depth + 1)
      else if (MEDIA_EXTENSIONS.includes(e.name.split('.').pop()?.toLowerCase() ?? ''))
        out.push(full)
    }
  }
  await walk(root, 0)
  return out
}

interface FfprobeJson {
  format?: { duration?: string; tags?: Record<string, string> }
  streams?: {
    codec_type?: string
    width?: number
    height?: number
    duration?: string
    disposition?: { attached_pic?: number }
    tags?: Record<string, string>
  }[]
}

function ffprobeJson(path: string): Promise<FfprobeJson> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err)
        try {
          resolve(JSON.parse(stdout) as FfprobeJson)
        } catch (e) {
          reject(e)
        }
      }
    )
  })
}

/** タグを大文字小文字を区別せずに引く */
function tag(tags: Record<string, string> | undefined, ...names: string[]): string | undefined {
  if (!tags) return undefined
  const lower = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]))
  for (const n of names) {
    const v = lower[n.toLowerCase()]
    if (v && v.trim()) return v.trim()
  }
  return undefined
}

async function probeFile(root: string, path: string): Promise<ProbedFile> {
  const [info, st] = await Promise.all([ffprobeJson(path), stat(path)])
  const streams = info.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find((s) => s.codec_type === 'audio')
  const duration = Number(info.format?.duration ?? video?.duration ?? audio?.duration ?? 0)
  const tags = { ...(audio?.tags ?? {}), ...(video?.tags ?? {}), ...(info.format?.tags ?? {}) }
  const created = tag(tags, 'creation_time', 'com.apple.quicktime.creationdate', 'date')
  const recordedAt = created ? Date.parse(created) / 1000 : NaN
  const make = tag(tags, 'com.apple.quicktime.make', 'make', 'com.android.manufacturer')
  const model = tag(tags, 'com.apple.quicktime.model', 'model', 'com.android.model')
  return {
    path,
    relativePath: relative(root, path).split('\\').join('/'),
    duration: Number.isFinite(duration) ? duration : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width,
    height: video?.height,
    recordedAt: Number.isFinite(recordedAt) ? recordedAt : undefined,
    device: [make, model].filter(Boolean).join(' ') || undefined,
    size: st.size
  }
}

export async function scanFootage(
  root: string,
  onProgress: (done: number, total: number) => void
): Promise<FootageScan> {
  const paths = await listMediaFiles(root)
  const probed: ProbedFile[] = []
  const skipped: FootageScan['skipped'] = []
  const stats: FootageScan['stats'] = {}
  const queue = [...paths]
  let done = 0
  await Promise.all(
    Array.from({ length: Math.min(PROBE_PARALLEL, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          const f = await probeFile(root, p)
          const st = await stat(p)
          stats[p] = { size: st.size, mtimeMs: st.mtimeMs }
          if (!f.hasAudio && !f.hasVideo)
            skipped.push({ path: p, reason: '映像も音声もありません' })
          else if (f.duration <= 0) skipped.push({ path: p, reason: '長さが分かりません' })
          else probed.push(f)
        } catch {
          skipped.push({ path: p, reason: '読み込めませんでした' })
        }
        onProgress(++done, paths.length)
      }
    })
  )
  return { root, sources: classifyFootage(probed), skipped, stats }
}

let running: Worker | null = null

export function runSync(
  files: SyncInputFile[],
  onProgress: (percent: number, stage: string) => void
): Promise<SyncReport> {
  if (running) return Promise.reject(new Error('同期はすでに実行中です'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(syncWorkerPath, {
      workerData: { files, ffmpegPath, cacheDir: join(app.getPath('userData'), 'analysis-cache') }
    })
    running = worker
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      running = null
      fn()
    }
    worker.on('message', (m: SyncWorkerMessage) => {
      if (m.type === 'progress') onProgress(m.percent, m.stage)
      else if (m.type === 'done') finish(() => resolve(m.report))
      else finish(() => reject(new Error(m.message)))
    })
    worker.on('error', (e) => finish(() => reject(e)))
    worker.on('exit', (code) =>
      finish(() => reject(new Error(code === 1 ? 'SYNC_CANCELED' : `同期が止まりました(${code})`)))
    )
  })
}

export function cancelSync(): void {
  void running?.terminate()
}
