import type { Project } from '../types'
import { createExportTimeMap } from '../exportTimeline'
import { projectRate, rateValue } from '../frameRate'
import { computeMainTrackLayout } from '../mainTrackLayout'
import { PIP_MARGIN_RATIO } from '../pipLayout'
import { targetResolution } from '../resolution'
import { assignLanes } from './lanes'
import type {
  AudioItem,
  MediaItem,
  ProjectV2,
  SequenceAudioTrack,
  TelopItem,
  VideoTrack
} from './types'

export interface FromV1Options {
  /** 出力の短辺(書き出し設定の解像度)。既定は 1080 */
  resolution?: number
}

/**
 * v1 のプロジェクトを v2(`ProjectV2`)へ写す。**v1 の書き出しと同じ位置**に置くことが要件。
 *
 * - 本編の位置・尺・繋ぎは書き出しと同じ `computeMainTrackLayout` から取る。
 * - テロップ・PiP・音声トラックの位置は、書き出しと同じ `createExportTimeMap` で
 *   「タイムラインの秒 → 書き出しの秒」へ換算する(区間の両端は対で換算する)。
 * - 本編の尺より後ろへはみ出したぶんは切る。v1 の書き出しも、PiP は尺で頭打ちにし、
 *   音声は `amix` の `duration=first` で、テロップは描かれないことで、同じく切っている。
 *
 * 秒からフレームへ丸めるので、繋ぎの秒数がフレームに乗っていない企画では、境目が
 * v1 の書き出しから最大で半フレームずれる(積み上がらない)。
 *
 * 【既知の限界】v1 の繋ぎは「手前のクリップ」ではなく「ここまで畳み込んだ長さ」で上限が
 * 決まるので、手前のクリップより長い繋ぎがありうる。そのときは2本前のクリップとも重なる。
 * v2 でもその重なりをそのまま写す(重なりは必ず繋ぎの区間の中に収まる)。
 */
