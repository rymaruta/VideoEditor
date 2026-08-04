import { useEffect, useState } from 'react'
import { MediaBin } from './components/MediaBin'
import { PreviewPlayer } from './components/PreviewPlayer'
import { Timeline } from './components/Timeline'
import { TemplatePanel } from './components/TemplatePanel'
import { TextOverlayPanel } from './components/TextOverlayPanel'
import { YouTubeTrendPanel } from './components/YouTubeTrendPanel'
import { ExportPanel } from './components/ExportPanel'
import { NarrationPanel } from './components/NarrationPanel'
import { ThumbnailPanel } from './components/ThumbnailPanel'
import { AudioLibraryPanel } from './components/AudioLibraryPanel'
import { GameTrendPanel } from './components/GameTrendPanel'
import { MetadataPanel } from './components/MetadataPanel'
import { PresetPanel } from './components/PresetPanel'
import { ProjectMenu } from './components/ProjectMenu'
import { useProjectStore } from './store/projectStore'
import { useSettingsStore } from './store/settingsStore'
import { useKeyboardShortcuts } from './lib/useKeyboardShortcuts'
import {
  ClapperboardIcon,
  SparklesIcon,
  TypeIcon,
  YoutubeIcon,
  DownloadIcon,
  MicIcon,
  UndoIcon,
  RedoIcon,
  ImageIcon,
  MusicIcon,
  TargetIcon,
  MegaphoneIcon,
  StarIcon,
  ChevronLeftIcon,
  ChevronRightIcon
} from './components/icons'
import type { SVGProps } from 'react'

type RightTab =
  | 'template'
  | 'text'
  | 'narration'
  | 'thumbnail'
  | 'audio'
  | 'preset'
  | 'gametrend'
  | 'youtube'
  | 'metadata'
  | 'export'

interface TabDef {
  id: RightTab
  label: string
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element
  description: string
}

const EDIT_TABS: TabDef[] = [
  {
    id: 'template',
    label: 'テンプレート',
    icon: SparklesIcon,
    description: 'ショート動画のトレンド構成テンプレートを適用'
  },
  { id: 'text', label: 'テキスト', icon: TypeIcon, description: 'テロップ(字幕)の追加・編集' },
  {
    id: 'narration',
    label: 'ボイス',
    icon: MicIcon,
    description: 'VOICEVOXによるナレーション音声合成'
  },
  { id: 'thumbnail', label: 'サムネ', icon: ImageIcon, description: 'サムネイル画像の自動生成' },
  {
    id: 'audio',
    label: 'BGM/SE',
    icon: MusicIcon,
    description: 'BGM・効果音ライブラリの検索と追加'
  },
  {
    id: 'preset',
    label: 'プリセット',
    icon: StarIcon,
    description: 'お気に入り登録したテロップスタイル・効果音の管理'
  }
]

const PUBLISH_TABS: TabDef[] = [
  {
    id: 'gametrend',
    label: 'ゲームトレンド',
    icon: TargetIcon,
    description: 'ゲームトレンド分析(YouTube+Gemini)'
  },
  {
    id: 'youtube',
    label: 'YouTube',
    icon: YoutubeIcon,
    description: 'YouTubeトレンド・キーワード調査'
  },
  {
    id: 'metadata',
    label: '投稿準備',
    icon: MegaphoneIcon,
    description: '投稿用タイトル・概要欄・ハッシュタグの自動生成'
  },
  { id: 'export', label: '書き出し', icon: DownloadIcon, description: '動画の書き出し設定' }
]

const LEFT_WIDTH_KEY = 've-layout-left-width'
const RIGHT_WIDTH_KEY = 've-layout-right-width'
const TIMELINE_HEIGHT_KEY = 've-layout-timeline-height'
const LEFT_COLLAPSED_KEY = 've-layout-left-collapsed'
const RIGHT_COLLAPSED_KEY = 've-layout-right-collapsed'

const DEFAULT_LEFT_WIDTH = 260
const DEFAULT_RIGHT_WIDTH = 320
const DEFAULT_TIMELINE_HEIGHT = 440
const MIN_LEFT_WIDTH = 200
const MAX_LEFT_WIDTH = 480
const MIN_RIGHT_WIDTH = 280
const MAX_RIGHT_WIDTH = 540
const MIN_TIMELINE_HEIGHT = 160
const MAX_TIMELINE_HEIGHT = 560

