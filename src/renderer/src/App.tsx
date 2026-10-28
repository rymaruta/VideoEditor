import { useEffect, useState } from 'react'
import { MediaBin } from './components/MediaBin'
import { PreviewPlayer } from './components/PreviewPlayer'
import { SourceViewer } from './components/SourceViewer'
import { Timeline } from './components/Timeline'
import { TemplatePanel } from './components/TemplatePanel'
import { TextOverlayPanel } from './components/TextOverlayPanel'
import { YouTubeTrendPanel } from './components/YouTubeTrendPanel'
import { ExportDialog } from './components/ExportDialog'
import { TelopStyleDialog } from './components/TelopStyleDialog'
import { NewEpisodeDialog } from './components/NewEpisodeDialog'
import { AutoEditScreen } from './components/AutoEditScreen'
import { NarrationPanel } from './components/NarrationPanel'
import { ThumbnailPanel } from './components/ThumbnailPanel'
import { AudioLibraryPanel } from './components/AudioLibraryPanel'
import { GameTrendPanel } from './components/GameTrendPanel'
import { MetadataPanel } from './components/MetadataPanel'
import { PresetPanel } from './components/PresetPanel'
import { Inspector } from './components/Inspector'
import { useAppMenu, useMenuCommand } from './lib/menuCommands'
import { StatusBar } from './components/StatusBar'
import { autoBottomHeight, defaultSideWidths } from './lib/layoutDefaults'
import { WorkflowBar } from './components/WorkflowBar'
import { SideRail, type RailItem } from './components/SideRail'
import { storedPanelTab } from './lib/panelTabs'
import { PanelBoundary } from './components/PanelBoundary'
import { AutosaveRestoreModal } from './components/AutosaveRestoreModal'
import { AboutDialog } from './components/AboutDialog'
import { EnvCheckDialog } from './components/EnvCheckDialog'
import { projectToSave, useProjectStore } from './store/projectStore'
import { formatIpcError } from './lib/ipcError'
import { useAutosaveStore } from './store/autosaveStore'
import { useSettingsStore } from './store/settingsStore'
import { useKeyboardShortcuts } from './lib/useKeyboardShortcuts'
import { installModalFocusTrap } from './lib/modalFocus'
import {
  LayoutGridIcon,
  MediaIcon,
  YoutubeIcon,
  MicIcon,
  ImageIcon,
  MusicIcon,
  TargetIcon,
  MegaphoneIcon,
  StarIcon
} from './components/icons'
import { PRODUCT_NAME } from '@shared/product'

/** 左のパネル(レールで選ぶ) */
type LeftPanel =
  | 'media'
  | 'audio'
  | 'preset'
  | 'template'
  | 'narration'
  | 'thumbnail'
  | 'metadata'
  | 'youtube'
  | 'gametrend'

/** 右のインスペクタのタブ */
type RightTab = 'inspector' | 'text'

/** レールに並べるもの(よく使う順) */
const RAIL_ITEMS: RailItem[] = [
  {
    id: 'media',
    label: '素材',
    icon: MediaIcon,
    description: '読み込んだ素材(動画・音声・画像)とライブラリ'
  },
  {
    id: 'audio',
    label: 'BGM・SE',
    icon: MusicIcon,
    description: 'BGM・効果音ライブラリの検索と追加'
  },
  {
    id: 'preset',
    label: 'プリセット',
    icon: StarIcon,
    description: 'お気に入り登録したテロップスタイル・効果音の管理'
  },
  {
    id: 'template',
    label: 'テンプレート',
    icon: LayoutGridIcon,
    description: 'ショート動画のトレンド構成テンプレートを適用'
  }
]

/** レールの「その他」の中(用途ごと) */
const RAIL_MORE: { label: string; items: RailItem[] }[] = [
  {
    label: '素材づくり',
    items: [
      {
        id: 'narration',
        label: 'ボイス',
        icon: MicIcon,
        description: 'VOICEVOXによるナレーション音声合成'
      },
      {
        id: 'thumbnail',
        label: 'サムネイル',
        icon: ImageIcon,
        description: 'サムネイル画像の自動生成'
      }
    ]
  },
  {
    label: '投稿',
    items: [
      {
        id: 'metadata',
        label: '投稿準備',
        icon: MegaphoneIcon,
        description: '投稿用タイトル・概要欄・ハッシュタグの自動生成'
      },
      {
        id: 'youtube',
        label: 'YouTube',
        icon: YoutubeIcon,
        description: 'YouTubeトレンド・キーワード調査'
      },
      {
        id: 'gametrend',
        label: 'ゲームトレンド',
        icon: TargetIcon,
        description: 'ゲームトレンド分析(YouTube+Gemini)'
      }
    ]
  }
]

