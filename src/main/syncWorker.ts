import { parentPort, workerData } from 'worker_threads'
import { cachedEnvelope, readWindow } from './audioPcm'
import {
  isReliableMatch,
  matchFeatures,
  matchWithDrift,
  onsetFeature,
  refineOffset
} from '@shared/sync/correlate'
import { solvePlacements } from '@shared/sync/solve'
import type { SyncInputFile, SyncPairResult, SyncWorkerMessage } from '@shared/sync/report'

/**
 * カメラ・マイクの同期(計画書 §5.2)を、画面と main プロセスを止めずに別スレッドで行う。
 *
 * 1. 各素材の音を 8kHz で読み、10ms ごとの大きさ(包絡線)にする(結果はキャッシュに残し、2回目からは読まない)
 * 2. 比べる組を決める: ピンマイクがあれば「カメラ × マイク」「マイク × マイク」(マイクは長く続いていて
 *    音もきれいなので、背骨にする)。無ければ別のカメラどうしの全組。
 *    マイクがあっても、マイクと合わなかったカメラ(マイクが止まっていた間の撮影)はほかのカメラと比べる
 * 3. 包絡線の相関で粗く → 重なりの中ほど 20 秒を 16kHz で GCC-PHAT にかけて細かく
 * 4. 重なりが10分以上あれば、頭と終わりで測り直して時計の進み方の差(ドリフト)を出す
 * 5. 全素材を1本の時間軸に並べる(sync/solve)
 */

interface WorkerInput {
  files: SyncInputFile[]
  ffmpegPath: string
  cacheDir: string
}

const input = workerData as WorkerInput
const post = (m: SyncWorkerMessage): void => parentPort!.postMessage(m)

const REFINE_SAMPLE_RATE = 16000
const REFINE_WINDOW_SEC = 20
const DRIFT_MIN_OVERLAP_SEC = 600
/**
 * 頭と終わりで測り直すときに探す幅(秒)。中ほどで詰めた offset からは、時計のずれの分だけ離れている
 * (200ppm で中ほどから1時間離れると 0.72 秒)ので、中ほどからの距離に比例して広げる。
 * 20 秒の窓の重なりが痩せすぎないよう 1 秒で止める
 */
const driftSearchSec = (distanceSec: number): number => Math.min(1, 0.05 + 2e-4 * distanceSec)
/** 並べて読む本数(ffmpeg の数) */
const DECODE_PARALLEL = 3

/**
 * 音の無い素材(映像だけのファイル)は ffmpeg が失敗する。1本のために同期全体を止めないよう、
 * 空の包絡線にして続ける(照らし合わせでは一致なしになり、録画時刻で置くか未同期のまま残る)
 */
async function envelopeOf(f: SyncInputFile): Promise<Float32Array> {
  try {
    return await cachedEnvelope(input.ffmpegPath, input.cacheDir, f)
  } catch (e) {
    console.warn(
      `[sync] 音を読めないので照らし合わせから外します: ${f.path}: ${e instanceof Error ? e.message : String(e)}`
    )
    return new Float32Array(0)
  }
}

const windowOf = (f: SyncInputFile, start: number, length: number): Promise<Float32Array> =>
  readWindow(input.ffmpegPath, f.path, start, length, REFINE_SAMPLE_RATE)

/** a の時刻 center の周りで、b のずれを細かく詰める */
async function refineAt(
  a: SyncInputFile,
  b: SyncInputFile,
  coarse: number,
  center: number,
  maxShiftSec?: number
): Promise<{ offset: number; sharpness: number }> {
  const s = center - REFINE_WINDOW_SEC / 2
  const [aWin, bWin] = await Promise.all([
    windowOf(a, s, REFINE_WINDOW_SEC),
    windowOf(b, s - coarse, REFINE_WINDOW_SEC)
  ])
  return refineOffset(aWin, bWin, REFINE_SAMPLE_RATE, coarse, maxShiftSec)
}

function choosePairs(files: SyncInputFile[]): [SyncInputFile, SyncInputFile][] {
  const mics = files.filter((f) => f.sourceKind === 'mic')
  const pairs: [SyncInputFile, SyncInputFile][] = []
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const x = files[i]
      const y = files[j]
      if (x.sourceId === y.sourceId) continue
      if (mics.length > 0 && x.sourceKind === 'camera' && y.sourceKind === 'camera') continue
      // 長いほう(マイク)を a にする
      pairs.push(x.duration >= y.duration ? [x, y] : [y, x])
    }
  }
  return pairs
}

/**
 * マイクと確かに合わなかったカメラの素材(マイクが止まっている間に撮った分など)と、別のカメラの素材の組。
 * 合わなかった素材の分だけなので、全部のカメラの組よりずっと少ない
 */
function orphanCameraPairs(
  files: SyncInputFile[],
  results: SyncPairResult[]
): [SyncInputFile, SyncInputFile][] {
  if (!files.some((f) => f.sourceKind === 'mic')) return [] // マイクが無ければ全組を照らし合わせ済み
  const linked = new Set(results.filter((r) => r.reliable).flatMap((r) => [r.a, r.b]))
  const cameras = files.filter((f) => f.sourceKind === 'camera')
  const orphans = new Set(cameras.filter((f) => !linked.has(f.id)).map((f) => f.id))
  const pairs: [SyncInputFile, SyncInputFile][] = []
  for (let i = 0; i < cameras.length; i++) {
    for (let j = i + 1; j < cameras.length; j++) {
      const x = cameras[i]
      const y = cameras[j]
      if (x.sourceId === y.sourceId) continue
      if (!orphans.has(x.id) && !orphans.has(y.id)) continue
      pairs.push(x.duration >= y.duration ? [x, y] : [y, x])
    }
  }
  return pairs
}

