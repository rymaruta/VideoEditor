import { useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { getTotalDuration, useProjectStore } from '../store/projectStore'
import { usePresetStore, CaptionPreset, SePreset } from '../store/presetStore'
import { useSfxDictionaryStore } from '../store/sfxDictionaryStore'
import { SFX_DRAG_TYPE } from '../lib/assetDrag'
import { formatIpcError } from '../lib/ipcError'
import { toFileUrl } from '../lib/previewSource'
import { newOverlayRange } from '../lib/textOverlayPlacement'
import { usePausePreviewWhenHidden } from '../lib/pausePreviewWhenHidden'
import { KeywordSeModal } from './KeywordSeModal'
import {
  PlusIcon,
  TrashIcon,
  TypeIcon,
  MusicIcon,
  StarIcon,
  WandIcon,
  PlayIcon,
  PauseIcon
} from './icons'

// Presets and the SE dictionary live in localStorage, outside the project's undo
// history — deleting one is permanent, so a single click on a small trash icon
// must not be the whole interaction.
function confirmDeletePreset(label: string): boolean {
  return confirm(`「${label}」を削除しますか?この操作は元に戻せません。`)
}

/**
 * 試聴に失敗したときの文面。**2つの経路(`play()` の失敗と要素の `error`)で同じ文を出す。**
 * 別々に書くと、同じ原因なのに押し方で違う文が出る。
 */
function previewFailedMessage(name?: string): string {
  const target = name ? `「${name}」` : 'この効果音'
  return `${target}を再生できませんでした。ファイルが移動・削除されていないか確認してください`
}

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
  // 再生位置は**押した瞬間に読む**(購読しない)。購読すると再生中は毎フレームこのパネル全体が
  // 描き直され、テロップが多い企画ほど重くなる(実測: テロップ1,000本・60分の企画で、
  // 再生中のフレーム間隔が 167ms=約6fps まで落ちていた。原因の大半がこの描き直し)。
  const addTextOverlay = useProjectStore((s) => s.addTextOverlay)
  const addAudioClipWithAsset = useProjectStore((s) => s.addAudioClipWithAsset)

  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * 試聴中のお気に入りの id。**追加ボタンの `busyId` とは分けている**——
   * 同じ入れ物を使うと、試聴しているだけで隣の「追加」まで押せなくなる。
   */
  const [playingId, setPlayingId] = useState<string | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement>(null)
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
      // 置く位置の規則は「テキスト」タブの追加と共通(片方だけ尺を超えて置けていた)
      ...newOverlayRange(useProjectStore.getState().playheadTime, getTotalDuration(project)),
      style: { ...preset.style },
      source: 'manual'
    })
  }

  /**
   * お気に入りの効果音を、**タイムラインに置かずに**その場で鳴らす。
   *
   * 「BGM/SE」タブの試聴は `downloadAudioAsset` で落としてから鳴らすが、
   * お気に入りは登録済みの `filePath` を既に持っているので、そのまま読ませる。
   * (ここを同じ経路にすると、ローカルのファイルをわざわざコピーしに行くことになる)
   *
   * **プロジェクトには一切触らない。** 追加と違ってクリップも素材も作らないので、
   * 取り消し履歴も動かない——試聴のたびに Undo が1つ積まれる、を起こさないこと。
   *
   * 鳴らす要素は1枚だけ使い回す。別のお気に入りを押したら前の音は自動で止まる
   * (2つ同時に鳴ると、どちらの音を聴いているのか分からなくなる)。
   */
  async function handlePreviewSe(preset: SePreset): Promise<void> {
    const el = previewAudioRef.current
    if (!el) return
    setError(null)
    // 鳴っているものをもう一度押したら止める(トグル)
    if (playingId === preset.id) {
      el.pause()
      setPlayingId(null)
      return
    }
    try {
      // `file://` + そのままのパスだと、空白や `#` を含むファイル名で読めない。
      // 組み立ては `toFileUrl` に任せる(プレビューの映像・音声と同じ関数)。
      el.src = toFileUrl(preset.filePath)
      el.currentTime = 0
      setPlayingId(preset.id)
      await el.play()
    } catch {
      // **生の英語を後ろに足さない。** `play()` が返すのは
      // 「Failed to load because no supported source was found.」のような
      // ブラウザの文言で、日本語の前置きを付けても利用者の次の一手は増えない
      // (増えるのは読む量だけ)。原因の切り分けに要る情報はここには無い。
      setPlayingId(null)
      setError(previewFailedMessage(preset.name))
    }
  }

  // 別のタブへ移ったら試聴を止める。規則は共通の置き場(理由は pausePreviewWhenHidden)。
  const panelRef = useRef<HTMLDivElement>(null)
  usePausePreviewWhenHidden(panelRef, previewAudioRef, () => setPlayingId(null))

  async function handleAddSe(preset: SePreset): Promise<void> {
    setBusyId(preset.id)
    setError(null)
    try {
      const known = project.assets.find((a) => a.filePath === preset.filePath)
      const duration = known?.duration ?? (await window.api.probeMedia(preset.filePath)).duration
      // Asset + track + clip as one undoable step (the store reuses the asset when
      // this sound effect is already in the project).
      addAudioClipWithAsset(
        {
          id: known?.id ?? uuid(),
          filePath: preset.filePath,
          fileName: preset.fileName,
          duration,
          width: 0,
          height: 0,
          fps: 0,
          hasAudio: true,
          hasVideo: false
        },
        // テロップのプリセットと同じく再生位置へ置く。そこが埋まっていれば直後へずれる。
        { trackName: 'SE', startTime: useProjectStore.getState().playheadTime }
      )
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="panel preset-panel" ref={panelRef}>
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
                onClick={() => {
                  if (confirmDeletePreset(preset.name)) removeCaptionPreset(preset.id)
                }}
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
        {/* 試聴用の1枚。鳴り終わったら再生中の印を戻す(押しっぱなしの見た目にしない)。
            読み込めなかったときは `play()` の失敗を待たずにここで拾う——ファイルが
            無いと `play()` が解決してしまい、無言で「再生中」のまま止まることがある。 */}
        <audio
          ref={previewAudioRef}
          style={{ display: 'none' }}
          onEnded={() => setPlayingId(null)}
          onError={() => {
            setError(previewFailedMessage(sePresets.find((p) => p.id === playingId)?.name))
            setPlayingId(null)
          }}
        />
        {sePresets.map((preset) => (
          <div
            key={preset.id}
            className="preset-item"
            // 音声トラックへ直接落とせるようにする。ボタンは再生位置に置くので、
            // 「別の場所へ置きたい」ときに一度置いてから動かす手間が消える。
            draggable
            title="音声トラックへドラッグすると、落とした位置に効果音を置きます"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData(
                SFX_DRAG_TYPE,
                JSON.stringify({ filePath: preset.filePath, fileName: preset.fileName })
              )
            }}
          >
            <div className="preset-item-info">
              <span className="preset-item-name">
                <StarIcon width={11} height={11} />
                {preset.name}
              </span>
            </div>
            <div className="preset-item-actions">
              <button
                className="icon-button"
                title={
                  playingId === preset.id
                    ? '試聴を止める'
                    : 'タイムラインに置かずに、この効果音を鳴らして確かめる'
                }
                onClick={() => handlePreviewSe(preset)}
              >
                {playingId === preset.id ? (
                  <PauseIcon width={13} height={13} />
                ) : (
                  <PlayIcon width={13} height={13} />
                )}
              </button>
              <button
                className="icon-button"
                title="現在の再生位置に効果音を追加(音声トラック「SE」。その位置が埋まっていれば重ならない直後へずらします)"
                disabled={busyId === preset.id}
                onClick={() => handleAddSe(preset)}
              >
                {busyId === preset.id ? '...' : <PlusIcon width={13} height={13} />}
              </button>
              <button
                className="icon-button danger"
                title="削除"
                onClick={() => {
                  if (confirmDeletePreset(preset.name)) removeSePreset(preset.id)
                }}
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
                onClick={() => {
                  if (confirmDeletePreset(entry.keyword)) removeDictionaryEntry(entry.id)
                }}
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