const LEFT_PANELS: readonly { id: LeftPanel; label: string }[] = [
  ...RAIL_ITEMS,
  ...RAIL_MORE.flatMap((g) => g.items)
].map(({ id, label }) => ({ id: id as LeftPanel, label }))

const RIGHT_TABS: readonly { id: RightTab; label: string; description: string }[] = [
  {
    id: 'inspector',
    label: 'プロパティ',
    description: '選択したクリップの尺・速度・フレーミング・繋ぎ・音声をまとめて編集'
  },
  { id: 'text', label: 'テロップ', description: 'テロップの一覧・追加・編集' }
]

/**
 * メニューバーの「ウィンドウ」に並べるパネル(右のタブと左のパネル)。
 * id は前の並び(window.inspector / window.text / window.audio …)のまま
 */
const MENU_WINDOWS = [
  { id: 'inspector', label: 'インスペクタ' },
  { id: 'text', label: 'テロップ' },
  ...LEFT_PANELS
]

const LEFT_PANEL_KEY = 've-left-panel'
const RIGHT_TAB_KEY = 've-right-tab'
/** 前の配置の「上段左のパネル」で選んでいたタブ(左右どちらかへ引き継ぐ) */
const OLD_PANEL_TAB_KEY = 've-panel-tab'

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function readLeftPanel(): LeftPanel {
  const old = readStored(OLD_PANEL_TAB_KEY)
  const fallback = old && LEFT_PANELS.some((p) => p.id === old) ? old : 'media'
  return storedPanelTab(readStored(LEFT_PANEL_KEY), LEFT_PANELS, fallback) as LeftPanel
}

function readRightTab(): RightTab {
  const old = readStored(OLD_PANEL_TAB_KEY)
  const fallback = old === 'text' ? 'text' : 'inspector'
  return storedPanelTab(readStored(RIGHT_TAB_KEY), RIGHT_TABS, fallback) as RightTab
}

function removeStored(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // 消せなくても今回は既定に戻る
  }
}

function storeValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 覚えられなくても今回は効く
  }
}

/**
 * 画面の配置(デザイン案 Main.dc.html)。区画の間は 1px の溝。
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ 上の帯 44px(工程・取り消し・書き出す)                 │
 *   ├────┬────────┬────────────────────────┬──────────┤
 *   │レール│ 左のパネル │ プログラム(ソース)            │ インスペクタ │
 *   │ 80 │  288    │                        │   312     │
 *   ├────┴────────┴────────────────────────┴──────────┤
 *   │ タイムライン(横いっぱい)                              │
 *   ├──────────────────────────────────────────────────────┤
 *   │ ステータスバー                                          │
 *   └──────────────────────────────────────────────────────┘
 *
 * 既定: 幅 1440 以上は 素材 288・インスペクタ 312、それ未満は 240・280。タイムラインの高さは中身
 * (トラックの合計 + 目盛り + スクロールバー)に合わせ、残りはプログラムに回す。
 * 溝をドラッグして変えた寸法だけを覚え、次回も使う(変えていない寸法は既定のまま窓・中身に付いていく)。
 */
const LEFT_WIDTH_KEY = 've-layout4-left-width'
const RIGHT_WIDTH_KEY = 've-layout4-right-width'
const BOTTOM_HEIGHT_KEY = 've-layout4-bottom-height'

const MIN_LEFT_WIDTH = 220
const MIN_RIGHT_WIDTH = 260
const RAIL_WIDTH = 80
const MIN_MONITOR_WIDTH = 360
const MIN_BOTTOM_HEIGHT = 180
const MIN_TOP_HEIGHT = 220
/** 上の帯 44・ステータスバー 24・溝 */
const CHROME_HEIGHT = 70

function readStoredSize(key: string): number | undefined {
  const raw = readStored(key)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface LayoutSize {
  left: number
  right: number
  bottom: number
}

/** 窓の大きさに収まるよう、3つの寸法を詰める(縮めた窓でプログラムやタイムラインが消えないように) */
function fitLayout(size: LayoutSize): LayoutSize {
  const w = window.innerWidth
  const h = window.innerHeight
  const room = w - RAIL_WIDTH - MIN_MONITOR_WIDTH
  const right = clamp(size.right, MIN_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, room - MIN_LEFT_WIDTH))
  return {
    right,
    left: clamp(size.left, MIN_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, room - right)),
    bottom: clamp(
      size.bottom,
      MIN_BOTTOM_HEIGHT,
      Math.max(MIN_BOTTOM_HEIGHT, h - MIN_TOP_HEIGHT - CHROME_HEIGHT)
    )
  }
}

