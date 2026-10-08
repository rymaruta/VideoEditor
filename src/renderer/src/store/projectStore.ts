import { carriesVoice, silencedTrack, tracksReplaceAnchorAudio } from '@shared/roughCut/build'
import { FACE_PIP_POSITION, FACE_PIP_SCALE } from '@shared/pipLayout'
import type { CameraRole, TrackRole } from '@shared/ingest/tracks'
import { isImagePath, STILL_DURATION_SEC } from '@shared/mediaExtensions'
import type { AudioEventWindow } from '@shared/events/audioEvents'
import {
  clipTimelineMapping,
  isIdentityMapping,
  mapTimelineRange,
  sourcePieces,
  uncoveredSpans,
  type ClipSpan
} from '@shared/roughCut/follow'
import {
  angleAlternatives,
  coverageOfClips,
  hasOverrides,
  reinsertExtraClips,
  type CameraSeg,
  type CutOverrides,
  type Range
} from '@shared/roughCut/overrides'
import {
  autoTelopKey,
  isManualEdit,
  mergeManualTelops,
  rememberEditedTelops
} from '@shared/telop/manual'
import type { PlacedCg } from '@shared/finish/cg'
import type { PlacedSound } from '@shared/finish/sound'
import type { ColorMatch } from '@shared/color/match'
import type { RoughCut } from '@shared/roughCut/build'
import { toCommon, type MulticamInfo, type MulticamSource } from '@shared/sync/multicam'
import type { TranscriptUtterance } from '@shared/transcript'
import type { MulticamLayout } from '@shared/sync/multicamLayout'
import {
  restyleEditedSpeech,
  restyleOverlays,
  restyleSpeechTelops,
  type TelopStyleDef
} from '@shared/telop/styles'
import { replaceInTelop } from '@shared/telop/srt'
import { create, type StateCreator } from 'zustand'
import { v4 as uuid } from 'uuid'
import { sameProjectContent } from '../lib/projectEquality'
import {
  audioClipDuration,
  buildTimedClips,
  findFreeAudioStart,
  toSourceSeconds
} from '../lib/timelineMath'
import { videoOverlayClipOutPoint } from '../lib/videoOverlay'
import { dropOrphanClips, orphanCleanupMessage } from '../lib/orphanClips'
import { clampBpm } from '../lib/beatGrid'
import { DEFAULT_PROJECT_NAME } from '@shared/fileName'
import { normalizeTextStyle } from '@shared/textStyle'
import { textCanvasSize } from '@shared/resolution'
import type {
  AspectRatio,
  AudioTrack,
  AudioTrackClip,
  AutoEditPattern,
  BeatGrid,
  Clip,
  ClipColorLabel,
  EditTemplate,
  MediaAsset,
  PipPosition,
  EditedTelop,
  Project,
  TextOverlay,
  TextStyle,
  TranscriptWord,
  Transition,
  VideoOverlayClip,
  VideoOverlayTrack
} from '@shared/types'

const MAX_HISTORY = 50
/**
 * クリップを縮められる下限(**素材の秒**)。これ未満だと画面から消えるのに、
 * タイムラインの1本としては残ってしまう。
 *
 * **この数字はここ(書き込み先)にしか置かない。** `applyTrim` が最後に挟み直すので、
 * どの入口から来てもここで守られる。入口側(インスペクタの数値欄・タイムラインのつまみ)は
 * **必ずこれを import する**こと——同じ名前のローカル定数を書き直していたころ、
 * 数値欄は 0.1秒まで縮められるのにつまみは 0.2秒で止まり、さらに 0.1秒のクリップの
 * 左端を掴むと**掴んだ向きと逆へ 0.1秒飛んで伸びていた**(実測: in 2.000 → 1.900)。
 */
export const MIN_CLIP_SOURCE_DURATION = 0.1
/** 言葉の効果音を置く段の数(SE・SE 2・SE 3) */
const KEYWORD_SE_LANES = 3

function assetDurationOf(project: Project, assetId: string): number | undefined {
  return project.assets.find((a) => a.id === assetId)?.duration
}

/**
 * トリムの2点を**素材の中**へ収める。
 *
 * 以前は `Math.max(0, ...)` で**0側だけ**丸めていた。ドラッグは掴む前に素材の尺を
 * 控えているので気づかないが、インスペクタの数値欄は素材より大きい数字をそのまま
 * 通す(`min`/`max` 属性は手入力を止めない)。書き出しは `-ss inPoint -t (out-in)` を
 * 渡すだけなので実尺は素材どまりになり、「タイムラインでは999秒・実際は12秒」という
 * 食い違いが下流を壊す。実測(24秒の本編・12秒のBGM・6秒のPiP)では
 *   - BGM のフェードアウト3秒が 996 秒地点に置かれて**一度も掛からない**
 *   - PiP が素材の終わり(6秒)を過ぎても**最後の1枚のまま24秒まで出続ける**
 * となった。素材が見つからない(オフライン)ときは尺を知りようがないので0側だけ丸める。
 */
/** クリップの速さとして受ける値(書き出し・プレビューが扱える範囲) */
function validSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed >= 0.05 && speed <= 100
}

function clampSourceRange<T extends { inPoint: number; outPoint: number }>(
  clip: T,
  inPoint: number,
  outPoint: number,
  assetDuration: number | undefined
): T {
  const limit =
    typeof assetDuration === 'number' && Number.isFinite(assetDuration) && assetDuration > 0
      ? assetDuration
      : Number.POSITIVE_INFINITY
  // NaN/Infinity(空欄や `e` を打った直後の数値欄)は「値なし」として今の値を残す。
  // ここで通すと Math.min/Math.max がそのまま NaN を返し、クリップが消える。
  let nextOut = Number.isFinite(outPoint) ? outPoint : clip.outPoint
  let nextIn = Number.isFinite(inPoint) ? inPoint : clip.inPoint
  nextOut = Math.min(Math.max(nextOut, 0), limit)
  nextIn = Math.min(Math.max(nextIn, 0), Math.max(0, nextOut - MIN_CLIP_SOURCE_DURATION))
  // 素材そのものが MIN_CLIP_SOURCE_DURATION より短いときは伸ばせないので素材の尺どまり。
  if (nextOut - nextIn < MIN_CLIP_SOURCE_DURATION) {
    nextOut = Math.min(limit, nextIn + MIN_CLIP_SOURCE_DURATION)
  }
  return nextIn === clip.inPoint && nextOut === clip.outPoint
    ? clip
    : { ...clip, inPoint: nextIn, outPoint: nextOut }
}

/**
 * 複製・貼り付けたクリップの「音を消した」印。マルチカムの収録のクリップはマイクのトラックが
 * 声を鳴らす(複製にもマイクの音が付く)ので、消したまま。分離した音で消していたクリップは、
 * 複製には分離した音が付かないので、自分の音を鳴らす
 * (どちらも外していたので、マルチカムの複製でカメラの音とマイクの音が二重に鳴っていた)
 */
function copiedAudioDetached(project: Project, clip: Clip): boolean {
  return (
    clip.audioDetached === true &&
    (project.multicam?.files.some((f) => f.assetId === clip.assetId) ?? false) &&
    // 手で「音声を分離」したマルチカムのクリップ(分離した音が付いている)は、複製に音が付かないので
    // 自分の音を鳴らす(消したままだと無音のクリップになっていた)
    !project.audioTracks.some((t) => t.clips.some((c) => c.linkedClipId === clip.id))
  )
}

/**
 * 本編のクリップの入点・速さを変えたとき、そのクリップに追従するテロップの `linkOffset` を、
 * 同じ中身(素材の同じ時刻)を指すように直す。直さないと、頭を詰めた・速くしたクリップの上で
 * テロップが元の秒数の所に残り、別の中身(次のクリップ)の上に出ていた
 */
function reanchorLinkedOverlays(before: Project, after: Project): Project {
  if (!after.textOverlays.some((o) => o.linkedClipId)) return after
  const oldById = new Map(before.clips.map((c) => [c.id, c]))
  const newById = new Map(after.clips.map((c) => [c.id, c]))
  let changed = false
  const textOverlays = after.textOverlays.map((o) => {
    if (!o.linkedClipId) return o
    const old = oldById.get(o.linkedClipId)
    const nw = newById.get(o.linkedClipId)
    if (!old || !nw) return o
    const oldSpeed = old.speed || 1
    const newSpeed = nw.speed || 1
    if (old.inPoint === nw.inPoint && old.outPoint === nw.outPoint && oldSpeed === newSpeed)
      return o
    // 追従は外さず、範囲でも丸めない(ロールのドラッグは動かすたびに呼ばれるので、行って戻ったときに
    // 元の位置へ戻れるよう、素材の時刻からそのまま計算し直す。クリップの頭より前・後ろに
    // ずらして置いたテロップ(負の・長い linkOffset)もそのまま)
    const source = old.inPoint + (o.linkOffset ?? 0) * oldSpeed
    const linkOffset = (source - nw.inPoint) / newSpeed
    if (!Number.isFinite(linkOffset) || linkOffset === o.linkOffset) return o
    changed = true
    return { ...o, linkOffset }
  })
  return changed ? { ...after, textOverlays } : after
}

function createBlankProject(): Project {
  return {
    id: uuid(),
    name: '新規プロジェクト',
    aspectRatio: '9:16',
    assets: [],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    beatGrid: null
  }
}

/** 配列でなければ空配列。要素は「オブジェクトであること」まで見て、使えない分は捨てる。 */
function asRecordArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is T => typeof v === 'object' && v !== null && !Array.isArray(v))
}

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数値として使える値だけ通す。`'12'` のような文字列も NaN も既定値へ落とす。 */
function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asNonNegative(value: unknown, fallback: number): number {
  return Math.max(0, asFinite(value, fallback))
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 決められた文字列のどれかなら通す。知らない値は既定へ(CSSのクラス名やASSの指定に使うため) */
function asOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

const PIP_POSITIONS: readonly PipPosition[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'full'
]

/**
 * 直す方針は共通で「**指す手段が無いものだけ捨て、あとは使える値に直して残す**」。
 * 数値が壊れているだけのクリップを捨てると、利用者が作ったものが黙って減る。
 * 逆に `assetId` の無いクリップは、どの素材か分からないので画面にも出せない。
 *
 * どの関数も `...raw` を先に広げてから既知の項目だけ上書きする。項目を並べ直すと、
 * ここに書き忘れた任意項目(`fillCrop` / `cropCenter` / `transitionIn` / `colorLabel` など)が
 * **読み込むたびに消える**——直したつもりで別の失い方をする。
 */
function normalizeAsset(raw: Record<string, unknown>): MediaAsset | null {
  if (typeof raw.filePath !== 'string' || raw.filePath === '') return null
  return {
    ...(raw as unknown as MediaAsset),
    id: asNonEmptyString(raw.id, uuid()),
    filePath: raw.filePath,
    fileName: asNonEmptyString(raw.fileName, raw.filePath),
    // 尺0は「まだ分からない」の意味で通す(尺の無い録画物で実際に起きる)。
    duration: asNonNegative(raw.duration, 0),
    width: asNonNegative(raw.width, 0),
    height: asNonNegative(raw.height, 0),
    // fps だけは 0 を通せない。1フレームの秒数が Infinity になり、コマ送りが効かなくなる。
    fps: asFinite(raw.fps, 30) > 0 ? asFinite(raw.fps, 30) : 30,
    hasVideo: asBoolean(raw.hasVideo, true),
    hasAudio: asBoolean(raw.hasAudio, false),
    proxyPath: typeof raw.proxyPath === 'string' ? raw.proxyPath : undefined,
    still: raw.still === true ? true : undefined,
    colorMatch: normalizeColorMatch(raw.colorMatch),
    denoisedFrom:
      typeof raw.denoisedFrom === 'string' && raw.denoisedFrom ? raw.denoisedFrom : undefined,
    proxyBeforeDenoise:
      typeof raw.proxyBeforeDenoise === 'string' && raw.proxyBeforeDenoise && raw.denoisedFrom
        ? raw.proxyBeforeDenoise
        : undefined
  }
}

type SignedTrack = {
  name?: string
  position?: string
  scale?: number
  muted?: boolean
  volume?: number
  duckingEnabled?: boolean
  hidden?: boolean
  clips: {
    assetId: string
    startTime: number
    inPoint: number
    outPoint: number
    volume?: number
    fadeIn?: number
    fadeOut?: number
  }[]
}

/** 前の版の要約(クリップの位置と音量だけ)。前の版で保存したプロジェクトを読むため */
function legacySignatureOf(track: SignedTrack): string {
  return track.clips
    .map((c) => [c.assetId, c.startTime, c.inPoint, c.outPoint, c.volume ?? 1].join(','))
    .join(';')
}

/**
 * 自動の SE・BGM・CG のトラックの中身の要約(手で直したかを見分ける)。
 * トラックの消音・音量・ダッキング・表示、クリップのフェードも入れる(入れないと、BGM を消音しても
 * 「手を付けていない」とみなされ、作り直しで消音していない BGM に戻っていた)
 */
function autoSignatureOf(track: SignedTrack): string {
  // v3: 名前・CG の位置・大きさも入れる(v2 では CG を小さく・隅へ寄せても作り直しで全面に戻った)
  return (
    'v3|' +
    JSON.stringify([track.name ?? '', track.position ?? '', track.scale ?? 1]) +
    '|' +
    signatureV2(track)
  )
}

/** v2 の要約(v2 の印で保存した企画を読むときに比べる) */
function signatureV2(track: SignedTrack): string {
  const head = [
    track.muted ? 1 : 0,
    track.volume ?? 1,
    track.duckingEnabled ? 1 : 0,
    track.hidden ? 1 : 0
  ]
  return (
    'v2|' +
    head.join(',') +
    '|' +
    track.clips
      .map((c) =>
        [
          c.assetId,
          c.startTime,
          c.inPoint,
          c.outPoint,
          c.volume ?? 1,
          c.fadeIn ?? 0,
          c.fadeOut ?? 0
        ].join(',')
      )
      .join(';')
  )
}

/** 自動で置いたまま手を付けていないトラックか(作り直しで入れ替えてよい) */
function isUntouchedAuto(
  track: SignedTrack & { autoRole?: string; autoSignature?: string }
): boolean {
  if (!track.autoRole || track.autoSignature === undefined) return false
  if (track.autoSignature.startsWith('v3|')) return track.autoSignature === autoSignatureOf(track)
  return track.autoSignature.startsWith('v2|')
    ? track.autoSignature === signatureV2(track)
    : track.autoSignature === legacySignatureOf(track)
}

function withAutoSignature<T extends AudioTrack | VideoOverlayTrack>(track: T): T {
  return { ...track, autoSignature: autoSignatureOf(track) }
}

/** 色合わせの値。壊れていれば補正なし(元の色)にする */
function normalizeColorMatch(raw: unknown): ColorMatch | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const triple = (v: unknown): [number, number, number] | null =>
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
      ? (v as [number, number, number])
      : null
  const gain = triple(r.gain)
  const offset = triple(r.offset)
  return gain && offset ? { gain, offset } : undefined
}

/** 素材の秒で持つ区間(本編・音声・PiP に共通)。壊れた尺は素材の尺で埋める */
/** 素材の時刻として読む上限(秒)。100 時間 */
const MAX_SOURCE_TIME = 360000

function normalizeRange(
  raw: Record<string, unknown>,
  assetDuration: number
): { inPoint: number; outPoint: number } {
  // 壊れた巨大な値(1e308)は、最短の長さを足しても丸めで同じ値のままになり長さ0になるので抑える
  const inPoint = Math.min(MAX_SOURCE_TIME, asNonNegative(raw.inPoint, 0))
  // 数値でないときに 0 を入れると、尺0の「画面に出ないのに消せないクリップ」になる。
  let outPoint = asNonNegative(raw.outPoint, assetDuration)
  // 終わりが頭より前(壊れた値)だと、尺が負になってタイムラインの後ろが全部重なる。
  // 素材の終わりまで(尺が分からなければ最短の長さ)にし、素材の尺の中へ収める
  if (outPoint <= inPoint) {
    outPoint = assetDuration > inPoint ? assetDuration : inPoint + MIN_CLIP_SOURCE_DURATION
  } else if (assetDuration > 0 && inPoint < assetDuration && outPoint > assetDuration) {
    // 素材より少し長い(素材をつなぎ直して尺が少し変わったなど)ときは、素材の終わりで止めるだけ。
    // 最短の長さに広げると、頭が前へ動いて後ろの本編が遅れる
    return { inPoint, outPoint: assetDuration }
  } else if (!(assetDuration > 0) || outPoint <= assetDuration + 1e-6) {
    // 正しい区間はそのまま読む。最短の長さに広げると(仮編集がカメラのファイルの切れ目で作る
    // 数フレームのクリップなど)、後ろの本編が全部遅れ、ピンマイクの声・自動の音とずれていた
    return { inPoint, outPoint }
  }
  const r = clampSourceRange({ inPoint, outPoint }, inPoint, outPoint, assetDuration)
  return { inPoint: r.inPoint, outPoint: r.outPoint }
}

function normalizeClip(
  raw: Record<string, unknown>,
  durationOf: (id: string) => number
): Clip | null {
  if (typeof raw.assetId !== 'string' || raw.assetId === '') return null
  const speed = asFinite(raw.speed, 1)
  return {
    ...(raw as unknown as Clip),
    id: asNonEmptyString(raw.id, uuid()),
    assetId: raw.assetId,
    ...normalizeRange(raw, durationOf(raw.assetId)),
    // 速度0は尺が Infinity になる(0除算)。負の速度も再生手段が無い。
    speed: speed > 0 ? speed : 1
  }
}

function normalizeAudioClip(
  raw: Record<string, unknown>,
  durationOf: (id: string) => number
): AudioTrackClip | null {
  if (typeof raw.assetId !== 'string' || raw.assetId === '') return null
  const speed = asFinite(raw.speed, 1)
  return {
    ...(raw as unknown as AudioTrackClip),
    id: asNonEmptyString(raw.id, uuid()),
    assetId: raw.assetId,
    startTime: asNonNegative(raw.startTime, 0),
    ...normalizeRange(raw, durationOf(raw.assetId)),
    volume: raw.volume === undefined ? undefined : asNonNegative(raw.volume, 1),
    speed: raw.speed === undefined ? undefined : speed > 0 ? speed : 1,
    fadeIn: raw.fadeIn === undefined ? undefined : asNonNegative(raw.fadeIn, 0),
    fadeOut: raw.fadeOut === undefined ? undefined : asNonNegative(raw.fadeOut, 0),
    linkedClipId: typeof raw.linkedClipId === 'string' ? raw.linkedClipId : undefined
  }
}

function normalizeVideoOverlayClip(
  raw: Record<string, unknown>,
  durationOf: (id: string) => number
): VideoOverlayClip | null {
  if (typeof raw.assetId !== 'string' || raw.assetId === '') return null
  return {
    ...(raw as unknown as VideoOverlayClip),
    id: asNonEmptyString(raw.id, uuid()),
    assetId: raw.assetId,
    startTime: asNonNegative(raw.startTime, 0),
    ...normalizeRange(raw, durationOf(raw.assetId))
  }
}

function normalizeWords(raw: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const words = asRecordArray<Record<string, unknown>>(raw).map((w) => ({
    ...(w as unknown as TranscriptWord),
    start: asNonNegative(w.start, 0),
    end: asNonNegative(w.end, 0),
    text: typeof w.text === 'string' ? w.text : ''
  }))
  return words.length > 0 ? words : undefined
}

/** テロップの時刻の上限(壊れた 1e308 などで、追従の計算が -1e308 を作らないように)。100 時間 */
const MAX_OVERLAY_TIME = 360000

function normalizeTextOverlay(raw: Record<string, unknown>): TextOverlay {
  const startTime = Math.min(MAX_OVERLAY_TIME, asNonNegative(raw.startTime, 0))
  return {
    ...(raw as unknown as TextOverlay),
    id: asNonEmptyString(raw.id, uuid()),
    text: typeof raw.text === 'string' ? raw.text : '',
    startTime,
    // 終わりが頭より前のテロップは出ない(尺が負)。頭より前へは置かない
    endTime: Math.min(MAX_OVERLAY_TIME, Math.max(startTime, asNonNegative(raw.endTime, startTime))),
    source: asOneOf(raw.source, ['manual', 'auto'] as const, 'manual'),
    style: normalizeTextStyle(raw.style),
    words: normalizeWords(raw.words),
    linkedClipId: typeof raw.linkedClipId === 'string' ? raw.linkedClipId : undefined,
    linkOffset: raw.linkOffset === undefined ? undefined : asFinite(raw.linkOffset, 0),
    speaker: typeof raw.speaker === 'string' && raw.speaker.trim() ? raw.speaker : undefined,
    styleId: typeof raw.styleId === 'string' && raw.styleId ? raw.styleId : undefined
  }
}

function normalizeAudioTrack(
  raw: Record<string, unknown>,
  durationOf: (id: string) => number
): AudioTrack {
  return {
    ...(raw as unknown as AudioTrack),
    id: asNonEmptyString(raw.id, uuid()),
    name: asNonEmptyString(raw.name, '音声トラック'),
    muted: asBoolean(raw.muted, false),
    duckingEnabled: asBoolean(raw.duckingEnabled, false),
    voice: raw.voice === true ? true : undefined,
    autoRole: raw.autoRole === 'se' || raw.autoRole === 'bgm' ? raw.autoRole : undefined,
    autoSignature: typeof raw.autoSignature === 'string' ? raw.autoSignature : undefined,
    autoVolume:
      typeof raw.autoVolume === 'number' && Number.isFinite(raw.autoVolume)
        ? raw.autoVolume
        : undefined,
    volume: asNonNegative(raw.volume, 1),
    clips: asRecordArray<Record<string, unknown>>(raw.clips)
      .map((c) => normalizeAudioClip(c, durationOf))
      .filter((c): c is AudioTrackClip => c !== null)
  }
}

function normalizeVideoOverlayTrack(
  raw: Record<string, unknown>,
  durationOf: (id: string) => number
): VideoOverlayTrack {
  const scale = asFinite(raw.scale, 0.3)
  return {
    ...(raw as unknown as VideoOverlayTrack),
    id: asNonEmptyString(raw.id, uuid()),
    name: asNonEmptyString(raw.name, 'PiP'),
    hidden: asBoolean(raw.hidden, false),
    audioMuted: raw.audioMuted === true ? true : undefined,
    position: asOneOf(raw.position, PIP_POSITIONS, 'top-right'),
    // 0以下だと `scale=0:-2` で書き出しが失敗する。1超は枠からはみ出す。
    scale: scale > 0 && scale <= 1 ? scale : 0.3,
    autoRole: raw.autoRole === 'cg' ? 'cg' : undefined,
    autoSignature: typeof raw.autoSignature === 'string' ? raw.autoSignature : undefined,
    clips: asRecordArray<Record<string, unknown>>(raw.clips)
      .map((c) => normalizeVideoOverlayClip(c, durationOf))
      .filter((c): c is VideoOverlayClip => c !== null)
  }
}

/**
 * ビートグリッド。**BPM は必ず入力欄と同じ範囲(20〜300)へ収める。**
 * ここを素通しにすると、線を引く数が `尺 ÷ (60/BPM)` で青天井になる
 * (実測: BPM 100000 の `.veproj` を開くと線が **50,002本**できて、
 *  開くのに 3,066ms かかった——正常なファイルは 602ms)。
 */
/**
 * この版の知らない項目(新しい版が書いた項目)。読み込みで整えるときに先に広げて残す。
 * 知っている項目は外す(形の崩れた値が、整えた値の代わりに残らないように)
 */
function unknownFields(
  raw: Record<string, unknown>,
  known: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!known.includes(k)) out[k] = v
  return out
}

function normalizeBeatGrid(raw: unknown): BeatGrid | null {
  if (!isRecord(raw)) return null
  const bpm = asFinite(raw.bpm, 0)
  if (bpm <= 0) return null
  return {
    ...unknownFields(raw, ['bpm', 'offsetSeconds', 'enabled', 'sourceLabel']),
    bpm: clampBpm(bpm),
    offsetSeconds: asFinite(raw.offsetSeconds, 0),
    enabled: asBoolean(raw.enabled, false),
    sourceLabel: typeof raw.sourceLabel === 'string' ? raw.sourceLabel : ''
  }
}

/**
 * 読み込んだプロジェクトを、**この先のコードが前提にしている形**に整える。
 *
 * `.veproj` は利用者が持ち歩いて共有し、手で編集もできる**外から来た JSON**。
 * 古い版のアプリが別の形で書いていることもあるし、書き込み途中で壊れることもある。
 * `JSON.parse` が通ったことは「期待した形」を何も保証しない。
 *
 * 以前は `project.clips ?? []` のように **null と undefined しか見ていなかった**ため、
 * `"clips": "こわれた"` のような**型違い**はそのまま state に入った。
 * 実測: `clips` が文字列の `.veproj` を開くと**タイムラインのパネルごと画面から消え、
 * しかもメッセージは何も出ない**。そのあと正しいファイルを開き直しても戻らず、
 * アプリを再起動するまで編集できなくなった。
 *
 * `loadProjectFile` は**一番外側**が object かどうかだけ確かめている(同じ理由で足された)。
 * ここはその続きで、**中身の型**を見る。配列の要素も、オブジェクトでないものは捨てる——
 * `null` が1つ混ざるだけで `clips.map((c) => c.id)` が落ちるため。
 *
 * **検査は一段で止めない。** 以前はここまで(一番外側の配列と「要素がオブジェクトか」)
 * だったため、**その中**は誰も見ていなかった。実測(実機で開く):
 * - テロップに `style` が無いファイル → 開いた瞬間に**アプリ全体がエラー画面**
 *   (`Cannot read properties of undefined (reading 'position')`)。タイムラインも消え、
 *   再読み込みするまで編集できない。
 * - 音声トラックの `clips` が文字列のファイル → `t.clips.filter is not a function` という
 *   **生の英語**が画面に出て、**開けないまま前のプロジェクトが残る**。
 * - ビートグリッドの BPM が 100000 のファイル → 線を **50,002本**引いて開くのに 3,066ms。
 */
