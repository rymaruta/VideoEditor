import { describe, expect, it } from 'vitest'
import { getTotalDuration, useProjectStore } from '@renderer/store/projectStore'
import {
  audioClipDuration,
  buildTimedClips,
  totalTimelineDuration
} from '@renderer/lib/timelineMath'
import type { AudioTrackClip, MediaAsset, Project, TextOverlay } from '@shared/types'
import { defaultTextStyle } from '@shared/textStyle'
import { seeded } from '../helpers/boundary'

/**
 * **編集アクションを乱数の手順で叩き続ける回帰テスト。**
 *
 * `projectStore.test.ts` の「連続操作」は契約どおりの引数だけを渡す。こちらは
 * - 収録(マルチカム)の企画(差し込みの画・自動の BGM/SE/CG・自動テロップ・紐づくテロップ入り)も回す
 * - 0・負・NaN・±Infinity・居ない id・素材の尺を超える時刻・速さ 0.1〜16 を混ぜる
 * - 1手ごとに強めの不変条件を見る(下の `brokenInvariants`)
 * - 1ラウンドの最後に、全部取り消すと最初と同じ・全部やり直すと最後と同じかを見る
 *
 * 種は固定なので、落ちたら同じ手順で必ず再現する(メッセージに手順が出る)。
 *
 * 呼び出し側が値を作って渡す(入口では検査しない)アクション——自動の SE/BGM/CG・演出テロップ・
 * 素材の差し替えの長さ・効果音の一括配置——には**呼び出し側が作りうる値だけ**を渡す。
 */

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

function asset(id: string, duration: number, extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    filePath: `/x/${id}`,
    fileName: id,
    duration,
    width: 1280,
    height: 720,
    fps: 30,
    hasAudio: true,
    hasVideo: true,
    ...extra
  }
}

const ASSETS: MediaAsset[] = [
  asset('A', 10),
  asset('B', 8),
  asset('M', 20, { hasVideo: false, width: 0, height: 0 }),
  asset('camA', 100),
  asset('camB', 100),
  asset('micM', 100, { hasVideo: false }),
  asset('broll', 8),
  asset('still', 5, { still: true, hasAudio: false })
]
const BGM_ASSET = asset('bgm', 30, { filePath: '/x/bgm', hasVideo: false })
const SE_ASSET = asset('se', 2, { filePath: '/x/se', hasVideo: false })
const CG_ASSET = asset('cg', 4, { filePath: '/x/cg', still: true, hasAudio: false })

function baseProject(): Project {
  return {
    id: 'p',
    name: 'fuzz',
    aspectRatio: '16:9',
    assets: ASSETS,
    clips: [
      { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1, audioDetached: true },
      { id: 'c2', assetId: 'B', inPoint: 1, outPoint: 5, speed: 1 },
      { id: 'c3', assetId: 'A', inPoint: 2, outPoint: 6, speed: 1 }
    ],
    audioTracks: [
      {
        id: 't1',
        name: 'BGM',
        volume: 1,
        muted: false,
        duckingEnabled: false,
        clips: [{ id: 'a1', assetId: 'M', startTime: 6, inPoint: 0, outPoint: 5, volume: 1 }]
      },
      {
        id: 't2',
        name: '分離音声',
        volume: 1,
        muted: false,
        duckingEnabled: false,
        clips: [
          {
            id: 'a2',
            assetId: 'A',
            startTime: 0,
            inPoint: 0,
            outPoint: 4,
            volume: 1,
            speed: 1,
            fadeIn: 0.5,
            fadeOut: 0.5,
            linkedClipId: 'c1'
          }
        ]
      }
    ],
    videoOverlayTracks: [
      {
        id: 'v1',
        name: 'PiP',
        hidden: false,
        position: 'top-right',
        scale: 0.3,
        clips: [{ id: 'p1', assetId: 'B', startTime: 2, inPoint: 0, outPoint: 3 }]
      }
    ],
    textOverlays: [
      {
        id: 'o1',
        text: 'あいう',
        startTime: 1,
        endTime: 3,
        style: defaultTextStyle(),
        source: 'manual',
        linkedClipId: 'c1',
        linkOffset: 1
      },
      {
        id: 'o2',
        text: 'いえ',
        startTime: 5,
        endTime: 7,
        style: defaultTextStyle(),
        source: 'manual'
      }
    ],
    beatGrid: null
  }
}

