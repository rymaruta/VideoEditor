import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { normalizeTextStyle } from '@shared/textStyle'
import type { QualityPreset, ResolutionHeight, TextStyle } from '@shared/types'

const CAPTION_PRESETS_KEY = 've-caption-presets'
const SE_PRESETS_KEY = 've-se-presets'
const EXPORT_PRESETS_KEY = 've-export-presets'

export interface CaptionPreset {
  id: string
  name: string
  style: TextStyle
  /** この話者の発言テロップに自動で使う(テロップスタイルの管理で選ぶ) */
  speakers?: string[]
}

export interface SePreset {
  id: string
  name: string
  filePath: string
  fileName: string
}

/** よく使う書き出し設定の組み合わせ。アスペクト比はプロジェクトの属性なので含めない */
export interface ExportPreset {
  id: string
  name: string
  resolutionHeight: ResolutionHeight
  quality: QualityPreset
  loudnessNormalization: boolean
}

const RESOLUTION_HEIGHTS: ResolutionHeight[] = [480, 720, 1080, 1440, 2160]
const QUALITY_PRESETS: QualityPreset[] = ['high', 'standard', 'small']

// localStorage は外部入力そのもの: 手で書き換えられるし、古い版が別の形で書いている
// こともある。JSON.parse が通っただけの値をそのまま返すと、配列でなかったり要素が
// null だったりしたときに、それを .map() する画面ごと落ちる(実測: 値が "null" や
// "5" のとき「v.map is not a function」で パネル全体が表示できなくなる)。
// 配列でなければ空にし、使えない要素は捨てて残りを返す。
function loadArray<T>(
  key: string,
  isValid: (value: unknown) => value is T,
  repair: (value: T) => T = (v) => v
): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValid).map(repair)
  } catch {
    return []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasIdAndName(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function isCaptionPreset(value: unknown): value is CaptionPreset {
  return hasIdAndName(value) && isRecord(value.style)
}

/**
 * `style` が**オブジェクトであること**しか確かめていないので、中身は歯抜けのまま通る。
 * 通ったお気に入りは `PresetPanel` がそのまま `addTextOverlay` へ渡すため、
 * 項目の欠けたテロップがプロジェクトに入り、**書き出しで初めて落ちる**
 * (実測: `style: {}` のお気に入りから作ったテロップがあると、書き出しが
 * 「Cannot read properties of undefined (reading 'replace')」で失敗する。
 * `color` だけ、`outlineColor` だけ落としても同じ)。
 *
 * 捨てずに**直して残す**のは、プロジェクトファイルの読み込みと同じ方針
 * (`normalizeTextStyle`)。名前は利用者が付けたもので、色が欠けていることは
 * 消してよい理由にならない。
 */
function repairCaptionPreset(preset: CaptionPreset): CaptionPreset {
  const speakers = Array.isArray(preset.speakers)
    ? preset.speakers.filter((sp): sp is string => typeof sp === 'string' && sp.trim() !== '')
    : []
  return {
    ...preset,
    style: normalizeTextStyle(preset.style),
    speakers: speakers.length > 0 ? speakers : undefined
  }
}

function isSePreset(value: unknown): value is SePreset {
  return (
    hasIdAndName(value) && typeof value.filePath === 'string' && typeof value.fileName === 'string'
  )
}

function isExportPreset(value: unknown): value is ExportPreset {
  return (
    hasIdAndName(value) &&
    RESOLUTION_HEIGHTS.includes(value.resolutionHeight as ResolutionHeight) &&
    QUALITY_PRESETS.includes(value.quality as QualityPreset) &&
    typeof value.loudnessNormalization === 'boolean'
  )
}

interface PresetState {
  captionPresets: CaptionPreset[]
  sePresets: SePreset[]
  exportPresets: ExportPreset[]
  addCaptionPreset: (name: string, style: TextStyle) => void
  removeCaptionPreset: (id: string) => void
  /** テロップスタイルの管理で OK を押したとき、一覧をまるごと置き換える */
  replaceCaptionPresets: (presets: CaptionPreset[]) => void
  addSePreset: (name: string, filePath: string, fileName: string) => void
  removeSePreset: (id: string) => void
  /** 同じ名前が既にあるときは追加せず false を返す(どちらを押したか区別できなくなるため) */
  addExportPreset: (name: string, settings: Omit<ExportPreset, 'id' | 'name'>) => boolean
  removeExportPreset: (id: string) => void
}

/**
 * 保存する。保存できなくても(容量が一杯・使えない)画面の変更は残す(保存の失敗で投げると、
 * 足したプリセット・スタイルの管理の OK が消えていた)
 */
function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 次に保存できたときに書かれる
  }
}

export const usePresetStore = create<PresetState>((set, get) => ({
  captionPresets: loadArray(CAPTION_PRESETS_KEY, isCaptionPreset, repairCaptionPreset),
  sePresets: loadArray(SE_PRESETS_KEY, isSePreset),
  exportPresets: loadArray(EXPORT_PRESETS_KEY, isExportPreset),

  addCaptionPreset: (name, style) => {
    // 書き込むときも同じ規則を通す。歯抜けの style がここから入ると、
    // 次に開いたときに直る(＝症状が消える)ぶん、原因が追えなくなる。
    const next = [...get().captionPresets, { id: uuid(), name, style: normalizeTextStyle(style) }]
    persist(CAPTION_PRESETS_KEY, next)
    set({ captionPresets: next })
  },

  replaceCaptionPresets: (presets) => {
    const next = presets.map(repairCaptionPreset)
    persist(CAPTION_PRESETS_KEY, next)
    set({ captionPresets: next })
  },

  removeCaptionPreset: (id) => {
    const next = get().captionPresets.filter((p) => p.id !== id)
    persist(CAPTION_PRESETS_KEY, next)
    set({ captionPresets: next })
  },

  addSePreset: (name, filePath, fileName) => {
    const next = [...get().sePresets, { id: uuid(), name, filePath, fileName }]
    persist(SE_PRESETS_KEY, next)
    set({ sePresets: next })
  },

  removeSePreset: (id) => {
    const next = get().sePresets.filter((p) => p.id !== id)
    persist(SE_PRESETS_KEY, next)
    set({ sePresets: next })
  },

  addExportPreset: (name, settings) => {
    const trimmed = name.trim()
    if (!trimmed) return false
    if (get().exportPresets.some((p) => p.name === trimmed)) return false
    const next = [...get().exportPresets, { id: uuid(), name: trimmed, ...settings }]
    persist(EXPORT_PRESETS_KEY, next)
    set({ exportPresets: next })
    return true
  },

  removeExportPreset: (id) => {
    const next = get().exportPresets.filter((p) => p.id !== id)
    persist(EXPORT_PRESETS_KEY, next)
    set({ exportPresets: next })
  }
}))
