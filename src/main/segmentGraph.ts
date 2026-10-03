import { colorMatchFilter } from '@shared/color/match'
import type { MediaAsset } from '@shared/types'
import type { AudioItem, MediaItem, Sequence, VideoItem } from '@shared/sequence/types'
import type { Segment } from '@shared/sequence/segmentPlan'
import { telopConcatList, type TelopLayerPayload } from '@shared/telop/layer'
import { audioClipGain } from '@shared/audioGain'
import { normalizeFades } from '@shared/audioFade'
import { duckingFilterArgs } from '@shared/ducking'
import { SQUARE_PIXEL_FILTER, scaleToFrameFilter } from '@shared/videoFrame'
import {
  AUDIO_FORMAT,
  OUTPUT_SAMPLE_RATE,
  VIDEO_FORMAT,
  audioSpeedChain,
  audioFormatFor,
  escapeFilterPath,
  xfadeName
} from './ffmpegService'

/**
 * セグメント1つぶんの ffmpeg の入力とフィルタグラフを組み立てる(純関数・ffmpeg は起動しない)。
 * 計画書: `docs/VARIETY_AUTO_EDIT_PLAN.md` §4.3
 *
 * v1 の書き出し(`ffmpegService.exportProject`)は企画全体を1つのグラフにしていた。
 * ここでは区間ごとに、**その区間に掛かるアイテムだけ**を入力にした小さなグラフを作る。
 * 1本ずつの枝の作り方(尺をフレーム数で切る・時刻を n 枚目から作り直す・音の形式を
 * 合流の手前で固定する 等)は、v1 の書き出しで実測して固めた手順をそのまま使う。
 * 理由はそれぞれ `ffmpegService` の該当箇所のコメントに実測付きで残っている。
 */

export interface GraphInput {
  /** `concatList` があるときは使わない(一覧のファイルを書き出し側が作る) */
  path: string
  /** 素材の何秒目から読むか */
  seek: number
  /** 何秒ぶん読むか */
  duration: number
  /** concat demuxer で読む一覧の中身(テロップの層)。あるときは `-ss/-t` を付けない */
  concatList?: string
}

export interface SegmentGraph {
  inputs: GraphInput[]
  /** `;` で繋いだフィルタグラフ(`-filter_complex_script` に書く) */
  filter: string
  /** 出力のラベル(`[vout]` / `[aout]`) */
  outLabel: string
}

export interface GraphContext {
  sequence: Sequence
  assetsById: ReadonlyMap<string, MediaAsset>
  /** 素材パス → 音声チャンネル数(分からない素材は入れない) */
  audioChannels?: ReadonlyMap<string, number>
  /** シーケンス全体のテロップを書いた ASS(時刻はシーケンスの絶対秒) */
  assPath?: string
  /**
   * 画面のプロセスが共通テロップレンダラで描いた、テロップの層。
   * **あるときは ASS より優先する**(画面と同じ絵になるのはこちら)
   */
  telopLayer?: { runs: TelopLayerPayload['runs']; imagePaths: readonly string[] }
}

/** ffmpeg に渡すフレームレートの表記(29.97 は `30000/1001`) */
export function fpsExpr(seq: Sequence): string {
  return seq.fps.den === 1 ? `${seq.fps.num}` : `${seq.fps.num}/${seq.fps.den}`
}

/** フレーム → 秒 */
export function frameToSeconds(seq: Sequence, frame: number): number {
  return (frame * seq.fps.den) / seq.fps.num
}

/**
 * フレーム → サンプル位置(48kHz)。**区間ごとの長さはこの差で決める**。
 * 29.97fps では1フレームが 1601.6 サンプルで整数にならないため、区間ごとに丸めると
 * 区間の数だけ誤差が積み上がる。絶対位置を丸めて差を取れば、合計は必ず全体と一致する。
 */
export function frameToSample(seq: Sequence, frame: number): number {
  return Math.round((frame * seq.fps.den * OUTPUT_SAMPLE_RATE) / seq.fps.num)
}

