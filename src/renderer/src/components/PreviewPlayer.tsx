import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { targetResolution, textCanvasSize } from '@shared/resolution'
import { frameSeconds } from '@shared/frameRate'
import { fadeGainAt } from '@shared/audioFade'
import {
  audioClipGain,
  MEDIA_ELEMENT_MAX_VOLUME,
  needsWebAudioGain,
  toElementVolume
} from '@shared/audioGain'
import { pipMarginPx } from '@shared/pipLayout'
import {
  TEXT_ANIMATION_MS,
  TEXT_MARGIN_H_RATIO,
  TEXT_MARGIN_V_RATIO,
  TEXT_SHADOW_OFFSET_PX,
  TEXT_SHADOW_OPACITY,
  textAnchorOriginCss,
  textSlideOffsetPx
} from '@shared/textStyle'
import { isKaraokeWordSung, karaokeWords } from '@shared/captionWords'
import { blurSigmaFor } from '@shared/videoFrame'
import {
  advanceDuckDetector,
  createDuckDetector,
  duckDetectorLevel,
  duckGainForLevel,
  isMainVoiceClip
} from '@shared/ducking'
import { crossfadeOpacity, effectiveTransitionSeconds } from '@shared/transition'
import { cropPreviewStyle } from '../lib/cropPreview'
import { overlayBoxStyle } from '../lib/overlayBox'
import {
  audioClipDuration,
  buildTimedClips,
  findTimedClipAt,
  findTimedClipById,
  nextTimedClip,
  totalTimelineDuration,
  totalExportDuration,
  TimedClip
} from '../lib/timelineMath'
import {
  PlayIcon,
  PauseIcon,
  ClapperboardIcon,
  YoutubeIcon,
  MaximizeIcon,
  Volume2Icon,
  VolumeXIcon,
  SkipBackIcon,
  SkipForwardIcon,
  StepBackIcon,
  StepForwardIcon
} from './icons'

import { ShortsUiMockup } from './ShortsUiMockup'
import type {
  AudioTrackClip,
  MediaAsset,
  PipPosition,
  TextOverlay,
  TextPosition,
  TextStyle,
  VideoOverlayClip
} from '@shared/types'
import { previewSourceUrl } from '../lib/previewSource'
import { activeVideoOverlayClips } from '../lib/videoOverlay'
import { toPlaybackRate } from '../lib/playbackRate'
import {
  PREVIEW_BLEND_FOLLOW_TOLERANCE_SEC,
  applyPreviewRate,
  followPreviewTime,
  seekPreviewTime
} from '../lib/previewSync'
import { applyPendingPreviewLoad, type PendingPreviewLoad } from '../lib/pendingPreviewLoad'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const FONT_STACKS: Record<TextStyle['fontFamily'], string> = {
  'sans-serif': 'sans-serif',
  serif: 'serif',
  'M PLUS Rounded 1c': '"M PLUS Rounded 1c", sans-serif',
  'Noto Sans JP': '"Noto Sans JP", sans-serif',
  'Noto Serif JP': '"Noto Serif JP", serif'
}

/**
 * `text-shadow` に入れる長さを安全な数値にする。
 *
 * NaN や負値がひとつでも混ざると `NaNpx` になって **text-shadow 宣言ごと無効**になり、
 * 縁取りも影もまとめて消える(しかもエラーは出ない)。プロジェクトファイルは外から
 * 来るので、描画直前で切り落とす。
 */
