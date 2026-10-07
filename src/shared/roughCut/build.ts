import { fileAt, GAP_TOLERANCE, nextFileStart, toSource, type MulticamInfo } from '../sync/multicam'
import type { Shot } from '../angles/choose'

/**
 * 仮編集(構成 → カット → アングル)をタイムラインの中身にする。
 *
 * - 本編: ショットごとに、そのカメラの素材の該当部分を並べる(素材の切れ目ではクリップを分ける)。
 *   本編のカメラの音は使わない(カメラを替えるたびに音質が跳ねるため)
 * - 声: ピンマイクごとの音声トラックに、本編と同じ区間を並べる
 * - 周りの音: 基準カメラの音を別の音声トラックに小さめに流す(ピンマイクだけだと場の空気が消える)
 *
 * 続いている区間(カメラの切り替えだけで時間は飛んでいない)は、音声を1本のクリップにまとめる。
 * 時刻は共通の時間軸(基準カメラの時計)、素材の時刻への換算は `MulticamInfo` の start / rate。
 */

export interface RoughMainClip {
  assetId: string
  inPoint: number
  outPoint: number
  speed: number
}

export interface RoughAudioClip {
  assetId: string
  startTime: number
  inPoint: number
  outPoint: number
  speed: number
  /** 時間の飛ぶ切れ目に付ける短いフェード(秒)。続いている所には付けない */
  fadeIn?: number
  fadeOut?: number
}

/**
 * 時間の飛ぶ切れ目で、音声のクリップの頭と終わりに付けるフェード(秒)。
 * 切れ目は静かな所へ寄せてある(`snapCutsToQuiet`)が、周りの音(カメラの音)は風・車・人混みで
 * いつも鳴っていて、別の時刻の音へ急に替わると波形が段になり「プツッ」と鳴る。
 * 20ms は耳に音の途切れとして聞こえない長さで、段をならすには足りる(長尺向けの書き出しでは
 * フレーム単位に丸められ、29.97fps で 1フレーム = 33ms になる)
 */
export const CUT_FADE_SEC = 0.02

export interface RoughOverlayClip {
  assetId: string
  startTime: number
  inPoint: number
  outPoint: number
}

export interface RoughCut {
  main: RoughMainClip[]
  /**
   * マイク(と周りの音)ごとの音声トラック。`muted` は聞かせないトラック
   * (OBS の全部入りのトラックを鳴らすときの声のトラック。文字起こし・盛り上がりには使う)
   */
  audio: {
    name: string
    sourceId: string
    volume: number
    muted?: boolean
    clips: RoughAudioClip[]
  }[]
  /** ワイプで常に出すカメラ(ゲーム実況の顔カメラ)。本編と同じ区間を並べる */
  overlays?: { name: string; sourceId: string; clips: RoughOverlayClip[] }[]
  /** タイムラインの長さ(秒) */
  duration: number
  /** 仮編集のタイムラインの時刻 ↔ 共通の時刻 の対応(テロップを置くのに使う) */
  spans: { timeline: number; start: number; end: number }[]
}

/** 周りの音(基準カメラの音)の音量 */
export const AMBIENCE_VOLUME = 0.35