/**
 * 同じ id が2つあると、紐づく音声・テロップが別のクリップに合わせて動く(片方の時刻へ飛ぶ)。
 * 後から出てきた方に新しい id を振る(紐づけは最初のものを指したまま)
 */
function uniqueIds<T extends { id: string }>(items: T[], seen: Set<string>): T[] {
  return items.map((it) => {
    if (!seen.has(it.id)) {
      seen.add(it.id)
      return it
    }
    const id = uuid()
    seen.add(id)
    return { ...it, id }
  })
}

function dedupeLoadedIds(p: Project): Project {
  const clipIds = new Set<string>()
  const trackIds = new Set<string>()
  return {
    ...p,
    assets: uniqueIds(p.assets, new Set()),
    // 本編・音声・PiP のクリップは、紐づけ(linkedClipId)で互いを指すので同じ集まりで見る
    clips: uniqueIds(p.clips, clipIds),
    audioTracks: uniqueIds(p.audioTracks, trackIds).map((t) => ({
      ...t,
      clips: uniqueIds(t.clips, clipIds)
    })),
    videoOverlayTracks: uniqueIds(p.videoOverlayTracks, trackIds).map((t) => ({
      ...t,
      clips: uniqueIds(t.clips, clipIds)
    })),
    textOverlays: uniqueIds(p.textOverlays, new Set())
  }
}

function normalizeLoadedProject(project: Project): Project {
  return dedupeLoadedIds(normalizeLoadedProjectFields(project))
}

function normalizeLoadedProjectFields(project: Project): Project {
  const raw = project as unknown as Record<string, unknown>
  const assets = asRecordArray<Record<string, unknown>>(raw.assets)
    .map(normalizeAsset)
    .filter((a): a is MediaAsset => a !== null)
  // 壊れた尺を埋めるのに使う。素材を先に整えてから、それを見てクリップを整える。
  // 同じ ID の素材が2つあれば、ID を持ち続けるのは先の方(`dedupeLoadedIds` が後の方に新しい ID を
  // 付ける)。後の方の尺で縮めると、先の素材を指すクリップが黙って短くなる
  const durationById = new Map<string, number>()
  for (const a of assets) if (!durationById.has(a.id)) durationById.set(a.id, a.duration)
  const durationOf = (assetId: string): number => durationById.get(assetId) ?? 0
  return {
    // 知らない項目(新しい版で足した項目)も残す。消すと、古い版で保存したときに新しい版のデータが消える
    ...(raw as Partial<Project>),
    id: asNonEmptyString(raw.id, uuid()),
    name: asNonEmptyString(raw.name, '無題のプロジェクト'),
    // 知っている2つ以外は既定へ。画面の切り替えもこの値を見る。
    aspectRatio:
      raw.aspectRatio === '16:9' || raw.aspectRatio === '9:16' ? raw.aspectRatio : '9:16',
    assets,
    clips: asRecordArray<Record<string, unknown>>(raw.clips)
      .map((c) => normalizeClip(c, durationOf))
      .filter((c): c is Clip => c !== null),
    audioTracks: asRecordArray<Record<string, unknown>>(raw.audioTracks).map((t) =>
      normalizeAudioTrack(t, durationOf)
    ),
    videoOverlayTracks: asRecordArray<Record<string, unknown>>(raw.videoOverlayTracks).map((t) =>
      normalizeVideoOverlayTrack(t, durationOf)
    ),
    textOverlays: asRecordArray<Record<string, unknown>>(raw.textOverlays).map(
      normalizeTextOverlay
    ),
    beatGrid: normalizeBeatGrid(raw.beatGrid),
    transcript: normalizeTranscript(raw.transcript),
    multicam: normalizeMulticam(raw.multicam),
    reviewed: asStringArray(raw.reviewed),
    dismissedTelops: asStringArray(raw.dismissedTelops),
    editedTelops: normalizeEditedTelops(raw.editedTelops),
    roughCutAuto: normalizeSegs(raw.roughCutAuto, true) as CameraSeg[] | undefined,
    cutOverrides: normalizeOverrides(raw.cutOverrides),
    audioEvents: Array.isArray(raw.audioEvents)
      ? (raw.audioEvents as unknown[]).filter(
          (e): e is AudioEventWindow =>
            Boolean(e) &&
            typeof e === 'object' &&
            ['start', 'end', 'laugh', 'cheer'].every((k) =>
              Number.isFinite((e as Record<string, unknown>)[k])
            )
        )
      : undefined
  }
}

/** 区間の並び(壊れた要素は捨てる)。`camera` なら cameraId も要る */
function normalizeSegs(raw: unknown, camera: boolean): (Range | CameraSeg)[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw
    .filter(
      (r): r is Record<string, unknown> =>
        Boolean(r) &&
        typeof r === 'object' &&
        Number.isFinite((r as Record<string, unknown>).start) &&
        Number.isFinite((r as Record<string, unknown>).end) &&
        (!camera || typeof (r as Record<string, unknown>).cameraId === 'string')
    )
    .map((r) => ({
      ...unknownFields(r, ['start', 'end', 'cameraId']),
      start: r.start as number,
      end: r.end as number,
      ...(camera ? { cameraId: r.cameraId as string } : {})
    }))
  return out
}

function normalizeOverrides(raw: unknown): CutOverrides | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const o: CutOverrides = {
    ...unknownFields(r, ['removed', 'added', 'angles']),
    removed: (normalizeSegs(r.removed, false) as Range[] | undefined) ?? [],
    added: (normalizeSegs(r.added, false) as Range[] | undefined) ?? [],
    angles: (normalizeSegs(r.angles, true) as CameraSeg[] | undefined) ?? []
  }
  return hasOverrides(o) ? o : undefined
}

function asStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const v = raw.filter((x): x is string => typeof x === 'string')
  return v.length > 0 ? v : undefined
}

/** 自動テロップを消したら、その鍵を覚える(作り直しで足し直さない) */
function withDismissed(
  list: string[] | undefined,
  removed: TextOverlay | undefined
): string[] | undefined {
  const key = removed ? autoTelopKey(removed) : null
  if (!key) return list
  return [...new Set([...(list ?? []), key])]
}

function normalizeMulticam(raw: unknown): MulticamInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.anchorSourceId !== 'string') return undefined
  const sources = asRecordArray<Record<string, unknown>>(r.sources)
    .filter(
      (s) =>
        typeof s.id === 'string' && (s.kind === 'camera' || s.kind === 'mic' || s.kind === 'audio')
    )
    .map((s) => ({
      ...unknownFields(s, ['id', 'name', 'kind', 'subject', 'trackRole', 'trackOf', 'cameraRole']),
      id: s.id as string,
      name: typeof s.name === 'string' ? s.name : '',
      kind: s.kind as 'camera' | 'mic' | 'audio',
      subject: typeof s.subject === 'string' && s.subject ? s.subject : undefined,
      ...(s.trackRole === 'voice' ||
      s.trackRole === 'call' ||
      s.trackRole === 'game' ||
      s.trackRole === 'mix'
        ? { trackRole: s.trackRole as TrackRole }
        : {}),
      ...(typeof s.trackOf === 'string' && s.trackOf ? { trackOf: s.trackOf } : {}),
      ...(s.cameraRole === 'screen' || s.cameraRole === 'face'
        ? { cameraRole: s.cameraRole as CameraRole }
        : {})
    }))
  const files = asRecordArray<Record<string, unknown>>(r.files)
    .filter((f) => typeof f.assetId === 'string' && typeof f.sourceId === 'string')
    .map((f) => ({
      ...unknownFields(f, ['assetId', 'sourceId', 'start', 'rate', 'duration', 'recordedAt']),
      assetId: f.assetId as string,
      sourceId: f.sourceId as string,
      start: asFinite(f.start, 0),
      rate: asFinite(f.rate, 1) > 0 ? asFinite(f.rate, 1) : 1,
      duration: asNonNegative(f.duration, 0),
      ...(typeof f.recordedAt === 'number' && Number.isFinite(f.recordedAt)
        ? { recordedAt: f.recordedAt }
        : {})
    }))
  return {
    ...unknownFields(r, ['anchorSourceId', 'sources', 'files']),
    anchorSourceId: r.anchorSourceId,
    sources,
    files
  }
}

/** 文字起こしは作り直せる結果なので、形の崩れたものは黙って捨てる(企画を開けなくするより良い) */
function normalizeTranscript(raw: unknown): TranscriptUtterance[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TranscriptUtterance[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r !== 'object' || r === null) continue
    if (typeof r.assetId !== 'string' || typeof r.text !== 'string') continue
    const start = asFinite(r.sourceStart, NaN)
    const end = asFinite(r.sourceEnd, NaN)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const words = Array.isArray(r.words)
      ? (r.words as Record<string, unknown>[])
          .filter((w) => w && typeof w.text === 'string')
          .map((w) => ({
            ...unknownFields(w, ['text', 'start', 'end']),
            text: w.text as string,
            start: asFinite(w.start, start),
            end: asFinite(w.end, end)
          }))
      : []
    out.push({
      ...unknownFields(r, [
        'id',
        'assetId',
        'speaker',
        'sourceStart',
        'sourceEnd',
        'text',
        'words',
        'overlap'
      ]),
      id: asNonEmptyString(r.id, uuid()),
      assetId: r.assetId,
      speaker: typeof r.speaker === 'string' && r.speaker ? r.speaker : undefined,
      sourceStart: start,
      sourceEnd: end,
      text: r.text,
      words,
      overlap: r.overlap === true
    })
  }
  return out
}

interface ProjectState {
  project: Project
  past: Project[]
  future: Project[]
  /**
   * `pushHistory` が付ける目印。**この印が付いた書き込みだけ**が
   * 「中身が変わっていなければ捨てる」関門(`skipNoOpHistory`)を通る。
   * 関門が必ず剥がすので、ストアの中に残ることはない。
   */
  __historyPush?: true
  /**
   * 本編を丸ごと組み直す書き込み(仮編集を入れる・同期の結果を並べる)の印。声・テロップも
   * 同時に新しい位置で入るので、本編に付いていかせる処理(`followMainEdit`)を通さない
   */
  __noFollow?: true
  currentFilePath: string | null
  isDirty: boolean
  selectedClipId: string | null
  multiSelectedClipIds: string[]
  /**
   * 選んでいるテロップ。タイムライン・テロップ一覧・インスペクタが同じものを見る。
   * 履歴には積まない(取り消しで消えたテロップを指していたら、読む側が「選択なし」と扱う)。
   */
  selectedOverlayId: string | null
  clipboardClips: Clip[]
  playheadTime: number
  isPlaying: boolean
  seekRequest: { time: number; token: number } | null
  /**
   * 実在しないと分かっている素材の**パス**。
   *
   * 印を「素材ID」だけで持つと、取り消しでパスが実在しないものに戻っても印が戻らない
   * (履歴のスナップショットは `project` しか持っていないため)。**実在しないのはパス**
   * なので、パスで覚えておいて、そのつどいまの `project` から ID を導く。
   */
  missingAssetPaths: string[]
  /** `missingAssetPaths` といまの `project` から導いた、印を付ける素材のID */
  missingAssetIds: string[]
  saveError: string | null

  // Source viewer (DaVinci-style two-up): the asset being auditioned and the range
  // marked on it. Transient UI state — never written to the project file.
  sourceAssetId: string | null
  sourceIn: number | null
  sourceOut: number | null
  /**
   * メディアパネルから引きずっている素材のID。
   *
   * ドラッグ中に `dataTransfer` の中身は読めない(仕様上、読めるのは drop のときだけ)ので、
   * 「この素材は映像を持つか/音を持つか」をタイムライン側が知る手段がこれしかない。
   * 置けるトラックだけを光らせるのに使う。編集内容ではないのでプロジェクトには保存しない。
   */
  draggingAssetId: string | null
  setDraggingAssetId: (assetId: string | null) => void
  openInSourceViewer: (assetId: string) => void
  closeSourceViewer: () => void
  setSourceIn: (t: number | null) => void
  setSourceOut: (t: number | null) => void

  setSaveError: (message: string | null) => void
  newProject: () => void
  loadProject: (project: Project, filePath: string) => void
  restoreAutosave: (project: Project) => void
  /**
   * 保存が終わったことを記録する。`savedProject` には**実際にディスクへ書いた企画**を
   * 渡すこと(保存中に編集が入ったかどうかの判定に使う)。
   */
  markSaved: (filePath: string, savedProject: Project) => void
  /** プロジェクト名を変える。空白だけなら既定名に戻す */
  setProjectName: (name: string) => void

  /** 実在確認の結果(見つからなかったパス)を入れる。IDはここから導く */
  setMissingAssetPaths: (paths: string[]) => void
  relinkAsset: (
    assetId: string,
    filePath: string,
    fileName: string,
    probe: {
      duration: number
      width: number
      height: number
      fps: number
      hasAudio: boolean
      hasVideo: boolean
    },
    thumbnailDataUrl: string | undefined
  ) => void

  addAsset: (asset: MediaAsset) => void
  addAssets: (assets: MediaAsset[]) => void
  /**
   * 同期した収録素材をまとめて入れる(素材の追加 + 本編・PiP・音声トラック)。取り消し1回で全部戻る。
   * 並べ方は `@shared/sync/multicamLayout`。`assetIdOf` は素材のファイル(同期の ID)→ 素材 ID。
   */
  addMulticamTimeline: (
    assets: MediaAsset[],
    layout: MulticamLayout,
    assetIdOf: Record<string, string>,
    /** 基準カメラに合わせた縦横比(指定すればプロジェクトの縦横比も同じ1回の操作で変える) */
    aspectRatio?: AspectRatio,
    /** 機材の名前・役割(企画に残す。仮編集の作り直しに使う) */
    sources?: MulticamSource[]
  ) => void
  setAssetProxyPath: (assetId: string, proxyPath: string) => void
  removeAsset: (assetId: string) => void
  addAudioClipWithAsset: (
    asset: MediaAsset,
    /** `startTime` を渡すとその位置(空いていなければ直後)へ、省略するとトラック末尾へ置く */
    target: { trackId?: string; trackName: string; startTime?: number }
  ) => void
  /** `index` を渡すとその位置へ挿入する(省略時は末尾に足す) */
  addClipToTimeline: (assetId: string, index?: number) => void
  /** `index` を渡すとその位置へ挿入する(省略時は末尾に足す) */
  addTrimmedClipToTimeline: (
    assetId: string,
    inPoint: number,
    outPoint: number,
    index?: number
  ) => void
  insertClipAtTime: (assetId: string, inPoint: number, outPoint: number, atTime: number) => void
  overwriteClipAtTime: (assetId: string, inPoint: number, outPoint: number, atTime: number) => void
  updateClipTrim: (clipId: string, inPoint: number, outPoint: number) => void
  rollTrim: (leftClipId: string, rightClipId: string, deltaSeconds: number) => void
  updateClipSpeed: (clipId: string, speed: number) => void
  updateClipTransition: (clipId: string, transition: Transition | undefined) => void
  detachClipAudio: (clipId: string) => void
  reattachClipAudio: (clipId: string) => void
  updateClipCrop: (clipId: string, fillCrop: boolean, cropCenter?: { x: number; y: number }) => void
  /** トリムモーダルの「適用」1回分。トリムとクロップをまとめて履歴1件で適用する */
  applyClipTrimAndCrop: (
    clipId: string,
    inPoint: number,
    outPoint: number,
    fillCrop: boolean,
    cropCenter?: { x: number; y: number }
  ) => void
  /** 余白を黒帯ではなくぼかし背景で埋めるかどうか */
  updateClipBlurBackground: (clipId: string, blurBackground: boolean) => void
  replaceClipRange: (clipId: string, newClips: Clip[]) => void
  /** 複数クリップの置き換えをまとめて1件の履歴で適用する(一括無音カット) */
  replaceClipRanges: (replacements: { clipId: string; newClips: Clip[] }[]) => void
  splitClipAtTime: (clipId: string, absoluteTime: number) => void
  removeClip: (clipId: string) => void
  removeClips: (clipIds: string[]) => void
  duplicateClips: (clipIds: string[]) => void
  updateClipsSpeed: (clipIds: string[], speed: number) => void
  /** 分類用の色ラベルを付ける。`label` が undefined なら外す */
  updateClipsColorLabel: (clipIds: string[], label: ClipColorLabel | undefined) => void
  moveClip: (clipId: string, direction: 'left' | 'right') => void
  moveClipToIndex: (clipId: string, targetIndex: number) => void
  setAspectRatio: (ratio: AspectRatio) => void
  selectClip: (clipId: string | null) => void
  setMultiSelectedClipIds: (clipIds: string[]) => void
  setPlayheadTime: (t: number) => void
  setIsPlaying: (p: boolean) => void
  /** 再生/一時停止の切り替え。末尾で止まっているときは先頭へ戻して再生し直す */
  togglePlayback: () => void
  seekTo: (t: number) => void

  copySelectedClip: () => void
  pasteClip: () => void

  undo: () => void
  redo: () => void

  /** 足したテロップの ID を返す(足した直後に選ぶため) */
  addTextOverlay: (overlay: Omit<TextOverlay, 'id'>) => string
  addTextOverlays: (overlays: Omit<TextOverlay, 'id'>[]) => void
  /**
   * テロップの文字を一括で置き換える(検索と置換)。`ids` を渡すとそのテロップだけ。
   * 置き換えた本数を返す。自動テロップは「人が直した」印を付ける(作り直しで戻さない)
   */
  replaceTelopText: (
    query: string,
    replacement: string,
    options?: { loose?: boolean; ids?: readonly string[] }
  ) => number
  updateTextOverlay: (id: string, patch: Partial<TextOverlay>) => void
  /** 選んだテロップのスタイルをまとめて更新する。何件でも履歴は1件 */
  updateTextOverlaysStyle: (ids: string[], patch: Partial<TextStyle>) => void
  /** クリップへの追従を設定/解除する。`clipId` が null なら解除 */
  setTextOverlayLink: (id: string, clipId: string | null) => void
  removeTextOverlay: (id: string) => void
  selectOverlay: (id: string | null) => void
  /** テロップスタイルの一覧を新しくしたとき、使っているテロップへ反映する(取り消しは1回で戻る) */
  restyleTextOverlays: (styles: readonly TelopStyleDef[]) => void
  /** 自動の発言テロップの見た目を選び直す(前の見た目のままの枚だけ。取り消せる) */
  restyleSpeechTelops: (
    prev: { style: TextStyle; styleId?: string },
    next: { style: TextStyle; styleId?: string },
    styles: readonly TelopStyleDef[]
  ) => number
  /** 要確認の項目を「このままでよい」にする/戻す(プロジェクトに保存する) */
  setReviewed: (key: string, reviewed: boolean) => void
  /** 本編のクリップを、同じ時間の別のカメラに替える(同期した収録素材のクリップだけ) */
  switchClipAngle: (clipId: string, sourceId: string) => void
  /** 消した自動テロップを、また置けるようにする(演出テロップを選び直したとき) */
  undismissTelops: (keys: string[]) => void
  /** カメラ間の色合わせを素材に付ける(undefined で外す)。まとめて1操作=履歴1件 */
  setColorMatches: (matches: Record<string, ColorMatch | undefined>) => void
  /**
   * 音声の素材を、ノイズを除いた音声に差し替える(パス)/ 元の録音へ戻す(null)。
   * `history: false` は開いたときの自動の戻し(利用者の操作ではない)。
   */
  setAssetsDenoised: (
    changes: Record<string, string | null>,
    options?: { history?: boolean }
  ) => void
  /**
   * 仮編集(構成・カット・アングル)を入れる。本編・同期で作ったトラック・発言テロップを入れ替え、
   * 手で足したトラック・テロップには触れない。取り消し1回で戻る
   */
  applyRoughCut: (
    cut: RoughCut,
    telops: Omit<TextOverlay, 'id'>[],
    overrides?: CutOverrides
  ) => void
  /** 演出テロップ(提案から置いたもの)を入れ替える(取り消し1回で戻る) */
  /**
   * 演出テロップを入れ替える。`speech` を渡すと、その発言の発言テロップも入れ替える
   * (吹き出しにした発言は発言テロップを外し、吹き出しをやめたら戻す。1回の取り消しで両方戻る)
   */
  setEffectTelops: (
    telops: Omit<TextOverlay, 'id'>[],
    speech?: { utteranceId: string; telops: Omit<TextOverlay, 'id'>[] },
    /** 手で消した印を外すもの(選び直した提案)。同じ1回の取り消しで戻る */
    undismiss?: string[]
  ) => void
  /**
   * 自動の SE・BGM のトラックを入れ替える(前に自動で置いたものは消える)。素材が無ければ足す。
   * 仮編集を入れた直後に続けて呼ぶので履歴は積まない(取り消し1回で仮編集の前に戻る)。
   */
  setAutoSounds: (
    sounds: { role: 'se' | 'bgm'; clips: PlacedSound[] }[],
    assets: MediaAsset[]
  ) => void
  /** 自動の版面CG のトラックを入れ替える(`setAutoSounds` と同じく履歴は積まない) */
  setAutoCg: (clips: PlacedCg[], assets: MediaAsset[]) => void
  /** 文字起こしの結果を入れ替える(取り消し1回で戻る) */
  setTranscript: (transcript: TranscriptUtterance[]) => void
  /** 笑い・歓声の検出結果を入れ替える(解析の結果なので履歴は積まない) */
  setAudioEvents: (events: AudioEventWindow[]) => void
  shiftAllTextOverlays: (deltaSeconds: number) => void

  addAudioTrack: (name: string) => void
  removeAudioTrack: (trackId: string) => void
  toggleAudioTrackMute: (trackId: string) => void
  toggleAudioTrackDucking: (trackId: string) => void
  setAudioTrackVolume: (trackId: string, volume: number) => void
  addClipToAudioTrack: (trackId: string, assetId: string) => void
  updateAudioClipStart: (trackId: string, clipId: string, startTime: number) => void
  /** 音声クリップを別の音声トラックへ移す(位置も同時に決める)。1操作=履歴1件 */
  moveAudioClipToTrack: (
    fromTrackId: string,
    clipId: string,
    toTrackId: string,
    startTime: number
  ) => void
  updateAudioClipTrim: (trackId: string, clipId: string, inPoint: number, outPoint: number) => void
  updateAudioClipStartAndTrim: (
    trackId: string,
    clipId: string,
    startTime: number,
    inPoint: number,
    outPoint: number
  ) => void
  updateAudioClipVolume: (trackId: string, clipId: string, volume: number) => void
  /** フェードイン/アウトの秒数(タイムライン上の秒)。クリップ尺を超える分は書き出し側で丸める */
  updateAudioClipFade: (trackId: string, clipId: string, fadeIn: number, fadeOut: number) => void
  unlinkAudioClip: (trackId: string, clipId: string) => void
  swapAudioClipAsset: (trackId: string, clipId: string, assetId: string, outPoint: number) => void
  removeAudioClip: (trackId: string, clipId: string) => void
  splitAudioClipAtTime: (trackId: string, clipId: string, absoluteTime: number) => void
  addKeywordSeClips: (
    placements: { assetId: string; startTime: number; outPoint: number; volume: number }[],
    newAssets?: MediaAsset[]
  ) => void

  addVideoOverlayTrack: (name: string) => void
  removeVideoOverlayTrack: (trackId: string) => void
  toggleVideoOverlayTrackHidden: (trackId: string) => void
  /** ワイプの音だけを鳴らす/鳴らさない(絵はそのまま) */
  toggleVideoOverlayTrackAudio: (trackId: string) => void
  setVideoOverlayTrackPosition: (trackId: string, position: PipPosition) => void
  setVideoOverlayTrackScale: (trackId: string, scale: number) => void
  /** `startTime` を渡すとその位置へ、省略するとトラック末尾へ置く */
  addClipToVideoOverlayTrack: (trackId: string, assetId: string, startTime?: number) => void
  updateVideoOverlayClipStart: (trackId: string, clipId: string, startTime: number) => void
  /** PiPクリップを別の動画トラックへ移す(位置も同時に決める)。1操作=履歴1件 */
  moveVideoOverlayClipToTrack: (
    fromTrackId: string,
    clipId: string,
    toTrackId: string,
    startTime: number
  ) => void
  updateVideoOverlayClipTrim: (
    trackId: string,
    clipId: string,
    inPoint: number,
    outPoint: number
  ) => void
  updateVideoOverlayClipStartAndTrim: (
    trackId: string,
    clipId: string,
    startTime: number,
    inPoint: number,
    outPoint: number
  ) => void
  swapVideoOverlayClipAsset: (
    trackId: string,
    clipId: string,
    assetId: string,
    outPoint: number
  ) => void
  removeVideoOverlayClip: (trackId: string, clipId: string) => void
  splitVideoOverlayClipAtTime: (trackId: string, clipId: string, absoluteTime: number) => void