function normalizeLength(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * テロップの見た目を画面用に組み立てる。
 *
 * 書き出しは ASS の PlayResX/PlayResY を**固定のキャンバス**(`textCanvasSize`)にしていて、
 * libass がそれを実フレームへ引き伸ばす。つまり `fontSize` と `letterSpacing` は
 * **キャンバス上のピクセル = 枠に対する比**。プレビュー枠はキャンバスより小さいので、
 * 「枠の高さ / キャンバスの高さ」を掛けて同じ比率で描く。ここを固定倍率にしていたときは、
 * サイズ40のテロップが画面では枠高の 6.77% を占めるのに、1080p の書き出しでは 2.08%
 * にしかならず、画面で決めたサイズが出力で使えなかった。
 *
 * 縁取り・影も同じキャンバス上の値なので、フォントと同じ `scale` を掛ける。
 */
function overlayPreviewStyle(style: TextStyle, scale: number): CSSProperties {
  const shadows: string[] = []
  if (style.outline) {
    // 縁取りも出力ピクセルの値(書き出しは `\bord${outlineWidth}`)なので、フォントと
    // 同じ `scale` を掛ける。ここだけ固定倍率のままだったため、文字は正しい比率なのに
    // 縁取りだけが太すぎた(1080p を 320px 枠で見ると scale≈0.30、太さ6は本来1.78pxの
    // ところ 3.6px で描かれていた)。
    // 整数pxに丸めない・1px の下限も置かない。text-shadow は小数pxを受け付けて
    // アンチエイリアスするので、丸めると縮小率が高いときにその丸めのほうが誤差の
    // 主因になる(1920p を 240px 枠で見ると、下限1px が本来 0.25px の縁取りを 4倍に
    // 太らせていた)。細く見えるのは書き出しでも実際に細いということ。
    const w = normalizeLength(style.outlineWidth) * scale
    const c = style.outlineColor
    if (w > 0) {
      shadows.push(
        `-${w}px -${w}px 0 ${c}`,
        `${w}px -${w}px 0 ${c}`,
        `-${w}px ${w}px 0 ${c}`,
        `${w}px ${w}px 0 ${c}`
      )
    }
  }
  if (style.shadow) {
    // 影も同じ。**落とし幅も濃さも共通の置き場から取る**——ここに直に書いていたので、
    // 濃さが書き出しと食い違っていた(実測: 画面 0.7 / 書き出し 0.6235。白地に置くと
    // 芯が 77 対 95 で**画面のほうが濃い**)。理由と実測は `TEXT_SHADOW_OFFSET_PX`。
    // **ぼかさない。** ASS の `\shad` は硬い影で、ぼかし半径を入れていたのは画面だけ。
    const o = TEXT_SHADOW_OFFSET_PX * scale
    if (o > 0) shadows.push(`${o}px ${o}px 0 rgba(0,0,0,${TEXT_SHADOW_OPACITY})`)
  }
  return {
    fontFamily: FONT_STACKS[style.fontFamily],
    fontSize: style.fontSize * scale,
    color: style.color,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    letterSpacing: style.letterSpacing ? `${style.letterSpacing * scale}px` : undefined,
    textShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
    whiteSpace: 'pre-line'
  }
}

function renderOverlayText(o: TextOverlay, playheadTime: number): React.ReactNode {
  // 単語ハイライトで描くのは**単語列がまだ本文を綴っているときだけ**。打ち直された本文を
  // 無視して古い単語を出さないための判定で、書き出し側と同じ関数を通す(理由は karaokeWords)。
  const words = karaokeWords(o)
  if (words) {
    return words.map((w, i) => (
      <span
        key={i}
        style={{
          // 色が変わる条件も**書き出しと同じ関数**を通す(理由は isKaraokeWordSung)。
          // 「今の1語だけ」にすると、読み終わった語が元の色へ戻って出力と食い違う。
          color: isKaraokeWordSung(w, playheadTime) ? o.style.highlightColor : undefined
        }}
      >
        {w.text}
      </span>
    ))
  }
  if (o.style.animation !== 'typewriter') return o.text
  const lines = o.text.split('\n')
  let charIndex = 0
  return lines.map((line, lineIdx) => (
    <span key={lineIdx}>
      {lineIdx > 0 && <br />}
      {[...line].map((char, i) => {
        const delay = charIndex * 40
        charIndex += 1
        return (
          <span key={i} className="typewriter-char" style={{ animationDelay: `${delay}ms` }}>
            {char}
          </span>
        )
      })}
    </span>
  ))
}

interface OverlayDragState {
  id: string
  x: number
  y: number
}

const VOLUME_KEY = 've-preview-volume'
const MUTED_KEY = 've-preview-muted'

function readStoredVolume(): number {
  const raw = localStorage.getItem(VOLUME_KEY)
  const n = raw ? Number(raw) : 1
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
}

/**
 * テロップの縦位置。**書き出しと同じ数字**(`TEXT_MARGIN_V_RATIO`)から出す。
 *
 * ここは以前 CSS の `.overlay-top { top: 8% }` / `.overlay-bottom { bottom: 10% }` に
 * 直接書かれていて、**下だけ書き出し(8%)と食い違っていた**。既定のテロップ位置が
 * `bottom` なので、既定のまま使うと必ず踏む。数字を2箇所に書く形をやめて、
 * 片方だけ動かせないようにする。
 */
function verticalAnchorStyle(position: TextPosition): CSSProperties {
  const margin = `${TEXT_MARGIN_V_RATIO * 100}%`
  if (position === 'top') return { top: margin }
  if (position === 'bottom') return { bottom: margin }
  return { top: '50%' }
}

/**
 * テロップの左右の余白＝**折り返す幅**。書き出しの ASS `MarginL/R` と同じ比
 * (`TEXT_MARGIN_H_RATIO`)から出す。縦と同じ理由で CSS には数字を書かない——
 * ここが CSS の 5% と ASS の出力px固定に分かれていたため、**同じテロップが
 * 画面では2行・書き出しでは1行**になっていた。
 */
const horizontalInsetStyle: CSSProperties = {
  left: `${TEXT_MARGIN_H_RATIO * 100}%`,
  right: `${TEXT_MARGIN_H_RATIO * 100}%`
}

/**
 * 隅からの余白は**枠の幅**基準(書き出しと同じ規則)。CSS の `top`/`bottom` に `%` を書くと
 * **親の高さ**基準になり、同じ設定でも縦横比によって書き出しとズレる。
 * 枠の実寸が要るので `frameWidth` を受け取る(0 のときは 0px = 隅に付く。初回描画の
 * 1フレームだけで、ResizeObserver が測ったらすぐ追従する)。
 */
function pipStyle(position: PipPosition, scale: number, frameWidth: number): CSSProperties {
  const margin = pipMarginPx(frameWidth)
  const style: CSSProperties = {
    position: 'absolute',
    width: `${scale * 100}%`,
    height: 'auto',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
    border: '2px solid rgba(255, 255, 255, 0.8)',
    zIndex: 2
  }
  if (position === 'top-left' || position === 'top-right') style.top = margin
  else style.bottom = margin
  if (position === 'top-left' || position === 'bottom-left') style.left = margin
  else style.right = margin
  return style
}

function VideoOverlayLayer({
  clip,
  asset,
  position,
  scale,
  frameWidth,
  playheadTime,
  isPlaying,
  volume,
  muted,
  seekToken
}: {
  clip: VideoOverlayClip
  asset: MediaAsset
  position: PipPosition
  scale: number
  frameWidth: number
  playheadTime: number
  isPlaying: boolean
  volume: number
  muted: boolean
  /** 明示的なシークの合図(`seekRequest.token`)。変わったら位置をぴったり入れ直す */
  seekToken: number
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const localTime = clip.inPoint + (playheadTime - clip.startTime)

  // 連続再生中の追従はゆるく(毎フレーム書き込まない)。理由は previewSync。
  useEffect(() => {
    followPreviewTime(ref.current, localTime)
  }, [localTime])

  // **明示的なシークはぴったり入れ直す。** 上の追従は許容(0.3秒)より小さいズレを
  // 直さないので、これが無いと**許容より小さくシークしたときだけ PiP が前の絵のまま**
  // 取り残される(本編は `seekRequest` で必ず入れ直すので、絵が2つに割れる)。
  useEffect(() => {
    seekPreviewTime(ref.current, localTime)
    // localTime はシークのたびに再計算されるが、依存に入れると連続再生でも毎フレーム
    // 走ってしまう。入れ直すのは「シークした」という合図が来たときだけ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToken])

  useEffect(() => {
    if (isPlaying) {
      ref.current?.play().catch(() => {})
    } else {
      ref.current?.pause()
    }
  }, [isPlaying])

  useEffect(() => {
    if (ref.current) {
      ref.current.volume = volume
      ref.current.muted = muted
    }
  }, [volume, muted])

  return (
    <video ref={ref} src={previewSourceUrl(asset)} style={pipStyle(position, scale, frameWidth)} />
  )
}

/**
 * 余白を素材のぼかしで埋めるクリップ用の背景レイヤー。
 *
 * 書き出しは同じ入力を2つに分けて「拡大+ぼかし」と「収めた前景」を重ねている。
 * プレビューでも同じ見た目にするため、同じ素材をもう1枚 `object-fit: cover` で敷いて
 * CSS の blur を掛ける。位置合わせは PiP レイヤーと同じで、0.3秒以上ずれたときだけ
 * 合わせ直す(ぼかしているので多少のズレは見えない。毎フレーム合わせると重い)。
 */
function PreviewBlurBackdrop({
  src,
  localTime,
  isPlaying,
  blurPx,
  speed,
  seekToken
}: {
  src: string
  localTime: number
  isPlaying: boolean
  blurPx: number
  speed: number
  /** 明示的なシークの合図(`seekRequest.token`)。変わったら位置をぴったり入れ直す */
  seekToken: number
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    followPreviewTime(ref.current, localTime)
  }, [localTime])

  // **明示的なシークはぴったり入れ直す**(理由は previewSync)。ぼかしていても、
  // 前景と別の瞬間を映していることに変わりはない。
  useEffect(() => {
    seekPreviewTime(ref.current, localTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToken])

  // 前景と同じ速度で回す。ここが等倍のままだと、上の 0.3秒 の合わせ直しだけで
  // 引きずられることになり、**再生中ずっとシークし続ける**(実測: 4倍速で背景の
  // `playbackRate` は 1 のまま、本編とのズレが 0.29秒 まで開いてから戻るのを繰り返す)。
  // **`src` も依存に入れる。** 差し替えると `playbackRate` は既定へ戻されるので、
  // 速度が同じまま別素材のクリップへ移ると等倍のまま取り残される(理由は previewSync)。
  useEffect(() => {
    applyPreviewRate(ref.current, speed)
  }, [speed, src])

  useEffect(() => {
    if (isPlaying) ref.current?.play().catch(() => {})
    else ref.current?.pause()
  }, [isPlaying])

  return (
    <video
      ref={ref}
      className="preview-blur-backdrop"
      src={src}
      muted
      style={{ filter: `blur(${blurPx}px)` }}
    />
  )
}

/**
 * クロスフェードで**消えていく側**(前のクリップ)を上に重ねる1枚。
 *
 * 作りは `PreviewBlurBackdrop` と同じ(2枚目の `<video>` を local time で回す)。
 * 違いは合わせ直しのしきい値で、ぼかし背景と違って**混ざった絵がそのまま見える**ので
 * 0.3秒では甘い。短い窓(最長2秒)しか映らないぶん、合わせ直しが多少増えても構わない。
 *
 * 音は鳴らさない(`muted`)。書き出しは `acrossfade` で音も混ぜるが、画面側の音は
 * 本編の1枚が持っているので、ここで鳴らすと**二重に聞こえる**。
 */
function PreviewCrossfadeLayer({
  src,
  localTime,
  isPlaying,
  opacity,
  speed,
  fit,
  seekToken
}: {
  src: string
  localTime: number
  isPlaying: boolean
  opacity: number
  speed: number
  fit: CSSProperties
  /** 明示的なシークの合図(`seekRequest.token`)。変わったら位置をぴったり入れ直す */
  seekToken: number
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    followPreviewTime(ref.current, localTime, PREVIEW_BLEND_FOLLOW_TOLERANCE_SEC)
  }, [localTime])

  // **明示的なシークはぴったり入れ直す**(理由は previewSync)。許容(0.12秒)より
  // 小さくシークすると、混ざる相手だけ前の絵のまま取り残される。
  useEffect(() => {
    seekPreviewTime(ref.current, localTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToken])

  // 速度は**それ自身の依存を持つ effect** で入れ直す。読み込みの経路だけで書くと、
  // 再生しながら速度を変えたときに古い値のまま回り続ける(前に本編と背景で踏んでいる)。
  // **`src` も依存に入れる。** 差し替えると `playbackRate` は既定へ戻されるので、
  // 速度が同じまま別素材が混ざる側に来ると等倍のまま取り残される(理由は previewSync)。
  useEffect(() => {
    applyPreviewRate(ref.current, speed)
  }, [speed, src])

  useEffect(() => {
    if (isPlaying) ref.current?.play().catch(() => {})
    else ref.current?.pause()
  }, [isPlaying])

  return (
    <video
      ref={ref}
      className="preview-crossfade-layer"
      src={src}
      muted
      style={{ ...fit, opacity }}
    />
  )
}

/**
 * プレビューの音量を鳴らすための共通 `AudioContext`。
 *
 * 再生要素ごとに作ると出力デバイスを食い潰すので1つだけ持つ。**1倍を超える音量を
 * 実際に要求されたときにだけ**作る(下の `attachGainNode` 参照)。
 */
let sharedAudioContext: AudioContext | null = null
function getSharedAudioContext(): AudioContext | null {
  if (sharedAudioContext) return sharedAudioContext
  try {
    sharedAudioContext = new AudioContext()
  } catch {
    sharedAudioContext = null
  }
  return sharedAudioContext
}

/**
 * 再生要素を `GainNode` 経由に付け替えて、1倍を超える音量を出せるようにする。
 *
 * `createMediaElementSource` は**要素につき1回しか呼べず、呼んだら元に戻せない**。
 * そのうえ `AudioContext` が動かない環境だと、付け替えた瞬間に音が消える——今の
 * 頭打ち(音は出るが大きくならない)より悪い。なので **1倍を超える音量を実際に
 * 要求されたときにだけ**付け替え、失敗したら今までどおり `el.volume` に倒す。
 * 1倍以下しか使わない利用者の経路は、これまでと1バイトも変わらない。
 */
function attachGainNode(el: HTMLAudioElement): GainNode | null {
  const nodes = attachAudioNodes(el)
  if (!nodes) return null
  // 以後の音量は GainNode 側が持つ。要素側は素通しにしておく。
  el.volume = MEDIA_ELEMENT_MAX_VOLUME
  return nodes.gain
}

/**
 * 1つの再生要素に対して作る WebAudio のノード一式。
 *
 * `createMediaElementSource` は**要素につき1回しか呼べず、2回目は必ず投げる**。
 * 音量用の `GainNode` と、ダッキングの測定用の `AnalyserNode` は**同じ要素に両方
 * 要ることがある**(分離した本編の音声を、聞かせながら測る)ので、
 * 作った `source` を要素ごとに覚えておいて使い回す。
 */
type ElementAudioNodes = { source: MediaElementAudioSourceNode; gain: GainNode }
const audioNodesByElement = new WeakMap<HTMLMediaElement, ElementAudioNodes>()

function attachAudioNodes(el: HTMLMediaElement): ElementAudioNodes | null {
  const existing = audioNodesByElement.get(el)
  if (existing) return existing
  const ctx = getSharedAudioContext()
  if (!ctx) return null
  try {
    const source = ctx.createMediaElementSource(el)
    const gain = ctx.createGain()
    source.connect(gain)
    gain.connect(ctx.destination)
    const nodes = { source, gain }
    audioNodesByElement.set(el, nodes)
    return nodes
  } catch {
    return null
  }
}

/**
 * ダッキングの「いま掛かっている倍率」を配る仕組み。
 *
 * 毎フレーム変わる値なので、**React の state に載せない**——載せるとプレビュー全体が
 * 毎フレーム再描画される(クリップが増えるほど重くなる既知の問題)。倍率を欲しい
 * `<audio>` 側が適用関数を登録し、測定ループがそれを呼ぶ。
 */
const duckAppliers = new Set<(duckGain: number) => void>()
/** いま掛かっているダッキングの倍率。途中で生えた `<audio>` もこの値から始める */
const duckGainRef = { current: 1 }

/**
 * 測定の窓。`analyser.fftSize` と読み出しバッファで同じ値を使う。
 * 検出器は「経過時間ぶんの末尾」を読むので、コマ間隔より長い時間を
 * 持てる大きさにする(2048 = 48kHz で約43ms。30fps のコマ間隔でも収まる)。
 */
const DUCK_FFT_SIZE = 2048

/**
 * 「本編の音」のうち、**音声トラックへ移っているぶん**の測り口。
 *
 * 音声分離を使うと本編の `<video>` は `muted` になり、声は `linkedClipId` を持つ
 * 音声クリップの `<audio>` へ移る。本編の要素だけを測っていると**無音を測る**ことになり、
 * ダッキングは掛かったまま一度も反応しない(倍率 1.0000 のまま)。
 * 書き出し側と同じ「本編の音 = 本編クリップの音声 + `linkedClipId` を持つ音声クリップ」に
 * するため、リンク付きのクリップが自分の測り口をここへ置く。
 *
 * `gain` は**マスター音量を除いた**倍率(トラック音量 × クリップ音量 × フェード)。
 * 測っているのは `el.volume` を通す前の生の波形なので、書き出しと同じ大きさに直すために
 * ここで掛ける。試聴の音量でダッキングの強さが変わってはいけない。
 */
const mainVoiceProbes = new Set<{ analyser: AnalyserNode; gain: () => number }>()

/**
 * 本編の音声レベルを測って、ダッキングの倍率を配り続ける。
 *
 * `createMediaElementSource` は**要素につき1回しか呼べず、戻せない**。しかも失敗すると
 * 本編の音が消える——アプリの真ん中が壊れる。なので**ダッキングを実際に使っている
 * ときだけ**付け替え、失敗したら倍率1(今までどおり=ダッキングなし)に倒す。
 * 使っていない利用者の経路は1バイトも変わらない。
 *
 * **付け替えは effect の入口ではなく、測定ループの中で「いまの要素」に対して行う。**
 * 入口で `videoRef.current` を1回読むだけだと、`<video>` がまだ生えていない瞬間に
 * 走ったときに何も起きず、**二度と試されない**——ref は依存に書けないので、要素が
 * 現れたことを effect は知れない。これは例外的な順序ではなく**保存したプロジェクトを
 * 開いた既定の順序**で、`<video>` は `activeSrc` が入った次の描画で初めて生える。
 * (実測: ダッキングを入れたまま保存したプロジェクトを開いて再生すると、本編が
 *  鳴っている間も BGM の倍率は **1.0000 のまま**。ダッキングを切って入れ直すと
 *  同じ再生で **0.599〜0.606** に下がった——設定は最初から `true` のまま)
 * 要素は**作り直されることもある**(クリップを全部消すと `<video>` ごと消え、置き直すと
 * 別の要素になる)。死んだ要素に付いた analyser を持ち続けると、読み取る波形が無音に
 * なって同じく倍率1に戻る(実測: 消して置き直したあとの倍率は **1.0000**)。
 * どちらも「いま画面にある要素に付いているか」を毎フレーム見れば起きない。
 */
function useMainAudioDucking(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  masterVolume: number,
  masterMuted: boolean
): void {
  const analyserRef = useRef<AnalyserNode | null>(null)
  /**
   * `analyserRef` がぶら下がっている要素。**付け替えを試した要素**でもある(成否は問わない)。
   * 失敗した要素をここに残さないと、`createMediaElementSource` を毎フレーム呼び直して
   * 2回目の呼び出しで必ず投げる。
   */
  const attachedElRef = useRef<HTMLVideoElement | null>(null)
  // 測定は毎フレーム走るので、最新値は ref で渡す(state にすると再描画が走る)
  const volumeRef = useRef(masterVolume)
  const mutedRef = useRef(masterMuted)
  useEffect(() => {
    volumeRef.current = masterVolume
    mutedRef.current = masterMuted
  }, [masterVolume, masterMuted])

  useEffect(() => {
    if (!enabled) {
      // 掛かっていた分を戻してから止める(切り替えた瞬間に下がったままにしない)
      duckGainRef.current = 1
      duckAppliers.forEach((apply) => apply(1))
      return
    }
    /**
     * いま画面にある `<video>` に付いた analyser を返す。付いていなければ付け替える。
     * 同じ要素なら ref の比較1回で返るので、毎フレーム呼んでよい。
     */
    const analyserForCurrentElement = (): AnalyserNode | null => {
      const el = videoRef.current
      if (el === attachedElRef.current) return analyserRef.current
      // 要素が変わった(初めて生えた / 作り直された)。前の analyser は死んだ要素のもの。
      analyserRef.current = null
      attachedElRef.current = el
      if (!el) return null
      const ctx = getSharedAudioContext()
      try {
        if (!ctx) throw new Error('no audio context')
        const source = ctx.createMediaElementSource(el)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = DUCK_FFT_SIZE
        source.connect(analyser)
        // **destination へも必ず繋ぐ。** 繋がないと本編の音がここで止まる。
        source.connect(ctx.destination)
        analyserRef.current = analyser
      } catch {
        analyserRef.current = null
      }
      void ctx?.resume()
      return analyserRef.current
    }

    // 検出器は書き出し(`sidechaincompress`)と同じ非対称追従器(@shared/ducking)。
    // 以前の「実効値 → 静特性 → 倍率をなます」だと、書き出しだけ常に約2dB深く
    // 下がっていた(検出器まで同じにしないと、同じ数字を配っても揃わない)。
    const detector = createDuckDetector()
    const sampleBuf = new Float32Array(DUCK_FFT_SIZE)
    const powerBuf = new Float32Array(DUCK_FFT_SIZE)
    let frame = 0
    let last = performance.now()
    const tick = (): void => {
      const now = performance.now()
      const dt = now - last
      last = now
      const analyser = analyserForCurrentElement()
      if (!analyser && mainVoiceProbes.size === 0) {
        // 付け替えられない間は今までどおり素通し(ダッキングなし)。
        duckGainRef.current = 1
        duckAppliers.forEach((apply) => apply(1))
        frame = requestAnimationFrame(tick)
        return
      }
      // 測っているのは**試聴の音量を掛けたあと**の波形(要素の volume はノードより手前)。
      // 書き出しのダッキングは試聴音量と無関係なので、掛かっていたぶんを割り戻す。
      // ミュート中は本編の大きさが分からないので、掛けない(倍率1)。
      const monitor = mutedRef.current ? 0 : volumeRef.current
      const sampleRate = getSharedAudioContext()?.sampleRate ?? 48000
      // 検出器は1サンプルずつ進む。バッファは「直近 DUCK_FFT_SIZE 本」なので、
      // 前回のコマから経過した時間ぶんの**末尾だけ**を流す(コマ落ちしても
      // 同じサンプルを二重に食わせない。時定数は経過時間で守られる)
      const count = Math.min(DUCK_FFT_SIZE, Math.max(1, Math.round((dt / 1000) * sampleRate)))
      const offset = DUCK_FFT_SIZE - count
      powerBuf.fill(0, 0, count)
      if (analyser && monitor > 0) {
        analyser.getFloatTimeDomainData(sampleBuf)
        for (let i = 0; i < count; i++) {
          const v = sampleBuf[offset + i] / monitor
          if (Number.isFinite(v)) powerBuf[i] += v * v
        }
      }
      // 分離された本編の音声を足す。**二重には数えない**——分離中の `<video>` は
      // `muted` なので上の測定は 0 になり、分離していなければリンク付きのクリップが無い。
      // 無相関な音の合成は**電力の足し算**(振幅で足すと同じ音が2倍=+6dBに見える)。
      mainVoiceProbes.forEach((probe) => {
        probe.analyser.getFloatTimeDomainData(sampleBuf)
        const g = probe.gain()
        if (!Number.isFinite(g) || g === 0) return
        for (let i = 0; i < count; i++) {
          const v = sampleBuf[offset + i] * g
          if (Number.isFinite(v)) powerBuf[i] += v * v
        }
      })
      advanceDuckDetector(detector, powerBuf, count, sampleRate)
      const gain = mutedRef.current ? 1 : duckGainForLevel(duckDetectorLevel(detector))
      duckGainRef.current = gain
      duckAppliers.forEach((apply) => apply(gain))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      duckGainRef.current = 1
      duckAppliers.forEach((apply) => apply(1))
    }
  }, [enabled, videoRef])
}

// Plays one BGM/narration/SE clip during preview via a hidden <audio> element,
// mounted only while the playhead is inside the clip's range. Ducking is applied
// live from the main track's measured level (see useMainAudioDucking).
function AudioTrackClipLayer({
  clip,
  asset,
  trackVolume,
  trackMuted,
  trackDucking,
  isMainVoice,
  playheadTime,
  isPlaying,
  masterVolume,
  masterMuted,
  seekToken
}: {
  clip: AudioTrackClip
  asset: MediaAsset
  trackVolume: number
  trackMuted: boolean
  trackDucking: boolean
  /** 分離された本編の音声で、いまダッキングが測り口を必要としているか */
  isMainVoice: boolean
  playheadTime: number
  isPlaying: boolean
  masterVolume: number
  masterMuted: boolean
  /** 明示的なシークの合図(`seekRequest.token`)。変わったら位置をぴったり入れ直す */
  seekToken: number
}): React.JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  const audioSrc = previewSourceUrl(asset)
  const speed = clip.speed || 1
  // タイムライン秒 → 素材秒は速度を掛ける。等倍以外だと素材の進みが速く(遅く)なる。
  const localTime = clip.inPoint + (playheadTime - clip.startTime) * speed

  // 連続再生中の追従はゆるく(毎フレーム書き込むと音が飛ぶ)。理由は previewSync。
  useEffect(() => {
    followPreviewTime(ref.current, localTime)
  }, [localTime])

  // **明示的なシークはぴったり入れ直す。** 上の追従は許容(0.3秒)より小さいズレを
  // 直さないので、これが無いと**許容より小さくシークしたときだけ音が前の位置に
  // 取り残され、そのまま再生してもズレたまま**進む(絵は本編が必ず入れ直すので合っている)。
  useEffect(() => {
    seekPreviewTime(ref.current, localTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToken])

  // `src` も依存に入れる理由はぼかし背景と同じ。ここはプロキシの変換が終わった
  // ときに差し替わる(理由は previewSync)。
  useEffect(() => {
    applyPreviewRate(ref.current, speed)
  }, [speed, audioSrc])

  useEffect(() => {
    if (isPlaying) {
      ref.current?.play().catch(() => {})
    } else {
      ref.current?.pause()
    }
  }, [isPlaying])

  // 書き出しの afade と同じ規則(共通モジュール)でゲインを掛ける。
  // ここで別式にすると、画面で聞いた音と出来上がりが黙って食い違う。
  const fadeGain = fadeGainAt(
    playheadTime - clip.startTime,
    audioClipDuration(clip),
    clip.fadeIn,
    clip.fadeOut
  )
  // 音量の式は書き出しと同じ共通モジュール。マスター音量は「試聴の音量」なので
  // 画面側にだけ掛ける(書き出しには入れない)。
  const exportGain = Math.max(0, audioClipGain(trackVolume, clip.volume) * fadeGain)
  const effectiveVolume = Math.max(0, masterVolume * exportGain)
  const gainNodeRef = useRef<GainNode | null>(null)
  // ダッキングの測定に渡す「書き出しと同じ大きさ」の倍率(マスター音量を含まない)
  const exportGainRef = useRef(exportGain)

  // 素の倍率(ダッキング前)を毎フレームの適用側から読めるようにしておく。
  // state にすると測定ループのたびに再描画が走る。
  const baseGainRef = useRef(effectiveVolume)

  const applyGain = (duckGain: number): void => {
    const el = ref.current
    if (!el) return
    const total = baseGainRef.current * (Number.isFinite(duckGain) ? duckGain : 1)
    const gainNode = gainNodeRef.current
    if (gainNode) {
      gainNode.gain.value = Number.isFinite(total) ? Math.max(0, total) : 0
      return
    }
    el.volume = toElementVolume(total)
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.muted = masterMuted || trackMuted
    // 一度 GainNode に付け替えたら、以後は必ずそちらで音量を持つ(戻せないため)。
    // 分離した本編の音声は**測るために必ず付け替える**——付けないと要素側の `volume` に
    // 音量が乗り、測った波形に試聴音量やクリップ音量が二重に掛かる。
    if (!gainNodeRef.current && (needsWebAudioGain(effectiveVolume) || isMainVoice)) {
      gainNodeRef.current = attachGainNode(el)
    }
    if (gainNodeRef.current) void getSharedAudioContext()?.resume()
    baseGainRef.current = effectiveVolume
    exportGainRef.current = exportGain
    // ダッキング中は測定ループが毎フレーム掛け直すので、ここでは素の倍率だけ入れる
    // (掛け算の相手は applyGain が持っている)。
    applyGain(duckGainRef.current)
  }, [effectiveVolume, exportGain, masterMuted, trackMuted, isMainVoice])

  // 分離された本編の音声は、鳴らしながら測り口を出す(書き出しのサイドチェインと同じ集合)。
  // リンクが外れたクリップ・ダッキングを使っていないときは登録しないので、
  // その経路は今までと1バイトも変わらない。
  useEffect(() => {
    if (!isMainVoice) return
    const el = ref.current
    if (!el) return
    const ctx = getSharedAudioContext()
    const nodes = attachAudioNodes(el)
    if (!ctx || !nodes) return
    const analyser = ctx.createAnalyser()
    analyser.fftSize = DUCK_FFT_SIZE
    nodes.source.connect(analyser)
    const probe = { analyser, gain: (): number => exportGainRef.current }
    mainVoiceProbes.add(probe)
    return () => {
      mainVoiceProbes.delete(probe)
      analyser.disconnect()
    }
  }, [isMainVoice])

  // ダッキングが有効なトラックだけ、測定ループの配信先に登録する。
  // 有効でないトラックの経路は今までと同じ(登録しないので誰も触らない)。
  useEffect(() => {
    if (!trackDucking) return
    duckAppliers.add(applyGain)
    return () => {
      duckAppliers.delete(applyGain)
      // 抜けるときは掛かっていたぶんを戻す
      applyGain(1)
    }
  }, [trackDucking])

  useEffect(() => {
    return () => {
      gainNodeRef.current?.disconnect()
      gainNodeRef.current = null
    }
  }, [])

  // Hidden: this element exists only to play back the audio-track clip, and must
  // not take part in the preview frame's layout.
  return <audio ref={ref} src={audioSrc} style={{ display: 'none' }} />
}

export function PreviewPlayer(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)
  const togglePlayback = useProjectStore((s) => s.togglePlayback)
  const setPlayheadTime = useProjectStore((s) => s.setPlayheadTime)
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const seekRequest = useProjectStore((s) => s.seekRequest)
  // 脇役(BGM・効果音・分離音声・PiP)へ配る「シークした」の合図。
  // 本編と同じ合図から出すので、入れ直す時刻が食い違わない(理由は previewSync)。
  const seekToken = seekRequest?.token ?? 0
  const seekTo = useProjectStore((s) => s.seekTo)
  const updateTextOverlay = useProjectStore((s) => s.updateTextOverlay)
  const exportResolutionHeight = useSettingsStore((s) => s.exportResolutionHeight)

  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  // 枠の高さは左右パネルのドラッグ・ウィンドウリサイズ・プレビューの拡大で変わるので、
  // 実測して追従させる。テロップの換算倍率の分母になる。
  const [frameHeight, setFrameHeight] = useState(0)
  // 幅も同じ経路で測る。PiP の余白は**幅**基準(書き出しと同じ規則)なので要る。
  const [frameWidth, setFrameWidth] = useState(0)
  const activeTimedClipRef = useRef<TimedClip | null>(null)
  const [overlayDrag, setOverlayDrag] = useState<OverlayDragState | null>(null)
  const [showShortsUi, setShowShortsUi] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [volume, setVolume] = useState(readStoredVolume)
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTED_KEY) === 'true')
  const [scrubbingPreview, setScrubbingPreview] = useState(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const scrubTrackRef = useRef<HTMLDivElement>(null)

  // The preview uses Chromium's <video>, which supports far fewer codecs than the
  // ffmpeg used for export — H.265/HEVC and AV1 game captures decode fine on export
  // but fail here. Without this, play() just rejects, the button stays in its
  // "playing" state and nothing moves, with no indication of why.
  const UNPLAYABLE_MESSAGE =
    'この動画はプレビューで再生できません。H.265(HEVC)やAV1など、プレビューが対応していない形式の可能性があります。カット位置の指定などの編集は行えます。書き出しは別の仕組み(ffmpeg)を使うため、成功する場合があります。'

  function handleVideoError(): void {
    const code = videoRef.current?.error?.code
    setIsPlaying(false)
    setPlaybackError(
      code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
        ? UNPLAYABLE_MESSAGE
        : 'この動画を読み込めませんでした。ファイルが移動・削除されていないか確認してください。'
    )
  }

  // A file whose video stream can't be decoded but whose audio can (HEVC video + AAC
  // audio) loads "successfully" and fires no error — it just never produces a frame.
  // videoWidth is the only signal that separates it from a working clip.
  // 枠の実寸を測って追従する。ResizeObserver なので、パネルのドラッグでも
  // ウィンドウリサイズでも拡大表示の切り替えでも同じ経路で更新される。
  // useEffect だと描画のあとに測ることになり、最初の1フレームだけ倍率0(文字が消える)
  // で描かれてしまうため、描画前に走る useLayoutEffect を使う。
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const initial = el.getBoundingClientRect()
    setFrameHeight(initial.height)
    setFrameWidth(initial.width)
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) {
        setFrameHeight(rect.height)
        setFrameWidth(rect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [isExpanded])

  // 書き出しの ASS は PlayResY = **固定のキャンバス高**(出力解像度ではない)で、
  // 文字サイズはそのキャンバス上のピクセル。画面では「枠の高さ / キャンバスの高さ」倍で
  // 描くと、フレームに対する比率が出力と一致する。
  // ここに出力解像度を使うと、**書き出し設定を変えただけで画面のテロップが伸び縮みする**
  // (書き出し側は libass がキャンバスを引き伸ばすので変わらないのに、画面だけ動く)。
  const textCanvasHeight = textCanvasSize(project.aspectRatio).h
  const overlayScale = frameHeight > 0 && textCanvasHeight > 0 ? frameHeight / textCanvasHeight : 0

  // ぼかし背景の強さは**出力の高さ**基準(書き出しは `gblur=sigma=blurSigmaFor(出力高)`)。
  // テロップとは基準の辺が違うので、`overlayScale` を使い回してはいけない。
  const outputHeight = targetResolution(project.aspectRatio, exportResolutionHeight).h
  const outputScale = frameHeight > 0 && outputHeight > 0 ? frameHeight / outputHeight : 0

  function handleLoadedMetadata(): void {
    const video = videoRef.current
    if (!video) return
    // 読み込み直しを待っていた位置をここで入れる。差し替えの直後に入れると
    // 読み込みの `emptied` に流されるため(理由は pendingPreviewLoad)。
    if (applyPendingPreviewLoad(video, pendingLoadRef.current)) pendingLoadRef.current = null
    const expectsVideo = activeTimedClipRef.current?.asset.hasVideo ?? true
    if (expectsVideo && video.videoWidth === 0) {
      setIsPlaying(false)
      setPlaybackError(UNPLAYABLE_MESSAGE)
      return
    }
    setPlaybackError(null)
  }

  function clientToNormalized(clientX: number, clientY: number): { x: number; y: number } {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0.5, y: 0.5 }
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    }
  }

  useEffect(() => {
    if (!overlayDrag) return
    function handleMouseMove(e: MouseEvent): void {
      setOverlayDrag((prev) =>
        prev ? { ...prev, ...clientToNormalized(e.clientX, e.clientY) } : prev
      )
    }
    function handleMouseUp(): void {
      const overlay = project.textOverlays.find((o) => o.id === overlayDrag?.id)
      if (overlay && overlayDrag) {
        updateTextOverlay(overlayDrag.id, {
          style: { ...overlay.style, customPosition: { x: overlayDrag.x, y: overlayDrag.y } }
        })
      }
      setOverlayDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [overlayDrag, project.textOverlays, updateTextOverlay])

  const timedClips = useMemo(() => buildTimedClips(project), [project])
  // 書き出しの `gblur=sigma` は出力ピクセル基準。画面では枠の実寸に合わせて換算する
  // (固定倍率を書くと解像度や枠の大きさを変えたときに見た目が食い違う)。
  // CSS の `blur(v)` は標準偏差 v/2 のガウスぼかしなので、sigma を2倍して渡す。
  const blurBackdrop = ((): { localTime: number; blurPx: number; speed: number } | null => {
    const tc = findTimedClipAt(timedClips, playheadTime)
    if (!tc || tc.clip.fillCrop || !tc.clip.blurBackground) return null
    if (outputScale <= 0) return null
    const speed = tc.clip.speed || 1
    return {
      localTime: tc.clip.inPoint + (playheadTime - tc.start) * speed,
      blurPx: blurSigmaFor(outputHeight) * outputScale * 2,
      speed
    }
  })()

  /**
   * クロスフェードの重ね合わせ。**前のクリップの終わりを、次のクリップの頭に重ねて薄く消す。**
   *
   * 書き出し(`xfade`)は2本を**重ねて**混ぜるので出力はそのぶん短くなるが、
   * タイムラインはクリップを隙間なく並べた形のまま(尺の持ち方を変えるのは別の話)。
   * そのため重なりぶんの「余った時間」がどうしても片方に出る。**次のクリップ側に置く**
   * のは、こちらなら**今見ているショットが途切れずに正しく進む**から——逆に前の
   * クリップの終わりに置くと、次のショットの頭が重なりのぶん巻き戻って見える。
   * 混ぜている絵の中身(前の終わり t 秒 × 次の頭 t 秒)と混ぜ方(線形)は書き出しと同じ。
   *
   * 実効の長さは書き出しと**同じ関数**から出す(`effectiveTransitionSeconds`)。
   * 指定した長さがそのまま掛かるとは限らず、隣が短いと詰められる。
   */
  const targetSize = targetResolution(project.aspectRatio, exportResolutionHeight)
  const crossfade = ((): {
    src: string
    localTime: number
    opacity: number
    speed: number
    fit: CSSProperties
  } | null => {
    const tc = findTimedClipAt(timedClips, playheadTime)
    if (!tc) return null
    const index = timedClips.findIndex((c) => c.clip.id === tc.clip.id)
    if (index <= 0) return null
    const seconds = effectiveTransitionSeconds(
      timedClips.map((c) => c.end - c.start),
      timedClips.map((c) => c.clip.transitionIn)
    )
    const t = seconds[index]
    if (t <= 0) return null
    // 範囲はまずクロスフェードだけ。`fade`(黒を挟む)と `wipe` は書き出し側の
    // 見た目が別物なので、中途半端に似せずハードカットのままにしてある。
    if (tc.clip.transitionIn?.type !== 'crossfade') return null
    const elapsed = playheadTime - tc.start
    if (elapsed < 0 || elapsed >= t) return null
    const prev = timedClips[index - 1]
    const prevSpeed = prev.clip.speed || 1
    return {
      src: previewSourceUrl(prev.asset),
      // 前のクリップの**最後の t 秒**を流す(書き出しが混ぜているのと同じ範囲)
      localTime: prev.clip.outPoint - (t - elapsed) * prevSpeed,
      // 出てくる側の不透明度が `crossfadeOpacity`。重ねているのは消える側なので裏返す
      opacity: 1 - crossfadeOpacity(elapsed, t),
      speed: prevSpeed,
      // **前のクリップ自身の**収め方で描く。今のクリップの収め方を使い回すと、
      // 片方だけ「画面いっぱい」のときに切り替わった瞬間に絵の大きさが飛ぶ。
      fit: cropPreviewStyle(
        prev.asset.width / prev.asset.height,
        targetSize.w / targetSize.h,
        prev.clip.fillCrop,
        prev.clip.cropCenter
      )
    }
  })()

  // 「クロップして画面いっぱいに表示」を画面にも反映する。式は `cropPreviewStyle` に
  // まとめてある(トリムのモーダルも同じ関数を呼ぶ。書き写すと片方だけ直したときに
  // 「画面では切れているのにモーダルでは切れていない」という食い違いが黙って生まれる)。
  const cropFit = ((): CSSProperties => {
    const tc = findTimedClipAt(timedClips, playheadTime)
    if (!tc) return { objectFit: 'contain' }
    const target = targetResolution(project.aspectRatio, exportResolutionHeight)
    return cropPreviewStyle(
      tc.asset.width / tc.asset.height,
      target.w / target.h,
      tc.clip.fillCrop,
      tc.clip.cropCenter
    )
  })()

  const total = totalTimelineDuration(timedClips)
  // 書き出したファイルの尺。つなぎの重なりぶんタイムラインより短くなる。
  // 再生位置やシークはタイムライン秒のままなので、総尺ラベルの**横に併記**する
  // (置き換えると、末尾で止めたとき「現在 0:20 / 全体 0:19」という壊れた表示になる)
  const exportTotal = totalExportDuration(timedClips)

  // Continuous drag-scrubbing on the preview's own progress bar: seekTo() already
  // preserves the isPlaying state, so this lets the user grab the bar and drag through
  // the video while it keeps playing, not just click to jump once.
  useEffect(() => {
    if (!scrubbingPreview) return
    function handleMove(e: MouseEvent): void {
      const rect = scrubTrackRef.current?.getBoundingClientRect()
      if (!rect || total <= 0) return
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      seekTo(ratio * total)
    }
    function handleUp(): void {
      setScrubbingPreview(false)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [scrubbingPreview, total, seekTo])

  const [activeSrc, setActiveSrc] = useState<string | null>(null)
  /** `src` を差し替えたときに、読み込み終わってから入れる位置(理由は pendingPreviewLoad) */
  const pendingLoadRef = useRef<PendingPreviewLoad | null>(null)
  // Long-lived closures (the rAF playback loop below) call loadClipForTime across many
  // renders without being recreated, so they'd otherwise compare against a stale
  // snapshot of `activeSrc` state. A ref is always current regardless of which
  // render's closure reads it, so use it for the actual comparison.
  const activeSrcRef = useRef<string | null>(null)

  function loadClipForTime(time: number, resumePlaying: boolean): void {
    const tc = findTimedClipAt(timedClips, time)
    activeTimedClipRef.current = tc
    if (!tc) {
      activeSrcRef.current = null
      setActiveSrc(null)
      setIsPlaying(false)
      return
    }
    const url = previewSourceUrl(tc.asset)
    const speed = tc.clip.speed || 1
    const localTime = tc.clip.inPoint + (time - tc.start) * speed
    if (activeSrcRef.current !== url) {
      activeSrcRef.current = url
      // **読み込み直しを挟むときは、ここで位置を入れない。** `src` を差し替えると
      // ブラウザは別のタスクで読み込みを始め、その中の `emptied` で再生位置が 0 に戻る。
      // つまり差し替えた直後の代入は**まだ前の素材に対するもの**で、直後に流される。
      // `requestAnimationFrame` を1回挟んでも順序は保証されない
      // (実測: 別素材のクリップへ飛ぶと `seeking`/`seeked` が一度も出ず、
      //  `emptied → loadstart → loadedmetadata → canplay` のあと **currentTime は 0 のまま**。
      //  A(0〜6秒)+B(0〜6秒)の並びで 7.5秒へ飛ぶと、B の 1.5秒ではなく **B の先頭**が映った)。
      // 新しい素材に対して確実に入れられるのは `loadedmetadata` の時点なので、そこまで控える。
      pendingLoadRef.current = { url, time: localTime, speed, play: resumePlaying }
      setActiveSrc(url)
    } else if (videoRef.current) {
      // 同じ素材なら読み込み直しは起きないので、その場で入れてよい(控えは捨てる)。
      pendingLoadRef.current = null
      videoRef.current.currentTime = localTime
      videoRef.current.playbackRate = toPlaybackRate(speed)
      if (resumePlaying) videoRef.current.play().catch(() => {})
    }
  }

  // Handle explicit seeks (from timeline clicks / trim UI), not continuous playback updates.
  useEffect(() => {
    if (!seekRequest) return
    // Reacting to an external event (timeline click) and driving the <video> element's
    // imperative API — not derivable from props/state, so this is not a "derived state" effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadClipForTime(seekRequest.time, isPlaying)
    // Intentionally only re-running on a new seek request, not on every isPlaying change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest?.token])

  // Initial load, and recovery when the currently-loaded clip is removed from the
  // timeline (e.g. deleted) — otherwise the preview keeps playing the stale, now
  // detached clip until it happens to reach its old out-point.
  useEffect(() => {
    const activeId = activeTimedClipRef.current?.clip.id
    const current = findTimedClipById(timedClips, activeId)
    if (activeId != null && !current) {
      loadClipForTime(playheadTime, isPlaying)
      return
    }
    if (!activeTimedClipRef.current && timedClips.length > 0) {
      loadClipForTime(0, false)
      return
    }
    // The loaded clip's source file can change while it stays on the timeline: a
    // preview proxy finishing its transcode swaps the asset's playback path. Without
    // this the element keeps the old, undecodable src and never starts.
    if (current && previewSourceUrl(current.asset) !== activeSrcRef.current) {
      loadClipForTime(playheadTime, isPlaying)
      return
    }
    // `timedClips` は project が変わるたび作り直されるので、ref が指しているのは常に
    // 「1つ前の配列の」オブジェクト。中身(start / outPoint)も編集前のまま凍っている。
    // 再生を止めずに、今の配列の同じクリップへ差し替える。
    if (current) {
      activeTimedClipRef.current = current
      // **速度もここで入れ直す。** `playbackRate` を書いているのは `loadClipForTime` だけで、
      // それは読み込み直しかシークのときしか走らない。だから**いま映っているクリップの
      // 速度を変えても要素は古い速度のまま**回り続ける。しかも再生位置の計算
      // (`globalTime = start + (currentTime - inPoint) / speed`)は新しい速度を使うので、
      // **速度を上げたのに再生位置がゆっくりになる**という逆の見え方になる。
      // (実測: 再生しながら2倍にすると `playbackRate` は 1 のままで、再生位置の進みが
      //  1.00 → **0.50 秒/秒**。止めて4倍にしてから再生しても `playbackRate` は 2 のままだった)
      // 読み込み直しはしない——`currentTime` を入れ直すことになり、音が飛ぶ。
      const video = videoRef.current
      const rate = toPlaybackRate(current.clip.speed)
      if (video && video.playbackRate !== rate) video.playbackRate = rate
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timedClips])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!isPlaying) {
      video.pause()
      return
    }
    // The <video> may already have failed to decode before play was ever pressed, in
    // which case no further error event fires — the button would otherwise sit in its
    // "playing" state forever with nothing moving.
    if (video.error) {
      handleVideoError()
      return
    }
    video.play().catch(() => {
      if (videoRef.current?.error) handleVideoError()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying])

  // Drive the playhead from requestAnimationFrame instead of the <video> element's
  // native `timeupdate` event, which only fires a handful of times per second and
  // makes the timeline playhead visibly jump instead of gliding smoothly.
  useEffect(() => {
    if (!isPlaying) return
    let frameId: number
    function tick(): void {
      const tc = activeTimedClipRef.current
      const video = videoRef.current
      if (tc && video) {
        const speed = tc.clip.speed || 1
        const globalTime = tc.start + (video.currentTime - tc.clip.inPoint) / speed
        setPlayheadTime(globalTime)

        if (video.currentTime >= tc.clip.outPoint - 0.02) {
          const next = nextTimedClip(timedClips, tc)
          if (next) {
            loadClipForTime(next.start, isPlaying)
          } else {
            video.pause()
            setIsPlaying(false)
          }
        }
      }
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, timedClips])

  // A clip whose audio was detached must not also play its embedded audio here —
  // the detached copy on the audio track supplies it, and both at once would double.
  const activeClipAudioDetached =
    findTimedClipAt(timedClips, playheadTime)?.clip.audioDetached ?? false

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume
      videoRef.current.muted = muted || activeClipAudioDetached
    }
  }, [volume, muted, activeSrc, activeClipAudioDetached])

  // ダッキングを使っているトラックが1つでもあるときだけ、本編のレベル測定を始める。
  // 使っていないプロジェクトでは本編の音声経路に一切触らない。
  const duckingInUse = project.audioTracks.some((t) => t.duckingEnabled && !t.muted)
  useMainAudioDucking(videoRef, duckingInUse, volume, muted)

  function stepFrame(direction: 1 | -1): void {
    // 1フレームぶんは素材のフレームレートで決まる。60fps の素材で 1/30 秒動かすと
    // 「1フレーム」と書いてあるのに2フレーム飛ぶ。書き出しと同じ関数から求める。
    const step = frameSeconds(project.clips, project.assets)
    const next = Math.max(0, Math.min(total, playheadTime + direction * step))
    seekTo(next)
  }

  useEffect(() => {
    localStorage.setItem(VOLUME_KEY, String(volume))
  }, [volume])
  useEffect(() => {
    localStorage.setItem(MUTED_KEY, String(muted))
  }, [muted])

  useEffect(() => {
    if (!isExpanded) return
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setIsExpanded(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isExpanded])

  const activeOverlays = project.textOverlays.filter(
    (o) => playheadTime >= o.startTime && playheadTime < o.endTime
  )

  const aspectClass = project.aspectRatio === '9:16' ? 'aspect-9-16' : 'aspect-16-9'

  return (
    <>
      {isExpanded && (
        <div className="preview-expanded-backdrop" onClick={() => setIsExpanded(false)} />
      )}
      <div className={`panel preview-player ${isExpanded ? 'expanded' : ''}`}>
        <div className="preview-frame-wrapper">
          <div className={`preview-frame ${aspectClass}`} ref={frameRef}>
            {activeSrc && blurBackdrop && (
              <PreviewBlurBackdrop
                src={activeSrc}
                localTime={blurBackdrop.localTime}
                isPlaying={isPlaying}
                blurPx={blurBackdrop.blurPx}
                speed={blurBackdrop.speed}
                seekToken={seekToken}
              />
            )}
            {activeSrc ? (
              <video
                ref={videoRef}
                src={activeSrc}
                style={cropFit}
                onEnded={() => setIsPlaying(false)}
                onError={handleVideoError}
                onLoadedMetadata={handleLoadedMetadata}
              />
            ) : (
              <div className="preview-empty">
                <ClapperboardIcon width={32} height={32} />
                <p>タイムラインにクリップを追加してください</p>
              </div>
            )}
            {/* 消えていく前のクリップは本編の**上**に重ねる。下に敷くと、本編が
                不透明なので何も見えない(不透明度を動かしているのはこちら側)。
                PiP・テロップより手前に出ないよう、重ね順は本編のすぐ上に留める。 */}
            {activeSrc && crossfade && (
              <PreviewCrossfadeLayer
                src={crossfade.src}
                localTime={crossfade.localTime}
                isPlaying={isPlaying}
                opacity={crossfade.opacity}
                speed={crossfade.speed}
                fit={crossfade.fit}
                seekToken={seekToken}
              />
            )}
            {playbackError && <div className="preview-playback-error">{playbackError}</div>}
            {/* 重なっている PiP は**全部**、書き出しと同じ並び順で重ねる
                (後ろのものが上。1本だけ出していた頃は画面と書き出しで別の絵が映っていた) */}
            {project.videoOverlayTracks
              .filter((t) => !t.hidden)
              .flatMap((track) =>
                activeVideoOverlayClips(track.clips, playheadTime).map((clip) => {
                  const asset = project.assets.find((a) => a.id === clip.assetId)
                  if (!asset) return null
                  return (
                    <VideoOverlayLayer
                      key={clip.id}
                      clip={clip}
                      asset={asset}
                      position={track.position}
                      scale={track.scale}
                      frameWidth={frameWidth}
                      playheadTime={playheadTime}
                      isPlaying={isPlaying}
                      volume={volume}
                      muted={muted}
                      seekToken={seekToken}
                    />
                  )
                })
              )}
            {activeOverlays.map((o) => {
              const livePos = overlayDrag?.id === o.id ? overlayDrag : o.style.customPosition
              const positionStyle: CSSProperties = livePos
                ? {
                    left: `${livePos.x * 100}%`,
                    top: `${livePos.y * 100}%`,
                    right: 'auto'
                  }
                : { ...horizontalInsetStyle, ...verticalAnchorStyle(o.style.position) }
              // **位置合わせと回転は `transform` ではなく `translate`/`rotate` に書く。**
              // 登場アニメーション(`anim-*`)のキーフレームは `transform` を指定していて、
              // **アニメーションの宣言はインラインの style より強い**。同じ `transform` に
              // 書くと、走っている 0.2〜0.5 秒のあいだ**こちらの指定が丸ごと消える**。
              // 消えるのは「中央ぞろえの -50%」「自由配置の -50%,-50%」「回転」で、
              // どれも**位置そのもの**なので、出てくる瞬間だけ別の場所に描かれて跳ねる。
              // (実測・枠 420x236: 中央ぞろえ+popIn は中心が縦 50% → **52.4%**、
              //  自由配置(0.5,0.5)+popIn は **(54.26%, 52.4%)**、
              //  自由配置(0.3,0.3)+slideInUp は **(34.26%, 39.57%)** と、
              //  本来の (30%, 30%) から縦に **17.83%** ずれる。回転15度は
              //  アニメ中の行列に回転成分が無く、**傾きが消えて**いた。
              //  下ぞろえだけはインラインの指定が無いので前からズレ 0)
              // `translate`/`rotate` は `transform` とは別のプロパティなので、
              // キーフレームの `transform` と**掛け合わさる**(適用順は
              // translate → rotate → transform)。CSS 側は触らない。
              if (livePos) positionStyle.translate = '-50% -50%'
              else if (o.style.position === 'center') positionStyle.translate = '0 -50%'
              if (o.style.rotation) positionStyle.rotate = `${o.style.rotation}deg`
              // **回して・拡大する軸は、書き出しと同じ「配置のアンカー」に置く。**
              // ASS は `\frz` も登場アニメの `\fscx/\fscy` も `\an` のアンカー(下ぞろえなら
              // 行の下端中央)を軸に掛けるが、CSS の既定は**箱の中心**。同じ設定なのに
              // 画面と出力で別の場所に描かれていた(理由と実測は textAnchorOriginCss)。
              positionStyle.transformOrigin = textAnchorOriginCss(
                o.style.position,
                Boolean(livePos)
              )
              // 「下から出る/上から出る」が動く距離は**枠の実寸から**出す。CSS に
              // `translateY(40px)` と固定px で書いてあったため、枠の大きさが変わるたびに
              // 書き出しとの比が動いていた(理由は TEXT_SLIDE_OFFSET_RATIO)。
              // キーフレーム側はこの変数だけを読む——数字を CSS へ書き戻さないため。
              ;(positionStyle as Record<string, string>)['--overlay-slide-offset'] =
                `${textSlideOffsetPx(frameHeight)}px`
              // 登場アニメーションの長さも同じ置き場から。CSS に秒を書き戻すと、
              // 書き出し(ASS の時刻)と2箇所に分かれる(理由は TEXT_ANIMATION_MS)。
              ;(positionStyle as Record<string, string>)['--overlay-anim-duration'] =
                `${TEXT_ANIMATION_MS[o.style.animation]}ms`
              return (
                <div
                  key={o.id}
                  className={`overlay-text ${livePos ? '' : `overlay-${o.style.position}`} anim-${o.style.animation}`}
                  style={{ ...overlayPreviewStyle(o.style, overlayScale), ...positionStyle }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setOverlayDrag({ id: o.id, ...clientToNormalized(e.clientX, e.clientY) })
                  }}
                >
                  {/* 背景箱は文字を包む内側に置く。外側は幅が確定した位置決めの箱なので、
                      そこへ塗ると文字の量と無関係な帯になる(`overlayBoxStyle` 参照)。
                      背景OFF のときは span を挟まず、今までと同じ木のまま描く。 */}
                  {o.style.background ? (
                    <span className="overlay-text-box" style={overlayBoxStyle(o.style)}>
                      {renderOverlayText(o, playheadTime)}
                    </span>
                  ) : (
                    renderOverlayText(o, playheadTime)
                  )}
                </div>
              )
            })}
            {showShortsUi && project.aspectRatio === '9:16' && <ShortsUiMockup />}
            {project.audioTracks.flatMap((track) =>
              track.clips
                .filter(
                  (c) =>
                    playheadTime >= c.startTime && playheadTime < c.startTime + audioClipDuration(c)
                )
                .map((clip) => {
                  const asset = project.assets.find((a) => a.id === clip.assetId)
                  if (!asset) return null
                  return (
                    <AudioTrackClipLayer
                      key={clip.id}
                      clip={clip}
                      asset={asset}
                      trackVolume={track.volume}
                      trackMuted={track.muted}
                      trackDucking={track.duckingEnabled}
                      isMainVoice={isMainVoiceClip(clip) && duckingInUse}
                      playheadTime={playheadTime}
                      isPlaying={isPlaying}
                      masterVolume={volume}
                      masterMuted={muted}
                      seekToken={seekToken}
                    />
                  )
                })
            )}
          </div>
        </div>
        <div className="preview-controls">
          <div className="preview-scrub-row">
            <span className="time-label current">{formatTime(playheadTime)}</span>
            <div
              ref={scrubTrackRef}
              className={`scrub-track ${scrubbingPreview ? 'scrubbing' : ''}`}
              onMouseDown={(e) => {
                if (total <= 0) return
                const rect = e.currentTarget.getBoundingClientRect()
                const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                seekTo(ratio * total)
                setScrubbingPreview(true)
              }}
            >
              <div
                className="scrub-fill"
                style={{
                  width: total > 0 ? `${Math.min(100, (playheadTime / total) * 100)}%` : '0%'
                }}
              />
            </div>
            <span className="time-label total">{formatTime(total)}</span>
            {exportTotal < total - 0.005 && (
              <span
                className="time-label export-total"
                title="つなぎは2本のクリップを重ねるため、書き出したファイルはタイムラインよりつなぎの秒数ぶん短くなります"
              >
                (書き出し {formatTime(exportTotal)})
              </span>
            )}
          </div>
          <div className="preview-transport-row">
            <div className="transport-side transport-side-left">
              {project.aspectRatio === '9:16' && (
                <button
                  className={`icon-button ${showShortsUi ? 'active' : ''}`}
                  title="YouTube Shorts の実際の画面イメージを重ねて表示(いいね/コメントなどのUIに字幕が隠れないか確認できます)"
                  onClick={() => setShowShortsUi((v) => !v)}
                >
                  <YoutubeIcon width={14} height={14} />
                </button>
              )}
            </div>
            <div className="transport-center">
              <button
                className="icon-button"
                title="先頭へ"
                disabled={!activeSrc}
                onClick={() => seekTo(0)}
              >
                <SkipBackIcon width={14} height={14} />
              </button>
              <button
                className="icon-button"
                title="1フレーム戻る (←)"
                disabled={!activeSrc}
                onClick={() => stepFrame(-1)}
              >
                <StepBackIcon width={14} height={14} />
              </button>
              <button className="play-button" onClick={togglePlayback} disabled={!activeSrc}>
                {isPlaying ? (
                  <PauseIcon width={16} height={16} />
                ) : (
                  <PlayIcon width={16} height={16} />
                )}
              </button>
              <button
                className="icon-button"
                title="1フレーム進む (→)"
                disabled={!activeSrc}
                onClick={() => stepFrame(1)}
              >
                <StepForwardIcon width={14} height={14} />
              </button>
              <button
                className="icon-button"
                title="末尾へ"
                disabled={!activeSrc}
                onClick={() => seekTo(total)}
              >
                <SkipForwardIcon width={14} height={14} />
              </button>
            </div>
            <div className="transport-side transport-side-right">
              <div className="preview-volume">
                <button
                  className="icon-button"
                  title={muted ? 'ミュート解除' : 'ミュート'}
                  onClick={() => setMuted((v) => !v)}
                >
                  {muted || volume === 0 ? (
                    <VolumeXIcon width={14} height={14} />
                  ) : (
                    <Volume2Icon width={14} height={14} />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setVolume(v)
                    if (v > 0 && muted) setMuted(false)
                  }}
                  title="音量"
                />
              </div>
              <button
                className={`icon-button ${isExpanded ? 'active' : ''}`}
                title={isExpanded ? '実サイズ表示を閉じる (Esc)' : '実サイズで表示'}
                onClick={() => setIsExpanded((v) => !v)}
              >
                <MaximizeIcon width={14} height={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
