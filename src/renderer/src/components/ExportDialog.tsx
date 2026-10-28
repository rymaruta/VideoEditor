import { useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { onProjectSwitch, useProjectStore } from '../store/projectStore'
import { usePresetStore } from '../store/presetStore'
import { useSettingsStore, type ExportLoudness, type VerticalFraming } from '../store/settingsStore'
import {
  framesOnFaces,
  prepareVerticalFill,
  verticalSampleKey,
  verticalSamples,
  withoutVerticalSplits,
  type VerticalSample
} from '../lib/verticalFraming'
import { cropObjectPosition } from '@shared/videoFrame'
import { useMenuCommand } from '../lib/menuCommands'
import { formatIpcError } from '../lib/ipcError'
import { formatTimecode, lengthClock } from '../lib/timelineRuler'
import { buildTimedClips, findTimedClipAt, totalExportDuration } from '../lib/timelineMath'
import { prepareTelopLayerForExport } from '../lib/telopRaster'
import type { EpisodeKind } from '@shared/structure/kind'
import { currentTimelineRange } from '../lib/timelineRange'
import { timelineAudioPieces, useWaveLevels } from '../lib/timelineWave'
import {
  DESTINATIONS,
  SHORT_MAX_SEC,
  jobFileName,
  type ExportJob,
  destinationSettings,
  matchDestination,
  sourceAspect,
  sourceHeight,
  type DestinationId,
  type DestinationSettings,
  exportBaseName,
  type ExportNameKind
} from '../lib/exportDestinations'
import { safeFileBaseName } from '@shared/fileName'
import { frameSeconds } from '@shared/frameRate'
import { targetResolution } from '@shared/resolution'
import { estimateOutputBytes, formatBytes } from '@shared/exportDiskSpace'
import type { TelopLayerPayload } from '@shared/telop/layer'
import {
  EXPORT_FORMAT_EXT,
  type AspectRatio,
  type ExportEngine,
  type ExportFormat,
  type Project,
  type QualityPreset,
  type ResolutionHeight
} from '@shared/types'
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  FolderIcon,
  PlayCircleIcon,
  TrashIcon,
  UploadIcon,
  XIcon
} from './icons'
import { ExportQcPanel } from './ExportQcPanel'
import { WaveBars } from './WaveBars'
import { reportBusy } from '../lib/busyReporter'
import { useQcStore } from '../store/qcStore'
import { usePipelineStore } from '../store/pipelineStore'
import { useReviewItems } from '../lib/useReviewItems'
import {
  premiereMediaNote,
  type PremiereExportResult,
  type PremiereTelopMode
} from '@shared/export/premiereTypes'

/**
 * 書き出し(ファイル > 書き出し… / Ctrl+M / 上の帯の「書き出す」)。デザイン案の「書き出し」ダイアログ。
 *
 * 左に行き先(YouTube・ショート・保存用・音声のみ・Premiere 用 XML と、保存した設定)、
 * 右にファイル名・保存先・範囲と、映像・音声・書き出しの後の設定、下に見本と要約。
 * 行き先は今ある書き出しの設定(解像度・画質・音量・形式・縦横比)を並べ替えるだけ(`exportDestinations`)。
 * 選んだ行き先で使えない欄は、無効の見た目にする。設定は次回も覚えておく。
 *
 * 閉じても書き出しは止まらない(このコンポーネントは常に置いておき、見せ方だけを切り替える)。
 * 書き出し中に開き直せば、進み具合がそのまま見える。
 */

interface QueueJob extends ExportJob {
  id: string
  /** 加えたときの本編(範囲のジョブは、本編が変わると違う所を指す) */
  clipsAtAdd: Project['clips']
}

type JobStatus = 'pending' | 'running' | 'done' | 'error'

/** Premiere 用 XML のテロップの渡し方(文字は必ずマーカーと SRT で渡す) */
const PREMIERE_TELOP_CHOICES: [PremiereTelopMode, string, string][] = [
  [
    'text',
    '文字だけ(マーカー+SRT)',
    'テロップの文字をシーケンスのマーカーのコメントと、同じ名前の .srt に書きます。Premiere で打ち直す・キャプションにする場合に'
  ],
  [
    'png',
    '見た目どおり: 透過 PNG',
    '画面と同じ描画のテロップを透過 PNG にして、一番上の映像トラックに並べます(「名前_telop」フォルダ)'
  ],
  [
    'prores',
    '見た目どおり: ProRes 4444(透過)',
    '画面と同じ描画のテロップを透過付きの動画 1 本にして、一番上の映像トラックに置きます。長尺ではファイルが大きくなります'
  ]
]

/** 29.97 / 59.94(ドロップフレームを選べるレート) */
function isDropFrameRate(fps: number): boolean {
  return [30, 60].some((tb) => Math.abs(fps - (tb * 1000) / 1001) < 0.005)
}

const QUALITY_LABEL: Record<QualityPreset, string> = {
  high: '高画質',
  standard: '標準',
  small: '軽量'
}

const RESOLUTION_NAME: Record<ResolutionHeight, string> = {
  2160: '4K',
  1440: '2K',
  1080: 'フルHD',
  720: 'HD',
  480: 'SD'
}

const RESOLUTIONS: ResolutionHeight[] = [2160, 1440, 1080, 720, 480]

const LOUDNESS_LABEL: Record<ExportLoudness, string> = {
  web: '−14 LUFS(YouTube 推奨)',
  broadcast: '−24 LKFS(放送 ARIB TR-B32)',
  off: '調整しない'
}

const MISSING_ASSET_MESSAGE =
  '見つからない素材ファイルがタイムラインで使われています。プロジェクトの素材一覧で再リンクしてから書き出してください。'

/** キューの1件の見出し */
function jobLabel(job: QueueJob, fps: number): string {
  const range = job.range
    ? ` · 範囲 ${formatTimecode(job.range.start, fps)} – ${formatTimecode(job.range.end, fps)}`
    : ''
  if (job.format === 'wav') return `音声のみ(WAV)${range}`
  return `${job.aspectRatio} · ${job.resolutionHeight}p · ${job.format === 'prores' ? 'ProRes 422' : QUALITY_LABEL[job.quality]}${range}`
}

/** 範囲に掛かるテロップだけを残した企画(範囲の書き出しのテロップの層を描く元。繋ぎのぶん前後に余白) */
function telopsNear(project: Project, range: { start: number; end: number }): Project {
  const margin = 1 + Math.max(0, ...project.clips.map((c) => c.transitionIn?.duration ?? 0))
  return {
    ...project,
    textOverlays: project.textOverlays.filter(
      (o) => o.endTime > range.start - margin && o.startTime < range.end + margin
    )
  }
}

/** 今の時刻(秒)。書き出しにかかった時間を測る */
function nowSeconds(): number {
  return Date.now() / 1000
}

function displayFps(fps: number): string {
  // 29.97 / 59.94 などは小数2桁、整数のレートはそのまま
  return Math.abs(fps - Math.round(fps)) < 0.005 ? String(Math.round(fps)) : fps.toFixed(2)
}

/** 数とその単位(「460」「MB」)に分ける(要約の欄は数を等幅で出す) */
function splitBytes(bytes: number): [string, string] {
  const t = formatBytes(bytes)
  const i = t.lastIndexOf(' ')
  return i > 0 ? [t.slice(0, i), t.slice(i)] : [t, '']
}

/** 推定時間を「2 分」「10 秒」の形で(数と単位) */
function splitDuration(sec: number): [string, string] {
  if (sec < 60) return [String(Math.max(1, Math.round(sec))), ' 秒']
  if (sec < 3600) return [String(Math.round(sec / 60)), ' 分']
  return [(sec / 3600).toFixed(1), ' 時間']
}

/** パスのフォルダの部分(区切りは Windows・mac のどちらでも) */
function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : ''
}

/** 保存のダイアログの最初の場所(フォルダが決まっていればそこに名前を付けて) */
function defaultPathIn(folder: string, name: string): string {
  if (!folder) return name
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return folder.endsWith(sep) ? `${folder}${name}` : `${folder}${sep}${name}`
}