const MULTICAM = {
  anchorSourceId: 'A',
  sources: [
    { id: 'A', name: 'カメラA', kind: 'camera' as const },
    { id: 'B', name: 'カメラB', kind: 'camera' as const },
    { id: 'M', name: '出演者A', kind: 'mic' as const }
  ],
  files: [
    { assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 },
    { assetId: 'camB', sourceId: 'B', start: 2, rate: 1, duration: 95 },
    { assetId: 'micM', sourceId: 'M', start: 0, rate: 1, duration: 100 }
  ]
}

type RoughCut = Parameters<ReturnType<typeof st>['applyRoughCut']>[0]
function cutOf(ranges: [number, number][]): RoughCut {
  let t = 0
  const main = ranges.map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 }))
  const clips = ranges.map(([a, b]) => {
    const c = { assetId: 'micM', startTime: t, inPoint: a, outPoint: b, speed: 1 }
    t += b - a
    return c
  })
  return {
    main,
    audio: [{ name: '出演者A', sourceId: 'M', volume: 1, clips }],
    duration: t,
    spans: []
  }
}

function autoTelop(id: string, text: string, s: number, e: number): Omit<TextOverlay, 'id'> {
  return {
    text,
    startTime: s,
    endTime: e,
    style: defaultTextStyle(),
    source: 'auto',
    utteranceId: id,
    utteranceChunk: 0
  }
}

/** ミラー(購読)が収束した状態から、履歴なしで始める */
function resetTo(project: Project): void {
  S.setState({
    project,
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    selectedOverlayId: null,
    clipboardClips: [],
    missingAssetPaths: [],
    missingAssetIds: []
  })
  S.setState({ project: { ...st().project } })
}

/**
 * 収録の企画: 仮編集(3区間・自動テロップ3件)→ 自動の BGM・SE・CG → 差し込みの画(インサート)
 * → 本編に紐づく手置きのテロップ。全部アクションを通して作る(追従が効いた状態から始める)。
 */
let multicamTemplate: Project | null = null
function multicamProject(): Project {
  if (!multicamTemplate) {
    resetTo({
      ...baseProject(),
      clips: [],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: [],
      multicam: MULTICAM
    })
    st().applyRoughCut(
      cutOf([
        [0, 10],
        [20, 30],
        [40, 50]
      ]),
      [
        autoTelop('u1', '一つ目', 2, 3),
        autoTelop('u2', '二つ目', 11, 12),
        autoTelop('u3', '三つ目', 25, 26)
      ]
    )
    st().setAutoSounds(
      [
        {
          role: 'bgm',
          clips: [
            { path: '/x/bgm', startTime: 0, inPoint: 0, outPoint: 25, volume: 0.5, reason: '' }
          ]
        },
        {
          role: 'se',
          clips: [{ path: '/x/se', startTime: 12, inPoint: 0, outPoint: 1, volume: 1, reason: '' }]
        }
      ],
      [BGM_ASSET, SE_ASSET]
    )
    st().setAutoCg(
      [{ path: '/x/cg', startTime: 3, inPoint: 0, outPoint: 4, keyword: 'k' }],
      [CG_ASSET]
    )
    st().insertClipAtTime('broll', 0, 3, 10)
    const p = st().project
    const target = p.clips[2]
    S.setState({
      project: {
        ...p,
        textOverlays: [
          ...p.textOverlays,
          {
            id: 'manual',
            text: '手置き',
            startTime: 15,
            endTime: 16,
            style: defaultTextStyle(),
            source: 'manual',
            linkedClipId: target.id,
            linkOffset: 2
          }
        ]
      }
    })
    S.setState({ project: { ...st().project } })
    multicamTemplate = structuredClone(st().project)
  }
  return structuredClone(multicamTemplate)
}

// ---------------------------------------------------------------- 不変条件

function nonFinitePaths(v: unknown, path: string, out: string[]): void {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(`${path}=${v}`)
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => nonFinitePaths(x, `${path}[${i}]`, out))
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) nonFinitePaths(x, `${path}.${k}`, out)
  }
}

function overlapCount(clips: readonly AudioTrackClip[]): number {
  const r = clips
    .map((c) => ({ s: c.startTime, e: c.startTime + audioClipDuration(c) }))
    .sort((a, b) => a.s - b.s)
  let n = 0
  for (let i = 1; i < r.length; i++) if (r[i].s < r[i - 1].e - 1e-6) n++
  return n
}

function duplicateCount(
  clips: readonly { assetId: string; startTime: number; inPoint: number; outPoint: number }[]
): number {
  const keys = clips.map((c) =>
    [c.assetId, c.startTime.toFixed(6), c.inPoint.toFixed(6), c.outPoint.toFixed(6)].join('|')
  )
  return keys.length - new Set(keys).size
}