  setBeatGrid: (grid: BeatGrid) => void
  updateBeatGrid: (patch: Partial<BeatGrid>, coalesceKey?: string) => void
  clearBeatGrid: () => void
  toggleBeatGridEnabled: () => void

  applyTemplate: (template: EditTemplate) => void
  autoCutFromCandidates: (
    picks: { assetId: string; start: number; end: number }[],
    template: EditTemplate
  ) => void
  addRoughCutClips: (picks: { assetId: string; start: number; end: number }[]) => void
  applyShortPlan: (
    picks: { assetId: string; start: number; end: number; transitionIn?: Transition }[],
    overlays: Omit<TextOverlay, 'id'>[]
  ) => void
  applyAutoEditPattern: (pattern: AutoEditPattern) => void
}

function totalDuration(project: Project): number {
  return project.clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint) / (c.speed || 1), 0)
}

function audioTrackEnd(track: AudioTrack): number {
  return track.clips.reduce((max, c) => Math.max(max, c.startTime + audioClipDuration(c)), 0)
}

function videoOverlayTrackEnd(track: Project['videoOverlayTracks'][number]): number {
  return track.clips.reduce((max, c) => Math.max(max, c.startTime + (c.outPoint - c.inPoint)), 0)
}

// Detached audio that is still linked belongs to its clip, so it goes with it —
// leaving it behind would keep playing the deleted clip's dialogue over whatever
// footage slid into that spot. Audio the user has since edited is already
// unlinked and is therefore left alone.
function removeLinkedAudioFor(
  audioTracks: AudioTrack[],
  removedClipIds: Set<string>
): AudioTrack[] {
  if (!audioTracks.some((t) => t.clips.some((c) => c.linkedClipId))) return audioTracks
  return audioTracks.map((t) => {
    const clips = t.clips.filter((c) => !c.linkedClipId || !removedClipIds.has(c.linkedClipId))
    return clips.length === t.clips.length ? t : { ...t, clips }
  })
}

/**
 * 1本の音声クリップが複数の断片に割れたとき、**フェードを配り直す**。
 *
 * 断片は `{ ...c }` で作るので、何もしないと**フェードイン・フェードアウトが全部の断片へ
 * 複製される**。すると切れ目ごとに音が落ちてまた上がる——**続きの音として鳴っていたものが、
 * 割った瞬間に途切れる。** 全体の出入りを変えないよう、**先頭にフェードインだけ・
 * 末尾にフェードアウトだけ**を残し、間の断片からは両方外す。
 *
 * (実測: 10秒の分離音声にフェードイン2秒・フェードアウト3秒を付けて 5.0秒でカミソリを
 *  入れると、書き出した音の実効値が平坦部 **0.1245 に対し 4.75秒地点で 0.0060**
 *  ——**-26.3 dB まで落ちてから鳴り直していた**。無音カットで3断片に割ると
 *  同じ落ち込みが **3回**繰り返される)
 *
 * **並びはタイムライン順であること。** 先頭・末尾を位置で決めているので、順不同で渡すと
 * フェードが別の断片に付く。
 */
function splitFades<T extends { fadeIn?: number; fadeOut?: number }>(pieces: T[]): T[] {
  if (pieces.length <= 1) return pieces
  const last = pieces.length - 1
  return pieces.map((p, i) => ({
    ...p,
    fadeIn: i === 0 ? p.fadeIn : undefined,
    fadeOut: i === last ? p.fadeOut : undefined
  }))
}

// Deleting a detached-audio clip (or the whole track it sits on) has to hand the
// audio back to its source clip. `audioDetached` only means "this clip's audio is
// playing from a separate track"; once that track is gone the flag is a dead end —
// the clip exports in digital silence, 音声を分離 is a no-op because it refuses to
// run on an already-detached clip, and speed changes stay blocked. The audio was
// unrecoverable except by undo.
// Only removal clears the flag. Severing a link while the audio clip lives on
// (dragging it, swapping its asset, the jump-cut recut) must keep the clip muted,
// otherwise its embedded audio plays on top of the still-present separated track.
function reattachClipsWithoutLinkedAudio(project: Project, unlinkedClipIds: string[]): Project {
  if (unlinkedClipIds.length === 0) return project
  const stillLinked = new Set(
    project.audioTracks.flatMap((t) => t.clips.map((c) => c.linkedClipId).filter(Boolean))
  )
  const orphaned = new Set(unlinkedClipIds.filter((id) => !stillLinked.has(id)))
  if (orphaned.size === 0) return project
  let changed = false
  const clips = project.clips.map((c) => {
    if (!orphaned.has(c.id) || !c.audioDetached) return c
    changed = true
    return { ...c, audioDetached: false }
  })
  return changed ? { ...project, clips } : project
}

// Continuous controls (typing in a caption, dragging a volume/size slider) fire an
// action per keystroke or per pixel. Without coalescing, typing a 30-character
// caption pushed 30 history entries and blew away the 50-entry undo history, and
// one undo only removed a single character. Consecutive edits carrying the same
// key within COALESCE_MS fold into the entry that opened the burst, so undo
// returns to the state from before the user started editing that field.
const COALESCE_MS = 700
let lastCoalesceKey: string | null = null
let lastCoalesceAt = 0

/** ドラッグ中の操作の目印。押してから離すまでは、手を止めた時間に関わらず1件にまとめる */
let gestureKey: string | null = null

function resetHistoryCoalescing(): void {
  lastCoalesceKey = null
}

/**
 * ドラッグの始まり・終わり。ドラッグは動かした分だけ操作を書き込むので、時間だけでまとめると、
 * 0.7 秒より長く手を止めたところで履歴が分かれ、1回の取り消しがドラッグの途中へ戻っていた
 */
export function beginHistoryGesture(key: string): void {
  gestureKey = key
  lastCoalesceKey = null
}
export function endHistoryGesture(): void {
  gestureKey = null
}

/**
 * まとめ判定の目印を控える／戻す。
 *
 * `pushHistory` は呼ばれた時点で「この burst の起点はここ」と目印を書き換えるが、
 * その書き込みは下の `skipNoOpHistory` で**丸ごと落とされる**ことがある
 * (いまと同じ中身だったとき)。落としたぶんの目印を残すと、**次に来た本物の
 * 書き込みが「起点はもう積んである」と思い込んで、履歴を1件も積まない**。
 */
function historyCoalescingMark(): { key: string | null; at: number } {
  return { key: lastCoalesceKey, at: lastCoalesceAt }
}

function restoreHistoryCoalescing(mark: { key: string | null; at: number }): void {
  lastCoalesceKey = mark.key
  lastCoalesceAt = mark.at
}

/**
 * 取り消し・やり直しで戻すプロジェクトに、編集の履歴に積まない裏の結果を引き継ぐ。
 * プレビュー用のプロキシ(裏で作った変換の結果)と、笑い・歓声の検出結果は編集ではないので、
 * 前の状態へ戻すと消えてしまう(プロキシが消えると、HEVC などの素材はプレビューできなくなる)
 */
function keepBackgroundResults(restored: Project, current: Project): Project {
  const proxyOf = new Map(
    current.assets.filter((a) => a.proxyPath).map((a) => [`${a.id}|${a.filePath}`, a.proxyPath])
  )
  let changed = false
  const assets = restored.assets.map((a) => {
    const proxy = proxyOf.get(`${a.id}|${a.filePath}`)
    if (!proxy || a.proxyPath === proxy) return a
    changed = true
    return { ...a, proxyPath: proxy }
  })
  // 検出結果は収録(同期した素材)ごとのもの。別の収録を入れる前へ戻したなら引き継がない
  const sameRecording =
    restored.multicam === current.multicam ||
    JSON.stringify(restored.multicam?.files ?? null) ===
      JSON.stringify(current.multicam?.files ?? null)
  const events =
    sameRecording && current.audioEvents !== restored.audioEvents && current.audioEvents
  if (!changed && !events) return restored
  return { ...restored, assets, ...(events ? { audioEvents: current.audioEvents } : {}) }
}

/** 裏の結果(プレビュー用のプロキシ)だけを書き込んだプロジェクト → 書き込む前のプロジェクト */
const backgroundBase = new WeakMap<Project, Project>()

/** 裏の結果だけの書き込み。未保存の判定(`markSaved`)で編集と数えないよう、元を覚えておく */
function backgroundUpdate(base: Project, next: Project): Project {
  backgroundBase.set(next, base)
  return next
}

/**
 * 今のプロジェクトが、保存したもの(か、それにプロキシだけを書き込んだもの)か。
 * 保存の途中で変換が終わってプロキシが入っても、未保存にしない
 */
function savedOrBackgroundOnly(current: Project, saved: Project): boolean {
  let p: Project | undefined = current
  while (p && p !== saved) p = backgroundBase.get(p)
  return p === saved
}

/** 繋ぎの書き換えの履歴のまとめ方: 同じ種類の長さだけを変えたときだけまとめる */
function transitionHistoryKey(
  clips: readonly Clip[],
  clipId: string,
  next: Transition | undefined
): string | undefined {
  const prev = clips.find((c) => c.id === clipId)?.transitionIn
  if (!prev || !next || prev.type !== next.type) return undefined
  return `transition:${clipId}:${next.type}`
}

/** 戻したプロジェクトにまだある文字テロップなら選んだまま、無ければ選びを外す */
function overlayStillThere(project: Project, id: string | null): string | null {
  return id && project.textOverlays.some((o) => o.id === id) ? id : null
}

/**
 * 「実在しないパス」の一覧から、いまのプロジェクトで印を付ける素材のIDを導く。
 *
 * IDを直接覚えると、取り消しで素材のパスが**実在しないものへ戻った**ときに印が戻らない
 * (履歴は `project` しか巻き戻さないので、`project` の外の state は取り残される)。
 * パスから毎回導けば、取り消し・やり直しのどちらでも自動的に辻褄が合う。
 */
function missingIdsFor(project: Project, missingPaths: readonly string[]): string[] {
  if (missingPaths.length === 0) return []
  const missing = new Set(missingPaths)
  return project.assets.filter((a) => missing.has(a.filePath)).map((a) => a.id)
}

/**
 * Splices a source range into the main video track at a timeline position.
 *
 * Main-track clips are stored sequentially with no absolute start times, so a position
 * is only meaningful as an offset accumulated across the clips before it. A cut that
 * lands mid-clip therefore has to split that clip rather than just choosing an index.
 *
 * With `overwrite`, the same amount of time the new clip occupies is consumed from the
 * material that followed, so everything downstream keeps its position; otherwise the
 * remainder is pushed later (insert). Returns null when nothing would change.
 */
function buildInsertedClips(
  project: Project,
  assetId: string,
  inPoint: number,
  outPoint: number,
  atTime: number,
  overwrite: boolean
): InsertedClips | null {
  const asset = project.assets.find((a) => a.id === assetId)
  if (!asset) return null
  // 数値でない位置・区間は先に捨てる。下の振り分けは `atTime >= …` / `atTime <= …` の
  // どちらも NaN では false になるので、**NaN は必ず最後の else(分割)へ落ちる**。
  // 分割すると in/out が NaN のクリップができ、その尺も NaN になって以降のクリップの
  // 開始位置まで NaN に汚染される。ミラー(`syncLinkedAudioClips`)の一致判定は
  // `NaN === NaN` が false なので毎回「変わった」と見なされ、購読 → setState → 購読 が
  // 止まらず `Maximum call stack size exceeded` でその場から操作不能になる。
  // (`splitClipAtTime` は `>` / `<` で挟んでいるため NaN では何も起きず、ここだけが穴だった)
  if (!Number.isFinite(atTime) || !Number.isFinite(inPoint) || !Number.isFinite(outPoint)) {
    return null
  }
  const from = Math.max(0, Math.min(inPoint, asset.duration))
  const to = Math.min(asset.duration, Math.max(outPoint, from))
  const insertedDuration = to - from
  if (insertedDuration <= 0) return null

  const clipDuration = (c: Clip): number => (c.outPoint - c.inPoint) / (c.speed || 1)
  const newClip: Clip = { id: uuid(), assetId, inPoint: from, outPoint: to, speed: 1 }

  // Split whatever sits under the insertion point into "before" and "after" halves.
  // The second half gets a fresh id, so anything linked to the original clip has to be
  // rebuilt afterwards — `split` carries what the caller needs for that.
  const before: Clip[] = []
  const after: Clip[] = []
  let split: { original: Clip; parts: Clip[] } | null = null
  let elapsed = 0
  for (const c of project.clips) {
    const dur = clipDuration(c)
    const speed = c.speed || 1
    // 分けると最短より短い切れ端ができる位置では、分けずにクリップの端へ寄せる(`splitClipAtTime` と同じ)
    const headSrc = (atTime - elapsed) * speed
    const tailSrc = c.outPoint - c.inPoint - headSrc
    if (atTime >= elapsed + dur - 1e-6 || (headSrc > 0 && tailSrc < MIN_CLIP_SOURCE_DURATION)) {
      before.push(c)
    } else if (atTime <= elapsed + 1e-6 || headSrc < MIN_CLIP_SOURCE_DURATION) {
      after.push(c)
    } else {
      const splitLocal = c.inPoint + headSrc
      const firstHalf = { ...c, outPoint: splitLocal }
      const secondHalf = { ...c, id: splitId(c.id), inPoint: splitLocal, transitionIn: undefined }
      before.push(firstHalf)
      after.push(secondHalf)
      split = { original: c, parts: [firstHalf, secondHalf] }
    }
    elapsed += dur
  }

  if (!overwrite) return { clips: [...before, newClip, ...after], split, removedClipIds: [] }

  // Consume `insertedDuration` worth of the following material, trimming the clip that
  // the consumed range ends inside rather than dropping it whole.
  let remaining = insertedDuration
  const kept: Clip[] = []
  const removedClipIds: string[] = []
  for (const c of after) {
    const dur = clipDuration(c)
    if (remaining <= 1e-6) {
      kept.push(c)
    } else if (remaining >= dur - 1e-6) {
      remaining -= dur
      removedClipIds.push(c.id)
    } else {
      const speed = c.speed || 1
      const inPoint = c.inPoint + remaining * speed
      remaining = 0
      // 上書きで残る切れ端が最短より短いなら、その分だけ置いたクリップを延ばして切れ端を消す
      // (つかめない・分けられないクリップを残さない)。延ばすので後ろの位置は変わらない。
      // 置いた素材の残りが足りなければ、切れ端は残す(後ろの位置を動かさないことを優先する)
      const tail = (c.outPoint - inPoint) / speed
      if (
        c.outPoint - inPoint < MIN_CLIP_SOURCE_DURATION &&
        newClip.outPoint + tail <= asset.duration
      ) {
        newClip.outPoint += tail
        removedClipIds.push(c.id)
        continue
      }
      kept.push({ ...c, inPoint, transitionIn: undefined })
    }
  }
  return { clips: [...before, newClip, ...kept], split, removedClipIds }
}

/**
 * インサート/上書きの結果を、`clips` の並びだけでなく**IDに起きたこと**まで返す。
 *
 * 並びだけ差し替えると、分割された後半の新しいIDと、丸ごと消えたクリップのIDを
 * 参照しているもの(分離音声・追従テロップ)が黙って取り残される。
 */
interface InsertedClips {
  clips: Clip[]
  /** 挿入点の下で2つに割れたクリップ(割れなければ null) */
  split: { original: Clip; parts: Clip[] } | null
  /** 上書きで丸ごと消えたクリップのID */
  removedClipIds: string[]
}

/**
 * インサート/上書きで組み替えた `clips` を、参照の付け替えまで済ませて `Project` にする。
 *
 * 分割は `splitClipAtTime` と、消えたぶんは `removeClips` と同じ規則を通す
 * (経路ごとに書くと、片方だけ直したときに黙ってズレる)。
 */
function applyInsertedClips(project: Project, built: InsertedClips): Project {
  let next: Project = { ...project, clips: built.clips }
  if (built.split) next = relinkForReplacedClip(next, built.split.original, built.split.parts)
  if (built.removedClipIds.length > 0) {
    next = {
      ...next,
      audioTracks: removeLinkedAudioFor(next.audioTracks, new Set(built.removedClipIds))
    }
  }
  return next
}

/**
 * **企画を切り替えるときに捨てる state の一覧。**
 *
 * 「開く」「新規作成」「自動保存から復元」の3経路は、どれも**前の企画の残りかす**を
 * 捨てなければならない。ところが3箇所に手で並べていたので、**経路ごとに一覧が
 * 食い違っていた**——`saveError` は開く/復元だけが捨てていて新規作成は残し、
 * ソースビューア(`sourceAssetId` / `sourceIn` / `sourceOut`)は**3経路とも捨てていなかった**。
 *
 * (実測: 企画Aで素材をソースビューアに出して選択範囲 1.5〜4.25 を打つ →
 *  企画Bを開く(ビューアは消えるが `sourceAssetId` は `asset-A` のまま) →
 *  **企画Aを開き直すと、開いた覚えのないビューアが勝手に開き、打った覚えのない
 *  選択範囲 1.5〜4.25 が入っている**。
 *  保存エラーのほうは、出ている状態で「新規作成」を押すと**新しい空の企画の画面に
 *  前の企画のエラー文がそのまま残っていた**——開く経路では消えるので、
 *  同じ操作なのに入口によって違う)
 *
 * **新しい state を `project` の外に足したら、捨てるべきかどうかをここで決めること。**
 * ここに書けば3経路すべてに同時に効く。
 *
 * `project` / `currentFilePath` / `isDirty` は経路ごとに値が違うので**ここには入れない**
 * (呼び出し側が必ず自分で決める)。`draggingAssetId` はドラッグの終わりに必ず下ろされる
 * 一時的な印なので、ここでは触らない。
 */
/**
 * 別のプロジェクトへ切り替わったときに知らせる先(自動編集の結果を捨てる)。
 * 自動編集のストアはこのストアを読むので、こちらからは読まずに知らせだけを受け付ける
 */
const projectSwitchListeners = new Set<() => void>()
export function onProjectSwitch(listener: () => void): () => void {
  projectSwitchListeners.add(listener)
  return () => projectSwitchListeners.delete(listener)
}

/** 保存していた「人が直したテロップ」を読み直す(壊れた項目は捨てる) */
function normalizeEditedTelops(raw: unknown): Record<string, EditedTelop> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, EditedTelop> = {}
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    if (typeof r.text !== 'string') continue
    out[key] = {
      ...unknownFields(r, ['text', 'style', 'styleId', 'speaker']),
      text: r.text,
      style: normalizeTextStyle(r.style),
      ...(typeof r.styleId === 'string' ? { styleId: r.styleId } : {}),
      ...(typeof r.speaker === 'string' ? { speaker: r.speaker } : {})
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function projectSwitchReset(): Pick<
  ProjectState,
  | 'past'
  | 'future'
  | 'selectedClipId'
  | 'multiSelectedClipIds'
  | 'selectedOverlayId'
  | 'clipboardClips'
  | 'playheadTime'
  | 'isPlaying'
  | 'seekRequest'
  | 'missingAssetPaths'
  | 'missingAssetIds'
  | 'saveError'
  | 'sourceAssetId'
  | 'sourceIn'
  | 'sourceOut'
> {
  return {
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    selectedOverlayId: null,
    clipboardClips: [],
    playheadTime: 0,
    isPlaying: false,
    seekRequest: null,
    missingAssetPaths: [],
    missingAssetIds: [],
    saveError: null,
    sourceAssetId: null,
    sourceIn: null,
    sourceOut: null
  }
}

function pushHistory(
  state: ProjectState,
  coalesceKey?: string
): Pick<ProjectState, 'past' | 'future' | 'isDirty' | '__historyPush'> {
  if (coalesceKey) {
    const now = Date.now()
    const continuing =
      lastCoalesceKey === coalesceKey &&
      (gestureKey === coalesceKey || now - lastCoalesceAt < COALESCE_MS)
    lastCoalesceKey = coalesceKey
    lastCoalesceAt = now
    if (continuing) {
      return { __historyPush: true, past: state.past, future: [], isDirty: true }
    }
  } else {
    lastCoalesceKey = null
  }
  return {
    __historyPush: true,
    past: [...state.past, state.project].slice(-MAX_HISTORY),
    future: [],
    isDirty: true
  }
}

/**
 * 「いまと同じ値を入れ直しただけ」の書き込みから、履歴と未保存の印を落とす関門。
 *
 * 押せば必ず届くボタン(選ばれている方の縦横比など)は、値が変わらなくてもアクションを
 * 呼ぶ。すると `pushHistory` が**中身が1バイトも違わないスナップショット**を積み、
 * `isDirty` も立つ——取り消しを押しても画面は何も変わらず(空の1件を消しているだけ)、
 * 閉じるときの警告と自動保存だけが走り出す。
 *
 * 各アクションの入口に「今と同じなら return」を書くと同じ形が20箇所以上に散るので、
 * `pushHistory` の目印を見て**ここ1箇所**で落とす。
 * 目印の無い書き込み(新規作成・開く・自動保存の復元・取り消し/やり直し・裏で走る
 * プロキシのパス書き込み)は**素通し**——履歴を捨てる側の操作まで捨ててしまうと、
 * 同じ内容の企画を開き直したときに古い履歴が残る。
 */
/**
 * 編集で消えたクリップ・テロップを選んだままにしない。上書き・無音のカット・演出テロップの置き直しは
 * クリップやテロップを作り替えるので、選択が消えたものを指したままになり、「選んだクリップに
 * 自動テロップ」が黙って何もせず、貼り付けが選んだ所の後ろではなく最後に入っていた
 */
function pruneSelection(state: ProjectState, patch: Partial<ProjectState>): Partial<ProjectState> {
  const project = patch.project
  if (!project) return patch
  const ids = new Set(project.clips.map((c) => c.id))
  const selected = 'selectedClipId' in patch ? (patch.selectedClipId ?? null) : state.selectedClipId
  const multi = patch.multiSelectedClipIds ?? state.multiSelectedClipIds
  const overlay =
    'selectedOverlayId' in patch ? (patch.selectedOverlayId ?? null) : state.selectedOverlayId
  const nextSelected = selected && ids.has(selected) ? selected : null
  const nextMulti = multi.every((id) => ids.has(id)) ? multi : multi.filter((id) => ids.has(id))
  const nextOverlay = overlayStillThere(project, overlay)
  if (nextSelected === selected && nextMulti === multi && nextOverlay === overlay) return patch
  return {
    ...patch,
    selectedClipId: nextSelected,
    multiSelectedClipIds: nextMulti,
    selectedOverlayId: nextOverlay
  }
}

function skipNoOpHistory(creator: StateCreator<ProjectState>): StateCreator<ProjectState> {
  return (set, get, api) => {
    const guardedSet: typeof set = (partial) => {
      set((state) => {
        // 落とすことになったときに戻せるよう、まとめ判定の目印を先に控える。
        // `partial` を評価すると、その中の `pushHistory` が目印を書き換えてしまう。
        const coalescingMark = historyCoalescingMark()
        let patch = (typeof partial === 'function' ? partial(state) : partial) as
          Partial<ProjectState> | undefined
        if (!patch || patch.__historyPush !== true) return patch as Partial<ProjectState>
        if (patch.__noFollow) patch = omitKeys(patch, ['__noFollow'])
        else if (patch.project && patch.project.clips !== state.project.clips)
          patch = { ...patch, project: followMainEdit(state.project, patch.project) }
        if (!patch.project || !sameProjectContent(patch.project, state.project)) {
          return pruneSelection(state, omitKeys(patch, ['__historyPush']))
        }
        // **落とすなら、まとめ判定の目印も落とす。** 残すと、この直後に来た本物の
        // 編集が「起点はもう積んである」と誤って判断し、**履歴を1件も積まないまま
        // 企画だけが変わる**——取り消しを押しても何も起きず、その編集は永久に戻せない。
        // (実測: 素材の端まで引いたトリム(値が頭打ちで同じ値の書き込みになる)の直後に
        //  引き戻すと `past` が **0 のまま** 0..6 → 0..4 に変わり、取り消しが効かなかった)
        restoreHistoryCoalescing(coalescingMark)
        // 中身が同じなら、履歴・未保存・企画の差し替えを丸ごと落とす。
        // `project` を差し替えないことで**参照も保たれる**ので、保存済み判定
        // (`markSaved` の `state.project !== savedProject`)も巻き添えにならない。
        const others = omitKeys(patch, [
          '__historyPush',
          '__noFollow',
          'project',
          'past',
          'future',
          'isDirty'
        ])
        // 何も残らないときは `state` をそのまま返す。zustand は同じ参照なら
        // 購読者に通知しないので、余計な再描画も起きない。
        return Object.keys(others).length === 0 ? state : others
      })
    }
    return creator(guardedSet, get, api)
  }
}

function omitKeys(
  patch: Partial<ProjectState>,
  keys: readonly (keyof ProjectState)[]
): Partial<ProjectState> {
  const dropped = new Set<string>(keys)
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => !dropped.has(key))
  ) as Partial<ProjectState>
}

