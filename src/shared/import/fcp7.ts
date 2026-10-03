import type { AudioTrack, Clip, MediaAsset, Project } from '../types'
import { defaultTextStyle } from '../textStyle'
/**
 * Premiere などが書き出す FCP7 XML(xmeml)を読む(計画書 §7)。
 * 人が仕上げた過去回の「採用区間・カット点・アングル・テロップの文字と時刻・SE/BGM」を取り出し、
 * 番組スタイルの学習と、自動編集との比較(評価)に使う。仕上げをこのアプリで完結させる方針とは矛盾しない
 * (人の編集結果を読むためだけに使い、書き出しはしない)。
 *
 * XML の解析そのものは呼び出し側に任せる(画面は標準の DOMParser、テストは xmldom)。ここでは要素をたどるだけ。
 */

/** DOM の要素のうち、ここで使うものだけ(DOMParser と xmldom の両方で通る) */
export interface XmlElement {
  tagName: string
  textContent: string | null
  childNodes: ArrayLike<unknown>
  getAttribute(name: string): string | null
  getElementsByTagName(name: string): ArrayLike<XmlElement>
}

export interface Fcp7Clip {
  /** タイムラインの秒 */
  start: number
  end: number
  /** 素材の秒 */
  in: number
  out: number
  fileName: string
  path?: string
  /** 素材ファイル全体の長さ(秒。分かれば) */
  fileDuration?: number
  /** 音量(Audio Levels。1 = 0dB。音声のクリップだけ) */
  gain?: number
}

export interface Fcp7Sequence {
  name: string
  fps: number
  duration: number
  /** トラックごと(下から) */
  video: Fcp7Clip[][]
  audio: Fcp7Clip[][]
  /** 文字のジェネレーター(テロップ)。タイムラインの秒 */
  texts: { start: number; end: number; text: string }[]
}

function children(el: XmlElement, tag: string): XmlElement[] {
  const out: XmlElement[] = []
  const nodes = el.childNodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as XmlElement
    if (n && typeof n === 'object' && n.tagName === tag) out.push(n)
  }
  return out
}

function child(el: XmlElement | undefined, tag: string): XmlElement | undefined {
  return el ? children(el, tag)[0] : undefined
}

function num(el: XmlElement | undefined): number {
  const v = Number(el?.textContent?.trim())
  return Number.isFinite(v) ? v : NaN
}

/** `<rate>` から 1 秒あたりのフレーム数(NTSC は 1000/1001 倍) */
function rateOf(el: XmlElement | undefined, fallback: number): number {
  const rate = child(el, 'rate')
  const timebase = num(child(rate, 'timebase'))
  if (!Number.isFinite(timebase) || timebase <= 0) return fallback
  const ntsc = child(rate, 'ntsc')?.textContent?.trim().toUpperCase() === 'TRUE'
  return ntsc ? (timebase * 1000) / 1001 : timebase
}

function decodePath(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const p = decodeURIComponent(url.replace(/^file:\/\/(localhost)?/, ''))
    // Windows のパス(/C:/...)は頭の / を外す
    return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p
  } catch {
    return url
  }
}

/** 文書の中の、ID で参照されるファイルの定義(2回目以降は `<file id="x"/>` だけになる) */
function fileTable(root: XmlElement, fps: number): Map<string, XmlElement> {
  const table = new Map<string, XmlElement>()
  const files = root.getElementsByTagName('file')
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const id = f.getAttribute('id')
    if (id && (child(f, 'name') || child(f, 'pathurl')) && !table.has(id)) table.set(id, f)
  }
  void fps
  return table
}

function readTrack(track: XmlElement, fps: number, files: Map<string, XmlElement>): Fcp7Clip[] {
  const out: Fcp7Clip[] = []
  let lastEnd = 0
  for (const item of children(track, 'clipitem')) {
    if (child(item, 'enabled')?.textContent?.trim().toUpperCase() === 'FALSE') continue
    const itemFps = rateOf(item, fps)
    let start = num(child(item, 'start'))
    let end = num(child(item, 'end'))
    const inF = num(child(item, 'in'))
    const outF = num(child(item, 'out'))
    if (!Number.isFinite(inF) || !Number.isFinite(outF) || outF <= inF) continue
    // つなぎ(トランジション)に掛かるクリップは start / end が -1 になる。前後から補う
    if (!(start >= 0)) start = lastEnd * itemFps
    if (!(end >= 0)) end = start + (outF - inF)
    const fileEl = child(item, 'file')
    const ref = fileEl?.getAttribute('id')
    const def = (ref && files.get(ref)) || fileEl
    const fileName =
      child(def, 'name')?.textContent?.trim() || child(item, 'name')?.textContent?.trim() || ''
    const fileFrames = num(child(def, 'duration'))
    const fileFps = rateOf(def, itemFps)
    const clip: Fcp7Clip = {
      start: start / itemFps,
      end: end / itemFps,
      in: inF / itemFps,
      out: outF / itemFps,
      fileName,
      path: decodePath(child(def, 'pathurl')?.textContent?.trim()),
      ...(Number.isFinite(fileFrames) ? { fileDuration: fileFrames / fileFps } : {})
    }
    const gain = levelOf(item)
    if (gain !== undefined) clip.gain = gain
    lastEnd = clip.end
    out.push(clip)
  }
  return out
}

