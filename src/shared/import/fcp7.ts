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
  /**
   * ネストしたシーケンスを展開したクリップのうち、**どのカメラを選んだか XML から分からない**もの
   * (マルチカメラのソースシーケンス: 同じ時間に複数のカメラが積まれている)。
   * 時間(採用区間・カット点)は正しいが、カメラは一番上のトラックを仮に入れてある。
   * 値は親のクリップの通し番号(親のクリップの境目がカット点になる)
   */
  angleUnknown?: number
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
  /** 展開したネストしたシーケンスの数と、そのうちカメラが分からなかった(マルチカメラの)数 */
  nested: { count: number; multicam: number }
}

/** 読み取りの文脈(文書の中の、ID で参照されるファイル・シーケンスの定義) */
interface ReadContext {
  files: Map<string, XmlElement>
  sequences: Map<string, XmlElement>
  nested: { count: number; multicam: number }
  /** 親のクリップの通し番号(マルチカメラの展開で使う) */
  nextParent: number
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
function definitionTable(
  root: XmlElement,
  tag: 'file' | 'sequence',
  isDefinition: (el: XmlElement) => boolean
): Map<string, XmlElement> {
  const table = new Map<string, XmlElement>()
  const els = root.getElementsByTagName(tag)
  for (let i = 0; i < els.length; i++) {
    const el = els[i]
    const id = el.getAttribute('id')
    if (id && isDefinition(el) && !table.has(id)) table.set(id, el)
  }
  return table
}

/** ネストを辿る深さの上限(壊れた XML の循環参照で止まらなくならないように) */
const MAX_NEST_DEPTH = 4

/** 区間 [a, b) から、すでに埋まっている区間を除いた残り */
function uncovered(a: number, b: number, covered: readonly [number, number][]): [number, number][] {
  let pieces: [number, number][] = [[a, b]]
  for (const [c, d] of covered)
    pieces = pieces.flatMap(([x, y]): [number, number][] =>
      d <= x || c >= y
        ? [[x, y]]
        : [
            ...(c > x ? [[x, c] as [number, number]] : []),
            ...(d < y ? [[d, y] as [number, number]] : [])
          ]
    )
  return pieces.filter(([x, y]) => y - x > 1e-3)
}

/**
 * ネストしたシーケンスの [inSec, outSec) を、親のタイムラインの startSec からに展開する。
 * 映像は**上のトラックが見える**ので、上から順に、まだ埋まっていない時間だけを取る。
 * 同じ時間に複数のトラックのクリップが重なっていれば、マルチカメラのソース(選んだカメラは XML に無い)とみなす。
 */
function expandNested(
  seqEl: XmlElement,
  kind: 'video' | 'audio',
  inSec: number,
  outSec: number,
  startSec: number,
  ctx: ReadContext,
  parentIndex: number,
  depth: number
): { pieces: Fcp7Clip[]; stacked: boolean } {
  const fps = rateOf(seqEl, 30)
  const media = child(child(seqEl, 'media'), kind)
  if (!media) return { pieces: [], stacked: false }
  // 文脈は複製せずに渡す(通し番号を中と外で共有しないと、別の親のクリップに同じ番号が付き、境目のカット点が消える)
  const tracks = children(media, 'track').map((t) => readTrack(t, fps, ctx, depth + 1))
  const out: Fcp7Clip[] = []
  if (kind === 'audio') {
    for (const t of tracks)
      for (const c of t) {
        const a = Math.max(inSec, c.start)
        const b = Math.min(outSec, c.end)
        if (b - a > 1e-3)
          out.push({
            ...c,
            start: startSec + (a - inSec),
            end: startSec + (b - inSec),
            in: c.in + (a - c.start),
            out: c.in + (b - c.start)
          })
      }
    return { pieces: out, stacked: false }
  }
  // 同じ時間に2本以上のトラックのクリップが重なる = マルチカメラのソース
  let stacked = false
  const covered: [number, number][] = []
  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    for (const c of tracks[ti]) {
      const a = Math.max(inSec, c.start)
      const b = Math.min(outSec, c.end)
      if (b - a <= 1e-3) continue
      const free = uncovered(a, b, covered)
      if (free.length !== 1 || free[0][0] !== a || free[0][1] !== b) stacked = true
      for (const [x, y] of free)
        out.push({
          ...c,
          start: startSec + (x - inSec),
          end: startSec + (y - inSec),
          in: c.in + (x - c.start),
          out: c.in + (y - c.start)
        })
      covered.push([a, b])
    }
  }
  if (stacked) for (const c of out) c.angleUnknown = parentIndex
  return { pieces: out.sort((x, y) => x.start - y.start), stacked }
}

/**
 * つなぎ(トランジション)に掛かるクリップは start / end が -1 になる。補う:
 * - 終わりが分かれば、終わりから素材の長さぶん戻した所が始まり(前のクリップの終わりは
 *   つなぎの「のりしろ」まで含むので、そこを始まりにするとずれる)
 * - 終わりも分からなければ、直前のつなぎの始まり(無ければ直前のクリップの終わり)
 */
function fillTransitionTimes(
  start: number,
  end: number,
  length: number,
  lastTransitionStart: number | null,
  lastEnd: number
): { start: number; end: number } {
  let s = start
  if (!(s >= 0)) s = end >= 0 ? end - length : (lastTransitionStart ?? lastEnd)
  const e = end >= 0 ? end : s + length
  return { start: s, end: e }
}