const projectStateCreator: StateCreator<ProjectState> = (set, get) => ({
  project: createBlankProject(),
  past: [],
  future: [],
  currentFilePath: null,
  isDirty: false,
  selectedClipId: null,
  multiSelectedClipIds: [],
  selectedOverlayId: null,
  clipboardClips: [],
  playheadTime: 0,
  isPlaying: false,
  seekRequest: null,
  missingAssetPaths: [],
  missingAssetIds: [],
  saveError: null,

  sourceAssetId: null,
  sourceIn: null,
  sourceOut: null,
  draggingAssetId: null,
  setDraggingAssetId: (assetId) => set({ draggingAssetId: assetId }),
  // Marks reset with the clip: they describe a range inside one asset and mean
  // nothing once a different one is loaded.
  openInSourceViewer: (assetId) => set({ sourceAssetId: assetId, sourceIn: null, sourceOut: null }),
  closeSourceViewer: () => set({ sourceAssetId: null, sourceIn: null, sourceOut: null }),
  setSourceIn: (t) =>
    set((state) => ({
      sourceIn: t,
      // An in point past the out point would describe a negative range; drop the
      // stale marker rather than silently producing an empty edit later.
      sourceOut:
        t !== null && state.sourceOut !== null && state.sourceOut <= t ? null : state.sourceOut
    })),
  setSourceOut: (t) =>
    set((state) => ({
      sourceOut: t,
      sourceIn: t !== null && state.sourceIn !== null && state.sourceIn >= t ? null : state.sourceIn
    })),

  setSaveError: (message) => set({ saveError: message }),

  setMissingAssetPaths: (paths) =>
    set((state) => ({
      missingAssetPaths: paths,
      missingAssetIds: missingIdsFor(state.project, paths)
    })),

  relinkAsset: (assetId, filePath, fileName, probe, thumbnailDataUrl) =>
    set((state) => {
      // Trims are offsets into the *old* file. Relinking to a shorter one left them
      // pointing past the end: a 0–20s clip on a 15s replacement still read 20s on the
      // timeline while ffmpeg only produced 15s, so every telop, BGM clip and PiP after
      // it burned in 5s out of place. Clamp everything that indexes into this asset.
      const target = state.project.assets.find((a) => a.id === assetId)
      // 静止画は長さを持たない(置いたクリップで決める)。静止画へつなぎ直すなら、静止画の長さのまま
      const still = isImagePath(filePath)
      const clampRange = <T extends { inPoint: number; outPoint: number }>(clip: T): T => {
        // 長さが測れなかった(0)ファイル・静止画は詰めない。詰めると全部のクリップが長さ0で消える
        if (still || !(probe.duration > 0)) return clip
        if (clip.outPoint <= probe.duration) return clip
        // 頭が新しい素材の中にあれば、終わりを素材の終わりで止めるだけ(頭を前へ動かすと、
        // 後ろの本編が遅れて声・自動の音とずれる。開き直すときと同じ決まり)
        if (clip.inPoint < probe.duration) return { ...clip, outPoint: probe.duration }
        const outPoint = Math.max(0, probe.duration)
        const inPoint = Math.min(clip.inPoint, Math.max(0, outPoint - MIN_CLIP_SOURCE_DURATION))
        return inPoint === clip.inPoint && outPoint === clip.outPoint
          ? clip
          : { ...clip, inPoint, outPoint }
      }
      const forAsset = <T extends { assetId: string; inPoint: number; outPoint: number }>(
        clip: T
      ): T => (clip.assetId === assetId ? clampRange(clip) : clip)
      // マルチカムの収録の長さも新しいファイルに合わせる(古い長さのまま、後の編集で
      // マイクの音を素材の終わりの先まで作っていた)。その収録のファイルで、長さが変わるときだけ
      // 作り直す(作り直すと、本編に付いていく処理が「別の収録を入れた」とみなして追従を止める)
      const info = state.project.multicam
      const newMulticam =
        info &&
        !still &&
        probe.duration > 0 &&
        info.files.some((f) => f.assetId === assetId && f.duration !== probe.duration)
          ? {
              ...info,
              files: info.files.map((f) =>
                f.assetId === assetId ? { ...f, duration: probe.duration } : f
              )
            }
          : undefined

      const relinked = {
        // 再リンクは利用者の操作なので履歴を積む。積まないと `past` が伸びないまま
        // `project` だけ進むので、**取り消し1回で2つ前まで戻ってしまう**。
        // (実測: クリップを置く → 速度を2倍 → 再リンク、と進めて取り消しを1回押すと、
        //  再リンクだけでなく**速度2倍の編集まで消えて 1倍に戻り**、やり直しを押しても
        //  再リンク後へ飛ぶだけで「速度2倍・元ファイル」の状態には二度と戻れなかった)
        // 上の `setAssetProxyPath` は裏で走る変換の結果なので積まない——**利用者が
        // やったことかどうか**が分かれ目で、`project` を変えるかどうかではない。
        ...pushHistory(state),
        project: {
          ...state.project,
          assets: state.project.assets.map((a) =>
            a.id === assetId
              ? {
                  ...a,
                  filePath,
                  fileName,
                  duration: still
                    ? STILL_DURATION_SEC
                    : probe.duration > 0
                      ? probe.duration
                      : (target?.duration ?? 0),
                  still: still ? true : undefined,
                  width: probe.width,
                  height: probe.height,
                  fps: probe.fps,
                  hasAudio: probe.hasAudio,
                  hasVideo: probe.hasVideo,
                  thumbnailDataUrl,
                  // The proxy was transcoded from the file we just replaced. Keeping it
                  // made the preview play the OLD footage while the export used the new
                  // file — the one place the two must never disagree.
                  proxyPath: undefined,
                  // 差し替えた先は人が選んだファイル。ノイズを除いた音声の印を残すと、
                  // 「ノイズ除去を外す」で前の(見つからない)録音へ戻っていた
                  denoisedFrom: undefined,
                  proxyBeforeDenoise: undefined
                }
              : a
          ),
          clips: state.project.clips.map(forAsset),
          audioTracks: state.project.audioTracks.map((t) => ({
            ...t,
            clips: t.clips.map(forAsset)
          })),
          videoOverlayTracks: state.project.videoOverlayTracks.map((t) => ({
            ...t,
            clips: t.clips.map(forAsset)
          })),
          ...(newMulticam ? { multicam: newMulticam } : {})
        },
        isDirty: true,
        missingAssetIds: state.missingAssetIds.filter((id) => id !== assetId)
      }
      if (!newMulticam) return relinked
      // 収録の長さを直したときは、本編(詰めたクリップ)に声・自動テロップを新しい長さで付いていかせる
      return {
        ...relinked,
        project: followMainEdit({ ...state.project, multicam: newMulticam }, relinked.project),
        __noFollow: true as const
      }
    }),

  newProject: () => {
    resetHistoryCoalescing()
    resetTransientFollowState()
    projectSwitchListeners.forEach((l) => l())
    set({
      ...projectSwitchReset(),
      project: createBlankProject(),
      currentFilePath: null,
      isDirty: false
    })
  },

  loadProject: (project, filePath) => {
    // 形を整えたあとに、**素材がもう居ないクリップ**を落とす。残すと画面から
    // 選ぶことも消すこともできないのに書き出しだけが毎回失敗する。
    // 落としたぶんはファイルの内容と食い違うので、保存できるよう dirty にする。
    // **履歴を捨てるなら、まとめ判定の目印も捨てる。** 残すと、開いた直後の編集が
    // 「起点はもう積んである」と誤って判断して履歴を1件も積まない(`newProject` と
    // `undo`/`redo` は最初からこれを通していて、開く／復元だけが漏れていた)。
    resetHistoryCoalescing()
    resetTransientFollowState()
    projectSwitchListeners.forEach((l) => l())
    // 落とした分離音声の紐づき先は、印を下ろして内蔵の音へ戻す(消す経路と同じ関門)。
    const cleaned = dropOrphanClips(normalizeLoadedProject(project))
    set({
      ...projectSwitchReset(),
      project: reattachClipsWithoutLinkedAudio(cleaned.project, cleaned.unlinkedClipIds),
      currentFilePath: filePath,
      isDirty: cleaned.droppedCount > 0,
      // 落としたぶんの案内は、上の一覧が入れた `null` のあとに上書きする
      saveError: cleaned.droppedCount > 0 ? orphanCleanupMessage(cleaned.droppedCount) : null
    })
  },

  restoreAutosave: (project) => {
    // **履歴を捨てるなら、まとめ判定の目印も捨てる。** 残すと、開いた直後の編集が
    // 「起点はもう積んである」と誤って判断して履歴を1件も積まない(`newProject` と
    // `undo`/`redo` は最初からこれを通していて、開く／復元だけが漏れていた)。
    resetHistoryCoalescing()
    resetTransientFollowState()
    projectSwitchListeners.forEach((l) => l())
    // 落とした分離音声の紐づき先は、印を下ろして内蔵の音へ戻す(消す経路と同じ関門)。
    const cleaned = dropOrphanClips(normalizeLoadedProject(project))
    set({
      ...projectSwitchReset(),
      project: reattachClipsWithoutLinkedAudio(cleaned.project, cleaned.unlinkedClipIds),
      currentFilePath: null,
      // The recovered draft doesn't exist on disk under a real save yet, so keep
      // it flagged dirty until the user explicitly saves it.
      isDirty: true,
      // 落としたぶんの案内は、上の一覧が入れた `null` のあとに上書きする
      saveError: cleaned.droppedCount > 0 ? orphanCleanupMessage(cleaned.droppedCount) : null
    })
  },

  markSaved: (filePath, savedProject) =>
    set((state) => ({
      currentFilePath: filePath,
      // **ディスクに書いたのは `savedProject`。** 保存は IPC を跨ぐので、書いている
      // 途中の編集は成果物に入らない。それでも一律 `false` にすると、その編集だけが
      // 「保存済み」の顔をして残り、閉じるときの警告も出ず、`clearAutosave` で
      // 復元用の控えまで消えるので**どこにも無くなる**。
      // (実測: 保存に 465ms かかる状態で、保存を始めた直後にクリップを1本足すと、
      //  画面は ABCD・`isDirty=false`・警告なしなのに、ファイルの中身は **ABC** だった)
      // 編集があれば `project` は必ず別のオブジェクトに差し替わる(どの操作も
      // `{...state.project}` を作る)ので、参照が同じかどうかで判定できる。
      isDirty: !savedOrBackgroundOnly(state.project, savedProject),
      saveError: null
    })),

  setProjectName: (name) =>
    set((state) => ({
      // 音量などと同じ合体キー。1文字打つたびに Undo が積まれないようにする。
      ...pushHistory(state, 'projectName'),
      project: { ...state.project, name: name.trim() || DEFAULT_PROJECT_NAME }
    })),

  addAsset: (asset) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, assets: [...state.project.assets, asset] }
    })),

  // Importing a folder of recordings one asset at a time would push one history
  // entry per file, so a 60-file import flushed the entire 50-entry undo history
  // and made everything done before the import unrecoverable.
  addAssets: (assets) =>
    set((state) => {
      if (assets.length === 0) return state
      return {
        ...pushHistory(state),
        project: { ...state.project, assets: [...state.project.assets, ...assets] }
      }
    }),

  addMulticamTimeline: (assets, layout, assetIdOf, aspectRatio, sources) =>
    set((state) => {
      // 同じプロジェクトでやり直すときは、前に並べた収録素材・自動で置いたもの・前の判断を外してから並べる。
      // 残すと、カメラ・マイクのトラックが二重になり、前の仮編集を「人が足した区間」と読み違えて
      // 収録全体が本編に戻る
      const prev = sources ? state.project.multicam : undefined
      const prevAssets = new Set(prev?.files.map((f) => f.assetId) ?? [])
      const base: Project = prev
        ? {
            ...state.project,
            assets: state.project.assets.filter((a) => !prevAssets.has(a.id)),
            clips: state.project.clips.filter((c) => !prevAssets.has(c.assetId)),
            videoOverlayTracks: state.project.videoOverlayTracks.filter(
              (t) => !t.multicamSourceId && !t.autoRole
            ),
            audioTracks: state.project.audioTracks.filter(
              (t) => !t.multicamSourceId && !t.autoRole
            ),
            textOverlays: state.project.textOverlays.filter(
              (o) => !(o.source === 'auto' && (o.utteranceId || o.effectId))
            ),
            roughCutAuto: undefined,
            cutOverrides: undefined,
            dismissedTelops: undefined,
            editedTelops: undefined,
            reviewed: undefined
          }
        : state.project
      const idOf = (fileId: string): string | undefined => assetIdOf[fileId]
      // 基準カメラの録画から音声トラックを取り出したなら、本編の音は鳴らさない
      // (全部入りのトラックと同じ音が重なり、二重に・大きく聞こえる)
      const anchorTracked = Boolean(
        sources && tracksReplaceAnchorAudio(sources, layout.anchorSourceId)
      )
      const main: Clip[] = layout.main
        .filter((m) => idOf(m.fileId))
        .map((m) => ({
          id: uuid(),
          assetId: idOf(m.fileId)!,
          inPoint: m.inPoint,
          outPoint: m.outPoint,
          speed: m.speed,
          ...(anchorTracked ? { audioDetached: true } : {})
        }))
      // ほかのカメラは隠しておく(どのアングルを使うかはアングルの切替で決める。出したままだと
      // 全部が小窓で重なって見える)。隠したトラックの音は書き出しでも鳴らさない
      // ゲーム実況の顔カメラは切り替えに使わず、ワイプとして常に出す
      const isFace = (id: string): boolean =>
        sources?.find((x) => x.id === id)?.cameraRole === 'face'
      const cameras: VideoOverlayTrack[] = layout.cameras.map((c) => ({
        id: uuid(),
        name: c.name,
        multicamSourceId: c.sourceId,
        hidden: !isFace(c.sourceId),
        // 顔カメラの声はマイク・ゲーム機の音源で鳴らす(カメラの音も足すと二重に聞こえる)
        ...(isFace(c.sourceId) ? { audioMuted: true } : {}),
        position: isFace(c.sourceId) ? FACE_PIP_POSITION : 'top-right',
        scale: isFace(c.sourceId) ? FACE_PIP_SCALE : 0.32,
        clips: c.pieces
          .filter((p) => idOf(p.fileId))
          .map((p) => ({
            id: uuid(),
            assetId: idOf(p.fileId)!,
            startTime: p.startTime,
            inPoint: p.inPoint,
            outPoint: p.outPoint
          }))
      }))
      // 録音機の時計のずれは速度で補正する(4時間で1秒近くずれることがある)。
      // PiP のクリップは速度を持てないので、区間ごとの頭で合わせ直すだけにする
      // (ずれは区間の中でしか積もらない。20ppm・30分の区間で最大 36ms)
      const mics: AudioTrack[] = [
        ...layout.mics.map((m) => ({ ...m, voice: true })),
        ...(layout.audio ?? []).map((m) => ({
          ...m,
          voice: carriesVoice(sources?.find((x) => x.id === m.sourceId))
        }))
      ].map((m) => ({
        id: uuid(),
        name: m.name,
        multicamSourceId: m.sourceId,
        muted: sources ? silencedTrack(sources, m.sourceId) : false,
        volume: 1,
        duckingEnabled: false,
        voice: m.voice,
        clips: m.pieces
          .filter((p) => idOf(p.fileId))
          .map((p) => ({
            id: uuid(),
            assetId: idOf(p.fileId)!,
            startTime: p.startTime,
            inPoint: p.inPoint,
            outPoint: p.outPoint,
            ...(Math.abs(p.speed - 1) > 1e-9 ? { speed: p.speed } : {})
          }))
      }))
      return {
        __noFollow: true,
        ...pushHistory(state),
        project: {
          ...base,
          aspectRatio: aspectRatio ?? base.aspectRatio,
          multicam: sources
            ? {
                anchorSourceId: layout.anchorSourceId,
                sources,
                files: layout.placed
                  .filter((p) => assetIdOf[p.fileId])
                  .map((p) => ({
                    assetId: assetIdOf[p.fileId],
                    sourceId: p.sourceId,
                    start: p.start,
                    rate: p.rate,
                    duration: p.duration
                  }))
              }
            : base.multicam,
          assets: [...base.assets, ...assets],
          clips: [...base.clips, ...main],
          videoOverlayTracks: [...base.videoOverlayTracks, ...cameras],
          audioTracks: [...base.audioTracks, ...mics]
        }
      }
    }),

  // Background result of transcoding a preview proxy, not something the user did:
  // it must not create an undo entry (undoing an import would otherwise leave a
  // half-state) and must not mark the project dirty, since the proxy is a rebuildable
  // cache rather than edited content.
  setAssetProxyPath: (assetId, proxyPath) =>
    set((state) => {
      const target = state.project.assets.find((a) => a.id === assetId)
      if (!target || target.proxyPath === proxyPath) return state
      return {
        project: backgroundUpdate(state.project, {
          ...state.project,
          assets: state.project.assets.map((a) => (a.id === assetId ? { ...a, proxyPath } : a))
        })
      }
    }),

  // Removing an asset must take every clip that references it with it — a clip whose
  // asset is gone has no file to read and would break both preview and export. That
  // makes this one user action spanning four collections, so it is one history entry.
  removeAsset: (assetId) =>
    set((state) => {
      if (!state.project.assets.some((a) => a.id === assetId)) return state
      const removedClipIds = state.project.clips
        .filter((c) => c.assetId === assetId)
        .map((c) => c.id)
      const clips = state.project.clips.filter((c) => c.assetId !== assetId)
      // **消える分離音声が、どの本編クリップに紐づいていたか**を控える。
      // 紐づき先が生き残るのに音声だけ消えると、その本編クリップは `audioDetached` が
      // 立ったまま「鳴らす相手が居ない」状態になり、**書き出しが digital silence になる**。
      // (実測: 本編に440Hz・分離音声にナレーション(別素材)という企画で、メディア一覧から
      //  ナレーション素材を削除して書き出すと、出力の実効値が **0.00000**＝完全な無音。
      //  同じ形を作る `removeAudioClip` / `removeAudioTrack` は印を下ろすので
      //  内蔵の440Hzが 0.17610 で戻る)
      const unlinkedClipIds = state.project.audioTracks.flatMap((t) =>
        t.clips
          .filter(
            (c) =>
              c.assetId === assetId ||
              (c.linkedClipId != null && removedClipIds.includes(c.linkedClipId))
          )
          .map((c) => c.linkedClipId)
          .filter((id): id is string => id != null)
      )
      const audioTracks = state.project.audioTracks
        .map((t) => ({
          ...t,
          // Detached audio linked to a removed video clip goes too, even when the audio
          // clip itself points at a different asset.
          clips: t.clips.filter(
            (c) =>
              c.assetId !== assetId &&
              !(c.linkedClipId != null && removedClipIds.includes(c.linkedClipId))
          )
        }))
        // A track emptied by this deletion (typically the "◯◯の音声" track the
        // detach created) would otherwise sit in the timeline forever, named after a
        // file the project no longer has. A track that was already empty is left
        // alone — the user made it deliberately and is about to fill it.
        .filter((t, i) => t.clips.length > 0 || state.project.audioTracks[i].clips.length === 0)
      const videoOverlayTracks = state.project.videoOverlayTracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => c.assetId !== assetId)
      }))
      const stillSelected =
        state.selectedClipId != null && clips.some((c) => c.id === state.selectedClipId)
      return {
        ...pushHistory(state),
        // 紐づく分離音声が消えた本編クリップは、印を下ろして内蔵の音へ戻す
        // (`removeAudioClip` / `removeAudioTrack` / `moveAudioClipToTrack` と同じ関門)。
        project: reattachClipsWithoutLinkedAudio(
          {
            ...state.project,
            assets: state.project.assets.filter((a) => a.id !== assetId),
            clips,
            audioTracks,
            videoOverlayTracks,
            // 同期の記録からも外す。残すと、本編を伸ばしたときにピンマイクの声として
            // 消した素材のクリップを足し、カメラの切り替え先にも出てしまう
            ...(state.project.multicam?.files.some((f) => f.assetId === assetId)
              ? {
                  multicam: {
                    ...state.project.multicam,
                    files: state.project.multicam.files.filter((f) => f.assetId !== assetId)
                  }
                }
              : {})
          },
          unlinkedClipIds
        ),
        selectedClipId: stillSelected ? state.selectedClipId : null,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) =>
          clips.some((c) => c.id === id)
        ),
        // The source viewer would otherwise keep showing a file the project no longer has.
        sourceAssetId: state.sourceAssetId === assetId ? null : state.sourceAssetId,
        sourceIn: state.sourceAssetId === assetId ? null : state.sourceIn,
        sourceOut: state.sourceAssetId === assetId ? null : state.sourceOut,
        missingAssetIds: state.missingAssetIds.filter((id) => id !== assetId)
      }
    }),

  // Adding narration/BGM is one user action but three mutations (asset, track,
  // clip). Kept as a single history entry so undo doesn't leave an orphaned empty
  // track and an unused asset behind.
  addAudioClipWithAsset: (asset, target) =>
    set((state) => {
      const existing =
        state.project.audioTracks.find((t) => t.id === target.trackId) ??
        state.project.audioTracks.find((t) => t.name === target.trackName)
      // Re-adding the same sound effect must reuse its asset rather than pile up a
      // duplicate media entry for every placement.
      const existingAsset = state.project.assets.find((a) => a.filePath === asset.filePath)
      const effectiveAsset = existingAsset ?? asset
      const clip: AudioTrackClip = {
        id: uuid(),
        assetId: effectiveAsset.id,
        startTime:
          target.startTime === undefined
            ? existing
              ? audioTrackEnd(existing)
              : 0
            : findFreeAudioStart(existing?.clips ?? [], target.startTime, effectiveAsset.duration),
        inPoint: 0,
        outPoint: effectiveAsset.duration
      }
      const audioTracks = existing
        ? state.project.audioTracks.map((t) =>
            t.id === existing.id ? { ...t, clips: [...t.clips, clip] } : t
          )
        : [
            ...state.project.audioTracks,
            {
              id: uuid(),
              name: target.trackName,
              muted: false,
              volume: 1,
              duckingEnabled: false,
              clips: [clip]
            }
          ]
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          assets: existingAsset ? state.project.assets : [...state.project.assets, asset],
          audioTracks
        }
      }
    }),

  addClipToTimeline: (assetId, index) =>
    set((state) => {
      const asset = state.project.assets.find((a) => a.id === assetId)
      // 静止画は本編に置かない(ワイプ・全面(CG)のトラック用)
      if (!asset || asset.still) return state
      const newClip: Clip = {
        id: uuid(),
        assetId,
        inPoint: 0,
        outPoint: asset.duration,
        speed: 1
      }
      const clips = [...state.project.clips]
      // 範囲外の index は末尾扱い。ドロップ位置から出す値なので、末尾より後ろは普通に起きる。
      const at = index === undefined ? clips.length : Math.max(0, Math.min(clips.length, index))
      clips.splice(at, 0, newClip)
      return {
        ...pushHistory(state),
        project: { ...state.project, clips }
      }
    }),

  addTrimmedClipToTimeline: (assetId, inPoint, outPoint, index) =>
    set((state) => {
      const asset = state.project.assets.find((a) => a.id === assetId)
      if (!asset || asset.still) return state
      // 頭と終わりが逆・数値でない区間は置かない(長さが負のクリップで後ろが全部重なる)
      if (!Number.isFinite(inPoint) || !Number.isFinite(outPoint) || outPoint <= inPoint) {
        return state
      }
      const newClip: Clip = clampSourceRange(
        { id: uuid(), assetId, inPoint, outPoint, speed: 1 },
        inPoint,
        outPoint,
        asset.duration
      )
      const clips = [...state.project.clips]
      const at = index === undefined ? clips.length : Math.max(0, Math.min(clips.length, index))
      clips.splice(at, 0, newClip)
      return {
        ...pushHistory(state),
        project: { ...state.project, clips }
      }
    }),

  // Three-point editing, DaVinci-style: the source range says how long, the timeline
  // playhead says where. Insert ripples everything after the playhead later; overwrite
  // consumes the same amount of existing material instead.
  insertClipAtTime: (assetId, inPoint, outPoint, atTime) =>
    set((state) => {
      if (state.project.assets.find((x) => x.id === assetId)?.still) return state
      const built = buildInsertedClips(state.project, assetId, inPoint, outPoint, atTime, false)
      if (!built) return state
      return { ...pushHistory(state), project: applyInsertedClips(state.project, built) }
    }),

  overwriteClipAtTime: (assetId, inPoint, outPoint, atTime) =>
    set((state) => {
      if (state.project.assets.find((x) => x.id === assetId)?.still) return state
      const built = buildInsertedClips(state.project, assetId, inPoint, outPoint, atTime, true)
      if (!built) return state
      return { ...pushHistory(state), project: applyInsertedClips(state.project, built) }
    }),

  updateClipTrim: (clipId, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state, `clipTrim:${clipId}`),
      project: reanchorLinkedOverlays(state.project, {
        ...state.project,
        clips: state.project.clips.map((c) =>
          c.id === clipId
            ? clampSourceRange(c, inPoint, outPoint, assetDurationOf(state.project, c.assetId))
            : c
        )
      })
    })),

  // Roll trim: moves the boundary between two neighbours without changing the total
  // length. The left clip gives up (or gains) exactly what the right clip gains (or
  // gives up), so everything downstream keeps its timeline position — the difference
  // from an ordinary edge drag, which ripples everything after it.
  rollTrim: (leftClipId, rightClipId, deltaSeconds) =>
    set((state) => {
      const left = state.project.clips.find((c) => c.id === leftClipId)
      const right = state.project.clips.find((c) => c.id === rightClipId)
      if (!left || !right) return state
      const leftAsset = state.project.assets.find((a) => a.id === left.assetId)
      const rightAsset = state.project.assets.find((a) => a.id === right.assetId)
      if (!leftAsset || !rightAsset) return state
      const leftSpeed = left.speed || 1
      const rightSpeed = right.speed || 1

      // Clamp against all four limits at once and in timeline seconds, so a drag that
      // would overrun one side stops at that side's limit instead of being rejected.
      if (!Number.isFinite(deltaSeconds)) return state
      // 最短より短いクリップ(端の近くで分割したもの)では余地が負になり、逆向き・素材の外へ動いていた。
      // 余地は 0 で止める
      const maxForward = Math.max(
        0,
        Math.min(
          (leftAsset.duration - left.outPoint) / leftSpeed,
          (right.outPoint - right.inPoint - MIN_CLIP_SOURCE_DURATION) / rightSpeed
        )
      )
      const maxBackward = Math.max(
        0,
        Math.min(
          (left.outPoint - left.inPoint - MIN_CLIP_SOURCE_DURATION) / leftSpeed,
          right.inPoint / rightSpeed
        )
      )
      const delta = Math.max(-maxBackward, Math.min(maxForward, deltaSeconds))
      if (Math.abs(delta) < 1e-6) return state

      return {
        ...pushHistory(state, `roll:${leftClipId}:${rightClipId}`),
        project: reanchorLinkedOverlays(state.project, {
          ...state.project,
          clips: state.project.clips.map((c) => {
            // 端まで動かしたときの丸めの残り(-2.8e-17 など)で、素材の外を指さないように
            if (c.id === leftClipId)
              return {
                ...c,
                outPoint: Math.min(leftAsset.duration, c.outPoint + delta * leftSpeed)
              }
            if (c.id === rightClipId)
              return { ...c, inPoint: Math.max(0, c.inPoint + delta * rightSpeed) }
            return c
          })
        })
      }
    }),

  updateClipSpeed: (clipId, speed) =>
    set((state) => {
      // 0・負・数値でない速さは書かない(長さが負・無限のクリップになる)
      if (!validSpeed(speed)) return state
      return {
        ...pushHistory(state),
        project: reanchorLinkedOverlays(state.project, {
          ...state.project,
          // 分離音声にも同じ速度がミラーされる(syncLinkedAudioClips)ので、分離済みでも
          // 速度を変えられる。
          clips: state.project.clips.map((c) => (c.id === clipId ? { ...c, speed } : c))
        })
      }
    }),

  updateClipTransition: (clipId, transition) =>
    set((state) => {
      // 長さの欄を空にした(0)・数でない値は書かない。0 秒の繋ぎは黙ってふつうのカットになる
      if (transition && !(Number.isFinite(transition.duration) && transition.duration > 0))
        return state
      return {
        // 長さの欄に打つ1文字ごとに履歴を積まない(打ち終えた値までを1回で取り消す)。
        // 種類を替える・外すのは1回ずつ(長さの打ち込みだけをまとめる)
        ...pushHistory(state, transitionHistoryKey(state.project.clips, clipId, transition)),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) =>
            c.id === clipId ? { ...c, transitionIn: transition } : c
          )
        }
      }
    }),

  detachClipAudio: (clipId) =>
    set((state) => {
      const clip = state.project.clips.find((c) => c.id === clipId)
      if (!clip || clip.audioDetached) return state
      const asset = state.project.assets.find((a) => a.id === clip.assetId)
      if (!asset || !asset.hasAudio) return state
      const timed = buildTimedClips(state.project)
      const timedClip = timed.find((tc) => tc.clip.id === clipId)
      if (!timedClip) return state
      const newTrack: AudioTrack = {
        id: uuid(),
        name: `${asset.fileName}の音声`,
        muted: false,
        volume: 1,
        duckingEnabled: false,
        clips: [
          {
            id: uuid(),
            assetId: clip.assetId,
            startTime: timedClip.start,
            inPoint: clip.inPoint,
            outPoint: clip.outPoint,
            // 速度もそのまま引き継ぐ。等倍以外のクリップを分離しても音がズレない。
            speed: clip.speed || 1,
            linkedClipId: clip.id
          }
        ]
      }
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) =>
            c.id === clipId ? { ...c, audioDetached: true } : c
          ),
          audioTracks: [...state.project.audioTracks, newTrack]
        }
      }
    }),

  // The counterpart to 音声を分離. `audioDetached` mutes the clip on export, and
  // detachClipAudio refuses to run on an already-detached clip, so without a way back
  // the flag is a one-way door. Removal of a *linked* audio clip clears it
  // automatically, but the link can be severed first — splitting the separated audio,
  // dragging it, or swapping its asset all unlink it — and deleting it afterwards then
  // left the clip permanently silent (measured: -91.0 dB) with no way to recover.
  reattachClipAudio: (clipId) =>
    set((state) => {
      const clip = state.project.clips.find((c) => c.id === clipId)
      if (!clip || !clip.audioDetached) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) =>
            c.id === clipId ? { ...c, audioDetached: false } : c
          ),
          // Audio still linked to this clip belongs to the separation we are undoing,
          // so it goes with it. Anything the user has since unlinked and edited is
          // left alone — deleting their work would be worse than a doubled track they
          // can see and remove.
          audioTracks: state.project.audioTracks
            .map((t) => {
              const clips = t.clips.filter((c) => c.linkedClipId !== clipId)
              return clips.length === t.clips.length ? t : { ...t, clips }
            })
            // The "◯◯の音声" track the separation created has no reason to stay behind
            // once it is empty. A track that was already empty is the user's, so it stays.
            .filter((t, i) => t.clips.length > 0 || state.project.audioTracks[i].clips.length === 0)
        }
      }
    }),

  updateClipBlurBackground: (clipId, blurBackground) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        // `...c` でスプレッドしないと、クロップ位置や色ラベルなどここに書いていない
        // 設定が落ちる
        clips: state.project.clips.map((c) => (c.id === clipId ? { ...c, blurBackground } : c))
      }
    })),

  updateClipCrop: (clipId, fillCrop, cropCenter) =>
    set((state) => ({
      // Dragging the crop-centre slider fires continuously; without coalescing one
      // adjustment would bury the rest of the undo history.
      ...pushHistory(state, `clipCrop:${clipId}`),
      project: {
        ...state.project,
        clips: state.project.clips.map((c) =>
          c.id === clipId ? { ...c, fillCrop, cropCenter: cropCenter ?? c.cropCenter } : c
        )
      }
    })),

  applyClipTrimAndCrop: (clipId, inPoint, outPoint, fillCrop, cropCenter) =>
    set((state) => ({
      // 「適用」ボタン1回 = 履歴1件。updateClipTrim と updateClipCrop を続けて呼ぶと
      // 履歴が2件積まれ、Undo 1回で利用者が一度も選んでいない中間状態に戻ってしまう
      ...pushHistory(state),
      project: reanchorLinkedOverlays(state.project, {
        ...state.project,
        clips: state.project.clips.map((c) => {
          if (c.id !== clipId) return c
          const trimmed =
            inPoint < outPoint
              ? clampSourceRange(c, inPoint, outPoint, assetDurationOf(state.project, c.assetId))
              : c
          // クロップに触れていないときは書かない。`fillCrop: false` を書き込むと
          // 未設定(undefined)のクリップが「変更あり」になり、空の履歴が積まれる
          const nextCenter = cropCenter ?? trimmed.cropCenter
          const cropChanged =
            fillCrop !== (trimmed.fillCrop ?? false) || nextCenter !== trimmed.cropCenter
          return cropChanged ? { ...trimmed, fillCrop, cropCenter: nextCenter } : trimmed
        })
      })
    })),

  replaceClipRange: (clipId, newClips) =>
    set((state) => {
      const project = applyClipReplacement(state.project, clipId, newClips)
      if (project === state.project) return state
      return { ...pushHistory(state), project }
    }),

  replaceClipRanges: (replacements) =>
    set((state) => {
      // 対象が何本でも履歴は1件。1本ずつ replaceClipRange を呼ぶと本数分の
      // Undo が積まれ、まとめて掛けた操作を1回で戻せなくなる。
      const project = replacements.reduce(
        (acc, r) => applyClipReplacement(acc, r.clipId, r.newClips),
        state.project
      )
      if (project === state.project) return state
      return { ...pushHistory(state), project }
    }),

  splitClipAtTime: (clipId, absoluteTime) =>
    set((state) => {
      let elapsed = 0
      let didSplit = false
      let secondHalfId: string | null = null
      let splitOriginal: Clip | null = null
      const splitParts: Clip[] = []
      const clips: Clip[] = []
      for (const c of state.project.clips) {
        const dur = (c.outPoint - c.inPoint) / (c.speed || 1)
        const splitAt =
          c.id === clipId && absoluteTime > elapsed && absoluteTime < elapsed + dur
            ? c.inPoint + toSourceSeconds(absoluteTime - elapsed, c.speed || 1)
            : NaN
        // 端のすぐそばでは分けない(最短より短いクリップは、ロールで逆へ動く・つかめない)
        if (
          Number.isFinite(splitAt) &&
          splitAt - c.inPoint >= MIN_CLIP_SOURCE_DURATION &&
          c.outPoint - splitAt >= MIN_CLIP_SOURCE_DURATION
        ) {
          didSplit = true
          secondHalfId = splitId(c.id)
          splitOriginal = c
          const speed = c.speed || 1
          const splitLocal = splitAt
          clips.push({ ...c, outPoint: splitLocal })
          splitParts.push({ ...c, outPoint: splitLocal })
          // Spread the source clip so per-clip settings that aren't listed here
          // (crop/fill framing in particular) survive the split — rebuilding the
          // second half field by field silently dropped them.
          const secondHalf = {
            ...c,
            id: secondHalfId,
            inPoint: splitLocal,
            outPoint: c.outPoint,
            speed,
            transitionIn: undefined
          }
          clips.push(secondHalf)
          splitParts.push(secondHalf)
        } else {
          clips.push(c)
        }
        elapsed += dur
      }
      if (!didSplit) return state
      // Detached audio linked to the split clip must split too: the link mirror
      // trims linked audio to its source clip's bounds, so without a second piece
      // linked to the new half, that half (audioDetached=true) would export silent.
      const audioTracks = state.project.audioTracks.map((t) => {
        if (!t.clips.some((c) => c.linkedClipId === clipId)) return t
        return {
          ...t,
          clips: t.clips.flatMap((c) => {
            if (c.linkedClipId !== clipId) return [c]
            // **タイムライン秒 → 素材秒は速度を掛ける。** 掛け忘れると、スロー再生の
            // クリップで切る位置が素材の外へ出て「範囲外なので切らない」に落ち、
            // 後半のクリップだけ紐づく音声が無くなる(理由は toSourceSeconds)。
            const splitLocal = c.inPoint + toSourceSeconds(absoluteTime - c.startTime, c.speed)
            if (splitLocal <= c.inPoint || splitLocal >= c.outPoint) return [c]
            // フェードは配り直す(そのまま複製すると切れ目で音が落ちる。理由は splitFades)
            return splitFades([
              { ...c, outPoint: splitLocal },
              {
                ...c,
                id: uuid(),
                startTime: absoluteTime,
                inPoint: splitLocal,
                linkedClipId: secondHalfId ?? undefined
              }
            ])
          })
        }
      })
      // 後半は新しいIDになるので、そこへ載っていた追従テロップを張り直す。
      const textOverlays = splitOriginal
        ? remapOverlayLinks(state.project.textOverlays, splitOriginal, splitParts)
        : state.project.textOverlays
      return {
        ...pushHistory(state),
        project: { ...state.project, clips, audioTracks, textOverlays }
      }
    }),

  removeClip: (clipId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        clips: state.project.clips.filter((c) => c.id !== clipId),
        audioTracks: removeLinkedAudioFor(state.project.audioTracks, new Set([clipId]))
      },
      selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
      multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => id !== clipId)
    })),

  removeClips: (clipIds) =>
    set((state) => {
      const idSet = new Set(clipIds)
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.filter((c) => !idSet.has(c.id)),
          audioTracks: removeLinkedAudioFor(state.project.audioTracks, idSet)
        },
        selectedClipId:
          state.selectedClipId && idSet.has(state.selectedClipId) ? null : state.selectedClipId,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => !idSet.has(id))
      }
    }),

  duplicateClips: (clipIds) =>
    set((state) => {
      const idSet = new Set(clipIds)
      const indices = state.project.clips
        .map((c, i) => (idSet.has(c.id) ? i : -1))
        .filter((i) => i !== -1)
      if (indices.length === 0) return state
      const lastIndex = Math.max(...indices)
      const newClips: Clip[] = indices.map((i) => ({
        ...state.project.clips[i],
        id: uuid(),
        transitionIn: undefined,
        audioDetached: copiedAudioDetached(state.project, state.project.clips[i])
      }))
      const clips = [...state.project.clips]
      clips.splice(lastIndex + 1, 0, ...newClips)
      return {
        ...pushHistory(state),
        project: { ...state.project, clips },
        selectedClipId: newClips[newClips.length - 1].id,
        multiSelectedClipIds: newClips.map((c) => c.id)
      }
    }),

  updateClipsSpeed: (clipIds, speed) =>
    set((state) => {
      if (!validSpeed(speed)) return state
      const idSet = new Set(clipIds)
      return {
        ...pushHistory(state),
        project: reanchorLinkedOverlays(state.project, {
          ...state.project,
          // 分離音声にも同じ速度がミラーされるので、分離済みでも速度を変えられる。
          clips: state.project.clips.map((c) => (idSet.has(c.id) ? { ...c, speed } : c))
        })
      }
    }),

  // 単一選択も複数選択も同じアクションを通す(呼び出し側が [clip.id] を渡す)。
  // 経路を分けると片方だけ直す事故が起きるため。
  updateClipsColorLabel: (clipIds, label) =>
    set((state) => {
      const idSet = new Set(clipIds)
      if (!state.project.clips.some((c) => idSet.has(c.id))) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) => (idSet.has(c.id) ? { ...c, colorLabel: label } : c))
        }
      }
    }),

  moveClip: (clipId, direction) =>
    set((state) => {
      const clips = [...state.project.clips]
      const idx = clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return state
      const swapWith = direction === 'left' ? idx - 1 : idx + 1
      if (swapWith < 0 || swapWith >= clips.length) return state
      ;[clips[idx], clips[swapWith]] = [clips[swapWith], clips[idx]]
      return { ...pushHistory(state), project: { ...state.project, clips } }
    }),

  /**
   * `targetIndex` は**動かす前の並びでの挿入位置**——「ここに線が出た」位置そのもの。
   * `0` なら先頭、`clips.length` なら末尾。
   *
   * 抜いてから同じ番号に挿すと、**後ろへ動かすときだけ1つ行き過ぎる**。自分を抜いたぶん
   * 並びが1つ詰まるためで、案内線は落とし先クリップの左端に出ているのに、実際は
   * その右へ入る。前へ動かすときは詰まらないので正しく、**向きによって意味が変わる**。
   * (実測 ABCDE: A を D の左端へ落とすと `BCDAE`(期待 `BCADE`)、
   *  A を B の左端へ落とすと——線は「動かない」位置なのに——`BACDE` と入れ替わった)
   * 挿す位置は「抜いたあとの並び」で数え直す。
   */
  moveClipToIndex: (clipId, targetIndex) =>
    set((state) => {
      const clips = [...state.project.clips]
      const fromIndex = clips.findIndex((c) => c.id === clipId)
      if (fromIndex === -1) return state
      // NaN だけ先に落とす。`Math.min/max` は NaN を素通しして `splice` が 0 扱いにするので、
      // 「先頭に入った」ように見えて理由が追えなくなる。±Infinity はそのまま挟めば端に着く。
      const wanted = Number.isNaN(targetIndex) ? 0 : targetIndex
      const insertAt = Math.max(0, Math.min(Math.trunc(wanted), clips.length))
      const adjusted = insertAt > fromIndex ? insertAt - 1 : insertAt
      if (adjusted === fromIndex) return state
      const [moved] = clips.splice(fromIndex, 1)
      clips.splice(adjusted, 0, moved)
      return { ...pushHistory(state), project: { ...state.project, clips } }
    }),

  setAspectRatio: (ratio) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, aspectRatio: ratio }
    })),

  selectClip: (clipId) =>
    set(
      clipId
        ? { selectedClipId: clipId, multiSelectedClipIds: [clipId], selectedOverlayId: null }
        : { selectedClipId: null, multiSelectedClipIds: [] }
    ),
  setMultiSelectedClipIds: (clipIds) => set({ multiSelectedClipIds: clipIds }),
  // テロップを選んだら本編クリップの選択は外す(選択は常に1種類だけ。理由は Timeline の selectOnly)
  selectOverlay: (id) =>
    set(
      id
        ? { selectedOverlayId: id, selectedClipId: null, multiSelectedClipIds: [] }
        : { selectedOverlayId: null }
    ),
  setPlayheadTime: (t) => set({ playheadTime: t }),
  setIsPlaying: (p) => set({ isPlaying: p }),
  togglePlayback: () =>
    set((state) => {
      if (state.isPlaying) return { isPlaying: false }
      // 末尾で止まった状態から再生を押すと、絵の要素は最後のクリップの終端に
      // いるので play() してもすぐ「次が無い」で止め直され、何も起きなかった。
      // 末尾(往復の丸めぶんを見て 0.1 秒手前まで)なら先頭へ戻してから再生する
      const total = getTotalDuration(state.project)
      if (total > 0 && state.playheadTime >= total - 0.1) {
        return {
          isPlaying: true,
          playheadTime: 0,
          seekRequest: { time: 0, token: (state.seekRequest?.token ?? 0) + 1 }
        }
      }
      return { isPlaying: true }
    }),
  seekTo: (t) =>
    set((state) => ({
      playheadTime: t,
      seekRequest: { time: t, token: (state.seekRequest?.token ?? 0) + 1 }
    })),

  copySelectedClip: () => {
    const state = get()
    const idSet = new Set(
      state.multiSelectedClipIds.length > 0
        ? state.multiSelectedClipIds
        : state.selectedClipId
          ? [state.selectedClipId]
          : []
    )
    const clips = state.project.clips.filter((c) => idSet.has(c.id))
    if (clips.length > 0) set({ clipboardClips: clips })
  },

  pasteClip: () =>
    set((state) => {
      if (state.clipboardClips.length === 0) return state
      // **コピーした後に素材が消えることがある。** クリップボードは素材IDしか覚えていない
      // ので、コピー後にその素材を削除してから貼り付けると、タイムラインにもプレビューにも
      // 出ない（buildTimedClips が素材の無いクリップを捨てる）クリップが project.clips
      // だけに残る。選ぶことも消すこともできないのに、以降の書き出しは毎回
      // 「アセットが見つかりません」で失敗する（実測: 貼り付け直後にクリップ数2・画面のクリップ数1、
      // 書き出しは Error: アセットが見つかりません: a1）。消えた素材のぶんは貼らない。
      // 素材削除を取り消せば同じIDが戻るので、クリップボードは捨てずに残す。
      const assetIds = new Set(state.project.assets.map((a) => a.id))
      // コピーした後に素材を短いファイルへ差し替えていれば、その尺に収める
      // (素材の終わりを越えた範囲のまま貼っていた)。収まる所が無ければ貼らない
      const pastable = state.clipboardClips
        .filter((c) => assetIds.has(c.assetId))
        .map((c) => {
          const duration = assetDurationOf(state.project, c.assetId)
          if (typeof duration === 'number' && duration > 0 && c.inPoint >= duration) return null
          return clampSourceRange(c, c.inPoint, c.outPoint, duration)
        })
        .filter((c): c is Clip => c !== null)
      if (pastable.length === 0) return state
      const newClips: Clip[] = pastable.map((c) => ({
        ...c,
        id: uuid(),
        transitionIn: undefined,
        audioDetached: copiedAudioDetached(state.project, c)
      }))
      const idx = state.project.clips.findIndex((c) => c.id === state.selectedClipId)
      const clips = [...state.project.clips]
      if (idx === -1) {
        clips.push(...newClips)
      } else {
        clips.splice(idx + 1, 0, ...newClips)
      }
      return {
        ...pushHistory(state),
        project: { ...state.project, clips },
        selectedClipId: newClips[newClips.length - 1].id,
        multiSelectedClipIds: newClips.map((c) => c.id)
      }
    }),

  undo: () => {
    resetHistoryCoalescing()
    set((state) => {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      const idSet = new Set(previous.clips.map((c) => c.id))
      return {
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, MAX_HISTORY),
        project: keepBackgroundResults(previous, state.project),
        // Undoing changes the document relative to what was last written to disk.
        // Without this the save button stays disabled, the close prompt never
        // appears and no recovery draft is written — the undo is silently lost.
        isDirty: true,
        selectedClipId: idSet.has(state.selectedClipId ?? '') ? state.selectedClipId : null,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => idSet.has(id)),
        selectedOverlayId: overlayStillThere(previous, state.selectedOverlayId),
        // 巻き戻したプロジェクトのパスで印を付け直す。ここを飛ばすと、再リンクを
        // 取り消して**パスが実在しないものへ戻ったのに印だけ消えたまま**になり、
        // 書き出し前の「再リンクしてください」の案内も出ずに ffmpeg が失敗する。
        missingAssetIds: missingIdsFor(previous, state.missingAssetPaths)
      }
    })
  },

  redo: () => {
    resetHistoryCoalescing()
    set((state) => {
      if (state.future.length === 0) return state
      const [next, ...rest] = state.future
      const idSet = new Set(next.clips.map((c) => c.id))
      return {
        past: [...state.past, state.project].slice(-MAX_HISTORY),
        future: rest,
        project: keepBackgroundResults(next, state.project),
        isDirty: true,
        selectedClipId: idSet.has(state.selectedClipId ?? '') ? state.selectedClipId : null,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => idSet.has(id)),
        selectedOverlayId: overlayStillThere(next, state.selectedOverlayId),
        missingAssetIds: missingIdsFor(next, state.missingAssetPaths)
      }
    })
  },

  addTextOverlay: (overlay) => {
    const id = uuid()
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        textOverlays: [...state.project.textOverlays, { ...overlay, id }]
      }
    }))
    return id
  },

  addTextOverlays: (overlays) =>
    set((state) => {
      if (overlays.length === 0) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          textOverlays: [
            ...state.project.textOverlays,
            ...overlays.map((o) => ({ ...o, id: uuid() }))
          ]
        }
      }
    }),

  replaceTelopText: (query, replacement, options) => {
    let count = 0
    set((state) => {
      const only = options?.ids ? new Set(options.ids) : null
      const textOverlays = state.project.textOverlays.map((o) => {
        if (only && !only.has(o.id)) return o
        const text = replaceInTelop(o.text, query, replacement, options)
        if (text === o.text) return o
        count++
        // 文字を変えたので単語の時刻(カラオケ)は使えない
        return { ...o, text, words: undefined, ...(autoTelopKey(o) ? { edited: true } : {}) }
      })
      if (count === 0) return state
      return { ...pushHistory(state), project: { ...state.project, textOverlays } }
    })
    return count
  },

  updateTextOverlay: (id, patch) =>
    set((state) => {
      const current = state.project.textOverlays.find((o) => o.id === id)
      if (!current) return state
      // 数値欄は空欄や指数表記から NaN/Infinity を作れる。時刻をそのまま保存すると
      // プレビューから消えるだけでなく、ASS/書き出しの時刻計算まで非有限値で汚染する。
      // 開始は0未満へ出さず、終了は必ず開始以降にする。片側だけの更新でも現在値を基準に整える。
      const safePatch = { ...patch }
      if (safePatch.startTime !== undefined) {
        if (!Number.isFinite(safePatch.startTime)) return state
        safePatch.startTime = Math.max(0, safePatch.startTime)
      }
      if (safePatch.endTime !== undefined) {
        if (!Number.isFinite(safePatch.endTime)) return state
        safePatch.endTime = Math.max(0, safePatch.endTime)
      }
      const nextStart = safePatch.startTime ?? current.startTime
      if (safePatch.endTime !== undefined)
        safePatch.endTime = Math.max(nextStart, safePatch.endTime)
      else if (safePatch.startTime !== undefined && current.endTime < nextStart)
        safePatch.endTime = nextStart

      // 追従中に開始時刻を直接いじったら、相対位置の方を更新する。そうしないと
      // 直後の追従補正が古い相対位置から計算し直して、編集をなかったことにしてしまう。
      const timedById =
        safePatch.startTime !== undefined
          ? new Map(buildTimedClips(state.project).map((tc) => [tc.clip.id, tc]))
          : null
      return {
        ...pushHistory(state, `overlay:${id}`),
        project: {
          ...state.project,
          textOverlays: state.project.textOverlays.map((o) => {
            if (o.id !== id) return o
            const next = { ...o, ...safePatch }
            // 自動で置いたテロップを人が直したら印を付ける(作り直しで上書きしない)
            if (autoTelopKey(o) && isManualEdit(safePatch)) next.edited = true
            // 位置を動かす更新なら単語も連れていく。`patch.words` を明示的に渡された
            // ときはそちらが正なので触らない(自動テロップの作り直しなど)。
            if (safePatch.startTime !== undefined && safePatch.words === undefined) {
              next.words = shiftOverlayWords(o.words, safePatch.startTime - o.startTime)
            }
            if (timedById && next.linkedClipId && safePatch.startTime !== undefined) {
              const tc = timedById.get(next.linkedClipId)
              if (tc) next.linkOffset = safePatch.startTime - tc.start
            }
            return next
          })
        }
      }
    }),

  updateTextOverlaysStyle: (ids, patch) =>
    set((state) => {
      const idSet = new Set(ids)
      if (idSet.size === 0) return state
      if (!state.project.textOverlays.some((o) => idSet.has(o.id))) return state
      const placementOnly = Object.keys(patch).every(
        (k) => k === 'position' || k === 'customPosition'
      )
      return {
        // 何件掛けても履歴は1件。合体キーを付けているのは、色や数値を連続で
        // 動かしたときに1回の調整で履歴が埋まらないようにするため(1件用と同じ考え方)。
        // キーには選んだテロップを含める(別のテロップへの変更まで1回の取り消しで戻っていた)
        ...pushHistory(state, `overlaysStyle:${[...idSet].sort().join(',')}`),
        project: {
          ...state.project,
          textOverlays: state.project.textOverlays.map((o) =>
            idSet.has(o.id)
              ? {
                  ...o,
                  style: { ...o.style, ...patch },
                  // 見た目を変えたらスタイルとのつながりを外す(置き場所だけなら保つ)
                  styleId: placementOnly ? o.styleId : undefined,
                  ...(autoTelopKey(o) ? { edited: true } : {})
                }
              : o
          )
        }
      }
    }),

  // 追従のON/OFF。ONにするときだけ相対位置を測り直す。OFFはその時点の絶対時刻で固定
  // されるので、時刻はいじらない。
  setTextOverlayLink: (id, clipId) =>
    set((state) => {
      const overlay = state.project.textOverlays.find((o) => o.id === id)
      if (!overlay) return state
      const tc = clipId ? buildTimedClips(state.project).find((t) => t.clip.id === clipId) : null
      if (clipId && !tc) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          textOverlays: state.project.textOverlays.map((o) =>
            o.id === id
              ? tc
                ? { ...o, linkedClipId: tc.clip.id, linkOffset: o.startTime - tc.start }
                : { ...o, linkedClipId: undefined, linkOffset: undefined }
              : o
          )
        }
      }
    }),

  applyRoughCut: (cut, telops, overrides) =>
    set((state) => {
      const rebuilt: Clip[] = cut.main.map((m) => ({
        id: uuid(),
        assetId: m.assetId,
        inPoint: m.inPoint,
        outPoint: m.outPoint,
        speed: m.speed,
        // 本編のカメラの音は使わない(声はピンマイク、周りの音は別トラック)
        audioDetached: true
      }))
      // 人が本編に入れた収録素材以外のクリップ(差し込みの画・静止画・タイトル)は消さずに、
      // 直前の収録素材のクリップの続きに入れ直す(同じクリップなので、結び付いたテロップも外れない)
      const clips = state.project.multicam
        ? reinsertExtraClips(state.project.clips, rebuilt, state.project.multicam)
        : rebuilt
      // 本編のクリップは作り直すと ID が変わるので、本編に紐づけた手置きのテロップ・分離音声を、
      // 同じ共通の時刻を映す新しいクリップへ紐づけ直す(しないと紐づきが外れ、元の時刻に取り残される)
      const relink = relinkToRebuiltClips(state.project.clips, clips, state.project.multicam)
      const previousTracks = new Map(
        state.project.audioTracks
          .filter((t) => t.multicamSourceId)
          .map((t) => [t.multicamSourceId!, t])
      )
      const audioTracks: AudioTrack[] = [
        ...state.project.audioTracks
          .filter((t) => !t.multicamSourceId)
          .map((t) =>
            t.clips.some((c) => c.linkedClipId)
              ? {
                  ...t,
                  clips: t.clips.map((c) => {
                    if (!c.linkedClipId) return c
                    const to = relink(c.linkedClipId, 0, c.assetId)
                    return to ? { ...c, linkedClipId: to.id } : { ...c, linkedClipId: undefined }
                  })
                }
              : t
          ),
        ...cut.audio.map((a) => {
          // 人が決めた消音・ダッキング・音量(仮編集が決めた値から変えたもの)は作り直しても残す
          const prev = previousTracks.get(a.sourceId)
          const volumeChanged =
            prev !== undefined && prev.autoVolume !== undefined && prev.volume !== prev.autoVolume
          return {
            id: uuid(),
            name: a.name,
            multicamSourceId: a.sourceId,
            muted: prev?.muted ?? a.muted ?? false,
            volume: volumeChanged ? prev!.volume : a.volume,
            autoVolume: a.volume,
            duckingEnabled: prev?.duckingEnabled ?? false,
            voice: carriesVoice(state.project.multicam?.sources.find((x) => x.id === a.sourceId)),
            clips: a.clips.map((c) => ({
              id: uuid(),
              assetId: c.assetId,
              startTime: c.startTime,
              inPoint: c.inPoint,
              outPoint: c.outPoint,
              ...(Math.abs(c.speed - 1) > 1e-9 ? { speed: c.speed } : {}),
              // 時間の飛ぶ切れ目の短いフェード(プツッという音を消す)
              ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
              ...(c.fadeOut ? { fadeOut: c.fadeOut } : {})
            }))
          }
        })
      ]
      // 本編に残した差し込みの画(静止画・タイトルなど)の分だけ、後ろの声とテロップを後ろへずらす。
      // 仮編集の声・テロップの時刻は差し込みの無いタイムラインのものなので、そのままだと差し込みの長さだけずれる
      const fresh: Project = {
        ...state.project,
        clips,
        audioTracks,
        // 全アングルを本編で切り替えるので、同期で作った PiP のカメラは外す。
        // ワイプで常に出すカメラ(ゲーム実況の顔カメラ)は、本編と同じ区間で並べ直す
        // (人が変えた置き場所・大きさ・表示は残す)
        videoOverlayTracks: [
          ...state.project.videoOverlayTracks.filter((t) => !t.multicamSourceId),
          ...(cut.overlays ?? []).map((o) => {
            const prev = state.project.videoOverlayTracks.find(
              (t) => t.multicamSourceId === o.sourceId
            )
            return {
              id: uuid(),
              name: o.name,
              multicamSourceId: o.sourceId,
              hidden: prev?.hidden ?? false,
              audioMuted: prev ? prev.audioMuted : true,
              position: prev?.position ?? FACE_PIP_POSITION,
              scale: prev?.scale ?? FACE_PIP_SCALE,
              clips: o.clips.map((c) => ({ id: uuid(), ...c }))
            }
          })
        ],
        // 作り直すときに今の本編と比べられるよう、組んだ本編を共通の時刻で覚える
        roughCutAuto: state.project.multicam
          ? coverageOfClips(cut.main, state.project.multicam)
          : undefined,
        cutOverrides: hasOverrides(overrides) ? overrides : undefined,
        // 人が直したテロップは文字と見た目を残し、人が消したものは足し直さない。
        // 直した内容はプロジェクトに覚える(場面を落として外れても、戻したときに直した内容で出す)
        editedTelops: rememberEditedTelops(state.project.textOverlays, state.project.editedTelops),
        textOverlays: [
          ...state.project.textOverlays
            .filter((o) => !o.utteranceId && !o.effectId)
            .map((o) => {
              if (!o.linkedClipId) return o
              const to = relink(o.linkedClipId, o.linkOffset ?? 0)
              return to
                ? { ...o, linkedClipId: to.id, linkOffset: to.offset }
                : { ...o, linkedClipId: undefined, linkOffset: undefined }
            }),
          ...mergeManualTelops(
            state.project.textOverlays,
            telops,
            new Set(state.project.dismissedTelops ?? []),
            state.project.editedTelops
          ).map((o) => ({ ...o, id: uuid() }))
        ]
      }
      const rebuiltProject =
        clips !== rebuilt && state.project.multicam
          ? followMainEdit({ ...fresh, clips: rebuilt }, fresh, true)
          : fresh
      return {
        __noFollow: true,
        ...pushHistory(state),
        selectedClipId: null,
        multiSelectedClipIds: [],
        selectedOverlayId: null,
        project: rebuiltProject
      }
    }),

  setEffectTelops: (telops, speech, undismiss) =>
    set((state) => {
      const dismissedTelops = (state.project.dismissedTelops ?? []).filter(
        (k) => !undismiss?.includes(k)
      )
      const dismissed = new Set(dismissedTelops)
      // 置いたままの演出テロップは、今の時刻を残す(1つ選び直しただけで、人が動かした他のものが戻らないように)
      const placedAt = new Map(
        state.project.textOverlays
          .filter((o) => o.effectId)
          .map((o) => [o.effectId!, { startTime: o.startTime, endTime: o.endTime }])
      )
      telops = telops.map((t) =>
        t.effectId && placedAt.has(t.effectId) ? { ...t, ...placedAt.get(t.effectId)! } : t
      )
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          dismissedTelops: dismissedTelops.length > 0 ? dismissedTelops : undefined,
          editedTelops: rememberEditedTelops(
            state.project.textOverlays,
            state.project.editedTelops
          ),
          textOverlays: [
            ...state.project.textOverlays.filter(
              (o) => !o.effectId && (!speech || o.utteranceId !== speech.utteranceId)
            ),
            ...(speech
              ? mergeManualTelops(
                  state.project.textOverlays,
                  speech.telops,
                  dismissed,
                  state.project.editedTelops
                ).map((o) => ({ ...o, id: uuid() }))
              : []),
            ...mergeManualTelops(
              state.project.textOverlays,
              telops,
              dismissed,
              state.project.editedTelops
            ).map((o) => ({ ...o, id: uuid() }))
          ]
        }
      }
    }),

  setTranscript: (transcript) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, transcript }
    })),

  setColorMatches: (matches) =>
    set((state) => {
      const ids = Object.keys(matches)
      if (!state.project.assets.some((a) => ids.includes(a.id))) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          assets: state.project.assets.map((a) =>
            a.id in matches ? { ...a, colorMatch: matches[a.id] } : a
          )
        }
      }
    }),

  setAutoCg: (clips, newAssets) =>
    set((state) => {
      const assets = [...state.project.assets]
      for (const a of newAssets) if (!assets.some((x) => x.filePath === a.filePath)) assets.push(a)
      const idOf = new Map(assets.map((a) => [a.filePath, a.id]))
      const placed = clips.filter((c) => idOf.has(c.path))
      const kept = state.project.videoOverlayTracks
        .filter((t) => !isUntouchedAuto(t))
        .map((t) => (t.autoRole ? { ...t, autoSignature: undefined } : t))
      // 手で直した CG のトラックがあれば、新しくは置かない(二重にしない)
      const cgEdited = kept.some((t) => t.autoRole === 'cg')
      const track: VideoOverlayTrack | null =
        placed.length > 0 && !cgEdited
          ? withAutoSignature({
              id: uuid(),
              name: 'CG(自動)',
              hidden: false,
              position: 'full',
              scale: 1,
              autoRole: 'cg',
              clips: placed.map((c) => ({
                id: uuid(),
                assetId: idOf.get(c.path)!,
                startTime: c.startTime,
                inPoint: c.inPoint,
                outPoint: c.outPoint
              }))
            })
          : null
      // 履歴には積まないが、未保存にする(保存の途中に届いた CG が、保存済みと扱われて残らなかった)
      return {
        isDirty: true,
        project: {
          ...state.project,
          assets,
          videoOverlayTracks: track ? [...kept, track] : kept
        }
      }
    }),

  setAutoSounds: (sounds, newAssets) =>
    set((state) => {
      const assets = [...state.project.assets]
      for (const a of newAssets) if (!assets.some((x) => x.filePath === a.filePath)) assets.push(a)
      const idOf = new Map(assets.map((a) => [a.filePath, a.id]))
      const NAMES = { se: 'SE(自動)', bgm: 'BGM(自動)' } as const
      const tracks: AudioTrack[] = sounds
        .filter((x) => x.clips.length > 0)
        .map((x) =>
          withAutoSignature({
            id: uuid(),
            name: NAMES[x.role],
            muted: false,
            volume: 1,
            // BGM は声の間だけ下げる
            duckingEnabled: x.role === 'bgm',
            autoRole: x.role,
            clips: x.clips
              .filter((c) => idOf.has(c.path))
              .map((c) => ({
                id: uuid(),
                assetId: idOf.get(c.path)!,
                startTime: c.startTime,
                inPoint: c.inPoint,
                outPoint: c.outPoint,
                volume: c.volume,
                ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
                ...(c.fadeOut ? { fadeOut: c.fadeOut } : {})
              }))
          })
        )
      // 手で直した自動のトラックは消さずに残す(種類の印は残し、要約を外して「手で直した」にする)。
      // その種類は新しく置かない(置くと SE が二重に鳴り、BGM が2曲同時に流れる)
      const kept = state.project.audioTracks
        .filter((t) => !isUntouchedAuto(t))
        .map((t) => (t.autoRole ? { ...t, autoSignature: undefined } : t))
      const editedRoles = new Set(kept.filter((t) => t.autoRole).map((t) => t.autoRole))
      // 履歴には積まないが、未保存にする(保存の途中に届いた SE・BGM が、保存済みと扱われて残らなかった)
      return {
        isDirty: true,
        project: {
          ...state.project,
          assets,
          audioTracks: [...kept, ...tracks.filter((t) => !editedRoles.has(t.autoRole))]
        }
      }
    }),

  // 笑い・歓声の検出結果は企画ファイルに保存するもの(作り直せるプロキシとは違う)。
  // 取り消しの履歴には積まないが、未保存にする(保存の途中に届いても、保存済みと扱わない)
  setAudioEvents: (events) =>
    set((state) => ({
      isDirty: true,
      project: { ...state.project, audioEvents: events }
    })),

  setAssetsDenoised: (changes, options) =>
    set((state) => {
      let changed = false
      const assets = state.project.assets.map((a) => {
        if (!(a.id in changes)) return a
        const cleaned = changes[a.id]
        if (cleaned) {
          if (a.filePath === cleaned) return a
          changed = true
          // プレビューのプロキシは差し替える前の録音から作ったもの。残すとプレビューだけノイズのある音が鳴る
          // (ノイズを除いた音声は FLAC で、そのまま再生できる)。元へ戻すときのために覚えておく
          return {
            ...a,
            filePath: cleaned,
            denoisedFrom: a.denoisedFrom ?? a.filePath,
            proxyPath: undefined,
            proxyBeforeDenoise: a.denoisedFrom ? a.proxyBeforeDenoise : a.proxyPath
          }
        }
        if (!a.denoisedFrom) return a
        changed = true
        return {
          ...a,
          filePath: a.denoisedFrom,
          denoisedFrom: undefined,
          proxyPath: a.proxyBeforeDenoise,
          proxyBeforeDenoise: undefined
        }
      })
      if (!changed) return state
      return {
        // 開いたときの自動の戻しは取り消しの履歴に積まないが、書き出しに使うファイルが変わるので
        // 未保存にする(保存しないと、開くたびに同じ戻しが起き、閉じるときの警告も出なかった)
        ...(options?.history === false ? { isDirty: true } : pushHistory(state)),
        project: { ...state.project, assets }
      }
    }),

  switchClipAngle: (clipId, sourceId) =>
    set((state) => {
      const info = state.project.multicam
      const clip = state.project.clips.find((c) => c.id === clipId)
      if (!info || !clip) return state
      const found = angleAlternatives(clip, info).find((a) => a.sourceId === sourceId)?.clip
      if (!found) return state
      // 人が変えた速さ(素材の速さとの比)を保つ。素材の速さに戻すと長さが変わり、後ろが全部ずれる
      const currentRate = info.files.find((f) => f.assetId === clip.assetId)?.rate || 1
      const alt = { ...found, speed: found.speed * ((clip.speed || 1) / currentRate) }
      // 分離した音声(このクリップに紐づく音声クリップ)も同じカメラへ替える。
      // 替えないと、映像は新しいカメラ・音は前のカメラのまま、前のカメラの素材に新しいカメラの
      // in/out が写され、カメラ間の時刻のずれの分だけ音がずれる(実測: 3秒)
      const altAsset = state.project.assets.find((a) => a.id === alt.assetId)
      const altHasAudio = altAsset?.hasAudio !== false
      const linked = state.project.audioTracks.some((t) =>
        t.clips.some((c) => c.linkedClipId === clipId)
      )
      const audioTracks = !linked
        ? state.project.audioTracks
        : state.project.audioTracks
            .map((t) => {
              if (!t.clips.some((c) => c.linkedClipId === clipId)) return t
              const clips = altHasAudio
                ? t.clips.map((c) =>
                    c.linkedClipId === clipId
                      ? {
                          ...c,
                          assetId: alt.assetId,
                          inPoint: alt.inPoint,
                          outPoint: alt.outPoint,
                          speed: alt.speed
                        }
                      : c
                  )
                : t.clips.filter((c) => c.linkedClipId !== clipId)
              return { ...t, clips }
            })
            // 外して空になったトラックだけ消す(人が用意した空のトラックは残す)
            .filter((t, i) => t.clips.length > 0 || state.project.audioTracks[i].clips.length === 0)
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) =>
            c.id !== clipId
              ? c
              : // 新しいカメラに音が無いので、分離した音声ごと外した。分離の印も戻す
                linked && !altHasAudio
                ? { ...c, ...alt, audioDetached: false }
                : { ...c, ...alt }
          ),
          audioTracks
        }
      }
    }),

  setReviewed: (key, reviewed) =>
    set((state) => {
      const cur = state.project.reviewed ?? []
      const next = reviewed ? [...new Set([...cur, key])] : cur.filter((k) => k !== key)
      if (next.length === cur.length && next.every((k, i) => k === cur[i])) return state
      // 履歴に積む(未保存の印も立つ)。積まないと、自動保存に拾われず閉じても警告が出ないうえ、
      // 手前の編集を取り消したときに、その時点の企画ごと印が消える
      return {
        ...pushHistory(state),
        project: { ...state.project, reviewed: next.length > 0 ? next : undefined }
      }
    }),

  undismissTelops: (keys) =>
    set((state) => {
      const cur = state.project.dismissedTelops ?? []
      const next = cur.filter((k) => !keys.includes(k))
      if (next.length === cur.length) return state
      return {
        ...pushHistory(state),
        project: { ...state.project, dismissedTelops: next.length > 0 ? next : undefined }
      }
    }),

  restyleSpeechTelops: (prev, next, styles) => {
    const state = get()
    const updated = restyleSpeechTelops(
      state.project.textOverlays,
      prev,
      next,
      styles,
      textCanvasSize(state.project.aspectRatio).h
    )
    const changed = updated.filter((o, i) => o !== state.project.textOverlays[i]).length
    // 場面を落として今タイムラインに無い、人が直した発言テロップにも当てる
    const editedTelops = restyleEditedSpeech(state.project.editedTelops, prev, next, styles)
    if (changed > 0 || editedTelops !== state.project.editedTelops)
      set({
        ...pushHistory(state),
        project: { ...state.project, textOverlays: updated, editedTelops }
      })
    return changed
  },

  restyleTextOverlays: (styles) =>
    set((state) => {
      const next = restyleOverlays(state.project.textOverlays, styles)
      if (next.every((o, i) => o === state.project.textOverlays[i])) return state
      return {
        ...pushHistory(state),
        project: { ...state.project, textOverlays: next }
      }
    }),

  removeTextOverlay: (id) =>
    set((state) => ({
      ...pushHistory(state),
      selectedOverlayId: state.selectedOverlayId === id ? null : state.selectedOverlayId,
      project: {
        ...state.project,
        textOverlays: state.project.textOverlays.filter((o) => o.id !== id),
        dismissedTelops: withDismissed(
          state.project.dismissedTelops,
          state.project.textOverlays.find((o) => o.id === id)
        )
      }
    })),

  /**
   * 全テロップをまとめてずらす。**頭打ちは1件ずつではなく、まとまり全体に掛ける。**
   *
   * `Math.max(0, o.startTime + delta)` を1件ずつ掛けると、0 にぶつかったものだけが
   * その場に残り、**テロップ同士の間隔が壊れる**。しかも壊れるのは「動かしすぎた」
   * ときだけなので、行き過ぎたと気付いて同じ量を逆へ適用しても**元に戻らない**。
   * 自動テロップは1件ずつが発話に合わせた時刻を持っているので、間隔が縮んだぶん
   * **そのテロップだけ音とずれたまま**になる。エラーも警告も出ない。
   * (実測: 1〜3 / 5〜7 / 9〜11 の3件(間隔 4,4)を「逆方向に3秒」→
   *  **0〜2 / 2〜4 / 6〜8(間隔 2,4)**。そのまま「正方向に3秒」で戻しても
   *  **3〜5 / 5〜7 / 9〜11(間隔 2,4)** で、先頭が 1 秒から 3 秒へずれたまま)
   *
   * 動かせる量は「一番早いテロップが 0 まで下がれる分」。そこで頭打ちにすれば
   * **全員が同じ量だけ動く**ので間隔は保たれ、逆へ適用すれば同じ量だけ戻る
   * (0 で止めた分は原理的に戻らないが、**崩れるのは位置だけで並びは保たれる**)。
   *
   * 動かす量が 0 になるとき(0 秒を指定した・これ以上左へ動かせない)は
   * **何も変えない**。同じ中身で履歴を1件積むと、取り消しを押しても
   * 何も起きないように見えるだけになる。
   */
  shiftAllTextOverlays: (deltaSeconds) =>
    set((state) => {
      const overlays = state.project.textOverlays
      if (overlays.length === 0) return state
      // 数値でない値をそのまま足すと、全テロップの時刻が NaN / Infinity になって
      // 画面からも書き出しからも消える。入口(数値欄)は空欄を 0 にするが、
      // `1e309` のような指数表記は `Infinity` になって通ってしまう。
      if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) return state
      // 一番早いテロップは `reduce` で求める。`Math.min(...arr)` は件数が増えると
      // 引数の上限に当たりうるので、件数に依らない形にしておく。
      const earliest = overlays.reduce(
        (min, o) => (Number.isFinite(o.startTime) && o.startTime < min ? o.startTime : min),
        Infinity
      )
      const room = Number.isFinite(earliest) ? Math.max(0, earliest) : 0
      const shift = deltaSeconds < 0 ? Math.max(deltaSeconds, -room) : deltaSeconds
      if (shift === 0) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          textOverlays: overlays.map((o) => ({
            ...o,
            startTime: o.startTime + shift,
            endTime: o.endTime + shift,
            words: shiftOverlayWords(o.words, shift),
            // 本編に紐づくテロップは、紐づけの位置もずらす(ずらさないと、紐づけが元の位置へ引き戻す)
            ...(o.linkedClipId ? { linkOffset: (o.linkOffset ?? 0) + shift } : {})
          }))
        }
      }
    }),

  addAudioTrack: (name) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: [
          ...state.project.audioTracks,
          { id: uuid(), name, muted: false, volume: 1, duckingEnabled: false, clips: [] }
        ]
      }
    })),

  removeAudioTrack: (trackId) =>
    set((state) => {
      const track = state.project.audioTracks.find((t) => t.id === trackId)
      if (!track) return state
      const unlinked = track.clips
        .map((c) => c.linkedClipId)
        .filter((id): id is string => id != null)
      return {
        ...pushHistory(state),
        project: reattachClipsWithoutLinkedAudio(
          {
            ...state.project,
            audioTracks: state.project.audioTracks.filter((t) => t.id !== trackId)
          },
          unlinked
        )
      }
    }),

  toggleAudioTrackMute: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId ? { ...t, muted: !t.muted } : t
        )
      }
    })),

  toggleAudioTrackDucking: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId ? { ...t, duckingEnabled: !t.duckingEnabled } : t
        )
      }
    })),

  setAudioTrackVolume: (trackId, volume) =>
    set((state) =>
      !Number.isFinite(volume)
        ? state
        : {
            ...pushHistory(state, `trackVolume:${trackId}`),
            project: {
              ...state.project,
              audioTracks: state.project.audioTracks.map((t) =>
                t.id === trackId ? { ...t, volume: Math.max(0, volume) } : t
              )
            }
          }
    ),

  addClipToAudioTrack: (trackId, assetId) =>
    set((state) => {
      const asset = state.project.assets.find((a) => a.id === assetId)
      if (!asset) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          audioTracks: state.project.audioTracks.map((t) => {
            if (t.id !== trackId) return t
            const startTime = audioTrackEnd(t)
            return {
              ...t,
              clips: [
                ...t.clips,
                { id: uuid(), assetId, startTime, inPoint: 0, outPoint: asset.duration }
              ]
            }
          })
        }
      }
    }),

  updateAudioClipStart: (trackId, clipId, startTime) =>
    set((state) =>
      !Number.isFinite(startTime)
        ? state
        : {
            ...pushHistory(state, `audioStart:${clipId}`),
            project: {
              ...state.project,
              audioTracks: state.project.audioTracks.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      clips: t.clips.map((c) =>
                        c.id === clipId
                          ? { ...c, startTime: Math.max(0, startTime), linkedClipId: undefined }
                          : c
                      )
                    }
                  : t
              )
            }
          }
    ),

  // トラックをまたぐ移動は「元から外す」と「先へ足す」の2手だが、利用者にとっては
  // 1回のドラッグなので履歴も1件にまとめる。手で動かした時点で本編への追従は切れる
  // (`updateAudioClipStart` と同じ扱い。追従したまま別トラックへ移すと、元クリップを
  // トリムした瞬間に戻ってきてしまう)。
  moveAudioClipToTrack: (fromTrackId, clipId, toTrackId, startTime) =>
    set((state) => {
      // 数値でない値(空欄・1e309 など)は書かない。NaN は取り消しの重複判定もすり抜ける
      if (!Number.isFinite(startTime)) return state
      const from = state.project.audioTracks.find((t) => t.id === fromTrackId)
      const clip = from?.clips.find((c) => c.id === clipId)
      if (!clip || fromTrackId === toTrackId) return state
      if (!state.project.audioTracks.some((t) => t.id === toTrackId)) return state
      const moved = { ...clip, startTime: Math.max(0, startTime), linkedClipId: undefined }
      // 分離した音はまだ鳴っているので、元のクリップの音は消したまま(戻すと台詞が二重に鳴っていた)
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          audioTracks: state.project.audioTracks.map((t) => {
            if (t.id === fromTrackId) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
            if (t.id === toTrackId) return { ...t, clips: [...t.clips, moved] }
            return t
          })
        }
      }
    }),

  updateAudioClipTrim: (trackId, clipId, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state, `audioTrim:${clipId}`),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? {
                        ...clampSourceRange(
                          c,
                          inPoint,
                          outPoint,
                          assetDurationOf(state.project, c.assetId)
                        ),
                        linkedClipId: undefined
                      }
                    : c
                )
              }
            : t
        )
      }
    })),

  // Dragging a clip's left trim handle moves startTime and inPoint together in one
  // undoable step (as opposed to updateAudioClipStart + updateAudioClipTrim, which
  // would otherwise push two separate history entries for a single drag gesture).
  updateAudioClipStartAndTrim: (trackId, clipId, startTime, inPoint, outPoint) =>
    set((state) =>
      !Number.isFinite(startTime) || !Number.isFinite(inPoint) || !Number.isFinite(outPoint)
        ? state
        : {
            ...pushHistory(state),
            project: {
              ...state.project,
              audioTracks: state.project.audioTracks.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      clips: t.clips.map((c) =>
                        c.id === clipId
                          ? {
                              ...clampSourceRange(
                                c,
                                inPoint,
                                outPoint,
                                assetDurationOf(state.project, c.assetId)
                              ),
                              startTime: Math.max(0, startTime),
                              linkedClipId: undefined
                            }
                          : c
                      )
                    }
                  : t
              )
            }
          }
    ),

  updateAudioClipVolume: (trackId, clipId, volume) =>
    set((state) =>
      !Number.isFinite(volume)
        ? state
        : {
            ...pushHistory(state, `audioVolume:${clipId}`),
            project: {
              ...state.project,
              audioTracks: state.project.audioTracks.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      clips: t.clips.map((c) =>
                        c.id === clipId ? { ...c, volume: Math.max(0, volume) } : c
                      )
                    }
                  : t
              )
            }
          }
    ),

  updateAudioClipFade: (trackId, clipId, fadeIn, fadeOut) =>
    set((state) =>
      !Number.isFinite(fadeIn) || !Number.isFinite(fadeOut)
        ? state
        : {
            // 音量と同じく合体キーを渡す。数値を続けて動かしても Undo は1件。
            ...pushHistory(state, `audioFade:${clipId}`),
            project: {
              ...state.project,
              audioTracks: state.project.audioTracks.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      clips: t.clips.map((c) =>
                        c.id === clipId
                          ? { ...c, fadeIn: Math.max(0, fadeIn), fadeOut: Math.max(0, fadeOut) }
                          : c
                      )
                    }
                  : t
              )
            }
          }
    ),

  swapAudioClipAsset: (trackId, clipId, assetId, outPoint) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? { ...c, assetId, inPoint: 0, outPoint, linkedClipId: undefined }
                    : c
                )
              }
            : t
        )
      }
    })),

  unlinkAudioClip: (trackId, clipId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) => (c.id === clipId ? { ...c, linkedClipId: undefined } : c))
              }
            : t
        )
      }
    })),

  removeAudioClip: (trackId, clipId) =>
    set((state) => {
      const removed = state.project.audioTracks
        .find((t) => t.id === trackId)
        ?.clips.find((c) => c.id === clipId)
      if (!removed) return state
      return {
        ...pushHistory(state),
        project: reattachClipsWithoutLinkedAudio(
          {
            ...state.project,
            audioTracks: state.project.audioTracks.map((t) =>
              t.id === trackId ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
            )
          },
          removed.linkedClipId ? [removed.linkedClipId] : []
        )
      }
    }),

  splitAudioClipAtTime: (trackId, clipId, absoluteTime) =>
    set((state) => {
      // 数値でない値(空欄・1e309 など)は書かない。NaN は取り消しの重複判定もすり抜ける
      if (!Number.isFinite(absoluteTime)) return state
      let didSplit = false
      const audioTracks = state.project.audioTracks.map((t) => {
        if (t.id !== trackId) return t
        return {
          ...t,
          clips: t.clips.flatMap((c) => {
            if (c.id !== clipId) return [c]
            const dur = audioClipDuration(c)
            if (absoluteTime <= c.startTime || absoluteTime >= c.startTime + dur) return [c]
            // タイムライン秒 → 素材秒は速度を掛ける(規則は toSourceSeconds)。
            const splitLocal = c.inPoint + toSourceSeconds(absoluteTime - c.startTime, c.speed)
            // 本編のカミソリと同じく、最短の長さに満たない断片は作らない(後で縮めると最短まで
            // 戻され、次の断片に重なって音が二重になる)
            if (
              splitLocal - c.inPoint < MIN_CLIP_SOURCE_DURATION ||
              c.outPoint - splitLocal < MIN_CLIP_SOURCE_DURATION
            )
              return [c]
            didSplit = true
            // フェードを両方へそのまま配ると、切れ目で音が一度落ちてまた上がる。
            // 規則は `splitFades` 1箇所に置く——ここに書き写していたころ、同じ割り方を
            // する他の3経路(本編のカミソリ・無音カットなどの置き換え・ジャンプカット)は
            // **どれも複製したままだった**。
            return splitFades([
              { ...c, outPoint: splitLocal, linkedClipId: undefined },
              {
                ...c,
                id: uuid(),
                startTime: absoluteTime,
                inPoint: splitLocal,
                linkedClipId: undefined
              }
            ])
          })
        }
      })
      if (!didSplit) return state
      return { ...pushHistory(state), project: { ...state.project, audioTracks } }
    }),

  addVideoOverlayTrack: (name) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: [
          ...state.project.videoOverlayTracks,
          { id: uuid(), name, hidden: false, position: 'top-right', scale: 0.32, clips: [] }
        ]
      }
    })),

  removeVideoOverlayTrack: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.filter((t) => t.id !== trackId)
      }
    })),

  toggleVideoOverlayTrackHidden: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId ? { ...t, hidden: !t.hidden } : t
        )
      }
    })),

  toggleVideoOverlayTrackAudio: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId ? { ...t, audioMuted: t.audioMuted ? undefined : true } : t
        )
      }
    })),

  setVideoOverlayTrackPosition: (trackId, position) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId ? { ...t, position } : t
        )
      }
    })),

  setVideoOverlayTrackScale: (trackId, scale) =>
    set((state) =>
      !Number.isFinite(scale)
        ? state
        : {
            ...pushHistory(state, `pipScale:${trackId}`),
            project: {
              ...state.project,
              videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
                t.id === trackId ? { ...t, scale: Math.min(0.6, Math.max(0.1, scale)) } : t
              )
            }
          }
    ),

  addClipToVideoOverlayTrack: (trackId, assetId, requestedStart) =>
    set((state) => {
      const asset = state.project.assets.find((a) => a.id === assetId)
      if (!asset) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          videoOverlayTracks: state.project.videoOverlayTracks.map((t) => {
            if (t.id !== trackId) return t
            const startTime =
              requestedStart === undefined || !Number.isFinite(requestedStart)
                ? videoOverlayTrackEnd(t)
                : Math.max(0, requestedStart)
            const outPoint = videoOverlayClipOutPoint(
              asset.duration,
              startTime,
              totalDuration(state.project)
            )
            return {
              ...t,
              clips: [...t.clips, { id: uuid(), assetId, startTime, inPoint: 0, outPoint }]
            }
          })
        }
      }
    }),

  updateVideoOverlayClipStart: (trackId, clipId, startTime) =>
    set((state) =>
      !Number.isFinite(startTime)
        ? state
        : {
            ...pushHistory(state, `pipStart:${clipId}`),
            project: {
              ...state.project,
              videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      clips: t.clips.map((c) =>
                        c.id === clipId ? { ...c, startTime: Math.max(0, startTime) } : c
                      )
                    }
                  : t
              )
            }
          }
    ),

  moveVideoOverlayClipToTrack: (fromTrackId, clipId, toTrackId, startTime) =>
    set((state) => {
      if (!Number.isFinite(startTime)) return state
      const from = state.project.videoOverlayTracks.find((t) => t.id === fromTrackId)
      const clip = from?.clips.find((c) => c.id === clipId)
      if (!clip || fromTrackId === toTrackId) return state
      if (!state.project.videoOverlayTracks.some((t) => t.id === toTrackId)) return state
      const moved = { ...clip, startTime: Math.max(0, startTime) }
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          videoOverlayTracks: state.project.videoOverlayTracks.map((t) => {
            if (t.id === fromTrackId) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
            if (t.id === toTrackId) return { ...t, clips: [...t.clips, moved] }
            return t
          })
        }
      }
    }),

  updateVideoOverlayClipTrim: (trackId, clipId, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state, `pipTrim:${clipId}`),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? clampSourceRange(
                        c,
                        inPoint,
                        outPoint,
                        assetDurationOf(state.project, c.assetId)
                      )
                    : c
                )
              }
            : t
        )
      }
    })),

  updateVideoOverlayClipStartAndTrim: (trackId, clipId, startTime, inPoint, outPoint) =>
    set((state) =>
      !Number.isFinite(startTime) || !Number.isFinite(inPoint) || !Number.isFinite(outPoint)
        ? state
        : {
            ...pushHistory(state),
            project: {
              ...state.project,
              videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
                t.id === trackId
                  ? {
                      ...t,
                      clips: t.clips.map((c) =>
                        c.id === clipId
                          ? {
                              ...clampSourceRange(
                                c,
                                inPoint,
                                outPoint,
                                assetDurationOf(state.project, c.assetId)
                              ),
                              startTime: Math.max(0, startTime)
                            }
                          : c
                      )
                    }
                  : t
              )
            }
          }
    ),

  swapVideoOverlayClipAsset: (trackId, clipId, assetId, outPoint) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId ? { ...c, assetId, inPoint: 0, outPoint } : c
                )
              }
            : t
        )
      }
    })),

  removeVideoOverlayClip: (trackId, clipId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
        )
      }
    })),

  splitVideoOverlayClipAtTime: (trackId, clipId, absoluteTime) =>
    set((state) => {
      // 数値でない値(空欄・1e309 など)は書かない。NaN は取り消しの重複判定もすり抜ける
      if (!Number.isFinite(absoluteTime)) return state
      let didSplit = false
      const videoOverlayTracks = state.project.videoOverlayTracks.map((t) => {
        if (t.id !== trackId) return t
        return {
          ...t,
          clips: t.clips.flatMap((c) => {
            if (c.id !== clipId) return [c]
            const dur = c.outPoint - c.inPoint
            if (absoluteTime <= c.startTime || absoluteTime >= c.startTime + dur) return [c]
            const splitLocal = c.inPoint + (absoluteTime - c.startTime)
            // 最短の長さに満たない断片は作らない(後で縮めると最短まで戻され、次の断片に重なる)
            if (
              splitLocal - c.inPoint < MIN_CLIP_SOURCE_DURATION ||
              c.outPoint - splitLocal < MIN_CLIP_SOURCE_DURATION
            )
              return [c]
            didSplit = true
            return [
              { ...c, outPoint: splitLocal },
              { ...c, id: uuid(), startTime: absoluteTime, inPoint: splitLocal }
            ]
          })
        }
      })
      if (!didSplit) return state
      return { ...pushHistory(state), project: { ...state.project, videoOverlayTracks } }
    }),

  addKeywordSeClips: (placements, newAssets) =>
    set((state) => {
      // **ワンクリックで足す経路は重ねて置かない。** 完全に覆われたクリップは画面では手前の1本と
      // 見分けが付かないのに、書き出しでは**そのまま足し算される**
      // (実測: 同じスキャンを2回で SE の区間が +6.0dB、近い2件の重なりでも +6.0dB)。
      // ただし後ろへずらすと言葉から何秒も離れて鳴る(「すごい拍手」の拍手の SE が 2 秒遅れて、
      // テロップが消えた後に鳴っていた)。ずらさず、空いている SE の段(SE・SE 2・SE 3)に置く。
      // 同じ素材が同じ時刻にすでにあれば置かない(スキャンを2回しても増えない)。
      // 段が足りなければ、従来どおり最初の段で後ろの空きへ
      const laneName = (i: number): string => (i === 0 ? 'SE' : `SE ${i + 1}`)
      const lanes: { id: string; name: string; existing: boolean; clips: AudioTrackClip[] }[] = []
      for (let i = 0; i < KEYWORD_SE_LANES; i++) {
        const t = state.project.audioTracks.find((x) => x.name === laneName(i))
        if (t) lanes.push({ id: t.id, name: t.name, existing: true, clips: [...t.clips] })
      }
      // スキャンの前からあったクリップ(段が埋まって後ろへずらしたものを、次のスキャンで見分ける)
      const before = new Set(lanes.flatMap((l) => l.clips.map((c) => c.id)))
      // 新しい段の名前は、まだ使っていない一番若い名前(SE 2 を消して SE・SE 3 が残っているとき、
      // 段の数から名前を付けると SE 3 が2本になっていた)
      const unusedLaneName = (): string | undefined => {
        for (let i = 0; i < KEYWORD_SE_LANES; i++)
          if (!lanes.some((l) => l.name === laneName(i))) return laneName(i)
        return undefined
      }
      const added = new Map<string, AudioTrackClip[]>()
      const free = (clips: readonly AudioTrackClip[], start: number, len: number): boolean =>
        clips.every(
          (c) =>
            start + len <= c.startTime + 1e-6 || start >= c.startTime + audioClipDuration(c) - 1e-6
        )
      const absorbed = new Set<string>()
      const ordered = placements
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p.startTime - b.p.startTime || a.i - b.i)
        .map((x) => x.p)
      for (const p of ordered) {
        // 数でない時刻・長さ(壊れた値)は置かない
        if (!Number.isFinite(p.startTime) || !(Number.isFinite(p.outPoint) && p.outPoint > 0))
          continue
        const start = Math.max(0, p.startTime)
        if (
          lanes.some((l) =>
            l.clips.some((c) => c.assetId === p.assetId && Math.abs(c.startTime - start) < 0.05)
          )
        )
          continue
        let lane = lanes.find((l) => free(l.clips, start, p.outPoint))
        const name = lane ? undefined : unusedLaneName()
        if (!lane && name !== undefined) {
          lane = { id: uuid(), name, existing: false, clips: [] }
          lanes.push(lane)
        }
        // 段が全部埋まっていて後ろへずらす場合: 前のスキャンで同じ言葉からずらして置いた同じ素材
        // (言葉の時刻から、今ずらすと置く位置までの間にある)があれば置かない
        // (スキャンし直すたびに、同じ SE がさらに後ろへ1本ずつ増えていた)
        // 1本のずらしたクリップが見分けるのは1件だけ(同じ素材の別の言葉まで「置いてある」として
        // 落とさない)。言葉の時刻の順に処理するので、早い言葉から先に見分ける
        if (!lane) {
          const at = findFreeAudioStart(lanes[0].clips, start, p.outPoint)
          const prior = lanes[0].clips.find(
            (c) =>
              before.has(c.id) &&
              !absorbed.has(c.id) &&
              c.assetId === p.assetId &&
              c.startTime >= start - 0.05 &&
              c.startTime <= at + 0.05
          )
          if (prior) {
            absorbed.add(prior.id)
            continue
          }
        }
        const clip: AudioTrackClip = {
          id: uuid(),
          assetId: p.assetId,
          startTime: lane ? start : findFreeAudioStart(lanes[0].clips, start, p.outPoint),
          inPoint: 0,
          outPoint: p.outPoint,
          volume: p.volume
        }
        const target = lane ?? lanes[0]
        target.clips.push(clip)
        added.set(target.id, [...(added.get(target.id) ?? []), clip])
      }
      if (added.size === 0 && !newAssets?.length) return state
      const audioTracks = [
        ...state.project.audioTracks.map((t) => {
          const more = added.get(t.id)
          return more ? { ...t, clips: [...t.clips, ...more] } : t
        }),
        ...lanes
          .filter((l) => !l.existing && added.has(l.id))
          .map((l) => ({
            id: l.id,
            name: l.name,
            muted: false,
            volume: 1,
            duckingEnabled: false,
            clips: added.get(l.id)!
          }))
      ]
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          // Registering the newly used SE files here keeps one scan = one undo step.
          assets: newAssets?.length
            ? [...state.project.assets, ...newAssets]
            : state.project.assets,
          audioTracks
        }
      }
    }),

  setBeatGrid: (grid) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, beatGrid: grid }
    })),

  // 検出値を手で直す用。数値欄を打っている間は coalesceKey で1件の Undo にまとめる
  // (1文字ごとに履歴が積まれると、打ち直す前の状態へ1回で戻れない)。
  updateBeatGrid: (patch, coalesceKey) =>
    set((state) => {
      const grid = state.project.beatGrid
      if (!grid) return {}
      return {
        ...pushHistory(state, coalesceKey),
        project: { ...state.project, beatGrid: { ...grid, ...patch } }
      }
    }),

  clearBeatGrid: () =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, beatGrid: null }
    })),

  toggleBeatGridEnabled: () =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        beatGrid: state.project.beatGrid
          ? { ...state.project.beatGrid, enabled: !state.project.beatGrid.enabled }
          : null
      }
    })),

  applyTemplate: (template) =>
    set((state) => {
      let project = { ...state.project, aspectRatio: '9:16' as AspectRatio }
      const duration = totalDuration(project)

      if (template.jumpCutSeconds && duration > 0) {
        const newClips: Clip[] = []
        const segmentsByClipId = new Map<string, Clip[]>()
        for (const c of project.clips) {
          const segments: Clip[] = []
          let localStart = c.inPoint
          // 区切りの長さはタイムラインの秒。素材の秒では速さの分だけ長い
          const step = template.jumpCutSeconds * (c.speed || 1)
          while (localStart < c.outPoint) {
            let localEnd = Math.min(localStart + step, c.outPoint)
            // 残りが最短の長さに満たなければ、この断片に含める(0.05 秒の断片を作らない)
            if (c.outPoint - localEnd < MIN_CLIP_SOURCE_DURATION) localEnd = c.outPoint
            // Spread the source clip: rebuilding field by field dropped the crop
            // framing and, worse, the audioDetached flag — the recut clips then
            // played their embedded audio again on top of the separated track.
            segments.push({
              ...c,
              id: uuid(),
              inPoint: localStart,
              outPoint: localEnd,
              // 速さはそのまま(1 に戻すと、2倍速のクリップの尺が倍になる)
              transitionIn: undefined
            })
            localStart = localEnd
          }
          segmentsByClipId.set(c.id, segments)
          newClips.push(...segments)
        }
        // The recut clips get fresh ids, so detached audio linked to the originals was
        // left pointing at clips that no longer exist. The link mirror then dropped the
        // links and the audio silently stopped following its clip: a later trim moved
        // the video but not the audio, desyncing everything after it with no warning.
        // Rebuild one linked audio clip per segment, the same way replaceClipRange does.
        const audioTracks = project.audioTracks.map((t) => {
          if (!t.clips.some((c) => c.linkedClipId && segmentsByClipId.has(c.linkedClipId))) {
            return t
          }
          return {
            ...t,
            clips: t.clips.flatMap((c) => {
              const segments = c.linkedClipId ? segmentsByClipId.get(c.linkedClipId) : undefined
              if (!segments) return [c]
              // Positions and trims are filled in by the link mirror right after.
              // フェードは配り直す(理由は splitFades)。断片は素材の並び順＝タイムライン順。
              return splitFades(
                segments.map((seg) => ({
                  ...c,
                  id: uuid(),
                  inPoint: seg.inPoint,
                  outPoint: seg.outPoint,
                  linkedClipId: seg.id
                }))
              )
            })
          }
        })
        project = { ...project, clips: newClips, audioTracks }
      }

      const total = totalDuration(project)
      const overlays: TextOverlay[] = template.segments.map((segment, i) => {
        const segmentSpan = total / template.segments.length
        return {
          id: uuid(),
          text: segment.label,
          startTime: i * segmentSpan,
          endTime: (i + 1) * segmentSpan,
          style: { ...template.captionStyle },
          source: 'manual'
        }
      })

      return { ...pushHistory(state), project: { ...project, textOverlays: overlays } }
    }),

  autoCutFromCandidates: (picks, template) =>
    set((state) => {
      const clips: Clip[] = picks.map((p) => ({
        id: uuid(),
        assetId: p.assetId,
        inPoint: p.start,
        outPoint: p.end,
        speed: 1
      }))
      // **今のタイムラインを丸ごと置き換える＝今のクリップを全部消すということ。**
      // 消す経路(`removeClip` / `removeClips` / 素材の削除 / 断片への置き換え)は
      // どれも紐づいた分離音声を一緒に連れていくのに、ここだけ `audioTracks` を
      // そのまま持ち越していた。持ち越すと、リンク先が消えたぶんはミラーが
      // リンクだけ外し、**クリップは古い絶対位置に居座る**——つまり
      // **カットで捨てたはずの音が、新しい絵の上でそのまま鳴る**。
      // (実測: 0.5秒にだけビープがある8秒の素材で音声を分離し、無音の 4〜6秒を
      //  1本だけ採用して書き出すと、2秒の出力に **0.479〜0.598秒のビープ
      //  (max -9.0dB)** が入っていた。本来は全域が無音。直すと -91.0dB)
      // 利用者が手で動かした音声(リンクを外したもの)は残す——`removeLinkedAudioFor`
      // が見るのは `linkedClipId` が生きているものだけ。
      const removedClipIds = new Set(state.project.clips.map((c) => c.id))
      const project: Project = {
        ...state.project,
        aspectRatio: '9:16',
        clips,
        audioTracks: removeLinkedAudioFor(state.project.audioTracks, removedClipIds)
      }
      const total = totalDuration(project)
      const overlays: TextOverlay[] = template.segments.map((segment, i) => {
        const segmentSpan = total / template.segments.length
        return {
          id: uuid(),
          text: segment.label,
          startTime: i * segmentSpan,
          endTime: (i + 1) * segmentSpan,
          style: { ...template.captionStyle },
          source: 'manual'
        }
      })
      return {
        ...pushHistory(state),
        project: { ...project, textOverlays: overlays },
        selectedClipId: null,
        multiSelectedClipIds: []
      }
    }),

  addRoughCutClips: (picks) =>
    set((state) => {
      const newClips: Clip[] = picks.map((p) => ({
        id: uuid(),
        assetId: p.assetId,
        inPoint: p.start,
        outPoint: p.end,
        speed: 1
      }))
      return {
        ...pushHistory(state),
        project: { ...state.project, clips: [...state.project.clips, ...newClips] }
      }
    }),

  // Adding the cut and its hook caption is one user action ("apply this plan"), so it
  // must be one undo step — otherwise undoing leaves the clips behind with the caption
  // gone, which is a state the user never asked for.
  applyShortPlan: (picks, overlays) =>
    set((state) => {
      if (picks.length === 0) return state
      const newClips: Clip[] = picks.map((p, i) => ({
        id: uuid(),
        assetId: p.assetId,
        inPoint: p.start,
        outPoint: p.end,
        speed: 1,
        // The first appended clip joins whatever was already on the timeline; putting a
        // transition there would change material the user did not ask us to touch.
        transitionIn: i === 0 ? undefined : p.transitionIn
      }))
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: [...state.project.clips, ...newClips],
          textOverlays: [
            ...state.project.textOverlays,
            ...overlays.map((o) => ({ ...o, id: uuid() }))
          ]
        }
      }
    }),

  applyAutoEditPattern: (pattern) =>
    set((state) => {
      const newClips: Clip[] = pattern.segments.map((seg, i) => {
        const transitionType = seg.transitionIn ?? pattern.transition
        return {
          id: uuid(),
          assetId: seg.assetId,
          inPoint: seg.start,
          outPoint: seg.end,
          speed: 1,
          transitionIn:
            i === 0 || transitionType === 'none'
              ? undefined
              : { type: transitionType, duration: 0.5 }
        }
      })
      return {
        ...pushHistory(state),
        project: { ...state.project, clips: [...state.project.clips, ...newClips] }
      }
    })
})