export function projectV1ToV2(project: Project, options: FromV1Options = {}): ProjectV2 {
  const rate = projectRate(project.clips, project.assets)
  const fpsNum = rateValue(rate)
  const toFrame = (sec: number): number => Math.round(sec * fpsNum)
  const { w, h } = targetResolution(project.aspectRatio, options.resolution ?? 1080)
  const assetById = new Map(project.assets.map((a) => [a.id, a]))

  // v1 の書き出しは素材の見つからないクリップで止まる。移行では飛ばして続ける
  // (素材の再リンクは別の画面の役目で、ここで落とすと開けないファイルになる)。
  const mainClips = project.clips.filter((c) => assetById.has(c.assetId))
  const layout = computeMainTrackLayout(mainClips, fpsNum)
  const totalFrames = toFrame(layout.totalExportDuration)
  const { toExportTime, toExportEndTime } = createExportTimeMap(
    layout.timelineStarts,
    layout.timelineDurations,
    layout.exportStarts
  )
  /** タイムラインの区間 → フレームの区間。本編の尺で頭打ちにし、空なら null */
  const toFrameRange = (
    startTimeline: number,
    endTimeline: number
  ): { startFrame: number; durationFrames: number } | null => {
    const startFrame = toFrame(toExportTime(startTimeline))
    const endFrame = Math.min(totalFrames, toFrame(toExportEndTime(startTimeline, endTimeline)))
    if (endFrame - startFrame < 1) return null
    return { startFrame, durationFrames: endFrame - startFrame }
  }

  // --- V1: 本編 ---
  const mainItems: MediaItem[] = []
  const mainAudioItems: AudioItem[] = []
  let prevEndFrame = 0
  let prevClipId: string | undefined
  let pendingFadeIn = 0
  mainClips.forEach((clip, i) => {
    // 両端を**別々に**丸める。始まりを丸めてから尺のフレーム数を足すと、繋ぎの秒数が
    // フレームに乗っていないときに終わりが1フレームずれ、繋ぎの無い次のクリップと重なる。
    // 両端とも書き出しの累積(`exportEnds` は次の始まりと同じ数)から丸めるので、
    // 境目は必ず一致し、v1 の書き出し位置との差はどの境目でも半フレーム以内(積み上がらない)。
    const startFrame = toFrame(layout.exportStarts[i])
    const durationFrames = toFrame(layout.exportEnds[i]) - startFrame
    if (durationFrames < 1) return
    const overlapFrames = i > 0 ? prevEndFrame - startFrame : 0
    const item: MediaItem = {
      kind: 'media',
      id: clip.id,
      assetId: clip.assetId,
      startFrame,
      durationFrames,
      sourceIn: clip.inPoint,
      speed: clip.speed || 1,
      origin: 'manual',
      placement: {
        kind: 'frame',
        fit: clip.fillCrop ? 'cover' : 'contain',
        ...(clip.cropCenter ? { cropCenter: { ...clip.cropCenter } } : {}),
        ...(clip.blurBackground ? { blurBackground: true } : {})
      },
      ...(clip.colorLabel ? { colorLabel: clip.colorLabel } : {})
    }
    if (overlapFrames > 0 && clip.transitionIn && clip.transitionIn.type !== 'none') {
      item.transitionIn = { type: clip.transitionIn.type, durationFrames: overlapFrames }
    }
    mainItems.push(item)
    const hasMainAudio = Boolean(assetById.get(clip.assetId)?.hasAudio && !clip.audioDetached)
    // 繋ぎ(クロスフェード)の相手に本編の音が無い(静止画・音を分離したクリップ)なら、音のある側を
    // 繋ぎの長さで消す/出す(標準の書き出しは acrossfade で無音へ溶ける。区間ごとの書き出しは
    // 相手が居ないと繋ぎにならず、ぶつっと切れて・始まっていた)
    if (item.transitionIn) {
      const prevAudio = mainAudioItems[mainAudioItems.length - 1]
      const prevHadAudio = prevAudio !== undefined && prevAudio.linkedItemId === prevClipId
      if (prevHadAudio && !hasMainAudio) prevAudio.fadeOutFrames = overlapFrames
      // 前の前のクリップの音がまだ繋ぎの区間に掛かっている(繋ぎが音の無い短いクリップより長い)なら、
      // その音との重なり(区間ごとの書き出しのクロスフェード)で出していく。ここでも出すと二重に掛かる
      const earlierOverlaps =
        prevAudio !== undefined && prevAudio.startFrame + prevAudio.durationFrames > startFrame
      if (!prevHadAudio && hasMainAudio && !earlierOverlaps) pendingFadeIn = overlapFrames
    }
    // 本編の音は映像と同じ位置で鳴る(分離したクリップは音声トラック側に居るので除く)
    if (hasMainAudio) {
      mainAudioItems.push({
        kind: 'audio',
        id: `${clip.id}:audio`,
        assetId: clip.assetId,
        startFrame,
        durationFrames,
        sourceIn: clip.inPoint,
        sourceOut: clip.outPoint,
        speed: clip.speed || 1,
        origin: 'manual',
        linkedItemId: clip.id,
        ...(pendingFadeIn > 0 ? { fadeInFrames: pendingFadeIn } : {})
      })
    }
    pendingFadeIn = 0
    prevClipId = clip.id
    prevEndFrame = startFrame + durationFrames
  })

  const videoTracks: VideoTrack[] = [
    { id: 'v1-main', name: 'V1 本編', hidden: false, items: mainItems }
  ]

  // --- PiP: 1本の v1 トラックの中で重なっていれば、v2 では段を分ける ---
  const pipAudioTracks: SequenceAudioTrack[] = []
  /** ワイプのクリップの出点(素材の秒)。音のアイテムに渡す */
  const pipSourceOut = new Map<string, number>()
  for (const track of project.videoOverlayTracks) {
    const items: MediaItem[] = []
    for (const oc of track.clips) {
      if (!assetById.has(oc.assetId)) continue
      const dur = oc.outPoint - oc.inPoint
      if (!(dur > 0)) continue
      const range = toFrameRange(oc.startTime, oc.startTime + dur)
      if (!range) continue
      pipSourceOut.set(oc.id, oc.outPoint)
      items.push({
        kind: 'media',
        id: oc.id,
        assetId: oc.assetId,
        ...range,
        sourceIn: oc.inPoint,
        speed: 1,
        origin: 'manual',
        placement:
          track.position === 'full'
            ? { kind: 'frame', fit: 'contain' }
            : {
                kind: 'box',
                anchor: track.position,
                margin: PIP_MARGIN_RATIO,
                width: track.scale
              }
      })
    }
    assignLanes(items).forEach((lane, li) => {
      videoTracks.push({
        id: li === 0 ? track.id : `${track.id}:${li + 1}`,
        name: li === 0 ? track.name : `${track.name} (${li + 1})`,
        hidden: track.hidden,
        items: lane
      })
      // v1 の書き出しはワイプの素材の音も混ぜる(本編の音ではないのでダッキングの基準にはしない)。
      // 非表示のワイプは音も出さないので、ミュートしたトラックとして写す。
      const audioItems: AudioItem[] = lane
        .filter((it) => assetById.get(it.assetId)?.hasAudio)
        .map((it) => ({
          kind: 'audio',
          id: `${it.id}:audio`,
          assetId: it.assetId,
          startFrame: it.startFrame,
          durationFrames: it.durationFrames,
          sourceIn: it.sourceIn,
          // 出点の先の音は読まない(フレームに丸めて伸びたぶんは無音。本編・音声トラックと同じ)
          sourceOut: pipSourceOut.get(it.id),
          speed: 1,
          origin: 'manual',
          linkedItemId: it.id
        }))
      if (audioItems.length > 0) {
        pipAudioTracks.push({
          id: `${li === 0 ? track.id : `${track.id}:${li + 1}`}:audio`,
          name: `${li === 0 ? track.name : `${track.name} (${li + 1})`} の音`,
          muted: track.hidden || track.audioMuted === true,
          volume: 1,
          duckingEnabled: false,
          items: audioItems
        })
      }
    })
  }

  // --- テロップ: 重なるものは段を分け、後から始まるものほど上に置く ---
  const telops: TelopItem[] = []
  for (const o of project.textOverlays) {
    const range = toFrameRange(o.startTime, o.endTime)
    if (!range) continue
    const itemStartSec = range.startFrame / fpsNum
    telops.push({
      kind: 'telop',
      id: o.id,
      ...range,
      text: o.text,
      style: { ...o.style },
      origin: o.source === 'auto' ? 'auto' : 'manual',
      ...(o.words
        ? {
            words: o.words.map((word) => ({
              text: word.text,
              start: toExportTime(word.start) - itemStartSec,
              end: toExportEndTime(word.start, word.end) - itemStartSec
            }))
          }
        : {})
    })
  }
  assignLanes(telops).forEach((lane, li) => {
    videoTracks.push({
      id: `telop-${li + 1}`,
      name: `テロップ ${li + 1}`,
      hidden: false,
      items: lane
    })
  })

  // --- 音声 ---
  const audioTracks: SequenceAudioTrack[] = []
  if (mainAudioItems.length > 0) {
    audioTracks.push({
      id: 'a1-main',
      name: 'A1 本編の音',
      muted: false,
      volume: 1,
      duckingEnabled: false,
      items: mainAudioItems
    })
  }
  for (const track of project.audioTracks) {
    const items: AudioItem[] = []
    for (const ac of track.clips) {
      if (!assetById.has(ac.assetId)) continue
      const speed = ac.speed || 1
      const dur = (ac.outPoint - ac.inPoint) / speed
      if (!(dur > 0)) continue
      const range = toFrameRange(ac.startTime, ac.startTime + dur)
      if (!range) continue
      items.push({
        kind: 'audio',
        id: ac.id,
        assetId: ac.assetId,
        ...range,
        sourceIn: ac.inPoint,
        sourceOut: ac.outPoint,
        speed,
        origin: 'manual',
        ...(ac.volume !== undefined ? { volume: ac.volume } : {}),
        ...(ac.fadeIn ? { fadeInFrames: toFrame(ac.fadeIn) } : {}),
        ...(ac.fadeOut ? { fadeOutFrames: toFrame(ac.fadeOut) } : {}),
        ...(ac.linkedClipId ? { linkedItemId: ac.linkedClipId } : {})
      })
    }
    assignLanes(items).forEach((lane, li) => {
      audioTracks.push({
        id: li === 0 ? track.id : `${track.id}:${li + 1}`,
        name: li === 0 ? track.name : `${track.name} (${li + 1})`,
        muted: track.muted,
        volume: track.volume,
        duckingEnabled: track.duckingEnabled,
        ...(track.voice ? { voice: true } : {}),
        items: lane
      })
    })
  }

  audioTracks.push(...pipAudioTracks)

  return {
    version: 2,
    id: project.id,
    name: project.name,
    assets: project.assets.map((a) => ({ ...a })),
    sequence: {
      width: w,
      height: h,
      fps: { num: rate.num, den: rate.den },
      videoTracks,
      audioTracks
    }
  }
}