/** 先頭のコマの見本(その時刻の本編の素材の絵) */
const thumbCache = new Map<string, Promise<string>>()
function PreviewThumb({ project, at }: { project: Project; at: number }): React.JSX.Element {
  const tc = findTimedClipAt(buildTimedClips(project), at)
  const source = tc
    ? {
        filePath: tc.asset.filePath,
        at: tc.asset.still ? 0 : tc.clip.inPoint + Math.max(0, at - tc.start) * (tc.clip.speed || 1)
      }
    : null
  const key = source ? `${source.filePath}|${source.at.toFixed(1)}` : ''
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null)
  useEffect(() => {
    if (!source) return
    let alive = true
    let p = thumbCache.get(key)
    if (!p) {
      p = window.api.generateThumbnail(source.filePath, source.at)
      p.catch(() => thumbCache.delete(key))
      thumbCache.set(key, p)
    }
    p.then(
      (url) => alive && setShown({ key, url }),
      () => {}
    )
    return () => {
      alive = false
    }
    // source は key から決まる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return (
    <span className="ve-export-thumb">
      {shown && <img src={shown.url} alt="書き出しの先頭のコマ" draggable={false} />}
    </span>
  )
}

/**
 * 縦の書き出しの見本(範囲の頭・真ん中・終わり近くの3コマ)。書き出しと同じ決め方で切り出して見せる
 * (顔に寄せる・人が決めた切り抜き・黒帯)。前は見本を真ん中で切っていて、書き出しの絵と違っていた
 */
const verticalSampleCache = new Map<string, Promise<VerticalSample[]>>()
/** 覚えておく見本の数の上限(古いものから捨てる) */
const VERTICAL_SAMPLE_CACHE_MAX = 16
function rememberVerticalSamples(key: string, p: Promise<VerticalSample[]>): void {
  verticalSampleCache.set(key, p)
  while (verticalSampleCache.size > VERTICAL_SAMPLE_CACHE_MAX)
    verticalSampleCache.delete(verticalSampleCache.keys().next().value!)
}
function VerticalSampleThumbs({
  project,
  start,
  end,
  fill,
  twoPeople,
  findFaces
}: {
  project: Project
  start: number
  end: number
  fill: boolean
  twoPeople: boolean
  findFaces: boolean
}): React.JSX.Element {
  const times = useMemo(() => {
    const len = Math.max(0, end - start)
    return [start, start + len * 0.5, start + len * 0.9].map((t) => Math.min(t, end - 1e-3))
  }, [start, end])
  // 鍵には企画と、見本の時刻に掛かるクリップの中身(素材・区間・速さ・見え方)を入れる(別の企画・直した
  // クリップで前の見本を出さない)
  const key = verticalSampleKey(project, times, fill, findFaces, twoPeople)
  const [shown, setShown] = useState<{ key: string; list: (VerticalSample & { url: string })[] }>()
  useEffect(() => {
    let alive = true
    let p = verticalSampleCache.get(key)
    if (!p) {
      p = verticalSamples(project, times, fill, findFaces, undefined, twoPeople)
      p.catch(() => verticalSampleCache.delete(key))
      rememberVerticalSamples(key, p)
    } else {
      // 使ったものは新しい方へ(古いものから捨てる)
      verticalSampleCache.delete(key)
      verticalSampleCache.set(key, p)
    }
    p.then(async (samples) => {
      const list = await Promise.all(
        samples.map(async (x) => {
          const k = `${x.filePath}|${x.time.toFixed(1)}`
          let t = thumbCache.get(k)
          if (!t) {
            t = window.api.generateThumbnail(x.filePath, x.time)
            t.catch(() => thumbCache.delete(k))
            thumbCache.set(k, t)
          }
          return { ...x, url: await t }
        })
      )
      if (alive) setShown({ key, list })
    }).catch(() => {})
    return () => {
      alive = false
    }
    // project・times は key から決まる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return (
    <span className="ve-export-vertical-samples" title="書き出しと同じ切り出しの見本">
      {shown?.list.map((x) => {
        // 2人を上下に積む所は、書き出しと同じ2つの窓を上下に並べて見せる
        if (x.stack)
          return (
            <span
              key={x.at}
              className="ve-export-thumb ve-export-stack"
              title="2人を上下に分けて切り出します"
            >
              {[x.stack.top, x.stack.bottom].map((win, k) => (
                <span key={k} className="ve-export-stack-half">
                  <img
                    src={x.url}
                    alt={k === 0 ? '縦の画の見本(上の人)' : '縦の画の見本(下の人)'}
                    draggable={false}
                    style={{
                      position: 'absolute',
                      maxWidth: 'none',
                      width: `${100 / win.w}%`,
                      height: `${100 / win.h}%`,
                      left: `${(-win.x / win.w) * 100}%`,
                      top: `${(-win.y / win.h) * 100}%`
                    }}
                  />
                </span>
              ))}
            </span>
          )
        const pos = cropObjectPosition(x.sourceAspect, 9 / 16, x.center)
        return (
          <span key={x.at} className="ve-export-thumb">
            <img
              src={x.url}
              alt="縦の画の見本"
              draggable={false}
              style={
                x.fill
                  ? { objectFit: 'cover', objectPosition: `${pos.x * 100}% ${pos.y * 100}%` }
                  : { objectFit: 'contain' }
              }
            />
          </span>
        )
      })}
    </span>
  )
}

/** 見本(サムネイル + 波形。音声のみは波形だけ)と、開始・終了の時刻 */
function ExportPreview({
  project,
  start,
  end,
  audioOnly,
  vertical,
  fill,
  twoPeople,
  findFaces,
  fps
}: {
  project: Project
  start: number
  end: number
  audioOnly: boolean
  /** 縦(9:16)で書き出す: 見本も縦に切り出して見せる */
  vertical: boolean
  /** 縦の書き出しで枠を埋めて切り出す(見本も書き出しと同じ切り出しで見せる) */
  fill: boolean
  /** 2人が収まらないとき上下に積む・話す人へ切り替える(false は1人に寄せる) */
  twoPeople: boolean
  /** 顔を探して寄せる(ゲーム実況は真ん中) */
  findFaces: boolean
  fps: number
}): React.JSX.Element {
  const pieces = useMemo(() => timelineAudioPieces(project, start, end), [project, start, end])
  const levels = useWaveLevels(pieces, start, end, 64)
  return (
    <div className="ve-export-sample">
      <span
        className={`ve-export-sample-box ${audioOnly ? 'audio-only' : ''} ${vertical && !audioOnly ? 'vertical' : ''}`}
      >
        {!audioOnly &&
          (vertical ? (
            <VerticalSampleThumbs
              project={project}
              start={start}
              end={end}
              fill={fill}
              twoPeople={twoPeople}
              findFaces={findFaces}
            />
          ) : (
            <PreviewThumb project={project} at={start} />
          ))}
        {levels && (
          <WaveBars
            levels={levels}
            width={128}
            height={14}
            className={audioOnly ? 've-export-sample-wave tall' : 've-export-sample-wave'}
          />
        )}
      </span>
      <span className="ve-export-sample-time">
        開始 <span className="mono">{formatTimecode(start, fps)}</span>
      </span>
      <span className="ve-export-sample-time">
        終了 <span className="mono">{formatTimecode(end, fps)}</span>
      </span>
    </div>
  )
}

/** 切り替え(書き出しの後の点検・フォルダを開く) */
function Switch({
  id,
  label,
  on,
  disabled,
  onChange
}: {
  id: string
  label: string
  on: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  return (
    <div className="ve-export-switch-row">
      <span id={id}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={id}
        className="ve-switch"
        disabled={disabled}
        onClick={() => onChange(!on)}
      >
        <span className="ve-switch-knob" />
      </button>
    </div>
  )
}

/** 1行の欄(名前と、選ぶ欄か決まった値) */
function FieldRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ve-export-row">
      <span className="ve-export-row-label">{label}</span>
      {children}
    </div>
  )
}