/**
 * 1手ごとに守られていなければならないこと。`manualTracks` は、利用者が手で動かした
 * (重ねてよい)トラックの id。追従で作られるトラックの重なり・重複はそれ以外で見る。
 */
function brokenInvariants(p: Project, manualTracks: ReadonlySet<string>): string[] {
  const out: string[] = []
  const nonFinite: string[] = []
  nonFinitePaths(p, 'project', nonFinite)
  if (nonFinite.length > 0) out.push(`有限でない値 ${nonFinite.slice(0, 3).join(', ')}`)

  const dur = new Map(p.assets.map((a) => [a.id, a.duration]))
  const clipIds = new Set(p.clips.map((c) => c.id))
  if (clipIds.size !== p.clips.length) out.push('本編クリップIDが重複')
  const itemIds = [
    ...p.audioTracks.flatMap((t) => t.clips.map((c) => c.id)),
    ...p.videoOverlayTracks.flatMap((t) => t.clips.map((c) => c.id)),
    ...p.textOverlays.map((o) => o.id)
  ]
  if (new Set(itemIds).size !== itemIds.length) out.push('音声・PiP・テロップのIDが重複')

  const rangeOk = (c: { inPoint: number; outPoint: number }, d: number): boolean =>
    c.inPoint >= 0 && c.outPoint > c.inPoint && c.outPoint <= d + 1e-9

  for (const c of p.clips) {
    const d = dur.get(c.assetId)
    if (d === undefined) out.push(`本編 ${c.id} が居ない素材を指す`)
    else if (!rangeOk(c, d)) out.push(`本編 ${c.id} の範囲 ${c.inPoint}..${c.outPoint} (素材 ${d})`)
    if (!(c.speed > 0)) out.push(`本編 ${c.id} の速さ ${c.speed}`)
  }

  const timed = new Map(buildTimedClips(p).map((tc) => [tc.clip.id, tc]))
  for (const t of p.audioTracks) {
    if (!(t.volume >= 0)) out.push(`音声トラック ${t.name} の音量 ${t.volume}`)
    for (const c of t.clips) {
      const d = dur.get(c.assetId)
      if (d === undefined) out.push(`音声 ${c.id} が居ない素材を指す`)
      else if (!(c.startTime >= 0 && rangeOk(c, d)))
        out.push(`音声 ${c.id} s=${c.startTime} ${c.inPoint}..${c.outPoint} (素材 ${d})`)
      if (c.speed !== undefined && !(c.speed > 0)) out.push(`音声 ${c.id} の速さ ${c.speed}`)
      if (c.volume !== undefined && !(c.volume >= 0)) out.push(`音声 ${c.id} の音量 ${c.volume}`)
      if ((c.fadeIn ?? 0) < 0 || (c.fadeOut ?? 0) < 0) out.push(`音声 ${c.id} のフェードが負`)
      if (c.linkedClipId) {
        const tc = timed.get(c.linkedClipId)
        if (!tc) out.push(`音声 ${c.id} の紐づけ先 ${c.linkedClipId} が居ない`)
        else if (
          Math.abs(tc.start - c.startTime) > 1e-6 ||
          c.inPoint !== tc.clip.inPoint ||
          c.outPoint !== tc.clip.outPoint
        )
          out.push(`音声 ${c.id} が紐づけ先とずれている`)
      }
    }
    const follows = Boolean(t.multicamSourceId || t.autoRole)
    if (follows && !manualTracks.has(t.id)) {
      const dup = duplicateCount(t.clips)
      if (dup > 0) out.push(`追従トラック ${t.name} に同じクリップが ${dup} 本重複`)
      if (t.multicamSourceId && overlapCount(t.clips) > 0)
        out.push(`収録の音声トラック ${t.name} でクリップが重なる`)
    }
  }

  for (const t of p.videoOverlayTracks) {
    if (!(t.scale >= 0.1 && t.scale <= 1)) out.push(`PiPトラック ${t.name} の大きさ ${t.scale}`)
    for (const c of t.clips) {
      const d = dur.get(c.assetId)
      if (d === undefined) out.push(`PiP ${c.id} が居ない素材を指す`)
      else if (!(c.startTime >= 0 && rangeOk(c, d)))
        out.push(`PiP ${c.id} s=${c.startTime} ${c.inPoint}..${c.outPoint} (素材 ${d})`)
    }
    if ((t.autoRole || t.multicamSourceId) && !manualTracks.has(t.id)) {
      const dup = duplicateCount(t.clips)
      if (dup > 0) out.push(`追従トラック ${t.name} に同じクリップが ${dup} 本重複`)
    }
  }

  for (const o of p.textOverlays) {
    if (!(o.startTime >= 0 && o.endTime >= o.startTime))
      out.push(`テロップ ${o.text} の範囲 ${o.startTime}..${o.endTime}`)
    if (o.linkedClipId && !clipIds.has(o.linkedClipId))
      out.push(`テロップ ${o.text} の紐づけ先 ${o.linkedClipId} が居ない`)
  }

  // 計算の道具(timelineMath)とストアの総尺が食い違わない
  const storeTotal = getTotalDuration(p)
  const mathTotal = totalTimelineDuration(buildTimedClips(p))
  if (!(Math.abs(storeTotal - mathTotal) < 1e-6))
    out.push(`総尺の食い違い store=${storeTotal} timelineMath=${mathTotal}`)
  return out
}