/** クリップに掛かった Audio Levels(倍率)。無ければ undefined */
function levelOf(item: XmlElement): number | undefined {
  const params = item.getElementsByTagName('parameter')
  for (let i = 0; i < params.length; i++) {
    const id = child(params[i], 'parameterid')?.textContent?.trim().toLowerCase()
    if (id !== 'level') continue
    const v = num(child(params[i], 'value'))
    if (Number.isFinite(v) && v >= 0) return v
  }
  return undefined
}

function readTexts(track: XmlElement, fps: number): Fcp7Sequence['texts'] {
  const out: Fcp7Sequence['texts'] = []
  for (const g of children(track, 'generatoritem')) {
    const start = num(child(g, 'start'))
    const end = num(child(g, 'end'))
    if (!(start >= 0) || !(end > start)) continue
    // 文字の値は effect > parameter(parameterid が str / text)
    const params = g.getElementsByTagName('parameter')
    let text = ''
    for (let i = 0; i < params.length; i++) {
      const id = child(params[i], 'parameterid')?.textContent?.trim().toLowerCase()
      if (id === 'str' || id === 'text') {
        text = child(params[i], 'value')?.textContent?.trim() ?? ''
        if (text) break
      }
    }
    if (text) out.push({ start: start / fps, end: end / fps, text })
  }
  return out
}

/** 文書の最初のシーケンスを読む(無ければ null) */
export function readFcp7(root: XmlElement): Fcp7Sequence | null {
  const seq = root.getElementsByTagName('sequence')[0]
  if (!seq) return null
  const fps = rateOf(seq, 30)
  const files = fileTable(root, fps)
  const media = child(seq, 'media')
  const video: Fcp7Clip[][] = []
  const audio: Fcp7Clip[][] = []
  const texts: Fcp7Sequence['texts'] = []
  for (const track of children(child(media, 'video') ?? seq, 'track')) {
    video.push(readTrack(track, fps, files))
    texts.push(...readTexts(track, fps))
  }
  for (const track of children(child(media, 'audio') ?? seq, 'track'))
    audio.push(readTrack(track, fps, files))
  return {
    name: child(seq, 'name')?.textContent?.trim() ?? '',
    fps,
    duration: num(child(seq, 'duration')) / fps || 0,
    video,
    audio,
    texts: texts.sort((a, b) => a.start - b.start)
  }
}

/** 収録素材とみなす長さ(これより長い音声ファイルは、ピンマイクやカメラの録音) */
const RECORDING_SEC = 600

/**
 * 番組スタイルの学習(`learnShowStyle`)に渡せる形にする。
 * - 本編: 一番下の映像トラック
 * - テロップ: 文字のジェネレーター
 * - 音声: 10分を超える録音(またはカメラの音)は出演者の声・周りの音として扱い、それ以外を SE・BGM とみなす
 */
export function fcp7ToProject(seq: Fcp7Sequence): Project {
  const videoFiles = new Set(seq.video.flat().map((c) => c.fileName))
  const names = new Set([...seq.video.flat(), ...seq.audio.flat()].map((c) => c.fileName))
  const assets: MediaAsset[] = [...names].map((n) => ({
    id: n,
    filePath: n,
    fileName: n,
    duration: 0,
    width: 0,
    height: 0,
    fps: seq.fps,
    hasAudio: true,
    hasVideo: videoFiles.has(n)
  }))
  const main = [...(seq.video[0] ?? [])].sort((a, b) => a.start - b.start)
  const clips: Clip[] = main.map((c, i) => ({
    id: `v${i}`,
    assetId: c.fileName,
    inPoint: c.in,
    outPoint: c.out,
    speed: 1
  }))
  const audioTracks: AudioTrack[] = seq.audio
    .filter((t) => t.length > 0)
    .map((t, ti) => {
      const camera = t.every((c) => videoFiles.has(c.fileName))
      const recording =
        camera ||
        t.every((c) => (c.fileDuration ?? 0) > RECORDING_SEC || videoFiles.has(c.fileName))
      return {
        id: `a${ti}`,
        name: `A${ti + 1}`,
        muted: false,
        volume: 1,
        duckingEnabled: false,
        // 録音のトラックは SE・BGM の集計から外す(カメラの音は周りの音、ほかは声)
        ...(recording ? { multicamSourceId: camera ? 'camera' : 'mic', voice: !camera } : {}),
        clips: t.map((c, ci) => ({
          id: `a${ti}-${ci}`,
          assetId: c.fileName,
          startTime: c.start,
          inPoint: c.in,
          outPoint: c.out,
          ...(c.gain !== undefined ? { volume: c.gain } : {})
        }))
      }
    })
  // 周りの音の音量は、カメラの音のトラックのクリップの音量から(トラック自体は等倍)
  for (const t of audioTracks)
    if (t.multicamSourceId === 'camera' && !t.voice) {
      const gains = t.clips.map((c) => c.volume ?? 1).sort((a, b) => a - b)
      if (gains.length > 0) t.volume = gains[Math.floor(gains.length / 2)]
    }
  return {
    id: `fcp7:${seq.name}`,
    name: seq.name || 'Premiere の完成版',
    aspectRatio: '16:9',
    assets,
    clips,
    audioTracks,
    videoOverlayTracks: [],
    textOverlays: seq.texts.map((t, i) => ({
      id: `t${i}`,
      text: t.text,
      startTime: t.start,
      endTime: t.end,
      style: defaultTextStyle()
    }))
  }
}
