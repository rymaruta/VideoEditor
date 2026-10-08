import { playableOnMain } from '../lib/relinkCheck'
import { useMemo, useState } from 'react'
import { editTemplates } from '@shared/templates'
import { useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import { SparklesIcon, TargetIcon } from './icons'

export function TemplatePanel(): React.JSX.Element {
  const applyTemplate = useProjectStore((s) => s.applyTemplate)
  const autoCutFromCandidates = useProjectStore((s) => s.autoCutFromCandidates)
  const clipCount = useProjectStore((s) => s.project.clips.length)
  const overlayCount = useProjectStore((s) => s.project.textOverlays.length)
  const assets = useProjectStore((s) => s.project.assets)
  const videoAssets = useMemo(() => assets.filter(playableOnMain), [assets])
  const [autoCutting, setAutoCutting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Both actions overwrite the existing captions with the template's placeholder
  // labels, and 自動カット rebuilds the whole clip list — losing auto-generated
  // subtitles and a trimmed timeline in one click is not something to do silently.
  function confirmDiscard(replacesClips: boolean): boolean {
    const losses: string[] = []
    if (overlayCount > 0) losses.push(`テロップ${overlayCount}件`)
    if (replacesClips && clipCount > 0) losses.push(`現在のタイムライン(${clipCount}クリップ)`)
    if (losses.length === 0) return true
    return confirm(
      `${losses.join('と')}はテンプレートの内容に置き換えられます。続行しますか?\n(元に戻すで取り消せます)`
    )
  }

  function handleApplyTemplate(template: (typeof editTemplates)[number]): void {
    if (!confirmDiscard(Boolean(template.jumpCutSeconds))) return
    applyTemplate(template)
  }

  async function handleAutoCut(templateId: string): Promise<void> {
    const template = editTemplates.find((t) => t.id === templateId)
    if (!template) return
    if (!confirmDiscard(true)) return
    setError(null)
    setAutoCutting(templateId)
    // 検出を待つ間に別の企画を開いたら当てない(開いた企画の本編・テロップ・縦横比を置き換えていた)
    const session = useProjectStore.getState().projectSession
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
      if (useProjectStore.getState().projectSession !== session) return
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
        ショート動画でよく使われる構成パターンです。適用するとアスペクト比が9:16になり、字幕プレースホルダーが自動配置されます(テキストは後で編集できます)。既にテロップがある場合は置き換えられるため、実行前に確認が表示されます。
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
                onClick={() => handleApplyTemplate(t)}
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
