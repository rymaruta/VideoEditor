import type { MediaAsset, Project } from './types'
import type { ProjectV2 } from './sequence/types'

/**
 * 入点が素材の長さより後ろにあるクリップ(書き出す絵も音も無い)を、書き出しの前に見つける。
 *
 * 素材を短いテイクに差し替えた・長さを読み違えた企画を開くと、こういうクリップが残る。
 * 前は ffmpeg に渡してから失敗し、標準の書き出しは「メディアファイルを処理できませんでした」だけ、
 * 区間ごとは英語の生の文(`Error opening output files: Invalid argument`)で、どのクリップが悪いのか
 * 分からなかった。前に別のクリップがあると、どちらもエラー無しでそのクリップの絵と音が無いまま
 * 書き出していた。
 */
export interface ClipBeyondSource {
  /** どのトラックの何本目か(例: 「本編の2本目」) */
  where: string
  fileName: string
  inPoint: number
  duration: number
}

/** 長さの読み違いの丸めで止めないための余裕(秒) */
const EPSILON = 1e-3

function beyond(asset: MediaAsset | undefined, inPoint: number): asset is MediaAsset {
  return (
    !!asset &&
    !asset.still &&
    Number.isFinite(asset.duration) &&
    asset.duration > 0 &&
    Number.isFinite(inPoint) &&
    inPoint >= asset.duration - EPSILON
  )
}

/** 標準の書き出し(v1 の企画)で、入点が素材の長さより後ろのクリップ */
export function clipsBeyondSource(
  project: Pick<Project, 'assets' | 'clips' | 'videoOverlayTracks' | 'audioTracks'>
): ClipBeyondSource[] {
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const out: ClipBeyondSource[] = []
  const check = (where: string, assetId: string, inPoint: number): void => {
    const a = assets.get(assetId)
    if (beyond(a, inPoint)) out.push({ where, fileName: a.fileName, inPoint, duration: a.duration })
  }
  project.clips.forEach((c, i) => check(`本編の${i + 1}本目`, c.assetId, c.inPoint))
  for (const t of project.videoOverlayTracks ?? []) {
    if (t.hidden) continue
    t.clips.forEach((c, i) => check(`トラック「${t.name}」の${i + 1}本目`, c.assetId, c.inPoint))
  }
  for (const t of project.audioTracks ?? []) {
    if (t.muted) continue
    t.clips.forEach((c, i) =>
      check(`音声トラック「${t.name}」の${i + 1}本目`, c.assetId, c.inPoint)
    )
  }
  return out
}

/** 区間ごとの書き出し(v2 のシーケンス)で、入点が素材の長さより後ろのクリップ */
export function sequenceItemsBeyondSource(
  project: Pick<ProjectV2, 'assets' | 'sequence'>
): ClipBeyondSource[] {
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const out: ClipBeyondSource[] = []
  const tracks = [
    ...project.sequence.videoTracks
      .map((t, i) => ({ t, name: i === 0 ? '本編' : `トラック「${t.name}」` }))
      .filter(({ t }) => !t.hidden)
      .map(({ t, name }) => ({ name, items: t.items })),
    ...project.sequence.audioTracks
      .filter((t) => !t.muted)
      .map((t) => ({ name: `音声トラック「${t.name}」`, items: t.items }))
  ]
  for (const t of tracks) {
    const media = t.items
      .filter(
        (i): i is Extract<(typeof t.items)[number], { assetId: string; sourceIn: number }> =>
          'assetId' in i && 'sourceIn' in i
      )
      .sort((a, b) => a.startFrame - b.startFrame)
    media.forEach((item, i) => {
      const a = assets.get(item.assetId)
      if (beyond(a, item.sourceIn))
        out.push({
          where: `${t.name}の${i + 1}本目`,
          fileName: a.fileName,
          inPoint: item.sourceIn,
          duration: a.duration
        })
    })
  }
  return out
}

/** 利用者に見せる文面(どのクリップか・何をすればよいか)。無ければ null */
export function clipsBeyondSourceMessage(list: readonly ClipBeyondSource[]): string | null {
  if (list.length === 0) return null
  const shown = list
    .slice(0, 3)
    .map(
      (c) =>
        `「${c.fileName}」(${c.where}): 入点 ${c.inPoint.toFixed(2)} 秒・素材の長さ ${c.duration.toFixed(2)} 秒`
    )
    .join('、')
  const more = list.length > 3 ? ` ほか ${list.length - 3} 本` : ''
  return (
    `入点が素材の長さより後ろにあるクリップがあります(${shown}${more})。` +
    '素材が短いものに差し替わった可能性があります。クリップの入点を素材の長さより前に直すか、' +
    'クリップを削除してから書き出してください'
  )
}