/** 決まった値の欄(選べない。無効のときは無効の見た目) */
function Fixed({
  value,
  note = '固定',
  title
}: {
  value: string
  /** 右に添える字(「固定」「素材と同じ」) */
  note?: string
  title?: string
}): React.JSX.Element {
  return (
    <span className="ve-export-fixed" title={title}>
      <span className="ve-export-fixed-value">{value}</span>
      <span className="ve-export-fixed-note">{note}</span>
    </span>
  )
}

/** 選ぶ欄(枠と ▾ は選べる欄だけ。▾ はアプリの線のアイコン) */
function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  const { className, ...rest } = props
  return (
    <span className={`ve-select ${props.disabled ? 'disabled' : ''}`}>
      <select {...rest} className={`ve-export-field ve-select-input ${className ?? ''}`} />
      <ChevronDownIcon width={10} height={10} className="ve-select-chevron" />
    </span>
  )
}

/** 行き先のアイコン(案の線の絵) */
const DESTINATION_ICON: Record<DestinationId, string> = {
  youtube: 'M2 4.5h12v7H2zM6.75 6.25v3.5l3-1.75z',
  short: 'M5 1.5h6v13H5zM7 12.5h2',
  master: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M5.5 3.5v3M10.5 3.5v3',
  audio:
    'M6 12.5V4l7-1.5V11M6 12.5a1.75 1.75 0 11-3.5 0 1.75 1.75 0 013.5 0zM13 11a1.75 1.75 0 11-3.5 0 1.75 1.75 0 013.5 0z',
  xml: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5'
}