/** 数値を ffmpeg の引数に入れるための表記(指数表記や -0 を出さない) */
function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`フィルタに有限でない数が入りました: ${n}`)
  const r = Math.round(n * 1e9) / 1e9
  return Object.is(r, -0) ? '0' : String(r)
}

const intersects = (
  item: { startFrame: number; durationFrames: number },
  start: number,
  end: number
): boolean => item.startFrame < end && item.startFrame + item.durationFrames > start

// ------------------------------------------------------------------ 映像

export function buildSegmentVideoGraph(ctx: GraphContext, segment: Segment): SegmentGraph {
  const seq = ctx.sequence
  const W = seq.width
  const H = seq.height
  const fps = fpsExpr(seq)
  const tb = `${seq.fps.den}/${seq.fps.num}`
  const segStart = segment.startFrame
  const segEnd = segment.endFrame
  const segFrames = segEnd - segStart
  const sec = (frames: number): number => frameToSeconds(seq, frames)

  const inputs: GraphInput[] = []
  const parts: string[] = []
  let labelSeq = 0
  const newLabel = (prefix: string): string => `${prefix}${labelSeq++}`

  const assetOf = (item: MediaItem): MediaAsset => {
    const asset = ctx.assetsById.get(item.assetId)
    if (!asset) throw new Error(`素材が見つかりません: ${item.assetId}`)
    return asset
  }

  /** 素材を区間の分だけ読む入力を足し、入力番号を返す */
  const addMediaInput = (item: MediaItem, visStart: number, visEnd: number): number => {
    const asset = assetOf(item)
    const speed = item.speed > 0 ? item.speed : 1
    const skip = sec(visStart - item.startFrame)
    inputs.push({
      path: asset.filePath,
      seek: item.sourceIn + skip * speed,
      duration: sec(visEnd - visStart) * speed
    })
    return inputs.length - 1
  }

  /** カメラ間の色合わせ(素材に付いていれば、縮める前の画に掛ける) */
  const colorOf = (item: MediaItem): string => {
    const m = assetOf(item).colorMatch
    return m ? `${colorMatchFilter(m)},` : ''
  }

  /**
   * 1本の枝を「ちょうど `frames` 枚・時刻は n 枚目 × 1フレーム」に揃える後半。
   * tpad(足りない分を最後の絵で延ばす)→ trim(フレーム数で切る)→ 時刻の作り直し → fps。
   */
  const exactFrames = (frames: number): string =>
    `tpad=stop_duration=${num(sec(frames))}:stop_mode=clone,trim=end_frame=${frames},` +
    `settb=${tb},setpts=N,fps=${fps}`

  /** 画面いっぱいの枠に収める枝(V1 の本編) */
  const fullFrameBranch = (item: MediaItem, visStart: number, visEnd: number): string => {
    const idx = addMediaInput(item, visStart, visEnd)
    const label = newLabel('m')
    const speed = item.speed > 0 ? item.speed : 1
    const pl = item.placement
    const fit = pl.kind === 'frame' ? pl : { fit: 'contain' as const }
    const scale = scaleToFrameFilter(
      W,
      H,
      fit.fit === 'cover',
      'cropCenter' in fit ? fit.cropCenter : undefined,
      'blurBackground' in fit ? fit.blurBackground : undefined,
      { labelSuffix: `_${label}`, fps }
    )
    parts.push(
      `[${idx}:v]setpts=PTS/${num(speed)},${colorOf(item)}${scale},setsar=1,${exactFrames(visEnd - visStart)},${VIDEO_FORMAT}[${label}]`
    )
    return label
  }

  /** 黒の隙間 */
  const gapBranch = (frames: number): string => {
    const label = newLabel('g')
    parts.push(
      `color=c=black:s=${W}x${H}:r=${fps}:d=${num(sec(frames + 1))},setsar=1,` +
        `trim=end_frame=${frames},settb=${tb},setpts=N,fps=${fps},${VIDEO_FORMAT}[${label}]`
    )
    return label
  }

  // --- 一番下のトラック: 前から畳み込む(隙間は黒、繋ぎは xfade) ---
  interface Piece {
    label: string
    frames: number
    transFrames: number
    transType?: NonNullable<MediaItem['transitionIn']>['type']
  }
  const pieces: Piece[] = []
  const base = seq.videoTracks[0]
  let cursor = segStart
  if (base && !base.hidden) {
    const items = base.items
      .filter((i): i is MediaItem => i.kind === 'media' && intersects(i, segStart, segEnd))
      .sort((a, b) => a.startFrame - b.startFrame)
    for (const item of items) {
      if (!assetOf(item).hasVideo) continue
      const itemEnd = item.startFrame + item.durationFrames
      let visStart = Math.max(item.startFrame, segStart)
      const visEnd = Math.min(itemEnd, segEnd)
      let transFrames = 0
      if (visStart < cursor) {
        // 手前と重なっている。区間の中で始まる繋ぎなら xfade、それ以外(壊れたデータ)は重なりを捨てる
        if (item.transitionIn && item.startFrame >= segStart && pieces.length > 0) {
          transFrames = cursor - item.startFrame
        } else {
          visStart = cursor
        }
      } else if (visStart > cursor) {
        pieces.push({
          label: gapBranch(visStart - cursor),
          frames: visStart - cursor,
          transFrames: 0
        })
      }
      if (visEnd - visStart < 1) continue
      // xfade は前後どちらの長さより短くないと書き出しごと失敗する。データが壊れていたらハードカット
      const accumulated = pieces.reduce((s, p) => s + p.frames - p.transFrames, 0)
      if (transFrames >= visEnd - visStart || transFrames >= accumulated) {
        transFrames = 0
        visStart = cursor
        if (visEnd - visStart < 1) continue
      }
      pieces.push({
        label: fullFrameBranch(item, visStart, visEnd),
        frames: visEnd - visStart,
        transFrames,
        transType: item.transitionIn?.type
      })
      cursor = Math.max(cursor, visEnd)
    }
  }
  if (cursor < segEnd) {
    pieces.push({ label: gapBranch(segEnd - cursor), frames: segEnd - cursor, transFrames: 0 })
  }

  let cur = pieces[0].label
  let accFrames = pieces[0].frames
  for (const piece of pieces.slice(1)) {
    const out = newLabel('f')
    if (piece.transFrames > 0 && piece.transType) {
      parts.push(
        `[${cur}][${piece.label}]xfade=transition=${xfadeName(piece.transType)}:` +
          `duration=${num(sec(piece.transFrames))}:offset=${num(sec(accFrames - piece.transFrames))},` +
          `settb=${tb}[${out}]`
      )
      accFrames += piece.frames - piece.transFrames
    } else {
      parts.push(`[${cur}][${piece.label}]concat=n=2:v=1:a=0,settb=${tb}[${out}]`)
      accFrames += piece.frames
    }
    cur = out
  }

  // --- 上のトラック: 下から順に重ねる ---
  const halfFrame = sec(0.5)
  for (const track of seq.videoTracks.slice(1)) {
    if (track.hidden) continue
    for (const item of track.items) {
      if (item.kind !== 'media' || !intersects(item, segStart, segEnd)) continue
      if (!assetOf(item).hasVideo) continue
      const visStart = Math.max(item.startFrame, segStart)
      const visEnd = Math.min(item.startFrame + item.durationFrames, segEnd)
      const frames = visEnd - visStart
      const offset = visStart - segStart
      const idx = addMediaInput(item, visStart, visEnd)
      const label = newLabel('o')
      const speed = item.speed > 0 ? item.speed : 1
      const pl = item.placement
      let shape: string
      let x: string
      let y: string
      if (pl.kind === 'box') {
        const boxW = Math.max(2, Math.round((W * pl.width) / 2) * 2)
        const margin = Math.round(W * pl.margin)
        shape = `${SQUARE_PIXEL_FILTER},scale=${boxW}:-2`
        x = pl.anchor.endsWith('left') ? `${margin}` : `W-w-${margin}`
        y = pl.anchor.startsWith('top') ? `${margin}` : `H-h-${margin}`
      } else if (pl.fit === 'contain' && !pl.blurBackground) {
        // 上のトラックの余白は黒で塗らない(下のトラックが透けて見えるのが正しい)
        shape = `${SQUARE_PIXEL_FILTER},scale=${W}:${H}:force_original_aspect_ratio=decrease`
        x = '(W-w)/2'
        y = '(H-h)/2'
      } else {
        shape = scaleToFrameFilter(W, H, pl.fit === 'cover', pl.cropCenter, pl.blurBackground, {
          labelSuffix: `_${label}`,
          fps
        })
        x = '0'
        y = '0'
      }
      parts.push(
        `[${idx}:v]setpts=PTS/${num(speed)},${colorOf(item)}${shape},setsar=1,` +
          `tpad=stop_duration=${num(sec(frames))}:stop_mode=clone,trim=end_frame=${frames},` +
          `settb=${tb},setpts=N+${offset}[${label}]`
      )
      const out = newLabel('c')
      // 区間の境目は時刻の小数で判定しない(29.97fps で境目の1枚が揺れる)。半フレームずらして挟む
      const from = sec(offset) - halfFrame
      const to = sec(offset + frames) - halfFrame
      parts.push(
        `[${cur}][${label}]overlay=x=${x}:y=${y}:enable='between(t\\,${num(from)}\\,${num(to)})'[${out}]`
      )
      cur = out
    }
  }

  // --- テロップ(共通レンダラの層): 区間の分だけ画像を並べた一覧を1本の入力として重ねる ---
  const layerList = ctx.telopLayer
    ? telopConcatList(ctx.telopLayer.runs, ctx.telopLayer.imagePaths, segStart, segEnd, seq.fps)
    : null
  if (layerList) {
    inputs.push({ path: '', seek: 0, duration: 0, concatList: layerList })
    const idx = inputs.length - 1
    const layer = newLabel('l')
    const out = newLabel('t')
    // テロップ層は「替わる瞬間だけ1枚」のまばらな入力のまま重ねる。時刻はフレーム単位に丸める(settb)。
    // overlay は次の1枚が来るまで直前の1枚を使い続けるので、毎フレームへ複製しなくてよい。
    // 複製(fps)すると全フレームぶんの RGBA が overlay の待ち行列に溜まり、メモリを使い切る
    // (実測: 45秒の区間で 1080p は 9.3GB、4K は 13.5GB で止まった。複製をやめると数百 MB)
    parts.push(`[${idx}:v]format=rgba,settb=${tb}[${layer}]`)
    parts.push(`[${cur}][${layer}]overlay=0:0:eof_action=repeat[${out}]`)
    cur = out
  }

  // --- テロップ(従来の ASS): シーケンス全体の ASS を、区間の頭へ時刻をずらして焼く ---
  const hasTelop = seq.videoTracks.some(
    (t) =>
      !t.hidden &&
      t.items.some((i: VideoItem) => i.kind === 'telop' && intersects(i, segStart, segEnd))
  )
  if (!ctx.telopLayer && hasTelop && ctx.assPath) {
    const out = newLabel('t')
    parts.push(
      `[${cur}]setpts=PTS+${num(sec(segStart))}/TB,subtitles=filename='${escapeFilterPath(ctx.assPath)}',` +
        `setpts=PTS-STARTPTS[${out}]`
    )
    cur = out
  }

  parts.push(
    `[${cur}]trim=end_frame=${segFrames},settb=${tb},setpts=N,fps=${fps},${VIDEO_FORMAT}[vout]`
  )
  return { inputs, filter: parts.join(';'), outLabel: '[vout]' }
}