interface ResizeDragState {
  kind: 'left' | 'right' | 'rows'
  startX: number
  startY: number
  start: LayoutSize
}

function App(): React.JSX.Element {
  const [left, setLeft] = useState<LeftPanel>(readLeftPanel)
  const [right, setRight] = useState<RightTab>(readRightTab)
  useEffect(() => storeValue(LEFT_PANEL_KEY, left), [left])
  useEffect(() => storeValue(RIGHT_TAB_KEY, right), [right])
  const projectName = useProjectStore((s) => s.project.name)
  // 試しに当てている間は、試す前の未保存の印(試しの案は保存しない)
  const isDirty = useProjectStore((s) => projectToSave(s).isDirty)
  const loadEnvApiKeys = useSettingsStore((s) => s.loadEnvApiKeys)
  const refreshAutosave = useAutosaveStore((s) => s.refresh)
  const sourceAssetId = useProjectStore((s) => s.sourceAssetId)

  // メニューバー(ファイル / 編集 / … / ウィンドウ)。ウィンドウの欄には左右のパネルを並べる
  useAppMenu(MENU_WINDOWS)

  // ダイアログを開いている間、Tab・フォーカスをダイアログの中に閉じ込める(裏のボタンを押せていた)
  useEffect(() => installModalFocusTrap(), [])

  // ウィンドウのタイトルにプロジェクト名と未保存の印を出す(Windows のソフトの決まり)
  useEffect(() => {
    document.title = `${projectName}${isDirty ? ' *' : ''} — ${PRODUCT_NAME}`
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
      const { project, isDirty } = projectToSave()
      // 見送った前回の自動保存を上書きする前に退避したときは、メニューの「破棄した自動保存
      // データを戻す」をすぐ使えるようにする。
      if (isDirty) {
        window.api.autosaveProject(project).then(
          (setAside) => {
            if (setAside) useAutosaveStore.getState().refreshDiscarded()
          },
          (err) => {
            // 書けなかったことを知らせる(黙っていると、落ちたときに戻せる作業が無いことに気付けない)。
            // 書く前に退避していることがあるので、復元のボタンも出し直す
            useAutosaveStore.getState().refreshDiscarded()
            useProjectStore
              .getState()
              .setSaveError(`自動保存に失敗しました: ${formatIpcError(err)}`)
          }
        )
      }
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  // 素材をソースで開いたら、中央をソースにする。閉じたらプログラムへ戻す
  const [monitor, setMonitor] = useState<'program' | 'source'>('program')
  const [prevSource, setPrevSource] = useState(sourceAssetId)
  if (prevSource !== sourceAssetId) {
    setPrevSource(sourceAssetId)
    setMonitor(sourceAssetId ? 'source' : 'program')
  }
  const showSource = monitor === 'source' && Boolean(sourceAssetId)
  // ソースとプログラムは同じ区画のタブ。プログラムが再生を始めたら(スペース・メニュー・タイムライン)
  // プログラムを見せる(隠れたまま音だけ鳴らさない)
  const programPlaying = useProjectStore((s) => s.isPlaying)
  const [prevPlaying, setPrevPlaying] = useState(programPlaying)
  if (prevPlaying !== programPlaying) {
    setPrevPlaying(programPlaying)
    if (programPlaying && monitor === 'source') setMonitor('program')
  }

  // メニューバーの「ウィンドウ」「テロップの一覧」で左右のパネルを切り替える
  useMenuCommand((id) => {
    const target = id.startsWith('window.')
      ? id.slice('window.'.length)
      : id === 'telop.list'
        ? 'text'
        : null
    if (!target) return
    if (RIGHT_TABS.some((t) => t.id === target)) setRight(target as RightTab)
    else if (LEFT_PANELS.some((p) => p.id === target)) setLeft(target as LeftPanel)
  })

  // 溝をドラッグして決めた寸法(決めていなければ既定)
  const [userSize, setUserSize] = useState<Partial<LayoutSize>>(() => ({
    left: readStoredSize(LEFT_WIDTH_KEY),
    right: readStoredSize(RIGHT_WIDTH_KEY),
    bottom: readStoredSize(BOTTOM_HEIGHT_KEY)
  }))
  // タイムラインの中身の高さ(Timeline が測って知らせる)
  const [timelineNatural, setTimelineNatural] = useState<number | null>(null)
  // 窓の大きさ(変われば詰め直す)
  const [windowSize, setWindowSize] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight
  }))
  const sideDefaults = defaultSideWidths(windowSize.w)
  const size = fitLayout({
    left: userSize.left ?? sideDefaults.left,
    right: userSize.right ?? sideDefaults.right,
    bottom:
      userSize.bottom ??
      autoBottomHeight(windowSize.h, CHROME_HEIGHT, MIN_BOTTOM_HEIGHT, timelineNatural)
  })
  // 溝のダブルクリック: 覚えた寸法を消して既定(タイムラインは中身に合わせる自動)へ戻す
  const resetSize = (key: keyof LayoutSize): void => {
    setUserSize((u) => ({ ...u, [key]: undefined }))
    removeStored(
      key === 'left' ? LEFT_WIDTH_KEY : key === 'right' ? RIGHT_WIDTH_KEY : BOTTOM_HEIGHT_KEY
    )
  }
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
      const next = fitLayout(
        resizeDrag.kind === 'left'
          ? { ...s, left: s.left + dx }
          : resizeDrag.kind === 'right'
            ? { ...s, right: s.right - dx }
            : { ...s, bottom: s.bottom - dy }
      )
      const key = resizeDrag.kind === 'rows' ? 'bottom' : resizeDrag.kind
      setUserSize((u) => ({ ...u, [key]: next[key] }))
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

  // ドラッグして決めた寸法だけを覚える
  useEffect(() => {
    if (userSize.left !== undefined) storeValue(LEFT_WIDTH_KEY, String(Math.round(userSize.left)))
    if (userSize.right !== undefined)
      storeValue(RIGHT_WIDTH_KEY, String(Math.round(userSize.right)))
    if (userSize.bottom !== undefined)
      storeValue(BOTTOM_HEIGHT_KEY, String(Math.round(userSize.bottom)))
  }, [userSize])

  // 窓そのものの大きさが変わったら詰め直す(前回の大きさのまま狭い窓で開いたときも)
  useEffect(() => {
    const handleWindowResize = (): void =>
      setWindowSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

  useKeyboardShortcuts()

  // 左のパネルの中身。どれも閉じずに隠すだけ(AI・API の頼みを走らせたまま、戻れば結果が残る)
  const leftPane = (id: LeftPanel, name: string, node: React.ReactNode): React.JSX.Element => (
    <div className={`tab-pane ${left === id ? 'active' : ''}`}>
      <PanelBoundary name={name}>{node}</PanelBoundary>
    </div>
  )

  return (
    <div className="app-shell">
      <PanelBoundary name="作業の流れ">
        <WorkflowBar
          telopOpen={right === 'text'}
          // 「編集」はインスペクタのプロパティへ戻す
          onEdit={() => setRight('inspector')}
          onTelop={() => setRight('text')}
        />
      </PanelBoundary>
      <div className="ve-workspace">
        <div className="ve-upper">
          <PanelBoundary name="レール">
            <SideRail
              items={RAIL_ITEMS}
              more={RAIL_MORE}
              current={left}
              onSelect={(id) => setLeft(id as LeftPanel)}
            />
          </PanelBoundary>
          {/* All tab panels stay mounted (hidden via CSS) rather than being unmounted on
              switch, so an in-progress AI/API request (Gemini, VOICEVOX, YouTube, etc.) in
              one tab keeps running and its result is still there when the user comes back,
              instead of being silently discarded by switching tabs to do something else. */}
          <section
            className="frame ve-left"
            style={{ width: size.left }}
            aria-label={LEFT_PANELS.find((p) => p.id === left)?.label}
          >
            <div className="tab-content">
              {leftPane('media', '素材', <MediaBin />)}
              {leftPane('audio', '音源', <AudioLibraryPanel />)}
              {leftPane('preset', 'プリセット', <PresetPanel />)}
              {leftPane('template', 'テンプレート', <TemplatePanel />)}
              {leftPane('narration', 'ナレーション', <NarrationPanel />)}
              {leftPane('thumbnail', 'サムネイル', <ThumbnailPanel />)}
              {leftPane('metadata', 'メタデータ', <MetadataPanel />)}
              {leftPane('youtube', 'YouTube トレンド', <YouTubeTrendPanel />)}
              {leftPane('gametrend', 'ゲームトレンド', <GameTrendPanel />)}
            </div>
          </section>
          <div
            className={`split-handle split-col ${resizeDrag?.kind === 'left' ? 'active' : ''}`}
            onMouseDown={(e) => beginResize('left', e)}
            onDoubleClick={() => resetSize('left')}
            title="ドラッグして幅を調整(ダブルクリックで既定の幅)"
          />
          <section className="frame frame-monitor ve-program" aria-label="プログラム">
            <div className="ve-panel-head">
              {!sourceAssetId && <h2 className="ve-panel-title">プログラム</h2>}
              <div
                className={`panel-tabs-list ${sourceAssetId ? '' : 've-visually-hidden'}`}
                role="tablist"
                aria-label="モニター"
              >
                {sourceAssetId && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={showSource}
                    className={`panel-tab ${showSource ? 'active' : ''}`}
                    title="素材をソースで確認する"
                    onClick={() => setMonitor('source')}
                  >
                    ソース
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={!showSource}
                  className={`panel-tab ${showSource ? '' : 'active'}`}
                  onClick={() => setMonitor('program')}
                >
                  プログラム
                </button>
              </div>
            </div>
            <div className="tab-content">
              {/* Keyed by asset so switching clips remounts the viewer: transport position,
                  play state and shuttle speed all belong to the clip being auditioned and
                  must not carry over to the next one. */}
              <div className={`tab-pane ${showSource ? 'active' : ''}`}>
                {sourceAssetId && (
                  <PanelBoundary key={sourceAssetId} name="ソース">
                    <SourceViewer key={sourceAssetId} />
                  </PanelBoundary>
                )}
              </div>
              <div className={`tab-pane ve-program-pane ${showSource ? '' : 'active'}`}>
                <PanelBoundary name="プログラムモニター">
                  <PreviewPlayer />
                </PanelBoundary>
              </div>
            </div>
          </section>
          <div
            className={`split-handle split-col ${resizeDrag?.kind === 'right' ? 'active' : ''}`}
            onMouseDown={(e) => beginResize('right', e)}
            onDoubleClick={() => resetSize('right')}
            title="ドラッグして幅を調整(ダブルクリックで既定の幅)"
          />
          <aside
            className="frame ve-inspector"
            style={{ width: size.right }}
            aria-label="インスペクタ"
          >
            <div className="ve-panel-head">
              {/* 中身は工程で決まる(編集 → プロパティ・テロップ → テロップの一覧)。タブは重ねて置かない */}
              <h2
                className="ve-panel-title"
                title={RIGHT_TABS.find((t) => t.id === right)?.description}
              >
                {RIGHT_TABS.find((t) => t.id === right)?.label}
              </h2>
            </div>
            <div className="tab-content">
              <div className={`tab-pane ${right === 'inspector' ? 'active' : ''}`}>
                <PanelBoundary name="インスペクタ">
                  <Inspector />
                </PanelBoundary>
              </div>
              <div className={`tab-pane ${right === 'text' ? 'active' : ''}`}>
                <PanelBoundary name="テロップ">
                  <TextOverlayPanel />
                </PanelBoundary>
              </div>
            </div>
          </aside>
        </div>

        <div
          className={`split-handle split-row ${resizeDrag?.kind === 'rows' ? 'active' : ''}`}
          onMouseDown={(e) => beginResize('rows', e)}
          onDoubleClick={() => resetSize('bottom')}
          title="ドラッグして高さを調整(ダブルクリックで中身に合わせる)"
        />

        <section className="frame frame-timeline ve-timeline" style={{ height: size.bottom }}>
          <PanelBoundary name="タイムライン">
            <Timeline onNaturalHeight={setTimelineNatural} />
          </PanelBoundary>
        </section>
      </div>
      <PanelBoundary name="ステータスバー">
        <StatusBar />
      </PanelBoundary>
      <PanelBoundary name="書き出し">
        <ExportDialog />
      </PanelBoundary>
      <PanelBoundary name="テロップのスタイル">
        <TelopStyleDialog />
      </PanelBoundary>
      <PanelBoundary name="新しい回">
        <NewEpisodeDialog />
      </PanelBoundary>
      <PanelBoundary name="自動編集">
        <AutoEditScreen />
      </PanelBoundary>
      <PanelBoundary name="自動保存の復元">
        <AutosaveRestoreModal />
      </PanelBoundary>
      <PanelBoundary name="バージョン情報">
        <AboutDialog />
        <EnvCheckDialog />
      </PanelBoundary>
    </div>
  )
}

export default App