function readStoredSize(key: string, fallback: number): number {
  const raw = localStorage.getItem(key)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface ResizeDragState {
  kind: 'left' | 'right' | 'timeline'
  startX: number
  startY: number
  startLeftWidth: number
  startRightWidth: number
  startTimelineHeight: number
}

function App(): React.JSX.Element {
  const [tab, setTab] = useState<RightTab>('template')
  const projectName = useProjectStore((s) => s.project.name)
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio)
  const canUndo = useProjectStore((s) => s.past.length > 0)
  const canRedo = useProjectStore((s) => s.future.length > 0)
  const undo = useProjectStore((s) => s.undo)
  const redo = useProjectStore((s) => s.redo)
  const isDirty = useProjectStore((s) => s.isDirty)
  const loadEnvApiKeys = useSettingsStore((s) => s.loadEnvApiKeys)

  useEffect(() => {
    loadEnvApiKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [leftWidth, setLeftWidth] = useState(() =>
    readStoredSize(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH)
  )
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredSize(RIGHT_WIDTH_KEY, DEFAULT_RIGHT_WIDTH)
  )
  const [timelineHeight, setTimelineHeight] = useState(() =>
    readStoredSize(TIMELINE_HEIGHT_KEY, DEFAULT_TIMELINE_HEIGHT)
  )
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem(LEFT_COLLAPSED_KEY) === 'true'
  )
  const [rightCollapsed, setRightCollapsed] = useState(
    () => localStorage.getItem(RIGHT_COLLAPSED_KEY) === 'true'
  )
  const [resizeDrag, setResizeDrag] = useState<ResizeDragState | null>(null)

  function beginResize(kind: ResizeDragState['kind'], e: React.MouseEvent): void {
    e.preventDefault()
    setResizeDrag({
      kind,
      startX: e.clientX,
      startY: e.clientY,
      startLeftWidth: leftWidth,
      startRightWidth: rightWidth,
      startTimelineHeight: timelineHeight
    })
  }

  useEffect(() => {
    if (!resizeDrag) return
    function handleMouseMove(e: MouseEvent): void {
      if (!resizeDrag) return
      if (resizeDrag.kind === 'left') {
        setLeftWidth(
          clamp(
            resizeDrag.startLeftWidth + (e.clientX - resizeDrag.startX),
            MIN_LEFT_WIDTH,
            MAX_LEFT_WIDTH
          )
        )
      } else if (resizeDrag.kind === 'right') {
        setRightWidth(
          clamp(
            resizeDrag.startRightWidth - (e.clientX - resizeDrag.startX),
            MIN_RIGHT_WIDTH,
            MAX_RIGHT_WIDTH
          )
        )
      } else {
        setTimelineHeight(
          clamp(
            resizeDrag.startTimelineHeight - (e.clientY - resizeDrag.startY),
            MIN_TIMELINE_HEIGHT,
            MAX_TIMELINE_HEIGHT
          )
        )
      }
    }
    function handleMouseUp(): void {
      setResizeDrag(null)
    }
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = resizeDrag.kind === 'timeline' ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [resizeDrag])

  useEffect(() => {
    localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth))
  }, [leftWidth])
  useEffect(() => {
    localStorage.setItem(RIGHT_WIDTH_KEY, String(rightWidth))
  }, [rightWidth])
  useEffect(() => {
    localStorage.setItem(TIMELINE_HEIGHT_KEY, String(timelineHeight))
  }, [timelineHeight])
  useEffect(() => {
    localStorage.setItem(LEFT_COLLAPSED_KEY, String(leftCollapsed))
  }, [leftCollapsed])
  useEffect(() => {
    localStorage.setItem(RIGHT_COLLAPSED_KEY, String(rightCollapsed))
  }, [rightCollapsed])

  useKeyboardShortcuts()

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="top-bar-brand">
            <span className="brand-icon">
              <ClapperboardIcon width={18} height={18} />
            </span>
            <span className="brand-name">VideoEditor</span>
          </div>
          <ProjectMenu />
          <div className="top-bar-history">
            <button
              className="icon-button"
              title="元に戻す (Ctrl+Z)"
              onClick={undo}
              disabled={!canUndo}
            >
              <UndoIcon width={14} height={14} />
            </button>
            <button
              className="icon-button"
              title="やり直す (Ctrl+Shift+Z)"
              onClick={redo}
              disabled={!canRedo}
            >
              <RedoIcon width={14} height={14} />
            </button>
          </div>
        </div>
        <div className="top-bar-project">
          <span className="project-name">
            {projectName}
            {isDirty && <span className="dirty-dot" title="未保存の変更があります" />}
          </span>
          <span className="project-badge">{aspectRatio}</span>
        </div>
      </header>
      <div className="app-layout">
        {!leftCollapsed && (
          <div className="left-column" style={{ width: leftWidth }}>
            <MediaBin />
          </div>
        )}
        <div className="col-resize-handle-track">
          {!leftCollapsed && (
            <div
              className={`col-resize-handle ${resizeDrag?.kind === 'left' ? 'active' : ''}`}
              onMouseDown={(e) => beginResize('left', e)}
              title="ドラッグして幅を調整"
            />
          )}
          <button
            className="panel-collapse-toggle"
            onClick={() => setLeftCollapsed((v) => !v)}
            title={leftCollapsed ? 'メディアパネルを表示' : 'メディアパネルを折りたたむ'}
          >
            {leftCollapsed ? (
              <ChevronRightIcon width={11} height={11} />
            ) : (
              <ChevronLeftIcon width={11} height={11} />
            )}
          </button>
        </div>
        <div className="center-column">
          <PreviewPlayer />
          <div
            className={`row-resize-handle ${resizeDrag?.kind === 'timeline' ? 'active' : ''}`}
            onMouseDown={(e) => beginResize('timeline', e)}
            title="ドラッグして高さを調整"
          />
          <div className="timeline-wrapper" style={{ height: timelineHeight }}>
            <Timeline />
          </div>
        </div>
        <div className="col-resize-handle-track">
          {!rightCollapsed && (
            <div
              className={`col-resize-handle ${resizeDrag?.kind === 'right' ? 'active' : ''}`}
              onMouseDown={(e) => beginResize('right', e)}
              title="ドラッグして幅を調整"
            />
          )}
          <button
            className="panel-collapse-toggle"
            onClick={() => setRightCollapsed((v) => !v)}
            title={rightCollapsed ? '右パネルを表示' : '右パネルを折りたたむ'}
          >
            {rightCollapsed ? (
              <ChevronLeftIcon width={11} height={11} />
            ) : (
              <ChevronRightIcon width={11} height={11} />
            )}
          </button>
        </div>
        {!rightCollapsed && (
          <div className="right-column" style={{ width: rightWidth }}>
            <div className="tab-bar">
              {EDIT_TABS.map(({ id, label, icon: Icon, description }) => (
                <button
                  key={id}
                  className={tab === id ? 'active' : ''}
                  onClick={() => setTab(id)}
                  title={description}
                >
                  <Icon width={14} height={14} />
                  <span>{label}</span>
                </button>
              ))}
              <div className="tab-bar-divider" />
              {PUBLISH_TABS.map(({ id, label, icon: Icon, description }) => (
                <button
                  key={id}
                  className={tab === id ? 'active' : ''}
                  onClick={() => setTab(id)}
                  title={description}
                >
                  <Icon width={14} height={14} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <div className="tab-content">
              {tab === 'template' && <TemplatePanel />}
              {tab === 'text' && <TextOverlayPanel />}
              {tab === 'narration' && <NarrationPanel />}
              {tab === 'thumbnail' && <ThumbnailPanel />}
              {tab === 'audio' && <AudioLibraryPanel />}
              {tab === 'preset' && <PresetPanel />}
              {tab === 'gametrend' && <GameTrendPanel />}
              {tab === 'youtube' && <YouTubeTrendPanel />}
              {tab === 'metadata' && <MetadataPanel />}
              {tab === 'export' && <ExportPanel />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
