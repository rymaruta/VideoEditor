import { useState } from 'react'
import { MediaBin } from './components/MediaBin'
import { PreviewPlayer } from './components/PreviewPlayer'
import { Timeline } from './components/Timeline'
import { TemplatePanel } from './components/TemplatePanel'
import { TextOverlayPanel } from './components/TextOverlayPanel'
import { YouTubeTrendPanel } from './components/YouTubeTrendPanel'
import { ExportPanel } from './components/ExportPanel'

type RightTab = 'template' | 'text' | 'youtube' | 'export'

function App(): React.JSX.Element {
  const [tab, setTab] = useState<RightTab>('template')

  return (
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
          <button className={tab === 'template' ? 'active' : ''} onClick={() => setTab('template')}>
            テンプレート
          </button>
          <button className={tab === 'text' ? 'active' : ''} onClick={() => setTab('text')}>
            テキスト
          </button>
          <button className={tab === 'youtube' ? 'active' : ''} onClick={() => setTab('youtube')}>
            YouTube
          </button>
          <button className={tab === 'export' ? 'active' : ''} onClick={() => setTab('export')}>
            書き出し
          </button>
        </div>
        <div className="tab-content">
          {tab === 'template' && <TemplatePanel />}
          {tab === 'text' && <TextOverlayPanel />}
          {tab === 'youtube' && <YouTubeTrendPanel />}
          {tab === 'export' && <ExportPanel />}
        </div>
      </div>
    </div>
  )
}

export default App
