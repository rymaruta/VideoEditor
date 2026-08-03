import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import { usePresetStore, CaptionPreset, SePreset } from '../store/presetStore'
import { useSfxDictionaryStore } from '../store/sfxDictionaryStore'
import { formatIpcError } from '../lib/ipcError'
import { KeywordSeModal } from './KeywordSeModal'
import { PlusIcon, TrashIcon, TypeIcon, MusicIcon, StarIcon, WandIcon } from './icons'

export function PresetPanel(): React.JSX.Element {
  const captionPresets = usePresetStore((s) => s.captionPresets)
  const removeCaptionPreset = usePresetStore((s) => s.removeCaptionPreset)
  const sePresets = usePresetStore((s) => s.sePresets)
  const removeSePreset = usePresetStore((s) => s.removeSePreset)

  const dictionaryEntries = useSfxDictionaryStore((s) => s.entries)
  const addDictionaryEntry = useSfxDictionaryStore((s) => s.addEntry)
  const updateDictionaryEntry = useSfxDictionaryStore((s) => s.updateEntry)
  const removeDictionaryEntry = useSfxDictionaryStore((s) => s.removeEntry)

  const project = useProjectStore((s) => s.project)
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const addTextOverlay = useProjectStore((s) => s.addTextOverlay)
  const addAsset = useProjectStore((s) => s.addAsset)
  const addAudioTrack = useProjectStore((s) => s.addAudioTrack)
  const addClipToAudioTrack = useProjectStore((s) => s.addClipToAudioTrack)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newKeyword, setNewKeyword] = useState('')
  const [newEntrySePresetId, setNewEntrySePresetId] = useState('')
  const [showKeywordSeModal, setShowKeywordSeModal] = useState(false)

  function handleAddDictionaryEntry(): void {
    const keyword = newKeyword.trim()
    const preset = sePresets.find((p) => p.id === newEntrySePresetId)
    if (!keyword || !preset) return
    addDictionaryEntry(keyword, preset.filePath, preset.fileName)
    setNewKeyword('')
  }

  function handleAddCaption(preset: CaptionPreset): void {
    addTextOverlay({
      text: preset.name,
      startTime: playheadTime,
      endTime: playheadTime + 3,
      style: { ...preset.style },
      source: 'manual'
    })
  }

  async function handleAddSe(preset: SePreset): Promise<void> {
    setBusyId(preset.id)
    setError(null)
    try {
      let asset = project.assets.find((a) => a.filePath === preset.filePath)
      if (!asset) {
        const meta = await window.api.probeMedia(preset.filePath)
        asset = {
          id: uuid(),
          filePath: preset.filePath,
          fileName: preset.fileName,
          duration: meta.duration,
          width: 0,
          height: 0,
          fps: 0,
          hasAudio: true,
          hasVideo: false
        }
        addAsset(asset)
      }
      let track = useProjectStore.getState().project.audioTracks.find((t) => t.name === 'SE')
      if (!track) {
        addAudioTrack('SE')
        track = useProjectStore.getState().project.audioTracks.find((t) => t.name === 'SE')
      }
      if (track) {
        addClipToAudioTrack(track.id, asset.id)
      }
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="panel preset-panel">
      <div className="panel-header">
        <h2>マイプリセット</h2>
      </div>
      <p className="hint-text">
        よく使うテロップのスタイルや効果音をお気に入り登録しておくと、ここからワンクリックで追加できます。テロップは「テキスト」タブの各テロップ、効果音は「BGM/SE」タブの検索結果から★ボタンで登録できます。
      </p>
      {error && <p className="error-text">{error}</p>}

      <div className="preset-section">
        <h3>
          <TypeIcon width={13} height={13} />
          テロップスタイル
        </h3>
        {captionPresets.length === 0 && <p className="hint-text">まだ登録されていません。</p>}
        {captionPresets.map((preset) => (
          <div key={preset.id} className="preset-item">
            <div className="preset-item-info">
              <span className="preset-item-name">{preset.name}</span>
              <span
                className="preset-caption-preview"
                style={{
                  color: preset.style.color,
                  fontFamily: preset.style.fontFamily,
                  fontWeight: preset.style.bold ? 700 : 400,
                  fontStyle: preset.style.italic ? 'italic' : 'normal'
                }}
              >
                {preset.name || 'サンプル'}
              </span>
              <span className="hint-text">
                {preset.style.fontSize}px ・{' '}
                {preset.style.animation === 'none' ? 'アニメーションなし' : preset.style.animation}
              </span>
            </div>
            <div className="preset-item-actions">
              <button
                className="icon-button"
                title="現在の再生位置に新規テロップとして追加"
                onClick={() => handleAddCaption(preset)}
              >
                <PlusIcon width={13} height={13} />
              </button>
              <button
                className="icon-button danger"
                title="削除"
                onClick={() => removeCaptionPreset(preset.id)}
              >
                <TrashIcon width={13} height={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="preset-section">
        <h3>
          <MusicIcon width={13} height={13} />
          効果音(SE)お気に入り
        </h3>
        {sePresets.length === 0 && <p className="hint-text">まだ登録されていません。</p>}
        {sePresets.map((preset) => (
          <div key={preset.id} className="preset-item">
            <div className="preset-item-info">
              <span className="preset-item-name">
                <StarIcon width={11} height={11} />
                {preset.name}
              </span>
            </div>
            <div className="preset-item-actions">
              <button
                className="icon-button"
                title="音声トラック「SE」に追加"
                disabled={busyId === preset.id}
                onClick={() => handleAddSe(preset)}
              >
                {busyId === preset.id ? '...' : <PlusIcon width={13} height={13} />}
              </button>
              <button
                className="icon-button danger"
                title="削除"
                onClick={() => removeSePreset(preset.id)}
              >
                <TrashIcon width={13} height={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="preset-section">
        <h3>
          <WandIcon width={13} height={13} />
          キーワード連動SE辞書
        </h3>
        <p className="hint-text">
          テロップ内に登録した単語が現れると、そのタイミングに指定した効果音を自動配置できます。効果音は上の「効果音(SE)お気に入り」から選びます。
        </p>
        {dictionaryEntries.length === 0 && <p className="hint-text">まだ登録されていません。</p>}
        {dictionaryEntries.map((entry) => (
          <div key={entry.id} className="preset-item">
            <div className="preset-item-info">
              <span className="preset-item-name">
                「{entry.keyword}」→ {entry.fileName}
              </span>
              <label className="keyword-se-volume-row hint-text">
                音量
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={entry.volume}
                  onChange={(e) =>
                    updateDictionaryEntry(entry.id, { volume: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className="preset-item-actions">
              <button
                className="icon-button danger"
                title="削除"
                onClick={() => removeDictionaryEntry(entry.id)}
              >
                <TrashIcon width={13} height={13} />
              </button>
            </div>
          </div>
        ))}
        <div className="overlay-item-row keyword-se-add-row">
          <input
            type="text"
            className="overlay-preset-name-input"
            placeholder="キーワード(例: ドーン)"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
          />
          <select
            value={newEntrySePresetId}
            onChange={(e) => setNewEntrySePresetId(e.target.value)}
          >
            <option value="">効果音を選択</option>
            {sePresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            title="辞書に追加"
            disabled={!newKeyword.trim() || !newEntrySePresetId}
            onClick={handleAddDictionaryEntry}
          >
            <PlusIcon width={13} height={13} />
          </button>
        </div>
        <button
          className="primary-button keyword-se-scan-button"
          disabled={dictionaryEntries.length === 0}
          onClick={() => setShowKeywordSeModal(true)}
        >
          <WandIcon width={13} height={13} />
          テロップをスキャンしてSEを配置
        </button>
      </div>

      {showKeywordSeModal && <KeywordSeModal onClose={() => setShowKeywordSeModal(false)} />}
    </div>
  )
}