export function ExportDialog(): React.JSX.Element | null {
  const project = useProjectStore((s) => s.project)
  const missingAssetIds = useProjectStore((s) => s.missingAssetIds)
  // ソロ(モニター用)は書き出しに効かない。ソロ中だけ一言知らせる
  const soloOn = useProjectStore((s) =>
    s.soloTrackIds.some((id) => s.project.audioTracks.some((t) => t.id === id))
  )
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio)
  const timelineIn = useProjectStore((s) => s.timelineIn)
  const timelineOut = useProjectStore((s) => s.timelineOut)
  const dragRange = useProjectStore((s) => s.dragRange)
  const multiSelectedClipIds = useProjectStore((s) => s.multiSelectedClipIds)

  const resolutionHeight = useSettingsStore((s) => s.exportResolutionHeight)
  const setResolutionHeight = useSettingsStore((s) => s.setExportResolutionHeight)
  const quality = useSettingsStore((s) => s.exportQuality)
  const setQuality = useSettingsStore((s) => s.setExportQuality)
  const loudness = useSettingsStore((s) => s.exportLoudness)
  const setLoudness = useSettingsStore((s) => s.setExportLoudness)
  const engine = useSettingsStore((s) => s.exportEngine)
  const verticalFraming = useSettingsStore((s) => s.verticalFraming)
  const setVerticalFraming = useSettingsStore((s) => s.setVerticalFraming)
  const sceneKind = usePipelineStore((s) => s.sceneKind)
  const episodeKind = useSettingsStore((s) => s.episodeKind)
  /** 企画に番組の種類が無い(古い企画)ときの種類(自動のショートと同じ決め方) */
  const kindFallback = (): EpisodeKind => sceneKind ?? episodeKind
  const setEngine = useSettingsStore((s) => s.setExportEngine)
  const openFolderAfter = useSettingsStore((s) => s.exportOpenFolderAfter)
  const setOpenFolderAfter = useSettingsStore((s) => s.setExportOpenFolderAfter)
  const format = useSettingsStore((s) => s.exportFormat)
  const setFormat = useSettingsStore((s) => s.setExportFormat)
  const xml = useSettingsStore((s) => s.exportXml)
  const setXml = useSettingsStore((s) => s.setExportXml)
  const folder = useSettingsStore((s) => s.exportFolder)
  const setFolder = useSettingsStore((s) => s.setExportFolder)
  const qcAfter = useSettingsStore((s) => s.exportQcAfter)
  const setQcAfter = useSettingsStore((s) => s.setExportQcAfter)
  const speeds = useSettingsStore((s) => s.exportSpeed)

  const exportPresets = usePresetStore((s) => s.exportPresets)
  const addExportPreset = usePresetStore((s) => s.addExportPreset)
  const removeExportPreset = usePresetStore((s) => s.removeExportPreset)

  const [open, setOpen] = useState(false)
  const [encoder, setEncoder] = useState<'libx264' | 'h264_nvenc' | null>(null)
  const [running, setRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState<{ percent: number; stage: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [donePath, setDonePath] = useState<string | null>(null)
  const [presetName, setPresetName] = useState<string | null>(null)
  const [presetError, setPresetError] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueJob[]>([])
  const [queueStatus, setQueueStatus] = useState<Record<string, JobStatus>>({})
  const [premiereTelop, setPremiereTelop] = useState<PremiereTelopMode>('text')
  const [premiereDropFrame, setPremiereDropFrame] = useState(true)
  const [premiereReviews, setPremiereReviews] = useState(true)
  const [premiereTelopMarkers, setPremiereTelopMarkers] = useState(true)
  const [premiereDone, setPremiereDone] = useState<PremiereExportResult | null>(null)
  /**
   * 手で書いたファイル名(拡張子なし)。動画・音声と Premiere 用 XML で別々に覚える(`exportBaseName`)。
   * 開くたびに企画の名前から作る(無いものは企画の名前のまま)
   */
  const [typedNames, setTypedNames] = useState<Partial<Record<ExportNameKind, string>>>({})
  const [rangeMode, setRangeMode] = useState<'all' | 'range'>('all')
  const [diskFree, setDiskFree] = useState<{ folder: string; bytes: number | null } | null>(null)
  const reviewLists = useReviewItems()

  useMenuCommand((id) => {
    if (id === 'file.export') {
      setTypedNames({})
      setOpen(true)
    }
  })

  // 前のプロジェクトの「書き出しが完了しました」・失敗・待ち行列を、別のプロジェクトに出さない
  // (完了の再生・フォルダを表示が、前のプロジェクトのファイルを開いていた)。書き出し中は残す
  useEffect(() => {
    if (running) return
    return onProjectSwitch(() => {
      setError(null)
      setDonePath(null)
      setPremiereDone(null)
      setProgress(null)
      setQueue([])
      setQueueStatus({})
      setTypedNames({})
      setRangeMode('all')
    })
  }, [running])

  useEffect(() => window.api.onExportProgress((p) => setProgress(p)), [])
  // 書き出しの最中は、PC をスリープさせず、タスクバーに進み具合を出す
  useEffect(() => {
    reportBusy('export', running ? { label: '書き出し', percent: progress?.percent } : null)
  }, [running, progress?.percent])
  useEffect(() => () => reportBusy('export', null), [])

  // GPU が使えるかは開いたときに1回だけ調べる(main 側も結果を覚えている)
  useEffect(() => {
    if (!open || encoder) return
    let alive = true
    window.api.detectExportEncoder().then(
      (e) => alive && setEncoder(e),
      () => alive && setEncoder('libx264')
    )
    return () => {
      alive = false
    }
  }, [open, encoder])

  // 保存先のドライブの空き(開いたとき・保存先を変えたとき)
  useEffect(() => {
    if (!open || !folder) return
    let alive = true
    window.api.exportDiskFree(folder).then(
      (bytes) => alive && setDiskFree({ folder, bytes }),
      () => alive && setDiskFree({ folder, bytes: null })
    )
    return () => {
      alive = false
    }
  }, [open, folder, running])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setOpen(false)
      // 下にある画面(自動編集の画面・大きく表示したプレビュー)まで一緒に閉じない
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const timedClips = useMemo(() => buildTimedClips(project), [project])
  const totalDuration = totalExportDuration(timedClips)
  const fps = 1 / frameSeconds(project.clips, project.assets)
  const usesMissingAsset = useMemo(() => {
    if (missingAssetIds.length === 0) return false
    const missing = new Set(missingAssetIds)
    return (
      project.clips.some((c) => missing.has(c.assetId)) ||
      project.audioTracks.some((t) => t.clips.some((c) => missing.has(c.assetId))) ||
      project.videoOverlayTracks.some((t) => t.clips.some((c) => missing.has(c.assetId)))
    )
  }, [project, missingAssetIds])

  if (!open) return null

  const { w, h } = targetResolution(project.aspectRatio, resolutionHeight)
  const selection = currentTimelineRange({
    timelineIn,
    timelineOut,
    dragRange,
    multiSelectedClipIds,
    project
  })?.range
  const useRange = rangeMode === 'range' && selection !== undefined && !xml
  const span = useRange && selection ? selection : { start: 0, end: totalDuration }
  const duration = Math.max(0, span.end - span.start)
  const ext = xml ? 'xml' : EXPORT_FORMAT_EXT[format]
  const baseName = exportBaseName(typedNames, xml, project.name)
  const srcH = sourceHeight(project.assets)
  const srcAspect = sourceAspect(project.assets, project.aspectRatio)
  const current: DestinationSettings = {
    aspectRatio: project.aspectRatio,
    resolutionHeight,
    quality,
    loudness,
    format,
    xml
  }
  const picked = matchDestination(current, srcH, srcAspect)
  const videoOff = xml || format === 'wav'
  const audioOff = xml
  const estBytes = xml
    ? null
    : estimateOutputBytes({ durationSec: duration, width: w, height: h, fps, quality, format })
  const speed = speeds[format]
  const estSec = xml || !speed ? null : duration / speed
  const free = folder && diskFree?.folder === folder ? diskFree.bytes : null
  const segmentedOnly = useRange || format !== 'mp4'
  // ショート(縦・1080)で 60 秒を超えるときは書き出さない(範囲を選べば書き出せる)
  const shortOver = picked === 'short' && duration > SHORT_MAX_SEC
  const encoderName =
    encoder === null ? '確認中…' : encoder === 'h264_nvenc' ? 'GPU(NVENC)' : 'CPU(x264)'
  const telopCount = project.textOverlays.length

  /** 行き先を選ぶ(今ある設定を、その行き先の組み合わせにする) */
  function pickDestination(id: DestinationId): void {
    const next = destinationSettings(id, current, srcH, srcAspect)
    if (next.aspectRatio !== project.aspectRatio) setAspectRatio(next.aspectRatio)
    if (next.resolutionHeight !== resolutionHeight) setResolutionHeight(next.resolutionHeight)
    if (next.quality !== quality) setQuality(next.quality)
    if (next.loudness !== loudness) setLoudness(next.loudness)
    if (next.format !== format) setFormat(next.format)
    if (next.xml !== xml) setXml(next.xml)
  }

  /** 書き出し前の確認。問題があれば理由を返す */
  function blocker(): string | null {
    if (project.clips.length === 0) return 'タイムラインにクリップがありません'
    if (usesMissingAsset) return MISSING_ASSET_MESSAGE
    return null
  }

  async function telopLayerFor(
    aspect: AspectRatio,
    height: ResolutionHeight,
    source: Project = project
  ): Promise<TelopLayerPayload | null> {
    // テロップは書き出し方式によらず、画面と同じ描画関数で先に画像にしておく
    // (見えているとおりに書き出すため。main は画像を時刻どおりに重ねるだけ)
    return prepareTelopLayerForExport(
      source,
      aspect,
      height,
      (done, total) => setProgress({ percent: 0, stage: `テロップを描画中(${done}/${total})` }),
      abortRef.current?.signal
    )
  }

  /** 書き出しの中止。テロップの描画中(main の書き出しが始まる前)にも効くよう、こちらでも覚える */
  function cancelExport(): void {
    abortRef.current?.abort()
    void window.api.cancelExport()
  }

  async function runOne(
    job: ExportJob,
    outputPath: string
  ): Promise<{ success: boolean; rangeStartSec?: number; exported: Project }> {
    setProgress({ percent: 0, stage: '準備中' })
    // 前の書き出しの確認がまだ動いていれば止める(結果を捨てる確認が、この書き出しと CPU を取り合う)
    await useQcStore.getState().stopForExport()
    // 縦(9:16)で書き出すときは、既定で横長の絵を人物に寄せて縦いっぱいに切り出す(書き出し用の写しだけ。
    // 企画のクリップは変えない)。設定で「上下に黒帯」を選べば、今までどおり縮めて収める
    // ゲーム実況(企画の種類)はゲーム画面なので顔は探さず、真ん中で埋める(今までどおり)。顔探しは素材ごとの
    // 代表の画だけで、進み具合を出し、中止も効く
    // 上下に積む形・話す人で分けたクリップ(自動のショートで保存した企画に残る)は、縦で「人物に寄せる
    // (2人は上下・話す人)」を選んだときだけ使う。ほかの選択・横の書き出しでは元の形に戻す
    let source =
      job.aspectRatio === '9:16' && verticalFraming === 'fill'
        ? project
        : withoutVerticalSplits(project)
    if (job.aspectRatio === '9:16' && job.format !== 'wav' && verticalFraming !== 'letterbox') {
      const findFaces = framesOnFaces(project, kindFallback())
      setProgress({ percent: 0, stage: findFaces ? '人物の位置を探しています' : '準備中' })
      const fill = await prepareVerticalFill(source, {
        findFaces,
        // 2人が縦の枠に収まらないとき: 上下に積む・話している人へ切り替える(「1人に寄せる」なら前の形)
        twoPeople: verticalFraming === 'fill',
        ...(job.range ? { range: job.range } : {}),
        signal: abortRef.current?.signal,
        onProgress: (done, total) =>
          setProgress({
            percent: total > 0 ? Math.round((done / total) * 100) : 0,
            stage: `人物の位置を探しています(${done}/${total})`
          })
      })
      source = fill.project
    }
    // 音声だけのときは絵が無いので、テロップは描かない。範囲だけのときは、その範囲(繋ぎのぶん広がる)に
    // 掛かるテロップだけを描く(全部を描くと長尺で時間と一時ファイルが無駄になる)
    const telopLayer =
      job.format === 'wav'
        ? null
        : await telopLayerFor(
            job.aspectRatio,
            job.resolutionHeight,
            job.range ? telopsNear(source, job.range) : source
          )
    try {
      // 描画のあいだに中止を押されていたら、書き出しを始めない(main 側の中止は、始まる前だと効かない)
      if (abortRef.current?.signal.aborted) throw new Error('EXPORT_CANCELED')
      const result = await window.api.exportProject({
        project: source,
        aspectRatio: job.aspectRatio,
        resolutionHeight: job.resolutionHeight,
        quality: job.quality,
        outputPath,
        loudnessNormalization: loudness !== 'off',
        loudnessTarget: loudness === 'off' ? undefined : loudness,
        engine,
        telopLayer,
        format: job.format,
        ...(job.range ? { range: job.range } : {})
      })
      return { ...result, exported: source }
    } finally {
      // 層の画像(main の一時フォルダ。長尺の 4K で数 GB)は、書き出しに渡らなかったときもここで片付ける
      // (書き出しに渡ったぶんは main が終わりに片付けている。2回目は何もしない)
      if (telopLayer?.stagedId)
        void window.api.telopLayer.release(telopLayer.stagedId).catch(() => {})
    }
  }

  async function handleExport(): Promise<void> {
    abortRef.current = new AbortController()
    setError(null)
    setDonePath(null)
    const reason = blocker()
    if (reason) {
      setError(reason)
      return
    }
    const job: ExportJob = {
      aspectRatio: project.aspectRatio,
      resolutionHeight,
      quality,
      format,
      ...(useRange && selection ? { range: { start: selection.start, end: selection.end } } : {})
    }
    const outputPath = await window.api.selectExportPath(
      defaultPathIn(folder, `${safeFileBaseName(baseName)}.${ext}`),
      format
    )
    if (!outputPath) return
    const chosenFolder = folderOf(outputPath)
    if (chosenFolder && chosenFolder !== folder) setFolder(chosenFolder)
    setRunning(true)
    const session = useProjectStore.getState().projectSession
    const began = nowSeconds()
    try {
      const result = await runOne(job, outputPath)
      const elapsed = nowSeconds() - began
      if (elapsed > 0.5) useSettingsStore.getState().recordExportSpeed(format, duration / elapsed)
      // 書き出している間に別のプロジェクトを開いたなら、結果・確認はそのプロジェクトに出さない
      // (前のプロジェクトのファイルを出し、確認の項目を押すと今のプロジェクトの別の時刻へ飛んでいた)。
      // 企画の id では写し・開き直した同じファイルを見分けられないので、開いた番号で見る
      const sameProject = useProjectStore.getState().projectSession === session
      if (sameProject) setDonePath(outputPath)
      window.api.notifyDone('書き出しが終わりました', outputPath)
      // 書き出した動画をそのまま点検する(黒味・フリーズ・無音・ラウドネス・テロップ)
      if (sameProject && qcAfter)
        void useQcStore.getState().run(
          outputPath,
          loudness,
          // 書き出した写し(縦の切り出しで発言テロップの位置を変えたもの)で確かめる
          result.exported,
          job.range && result.rangeStartSec !== undefined
            ? { ...job.range, exportStart: result.rangeStartSec }
            : undefined
        )
      if (openFolderAfter) await window.api.showItemInFolder(outputPath).catch(() => {})
    } catch (e) {
      const message = formatIpcError(e)
      if (message !== 'EXPORT_CANCELED') {
        setError(message)
        window.api.notifyDone('書き出しに失敗しました', message)
      }
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  /** Premiere 用 XML(FCP7 xmeml)と SRT・(選べば)見た目どおりのテロップを書き出す */
  async function handlePremiereExport(): Promise<void> {
    abortRef.current = new AbortController()
    setError(null)
    setDonePath(null)
    setPremiereDone(null)
    const reason = blocker()
    if (reason) {
      setError(reason)
      return
    }
    const outputPath = await window.api.selectPremiereXmlPath(
      defaultPathIn(folder, `${safeFileBaseName(baseName)}.xml`)
    )
    if (!outputPath) return
    const chosenFolder = folderOf(outputPath)
    if (chosenFolder && chosenFolder !== folder) setFolder(chosenFolder)
    setRunning(true)
    setProgress({ percent: 0, stage: '準備中' })
    const session = useProjectStore.getState().projectSession
    let telopLayer: TelopLayerPayload | null = null
    try {
      // 見た目どおりのテロップは、動画の書き出しと同じ描画(画面と同じ関数)で先に画像にする
      if (premiereTelop !== 'text')
        telopLayer = await telopLayerFor(project.aspectRatio, resolutionHeight)
      if (abortRef.current?.signal.aborted) throw new Error('EXPORT_CANCELED')
      const result = await window.api.exportPremiereXml({
        project,
        aspectRatio: project.aspectRatio,
        resolutionHeight,
        outputPath,
        dropFrame: premiereDropFrame,
        telopMode: premiereTelop,
        telopMarkers: premiereTelopMarkers,
        reviews: premiereReviews
          ? reviewLists.open.map((r) => ({
              key: r.key,
              kind: r.kind,
              text: r.text,
              ...(r.at !== undefined ? { at: r.at } : {}),
              ...(r.overlayId ? { overlayId: r.overlayId } : {})
            }))
          : [],
        telopLayer
      })
      if (useProjectStore.getState().projectSession === session) setPremiereDone(result)
      window.api.notifyDone('Premiere 用 XML を書き出しました', outputPath)
      if (openFolderAfter) await window.api.showItemInFolder(outputPath).catch(() => {})
    } catch (e) {
      const message = formatIpcError(e)
      if (message !== 'EXPORT_CANCELED') {
        setError(message)
        window.api.notifyDone('Premiere 用 XML の書き出しに失敗しました', message)
      }
    } finally {
      // 層の画像は main が使い終わりに片付ける。渡らなかったときもここで片付ける(2回目は何もしない)
      if (telopLayer?.stagedId)
        void window.api.telopLayer.release(telopLayer.stagedId).catch(() => {})
      setRunning(false)
      setProgress(null)
    }
  }

  async function handleRunQueue(): Promise<void> {
    abortRef.current = new AbortController()
    setError(null)
    setDonePath(null)
    const reason = blocker()
    if (reason) {
      setError(reason)
      return
    }
    // 範囲のジョブは時刻で覚えている。加えた後で本編が変わったなら、違う所を書き出すかもしれない
    const moved = queue.filter((j) => j.range && j.clipsAtAdd !== project.clips)
    if (
      moved.length > 0 &&
      !confirm(
        `範囲を書き出すジョブ ${moved.length} 件は、キューに加えた後で本編が変わりました。範囲の時刻は加えたときのままなので、違う所を書き出すことがあります。続けますか`
      )
    )
      return
    const target = await window.api.selectExportFolder()
    if (!target) return
    setRunning(true)
    setQueueStatus(Object.fromEntries(queue.map((j) => [j.id, 'pending' as JobStatus])))
    let lastPath: string | null = null
    let doneCount = 0
    let failedCount = 0
    let canceledCount = 0
    for (const [index, job] of queue.entries()) {
      setQueueStatus((prev) => ({ ...prev, [job.id]: 'running' }))
      try {
        const path = `${target}/${jobFileName(project.name, job)}`
        await runOne(job, path)
        // 書き出せたものだけ覚える(最後の1件が失敗・中止だと、無いファイルを開こうとして
        // フォルダが開かなかった)
        lastPath = path
        setQueueStatus((prev) => ({ ...prev, [job.id]: 'done' }))
        doneCount++
      } catch (e) {
        const message = formatIpcError(e)
        if (message === 'EXPORT_CANCELED') {
          setQueueStatus((prev) => ({ ...prev, [job.id]: 'pending' }))
          // 中止したぶんと、まだ始めていないぶん
          canceledCount = queue.length - index
          break
        }
        setQueueStatus((prev) => ({ ...prev, [job.id]: 'error' }))
        setError(message)
        failedCount++
      }
    }
    setRunning(false)
    setProgress(null)
    // 失敗・中止があっても「終わりました」だけだと、離れていた人は全部できたと思い込む
    const summary =
      failedCount === 0 && canceledCount === 0
        ? 'まとめての書き出しが終わりました'
        : [
            `まとめての書き出し: ${doneCount}件完了`,
            failedCount > 0 ? `${failedCount}件失敗` : '',
            canceledCount > 0 ? `${canceledCount}件中止` : ''
          ]
            .filter(Boolean)
            .join('・')
    window.api.notifyDone(summary, target)
    if (lastPath && openFolderAfter) await window.api.showItemInFolder(lastPath).catch(() => {})
  }

  function addToQueue(): void {
    const job: QueueJob = {
      id: uuid(),
      clipsAtAdd: project.clips,
      aspectRatio: project.aspectRatio,
      resolutionHeight,
      quality,
      format,
      ...(useRange && selection ? { range: { start: selection.start, end: selection.end } } : {})
    }
    // 同じ名前になるものは並べない(後のジョブが先のファイルを上書きするため)
    const name = jobFileName(project.name, job)
    if (queue.some((j) => jobFileName(project.name, j) === name)) {
      setError('同じ組み合わせがすでにキューにあります(同じファイル名になり上書きされるため)')
      return
    }
    setError(null)
    setQueue((prev) => [...prev, job])
  }

  function applyPreset(id: string): void {
    const preset = exportPresets.find((p) => p.id === id)
    if (!preset) return
    setResolutionHeight(preset.resolutionHeight)
    setQuality(preset.quality)
    // 保存した設定は MP4 の組み合わせ(形式を持たない)
    setFormat('mp4')
    setXml(false)
    // 古いプリセットは「正規化する/しない」しか持たないので、するなら今の基準を保つ
    setLoudness(preset.loudnessNormalization ? (loudness === 'off' ? 'web' : loudness) : 'off')
  }

  function savePreset(): void {
    const ok = addExportPreset(presetName ?? '', {
      resolutionHeight,
      quality,
      loudnessNormalization: loudness !== 'off'
    })
    if (!ok) {
      setPresetError(
        (presetName ?? '').trim()
          ? 'その名前のプリセットはすでにあります'
          : '名前を入力してください'
      )
      return
    }
    setPresetError(null)
    setPresetName(null)
  }

  const matchingPreset =
    !xml && format === 'mp4'
      ? exportPresets.find(
          (p) =>
            p.resolutionHeight === resolutionHeight &&
            p.quality === quality &&
            p.loudnessNormalization === (loudness !== 'off')
        )
      : undefined

  const resolutionSelect = (
    <Select
      aria-label="解像度"
      value={`${project.aspectRatio}|${resolutionHeight}`}
      disabled={running || (videoOff && !xml)}
      onChange={(e) => {
        const [aspect, height] = e.target.value.split('|')
        if (aspect !== project.aspectRatio) setAspectRatio(aspect as AspectRatio)
        setResolutionHeight(Number(height) as ResolutionHeight)
      }}
    >
      {(['16:9', '9:16'] as AspectRatio[]).map((aspect) => (
        <optgroup key={aspect} label={aspect === '9:16' ? '縦(9:16)' : '横(16:9)'}>
          {RESOLUTIONS.map((r) => {
            const size = targetResolution(aspect, r)
            return (
              <option key={r} value={`${aspect}|${r}`}>
                {size.w} × {size.h}({RESOLUTION_NAME[r]}
                {aspect === '9:16' ? '・縦' : ''})
              </option>
            )
          })}
        </optgroup>
      ))}
    </Select>
  )

  return (
    <div className="modal-backdrop" onMouseDown={() => !running && setOpen(false)}>
      <div
        className="ve-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ve-export-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ve-export-head">
          <span id="ve-export-title" className="ve-export-title">
            書き出し
          </span>
          <button
            type="button"
            className="ve-export-close"
            aria-label="閉じる"
            title={running ? '閉じても書き出しは続きます' : '閉じる(Esc)'}
            onClick={() => setOpen(false)}
          >
            <XIcon width={14} height={14} />
          </button>
        </div>

        <div className="ve-export-body">
          <nav className="ve-export-nav" aria-label="行き先">
            <span className="ve-export-section">行き先</span>
            {DESTINATIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`ve-export-dest ${picked === d.id ? 'on' : ''}`}
                aria-pressed={picked === d.id}
                disabled={running}
                onClick={() => pickDestination(d.id)}
              >
                <span className="ve-export-dest-icon">
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path d={DESTINATION_ICON[d.id]} />
                  </svg>
                </span>
                <span className="ve-export-dest-text">
                  <span className="ve-export-dest-name">{d.name}</span>
                  <span className="ve-export-dest-sub">{d.sub}</span>
                </span>
              </button>
            ))}
            <span className="ve-export-section ve-export-section-gap">保存した設定</span>
            {exportPresets.length === 0 && (
              <span className="ve-export-nav-note">
                今の解像度・画質・音量の組み合わせに名前を付けて残せます(MP4)
              </span>
            )}
            {exportPresets.map((p) => (
              <div key={p.id} className="ve-export-preset">
                <button
                  type="button"
                  className={`ve-export-dest ${matchingPreset?.id === p.id ? 'on' : ''}`}
                  aria-pressed={matchingPreset?.id === p.id}
                  disabled={running}
                  onClick={() => applyPreset(p.id)}
                >
                  <span className="ve-export-dest-text">
                    <span className="ve-export-dest-name">{p.name}</span>
                    <span className="ve-export-dest-sub">
                      {p.resolutionHeight}p · {QUALITY_LABEL[p.quality]} ·{' '}
                      {p.loudnessNormalization ? '音量を合わせる' : '音量はそのまま'}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  title="この設定を削除"
                  aria-label={`${p.name} を削除`}
                  onClick={() => removeExportPreset(p.id)}
                >
                  <TrashIcon width={12} height={12} />
                </button>
              </div>
            ))}
            {presetName === null ? (
              <button
                type="button"
                className="small-button ve-export-save-preset"
                disabled={running || xml || format !== 'mp4'}
                title={
                  xml || format !== 'mp4'
                    ? '保存できるのは MP4 の組み合わせです'
                    : '今の解像度・画質・音量に名前を付けて残します'
                }
                onClick={() => setPresetName('')}
              >
                今の設定を保存…
              </button>
            ) : (
              <div className="ve-export-preset-form">
                <input
                  type="text"
                  autoFocus
                  aria-label="設定の名前"
                  placeholder="名前(例: YouTube 1080p)"
                  value={presetName}
                  onChange={(e) => {
                    setPresetName(e.target.value)
                    setPresetError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePreset()
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setPresetName(null)
                    }
                  }}
                />
                <div className="ve-export-preset-actions">
                  <button type="button" className="small-button" onClick={savePreset}>
                    保存
                  </button>
                  <button
                    type="button"
                    className="small-button"
                    onClick={() => setPresetName(null)}
                  >
                    やめる
                  </button>
                </div>
                {presetError && <span className="error-text">{presetError}</span>}
              </div>
            )}
            {queue.length > 0 && (
              <div className="ve-export-queue" aria-label="キュー">
                <div className="ve-export-queue-head">
                  <span>キュー({queue.length})</span>
                  <button
                    className="small-button"
                    disabled={running}
                    onClick={handleRunQueue}
                    title="キューの組み合わせを、選んだフォルダへ順に書き出します"
                  >
                    キューを書き出す…
                  </button>
                </div>
                <ul>
                  {queue.map((job) => (
                    <li key={job.id} className={`export-queue-item ${queueStatus[job.id] ?? ''}`}>
                      <span>{jobLabel(job, fps)}</span>
                      <span className="export-queue-status">
                        {
                          {
                            pending: '待機',
                            running: '書き出し中',
                            done: '完了',
                            error: '失敗'
                          }[queueStatus[job.id] ?? 'pending']
                        }
                      </span>
                      <button
                        className="icon-button danger"
                        title="キューから外す"
                        aria-label="キューから外す"
                        disabled={running}
                        onClick={() => setQueue((prev) => prev.filter((j) => j.id !== job.id))}
                      >
                        <TrashIcon width={12} height={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </nav>

          <div className="ve-export-main">
            <div className="ve-export-top">
              <label htmlFor="ve-export-name" className="ve-export-row-label">
                ファイル名
              </label>
              <div className="ve-export-field ve-export-name">
                <input
                  id="ve-export-name"
                  value={baseName}
                  disabled={running}
                  onChange={(e) => {
                    const value = e.target.value
                    setTypedNames((prev) => ({ ...prev, [xml ? 'xml' : 'media']: value }))
                  }}
                />
                <span className="mono ve-export-ext">.{ext}</span>
              </div>
              <span className="ve-export-row-label">保存先</span>
              <div className="ve-export-folder">
                <span
                  className={`ve-export-field fixed mono ${folder ? '' : 'empty'}`}
                  title={folder || undefined}
                >
                  {folder || '書き出すときに選びます'}
                </span>
                <button
                  type="button"
                  className="small-button"
                  disabled={running}
                  onClick={() =>
                    void window.api.selectExportFolder().then((f) => f && setFolder(f))
                  }
                >
                  参照…
                </button>
              </div>
              <span className="ve-export-row-label">範囲</span>
              <div className="ve-export-segmented" role="group" aria-label="範囲">
                <button
                  type="button"
                  aria-pressed={!useRange}
                  className={!useRange ? 'on' : ''}
                  disabled={running}
                  onClick={() => setRangeMode('all')}
                >
                  全体
                </button>
                <button
                  type="button"
                  aria-pressed={useRange}
                  className={useRange ? 'on' : ''}
                  disabled={running || !selection || xml}
                  title={
                    xml
                      ? 'Premiere 用 XML は全体だけです'
                      : selection
                        ? undefined
                        : 'タイムラインでイン点・アウト点を打つか、範囲を選ぶと選べます'
                  }
                  onClick={() => setRangeMode('range')}
                >
                  選んだ範囲{' '}
                  <span className="mono">
                    {selection
                      ? `${formatTimecode(selection.start, fps)} – ${formatTimecode(selection.end, fps)}`
                      : 'なし'}
                  </span>
                </button>
              </div>
            </div>

            <div className="ve-export-divider" />

            {xml ? (
              <div className="ve-export-columns">
                <div className="ve-export-col">
                  <span className="ve-export-section">シーケンス</span>
                  <FieldRow label="形式">
                    <Fixed value="FCP7 XML" title="Premiere の「読み込み」で開けます(xmeml v4)" />
                  </FieldRow>
                  <FieldRow label="解像度">{resolutionSelect}</FieldRow>
                  <FieldRow label="フレームレート">
                    <Fixed value={`${displayFps(fps)} fps`} note="素材と同じ" />
                  </FieldRow>
                  <FieldRow label="タイムコード">
                    {isDropFrameRate(fps) ? (
                      <Select
                        aria-label="タイムコード"
                        value={premiereDropFrame ? 'df' : 'ndf'}
                        disabled={running}
                        onChange={(e) => setPremiereDropFrame(e.target.value === 'df')}
                      >
                        <option value="df">ドロップフレーム(DF)</option>
                        <option value="ndf">ノンドロップ(NDF)</option>
                      </Select>
                    ) : (
                      <Fixed value="ノンドロップ(NDF)" />
                    )}
                  </FieldRow>
                  <FieldRow label="音声">
                    <Fixed value="48 kHz · ステレオ" />
                  </FieldRow>
                </div>
                <div className="ve-export-col">
                  <span className="ve-export-section">テロップ</span>
                  <FieldRow label="渡し方">
                    <Select
                      aria-label="テロップの渡し方"
                      value={premiereTelop}
                      disabled={running}
                      title={PREMIERE_TELOP_CHOICES.find(([v]) => v === premiereTelop)?.[2]}
                      onChange={(e) => setPremiereTelop(e.target.value as PremiereTelopMode)}
                    >
                      {PREMIERE_TELOP_CHOICES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </FieldRow>
                  <Switch
                    id="ve-export-telop-markers"
                    label="テロップの文字をマーカーにも入れる"
                    on={premiereTelopMarkers}
                    disabled={running}
                    onChange={setPremiereTelopMarkers}
                  />
                  <Switch
                    id="ve-export-review-markers"
                    label={`要確認をマーカーにする(${reviewLists.open.length} 件)`}
                    on={premiereReviews}
                    disabled={running}
                    onChange={setPremiereReviews}
                  />
                  <span className="ve-export-section ve-export-section-gap">書き出しの後</span>
                  <Switch
                    id="ve-export-open-folder"
                    label="終わったらフォルダを開く"
                    on={openFolderAfter}
                    onChange={setOpenFolderAfter}
                  />
                </div>
              </div>
            ) : (
              <div className="ve-export-columns">
                {format !== 'wav' && (
                  <div className="ve-export-col">
                    <span className="ve-export-section">映像</span>
                    <FieldRow label="コンテナ">
                      <Fixed
                        value={format === 'prores' ? 'QuickTime(.mov)' : 'MP4'}
                        title="コーデックで決まります"
                      />
                    </FieldRow>
                    <FieldRow label="コーデック">
                      <Select
                        aria-label="コーデック"
                        value={format === 'prores' ? 'prores' : 'mp4'}
                        disabled={running || videoOff}
                        onChange={(e) => setFormat(e.target.value as ExportFormat)}
                      >
                        <option value="mp4">H.264</option>
                        <option value="prores">Apple ProRes 422</option>
                      </Select>
                    </FieldRow>
                    <FieldRow label="解像度">{resolutionSelect}</FieldRow>
                    {project.aspectRatio === '9:16' && !videoOff && (
                      <FieldRow label="縦の画">
                        <Select
                          aria-label="縦の画"
                          value={verticalFraming}
                          disabled={running}
                          title="横長の素材を縦で書き出すときの収め方。人がクリップに決めた切り抜きはそのまま使います"
                          onChange={(e) => setVerticalFraming(e.target.value as VerticalFraming)}
                        >
                          <option value="fill">
                            画面いっぱいに切り出す(人物に寄せる。2人が離れていれば上下に分けるか、話す人へ切り替える。ゲーム実況は真ん中)
                          </option>
                          <option value="single">
                            画面いっぱいに切り出す(よく映る1人に寄せる)
                          </option>
                          <option value="letterbox">横の絵をそのまま(上下に黒帯)</option>
                        </Select>
                      </FieldRow>
                    )}
                    <FieldRow label="フレームレート">
                      <Fixed value={`${displayFps(fps)} fps`} note="素材と同じ" />
                    </FieldRow>
                    <FieldRow label="ビットレート">
                      {format === 'prores' ? (
                        <Fixed
                          value="ProRes 422"
                          title="ProRes は画質の段を選ばず、決まった画質で書き出します"
                        />
                      ) : (
                        <Select
                          aria-label="ビットレート"
                          value={quality}
                          disabled={running || videoOff}
                          onChange={(e) => setQuality(e.target.value as QualityPreset)}
                        >
                          <option value="high">VBR · 高画質</option>
                          <option value="standard">VBR · 標準</option>
                          <option value="small">VBR · 軽量(ファイルが小さい)</option>
                        </Select>
                      )}
                    </FieldRow>
                    <FieldRow label="エンコード">
                      {format === 'prores' ? (
                        <Fixed value="CPU(ProRes 422)" title="ProRes は CPU で書き出します" />
                      ) : (
                        <Select
                          aria-label="エンコード"
                          value={segmentedOnly ? 'segmented' : engine}
                          disabled={running || videoOff || segmentedOnly}
                          title={
                            segmentedOnly && !videoOff
                              ? '範囲だけの書き出しは、区間に分けて書き出す方式で作ります'
                              : undefined
                          }
                          onChange={(e) => setEngine(e.target.value as ExportEngine)}
                        >
                          <option value="segmented">
                            {/* 選べないときは、切れないよう短い名前だけを出す(理由は title) */}
                            {running || videoOff || segmentedOnly
                              ? encoderName
                              : `${encoderName} · 区間に分けて並列(長尺向け)`}
                          </option>
                          <option value="standard">CPU(x264)· 全体を1回で</option>
                        </Select>
                      )}
                    </FieldRow>
                    <FieldRow label="色空間">
                      <Fixed
                        value="Rec.709(SDR)"
                        title="HDR の素材も Rec.709 へ寄せて書き出します"
                      />
                    </FieldRow>
                  </div>
                )}
                <div className="ve-export-col">
                  <span className="ve-export-section">音声</span>
                  <FieldRow label="コーデック">
                    <Fixed value={format === 'mp4' ? 'AAC · 192 kbps' : 'PCM · 24 bit'} />
                  </FieldRow>
                  <FieldRow label="ラウドネス">
                    <Select
                      aria-label="ラウドネス"
                      value={loudness}
                      disabled={running || audioOff}
                      title="全体を一度測ってから、狙いの音量へ一定の量で上げ下げします(2パス)。音の強弱の幅はそのまま残ります"
                      onChange={(e) => setLoudness(e.target.value as ExportLoudness)}
                    >
                      {(['web', 'broadcast', 'off'] as ExportLoudness[]).map((v) => (
                        <option key={v} value={v}>
                          {LOUDNESS_LABEL[v]}
                        </option>
                      ))}
                    </Select>
                  </FieldRow>
                  <FieldRow label="チャンネル">
                    <Fixed value="ステレオ · 48 kHz" />
                  </FieldRow>
                  <span className="ve-export-section ve-export-section-gap">書き出しの後</span>
                  <Switch
                    id="ve-export-qc"
                    label={
                      format === 'wav' ? '音量と音の乱れを点検する' : '音量と映像の乱れを点検する'
                    }
                    on={qcAfter}
                    onChange={setQcAfter}
                  />
                  <Switch
                    id="ve-export-open-folder"
                    label="終わったらフォルダを開く"
                    on={openFolderAfter}
                    onChange={setOpenFolderAfter}
                  />
                </div>
              </div>
            )}

            <div className="ve-export-status">
              {(running || progress) && (
                <div className="export-dialog-progress">
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${progress?.percent ?? 0}%` }}
                    />
                    <span>
                      {progress?.stage ?? '準備中'} {Math.round(progress?.percent ?? 0)}%
                    </span>
                  </div>
                </div>
              )}
              {donePath && (
                <div className="export-done">
                  <p className="success-text" title={donePath}>
                    書き出しが完了しました
                  </p>
                  <div className="export-done-actions">
                    <button
                      className="small-button"
                      onClick={() =>
                        window.api.openPath(donePath).catch((e) => setError(formatIpcError(e)))
                      }
                    >
                      <PlayCircleIcon width={14} height={14} />
                      再生
                    </button>
                    <button
                      className="small-button"
                      onClick={() =>
                        window.api
                          .showItemInFolder(donePath)
                          .catch((e) => setError(formatIpcError(e)))
                      }
                    >
                      <FolderIcon width={14} height={14} />
                      フォルダを表示
                    </button>
                  </div>
                </div>
              )}
              {premiereDone && (
                <div className="export-done">
                  <p className="success-text" title={premiereDone.xmlPath}>
                    Premiere 用 XML を書き出しました(映像 {premiereDone.stats.videoClips}・音声{' '}
                    {premiereDone.stats.audioClips} クリップ・マーカー {premiereDone.stats.markers})
                  </p>
                  {premiereMediaNote(premiereDone.media) && (
                    <p className="hint-text" title={premiereDone.media?.dir}>
                      {premiereMediaNote(premiereDone.media)}
                    </p>
                  )}
                  <div className="export-done-actions">
                    <button
                      className="small-button"
                      onClick={() =>
                        window.api
                          .showItemInFolder(premiereDone.xmlPath)
                          .catch((e) => setError(formatIpcError(e)))
                      }
                    >
                      <FolderIcon width={14} height={14} />
                      フォルダを表示
                    </button>
                  </div>
                  {premiereDone.warnings.map((warning) => (
                    <p key={warning} className="hint-text">
                      {warning}
                    </p>
                  ))}
                </div>
              )}
              {error && <p className="error-text">{error}</p>}
              {usesMissingAsset && <p className="error-text">{MISSING_ASSET_MESSAGE}</p>}
              {soloOn && (
                <p
                  className="hint-text ve-export-solo-note"
                  role="note"
                  title="ソロはプレビューの音だけに効きます。書き出しには、ミュートしていない全部のトラックの音が入ります"
                >
                  ソロ中: 書き出しには効きません
                </p>
              )}
              {shortOver && (
                <div className="ve-export-warn" role="alert">
                  <AlertTriangleIcon width={14} height={14} />
                  <span>
                    ショートは {SHORT_MAX_SEC} 秒までです(今は {lengthClock(duration, fps)})。
                    {SHORT_MAX_SEC} 秒以下の範囲を選ぶと書き出せます。
                  </span>
                  <button
                    type="button"
                    className="small-button"
                    onClick={() => {
                      if (selection && selection.end - selection.start <= SHORT_MAX_SEC) {
                        setRangeMode('range')
                        return
                      }
                      // 範囲はタイムラインで選ぶ(イン点 I・アウト点 O)。確認の画面も閉じて編集の画面へ
                      setOpen(false)
                      usePipelineStore.getState().setScreenOpen(false)
                    }}
                    title={
                      selection && selection.end - selection.start <= SHORT_MAX_SEC
                        ? '選んである範囲だけを書き出します'
                        : 'タイムラインでイン点(I)・アウト点(O)を打ち、もう一度開いてください'
                    }
                  >
                    範囲を選ぶ
                  </button>
                </div>
              )}
              {xml && (
                <p className="hint-text">
                  {'カット・速さ・繋ぎ・ワイプ・BGM と SE の音量を、同じ並びで書きます。' +
                    'ダッキング・ラウドネス・色合わせは Premiere で仕上げます。章はいつもマーカーに入ります。'}
                </p>
              )}
              <ExportQcPanel onJump={() => setOpen(false)} />
            </div>

            <div className="ve-export-bottom">
              {xml ? (
                <div className="ve-export-sample">
                  <span className="ve-export-sample-time">
                    テロップ <span className="mono">{telopCount.toLocaleString()}</span> 本
                  </span>
                  <span className="ve-export-sample-time">
                    要確認 <span className="mono">{reviewLists.open.length.toLocaleString()}</span>{' '}
                    件
                  </span>
                </div>
              ) : (
                <ExportPreview
                  project={project}
                  start={span.start}
                  end={span.end}
                  audioOnly={format === 'wav'}
                  vertical={project.aspectRatio === '9:16'}
                  fill={verticalFraming !== 'letterbox'}
                  twoPeople={verticalFraming === 'fill'}
                  findFaces={framesOnFaces(project, kindFallback())}
                  fps={fps}
                />
              )}
              <dl className="ve-export-summary">
                <div>
                  <dt>長さ</dt>
                  <dd>
                    <span className="mono">{lengthClock(duration, fps)}</span>
                  </dd>
                </div>
                <div>
                  <dt>推定サイズ</dt>
                  <dd title="絵柄で数倍変わります(目安)">
                    {estBytes === null ? (
                      <span className="mono">—</span>
                    ) : (
                      <>
                        <span className="mono">{splitBytes(estBytes)[0]}</span>
                        {splitBytes(estBytes)[1]}
                      </>
                    )}
                  </dd>
                </div>
                {estSec !== null && (
                  <div>
                    <dt>推定時間</dt>
                    <dd title="前に書き出したときの速さからの目安">
                      <span className="mono">{splitDuration(estSec)[0]}</span>
                      {splitDuration(estSec)[1]}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>空き容量</dt>
                  <dd title={folder ? folder : '保存先を選ぶと出ます'}>
                    {free === null ? (
                      <span className="mono">—</span>
                    ) : (
                      <>
                        <span className="mono">{splitBytes(free)[0]}</span>
                        {splitBytes(free)[1]}
                      </>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>

        <div className="ve-export-foot">
          <span className="ve-export-foot-note">
            {xml
              ? 'XML と同じ名前の .srt を並べて書きます。'
              : telopCount > 0
                ? `テロップ ${telopCount.toLocaleString()} 本は画面と同じ描画で書き出します。この設定は次回も覚えておきます。`
                : 'この設定は次回も覚えておき、同じ設定で書き出します。'}
          </span>
          {running ? (
            <button type="button" className="ve-export-button danger" onClick={cancelExport}>
              書き出しを中止
            </button>
          ) : (
            <button type="button" className="ve-export-button" onClick={() => setOpen(false)}>
              キャンセル
            </button>
          )}
          {!xml && (
            <button
              type="button"
              className="ve-export-button"
              disabled={running || shortOver}
              onClick={addToQueue}
              title="今の組み合わせをキューに並べ、あとでまとめて書き出します"
            >
              キューに追加
            </button>
          )}
          <button
            type="button"
            className="ve-export-button primary"
            disabled={running || shortOver}
            title={shortOver ? `ショートは ${SHORT_MAX_SEC} 秒までです` : undefined}
            onClick={xml ? handlePremiereExport : handleExport}
          >
            <UploadIcon width={14} height={14} />
            {running ? '書き出し中…' : xml ? 'XML を書き出す' : '書き出す'}
          </button>
        </div>
      </div>
    </div>
  )
}
