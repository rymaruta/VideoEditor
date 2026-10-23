/**
 * ヘルプ > 環境チェック の結果の形と、それを人が読む文(保存するテキスト)にする純関数。
 *
 * 調べること(main の envCheck.ts が集める):
 * - OS・CPU・メモリ・GPU の名前と VRAM(Electron の app.getGPUInfo)
 * - ffmpeg のハードウェアのエンコーダ(NVENC・Quick Sync・AMF・VideoToolbox)が、実際に短い試し書き出しで
 *   使えるか
 * - 書き出しの速さ(10 秒の試し映像を、CPU と使えるハードウェアで)
 * - ローカル AI(node-llama-cpp が選ぶ GPU と、選ばれるモデル。モデルはダウンロードしない)
 * - 文字起こし(Whisper)の実行方法(GPU → CPU の順と、onnxruntime が使える装置)
 *
 * **どこにも自動では送らない。** 保存したテキストを利用者が見てから送る。API キー・パスの中の利用者名は
 * main が crashLog の伏せ字(sanitizeLogText)で伏せてから、画面とテキストに出す。
 */

import {
  chooseLocalModel,
  judgeLocalModelLoad,
  pickLocalModel,
  skippedModelMessage,
  type LlmLoadFailure
} from './llm'

/** 試すハードウェアのエンコーダ(並びは表の順) */
export const HW_ENCODERS = [
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'h264_amf',
  'h264_videotoolbox'
] as const
export type HwEncoder = (typeof HW_ENCODERS)[number]

/** エンコーダの、利用者に見せる名前 */
export const ENCODER_LABEL: Record<string, string> = {
  libx264: 'CPU(x264)',
  h264_nvenc: 'NVIDIA NVENC(H.264)',
  hevc_nvenc: 'NVIDIA NVENC(H.265)',
  h264_qsv: 'Intel Quick Sync(H.264)',
  h264_amf: 'AMD AMF(H.264)',
  h264_videotoolbox: 'Apple VideoToolbox(H.264)'
}

/** 速さを測る試し映像の長さ(秒)と大きさ */
export const SPEED_TEST_SECONDS = 10
export const SPEED_TEST_SIZE = '1920x1080'
export const SPEED_TEST_FPS = 30

export interface EncoderCheck {
  encoder: HwEncoder
  /** ffmpeg に組み込まれているか(-encoders の一覧) */
  listed: boolean
  /** 短い試し書き出しが通ったか */
  usable: boolean
  /** 使えなかった理由(ffmpeg のエラーの最後の行) */
  error?: string
}

export interface SpeedResult {
  encoder: string
  /** かかった秒数(失敗は null) */
  seconds: number | null
  /** 再生の何倍の速さで書けたか(10 秒 ÷ かかった秒) */
  speed: number | null
  error?: string
}

export interface GpuDevice {
  name: string
  vendor: string
  /** VRAM(MB)。取れなければ undefined */
  vramMb?: number
  driver?: string
  active: boolean
}

export interface LocalAiCheck {
  /** 判定できたか(node-llama-cpp を読み込めたか) */
  ok: boolean
  /** node-llama-cpp が選んだ装置(cuda・vulkan・metal・cpu) */
  device?: string
  gpuNames?: string[]
  vramGb?: number
  /** GPU のメモリが PC のメモリと同じ(Apple Silicon など) */
  unifiedMemory?: boolean
  /** 選ばれるモデル */
  model?: string
  modelSizeGb?: number
  /** このモデルを読み込めるかの判定(読めないときは理由) */
  loadable?: boolean
  reason?: string
  /** 軽いモデルを使う理由など */
  note?: string
  error?: string
}

export interface WhisperCheck {
  /** 試す装置の順(Windows: DirectML → CPU、それ以外: CPU) */
  order: string[]
  /** onnxruntime が使える装置(取れなければ空) */
  backends: string[]
  model: string
  /** モデルをダウンロード済みか */
  downloaded: boolean
  error?: string
}

