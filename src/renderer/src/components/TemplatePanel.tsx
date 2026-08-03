import { editTemplates } from '@shared/templates'
import { useProjectStore } from '../store/projectStore'
import { SparklesIcon } from './icons'

export function TemplatePanel(): React.JSX.Element {
  const applyTemplate = useProjectStore((s) => s.applyTemplate)
  const clipCount = useProjectStore((s) => s.project.clips.length)

  return (
    <div className="panel template-panel">
      <div className="panel-header">
        <h2>トレンド構成テンプレート</h2>
      </div>
      <p className="hint-text">
        ショート動画でよく使われる構成パターンです。適用するとアスペクト比が9:16になり、字幕プレースホルダーが自動配置されます(テキストは後で編集できます)。
      </p>
      <div className="template-list">
        {editTemplates.map((t) => (
          <div key={t.id} className="template-card">
            <h3>
              <SparklesIcon width={14} height={14} className="template-card-icon" />
              {t.name}
            </h3>
            <p>{t.description}</p>
            <ul>
              {t.segments.map((seg, i) => (
                <li key={i}>
                  <strong>{seg.label}</strong>({seg.durationHint}): {seg.suggestion}
                </li>
              ))}
            </ul>
            <button
              className="primary-button"
              disabled={clipCount === 0}
              onClick={() => applyTemplate(t)}
            >
              このテンプレートを適用
            </button>
          </div>
        ))}
      </div>
      {clipCount === 0 && <p className="hint-text">先にタイムラインへクリップを追加してください</p>}
    </div>
  )
}