// ---------------------------------------------------------------- 手順

const NASTY = [0, -0, -1, -0.001, 0.05, 150, 1e9, NaN, Infinity, -Infinity] as const
const MAX_HISTORY = 50

interface Ctx {
  rnd: () => number
  /** 手で動かした(重ねてよい)トラックの id */
  manualTracks: Set<string>
}

interface Op {
  name: string
  /** 履歴に積まない仕様のアクション(取り消しの検査から外す) */
  noHistory?: boolean
  /** 取り消し・やり直しそのもの */
  history?: boolean
  run: (ctx: Ctx) => string
}

function makeOps(): Op[] {
  // 乱数は ctx から取る(ラウンドごとに同じ種の流れ)
  let rnd: () => number = Math.random
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  /** 範囲内の値。4回に1回は異常値 */
  const num = (lo: number, hi: number): number =>
    rnd() < 0.25 ? pick(NASTY) : lo + rnd() * (hi - lo)
  const valid = (lo: number, hi: number): number => lo + rnd() * (hi - lo)
  const speed = (): number =>
    rnd() < 0.75 ? 0.1 + rnd() * 15.9 : pick([0, -1, NaN, Infinity, 0.1, 16])
  const orMissing = (id: string | undefined): string =>
    id === undefined || rnd() < 0.1 ? 'missing-id' : id
  const p = (): Project => st().project
  const clipId = (): string => orMissing(p().clips.length ? pick(p().clips).id : undefined)
  const assetId = (): string => orMissing(pick(p().assets.map((a) => a.id)))
  const audioTrackId = (): string =>
    orMissing(p().audioTracks.length ? pick(p().audioTracks).id : undefined)
  const pipTrackId = (): string =>
    orMissing(p().videoOverlayTracks.length ? pick(p().videoOverlayTracks).id : undefined)
  const overlayId = (): string =>
    orMissing(p().textOverlays.length ? pick(p().textOverlays).id : undefined)
  const pair = (tracks: { id: string; clips: { id: string }[] }[]): [string, string] => {
    const all = tracks.flatMap((t) => t.clips.map((c) => [t.id, c.id] as [string, string]))
    return all.length && rnd() > 0.1 ? pick(all) : ['missing-id', 'missing-id']
  }
  const audioPair = (ctx: Ctx): [string, string] => {
    const r = pair(p().audioTracks)
    ctx.manualTracks.add(r[0])
    return r
  }
  const pipPair = (ctx: Ctx): [string, string] => {
    const r = pair(p().videoOverlayTracks)
    ctx.manualTracks.add(r[0])
    return r
  }
  const T = (): number => num(0, 60)
  const fmt = (...xs: unknown[]): string => xs.map((x) => String(x)).join(', ')

  const ops: Op[] = [
    // ---- 本編
    {
      name: 'updateClipTrim',
      run: () => {
        const a = [clipId(), num(0, 50), num(0, 120)] as const
        st().updateClipTrim(...a)
        return fmt(...a)
      }
    },
    {
      name: 'rollTrim',
      run: () => {
        const c = p().clips
        if (c.length < 2) return '-'
        const i = Math.floor(rnd() * (c.length - 1))
        const d = num(-5, 5)
        st().rollTrim(c[i].id, c[i + 1].id, d)
        return fmt(i, d)
      }
    },
    {
      name: 'updateClipSpeed',
      run: () => {
        const a = [clipId(), speed()] as const
        st().updateClipSpeed(...a)
        return fmt(...a)
      }
    },
    {
      name: 'updateClipsSpeed',
      run: () => {
        const s = speed()
        st().updateClipsSpeed([clipId(), clipId()], s)
        return fmt(s)
      }
    },
    {
      name: 'splitClipAtTime',
      run: () => {
        const a = [clipId(), T()] as const
        st().splitClipAtTime(...a)
        return fmt(...a)
      }
    },
    { name: 'removeClip', run: () => (st().removeClip(clipId()), '') },
    { name: 'removeClips', run: () => (st().removeClips([clipId(), clipId()]), '') },
    { name: 'duplicateClips', run: () => (st().duplicateClips([clipId()]), '') },
    {
      name: 'moveClip',
      run: () => {
        const dir = pick(['left', 'right'] as const)
        st().moveClip(clipId(), dir)
        return dir
      }
    },
    {
      name: 'moveClipToIndex',
      run: () => {
        const i = pick([0, 1, 2, 5, -3, NaN, Infinity, -Infinity, 1.5])
        st().moveClipToIndex(clipId(), i)
        return fmt(i)
      }
    },
    { name: 'detachClipAudio', run: () => (st().detachClipAudio(clipId()), '') },
    { name: 'reattachClipAudio', run: () => (st().reattachClipAudio(clipId()), '') },
    {
      name: 'insertClipAtTime',
      run: () => {
        const a = [assetId(), num(0, 5), num(0, 12), T()] as const
        st().insertClipAtTime(...a)
        return fmt(...a)
      }
    },
    {
      name: 'overwriteClipAtTime',
      run: () => {
        const a = [assetId(), num(0, 5), num(0, 12), T()] as const
        st().overwriteClipAtTime(...a)
        return fmt(...a)
      }
    },
    {
      name: 'addClipToTimeline',
      run: () => {
        const i = pick([undefined, 0, 2, 99, -1, NaN])
        const a = assetId()
        st().addClipToTimeline(a, i)
        return fmt(a, i)
      }
    },
    {
      name: 'addTrimmedClipToTimeline',
      run: () => {
        const a = [assetId(), num(0, 5), num(0, 12)] as const
        st().addTrimmedClipToTimeline(...a)
        return fmt(...a)
      }
    },
    {
      name: 'applyClipTrimAndCrop',
      run: () => {
        const a = [clipId(), num(0, 5), num(0, 12), rnd() < 0.5] as const
        st().applyClipTrimAndCrop(...a)
        return fmt(...a)
      }
    },
    {
      name: 'updateClipsColorLabel',
      run: () => (st().updateClipsColorLabel([clipId()], pick(['red', 'blue', undefined])), '')
    },
    {
      name: 'replaceClipRange',
      run: () => {
        const c = p().clips.length ? pick(p().clips) : null
        if (!c || c.outPoint - c.inPoint < 0.5) return '-'
        const m = (c.inPoint + c.outPoint) / 2
        st().replaceClipRange(c.id, [
          { ...c, id: `r${Math.floor(rnd() * 1e9)}`, outPoint: m - 0.1 },
          { ...c, id: `r${Math.floor(rnd() * 1e9)}`, inPoint: m + 0.1 }
        ])
        return c.id
      }
    },
    {
      name: 'copyPaste',
      run: () => {
        st().selectClip(clipId())
        st().copySelectedClip()
        st().pasteClip()
        return ''
      }
    },
    {
      name: 'switchClipAngle',
      run: () => {
        const s = pick(['A', 'B', 'M', 'missing-id'])
        st().switchClipAngle(clipId(), s)
        return s
      }
    },
    {
      name: 'applyRoughCut',
      run: () => {
        if (!p().multicam) return '-'
        st().applyRoughCut(
          cutOf([
            [0, 8],
            [22, 30],
            [45, 50]
          ]),
          [autoTelop('u1', '一つ目', 2, 3), autoTelop('u3', '三つ目', 18, 19)]
        )
        return ''
      }
    },
    { name: 'undo', history: true, run: () => (st().undo(), '') },
    { name: 'redo', history: true, run: () => (st().redo(), '') },

    // ---- 音声
    { name: 'addAudioTrack', run: () => (st().addAudioTrack('T'), '') },
    { name: 'removeAudioTrack', run: () => (st().removeAudioTrack(audioTrackId()), '') },
    {
      name: 'setAudioTrackVolume',
      run: () => {
        const v = num(0, 2)
        st().setAudioTrackVolume(audioTrackId(), v)
        return fmt(v)
      }
    },
    { name: 'toggleAudioTrackMute', run: () => (st().toggleAudioTrackMute(audioTrackId()), '') },
    {
      name: 'addClipToAudioTrack',
      run: () => (st().addClipToAudioTrack(audioTrackId(), assetId()), '')
    },
    {
      name: 'updateAudioClipStart',
      run: (ctx) => {
        const [t, c] = audioPair(ctx)
        const s = T()
        st().updateAudioClipStart(t, c, s)
        return fmt(s)
      }
    },
    {
      name: 'moveAudioClipToTrack',
      run: (ctx) => {
        const [t, c] = audioPair(ctx)
        const to = audioTrackId()
        ctx.manualTracks.add(to)
        const s = T()
        st().moveAudioClipToTrack(t, c, to, s)
        return fmt(s)
      }
    },
    {
      name: 'updateAudioClipTrim',
      run: (ctx) => {
        const [t, c] = audioPair(ctx)
        const a = [num(0, 5), num(0, 30)] as const
        st().updateAudioClipTrim(t, c, ...a)
        return fmt(...a)
      }
    },
    {
      name: 'updateAudioClipStartAndTrim',
      run: (ctx) => {
        const [t, c] = audioPair(ctx)
        const a = [T(), num(0, 5), num(0, 30)] as const
        st().updateAudioClipStartAndTrim(t, c, ...a)
        return fmt(...a)
      }
    },
    {
      name: 'updateAudioClipVolume',
      run: () => {
        const [t, c] = pair(p().audioTracks)
        const v = num(0, 2)
        st().updateAudioClipVolume(t, c, v)
        return fmt(v)
      }
    },
    {
      name: 'updateAudioClipFade',
      run: () => {
        const [t, c] = pair(p().audioTracks)
        const a = [num(0, 3), num(0, 3)] as const
        st().updateAudioClipFade(t, c, ...a)
        return fmt(...a)
      }
    },
    {
      name: 'unlinkAudioClip',
      run: () => {
        const [t, c] = pair(p().audioTracks)
        st().unlinkAudioClip(t, c)
        return ''
      }
    },
    {
      // 呼び出し側は差し替え先の素材の尺を渡す
      name: 'swapAudioClipAsset',
      run: (ctx) => {
        const [t, c] = audioPair(ctx)
        const a = pick(p().assets)
        st().swapAudioClipAsset(t, c, a.id, a.duration)
        return a.id
      }
    },
    {
      name: 'removeAudioClip',
      run: () => {
        const [t, c] = pair(p().audioTracks)
        st().removeAudioClip(t, c)
        return ''
      }
    },
    {
      name: 'splitAudioClipAtTime',
      run: () => {
        const [t, c] = pair(p().audioTracks)
        const s = T()
        st().splitAudioClipAtTime(t, c, s)
        return fmt(s)
      }
    },
    {
      name: 'addAudioClipWithAsset',
      run: (ctx) => {
        const s = pick([undefined, 0, 5, -2, NaN, Infinity])
        const n = Math.floor(rnd() * 3)
        const existing = p().audioTracks.find((t) => t.name === 'ナレ')
        if (existing) ctx.manualTracks.add(existing.id)
        st().addAudioClipWithAsset(asset(`n${n}`, 4, { filePath: `/x/n${n}` }), {
          trackName: 'ナレ',
          startTime: s
        })
        return fmt(s)
      }
    },
    {
      // 呼び出し側は SE 素材の尺を outPoint に渡す
      name: 'addKeywordSeClips',
      run: () => {
        if (!p().assets.some((a) => a.id === 'M')) return '-'
        const s = num(0, 20)
        st().addKeywordSeClips([{ assetId: 'M', startTime: s, outPoint: 20, volume: 1 }], [])
        return fmt(s)
      }
    },

    // ---- PiP
    { name: 'addVideoOverlayTrack', run: () => (st().addVideoOverlayTrack('P'), '') },
    {
      name: 'removeVideoOverlayTrack',
      run: () => (st().removeVideoOverlayTrack(pipTrackId()), '')
    },
    {
      name: 'toggleVideoOverlayTrackHidden',
      run: () => (st().toggleVideoOverlayTrackHidden(pipTrackId()), '')
    },
    {
      name: 'setVideoOverlayTrackScale',
      run: () => {
        const v = num(0, 1)
        st().setVideoOverlayTrackScale(pipTrackId(), v)
        return fmt(v)
      }
    },
    {
      name: 'addClipToVideoOverlayTrack',
      run: (ctx) => {
        const t = pipTrackId()
        ctx.manualTracks.add(t)
        const s = pick([undefined, T()])
        st().addClipToVideoOverlayTrack(t, assetId(), s)
        return fmt(s)
      }
    },
    {
      name: 'updateVideoOverlayClipStart',
      run: (ctx) => {
        const [t, c] = pipPair(ctx)
        const s = T()
        st().updateVideoOverlayClipStart(t, c, s)
        return fmt(s)
      }
    },
    {
      name: 'moveVideoOverlayClipToTrack',
      run: (ctx) => {
        const [t, c] = pipPair(ctx)
        const to = pipTrackId()
        ctx.manualTracks.add(to)
        const s = T()
        st().moveVideoOverlayClipToTrack(t, c, to, s)
        return fmt(s)
      }
    },
    {
      name: 'updateVideoOverlayClipTrim',
      run: (ctx) => {
        const [t, c] = pipPair(ctx)
        const a = [num(0, 5), num(0, 30)] as const
        st().updateVideoOverlayClipTrim(t, c, ...a)
        return fmt(...a)
      }
    },
    {
      name: 'updateVideoOverlayClipStartAndTrim',
      run: (ctx) => {
        const [t, c] = pipPair(ctx)
        const a = [T(), num(0, 5), num(0, 30)] as const
        st().updateVideoOverlayClipStartAndTrim(t, c, ...a)
        return fmt(...a)
      }
    },
    {
      name: 'swapVideoOverlayClipAsset',
      run: (ctx) => {
        const [t, c] = pipPair(ctx)
        const a = pick(p().assets)
        st().swapVideoOverlayClipAsset(t, c, a.id, a.duration)
        return a.id
      }
    },
    {
      name: 'removeVideoOverlayClip',
      run: () => {
        const [t, c] = pair(p().videoOverlayTracks)
        st().removeVideoOverlayClip(t, c)
        return ''
      }
    },
    {
      name: 'splitVideoOverlayClipAtTime',
      run: () => {
        const [t, c] = pair(p().videoOverlayTracks)
        const s = T()
        st().splitVideoOverlayClipAtTime(t, c, s)
        return fmt(s)
      }
    },

    // ---- テロップ
    {
      name: 'addTextOverlay',
      run: () => {
        const s = valid(0, 30)
        const e = s + valid(0, 3)
        st().addTextOverlay({
          text: 'て',
          startTime: s,
          endTime: e,
          style: defaultTextStyle(),
          source: 'manual'
        })
        return fmt(s, e)
      }
    },
    {
      // 画面の操作は尺を保ったまま、0 以上へ動かす。ストアは負・逆転・非有限をそのまま通す
      // (projectStore.test.ts の【既知の穴】で固定している)ので、ここでは画面が渡す値だけ
      name: 'updateTextOverlay(移動)',
      run: () => {
        const o = p().textOverlays
        if (!o.length) return '-'
        const x = pick(o)
        const s = valid(0, 30)
        st().updateTextOverlay(x.id, { startTime: s, endTime: s + (x.endTime - x.startTime) })
        return fmt(s)
      }
    },
    {
      name: 'updateTextOverlay(文言)',
      run: () => (st().updateTextOverlay(overlayId(), { text: `x${Math.floor(rnd() * 3)}` }), '')
    },
    {
      name: 'updateTextOverlaysStyle',
      run: () => (
        st().updateTextOverlaysStyle([overlayId()], { fontSize: 30 + Math.floor(rnd() * 3) }),
        ''
      )
    },
    { name: 'removeTextOverlay', run: () => (st().removeTextOverlay(overlayId()), '') },
    {
      name: 'shiftAllTextOverlays',
      run: () => {
        const d = num(-10, 10)
        st().shiftAllTextOverlays(d)
        return fmt(d)
      }
    },
    {
      name: 'setTextOverlayLink',
      run: () => {
        const c = rnd() < 0.3 ? null : clipId()
        st().setTextOverlayLink(overlayId(), c)
        return fmt(c)
      }
    },
    {
      name: 'setEffectTelops',
      run: () => {
        const s = valid(0, 20)
        st().setEffectTelops([
          {
            text: 'fx',
            startTime: s,
            endTime: s + 1,
            style: defaultTextStyle(),
            source: 'auto',
            effectId: `e${Math.floor(rnd() * 2)}`
          }
        ])
        return fmt(s)
      }
    },

    // ---- 自動の SE/BGM/CG(履歴に積まない仕様)
    {
      name: 'setAutoSounds',
      noHistory: true,
      run: () => {
        const s = valid(0, 20)
        st().setAutoSounds(
          [
            {
              role: 'se',
              clips: [
                { path: '/x/se', startTime: s, inPoint: 0, outPoint: 1, volume: 1, reason: '' }
              ]
            }
          ],
          [SE_ASSET]
        )
        return fmt(s)
      }
    },
    {
      name: 'setAutoCg',
      noHistory: true,
      run: () => {
        const s = valid(0, 20)
        st().setAutoCg(
          [{ path: '/x/cg', startTime: s, inPoint: 0, outPoint: 4, keyword: 'k' }],
          [CG_ASSET]
        )
        return fmt(s)
      }
    },
    {
      name: 'removeAsset',
      run: () => {
        if (rnd() < 0.7) return '-'
        const a = assetId()
        st().removeAsset(a)
        return a
      }
    }
  ]
  return ops.map((op) => ({
    ...op,
    run: (ctx: Ctx) => {
      rnd = ctx.rnd
      return op.run(ctx)
    }
  }))
}