export const useProjectStore = create<ProjectState>(skipNoOpHistory(projectStateCreator))

// Detached-audio clips (linkedClipId set) must follow their source clip: the main
// track lays clips back-to-back, so trimming/reordering/deleting ANY earlier clip
// shifts every later clip's absolute start — and a frozen startTime would silently
// export lip-synced audio seconds out of place. Mirror position and trim from the
// live source clip; unlink (freezing current values) when the source is gone.
/**
 * ミラーの「変わっていない」判定。
 *
 * 素の `===` だと **`NaN === NaN` が false** なので、値に NaN が1つ紛れ込むだけで
 * 毎回「変わった」と判定され、購読 → `setState` → 購読 … が止まらなくなる
 * (`Maximum call stack size exceeded` でアプリがその場から操作不能になる)。
 * 入口で NaN を弾くのが本筋だが、**入口を1つ増やすたびに同じ穴が開く**ので、
 * ミラー側も NaN 同士は「同じ」と見なして必ず収束させる。
 */
function sameNumber(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b))
}

function syncLinkedAudioClips(project: Project): Project {
  const hasLinks = project.audioTracks.some((t) => t.clips.some((c) => c.linkedClipId))
  if (!hasLinks) return project
  const timedById = new Map(buildTimedClips(project).map((tc) => [tc.clip.id, tc]))
  let changed = false
  const audioTracks = project.audioTracks.map((t) => {
    let trackChanged = false
    const clips = t.clips.map((c) => {
      if (!c.linkedClipId) return c
      const tc = timedById.get(c.linkedClipId)
      if (!tc) {
        trackChanged = true
        return { ...c, linkedClipId: undefined }
      }
      // 速度もミラーする。これが無いと本編だけ速くなって音が置き去りになる。
      const speed = tc.clip.speed || 1
      if (
        sameNumber(c.startTime, tc.start) &&
        sameNumber(c.inPoint, tc.clip.inPoint) &&
        sameNumber(c.outPoint, tc.clip.outPoint) &&
        sameNumber(c.speed || 1, speed)
      ) {
        return c
      }
      trackChanged = true
      return {
        ...c,
        startTime: tc.start,
        inPoint: tc.clip.inPoint,
        outPoint: tc.clip.outPoint,
        speed
      }
    })
    if (trackChanged) changed = true
    return trackChanged ? { ...t, clips } : t
  })
  return changed ? { ...project, audioTracks } : project
}

