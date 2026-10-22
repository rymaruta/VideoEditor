import type { MediaAsset } from '../types'
import type {
  AudioItem,
  MediaItem,
  ProjectV2,
  Rational,
  SequenceAudioTrack,
  SequenceTransition
} from '../sequence/types'
import { sequenceDurationFrames } from '../sequence/segmentPlan'

/**
 * Premiere Pro に渡す XML(Final Cut Pro 7 の xmeml version 4)を、v2 のシーケンスから書く。
 *
 * 読み込み(`import/fcp7.ts`)と対になる。仕様は Apple の「Final Cut Pro XML Interchange Format」
 * (xmeml v4/v5 共通の部分だけを使う)と、Premiere が書き出す xmeml の形に合わせる:
 *
 * - **時刻はすべてシーケンスのフレーム(整数)。** v2 は位置をフレームで持つので、そのまま書く
 *   (秒を経由しないので、29.97fps の 3 時間でも 1 フレームもずれない)。
 * - `<rate>` は timebase(整数)と ntsc(TRUE で 1000/1001 倍)。29.97 は 30 + TRUE。
 * - クリップの `in`/`out` は**クリップの時間(速さを掛けた後)**のフレーム。速さを変えたクリップは
 *   `out - in == end - start` のまま、`Time Remap` の効果に速さ(%)を書く(FCP7 の仕様:
 *   「速さを変えるとクリップの duration が変わる」。素材の位置は graphdict のキーフレームが持つ)。
 * - `out`・`end` は「含まない」終わり(FCP7 は out/end を 1 始まりで数える = 0 始まりの排他の終わり)。
 * - 繋ぎ(クロスフェード)は、2 本のクリップを**切れ目(繋ぎの真ん中)で突き合わせ**、その上に
 *   `transitionitem`(alignment=center)を置く。繋ぎに接する側の start/end は Premiere と同じく -1
 *   (長さは in/out から決まる)。のりしろは素材の外側(ハンドル)から取る。
 * - 素材のパスは `file://localhost/` + 1 区切りずつ百分率符号化(RFC 2396。日本語・空白・#・% も)。
 *   Windows のドライブは Premiere と同じく `C%3a`。
 * - ファイルの定義(`<file id>`)は文書の中で最初に出たときだけ中身を書き、2 回目からは id だけ。
 */

// ------------------------------------------------------------------ 時間

/** FCP7 の `<rate>`。29.97 は { timebase: 30, ntsc: true } */
export interface FcpRate {
  timebase: number
  ntsc: boolean
}

/** シーケンスの分数のフレームレート → `<rate>` */
export function fcpRateOf(fps: Rational): FcpRate {
  const value = fps.num / fps.den
  if (fps.den === 1001) return { timebase: Math.round(fps.num / 1000), ntsc: true }
  if (Number.isInteger(value)) return { timebase: value, ntsc: false }
  return fcpRateOfNumber(value)
}

/** 素材の fps(小数)→ `<rate>`。23.976 / 29.97 / 59.94 は NTSC として扱う */
export function fcpRateOfNumber(fps: number): FcpRate {
  if (!Number.isFinite(fps) || fps <= 0) return { timebase: 30, ntsc: false }
  for (const tb of [24, 30, 60, 48, 120]) {
    if (Math.abs(fps - (tb * 1000) / 1001) < 0.005) return { timebase: tb, ntsc: true }
  }
  return { timebase: Math.max(1, Math.round(fps)), ntsc: false }
}

export function fcpRateValue(r: FcpRate): number {
  return r.ntsc ? (r.timebase * 1000) / 1001 : r.timebase
}

/** ドロップフレームの表記ができるレート(29.97・59.94 だけ) */
export function canDropFrame(r: FcpRate): boolean {
  return r.ntsc && (r.timebase === 30 || r.timebase === 60)
}

/**
 * フレーム数 → タイムコード。ドロップフレーム(29.97/59.94)は「00;00;00;00」、
 * ノンドロップは「00:00:00:00」(Premiere の表記)。
 * DF は 10 分ごとを除く毎分の頭で 2(59.94 は 4)番号を飛ばす。
 */
export function framesToTimecode(frame: number, r: FcpRate, dropFrame: boolean): string {
  const tb = r.timebase
  let f = Math.max(0, Math.floor(frame))
  const df = dropFrame && canDropFrame(r)
  if (df) {
    const drop = tb === 60 ? 4 : 2
    const per10 = tb * 600 - drop * 9
    const perMin = tb * 60 - drop
    const d = Math.floor(f / per10)
    const m = f % per10
    f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0)
  }
  const ff = f % tb
  const ss = Math.floor(f / tb) % 60
  const mm = Math.floor(f / (tb * 60)) % 60
  const hh = Math.floor(f / (tb * 3600))
  const p = (n: number): string => String(n).padStart(2, '0')
  const sep = df ? ';' : ':'
  return `${p(hh)}${sep}${p(mm)}${sep}${p(ss)}${sep}${p(ff)}`
}

