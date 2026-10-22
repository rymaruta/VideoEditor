/**
 * 自動編集の工程を、収録フォルダ・同期・文字起こし・AI を差し替えて通しで走らせる試験の足場
 * (`pipelineReopen.test.ts` と同じ作り)。呼ぶ前に `localStorage` を用意しておく(`vi.hoisted`)
 */
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { useSettingsStore } from '@renderer/store/settingsStore'

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

export const EPISODE_DURATION = 240
const LINES = [
  'おはようございます、今日はよろしくお願いします',
  'すごい!これは本当に面白いですね!',
  'えっ、ちょっと待って、何それ?',
  'じゃあ次の場所へ移動しましょうか',
  'ここのお店、昔から有名なんですよ',
  'うわー、めっちゃおいしい!最高!',
  'それでは今日はこのへんで、ありがとうございました'
]

export function stubApi(extra: Record<string, unknown> = {}): void {
  const env = new Float32Array(EPISODE_DURATION * 100)
  for (let i = 0; i < env.length; i++) env[i] = Math.floor(i / 300) % 3 < 2 ? 0.2 : 0.0005
  const known: Record<string, unknown> = {
    syncRun: async () => ({
      placements: [{ id: '/r/a.mp4', start: 0, method: 'reference', rate: 1 }],
      issues: [],
      pairs: [],
      elapsedMs: 1
    }),
    onSyncProgress: () => () => {},
    onAsrProgress: () => () => {},
    onDenoiseProgress: () => () => {},
    onEventsProgress: () => () => {},
    probeMedia: async () => ({
      duration: EPISODE_DURATION,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      needsPreviewProxy: false
    }),
    generateThumbnail: async () => undefined,
    footageEnvelopes: async (paths: string[]) => paths.map(() => env),
    asrRun: async (jobs: { id: string; start: number; end: number }[]) =>
      jobs.map((j, i) => ({ id: j.id, text: LINES[i % LINES.length], words: [] })),
    eventsRun: async () => [],
    llmRun: async (requests: unknown[]) => requests.map(() => null),
    setBusyState: () => {},
    notifyDone: () => {},
    ...extra
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: () => true,
    api: new Proxy(known, {
      get: (t, k: string) =>
        k in t ? t[k] : k.startsWith('on') ? () => () => {} : () => Promise.resolve()
    })
  }
}

export async function runEpisode(
  beforeRun?: () => void,
  api: Record<string, unknown> = {}
): Promise<void> {
  stubApi(api)
  useSettingsStore.setState({ aiProvider: 'off', episodeKind: 'location' } as never)
  useProjectStore.getState().newProject('第1回')
  await flush()
  beforeRun?.()
  usePipelineStore.setState({
    running: false,
    root: '/r',
    scanTracks: false,
    scan: { root: '/r', sources: [], skipped: [], stats: {} },
    sources: [
      {
        id: 'cam',
        name: 'カメラA',
        kind: 'camera',
        basis: '',
        files: [
          {
            path: '/r/a.mp4',
            relativePath: 'a.mp4',
            duration: EPISODE_DURATION,
            hasVideo: true,
            hasAudio: true
          }
        ]
      }
    ]
  } as never)
  await usePipelineStore.getState().runPipeline()
}

/**
 * 企画の中身の指紋(ID は出てきた順の番号に置き換える。uuid は毎回変わるので)。
 * 浮動小数は 1e-9 に丸める
 */
export function projectFingerprint(value: unknown): string {
  const ids = new Map<string, string>()
  const raw = JSON.stringify(value, (_k, v) =>
    typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)
      ? Math.round(v * 1e9) / 1e9
      : v
  )
  // 鍵の中・文字の中の uuid も(自動テロップの鍵 `u:<id>:0`、素材の id で引く表)
  const text = raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => {
    if (!ids.has(m)) ids.set(m, `#${ids.size}`)
    return ids.get(m)!
  })
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${text.length}:${h.toString(16)}`
}
