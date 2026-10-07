/**
 * ゲーム実況の自動編集(`docs/GAME_AUTO_EDIT_PLAN.md` G1)を、本物の ffmpeg と本物の素材ファイルで通す受け入れテスト。
 *
 * 素材は毎回ここで作る: OBS で録った形(ゲーム画面 + ゲーム音 + 自分の声が1本の動画)、8 分。
 * - ゲーム音: ずっと鳴っている環境音と、声の無い所で鳴る爆発音(大きい)
 * - 声: 普段の話し声の中に、時刻を決めて叫び(普段より 12dB 大きい)を入れる。笑いは音声イベントで返す
 * - 黙々とプレイする所(声の無い 40 秒)を3か所
 * 正解(山の時刻)が分かっているので、「面白い所だけ残す」の再現率・適合率を測る(計画書の合格: 0.9 / 0.8)。
 *
 * 音声認識・笑いの検出は、正解から作った決まった答えを返す。同期・音の大きさ・場面分け・判定・カットは本物。
 * ffmpeg(node_modules/ffmpeg-static)か ffprobe が無ければ飛ばす。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
  return { cacheDir: '' }
})

vi.mock('electron', () => ({
  app: { getPath: () => state.cacheDir, isPackaged: false, getAppPath: () => process.cwd() }
}))
vi.mock('@main/syncWorker?modulePath', () => ({ default: '' }))

import { existsSync } from 'fs'
import { ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { scanFootage } from '@main/footageService'
import { cachedEnvelope } from '@main/audioPcm'
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import type { SyncInputFile, SyncReport, SyncWorkerMessage } from '@shared/sync/report'
import type { AsrJob, AsrJobResult } from '@shared/transcript'
import {
  DURATION,
  EXPLOSIONS,
  HYPE_AT,
  LAUGH_AT,
  makeScript,
  mix,
  QUIET,
  renderGame,
  renderVoice,
  writeWav,
  type Line
} from './gameShoot'

const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)

/** 1本の動画の音: ゲームの環境音 + 爆発音(声の無い所) + 声 */
function renderAudio(lines: Line[]): Float32Array {
  return mix(renderGame(EXPLOSIONS), renderVoice(lines, 140))
}

// ---------------------------------------------------------------- アプリの main 側

async function syncInProcess(files: SyncInputFile[]): Promise<SyncReport> {
  return new Promise<SyncReport>((resolve, reject) => {
    vi.resetModules()
    vi.doMock('worker_threads', () => ({
      parentPort: {
        postMessage: (m: SyncWorkerMessage) => {
          if (m.type === 'done') resolve(m.report)
          else if (m.type === 'error') reject(new Error(m.message))
        }
      },
      workerData: { files, ffmpegPath, cacheDir: state.cacheDir }
    }))
    import('@main/syncWorker').catch(reject)
  }).finally(() => vi.doUnmock('worker_threads'))
}

function installApi(lines: Line[]): void {
  const asr = (job: AsrJob): AsrJobResult => {
    const heard = lines.filter(
      (l) => (l.start + l.end) / 2 >= job.start && (l.start + l.end) / 2 < job.end
    )
    return {
      id: job.id,
      text: heard.map((l) => l.text).join(''),
      words: heard.map((l) => ({ text: l.text, start: l.start, end: l.end }))
    }
  }
  const noop = (): (() => void) => () => {}
  const api: Record<string, unknown> = {
    footageScan: (root: string) => scanFootage(root, () => {}),
    onFootageScanProgress: noop,
    syncRun: (files: SyncInputFile[]) => syncInProcess(files),
    onSyncProgress: noop,
    probeMedia: (p: string) => probeMedia(p),
    generateThumbnail: async () => '',
    libraryRemember: async () => ({}),
    footageEnvelopes: (paths: string[]) =>
      Promise.all(
        paths.map((path) => {
          const st = statSync(path)
          return cachedEnvelope(ffmpegPath, state.cacheDir, {
            path,
            size: st.size,
            mtimeMs: st.mtimeMs
          })
        })
      ),
    onAsrProgress: noop,
    asrRun: async (jobs: AsrJob[]) => jobs.map(asr),
    onDenoiseProgress: noop,
    denoiseRun: async (sources: string[]) =>
      sources.map((source) => ({ source, error: 'テストでは除かない' })),
    onEventsProgress: noop,
    eventsRun: async () =>
      LAUGH_AT.map((at) => ({ start: at - 2, end: at + 3, laugh: 0.6, cheer: 0 })),
    onFramesProgress: noop,
    framesRgb: async (requests: unknown[]) => requests.map(() => null),
    onFaceProgress: noop,
    faceDetect: async (requests: unknown[]) => requests.map(() => []),
    onLlmProgress: noop,
    llmRun: async () => [],
    showKitScan: async () => ({ se: [], bgm: [], cg: [] }),
    getEnvApiKeys: async () => ({}),
    onMenuCommand: noop,
    updateMenu: async () => {},
    setBusyState: () => {},
    notifyDone: () => {}
  }
  const proxy = new Proxy(api, {
    get(target, key: string) {
      if (key in target) return target[key]
      return key.startsWith('on') ? noop : async () => undefined
    }
  })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: proxy,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}

// ---------------------------------------------------------------- 測る