// ------------------------------------------------------------------ 文字

/** XML の本文・属性に書ける形にする(XML 1.0 で使えない制御文字・壊れたサロゲートは落とす) */
export function xmlEscape(s: string): string {
  return (
    String(s ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  )
}

/**
 * 素材のパス → `pathurl`。
 * - mac / Linux: `/Users/a/b.mov` → `file://localhost/Users/a/b.mov`
 * - Windows: `C:\a\b.mov` → `file://localhost/C%3a/a/b.mov`(Premiere が書く形)
 * - UNC: `\\server\share\b.mov` → `file://server/share/b.mov`
 * 区切りの間は UTF-8 の百分率符号化(日本語・空白・#・%・?・& など)。
 */
export function fileUrl(path: string): string {
  const enc = (seg: string): string => encodeURIComponent(seg.normalize('NFC'))
  const p = path.replace(/\\/g, '/')
  if (/^\/\/[^/]/.test(p)) {
    const [host, ...rest] = p.slice(2).split('/')
    return `file://${enc(host)}/${rest.map(enc).join('/')}`
  }
  const drive = /^\/?([A-Za-z]):\/(.*)$/.exec(p)
  if (drive) return `file://localhost/${drive[1]}%3a/${drive[2].split('/').map(enc).join('/')}`
  const abs = p.startsWith('/') ? p : `/${p}`
  return `file://localhost${abs.split('/').map(enc).join('/')}`
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

// ------------------------------------------------------------------ 入力

/** シーケンスのマーカー(章・要確認・テロップの文字) */
export interface PremiereMarker {
  frame: number
  /** 長さ(フレーム)。無ければ点のマーカー */
  durationFrames?: number
  name: string
  comment?: string
}

/** 見た目どおりのテロップ(透過 PNG または透過動画)を置くクリップ */
export interface PremiereOverlayClip {
  path: string
  startFrame: number
  durationFrames: number
  /** 静止画(PNG)。false は動画(ProRes 4444 など) */
  still: boolean
  /** 動画のとき、素材の頭からのフレーム(シーケンスのレート) */
  sourceInFrame?: number
  /** 動画のとき、素材の長さ(フレーム) */
  fileFrames?: number
}

export interface PremiereXmlOptions {
  /** シーケンスの名前(既定は企画の名前) */
  name?: string
  /** 29.97・59.94 のタイムコードをドロップフレームで表す(既定 true。他のレートでは無視) */
  dropFrame?: boolean
  markers?: readonly PremiereMarker[]
  /** 見た目どおりのテロップを、映像トラックの一番上に置く */
  telopMedia?: { width: number; height: number; clips: readonly PremiereOverlayClip[] }
}

export interface PremiereXmlResult {
  xml: string
  /** XML に入らない(または近い形に置き換えた)もの。画面に出す */
  warnings: string[]
  stats: {
    videoClips: number
    audioClips: number
    videoTracks: number
    audioTracks: number
    markers: number
    durationFrames: number
  }
}

// ------------------------------------------------------------------ 並べ方

/** 書く前に決めた、1 本のクリップの位置 */
interface Placed {
  id: string
  kind: 'video' | 'audio'
  /** 1 始まり(種類ごと) */
  trackIndex: number
  /** 1 始まり(トラックの中のクリップの並び) */
  clipIndex: number
  start: number
  end: number
  /** クリップの時間のフレーム(速さを掛けた後) */
  inF: number
  /** 繋ぎに接する側(start / end を -1 で書く) */
  headTransition: boolean
  tailTransition: boolean
  source:
    | { kind: 'media'; item: MediaItem }
    | { kind: 'audio'; item: AudioItem }
    | { kind: 'overlay'; clip: PremiereOverlayClip }
  /** この直前に置く繋ぎ */
  transitionBefore?: { start: number; end: number; type: SequenceTransition['type'] | 'audio' }
  fadeIn?: number
  fadeOut?: number
  level?: number
  links: string[]
}

interface TrackPlan {
  kind: 'video' | 'audio'
  enabled: boolean
  clips: Placed[]
}

/**
 * 1 本のトラックのアイテムを、FCP7 の形(重ならない・繋ぎは切れ目で突き合わせ)に並べる。
 * 重なっているのに繋ぎとして扱えない物は `overflow` に返す(別のトラックへ置く)
 */
function arrange<T extends { startFrame: number; durationFrames: number }>(
  items: readonly T[],
  isTransition: (prev: T, item: T) => SequenceTransition['type'] | 'audio' | null
): {
  placed: {
    item: T
    start: number
    end: number
    shift: number
    transition?: { start: number; end: number; type: SequenceTransition['type'] | 'audio' }
  }[]
  overflow: T[]
} {
  const sorted = [...items].sort((a, b) => a.startFrame - b.startFrame)
  const placed: {
    item: T
    start: number
    end: number
    shift: number
    transition?: { start: number; end: number; type: SequenceTransition['type'] | 'audio' }
  }[] = []
  const overflow: T[] = []
  for (const item of sorted) {
    const start = item.startFrame
    const end = item.startFrame + item.durationFrames
    if (end <= start) continue
    const prev = placed[placed.length - 1]
    if (!prev || prev.end <= start) {
      placed.push({ item, start, end, shift: 0 })
      continue
    }
    const type = isTransition(prev.item, item)
    // 繋ぎにできるのは、前のクリップの頭より後ろで重なり、このクリップの終わりより前に前のが終わるときだけ
    if (type && prev.end < end && start > prev.start) {
      const tStart = start
      const tEnd = prev.end
      let cut = tStart + Math.floor((tEnd - tStart) / 2)
      cut = Math.min(end - 1, Math.max(prev.start + 1, cut))
      prev.end = cut
      placed.push({
        item,
        start: cut,
        end,
        shift: cut - start,
        transition: { start: tStart, end: tEnd, type }
      })
      continue
    }
    overflow.push(item)
  }
  return { placed, overflow }
}

function clampLevel(v: number): number {
  // Premiere の Audio Levels は +12dB(3.98 倍)まで
  return Math.min(3.981, Math.max(0, Number.isFinite(v) ? v : 1))
}

// ------------------------------------------------------------------ 書き出し

export function buildPremiereXml(
  project: ProjectV2,
  options: PremiereXmlOptions = {}
): PremiereXmlResult {
  const seq = project.sequence
  const rate = fcpRateOf(seq.fps)
  const fps = seq.fps.num / seq.fps.den
  const dropFrame = (options.dropFrame ?? true) && canDropFrame(rate)
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const warnings = new Set<string>()
  let nextClip = 1
  const newId = (): string => `clipitem-${nextClip++}`

  // --- 映像 ---
  const videoPlans: TrackPlan[] = []
  const placedByItem = new Map<string, Placed>()
  const addVideoTrack = (enabled: boolean, items: MediaItem[]): void => {
    let pending = items
    let guard = 0
    while (pending.length > 0 && guard++ < 64) {
      const { placed, overflow } = arrange(pending, (_p, it) =>
        it.transitionIn && it.transitionIn.durationFrames > 0 ? it.transitionIn.type : null
      )
      const trackIndex = videoPlans.length + 1
      const plan: TrackPlan = { kind: 'video', enabled, clips: [] }
      placed.forEach((p, i) => {
        const speed = p.item.speed > 0 ? p.item.speed : 1
        const asset = assets.get(p.item.assetId)
        const still = asset?.still === true
        const pc: Placed = {
          id: newId(),
          kind: 'video',
          trackIndex,
          clipIndex: i + 1,
          start: p.start,
          end: p.end,
          inF: (still ? 0 : Math.round((p.item.sourceIn * fps) / speed)) + p.shift,
          headTransition: p.transition !== undefined,
          tailTransition: false,
          source: { kind: 'media', item: p.item },
          ...(p.transition ? { transitionBefore: p.transition } : {}),
          links: []
        }
        if (p.transition) plan.clips[plan.clips.length - 1].tailTransition = true
        plan.clips.push(pc)
        placedByItem.set(p.item.id, pc)
      })
      videoPlans.push(plan)
      pending = overflow
    }
  }
  for (const track of seq.videoTracks) {
    const media = track.items.filter(
      (i): i is MediaItem => i.kind === 'media' && assets.has(i.assetId)
    )
    if (media.length === 0) continue
    addVideoTrack(!track.hidden, media)
    for (const it of media) {
      if (it.placement.kind === 'frame' && it.placement.blurBackground)
        warnings.add(
          'ぼかし背景(余白を素材のぼかしで埋める)は XML に入りません。余白は黒になります'
        )
    }
  }
  if (project.assets.some((a) => a.colorMatch))
    warnings.add('カメラの色合わせは XML に入りません(Premiere で色を合わせてください)')

  // 見た目どおりのテロップ(透過の画像・動画)を一番上へ
  const telopClips = options.telopMedia?.clips ?? []
  if (telopClips.length > 0) {
    const trackIndex = videoPlans.length + 1
    const plan: TrackPlan = { kind: 'video', enabled: true, clips: [] }
    ;[...telopClips]
      .filter((c) => c.durationFrames > 0)
      .sort((a, b) => a.startFrame - b.startFrame)
      .forEach((c, i) => {
        plan.clips.push({
          id: newId(),
          kind: 'video',
          trackIndex,
          clipIndex: i + 1,
          start: c.startFrame,
          end: c.startFrame + c.durationFrames,
          inF: c.still ? 0 : (c.sourceInFrame ?? c.startFrame),
          headTransition: false,
          tailTransition: false,
          source: { kind: 'overlay', clip: c },
          links: []
        })
      })
    videoPlans.push(plan)
  }

  // --- 音声 ---
  const audioPlans: TrackPlan[] = []
  const addAudioTrack = (track: SequenceAudioTrack, items: AudioItem[]): void => {
    let pending = items
    let guard = 0
    while (pending.length > 0 && guard++ < 64) {
      // 同じトラックの中で重なるのは繋ぎ(本編の音のクロスフェード)だけ。クロスフェードにする
      const { placed, overflow } = arrange(pending, () => 'audio')
      const trackIndex = audioPlans.length + 1
      const plan: TrackPlan = { kind: 'audio', enabled: !track.muted, clips: [] }
      placed.forEach((p, i) => {
        const speed = p.item.speed > 0 ? p.item.speed : 1
        const pc: Placed = {
          id: newId(),
          kind: 'audio',
          trackIndex,
          clipIndex: i + 1,
          start: p.start,
          end: p.end,
          inF: Math.round((p.item.sourceIn * fps) / speed) + p.shift,
          headTransition: p.transition !== undefined,
          tailTransition: false,
          source: { kind: 'audio', item: p.item },
          ...(p.transition ? { transitionBefore: p.transition } : {}),
          level: clampLevel((p.item.volume ?? 1) * (track.volume ?? 1)),
          ...(p.item.fadeInFrames ? { fadeIn: p.item.fadeInFrames } : {}),
          ...(p.item.fadeOutFrames ? { fadeOut: p.item.fadeOutFrames } : {}),
          links: []
        }
        if (p.transition) plan.clips[plan.clips.length - 1].tailTransition = true
        plan.clips.push(pc)
      })
      audioPlans.push(plan)
      pending = overflow
    }
    if (track.duckingEnabled)
      warnings.add('ダッキング(声に合わせて BGM を下げる)は XML に入りません。BGM は一定の音量です')
  }
  for (const track of seq.audioTracks) {
    const items = track.items.filter((i) => assets.has(i.assetId))
    if (items.length > 0) addAudioTrack(track, items)
  }

  // 片側のフェード: 隣のクリップと突き合わせている側・繋ぎのある側には置けない(FCP7 は1つの切れ目に繋ぎ1つ)
  for (const plan of audioPlans) {
    plan.clips.forEach((c, i) => {
      const prev = plan.clips[i - 1]
      const next = plan.clips[i + 1]
      const len = c.end - c.start
      if (c.fadeIn && (c.headTransition || (prev && prev.end === c.start))) {
        delete c.fadeIn
        warnings.add('隣のクリップと接しているフェードの一部は XML に入れていません')
      }
      if (c.fadeOut && (c.tailTransition || (next && next.start === c.end))) {
        delete c.fadeOut
        warnings.add('隣のクリップと接しているフェードの一部は XML に入れていません')
      }
      const fi = c.fadeIn ?? 0
      const fo = c.fadeOut ?? 0
      if (fi + fo > len) {
        // 短いクリップでフェードが重なるなら、割合で縮める
        const k = len / (fi + fo)
        if (fi) c.fadeIn = Math.max(1, Math.floor(fi * k))
        if (fo) c.fadeOut = Math.max(1, Math.floor(fo * k))
        if ((c.fadeIn ?? 0) + (c.fadeOut ?? 0) > len) delete c.fadeOut
      }
    })
  }

  // 映像と音(同じ素材・同じ位置)をリンクする
  for (const plan of audioPlans) {
    for (const a of plan.clips) {
      if (a.source.kind !== 'audio' || !a.source.item.linkedItemId) continue
      const v = placedByItem.get(a.source.item.linkedItemId)
      if (!v || v.start !== a.start || v.end !== a.end) continue
      if (v.links.length === 0) v.links.push(v.id)
      v.links.push(a.id)
      a.links = v.links
    }
  }

  // --- ファイルの定義 ---
  const fileIds = new Map<string, string>()
  const defined = new Set<string>()
  /** 静止画・テロップの素材の、使っている一番遠い出点(file の長さに使う) */
  const maxOut = new Map<string, number>()
  const fileKey = (c: Placed): string =>
    c.source.kind === 'overlay' ? `path:${c.source.clip.path}` : `asset:${c.source.item.assetId}`
  for (const plan of [...videoPlans, ...audioPlans])
    for (const c of plan.clips) {
      const key = fileKey(c)
      if (!fileIds.has(key)) fileIds.set(key, `file-${fileIds.size + 1}`)
      maxOut.set(key, Math.max(maxOut.get(key) ?? 0, c.inF + (c.end - c.start)))
    }

  const rateXml = (r: FcpRate, ind: string): string =>
    `${ind}<rate>\n${ind}  <timebase>${r.timebase}</timebase>\n${ind}  <ntsc>${r.ntsc ? 'TRUE' : 'FALSE'}</ntsc>\n${ind}</rate>`
  const seqRate = (ind: string): string => rateXml(rate, ind)
  const videoSample = (r: FcpRate, w: number, h: number, ind: string): string =>
    [
      `${ind}<samplecharacteristics>`,
      rateXml(r, `${ind}  `),
      `${ind}  <width>${Math.max(1, Math.round(w))}</width>`,
      `${ind}  <height>${Math.max(1, Math.round(h))}</height>`,
      `${ind}  <anamorphic>FALSE</anamorphic>`,
      `${ind}  <pixelaspectratio>square</pixelaspectratio>`,
      `${ind}  <fielddominance>none</fielddominance>`,
      `${ind}</samplecharacteristics>`
    ].join('\n')
  const audioSample = (ind: string): string =>
    `${ind}<samplecharacteristics>\n${ind}  <depth>16</depth>\n${ind}  <samplerate>48000</samplerate>\n${ind}</samplecharacteristics>`

  const fileXml = (c: Placed, ind: string): string => {
    const key = fileKey(c)
    const id = fileIds.get(key)!
    if (defined.has(id)) return `${ind}<file id="${id}"/>`
    defined.add(id)
    let path: string
    let fileRate: FcpRate
    let frames: number
    let width: number
    let height: number
    let hasVideo: boolean
    let hasAudio: boolean
    if (c.source.kind === 'overlay') {
      const o = c.source.clip
      path = o.path
      fileRate = rate
      frames = o.still ? (maxOut.get(key) ?? 0) : Math.max(o.fileFrames ?? 0, maxOut.get(key) ?? 0)
      width = options.telopMedia?.width ?? seq.width
      height = options.telopMedia?.height ?? seq.height
      hasVideo = true
      hasAudio = false
    } else {
      const a = assets.get(c.source.item.assetId) as MediaAsset
      path = a.filePath
      const still = a.still === true
      fileRate = still || !(a.fps > 0) ? rate : fcpRateOfNumber(a.fps)
      const own = Math.round((a.duration || 0) * fcpRateValue(fileRate))
      // 静止画・長さの分からない素材は、使っている出点まで(シーケンスのレートで数える)
      frames = still || own <= 0 ? (maxOut.get(key) ?? 0) : own
      width = a.width || seq.width
      height = a.height || seq.height
      hasVideo = a.hasVideo !== false && (a.width > 0 || still)
      hasAudio = a.hasAudio && !still
    }
    const lines = [
      `${ind}<file id="${id}">`,
      `${ind}  <name>${xmlEscape(baseName(path))}</name>`,
      `${ind}  <pathurl>${xmlEscape(fileUrl(path))}</pathurl>`,
      rateXml(fileRate, `${ind}  `),
      `${ind}  <duration>${Math.max(1, frames)}</duration>`,
      `${ind}  <timecode>`,
      rateXml(fileRate, `${ind}    `),
      `${ind}    <string>${framesToTimecode(0, fileRate, false)}</string>`,
      `${ind}    <frame>0</frame>`,
      `${ind}    <displayformat>NDF</displayformat>`,
      `${ind}  </timecode>`,
      `${ind}  <media>`
    ]
    if (hasVideo)
      lines.push(
        `${ind}    <video>`,
        videoSample(fileRate, width, height, `${ind}      `),
        `${ind}    </video>`
      )
    if (hasAudio)
      lines.push(
        `${ind}    <audio>`,
        audioSample(`${ind}      `),
        `${ind}      <channelcount>2</channelcount>`,
        `${ind}    </audio>`
      )
    lines.push(`${ind}  </media>`, `${ind}</file>`)
    return lines.join('\n')
  }

  // --- 効果 ---
  const param = (
    id: string,
    name: string,
    value: string | number,
    ind: string,
    extra = ''
  ): string =>
    `${ind}<parameter authoringApp="PremierePro">\n${ind}  <parameterid>${id}</parameterid>\n${ind}  <name>${name}</name>\n${extra}${ind}  <value>${value}</value>\n${ind}</parameter>`

  const timeRemapXml = (c: Placed, speed: number, clipFrames: number, ind: string): string => {
    const len = c.end - c.start
    const media = (f: number): string => String(Math.round(f * speed * 1000) / 1000)
    const kf = (when: number, value: string, flag: string): string =>
      `${ind}      <keyframe>\n${ind}        <when>${when}</when>\n${ind}        <value>${value}</value>\n${ind}        <speedvirtualkf>TRUE</speedvirtualkf>\n${ind}        <${flag}>TRUE</${flag}>\n${ind}      </keyframe>`
    return [
      `${ind}<filter>`,
      `${ind}  <effect>`,
      `${ind}    <name>Time Remap</name>`,
      `${ind}    <effectid>timeremap</effectid>`,
      `${ind}    <effectcategory>motion</effectcategory>`,
      `${ind}    <effecttype>motion</effecttype>`,
      `${ind}    <mediatype>${c.kind}</mediatype>`,
      param(
        'variablespeed',
        'variablespeed',
        0,
        `${ind}    `,
        `${ind}      <valuemin>0</valuemin>\n${ind}      <valuemax>1</valuemax>\n`
      ),
      param(
        'speed',
        'speed',
        Math.round(speed * 100 * 1000) / 1000,
        `${ind}    `,
        `${ind}      <valuemin>-100000</valuemin>\n${ind}      <valuemax>100000</valuemax>\n`
      ),
      param('reverse', 'reverse', 'FALSE', `${ind}    `),
      param('frameblending', 'frameblending', 'FALSE', `${ind}    `),
      `${ind}    <parameter authoringApp="PremierePro">`,
      `${ind}      <parameterid>graphdict</parameterid>`,
      `${ind}      <name>graphdict</name>`,
      // FCP7 の仕様: when はクリップの中の位置、value は素材の位置。最初は when 0、最後は when = クリップの長さ
      kf(0, '0', 'speedkfstart'),
      kf(c.inF, media(c.inF), 'speedkfin'),
      kf(c.inF + len, media(c.inF + len), 'speedkfout'),
      kf(clipFrames, media(clipFrames), 'speedkfend'),
      `${ind}    </parameter>`,
      `${ind}  </effect>`,
      `${ind}</filter>`
    ].join('\n')
  }

  /** 置き方(大きさ・位置)。等倍・真ん中なら書かない */
  const motionXml = (item: MediaItem, ind: string): string => {
    const a = assets.get(item.assetId)
    const W = seq.width
    const H = seq.height
    const sw = a?.width || W
    const sh = a?.height || H
    let scale: number
    let cx = 0
    let cy = 0
    const pl = item.placement
    if (pl.kind === 'frame') {
      scale = pl.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)
      if (pl.fit === 'cover' && pl.cropCenter) {
        // 切り抜き窓の中心(素材の 0〜1)が画面の真ん中に来るように、はみ出さない範囲でずらす
        const visW = W / scale / sw
        const visH = H / scale / sh
        const ccx = Math.min(1 - visW / 2, Math.max(visW / 2, pl.cropCenter.x))
        const ccy = Math.min(1 - visH / 2, Math.max(visH / 2, pl.cropCenter.y))
        cx = (0.5 - ccx) * sw * scale
        cy = (0.5 - ccy) * sh * scale
      }
    } else {
      const boxW = pl.width * W
      scale = boxW / sw
      const boxH = sh * scale
      const m = pl.margin * W
      const left = pl.anchor.endsWith('left') ? m : W - m - boxW
      const top = pl.anchor.startsWith('top') ? m : H - m - boxH
      cx = left + boxW / 2 - W / 2
      cy = top + boxH / 2 - H / 2
    }
    const pct = Math.round(scale * 100 * 1000) / 1000
    const h = Math.round((cx / W) * 1e6) / 1e6
    const v = Math.round((cy / H) * 1e6) / 1e6
    if (Math.abs(pct - 100) < 1e-6 && h === 0 && v === 0) return ''
    return [
      `${ind}<filter>`,
      `${ind}  <effect>`,
      `${ind}    <name>Basic Motion</name>`,
      `${ind}    <effectid>basic</effectid>`,
      `${ind}    <effectcategory>motion</effectcategory>`,
      `${ind}    <effecttype>motion</effecttype>`,
      `${ind}    <mediatype>video</mediatype>`,
      param(
        'scale',
        'Scale',
        pct,
        `${ind}    `,
        `${ind}      <valuemin>0</valuemin>\n${ind}      <valuemax>1000</valuemax>\n`
      ),
      `${ind}    <parameter authoringApp="PremierePro">`,
      `${ind}      <parameterid>center</parameterid>`,
      `${ind}      <name>Center</name>`,
      `${ind}      <value>`,
      `${ind}        <horiz>${h}</horiz>`,
      `${ind}        <vert>${v}</vert>`,
      `${ind}      </value>`,
      `${ind}    </parameter>`,
      `${ind}  </effect>`,
      `${ind}</filter>`
    ].join('\n')
  }

  const levelXml = (level: number, ind: string): string =>
    [
      `${ind}<filter>`,
      `${ind}  <effect>`,
      `${ind}    <name>Audio Levels</name>`,
      `${ind}    <effectid>audiolevels</effectid>`,
      `${ind}    <effectcategory>audiolevels</effectcategory>`,
      `${ind}    <effecttype>audiolevels</effecttype>`,
      `${ind}    <mediatype>audio</mediatype>`,
      param(
        'level',
        'Level',
        Math.round(level * 1e5) / 1e5,
        `${ind}    `,
        `${ind}      <valuemin>0</valuemin>\n${ind}      <valuemax>3.98109</valuemax>\n`
      ),
      `${ind}  </effect>`,
      `${ind}</filter>`
    ].join('\n')

  const TRANSITION_EFFECT: Record<
    string,
    { name: string; id: string; category: string; media: 'video' | 'audio' }
  > = {
    crossfade: {
      name: 'Cross Dissolve',
      id: 'Cross Dissolve',
      category: 'Dissolve',
      media: 'video'
    },
    fade: {
      name: 'Dip to Color Dissolve',
      id: 'Dip to Color Dissolve',
      category: 'Dissolve',
      media: 'video'
    },
    wipe: { name: 'Edge Wipe', id: 'Edge Wipe', category: 'Wipe', media: 'video' },
    audio: {
      name: 'Cross Fade (+3dB)',
      id: 'KGAudioTransCrossFade3dB',
      category: 'Crossfade',
      media: 'audio'
    }
  }
  const transitionXml = (
    start: number,
    end: number,
    type: string,
    alignment: 'center' | 'start-black' | 'end-black',
    ind: string
  ): string => {
    const e = TRANSITION_EFFECT[type] ?? TRANSITION_EFFECT.crossfade
    const lines = [
      `${ind}<transitionitem>`,
      `${ind}  <start>${start}</start>`,
      `${ind}  <end>${end}</end>`,
      `${ind}  <alignment>${alignment}</alignment>`,
      seqRate(`${ind}  `),
      `${ind}  <effect>`,
      `${ind}    <name>${e.name}</name>`,
      `${ind}    <effectid>${e.id}</effectid>`,
      `${ind}    <effectcategory>${e.category}</effectcategory>`,
      `${ind}    <effecttype>transition</effecttype>`,
      `${ind}    <mediatype>${e.media}</mediatype>`
    ]
    if (e.media === 'video')
      lines.push(
        `${ind}    <wipecode>0</wipecode>`,
        `${ind}    <wipeaccuracy>100</wipeaccuracy>`,
        `${ind}    <startratio>0</startratio>`,
        `${ind}    <endratio>1</endratio>`,
        `${ind}    <reverse>FALSE</reverse>`
      )
    if (type === 'fade')
      lines.push(
        `${ind}    <parameter>`,
        `${ind}      <parameterid>color</parameterid>`,
        `${ind}      <name>Color</name>`,
        `${ind}      <value>`,
        `${ind}        <alpha>255</alpha>`,
        `${ind}        <red>0</red>`,
        `${ind}        <green>0</green>`,
        `${ind}        <blue>0</blue>`,
        `${ind}      </value>`,
        `${ind}    </parameter>`
      )
    lines.push(`${ind}  </effect>`, `${ind}</transitionitem>`)
    return lines.join('\n')
  }

  const placedById = new Map<string, Placed>()
  for (const plan of [...videoPlans, ...audioPlans])
    for (const c of plan.clips) placedById.set(c.id, c)

  const clipXml = (c: Placed, ind: string): string => {
    const len = c.end - c.start
    let name: string
    let speed = 1
    let clipFrames: number
    let alpha = 'none'
    if (c.source.kind === 'overlay') {
      name = baseName(c.source.clip.path)
      alpha = 'straight'
      clipFrames = c.source.clip.still
        ? (maxOut.get(fileKey(c)) ?? len)
        : Math.max(c.source.clip.fileFrames ?? 0, c.inF + len)
    } else {
      const a = assets.get(c.source.item.assetId) as MediaAsset
      name = a.fileName || baseName(a.filePath)
      const still = a.still === true
      speed = !still && c.source.item.speed > 0 ? c.source.item.speed : 1
      if (still) alpha = 'straight'
      const own = Math.round(((a.duration || 0) * fps) / speed)
      clipFrames = still || own <= 0 ? (maxOut.get(fileKey(c)) ?? len) : own
    }
    clipFrames = Math.max(clipFrames, c.inF + len)
    const lines = [
      `${ind}<clipitem id="${c.id}">`,
      `${ind}  <name>${xmlEscape(name)}</name>`,
      `${ind}  <enabled>TRUE</enabled>`,
      `${ind}  <duration>${clipFrames}</duration>`,
      seqRate(`${ind}  `),
      `${ind}  <start>${c.headTransition ? -1 : c.start}</start>`,
      `${ind}  <end>${c.tailTransition ? -1 : c.end}</end>`,
      `${ind}  <in>${c.inF}</in>`,
      `${ind}  <out>${c.inF + len}</out>`
    ]
    if (c.kind === 'video') lines.push(`${ind}  <alphatype>${alpha}</alphatype>`)
    lines.push(fileXml(c, `${ind}  `))
    if (c.kind === 'audio')
      lines.push(
        `${ind}  <sourcetrack>`,
        `${ind}    <mediatype>audio</mediatype>`,
        `${ind}    <trackindex>1</trackindex>`,
        `${ind}  </sourcetrack>`
      )
    if (Math.abs(speed - 1) > 1e-9) lines.push(timeRemapXml(c, speed, clipFrames, `${ind}  `))
    if (c.source.kind === 'media') {
      const m = motionXml(c.source.item, `${ind}  `)
      if (m) lines.push(m)
    }
    if (c.kind === 'audio' && c.level !== undefined && Math.abs(c.level - 1) > 1e-9)
      lines.push(levelXml(c.level, `${ind}  `))
    for (const id of c.links) {
      const l = placedById.get(id)
      if (!l) continue
      lines.push(
        `${ind}  <link>`,
        `${ind}    <linkclipref>${l.id}</linkclipref>`,
        `${ind}    <mediatype>${l.kind}</mediatype>`,
        `${ind}    <trackindex>${l.trackIndex}</trackindex>`,
        `${ind}    <clipindex>${l.clipIndex}</clipindex>`,
        ...(l.kind === 'audio' ? [`${ind}    <groupindex>1</groupindex>`] : []),
        `${ind}  </link>`
      )
    }
    lines.push(`${ind}</clipitem>`)
    return lines.join('\n')
  }

  const trackXml = (plan: TrackPlan, ind: string): string => {
    const attr = plan.kind === 'audio' ? ' premiereTrackType="Stereo"' : ''
    const lines = [`${ind}<track${attr}>`]
    for (const c of plan.clips) {
      if (c.transitionBefore)
        lines.push(
          transitionXml(
            c.transitionBefore.start,
            c.transitionBefore.end,
            c.transitionBefore.type,
            'center',
            `${ind}  `
          )
        )
      if (c.fadeIn)
        lines.push(transitionXml(c.start, c.start + c.fadeIn, 'audio', 'start-black', `${ind}  `))
      lines.push(clipXml(c, `${ind}  `))
      if (c.fadeOut)
        lines.push(transitionXml(c.end - c.fadeOut, c.end, 'audio', 'end-black', `${ind}  `))
    }
    lines.push(
      `${ind}  <enabled>${plan.enabled ? 'TRUE' : 'FALSE'}</enabled>`,
      `${ind}  <locked>FALSE</locked>`
    )
    if (plan.kind === 'audio') lines.push(`${ind}  <outputchannelindex>1</outputchannelindex>`)
    lines.push(`${ind}</track>`)
    return lines.join('\n')
  }

  // --- 尺・マーカー ---
  let duration = sequenceDurationFrames(seq)
  for (const c of telopClips) duration = Math.max(duration, c.startFrame + c.durationFrames)
  const markers = [...(options.markers ?? [])]
    .filter((m) => Number.isFinite(m.frame) && m.frame >= 0)
    .sort((a, b) => a.frame - b.frame)
  const markerXml = (m: PremiereMarker, ind: string): string => {
    const f = Math.round(m.frame)
    const d = m.durationFrames && m.durationFrames > 0 ? Math.round(m.durationFrames) : 0
    return [
      `${ind}<marker>`,
      `${ind}  <comment>${xmlEscape(m.comment ?? '')}</comment>`,
      `${ind}  <name>${xmlEscape(m.name)}</name>`,
      `${ind}  <in>${f}</in>`,
      `${ind}  <out>${d > 0 ? f + d : -1}</out>`,
      `${ind}</marker>`
    ].join('\n')
  }

  const name = options.name ?? project.name ?? 'sequence'
  const ind = '    '
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    `    <name>${xmlEscape(name)}</name>`,
    `    <duration>${duration}</duration>`,
    seqRate(ind),
    `${ind}<timecode>`,
    seqRate(`${ind}  `),
    `${ind}  <string>${framesToTimecode(0, rate, dropFrame)}</string>`,
    `${ind}  <frame>0</frame>`,
    `${ind}  <displayformat>${dropFrame ? 'DF' : 'NDF'}</displayformat>`,
    `${ind}</timecode>`,
    `${ind}<in>-1</in>`,
    `${ind}<out>-1</out>`,
    `${ind}<media>`,
    `${ind}  <video>`,
    `${ind}    <format>`,
    videoSample(rate, seq.width, seq.height, `${ind}      `),
    `${ind}    </format>`
  ]
  for (const plan of videoPlans) out.push(trackXml(plan, `${ind}    `))
  out.push(
    `${ind}  </video>`,
    `${ind}  <audio>`,
    `${ind}    <numOutputChannels>2</numOutputChannels>`,
    `${ind}    <format>`,
    audioSample(`${ind}      `),
    `${ind}    </format>`,
    `${ind}    <outputs>`,
    ...[1, 2].map((i) =>
      [
        `${ind}      <group>`,
        `${ind}        <index>${i}</index>`,
        `${ind}        <numchannels>1</numchannels>`,
        `${ind}        <downmix>0</downmix>`,
        `${ind}        <channel>`,
        `${ind}          <index>${i}</index>`,
        `${ind}        </channel>`,
        `${ind}      </group>`
      ].join('\n')
    ),
    `${ind}    </outputs>`
  )
  for (const plan of audioPlans) out.push(trackXml(plan, `${ind}    `))
  out.push(`${ind}  </audio>`, `${ind}</media>`)
  for (const m of markers) out.push(markerXml(m, ind))
  out.push('  </sequence>', '</xmeml>', '')

  return {
    xml: out.join('\n'),
    warnings: [...warnings],
    stats: {
      videoClips: videoPlans.reduce((n, p) => n + p.clips.length, 0),
      audioClips: audioPlans.reduce((n, p) => n + p.clips.length, 0),
      videoTracks: videoPlans.length,
      audioTracks: audioPlans.length,
      markers: markers.length,
      durationFrames: duration
    }
  }
}