export interface EnvCheckResult {
  createdAt: string
  app: { product: string; version: string; electron: string; chrome: string }
  os: string
  cpu: string
  cores: number
  memoryGb: number
  freeMemoryGb: number
  gpus: GpuDevice[]
  gpuFeatures: Record<string, string>
  ffmpeg: { version: string; encoders: EncoderCheck[] }
  speed: SpeedResult[]
  localAi: LocalAiCheck
  whisper: WhisperCheck
  /** 調べるのにかかった時間(ミリ秒) */
  durationMs: number
}

/** 進み具合(画面に出す) */
export interface EnvCheckProgress {
  step: string
  done: number
  total: number
}

/** `ffmpeg -encoders` の一覧から、組み込まれているエンコーダの名前を読む */
export function parseEncoderList(text: string): Set<string> {
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    // " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)"
    const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)\s/.exec(line)
    if (m && m[1] !== '=') names.add(m[1])
  }
  return names
}

/** ffmpeg のエラー出力の、意味のある最後の行(長いものは切る) */
export function lastErrorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Conversion failed|Error while|Exiting)/i.test(l))
  const line = lines[lines.length - 1] ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

const VENDORS: Record<number, string> = {
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x8086: 'Intel',
  0x106b: 'Apple',
  0x5143: 'Qualcomm',
  0x15ad: 'VMware',
  0x1af4: 'Virtio',
  0x1414: 'Microsoft'
}

type Json = Record<string, unknown>

