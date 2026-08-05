import { useMemo, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import { useSfxDictionaryStore } from '../store/sfxDictionaryStore'
import { detectKeywordSeMatches } from '../lib/keywordSe'
import { formatIpcError } from '../lib/ipcError'
import { WandIcon, PlusIcon } from './icons'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function KeywordSeModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const addAsset = useProjectStore((s) => s.addAsset)
  const addKeywordSeClips = useProjectStore((s) => s.addKeywordSeClips)
  const dictionary = useSfxDictionaryStore((s) => s.entries)

  const matches = useMemo(
    () => detectKeywordSeMatches(project.textOverlays, dictionary),
    [project.textOverlays, dictionary]
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set(matches.map((m) => m.id)))
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleApply(): Promise<void> {
    setApplying(true)
    setError(null)
    try {
      const chosen = matches.filter((m) => selected.has(m.id))
      const placements: {
        assetId: string
        startTime: number
        outPoint: number
        volume: number
      }[] = []
      const durationCache = new Map<string, number>()
      // The render-time `project` snapshot goes stale after each addAsset; without
      // this map, several matches on the same SE file would each fail the find and
      // register a duplicate asset for the same wav.
      const createdByPath = new Map(project.assets.map((a) => [a.filePath, a]))
      for (const match of chosen) {
        let asset = createdByPath.get(match.entry.filePath)
        if (!asset) {
          let duration = durationCache.get(match.entry.filePath)
          if (duration === undefined) {
            const meta = await window.api.probeMedia(match.entry.filePath)
            duration = meta.duration
            durationCache.set(match.entry.filePath, duration)
          }
          asset = {
            id: uuid(),
            filePath: match.entry.filePath,
            fileName: match.entry.fileName,
            duration,
            width: 0,
            height: 0,
            fps: 0,
            hasAudio: true,
            hasVideo: false
          }
          addAsset(asset)
          createdByPath.set(asset.filePath, asset)
        }
        placements.push({
          assetId: asset.id,
          startTime: match.time,
          outPoint: asset.duration,
          volume: match.entry.volume
        })
      }
      addKeywordSeClips(placements)
      onClose()
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal keyword-se-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <WandIcon width={15} height={15} />
          キーワード連動SEをスキャン
        </h3>
        <p className="hint-text">
          すべてのテロップから辞書に登録したキーワードを検索し、一致した箇所に効果音を自動配置します。チェックを外すと配置対象から除外できます。
        </p>
        {error && <p className="error-text">{error}</p>}
        {dictionary.length === 0 && (
          <p className="hint-text">
            辞書が空です。「プリセット」タブでキーワードと効果音の組み合わせを登録してください。
          </p>
        )}
        {dictionary.length > 0 && matches.length === 0 && (
          <p className="hint-text">一致するキーワードが見つかりませんでした。</p>
        )}
        {matches.length > 0 && (
          <>
            <p className="hint-text">
              選択中: {selected.size} / {matches.length} 件
            </p>
            <div className="highlight-list keyword-se-list">
              {matches.map((m) => (
                <div key={m.id} className="highlight-item">
                  <input
                    type="checkbox"
                    checked={selected.has(m.id)}
                    onChange={() => toggle(m.id)}
                  />
                  <div className="highlight-item-info">
                    <span className="highlight-item-time">{formatTime(m.time)}</span>
                    <span className="keyword-se-keyword">「{m.keyword}」</span>
                    <span className="hint-text keyword-se-context" title={m.contextText}>
                      {m.contextText}
                    </span>
                    <span className="hint-text">→ {m.entry.fileName}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button
            className="primary-button"
            onClick={handleApply}
            disabled={applying || selected.size === 0}
          >
            <PlusIcon width={13} height={13} />
            {applying ? '配置中...' : 'タイムラインに配置'}
          </button>
        </div>
      </div>
    </div>
  )
}
