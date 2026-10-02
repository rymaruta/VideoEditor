import { useEffect, useState } from 'react'
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
import { useAppMenu, useMenuCommand } from './lib/menuCommands'
import { StatusBar } from './components/StatusBar'
import { AutosaveRestoreModal } from './components/AutosaveRestoreModal'
import { useProjectStore } from './store/projectStore'
import { useAutosaveStore } from './store/autosaveStore'
import { useSettingsStore } from './store/settingsStore'
import { useKeyboardShortcuts } from './lib/useKeyboardShortcuts'
import {
  SparklesIcon,
  TypeIcon,
  YoutubeIcon,
  DownloadIcon,
  MicIcon,
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

/** メニューバーの「ウィンドウ」に並べる右側のパネル */
const MENU_WINDOWS = [...EDIT_TABS, ...PUBLISH_TABS].map(({ id, label }) => ({ id, label }))

/**
 * 画面の配置(Windows の編集ソフト・Premiere と同じ並び)。
 *
 *   ┌──────────────┬─────────────────────┐
 *   │ パネル(タブ)  │ プログラムモニター   │  上段
 *   ├──────────────┼─────────────────────┤
 *   │ プロジェクト  │ タイムライン          │  下段
 *   └──────────────┴─────────────────────┘
 *   ステータスバー
 *
 * 上段の左は「ソース・インスペクタ・テロップ・BGM/SE・書き出し…」をタブで切り替える。
 * 下段の左は素材(プロジェクト / ライブラリ)。境目はどれもドラッグで動かせ、大きさは次回も残る。
 */
const PROPS_WIDTH_KEY = 've-layout2-props-width'
const BIN_WIDTH_KEY = 've-layout2-bin-width'
const BOTTOM_HEIGHT_KEY = 've-layout2-bottom-height'

const DEFAULT_PROPS_WIDTH = 520
const DEFAULT_BIN_WIDTH = 320
const DEFAULT_BOTTOM_HEIGHT = 420
const MIN_PROPS_WIDTH = 300
const MIN_BIN_WIDTH = 220
const MIN_MONITOR_WIDTH = 360
const MIN_TIMELINE_WIDTH = 420
const MIN_BOTTOM_HEIGHT = 180
const MIN_TOP_HEIGHT = 220
/** 枠・境目・ステータスバーなど、パネル以外が使う高さ */
const CHROME_HEIGHT = 60

function readStoredSize(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

function storeSize(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)))
  } catch {
    // 残せなくても今回の配置は効く
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 窓の大きさに収まるよう、3つの寸法を詰める(縮めた窓でモニターやタイムラインが消えないように) */
function fitLayout(size: { props: number; bin: number; bottom: number }): {
  props: number
  bin: number
  bottom: number
} {
  const w = window.innerWidth
  const h = window.innerHeight
  return {
    props: clamp(size.props, MIN_PROPS_WIDTH, Math.max(MIN_PROPS_WIDTH, w - MIN_MONITOR_WIDTH)),
    bin: clamp(size.bin, MIN_BIN_WIDTH, Math.max(MIN_BIN_WIDTH, w - MIN_TIMELINE_WIDTH)),
    bottom: clamp(
      size.bottom,
      MIN_BOTTOM_HEIGHT,
      Math.max(MIN_BOTTOM_HEIGHT, h - MIN_TOP_HEIGHT - CHROME_HEIGHT)
    )
  }
}

type PanelTab = RightTab | 'source'

interface ResizeDragState {
  kind: 'props' | 'bin' | 'rows'
  startX: number
  startY: number
  start: { props: number; bin: number; bottom: number }
}

function App(): React.JSX.Element {
  const [tab, setTab] = useState<PanelTab>('inspector')
  const projectName = useProjectStore((s) => s.project.name)
  const isDirty = useProjectStore((s) => s.isDirty)
  const loadEnvApiKeys = useSettingsStore((s) => s.loadEnvApiKeys)
  const refreshAutosave = useAutosaveStore((s) => s.refresh)
  const sourceAssetId = useProjectStore((s) => s.sourceAssetId)

  // メニューバー(ファイル / 編集 / … / ウィンドウ)。ウィンドウの欄には上段左のパネルを並べる
  useAppMenu(MENU_WINDOWS)

  // ウィンドウのタイトルにプロジェクト名と未保存の印を出す(Windows のソフトの決まり)
  useEffect(() => {
    document.title = `${projectName}${isDirty ? ' *' : ''} — VideoEditor`
  }, [projectName, isDirty])

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
      // 見送った前回の自動保存を上書きする前に退避したときは、メニューの「破棄した自動保存
      // データを戻す」をすぐ使えるようにする。
      if (isDirty) {
        window.api.autosaveProject(project).then((setAside) => {
          if (setAside) useAutosaveStore.getState().refresh()
        })
      }
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  // 素材をソースで開いたら、上段左を「ソース」にする。閉じたら元のタブへ戻す
  const [prevSource, setPrevSource] = useState(sourceAssetId)
  if (prevSource !== sourceAssetId) {
    setPrevSource(sourceAssetId)
    if (sourceAssetId) setTab('source')
    else if (tab === 'source') setTab('inspector')
  }

  // メニューバーの「ウィンドウ」「書き出し…」「テロップの一覧」で上段左のパネルを切り替える
  useMenuCommand((id) => {
    const target = id.startsWith('window.')
      ? (id.slice('window.'.length) as RightTab)
      : id === 'file.export'
        ? 'export'
        : id === 'telop.list'
          ? 'text'
          : null
    if (target && MENU_WINDOWS.some((w) => w.id === target)) setTab(target)
  })

  const [size, setSize] = useState(() =>
    fitLayout({
      props: readStoredSize(PROPS_WIDTH_KEY, DEFAULT_PROPS_WIDTH),
      bin: readStoredSize(BIN_WIDTH_KEY, DEFAULT_BIN_WIDTH),
      bottom: readStoredSize(BOTTOM_HEIGHT_KEY, DEFAULT_BOTTOM_HEIGHT)
    })
  )
  const [resizeDrag, setResizeDrag] = useState<ResizeDragState | null>(null)

  function beginResize(kind: ResizeDragState['kind'], e: React.MouseEvent): void {
    e.preventDefault()
    setResizeDrag({ kind, startX: e.clientX, startY: e.clientY, start: size })
  }

  useEffect(() => {
    if (!resizeDrag) return
    function handleMouseMove(e: MouseEvent): void {
      if (!resizeDrag) return
      const dx = e.clientX - resizeDrag.startX
      const dy = e.clientY - resizeDrag.startY
      const s = resizeDrag.start
      setSize(
        fitLayout(
          resizeDrag.kind === 'props'
            ? { ...s, props: s.props + dx }
            : resizeDrag.kind === 'bin'
              ? { ...s, bin: s.bin + dx }
              : { ...s, bottom: s.bottom - dy }
        )
      )
    }
    function handleMouseUp(): void {
      setResizeDrag(null)
    }
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = resizeDrag.kind === 'rows' ? 'row-resize' : 'col-resize'
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
    storeSize(PROPS_WIDTH_KEY, size.props)
    storeSize(BIN_WIDTH_KEY, size.bin)
    storeSize(BOTTOM_HEIGHT_KEY, size.bottom)
  }, [size])

  // 窓そのものの大きさが変わったら詰め直す(前回の大きさのまま狭い窓で開いたときも)
  useEffect(() => {
    const handleWindowResize = (): void => setSize((s) => fitLayout(s))
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

  useKeyboardShortcuts()

  const tabButton = ({
    id,
    label,
    description
  }: {
    id: PanelTab
    label: string
    description: string
  }): React.JSX.Element => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={`panel-tab ${tab === id ? 'active' : ''}`}
      onClick={() => setTab(id)}
      title={description}
    >
      {label}
    </button>
  )

  return (
    <div className="app-shell">
      <div className="workspace">
        {/* ===== 上段: パネル(タブ) / プログラムモニター ===== */}
        <div className="workspace-row" style={{ flex: 1 }}>
          <section className="frame frame-props" style={{ width: size.props }}>
            <div className="panel-tabs" role="tablist" aria-label="パネル">
              {sourceAssetId &&
                tabButton({ id: 'source', label: 'ソース', description: '素材をソースで確認する' })}
              {EDIT_TABS.map(tabButton)}
              {PUBLISH_TABS.map(tabButton)}
            </div>
            {/* All tab panels stay mounted (hidden via CSS) rather than being unmounted on
                switch, so an in-progress AI/API request (Gemini, VOICEVOX, YouTube, etc.) in
                one tab keeps running and its result is still there when the user comes back,
                instead of being silently discarded by switching tabs to do something else. */}
            <div className="tab-content">
              {/* Keyed by asset so switching clips remounts the viewer: transport position,
                  play state and shuttle speed all belong to the clip being auditioned and
                  must not carry over to the next one. */}
              <div className={`tab-pane ${tab === 'source' ? 'active' : ''}`}>
                {sourceAssetId && <SourceViewer key={sourceAssetId} />}
              </div>
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
          </section>
          <div
            className={`split-handle split-col ${resizeDrag?.kind === 'props' ? 'active' : ''}`}
            onMouseDown={(e) => beginResize('props', e)}
            title="ドラッグして幅を調整"
          />
          <section className="frame frame-monitor">
            <div className="panel-tabs" role="tablist" aria-label="モニター">
              <button type="button" role="tab" aria-selected className="panel-tab active">
                プログラム
              </button>
            </div>
            <PreviewPlayer />
          </section>
        </div>

        <div
          className={`split-handle split-row ${resizeDrag?.kind === 'rows' ? 'active' : ''}`}
          onMouseDown={(e) => beginResize('rows', e)}
          title="ドラッグして高さを調整"
        />

        {/* ===== 下段: プロジェクト / タイムライン ===== */}
        <div className="workspace-row" style={{ height: size.bottom }}>
          <section className="frame frame-bin" style={{ width: size.bin }}>
            <MediaBin />
          </section>
          <div
            className={`split-handle split-col ${resizeDrag?.kind === 'bin' ? 'active' : ''}`}
            onMouseDown={(e) => beginResize('bin', e)}
            title="ドラッグして幅を調整"
          />
          <section className="frame frame-timeline">
            <Timeline />
          </section>
        </div>
      </div>
      <StatusBar />
      <AutosaveRestoreModal />
    </div>
  )
}

export default App