/**
 * クリップを作り直す操作(無音カット・分割)で、追従テロップのリンクを新しい断片へ張り直す。
 *
 * IDが変わるとリンクは**エラーも出さずに切れる**ので、元クリップ内での位置(素材の秒数)から
 * 行き先の断片を選び直す。切り捨てられた区間に載っていたテロップは、次に残った断片の先頭へ
 * 寄せる(テロップだけ元の場所に取り残されるより、内容の続きに付いていく方が近い)。
 */
/**
 * クリップ1つを断片の並びに置き換えた新しい `Project` を返す(履歴は積まない)。
 *
 * 単発(`replaceClipRange`)と一括(`replaceClipRanges`)で同じ規則を通すためにここへ出す。
 * 書き写すと、分離音声やテロップの張り直しが片方にだけ足されて差が開く。
 * 置き換えるものが無ければ受け取った `project` をそのまま返す(呼び出し側が
 * 参照の同一性で「変化なし」を判定する)。
 */
function applyClipReplacement(project: Project, clipId: string, newClips: Clip[]): Project {
  const idx = project.clips.findIndex((c) => c.id === clipId)
  if (idx === -1) return project
  const original = project.clips[idx]
  const clips = [...project.clips]
  clips.splice(idx, 1, ...newClips)
  return relinkForReplacedClip({ ...project, clips }, original, newClips)
}

