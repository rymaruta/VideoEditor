import { useEffect, useRef, useState } from 'react'
import { MediaBin } from './components/MediaBin'
import { PreviewPlayer } from './components/PreviewPlayer'
import { SourceViewer } from './components/SourceViewer'
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
import { Inspector } from './components/Inspector'
import { ProjectMenu } from './components/ProjectMenu'
import { ProjectNameField } from './components/ProjectNameField'
import { AutosaveRestoreModal } from './components/AutosaveRestoreModal'
import { useProjectStore } from './store/projectStore'
import { useAutosaveStore } from './store/autosaveStore'
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
  StarIcon
} from './components/icons'
import type { SVGProps } from 'react'

type RightTab =
  | 'inspector'
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
    id: 'inspector',
    label: 'インスペクタ',
    icon: TargetIcon,
    description: '選択したクリップの尺・速度・フレーミング・繋ぎ・音声をまとめて編集'
  },
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
const MIN_RIGHT_WIDTH = 280
const MIN_TIMELINE_HEIGHT = 160
const MAX_TIMELINE_HEIGHT = 560
// DaVinci Resolve-style panels: no fixed pixel cap. The only limit is leaving
// enough room for the preview/timeline in the center to stay usable.
const MIN_CENTER_WIDTH = 360
const RESIZE_CHROME_WIDTH = 80

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
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio)
  const canUndo = useProjectStore((s) => s.past.length > 0)
  const canRedo = useProjectStore((s) => s.future.length > 0)
  const undo = useProjectStore((s) => s.undo)
  const redo = useProjectStore((s) => s.redo)
  const isDirty = useProjectStore((s) => s.isDirty)
  const loadEnvApiKeys = useSettingsStore((s) => s.loadEnvApiKeys)
  const refreshAutosave = useAutosaveStore((s) => s.refresh)
  const sourceAssetId = useProjectStore((s) => s.sourceAssetId)

  useEffect(() => {
    loadEnvApiKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Crash recovery: on launch, offer to restore a draft that was autosaved but
  // never cleanly saved/closed (e.g. after a crash or forced quit).
  // 確認は AutosaveRestoreModal が出す。ここは状態を読み込むだけ。
  useEffect(() => {
    refreshAutosave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the main process informed of unsaved-changes state so it can warn
  // before quitting, and periodically autosave a recovery draft while dirty.
  useEffect(() => {
    window.api.setDirtyState(isDirty)
  }, [isDirty])

  useEffect(() => {
    const interval = setInterval(() => {
      const { project, isDirty } = useProjectStore.getState()
      // 見送った前回の自動保存を上書きする前に退避したときは、上部バーの復元ボタンを
      // すぐ出す。退避したのにボタンが出ないと、再起動するまで戻せない。
      if (isDirty) {
        window.api.autosaveProject(project).then((setAside) => {
          if (setAside) useAutosaveStore.getState().refresh()
        })
      }
    }, 60000)
    return () => clearInterval(interval)
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
  const previousTimelineHeightRef = useRef(timelineHeight)

  // Double-clicking the preview/timeline divider snaps the timeline down to its
  // minimum height (maximizing the preview) and back, so getting a much bigger
  // preview doesn't require manually dragging the divider every time.
  function handleDividerDoubleClick(): void {
    setTimelineHeight((current) => {
      if (current > MIN_TIMELINE_HEIGHT) {
        previousTimelineHeightRef.current = current
        return MIN_TIMELINE_HEIGHT
      }
      return previousTimelineHeightRef.current > MIN_TIMELINE_HEIGHT
        ? previousTimelineHeightRef.current
        : DEFAULT_TIMELINE_HEIGHT
    })
  }
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
        const rightSpace = rightCollapsed ? 0 : resizeDrag.startRightWidth
        const maxLeftWidth = Math.max(
          MIN_LEFT_WIDTH,
          window.innerWidth - rightSpace - MIN_CENTER_WIDTH - RESIZE_CHROME_WIDTH
        )
        setLeftWidth(
          clamp(
            resizeDrag.startLeftWidth + (e.clientX - resizeDrag.startX),
            MIN_LEFT_WIDTH,
            maxLeftWidth
          )
        )
      } else if (resizeDrag.kind === 'right') {
        const leftSpace = leftCollapsed ? 0 : resizeDrag.startLeftWidth
        const maxRightWidth = Math.max(
          MIN_RIGHT_WIDTH,
          window.innerWidth - leftSpace - MIN_CENTER_WIDTH - RESIZE_CHROME_WIDTH
        )
        setRightWidth(
          clamp(
            resizeDrag.startRightWidth - (e.clientX - resizeDrag.startX),
            MIN_RIGHT_WIDTH,
            maxRightWidth
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
  }, [resizeDrag, leftCollapsed, rightCollapsed])

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

  // Re-clamp panel widths when the OS window itself is resized (not just via drag),
  // so shrinking the window can't squeeze the center preview/timeline out entirely.
  const layoutRef = useRef({ leftWidth, rightWidth, leftCollapsed, rightCollapsed })
  useEffect(() => {
    layoutRef.current = { leftWidth, rightWidth, leftCollapsed, rightCollapsed }
  }, [leftWidth, rightWidth, leftCollapsed, rightCollapsed])
  useEffect(() => {
    function handleWindowResize(): void {
      const {
        leftWidth: lw,
        rightWidth: rw,
        leftCollapsed: lc,
        rightCollapsed: rc
      } = layoutRef.current
      const rightSpace = rc ? 0 : rw
      const leftSpace = lc ? 0 : lw
      const maxLeftWidth = Math.max(
        MIN_LEFT_WIDTH,
        window.innerWidth - rightSpace - MIN_CENTER_WIDTH - RESIZE_CHROME_WIDTH
      )
      const maxRightWidth = Math.max(
        MIN_RIGHT_WIDTH,
        window.innerWidth - leftSpace - MIN_CENTER_WIDTH - RESIZE_CHROME_WIDTH
      )
      setLeftWidth((w) => clamp(w, MIN_LEFT_WIDTH, maxLeftWidth))
      setRightWidth((w) => clamp(w, MIN_RIGHT_WIDTH, maxRightWidth))
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

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
          <ProjectNameField />
          <span className="project-badge">{aspectRatio}</span>
        </div>
      </header>
      <div className="app-layout">
        <div
          className={`left-column ${leftCollapsed ? 'panel-collapsed' : ''}`}
          style={{ width: leftCollapsed ? 0 : leftWidth }}
        >
          <MediaBin />
        </div>
        <div
          className={`col-resize-handle ${leftCollapsed ? 'collapsed' : ''} ${
            resizeDrag?.kind === 'left' ? 'active' : ''
          }`}
          onMouseDown={leftCollapsed ? undefined : (e) => beginResize('left', e)}
          onDoubleClick={() => setLeftCollapsed((v) => !v)}
          title={
            leftCollapsed
              ? 'ダブルクリックでメディアパネルを表示'
              : 'ドラッグして幅を調整(ダブルクリックで折りたたむ)'
          }
        />
        <div className="center-column">
          <div className="viewer-row">
            {/* Keyed by asset so switching clips remounts the viewer: transport position,
                play state and shuttle speed all belong to the clip being auditioned and
                must not carry over to the next one. */}
            {sourceAssetId && <SourceViewer key={sourceAssetId} />}
            <PreviewPlayer />
          </div>
          <div
            className={`row-resize-handle ${resizeDrag?.kind === 'timeline' ? 'active' : ''}`}
            onMouseDown={(e) => beginResize('timeline', e)}
            onDoubleClick={handleDividerDoubleClick}
            title="ドラッグして高さを調整(ダブルクリックでプレビューを最大化/元に戻す)"
          />
          <div className="timeline-wrapper" style={{ height: timelineHeight }}>
            <Timeline />
          </div>
        </div>
        <div
          className={`col-resize-handle ${rightCollapsed ? 'collapsed' : ''} ${
            resizeDrag?.kind === 'right' ? 'active' : ''
          }`}
          onMouseDown={rightCollapsed ? undefined : (e) => beginResize('right', e)}
          onDoubleClick={() => setRightCollapsed((v) => !v)}
          title={
            rightCollapsed
              ? 'ダブルクリックで右パネルを表示'
              : 'ドラッグして幅を調整(ダブルクリックで折りたたむ)'
          }
        />
        <div
          className={`right-column ${rightCollapsed ? 'panel-collapsed' : ''}`}
          style={{ width: rightCollapsed ? 0 : rightWidth }}
        >
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
          {/* All tab panels stay mounted (hidden via CSS) rather than being unmounted on
              switch, so an in-progress AI/API request (Gemini, VOICEVOX, YouTube, etc.) in
              one tab keeps running and its result is still there when the user comes back,
              instead of being silently discarded by switching tabs to do something else. */}
          <div className="tab-content">
            <div className={`tab-pane ${tab === 'inspector' ? 'active' : ''}`}>
              <Inspector />
            </div>
            <div className={`tab-pane ${tab === 'template' ? 'active' : ''}`}>
              <TemplatePanel />
            </div>
            <div className={`tab-pane ${tab === 'text' ? 'active' : ''}`}>
              <TextOverlayPanel />
            </div>
            <div className={`tab-pane ${tab === 'narration' ? 'active' : ''}`}>
              <NarrationPanel />
            </div>
            <div className={`tab-pane ${tab === 'thumbnail' ? 'active' : ''}`}>
              <ThumbnailPanel />
            </div>
            <div className={`tab-pane ${tab === 'audio' ? 'active' : ''}`}>
              <AudioLibraryPanel />
            </div>
            <div className={`tab-pane ${tab === 'preset' ? 'active' : ''}`}>
              <PresetPanel />
            </div>
            <div className={`tab-pane ${tab === 'gametrend' ? 'active' : ''}`}>
              <GameTrendPanel />
            </div>
            <div className={`tab-pane ${tab === 'youtube' ? 'active' : ''}`}>
              <YouTubeTrendPanel />
            </div>
            <div className={`tab-pane ${tab === 'metadata' ? 'active' : ''}`}>
              <MetadataPanel />
            </div>
            <div className={`tab-pane ${tab === 'export' ? 'active' : ''}`}>
              <ExportPanel />
            </div>
          </div>
        </div>
      </div>
      <AutosaveRestoreModal />
    </div>
  )
}

export default App