/** 1組を照らし合わせる。重なれる位置が無ければ null */
async function matchPair(
  a: SyncInputFile,
  b: SyncInputFile,
  envelopes: Map<string, Float32Array>
): Promise<SyncPairResult | null> {
  const ea = envelopes.get(a.id)!
  const eb = envelopes.get(b.id)!
  let m = matchFeatures(ea, eb)
  let reliable = m ? isReliableMatch(m) : false
  // 丸ごとでは合わない長い2本は、時計のずれで山がつぶれていることがある。窓ごとに合わせ直す
  if (!reliable) {
    const d = matchWithDrift(ea, eb)
    if (d) {
      m = d
      reliable = true
    }
  }
  if (!m) return null
  const result: SyncPairResult = {
    a: a.id,
    b: b.id,
    offset: m.offset,
    confidence: m.confidence,
    distinctness: m.distinctness,
    overlap: m.overlap,
    reliable,
    refined: false
  }
  if (!reliable) return result
  // 窓ごとの合わせで求めた時計の速さ(下で頭と終わりを測り直せれば、そちらで置き換える)
  if ('rate' in m && typeof m.rate === 'number') {
    result.rate = m.rate
    result.driftPpm = (m.rate - 1) * 1e6
  }
  // 重なっている区間(a の時刻)の中ほどで詰める
  const ovStart = Math.max(0, m.offset)
  const ovEnd = Math.min(a.duration, m.offset + b.duration)
  // offset を測った位置。時計がずれていると、測る位置で offset が変わる(sync/solve で補正する)
  result.center = 'center' in m && typeof m.center === 'number' ? m.center : (ovStart + ovEnd) / 2
  try {
    const mid = await refineAt(a, b, m.offset, result.center)
    // GCC-PHAT の山が鋭くなければ(音が少ない区間など)、粗い値のままにする
    if (mid.sharpness >= 5 && Math.abs(mid.offset - m.offset) <= 0.05) {
      result.offset = mid.offset
      result.refined = true
    }
    if (result.refined && ovEnd - ovStart >= DRIFT_MIN_OVERLAP_SEC) {
      const early = ovStart + 60
      const late = ovEnd - 60
      const center = result.center
      // 窓ごとの合わせで時計の速さが分かっていれば、頭と終わりの offset をそこから見込んで狭く探す
      // (見込まずに中ほどの値の周りを探すと、ずれが探す幅を越えて別の山を拾い、速さを取り違えた)
      const known = result.rate
      const expect = (t: number): number =>
        known === undefined ? result.offset : result.offset + (1 - known) * (t - center)
      const shift = known === undefined ? driftSearchSec((late - early) / 2) : 0.05
      const [e, l] = await Promise.all([
        refineAt(a, b, expect(early), early, shift),
        refineAt(a, b, expect(late), late, shift)
      ])
      if (e.sharpness >= 5 && l.sharpness >= 5) {
        // b の時計が速いと、a の後ろほど b の位置は手前(offset が小さく)に見える
        const drift = -(l.offset - e.offset) / (late - early)
        result.driftPpm = drift * 1e6
        result.rate = 1 + drift
      }
    }
  } catch {
    // 細かく詰められなくても、粗い値で並べられる
  }
  return result
}

async function run(): Promise<void> {
  const t0 = Date.now()
  const files = input.files
  const envelopes = new Map<string, Float32Array>()
  let done = 0
  const queue = [...files]
  await Promise.all(
    Array.from({ length: Math.min(DECODE_PARALLEL, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        envelopes.set(f.id, onsetFeature(await envelopeOf(f)))
        done++
        post({
          type: 'progress',
          percent: (done / files.length) * 50,
          stage: `音を読み込み中(${done}/${files.length})`
        })
      }
    })
  )

  const results: SyncPairResult[] = []
  const matchAll = async (
    pairs: [SyncInputFile, SyncInputFile][],
    from: number,
    to: number
  ): Promise<void> => {
    for (let i = 0; i < pairs.length; i++) {
      const [a, b] = pairs[i]
      post({
        type: 'progress',
        percent: from + (i / Math.max(1, pairs.length)) * (to - from),
        stage: `音を照らし合わせ中(${i + 1}/${pairs.length})`
      })
      const r = await matchPair(a, b, envelopes)
      if (r) results.push(r)
    }
  }
  await matchAll(choosePairs(files), 50, 88)
  // マイクが止まっている間に撮ったカメラは、マイクと合わない。そういうカメラだけ、ほかのカメラと照らし合わせる
  await matchAll(orphanCameraPairs(files, results), 88, 98)

  const solution = solvePlacements(
    files.map((f) => ({
      id: f.id,
      sourceId: f.sourceId,
      duration: f.duration,
      recordedAt: f.recordedAt
    })),
    results
      .filter((r) => r.reliable)
      .map((r) => ({
        a: r.a,
        b: r.b,
        offset: r.offset,
        confidence: r.confidence,
        rate: r.rate,
        center: r.center
      }))
  )
  post({ type: 'progress', percent: 100, stage: '完了' })
  post({ type: 'done', report: { ...solution, pairs: results, elapsedMs: Date.now() - t0 } })
}

run().catch((e: unknown) =>
  post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
)