/**
 * クリップ1本が断片の並びに置き換わったときに、そのIDを参照している物を作り直す。
 * `clips` 自体は呼び出し側が組み立てたものをそのまま使う。
 *
 * **IDが変わると参照はエラーも出さずに切れる**ので、置き換えを行う経路は必ずここを通す。
 * 置き換え後の並びを自分で組み立てる経路(インサート/上書き)からも呼べるように、
 * `applyClipReplacement` から切り出してある。
 */
function relinkForReplacedClip(project: Project, original: Clip, newClips: Clip[]): Project {
  const textOverlays = remapOverlayLinks(project.textOverlays, original, newClips)
  // Silence/filler/text-based cuts replace one clip with several. Detached audio
  // linked to the original must be rebuilt to match the surviving segments —
  // otherwise the video loses the cut-out parts while its separated audio plays
  // on unchanged, desyncing everything from that point on.
  const audioTracks = project.audioTracks.map((t) => {
    if (!t.clips.some((c) => c.linkedClipId === original.id)) return t
    return {
      ...t,
      clips: t.clips.flatMap((c) => {
        if (c.linkedClipId !== original.id) return [c]
        // Positions and trims are filled in by the link mirror right after.
        // フェードは配り直す(理由は splitFades)。断片は `newClips` の順＝タイムライン順。
        return splitFades(
          newClips.map((seg) => ({
            ...c,
            id: uuid(),
            inPoint: seg.inPoint,
            outPoint: seg.outPoint,
            linkedClipId: seg.id
          }))
        )
      })
    }
  })
  return { ...project, audioTracks, textOverlays }
}

