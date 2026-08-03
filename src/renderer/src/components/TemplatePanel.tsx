import { useMemo, useState } from 'react'
import { editTemplates } from '@shared/templates'
import { useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import { SparklesIcon, TargetIcon } from './icons'

export function TemplatePanel(): React.JSX.Element {
  const applyTemplate = useProjectStore((s) => s.applyTemplate)
  const autoCutFromCandidates = useProjectStore((s) => s.autoCutFromCandidates)
  const clipCount = useProjectStore((s) => s.project.clips.length)
  const assets = useProjectStore((s) => s.project.assets)
  const videoAssets = useMemo(() => assets.filter((a) => a.hasVideo), [assets])
  const [autoCutting, setAutoCutting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAutoCut(templateId: string): Promise<void> {
    const template = editTemplates.find((t) => t.id === templateId)
    if (!template) return
    setError(null)
    setAutoCutting(templateId)
    try {
      const allPicks: { assetId: string; start: number; end: number; score: number }[] = []
      for (const asset of videoAssets) {
        const candidates = await window.api.detectHighlights(asset.filePath, asset.duration)
        for (const c of candidates) {
          allPicks.push({ assetId: asset.id, start: c.start, end: c.end, score: c.score })
        }
      }
      if (allPicks.length === 0) {
        setError('ハイライトを検出できませんでした。素材を確認してください。')
        return
      }
      const slotCount = Math.max(1, template.segments.length)
      const assetOrder = new Map(videoAssets.map((a, i) => [a.id, i]))
      const chosen = allPicks
        .sort((a, b) => b.score - a.score)
        .slice(0, slotCount)
        .sort(
          (a, b) =>
            (assetOrder.get(a.assetId) ?? 0) - (assetOrder.get(b.assetId) ?? 0) || a.start - b.start
        )
      autoCutFromCandidates(chosen, template)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setAutoCutting(null)
    }
  }

  return (
    <div className="panel template-panel">
      <div className="panel-header">
        <h2>トレンド構成テンプレート</h2>
      </div>
      <p className="hint-text">
        ショート動画でよく使われる構成パターンです。適用するとアスペクト比が9:16になり、字幕プレースホルダーが自動配置されます(テキストは後で編集できます)。
      </p>
      {error && <p className="error-text">{error}</p>}
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
            <div className="template-card-actions">
              <button
                className="primary-button"
                disabled={clipCount === 0}
                onClick={() => applyTemplate(t)}
              >
                このテンプレートを適用
              </button>
              <button
                className="small-button"
                disabled={videoAssets.length === 0 || autoCutting !== null}
                onClick={() => handleAutoCut(t.id)}
                title="メディアの素材からハイライトを検出し、自動でタイムラインを組み立てます"
              >
                <TargetIcon width={13} height={13} />
                {autoCutting === t.id ? '解析中...' : '素材から自動カット'}
              </button>
            </div>
          </div>
        ))}
      </div>
      {clipCount === 0 && videoAssets.length === 0 && (
        <p className="hint-text">先にメディアを追加してください</p>
      )}
    </div>
  )
}