/** トラックの中の、つなぎの始まり(フレーム)。要素の並び順で、各クリップの直前のものを引けるように */
function transitionStarts(track: XmlElement): Map<XmlElement, number | null> {
  const out = new Map<XmlElement, number | null>()
  let last: number | null = null
  const nodes = track.childNodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as XmlElement
    if (!n || typeof n !== 'object') continue
    if (n.tagName === 'transitionitem') {
      const st = num(child(n, 'start'))
      last = st >= 0 ? st : last
    } else if (n.tagName === 'clipitem' || n.tagName === 'generatoritem') out.set(n, last)
  }
  return out
}

function readTrack(track: XmlElement, fps: number, ctx: ReadContext, depth = 0): Fcp7Clip[] {
  const files = ctx.files
  const out: Fcp7Clip[] = []
  const transitionBefore = transitionStarts(track)
  let lastEnd = 0
  for (const item of children(track, 'clipitem')) {
    if (disabled(item)) continue
    const itemFps = rateOf(item, fps)
    const inF = num(child(item, 'in'))
    const outF = num(child(item, 'out'))
    if (!Number.isFinite(inF) || !Number.isFinite(outF) || outF <= inF) continue
    const { start, end } = fillTransitionTimes(
      num(child(item, 'start')),
      num(child(item, 'end')),
      outF - inF,
      transitionBefore.get(item) ?? null,
      lastEnd * itemFps
    )
    // ネストしたシーケンス(Premiere のマルチカメラもこの形で書き出される)は中身に展開する
    const nestedEl = child(item, 'sequence')
    if (nestedEl) {
      const def = ctx.sequences.get(nestedEl.getAttribute('id') ?? '') ?? nestedEl
      if (depth >= MAX_NEST_DEPTH) continue
      const kind = isAudioTrack(track) ? 'audio' : 'video'
      const parentIndex = ctx.nextParent++
      const { pieces, stacked } = expandNested(
        def,
        kind,
        inF / itemFps,
        outF / itemFps,
        start / itemFps,
        ctx,
        parentIndex,
        depth
      )
      if (kind === 'video') {
        ctx.nested.count++
        // マルチカメラと数えるのは、この入れ子そのものにカメラが積まれているときだけ
        if (stacked) ctx.nested.multicam++
      }
      out.push(...pieces)
      lastEnd = start / itemFps + (outF - inF) / itemFps
      continue
    }
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

/** 音声のトラックか(親の `<audio>` の中にあるか) */
function isAudioTrack(track: XmlElement): boolean {
  const parent = (track as unknown as { parentNode?: XmlElement | null }).parentNode
  return parent?.tagName === 'audio'
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

/** 無効にした(`<enabled>FALSE</enabled>` を直下に持つ)クリップ・文字・トラック */
function disabled(el: XmlElement): boolean {
  return child(el, 'enabled')?.textContent?.trim().toUpperCase() === 'FALSE'
}

/** ステレオを左右に分けたトラックの2本目以降 */
function explodedCopy(track: XmlElement): boolean {
  const i = track.getAttribute('currentExplodedTrackIndex')
  return i !== null && i !== undefined && i !== '' && Number(i) > 0
}

function readTexts(track: XmlElement, fps: number): Fcp7Sequence['texts'] {
  const out: Fcp7Sequence['texts'] = []
  const transitionBefore = transitionStarts(track)
  let lastEnd = 0
  for (const g of children(track, 'generatoritem')) {
    // 使わないことにした(無効にした)文字は読まない。没にした文字で番組の癖を学ばない
    if (disabled(g)) continue
    // 溶けて出る(つなぎの付いた)文字は start / end が -1。クリップと同じく補う
    const inF = num(child(g, 'in'))
    const outF = num(child(g, 'out'))
    const length = outF > inF ? outF - inF : num(child(g, 'duration'))
    const { start, end } = fillTransitionTimes(
      num(child(g, 'start')),
      num(child(g, 'end')),
      Number.isFinite(length) ? length : NaN,
      transitionBefore.get(g) ?? null,
      lastEnd
    )
    if (!(start >= 0) || !(end > start)) continue
    lastEnd = end
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
  const ctx: ReadContext = {
    files: definitionTable(root, 'file', (f) => Boolean(child(f, 'name') || child(f, 'pathurl'))),
    sequences: definitionTable(root, 'sequence', (s) => Boolean(child(s, 'media'))),
    nested: { count: 0, multicam: 0 },
    nextParent: 0
  }
  const media = child(seq, 'media')
  const video: Fcp7Clip[][] = []
  const audio: Fcp7Clip[][] = []
  const texts: Fcp7Sequence['texts'] = []
  for (const track of children(child(media, 'video') ?? seq, 'track')) {
    if (disabled(track)) continue
    video.push(readTrack(track, fps, ctx))
    texts.push(...readTexts(track, fps))
  }
  for (const track of children(child(media, 'audio') ?? seq, 'track')) {
    // Premiere はステレオのトラックを左右2本(currentExplodedTrackIndex 0・1)に分けて書き、
    // どちらにも同じクリップが入る。2本目以降は読まない(数えると SE が2倍になる)
    if (disabled(track) || explodedCopy(track)) continue
    audio.push(readTrack(track, fps, ctx))
  }
  return {
    name: child(seq, 'name')?.textContent?.trim() ?? '',
    fps,
    duration: num(child(seq, 'duration')) / fps || 0,
    video,
    audio,
    texts: texts.sort((a, b) => a.start - b.start),
    nested: ctx.nested
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
