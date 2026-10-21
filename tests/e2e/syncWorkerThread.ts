import { build, type Plugin } from 'esbuild'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Worker } from 'worker_threads'
import type { SyncInputFile, SyncReport, SyncWorkerMessage } from '@shared/sync/report'

/**
 * 同期の処理(`src/main/syncWorker.ts`)を、本番と同じく**別のスレッド(Worker)**で走らせる。
 *
 * 以前はテストの作業スレッドの中で直接動かしていた。同期の相関は1組で 30 秒以上止まらずに計算するので
 * (60分の2本で実測 31.7 秒)、その間テストの作業スレッドが vitest へ進み具合を返せず、遅い機械
 * (Windows の CI)では vitest の通信の待ち時間(60 秒)を超えて「Timeout calling "onTaskUpdate"」で
 * 全体が失敗していた(テストはどれも合格なのに終了コードが 1)。本番も Worker で動かしているので、
 * テストも同じ形にする
 */

const ROOT = resolve(__dirname, '../..')

/** `@shared/…`・`@main/…` を、アプリの作りと同じ置き場へ解決する */
const aliases: Plugin = {
  name: 'aliases',
  setup(build) {
    build.onResolve({ filter: /^@(shared|main)\// }, (args) => {
      const [, dir, rest] = /^@(shared|main)\/(.*)$/.exec(args.path)!
      return build.resolve(`./src/${dir}/${rest}`, { kind: args.kind, resolveDir: ROOT })
    })
  }
}

let bundled: Promise<string> | null = null

/** 同期の Worker を1回だけ1つのファイルへまとめる(テストのたびに作り直さない) */
function workerFile(): Promise<string> {
  bundled ??= bundle()
  return bundled
}

async function bundle(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 've-syncworker-'))
  const out = join(dir, 'syncWorker.cjs')
  await build({
    entryPoints: [join(ROOT, 'src/main/syncWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    plugins: [aliases],
    logLevel: 'silent'
  })
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  return out
}

/** 同期の処理を Worker で走らせ、結果を返す */
export async function runSyncWorker(
  files: SyncInputFile[],
  ffmpegPath: string,
  cacheDir: string
): Promise<SyncReport> {
  const file = await workerFile()
  return new Promise<SyncReport>((resolvePromise, reject) => {
    const worker = new Worker(file, { workerData: { files, ffmpegPath, cacheDir } })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
      void worker.terminate()
    }
    worker.on('message', (m: SyncWorkerMessage) => {
      if (m.type === 'done') finish(() => resolvePromise(m.report))
      else if (m.type === 'error') finish(() => reject(new Error(m.message)))
    })
    worker.on('error', (e) => finish(() => reject(e)))
    worker.on('exit', (code) =>
      finish(() =>
        reject(new Error(`同期の Worker が結果を返さずに終わりました(終了コード ${code})`))
      )
    )
  })
}