/** 仮編集に残った素材の区間(素材の秒) */
function keptRanges(): [number, number][] {
  return useProjectStore
    .getState()
    .project.clips.map((c) => [c.inPoint, c.outPoint] as [number, number])
}
const covered = (ranges: [number, number][], t: number): boolean =>
  ranges.some(([a, b]) => t >= a && t <= b)

describe.skipIf(!HAVE_FFMPEG)('ゲーム実況の自動編集(面白い所だけ残す)', () => {
  let dir = ''
  const keep = Boolean(process.env.E2E_GAME_DIR)
  const lines = makeScript()

  beforeAll(() => {
    dir = keep ? process.env.E2E_GAME_DIR! : mkdtempSync(join(tmpdir(), 've-game-'))
    mkdirSync(join(dir, 'shoot', 'OBS'), { recursive: true })
    state.cacheDir = join(dir, 'analysis-cache')
    rmSync(state.cacheDir, { recursive: true, force: true })
    const wav = join(dir, 'obs.wav')
    writeWav(wav, renderAudio(lines))
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=30',
      '-i',
      wav,
      '-t',
      String(DURATION),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '45',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      join(dir, 'shoot', 'OBS', '2026-10-07 21-00-00.mp4')
    ])
  }, 120_000)

  afterAll(() => {
    if (!keep && dir) rmSync(dir, { recursive: true, force: true })
  })

  async function run(
    kind: 'location' | 'game',
    editPolicy: 'highlights' | 'tempo' | 'light'
  ): Promise<void> {
    installApi(lines)
    useProjectStore.getState().newProject()
    usePipelineStore.getState().reset()
    useSettingsStore.setState({
      aiProvider: 'off',
      showKitFolder: '',
      episodeKind: kind,
      editPolicy
    })
    await usePipelineStore.getState().scanFolder(join(dir, 'shoot'))
    await usePipelineStore.getState().runPipeline()
  }

  it('叫び・笑いのある所を残し、黙々とプレイする所と落ち着いた解説だけの所を落とす', async () => {
    await run('game', 'highlights')
    const log = usePipelineStore.getState().log.map((l) => l.text)
    const kept = keptRanges()
    const total = kept.reduce((t, [a, b]) => t + (b - a), 0)
    const scenes = usePipelineStore.getState().scenes
    const judge = new Map(usePipelineStore.getState().judgements.map((j) => [j.sceneId, j]))
    // 残した時間のうち、山(叫び・笑い)の前後(前 14 秒・後 12 秒)に入る割合
    const peaksAt = [...HYPE_AT, ...LAUGH_AT]
    let nearPeak = 0
    for (const [a, b] of kept)
      for (let t = a; t < b; t += 0.1)
        if (peaksAt.some((p) => t >= p - 14 && t <= p + 12)) nearPeak += Math.min(0.1, b - t)
    const precision = nearPeak / Math.max(1e-9, total)
    const recall = HYPE_AT.filter((h) => covered(kept, h + 0.3)).length / HYPE_AT.length
    const quietKept = QUIET.map(([a, b]) =>
      kept.reduce((t, [x, y]) => t + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)
    )
    const hypeLine = log.find((l) => l.startsWith('声の盛り上がり'))
    console.log(
      JSON.stringify(
        {
          hypeLine,
          total: Math.round(total),
          recall,
          precision,
          quietKept,
          scenes: scenes.map((s) => ({
            s: Math.round(s.start),
            e: Math.round(s.end),
            hype: s.hype,
            laughs: s.laughs,
            kind: judge.get(s.id)?.kind,
            score: judge.get(s.id)?.score
          }))
        },
        null,
        1
      )
    )
    // 叫びは全部見つかり、爆発音(声の無い所)は数えない
    expect(hypeLine).toBe(`声の盛り上がり(叫び・大声): ${HYPE_AT.length} 回`)
    expect(recall).toBeGreaterThanOrEqual(0.9)
    expect(precision).toBeGreaterThanOrEqual(0.8)
    // 黙々とプレイする所は、最長 2 秒の絵だけ
    for (const q of quietKept) expect(q).toBeLessThanOrEqual(2.5)
    // 8 分の録画が、山の所だけに縮む
    expect(total).toBeLessThan(DURATION * 0.6)
  }, 180_000)

  it('方針を替えると残し方が替わる: 面白い所だけ < テンポよく < 軽く整える', async () => {
    const totals: Record<string, number> = {}
    const calmKept: Record<string, boolean> = {}
    for (const policy of ['highlights', 'tempo', 'light'] as const) {
      await run('game', policy)
      const kept = keptRanges()
      totals[policy] = kept.reduce((t, [a, b]) => t + (b - a), 0)
      // 300 秒あたりは、叫びも笑いも無い落ち着いた解説
      calmKept[policy] = covered(kept, 300)
    }
    console.log(JSON.stringify({ totals, calmKept }))
    expect(calmKept).toEqual({ highlights: false, tempo: true, light: true })
    expect(totals.highlights).toBeLessThan(totals.tempo - 60)
    expect(totals.tempo).toBeLessThan(totals.light)
    // 軽く整える: 場面は落とさず、黙々とプレイする 40 秒 × 3 か所の無言だけを詰める
    expect(totals.light).toBeGreaterThan(DURATION - 3 * 40 - 30)
  }, 300_000)
})