/** 入れ子のどこかにある、名前が合う数値(VRAM の項目は OS・版で名前が変わる) */
function findNumber(obj: unknown, key: RegExp, depth = 0): number | undefined {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined
  for (const [k, v] of Object.entries(obj as Json)) {
    if (key.test(k) && typeof v === 'number' && v > 0) return v
    if (key.test(k) && typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  }
  for (const v of Object.values(obj as Json)) {
    const hit = findNumber(v, key, depth + 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** VRAM の値を MB に(バイトで来たもの・MB で来たもの) */
function toMb(n: number | undefined): number | undefined {
  if (n === undefined) return undefined
  return n > 1024 * 1024 ? Math.round(n / 1024 / 1024) : Math.round(n)
}

/**
 * `app.getGPUInfo('complete')` から GPU の一覧を作る。名前は deviceString(無ければ GL の
 * レンダラ)、VRAM は見つかる項目から(無ければ空。ローカル AI の判定の VRAM も別に出す)
 */
export function gpuDevicesFromInfo(info: unknown): GpuDevice[] {
  const root = (info ?? {}) as Json
  const devices = Array.isArray(root.gpuDevice) ? (root.gpuDevice as Json[]) : []
  const aux = (root.auxAttributes ?? {}) as Json
  const renderer = typeof aux.glRenderer === 'string' ? aux.glRenderer : ''
  const vram = toMb(findNumber(root, /^(video_?memory|vram|dedicated_?video_?memory)/i))
  return devices.map((d, i) => {
    const vendorId = typeof d.vendorId === 'number' ? d.vendorId : 0
    const vendor =
      (typeof d.vendorString === 'string' && d.vendorString) ||
      VENDORS[vendorId] ||
      (vendorId === 0 ? '不明' : '') ||
      `vendor 0x${vendorId.toString(16)}`
    const active = d.active === true
    // vendor・device が 0(GPU を使わない描画: --disable-gpu・リモートの画面・ドライバの問題)
    const software = vendorId === 0 && (typeof d.deviceId !== 'number' || d.deviceId === 0)
    const name =
      (typeof d.deviceString === 'string' && d.deviceString) ||
      (active || (i === 0 && devices.length === 1) ? renderer : '') ||
      (software ? 'GPU を使っていない描画(ソフトウェア)' : '') ||
      `${vendor} device 0x${(typeof d.deviceId === 'number' ? d.deviceId : 0).toString(16)}`
    return {
      name,
      vendor,
      vramMb:
        toMb(findNumber(d, /^(video_?memory|vram|dedicated_?video_?memory)/i)) ??
        (active ? vram : undefined),
      driver: typeof d.driverVersion === 'string' && d.driverVersion ? d.driverVersion : undefined,
      active
    }
  })
}

function speedText(r: SpeedResult): string {
  if (r.speed === null || r.seconds === null) return `失敗(${r.error ?? '理由不明'})`
  return `${r.seconds.toFixed(1)} 秒(再生の ${r.speed.toFixed(1)} 倍)`
}

/** 書き出しの速さの、一番速いもの(CPU と比べた倍率つき) */
export function fastestEncoder(
  speed: readonly SpeedResult[]
): { encoder: string; speed: number; vsCpu: number | null } | null {
  const ok = speed.filter((s) => s.speed !== null) as (SpeedResult & { speed: number })[]
  if (ok.length === 0) return null
  const best = ok.reduce((a, b) => (b.speed > a.speed ? b : a))
  const cpu = ok.find((s) => s.encoder === 'libx264')
  return { encoder: best.encoder, speed: best.speed, vsCpu: cpu ? best.speed / cpu.speed : null }
}

/** 画面とテキストに出す、表の行(見出し → 行の組) */
export function envCheckSections(r: EnvCheckResult): { title: string; rows: [string, string][] }[] {
  const ai = r.localAi
  const best = fastestEncoder(r.speed)
  return [
    {
      title: 'PC',
      rows: [
        ['OS', r.os],
        ['CPU', `${r.cpu}(${r.cores} スレッド)`],
        ['メモリ', `${r.memoryGb} GB(空き ${r.freeMemoryGb.toFixed(1)} GB)`]
      ]
    },
    {
      title: 'GPU',
      rows:
        r.gpus.length > 0
          ? r.gpus.map((g, i): [string, string] => [
              `GPU ${i + 1}${g.active ? '(使用中)' : ''}`,
              [
                g.name,
                g.vramMb !== undefined ? `VRAM ${(g.vramMb / 1024).toFixed(1)} GB` : 'VRAM 不明',
                g.driver ? `ドライバ ${g.driver}` : ''
              ]
                .filter(Boolean)
                .join(' / ')
            ])
          : [['GPU', '取得できませんでした']]
    },
    {
      title: 'ハードウェアのエンコーダ',
      rows: [
        ['ffmpeg', r.ffmpeg.version || '不明'],
        ...r.ffmpeg.encoders.map((e): [string, string] => [
          ENCODER_LABEL[e.encoder] ?? e.encoder,
          e.usable
            ? '使える'
            : e.listed
              ? `使えない(${e.error || '試し書き出しに失敗'})`
              : 'この ffmpeg に入っていない'
        ])
      ]
    },
    {
      title: `書き出しの速さ(${SPEED_TEST_SECONDS} 秒・${SPEED_TEST_SIZE}・${SPEED_TEST_FPS}fps の試し映像)`,
      rows: [
        ...r.speed.map((s): [string, string] => [
          ENCODER_LABEL[s.encoder] ?? s.encoder,
          speedText(s)
        ]),
        ...(best && best.encoder !== 'libx264' && best.vsCpu !== null
          ? [
              [
                '一番速いもの',
                `${ENCODER_LABEL[best.encoder] ?? best.encoder}(CPU の ${best.vsCpu.toFixed(1)} 倍)`
              ] as [string, string]
            ]
          : [])
      ]
    },
    {
      title: 'ローカル AI(node-llama-cpp)',
      rows: ai.ok
        ? [
            ['使う装置', ai.device === 'cpu' ? 'CPU(GPU なし)' : (ai.device ?? '不明')],
            ...(ai.gpuNames && ai.gpuNames.length > 0
              ? [['GPU', ai.gpuNames.join(' / ')] as [string, string]]
              : []),
            [
              'VRAM',
              ai.device === 'cpu'
                ? '—'
                : `${(ai.vramGb ?? 0).toFixed(1)} GB${ai.unifiedMemory ? '(PC のメモリと共有)' : ''}`
            ],
            [
              '選ばれるモデル',
              ai.model ? `${ai.model}(約 ${(ai.modelSizeGb ?? 0).toFixed(1)} GB)` : '—'
            ],
            [
              '判定',
              ai.loadable
                ? `読み込める見込み${ai.note ? `(${ai.note})` : ''}`
                : `使わない: ${ai.reason ?? '不明'}`
            ]
          ]
        : [['判定', `調べられませんでした(${ai.error ?? '不明'})`]]
    },
    {
      title: '文字起こし(Whisper)',
      rows: [
        ['試す順', r.whisper.order.map(deviceLabel).join(' → ')],
        [
          'onnxruntime の装置',
          r.whisper.backends.length > 0
            ? r.whisper.backends.map(deviceLabel).join('・')
            : `不明${r.whisper.error ? `(${r.whisper.error})` : ''}`
        ],
        [
          'モデル',
          `${r.whisper.model}(${r.whisper.downloaded ? 'ダウンロード済み' : '未ダウンロード。初回の文字起こしでダウンロード'})`
        ]
      ]
    }
  ]
}

function deviceLabel(d: string): string {
  if (d === 'dml') return 'DirectML(GPU)'
  if (d === 'cuda') return 'CUDA(GPU)'
  if (d === 'webgpu') return 'WebGPU'
  if (d === 'coreml') return 'Core ML'
  if (d === 'tensorrt') return 'TensorRT(GPU)'
  if (d === 'cpu') return 'CPU'
  return d
}

/** 保存するテキスト(伏せ字は main がこの後にかける) */
export function buildEnvCheckReport(r: EnvCheckResult): string {
  const lines = [
    `${r.app.product} 環境チェック`,
    `作成: ${r.createdAt}(調べるのに ${(r.durationMs / 1000).toFixed(0)} 秒)`,
    `版: ${r.app.product} ${r.app.version} / Electron ${r.app.electron} / Chromium ${r.app.chrome}`,
    '',
    'このファイルはどこにも自動では送られません。送る前に中身を確かめてください。',
    'API キーと、パスの中の利用者名は伏せています。',
    ''
  ]
  for (const s of envCheckSections(r)) {
    lines.push(`[${s.title}]`)
    for (const [k, v] of s.rows) lines.push(`  ${k}: ${v}`)
    lines.push('')
  }
  const features = Object.entries(r.gpuFeatures)
  if (features.length > 0) {
    lines.push('[GPU の機能(Chromium)]')
    for (const [k, v] of features) lines.push(`  ${k}: ${v}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 保存するファイルの名前(日時つき) */
export function envCheckFileName(product: string, d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${product}-環境チェック-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`
}

/**
 * ローカル AI の構成の判定(モデルはダウンロードしない)。自動編集が実際に使うのと同じ選び方
 * (pickLocalModel・judgeLocalModelLoad)で、node-llama-cpp が見つけた GPU から決める
 */
export function judgeLocalAi(input: {
  /** node-llama-cpp が選んだ GPU(cuda・vulkan・metal)。無ければ false */
  gpu: string | false
  vramGb: number
  unifiedMemory: boolean
  gpuNames: string[]
  ramGb: number
  appVersion: string
  failures: readonly LlmLoadFailure[]
}): LocalAiCheck {
  const env = {
    appVersion: input.appVersion,
    gpu: input.gpu || 'cpu',
    vramGb: input.vramGb,
    ramGb: input.ramGb
  }
  const hasGpu = Boolean(input.gpu)
  const pick = pickLocalModel({ vramGb: input.vramGb, hasGpu, failures: input.failures, env })
  const base = {
    ok: true,
    device: input.gpu || 'cpu',
    gpuNames: input.gpuNames,
    vramGb: input.vramGb,
    unifiedMemory: input.unifiedMemory
  }
  if (pick.kind === 'skip') {
    const choice = chooseLocalModel(input.vramGb, hasGpu)
    return {
      ...base,
      model: choice.label,
      modelSizeGb: choice.sizeGb,
      loadable: false,
      reason: skippedModelMessage(pick.label)
    }
  }
  const decision = judgeLocalModelLoad({
    gpu: input.gpu,
    vramTotalGb: input.vramGb,
    unifiedMemory: input.unifiedMemory,
    ramTotalGb: input.ramGb,
    modelGb: pick.model.sizeGb,
    modelLabel: pick.model.label
  })
  return {
    ...base,
    model: pick.model.label,
    modelSizeGb: pick.model.sizeGb,
    loadable: decision.ok,
    reason: decision.ok ? undefined : decision.reason,
    note: pick.note
  }
}