// ------------------------------------------------------------------ 音声

/** ダッキングとフェードが区間の頭で「途中から」にならないよう、前から読んでおく秒数 */
export const AUDIO_PREROLL_SECONDS = 2

export interface SegmentAudioGraph extends SegmentGraph {
  /** 出力のサンプル数(区間の長さちょうど) */
  samples: number
}

/**
 * 区間の音。**前置き(プリロール)ぶん手前から鳴らして、区間の頭で切り落とす。**
 * ダッキングの圧縮器は直前の音量で状態を持つので、区間の頭から鳴らすと
 * 境目ごとに BGM が一瞬だけ戻る。
 */
export function buildSegmentAudioGraph(ctx: GraphContext, segment: Segment): SegmentAudioGraph {
  const seq = ctx.sequence
  const sec = (frames: number): number => frameToSeconds(seq, frames)
  const prerollFrames = Math.round((AUDIO_PREROLL_SECONDS * seq.fps.num) / seq.fps.den)
  const renderStart = Math.max(0, segment.startFrame - prerollFrames)
  const renderEnd = segment.endFrame
  const renderSamples = frameToSample(seq, renderEnd) - frameToSample(seq, renderStart)
  const keepFrom = frameToSample(seq, segment.startFrame) - frameToSample(seq, renderStart)
  const samples = renderSamples - keepFrom

  const mainIds = new Set((seq.videoTracks[0]?.items ?? []).map((i) => i.id))
  const inputs: GraphInput[] = []
  const parts: string[] = []
  let labelSeq = 0
  const newLabel = (prefix: string): string => `${prefix}${labelSeq++}`
  const silence = (): string => {
    const l = newLabel('z')
    parts.push(
      `anullsrc=channel_layout=stereo:sample_rate=${OUTPUT_SAMPLE_RATE},` +
        `atrim=end_sample=${renderSamples},${AUDIO_FORMAT}[${l}]`
    )
    return l
  }
  /** 複数の枝を「区間の長さちょうど」に混ぜる(無音を先頭に置いて `duration=first`) */
  const mixToLength = (labels: string[]): string => {
    const out = newLabel('x')
    const all = [silence(), ...labels]
    parts.push(
      `${all.map((l) => `[${l}]`).join('')}amix=inputs=${all.length}:duration=first:` +
        `dropout_transition=0:normalize=0,${AUDIO_FORMAT}[${out}]`
    )
    return out
  }

  /** アイテム内の秒 L に対する音量の式(フェード・繋ぎの重なりを直線で) */
  const envelope = (
    item: AudioItem,
    others: AudioItem[],
    gain: number,
    skipSec: number
  ): string => {
    const dur = sec(item.durationFrames)
    const { fadeIn, fadeOut } = normalizeFades(
      item.fadeInFrames !== undefined ? sec(item.fadeInFrames) : undefined,
      item.fadeOutFrames !== undefined ? sec(item.fadeOutFrames) : undefined,
      dur
    )
    // 同じトラックで重なる相手(本編の繋ぎ)とは、重なりの区間で直線のクロスフェードにする。
    // v1 の `acrossfade`(既定の曲線は両側とも直線)と同じ足し算になる。
    let xIn = 0
    let xOut = 0
    const end = item.startFrame + item.durationFrames
    for (const o of others) {
      if (o === item) continue
      const oEnd = o.startFrame + o.durationFrames
      if (o.startFrame < item.startFrame && oEnd > item.startFrame) {
        xIn = Math.max(xIn, sec(Math.min(oEnd, end) - item.startFrame))
      }
      if (o.startFrame > item.startFrame && o.startFrame < end) {
        xOut = Math.max(xOut, sec(end - o.startFrame))
      }
    }
    const L = `(t+${num(skipSec)})`
    const terms: string[] = []
    const rampIn = (d: number): void => {
      if (d > 0) terms.push(`min(1\\,${L}/${num(d)})`)
    }
    const rampOut = (d: number): void => {
      if (d > 0) terms.push(`min(1\\,max(0\\,${num(dur)}-${L})/${num(d)})`)
    }
    rampIn(fadeIn)
    rampOut(fadeOut)
    rampIn(xIn)
    rampOut(xOut)
    if (terms.length === 0) return `volume=${num(gain)}`
    const g = [num(gain), ...terms].join('*')
    return `aeval=exprs='val(0)*${g}|val(1)*${g}':channel_layout=stereo`
  }

  const trackMixes: { label: string; duck: boolean }[] = []
  const voiceLabels: string[] = []
  const duckingInUse = seq.audioTracks.some((t) => t.duckingEnabled && !t.muted)
  seq.audioTracks.forEach((track) => {
    if (track.muted) return
    const labels: string[] = []
    for (const item of track.items) {
      if (!intersects(item, renderStart, renderEnd)) continue
      const asset = ctx.assetsById.get(item.assetId)
      if (!asset || !asset.hasAudio) continue
      const speed = item.speed > 0 ? item.speed : 1
      const visStart = Math.max(item.startFrame, renderStart)
      const visEnd = Math.min(item.startFrame + item.durationFrames, renderEnd)
      const skipSec = sec(visStart - item.startFrame)
      const dur = sec(visEnd - visStart)
      inputs.push({
        path: asset.filePath,
        seek: item.sourceIn + skipSec * speed,
        duration: dur * speed
      })
      const idx = inputs.length - 1
      const label = newLabel('a')
      const delay = frameToSample(seq, visStart) - frameToSample(seq, renderStart)
      parts.push(
        `[${idx}:a]${audioSpeedChain(speed)},aresample=async=1,asetpts=PTS-STARTPTS,` +
          `apad,atrim=0:${num(dur)},asetpts=PTS-STARTPTS,` +
          `${audioFormatFor(ctx.audioChannels?.get(asset.filePath))},` +
          `${envelope(item, track.items, audioClipGain(track.volume, item.volume), skipSec)},` +
          `adelay=${delay}S:all=1,${AUDIO_FORMAT}[${label}]`
      )
      // 本編(一番下の映像トラック)に紐づく音は「本編の声」。ダッキングの基準にもする
      // 出演者の声のトラック(ピンマイク)も同じく基準にする
      if (
        duckingInUse &&
        !track.duckingEnabled &&
        ((item.linkedItemId && mainIds.has(item.linkedItemId)) || track.voice)
      ) {
        parts.push(`[${label}]asplit=2[${label}m][${label}v]`)
        labels.push(`${label}m`)
        voiceLabels.push(`${label}v`)
      } else {
        labels.push(label)
      }
    }
    if (labels.length === 0) return
    trackMixes.push({ label: mixToLength(labels), duck: track.duckingEnabled })
  })

  const ducked = trackMixes.filter((t) => t.duck)
  if (ducked.length > 0 && voiceLabels.length > 0) {
    const voice = mixToLength(voiceLabels)
    const split = ducked.map(() => newLabel('s'))
    parts.push(`[${voice}]asplit=${ducked.length}${split.map((l) => `[${l}]`).join('')}`)
    ducked.forEach((t, i) => {
      const out = newLabel('d')
      parts.push(`[${t.label}][${split[i]}]${duckingFilterArgs()},${AUDIO_FORMAT}[${out}]`)
      t.label = out
    })
  } else {
    // 割った声の枝は、受け取り手がいないとグラフごと失敗するので捨てる
    voiceLabels.forEach((l) => parts.push(`[${l}]anullsink`))
  }

  const mixed = mixToLength(trackMixes.map((t) => t.label))
  parts.push(
    `[${mixed}]atrim=start_sample=${keepFrom}:end_sample=${renderSamples},asetpts=PTS-STARTPTS,${AUDIO_FORMAT}[aout]`
  )
  return { inputs, filter: parts.join(';'), outLabel: '[aout]', samples }
}
