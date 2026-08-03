import { useState } from 'react'
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
import { ProjectMenu } from './components/ProjectMenu'
import { useProjectStore } from './store/projectStore'
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
  MusicIcon
} from './components/icons'
import type { SVGProps } from 'react'

type RightTab = 'template' | 'text' | 'narration' | 'thumbnail' | 'audio' | 'youtube' | 'export'

const TABS: {
  id: RightTab
  label: string
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element
}[] = [
  { id: 'template', label: 'テンプレート', icon: SparklesIcon },
  { id: 'text', label: 'テキスト', icon: TypeIcon },
  { id: 'narration', label: 'ボイス', icon: MicIcon },
  { id: 'thumbnail', label: 'サムネ', icon: ImageIcon },
  { id: 'audio', label: 'BGM/SE', icon: MusicIcon },
  { id: 'youtube', label: 'YouTube', icon: YoutubeIcon },
  { id: 'export', label: '書き出し', icon: DownloadIcon }
]

function App(): React.JSX.Element {
  const [tab, setTab] = useState<RightTab>('template')
  const projectName = useProjectStore((s) => s.project.name)
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio)
  const canUndo = useProjectStore((s) => s.past.length > 0)
  const canRedo = useProjectStore((s) => s.future.length > 0)
  const undo = useProjectStore((s) => s.undo)
  const redo = useProjectStore((s) => s.redo)
  const isDirty = useProjectStore((s) => s.isDirty)

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
        <div className="left-column">
          <MediaBin />
        </div>
        <div className="center-column">
          <PreviewPlayer />
          <Timeline />
        </div>
        <div className="right-column">
          <div className="tab-bar">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
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
            {tab === 'youtube' && <YouTubeTrendPanel />}
            {tab === 'export' && <ExportPanel />}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