export function buildRoughCut(
  shots: readonly Shot[],
  info: MulticamInfo,
  options: { ambienceVolume?: number } = {}
): RoughCut {
  const main: RoughMainClip[] = []
  // 本編: ショットを素材の切れ目で分けて並べる
  const placed: { start: number; end: number }[] = []
  const anchorIsCamera = info.sources.some(
    (x) => x.id === info.anchorSourceId && x.kind === 'camera'
  )
  for (const s of shots) {
    let t = s.start
    while (t < s.end - 1e-6) {
      let f = fileAt(info, s.cameraId, t)
      let end = f ? Math.min(s.end, f.start + f.duration / f.rate) : t
      if (!f) {
        // ショットのカメラが録っていない時間(分割ファイルのつなぎ目・録画を止めた間)。
        // ショットを切り捨てず、ごく短い隙間は飛ばして次のファイルへ続け、
        // 長い隙間は基準カメラで埋める(基準カメラも録っていなければ飛ばす)
        const resume = Math.min(s.end, nextFileStart(info, s.cameraId, t))
        const anchor =
          anchorIsCamera && resume - t >= GAP_TOLERANCE
            ? fileAt(info, info.anchorSourceId, t)
            : null
        if (!anchor) {
          t =
            resume - t >= GAP_TOLERANCE
              ? Math.min(resume, nextFileStart(info, info.anchorSourceId, t))
              : resume
          continue
        }
        f = anchor
        end = Math.min(resume, f.start + f.duration / f.rate)
      }
      main.push({
        assetId: f.assetId,
        inPoint: toSource(f, t),
        outPoint: toSource(f, end),
        speed: f.rate
      })
      placed.push({ start: t, end })
      t = end
    }
  }

  // 本編に並んだ区間を、時間の続いているものどうしでまとめる
  const spans: RoughCut['spans'] = []
  let timeline = 0
  for (const p of placed) {
    const last = spans[spans.length - 1]
    // カメラを替えた所は、素材の秒 ↔ 共通の秒の変換の丸めで数μs 離れることがある(実測 1.47μs)。
    // 1μs で比べると時間の飛ぶカットと見なされ、そこを越えないテロップが言い終わる前に切れていた。
    // 丸めの大きさ(10μs 未満)だけつなぐ。それより大きい隙間(分割ファイルのつなぎ目の本当の隙間)は
    // つながない(つなぐと、ピンマイクの声が本編より長く続き、隙間の後ろでずれる)
    if (last && Math.abs(last.end - p.start) < 1e-5) last.end = p.end
    else spans.push({ timeline, start: p.start, end: p.end })
    timeline += p.end - p.start
  }

  const audioFor = (sourceId: string): RoughAudioClip[] => {
    const clips: RoughAudioClip[] = []
    for (const span of spans) {
      let t = span.start
      while (t < span.end - 1e-6) {
        const f = fileAt(info, sourceId, t)
        if (!f) {
          // この機材が録っていない時間は飛ばす(次に録っている所から)
          const next = info.files
            .filter((x) => x.sourceId === sourceId && x.start > t)
            .reduce((m, x) => Math.min(m, x.start), Infinity)
          t = Math.min(span.end, next)
          continue
        }
        const end = Math.min(span.end, f.start + f.duration / f.rate)
        clips.push({
          assetId: f.assetId,
          startTime: span.timeline + (t - span.start),
          inPoint: toSource(f, t),
          outPoint: toSource(f, end),
          speed: f.rate,
          // 時間の飛ぶ切れ目(区間の頭と終わり)だけ。素材の切れ目は音が続いているので付けない
          ...(Math.abs(t - span.start) < 1e-6 ? { fadeIn: CUT_FADE_SEC } : {}),
          ...(Math.abs(end - span.end) < 1e-6 ? { fadeOut: CUT_FADE_SEC } : {})
        })
        t = end
      }
    }
    return clips
  }

  const mics = info.sources.filter((s) => s.kind === 'mic')
  const others = info.sources.filter((s) => s.kind === 'audio')
  const audio: RoughCut['audio'] = [...mics, ...others].map((m) => ({
    name: m.name,
    sourceId: m.id,
    volume: 1,
    ...(silencedTrack(info.sources, m.id) ? { muted: true } : {}),
    clips: audioFor(m.id)
  }))
  const anchor = info.sources.find((s) => s.id === info.anchorSourceId)
  // 基準カメラの録画からトラックを取り出していれば、基準カメラの音(= 1本目のトラック)は重ねない
  // (取り出したトラックが同じ音を持っている)。ほかのカメラ・別のファイルのトラックは関係ない
  const tracksExtracted = info.sources.some((s) => s.trackOf === info.anchorSourceId)
  if (anchor && !tracksExtracted) {
    audio.push({
      // ピンマイクが無ければ、基準カメラの音が声も兼ねるので小さくしない
      name: mics.length > 0 ? `周りの音(${anchor.name})` : `${anchor.name} の音`,
      sourceId: anchor.id,
      volume: mics.length > 0 ? (options.ambienceVolume ?? AMBIENCE_VOLUME) : 1,
      clips: audioFor(anchor.id)
    })
  }
  const faces = info.sources.filter((s) => s.kind === 'camera' && s.cameraRole === 'face')
  const overlays = faces.map((c) => ({
    name: c.name,
    sourceId: c.id,
    clips: audioFor(c.id).map((a) => ({
      assetId: a.assetId,
      startTime: a.startTime,
      inPoint: a.inPoint,
      outPoint: a.outPoint
    }))
  }))
  return { main, audio, ...(overlays.length ? { overlays } : {}), duration: timeline, spans }
}

/**
 * 鳴らさない音声トラックか(OBS の音声トラックを取り出したとき)。
 * ゲーム音のトラックがあれば「声 + ゲーム音」を鳴らし、全部入りは鳴らさない。
 * 無くて全部入りがあれば、全部入りだけを鳴らし、取り出した声のトラックは鳴らさない
 * (同じ声が二重に重なる)。鳴らさないトラックも文字起こし・盛り上がりには使う
 */
export function silencedTrack(
  sources: readonly { id: string; kind: string; trackRole?: string; trackOf?: string }[],
  sourceId: string
): boolean {
  const s = sources.find((x) => x.id === sourceId)
  // 動画から取り出したトラックだけ(別のファイルを「ゲーム音」にしたものは、ほかと重ならない)。
  // 同じ動画から取り出したトラックどうしで決める
  if (!s?.trackRole || !s.trackOf) return false
  const siblings = sources.filter((x) => x.trackOf === s.trackOf)
  const hasGame = siblings.some((x) => x.kind === 'audio' && x.trackRole === 'game')
  const hasMix = siblings.some((x) => x.kind === 'audio' && x.trackRole === 'mix')
  if (s.trackRole === 'mix') return hasGame
  if (s.trackRole === 'voice') return !hasGame && hasMix
  return false
}

/** 共通の時刻 → 仮編集のタイムラインの時刻(使っていない時間なら null) */
export function roughTimelineAt(spans: RoughCut['spans'], t: number): number | null {
  for (const s of spans) if (t >= s.start - 1e-6 && t < s.end) return s.timeline + (t - s.start)
  return null
}