const OPS = makeOps()
const ROUNDS = 60
const STEPS = 25

/**
 * 1ラウンド = 企画を作り直して STEPS 手。1手ごとに不変条件と「何も変えない操作は履歴を積まない」を見て、
 * 最後に全部取り消し → 最初と同じ、全部やり直し → 最後と同じ を見る。
 * `withAuto` が false のラウンドは、履歴に積まない仕様のアクションを使わない(取り消しで戻せないため)。
 */
function runRounds(kind: 'base' | 'multicam', seed: number, withAuto: boolean): void {
  const rnd = seeded(seed)
  const ops = OPS.filter((o) => withAuto || !o.noHistory)
  for (let r = 0; r < ROUNDS; r++) {
    resetTo(kind === 'base' ? baseProject() : multicamProject())
    const ctx: Ctx = { rnd, manualTracks: new Set() }
    const start = structuredClone(st().project)
    expect(brokenInvariants(start, ctx.manualTracks), `${kind} の土台`).toEqual([])
    const trail: string[] = []
    for (let s = 0; s < STEPS; s++) {
      const op = ops[Math.floor(rnd() * ops.length)]
      const before = st().project
      const beforeJson = JSON.stringify(before)
      const pastBefore = st().past.length
      const args = op.run(ctx)
      trail.push(`${op.name}(${args})`)
      const where = `${kind} seed=${seed} round=${r}: ${trail.join(' → ')}`
      const after = st().project
      if (!op.history && JSON.stringify(after) === beforeJson) {
        expect(st().past.length, `何も変えない操作で履歴が積まれた: ${where}`).toBe(pastBefore)
      }
      expect(st().past.length, `履歴の上限: ${where}`).toBeLessThanOrEqual(MAX_HISTORY)
      expect(st().future.length, `やり直しの上限: ${where}`).toBeLessThanOrEqual(MAX_HISTORY)
      expect(brokenInvariants(after, ctx.manualTracks), where).toEqual([])
    }
    if (withAuto) continue
    const where = `${kind} seed=${seed} round=${r}: ${trail.join(' → ')}`
    const end = structuredClone(st().project)
    const depth = st().past.length
    for (let i = 0; i < depth; i++) st().undo()
    expect(st().past.length, `全部取り消した: ${where}`).toBe(0)
    expect(st().project, `全部取り消すと最初と同じ: ${where}`).toEqual(start)
    for (let i = 0; i < depth; i++) st().redo()
    expect(st().project, `全部やり直すと最後と同じ: ${where}`).toEqual(end)
  }
}

describe('編集アクションの乱数手順(異常値入り)', () => {
  it('ふつうの企画: 不変条件・取り消し/やり直し', () => runRounds('base', 20261005, false))
  it('収録の企画: 不変条件・取り消し/やり直し', () => runRounds('multicam', 20261006, false))
  it('ふつうの企画: 自動の SE/BGM/CG も混ぜて不変条件', () => runRounds('base', 20261007, true))
  it('収録の企画: 自動の SE/BGM/CG も混ぜて不変条件', () => runRounds('multicam', 20261008, true))

  it('同じ所を2回使った本編の色ラベルを変えても、追従の声は増えない(倍々に増えていた)', () => {
    resetTo(multicamProject())
    st().duplicateClips([st().project.clips[0].id])
    const mic = (): number => st().project.audioTracks.find((t) => t.multicamSourceId)!.clips.length
    const n = mic()
    for (const label of ['red', 'blue', 'red', 'blue'] as const) {
      st().updateClipsColorLabel([st().project.clips[0].id], label)
    }
    expect(mic()).toBe(n)
    expect(brokenInvariants(st().project, new Set())).toEqual([])
  })
})