function remapOverlayLinks(
  overlays: TextOverlay[],
  original: Clip,
  newClips: Clip[]
): TextOverlay[] {
  if (!overlays.some((o) => o.linkedClipId === original.id)) return overlays
  const speed = original.speed || 1
  return overlays.map((o) => {
    if (o.linkedClipId !== original.id) return o
    const sourceTime = original.inPoint + (o.linkOffset ?? 0) * speed
    const inside = newClips.find((s) => sourceTime >= s.inPoint && sourceTime < s.outPoint)
    if (inside) {
      return {
        ...o,
        linkedClipId: inside.id,
        linkOffset: (sourceTime - inside.inPoint) / (inside.speed || 1)
      }
    }
    if (newClips.length === 0) return { ...o, linkedClipId: undefined, linkOffset: undefined }
    // 元のクリップの頭より前・終わりより後ろにずらして置いたテロップ(負の・長い linkOffset)は、
    // 一番近い断片に、同じ位置のまま付ける(頭へ寄せると、分割しただけでテロップが動いていた)。
    // クリップの中で、無音カットなどで切り取られた所のテロップは、今までどおり次の断片の頭へ
    const first = newClips[0]
    const last = newClips[newClips.length - 1]
    // 頭より前のものはクリップの頭からの距離、終わりより後ろのものはクリップの終わりからの距離を
    // 保つ(無音カットで頭・終わりが切られても、置いた位置からずれない)
    if (sourceTime < original.inPoint && sourceTime < first.inPoint)
      return {
        ...o,
        linkedClipId: first.id,
        linkOffset: (sourceTime - original.inPoint) / speed
      }
    if (sourceTime >= original.outPoint && sourceTime >= last.outPoint)
      return {
        ...o,
        linkedClipId: last.id,
        linkOffset:
          (last.outPoint - last.inPoint) / (last.speed || 1) +
          (sourceTime - original.outPoint) / speed
      }
    const after = newClips.find((s) => s.inPoint >= sourceTime)
    if (after) return { ...o, linkedClipId: after.id, linkOffset: 0 }
    return { ...o, linkedClipId: undefined, linkOffset: undefined }
  })
}

/**
 * テロップを動かしたとき、カラオケ(単語ごとの色替え)の時刻も同じだけ動かす。
 *
 * `words` の `start`/`end` は**テロップと同じタイムラインの絶対秒**。プレビューは
 * `isKaraokeWordSung(w, playheadTime)`(＝開始時刻を過ぎたか)で直接見比べ、書き出しは
 * `buildKaraokeText(words, o.startTime)` で**テロップの開始からの差**を `\k` に変換する。
 * どちらも絶対秒を前提にしているので、**テロップだけ動かすと単語が置き去りになる**。
 *
 * 動かす経路は3つ(タイムラインでのドラッグ・一括ずらし・追従先クリップの移動)あり、
 * **どれも同じだけ壊れる**ので規則はここ1箇所に置く。書き写すと片方だけ直る。
 *
 * 実測(テロップ 2.00〜4.00 / 単語 あ2.50〜3.00・い3.00〜3.50 を +3秒 動かす):
 *   書き出しASS `\k=[50, 50, 50]` → **`[50, 50]`**（先頭 0.5 秒の間が消え、色が早く始まる）
 *   プレビュー   2.50でカラオケ開始 → **どの時刻でも1語も色が付かない**
 * 追従先が -4 秒動いた場合はさらに露骨で、`\k=[450, 50, 50]` と
 * **2秒のテロップに 4.5 秒の前置き**が入り、色は最後まで一度も始まらなかった。
 */
function shiftOverlayWords(words: TextOverlay['words'], delta: number): TextOverlay['words'] {
  if (!words || words.length === 0) return words
  // 動いていない・動かせない量なら触らない(参照も変えない=無駄な再描画を出さない)。
  if (!Number.isFinite(delta) || delta === 0) return words
  return words.map((w) => ({ ...w, start: w.start + delta, end: w.end + delta }))
}

/**
 * 追従ONのテロップを、紐づけ先クリップの現在位置へ合わせ直す。
 *
 * テロップはタイムライン絶対秒を持つので、手前のクリップを詰めたり消したりすると
 * 内容とズレる。追従中のものはクリップ開始 + `linkOffset` で位置を決め直し、尺は保つ。
 * 紐づけ先が消えたら追従を外して、その時点の時刻で固定する(分離音声と同じ考え方)。
 */
function syncLinkedTextOverlays(project: Project): Project {
  const hasLinks = project.textOverlays.some((o) => o.linkedClipId)
  if (!hasLinks) return project
  const timedById = new Map(buildTimedClips(project).map((tc) => [tc.clip.id, tc]))
  let changed = false
  const textOverlays = project.textOverlays.map((o) => {
    if (!o.linkedClipId) return o
    const tc = timedById.get(o.linkedClipId)
    if (!tc) {
      changed = true
      return { ...o, linkedClipId: undefined, linkOffset: undefined }
    }
    const startTime = Math.max(0, tc.start + (o.linkOffset ?? 0))
    const endTime = startTime + (o.endTime - o.startTime)
    if (sameNumber(o.startTime, startTime) && sameNumber(o.endTime, endTime)) return o
    changed = true
    // クランプ後の実際の移動量で単語も動かす(0 で頭打ちになった分だけずれない)。
    return { ...o, startTime, endTime, words: shiftOverlayWords(o.words, startTime - o.startTime) }
  })
  return changed ? { ...project, textOverlays } : project
}

/**
 * 作り直す前の本編のクリップ(の、先頭から `offset` 秒の所)が映していた共通の時刻を、
 * 作り直したあとの本編で映しているクリップと、その先頭からの秒を返す。
 * 作り直しでも残るクリップ(差し込みの画など)は ID が同じなのでそのまま。
 * `sameAsset` を渡すと、同じ素材のクリップにだけ紐づける(分離音声: 別のカメラに紐づくと
 * そのカメラの in/out が音に写され、カメラ間の時刻のずれの分だけ音がずれる)
 */
function relinkToRebuiltClips(
  oldClips: readonly Clip[],
  newClips: readonly Clip[],
  info: MulticamInfo | undefined
): (clipId: string, offset: number, sameAsset?: string) => { id: string; offset: number } | null {
  const newIds = new Set(newClips.map((c) => c.id))
  return (clipId, offset, sameAsset) => {
    if (newIds.has(clipId)) return { id: clipId, offset }
    if (!info) return null
    const old = oldClips.find((c) => c.id === clipId)
    const f = old && info.files.find((x) => x.assetId === old.assetId)
    if (!old || !f) return null
    const common = toCommon(f, old.inPoint + offset * (old.speed || 1))
    for (const c of newClips) {
      if (sameAsset && c.assetId !== sameAsset) continue
      const g = info.files.find((x) => x.assetId === c.assetId)
      if (!g) continue
      const start = toCommon(g, c.inPoint)
      const end = toCommon(g, c.outPoint)
      if (common >= start - 1e-6 && common < end) return { id: c.id, offset: common - start }
    }
    return null
  }
}

/**
 * 本編(収録素材のカメラ)を手で消す・詰める・伸ばす・並べ替えたとき、本編に紐づいていない
 * ピンマイクの声・周りの音・自動テロップ・自動の SE/BGM/CG を、同じ共通の時刻を映している所へ動かす。
 * 動かさないと、そこから後ろの声とテロップが詰めた分だけずれたまま書き出される。
 * 本編から消えた区間のものは消え、伸ばして新しく見えた区間にはピンマイクの声を足す。
 * 人が自分で置いたもの(自動の印の無いトラック・テロップ)と、本編に紐づくものは動かさない
 * (紐づくものは `syncLinked…` が本編のクリップに合わせる)。
 */
/** 並びの中身が(参照として)同じか */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function followMainEdit(
  prev: Project,
  next: Project,
  /** 仮編集を入れた直後: 動かすのは入れたばかりの声と自動テロップだけ(前の回の自動 SE・BGM・CG は置き直される) */
  onlyRebuilt = false
): Project {
  const info = next.multicam
  if (!info || prev.multicam !== info) return next
  const before = followSpans(prev.clips, info)
  // 本編が空だった(初めて並べる)ときは追従しない。収録素材が無くても、速さを変えたクリップ・
  // 差し込みの画があれば続ける(速さを戻して収録素材に戻ったとき、声を入れ直すため)
  if (before.length === 0) return next
  const after = followSpans(next.clips, info)
  // 同じクリップどうし・残りは1回ずつ結ぶ(同じ素材の時刻を2回使った本編で、声が倍々に増えないように)
  const segs = clipTimelineMapping(before, after, splitAncestors)
  if (isIdentityMapping(segs, before, after)) return next

  const remapClip = <
    C extends {
      id: string
      startTime: number
      inPoint: number
      outPoint: number
      speed?: number
      fadeIn?: number
      fadeOut?: number
    }
  >(
    c: C
  ): C[] => {
    const speed = c.speed || 1
    const end = c.startTime + (c.outPoint - c.inPoint) / speed
    const pieces = mapTimelineRange(segs, c.startTime, end)
    // 動かないクリップは**元の値のまま**返す。作り直すと、編集した所より前の(動かない)ピンマイクの
    // クリップまで毎回別の値になり、取り消しの履歴が1件ごとに全クリップを抱える
    // (実測: 60分・2,000クリップ・ピンマイク6本で本編を50回直すと、履歴が 602,820 個のクリップを
    //  抱えていた=共有ゼロ)。計算し直すと浮動小数の丸めで端が 1e-15 秒ずつ動き続けることも防ぐ
    if (pieces.length === 1) {
      const p = pieces[0]
      const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9
      if (
        p.to - p.from > 1e-3 &&
        same(p.at, c.startTime) &&
        same(p.from, c.startTime) &&
        same(p.to, end)
      ) {
        return [c]
      }
    }
    // 写した先でつながっている切れ目(本編のクリップの境目)は1本にまとめる(BGM が細切れにならないように)
    const merged: typeof pieces = []
    for (const p of pieces) {
      const last = merged[merged.length - 1]
      if (
        last &&
        Math.abs(last.to - p.from) <= 1e-6 &&
        Math.abs(last.at + (last.to - last.from) - p.at) <= 1e-6
      ) {
        merged[merged.length - 1] = { ...last, to: p.to }
      } else merged.push(p)
    }
    return merged
      .filter((p) => p.to - p.from > 1e-3)
      .map((p, i, all) => ({
        ...c,
        id: i === 0 ? c.id : uuid(),
        startTime: p.at,
        inPoint: c.inPoint + (p.from - c.startTime) * speed,
        outPoint: c.inPoint + (p.to - c.startTime) * speed,
        fadeIn: i === 0 ? c.fadeIn : undefined,
        fadeOut: i === all.length - 1 ? c.fadeOut : undefined
      }))
  }
  const follows = (t: { multicamSourceId?: string; autoRole?: string }): boolean =>
    Boolean(t.multicamSourceId || (!onlyRebuilt && t.autoRole))
  // 新しく見えた所に足す声は、収録素材のクリップの所だけ(差し込んだ素材・速さを変えたクリップには足さない)
  const gaps = uncoveredSpans(
    after.filter((x) => x.real),
    segs
  )

  const audioTracks = next.audioTracks.map((t) => {
    if (!follows(t)) return t
    const untouched = isUntouchedAuto(t)
    const moved = t.clips.flatMap((c) => (c.linkedClipId ? [c] : remapClip(c)))
    // 伸ばして新しく見えた所: 収録素材のトラックなら、その機材の音を足す
    const added =
      t.multicamSourceId && gaps.length > 0
        ? gaps.flatMap((g) =>
            sourcePieces(info, t.multicamSourceId!, g).map((p) => ({
              id: uuid(),
              assetId: p.assetId,
              startTime: p.startTime,
              inPoint: p.inPoint,
              outPoint: p.outPoint,
              ...(Math.abs(p.speed - 1) > 1e-9 ? { speed: p.speed } : {})
            }))
          )
        : []
    const clips = [...moved, ...added].sort((a, b) => a.startTime - b.startTime)
    // どのクリップも動かなかったトラックは、元のトラックのまま(履歴で共有できるように)
    if (sameItems(clips, t.clips) && (!untouched || t.autoSignature === autoSignatureOf(t))) {
      return t
    }
    const track = { ...t, clips }
    // 手を付けていない自動のトラックは、動かしたあとも「手を付けていない」のまま(作り直しで入れ替わる)
    return untouched ? withAutoSignature(track) : track
  })
  const videoOverlayTracks = next.videoOverlayTracks.map((t) => {
    if (!follows(t)) return t
    const untouched = isUntouchedAuto(t)
    // 伸ばして新しく見えた所: 収録素材のカメラ(ゲーム実況の顔カメラのワイプ)なら、そのカメラの絵を足す
    const added =
      t.multicamSourceId && gaps.length > 0
        ? gaps.flatMap((g) =>
            sourcePieces(info, t.multicamSourceId!, g).map((p) => ({
              id: uuid(),
              assetId: p.assetId,
              startTime: p.startTime,
              inPoint: p.inPoint,
              outPoint: p.outPoint
            }))
          )
        : []
    const clips = [...t.clips.flatMap((c) => remapClip(c)), ...added].sort(
      (a, b) => a.startTime - b.startTime
    )
    if (sameItems(clips, t.clips) && (!untouched || t.autoSignature === autoSignatureOf(t))) {
      return t
    }
    const track = { ...t, clips }
    return untouched ? withAutoSignature(track) : track
  })
  /** 本編から消えて落とした、人が直した自動テロップ(作り直しで戻したとき、直した内容で出す) */
  const droppedEdited: TextOverlay[] = []
  const textOverlays = next.textOverlays.flatMap((o) => {
    if (o.linkedClipId || autoTelopKey(o) === null) return [o]
    // 長さの無いテロップは、その時刻の点を写す(区間として写すと、どこにも写らず消える)
    const point = o.endTime - o.startTime <= 1e-6
    const pieces = mapTimelineRange(segs, o.startTime, point ? o.startTime + 1e-3 : o.endTime)
    // 本編から消えた発言のテロップは消す(場面を戻して作り直せば、また入る)
    if (pieces.length === 0) {
      if (o.edited) droppedEdited.push(o)
      return []
    }
    const startTime = pieces[0].at
    let endTime = startTime + (pieces[0].to - pieces[0].from)
    for (const p of pieces.slice(1)) {
      if (Math.abs(p.at - endTime) > 1e-6) break
      endTime = p.at + (p.to - p.from)
    }
    if (point) endTime = startTime + (o.endTime - o.startTime)
    if (sameNumber(startTime, o.startTime) && sameNumber(endTime, o.endTime)) return [o]
    return [
      { ...o, startTime, endTime, words: shiftOverlayWords(o.words, startTime - o.startTime) }
    ]
  })
  return {
    ...next,
    audioTracks,
    videoOverlayTracks,
    textOverlays,
    ...(droppedEdited.length > 0
      ? { editedTelops: rememberEditedTelops(droppedEdited, next.editedTelops) }
      : {})
  }
}

/** 本編のクリップが、共通の時刻に 1:1 で写る収録素材のクリップか(速さが素材の速さと同じ) */
function isRealClip(
  c: { assetId: string; speed?: number },
  fileOf: ReadonlyMap<string, { rate: number }>
): boolean {
  const f = fileOf.get(c.assetId)
  return Boolean(f && Math.abs((c.speed || 1) - f.rate) <= 1e-9)
}

/**
 * 分割で作った後ろ半分の id → 元のクリップの id。本編の追従で、後ろ半分を元のクリップとして先に結ぶ
 * (結ばないと、同じ素材を差し込んだときに、後ろ半分の下の自動の音・テロップが差し込んだクリップの下へ写る)
 */
const splitOrigins = new Map<string, string>()
function splitId(originalId: string): string {
  const id = uuid()
  // 直接の親を覚える(続けて分割したときも、どのクリップから分けたかを辿れるように)
  splitOrigins.set(id, originalId)
  return id
}
/** 分割の祖先(近い順) */
function splitAncestors(id: string): string[] {
  const out: string[] = []
  for (let p = splitOrigins.get(id); p !== undefined && out.length < 64; p = splitOrigins.get(p))
    out.push(p)
  return out
}

/**
 * 分割元の対応は、直後の追従計算にだけ必要な一時情報。
 * 企画をまたいで残すと、別企画でたまたま同じIDが出たときに誤追従するうえ、
 * 長時間編集で無制限に増え続ける。企画切替時に必ず破棄する。
 */
function resetTransientFollowState(): void {
  splitOrigins.clear()
  pseudoSlots.clear()
}

/** 差し込んだ素材・速さを変えたクリップの、仮の共通の時刻の置き場(収録の時刻と重ならない遠く) */
const PSEUDO_BASE = 1e7
const PSEUDO_STRIDE = 1e5
const pseudoSlots = new Map<string, number>()
function pseudoSlot(key: string): number {
  let n = pseudoSlots.get(key)
  if (n === undefined) {
    n = pseudoSlots.size
    pseudoSlots.set(key, n)
  }
  return PSEUDO_BASE + n * PSEUDO_STRIDE
}

/**
 * 追従に使う、本編のクリップごとの タイムラインの時刻 ↔ 共通の時刻 の区間(クリップの id 付き)。
 * 収録素材を素材の速さで流すクリップは共通の時刻(`real`。タイムラインと 1:1)。
 * それ以外(差し込んだ B ロール・静止画・タイトル、速さを変えたクリップ)は、クリップごとの仮の時刻を当てる。
 * 当てないと、その区間に置いた自動の BGM・SE・CG が、どこに写るか分からず切り落とされる。
 * 速さを変えたクリップは長さが合わないので、速さも鍵に入れる(速さを変えたら、その下の声・自動テロップは外す)
 */
function followSpans(
  clips: Project['clips'],
  info: NonNullable<Project['multicam']>
): (ClipSpan & { real: boolean })[] {
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const out: (ClipSpan & { real: boolean })[] = []
  let cursor = 0
  for (const c of clips) {
    const speed = c.speed || 1
    const len = Math.max(0, c.outPoint - c.inPoint) / speed
    const f = fileOf.get(c.assetId)
    if (f && isRealClip(c, fileOf)) {
      const start = toCommon(f, c.inPoint)
      const end = toCommon(f, c.outPoint)
      if (end - start > 1e-6) out.push({ id: c.id, timeline: cursor, start, end, real: true })
    } else if (len > 1e-6) {
      // 素材と速さごとの仮の時刻(クリップの id ごとにすると、分割した後ろ半分が別の時刻になり、
      // その下の自動の音・テロップが消えた)。同じ素材を2か所で使っても、対応は1回ずつ結ぶ
      const base = pseudoSlot(`${c.assetId}@${speed}`)
      const start = base + c.inPoint / speed
      out.push({ id: c.id, timeline: cursor, start, end: start + len, real: false })
    }
    cursor += len
  }
  return out
}

// Runs the mirror as a silent follow-up correction (no history entry of its own):
// the triggering edit already pushed one, and undo restores an already-synced
// snapshot so this stays a no-op on undo/redo. The clips-identity guard prevents
// recursion — the correction only touches audioTracks.
useProjectStore.subscribe((state, prevState) => {
  if (state.project === prevState.project) return
  const synced = syncLinkedTextOverlays(syncLinkedAudioClips(state.project))
  if (synced !== state.project) {
    useProjectStore.setState({ project: synced })
  }
})

export function getTotalDuration(project: Project): number {
  return totalDuration(project)
}
