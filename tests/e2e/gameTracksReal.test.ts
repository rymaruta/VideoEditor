/**
 * ゲーム実況の取り込み(`docs/GAME_AUTO_EDIT_PLAN.md` G2)を、本物の ffmpeg と本物のファイルで通す受け入れテスト。
 *
 * 収録の形(よくある組み合わせを全部入れる):
 * - OBS の録画 1 本(ゲーム画面)に音声トラック 3 本: 1 = 全部入り、2 = 実況者の声、3 = ゲーム音。トラックの名前は無し
 * - 顔カメラ(Web カメラ)の別の録画。OBS より 1.5 秒遅れて録り始めた
 * - Craig の話者別ファイル(コラボ相手「tomo」)。OBS より 3 秒早く録り始めた
 * 爆発音は、声の無い所だけでなく落ち着いた解説の最中にも鳴らす(1本の音では声の盛り上がりと見分けにくい)。
 * トラックを分けて声だけで測れば、叫びだけを拾えることを確かめる。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
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
// テロップの層は画面の描画(canvas)で作るので、このテストでは作らない(テロップの描画は別の受け入れテストで確かめている)
vi.mock('@renderer/lib/telopRaster', () => ({ prepareTelopLayerForExport: async () => null }))

import { exportProject, ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { saveProjectFile } from '@main/projectFileService'
import { scanFootage } from '@main/footageService'
import { cachedEnvelope } from '@main/audioPcm'
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import type { SyncInputFile, SyncReport, SyncWorkerMessage } from '@shared/sync/report'
import type { AsrJob, AsrJobResult } from '@shared/transcript'
import type { Project } from '@shared/types'
import { detectHype } from '@shared/structure/hype'
import {
  DURATION,
  EXPLOSIONS,
  explosionsDuringTalk,
  FS,
  HYPE_AT,
  LAUGH_AT,
  makeFriendScript,
  makeScript,
  mix,
  QUIET,
  renderGame,
  renderVoice,
  writeWav,
  type Line
} from './gameShoot'

const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)
const FACE_LATE = 1.5
const CRAIG_EARLY = 3

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

function installApi(streamer: Line[], friend: Line[], calls: { asrPaths: string[] }): void {
  const asr = (job: AsrJob): AsrJobResult => {
    calls.asrPaths.push(job.path)
    // ファイルの時刻で答える。実況者の声のトラック(2本目)は OBS と同じ時刻、Craig は 3 秒早く始まっている
    const [lines, shift] = /_track2\.m4a$/.test(job.path)
      ? [streamer, 0]
      : /1-tomo\.flac$/.test(job.path)
        ? [friend, CRAIG_EARLY]
        : [[], 0]
    const heard = lines.filter(
      (l) => (l.start + l.end) / 2 + shift >= job.start && (l.start + l.end) / 2 + shift < job.end
    )
    return {
      id: job.id,
      text: heard.map((l) => l.text).join(''),
      words: heard.map((l) => ({ text: l.text, start: l.start + shift, end: l.end + shift }))
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
    saveProject: async (path: string, project: unknown) =>
      saveProjectFile(path, project as Parameters<typeof saveProjectFile>[1]),
    exportProject: (payload: Parameters<typeof exportProject>[0]) =>
      exportProject({ ...payload, onProgress: () => {} }),
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

function ff(args: string[]): void {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
}

describe.skipIf(!HAVE_FFMPEG)('ゲーム実況の取り込み(OBS の音声トラック別・顔カメラ・Craig)', () => {
  let dir = ''
  const keep = Boolean(process.env.E2E_GAME_DIR)
  const streamer = makeScript()
  const friend = makeFriendScript(streamer)

  beforeAll(() => {
    dir = keep ? process.env.E2E_GAME_DIR! : mkdtempSync(join(tmpdir(), 've-gametracks-'))
    const shoot = join(dir, 'tracks')
    rmSync(shoot, { recursive: true, force: true })
    for (const sub of ['OBS', 'webcam', 'craig']) mkdirSync(join(shoot, sub), { recursive: true })
    state.cacheDir = join(dir, 'userdata')
    rmSync(state.cacheDir, { recursive: true, force: true })

    const game = renderGame(EXPLOSIONS, explosionsDuringTalk(streamer))
    const voice = renderVoice(streamer, 140)
    const tomo = renderVoice(friend, 210)
    const wav = (name: string, x: Float32Array): string => {
      const p = join(dir, name)
      writeWav(p, x)
      return p
    }
    const t1 = wav('t1.wav', mix(game, voice, tomo))
    const t2 = wav('t2.wav', voice)
    const t3 = wav('t3.wav', game)
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30',
      '-i',
      t1,
      '-i',
      t2,
      '-i',
      t3,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-map',
      '3:a',
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
      join(shoot, 'OBS', '2026-10-07 21-00-00.mp4')
    ])
    // 顔カメラ: OBS の 1.5 秒後から。Web カメラのマイクは声を小さめに拾う
    const face = renderVoice(streamer, 140, -FACE_LATE).subarray(
      0,
      Math.round((DURATION - FACE_LATE) * FS)
    )
    const faceWav = wav(
      'face.wav',
      mix(
        face.map((v) => v * 0.5),
        new Float32Array(face.length)
      )
    )
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=30',
      '-i',
      faceWav,
      '-t',
      String(DURATION - FACE_LATE),
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
      join(shoot, 'webcam', 'facecam.mp4')
    ])
    // Craig: OBS の 3 秒前から
    ff([
      '-i',
      wav('tomo.wav', renderVoice(friend, 210, CRAIG_EARLY)),
      join(shoot, 'craig', '1-tomo.flac')
    ])
  }, 240_000)

  afterAll(() => {
    if (!keep && dir) rmSync(dir, { recursive: true, force: true })
  })

  it('トラックを分け、役割を推し量り、声だけで盛り上がりを測る。ゲーム音と声を鳴らし、顔カメラはワイプで出す', async () => {
    const calls = { asrPaths: [] as string[] }
    installApi(streamer, friend, calls)
    useProjectStore.getState().newProject()
    usePipelineStore.getState().reset()
    useSettingsStore.setState({
      aiProvider: 'off',
      showKitFolder: '',
      episodeKind: 'game',
      editPolicy: 'highlights'
    })
    await usePipelineStore.getState().scanFolder(join(dir, 'tracks'))
    const sources = usePipelineStore.getState().sources
    const summary = sources.map((s) => ({
      name: s.name,
      kind: s.kind,
      trackRole: s.trackRole,
      cameraRole: s.cameraRole
    }))
    console.log(JSON.stringify(summary))
    expect(summary).toEqual([
      { name: 'カメラA', kind: 'camera', trackRole: undefined, cameraRole: 'screen' },
      { name: 'カメラB', kind: 'camera', trackRole: undefined, cameraRole: 'face' },
      { name: 'tomo', kind: 'mic', trackRole: undefined, cameraRole: undefined },
      { name: '全部入り(トラック1)', kind: 'audio', trackRole: 'mix', cameraRole: undefined },
      { name: '声(トラック2)', kind: 'mic', trackRole: 'voice', cameraRole: undefined },
      { name: 'ゲーム音(トラック3)', kind: 'audio', trackRole: 'game', cameraRole: undefined }
    ])

    await usePipelineStore.getState().runPipeline()
    const log = usePipelineStore.getState().log.map((l) => l.text)
    const project = useProjectStore.getState().project
    const info = project.multicam!
    const placed = (name: string): number | undefined => {
      const src = info.sources.find((s) => s.name === name)
      return info.files.find((f) => f.sourceId === src?.id)?.start
    }
    // 位置: 取り出したトラックは OBS と同じ頭、顔カメラは 1.5 秒後、Craig は 3 秒前
    const obs = placed('カメラA')!
    expect(placed('声(トラック2)')).toBeCloseTo(obs, 6)
    expect(placed('ゲーム音(トラック3)')).toBeCloseTo(obs, 6)
    expect(placed('カメラB')! - obs).toBeCloseTo(FACE_LATE, 1)
    expect(placed('tomo')! - obs).toBeCloseTo(-CRAIG_EARLY, 1)
    expect(info.anchorSourceId).toBe(info.sources.find((s) => s.name === 'カメラA')!.id)

    // 文字起こしは声のトラックと Craig だけ(ゲーム音・全部入りは文字起こししない)
    const asked = [...new Set(calls.asrPaths.map((p) => p.split(/[/\\]/).pop()))].sort()
    expect(asked.every((p) => /_track2\.m4a$|1-tomo\.flac$/.test(p!))).toBe(true)

    // 盛り上がりは声のトラックで測るので、解説中の爆発音は数えない
    const hypeLine = log.find((l) => l.startsWith('声の盛り上がり'))
    expect(hypeLine).toBe(`声の盛り上がり(叫び・大声): ${HYPE_AT.length} 回`)

    // 計器を先に疑う: 同じ発話を全部入りのトラック(1本の音)で測ると、解説中の爆発音も山に数える
    const mixFile = usePipelineStore.getState().sources.find((s) => s.trackRole === 'mix')!.files[0]
    const st = statSync(mixFile.path)
    const env = await cachedEnvelope(ffmpegPath, state.cacheDir, {
      path: mixFile.path,
      size: st.size,
      mtimeMs: st.mtimeMs
    })
    const db = Float32Array.from(env, (v) => 20 * Math.log10(v + 1e-12))
    const onMix = detectHype(streamer, () => db)
    expect(onMix.length).toBeGreaterThan(HYPE_AT.length)

    // 面白い所だけ: 山は全部残り、黙々とプレイする所は残さない
    const kept = project.clips.map((c) => [c.inPoint, c.outPoint] as [number, number])
    const covered = (t: number): boolean => kept.some(([a, b]) => t >= a && t <= b)
    expect(HYPE_AT.every((h) => covered(h + 0.3))).toBe(true)
    for (const [a, b] of QUIET) {
      const inside = kept.reduce((t, [x, y]) => t + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)
      expect(inside).toBeLessThanOrEqual(2.5)
    }

    // 音: 声・ゲーム音・相手の声を鳴らし、全部入りは鳴らさない(重なって二重になる)。基準カメラの音は重ねない
    const tracks = project.audioTracks.map((t) => ({
      name: t.name,
      muted: t.muted,
      voice: Boolean(t.voice),
      clips: t.clips.length
    }))
    console.log(JSON.stringify(tracks))
    const byName = new Map(tracks.map((t) => [t.name, t]))
    expect(byName.get('声(トラック2)')).toMatchObject({ muted: false, voice: true })
    expect(byName.get('tomo')).toMatchObject({ muted: false, voice: true })
    expect(byName.get('ゲーム音(トラック3)')).toMatchObject({ muted: false, voice: false })
    expect(byName.get('全部入り(トラック1)')).toMatchObject({ muted: true })
    expect(tracks.some((t) => t.name.includes('カメラA'))).toBe(false)
    for (const t of tracks) expect(t.clips).toBeGreaterThan(0)

    // 顔カメラはワイプで出し、本編と同じ区間を並べる
    const face = project.videoOverlayTracks.find((t) => t.name === 'カメラB')
    expect(face).toBeDefined()
    expect(face!.hidden).toBe(false)
    expect(face!.position).toBe('bottom-right')
    const mainLen = project.clips.reduce((t, c) => t + (c.outPoint - c.inPoint) / (c.speed || 1), 0)
    const faceLen = face!.clips.reduce((t, c) => t + (c.outPoint - c.inPoint), 0)
    expect(Math.abs(faceLen - mainLen)).toBeLessThan(2)
    // 本編は全部ゲーム画面(顔カメラへ切り替えない)
    const screenAsset = new Set(
      info.files.filter((f) => f.sourceId === info.anchorSourceId).map((f) => f.assetId)
    )
    expect(project.clips.every((c) => screenAsset.has(c.assetId))).toBe(true)

    // ショート: 山の強い順に 3 本、45 秒まで。縦 1080×1920、顔カメラは上に横幅いっぱい
    const outDir = join(dir, 'shorts')
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
    const files = await usePipelineStore.getState().makeShorts(outDir, { count: 3, maxSec: 45 })
    expect(usePipelineStore.getState().shorts.state).toBe('done')
    expect(files).toHaveLength(3)
    for (const f of files) {
      const probe = JSON.parse(
        execFileSync(ffprobePath, [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          f
        ]).toString()
      ) as {
        format: { duration: string }
        streams: { codec_type: string; width?: number; height?: number }[]
      }
      const v = probe.streams.find((x) => x.codec_type === 'video')!
      expect([v.width, v.height]).toEqual([1080, 1920])
      expect(probe.streams.some((x) => x.codec_type === 'audio')).toBe(true)
      const len = Number(probe.format.duration)
      expect(len).toBeGreaterThanOrEqual(14)
      expect(len).toBeLessThanOrEqual(49)
      expect(existsSync(f.replace(/\.mp4$/, '.veproj'))).toBe(true)
    }
    const short = JSON.parse(readFileSync(files[0].replace(/\.mp4$/, '.veproj'), 'utf8'))
    const sp = (short.project ?? short) as Project
    expect(sp.aspectRatio).toBe('9:16')
    expect(sp.clips.every((c) => c.fillCrop)).toBe(true)
    expect(sp.videoOverlayTracks[0]).toMatchObject({
      position: 'top-left',
      scale: 1,
      hidden: false
    })
    expect(sp.textOverlays.length).toBeGreaterThan(0)
    // どのショートにも叫びの山が入っている
    const shortsInfo = usePipelineStore.getState().log.filter((l) => l.text.startsWith('ショート '))
    expect(shortsInfo).toHaveLength(3)
    const sec = (t: string): number => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1])
    for (const l of shortsInfo) {
      const m = /: (\d+:\d+)〜(\d+:\d+)/.exec(l.text)!
      const [a, b] = [sec(m[1]), sec(m[2])]
      expect(HYPE_AT.some((h) => h >= a && h <= b)).toBe(true)
    }
  }, 300_000)
})
