import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import type { VoicevoxSpeaker } from '@shared/types'
import { formatIpcError } from '../lib/ipcError'
import { MicIcon, WandIcon } from './icons'

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

export function NarrationPanel(): React.JSX.Element {
  const audioTracks = useProjectStore((s) => s.project.audioTracks)
  const addAudioClipWithAsset = useProjectStore((s) => s.addAudioClipWithAsset)

  const [speakers, setSpeakers] = useState<VoicevoxSpeaker[]>([])
  const [connError, setConnError] = useState<string | null>(null)
  const [loadingSpeakers, setLoadingSpeakers] = useState(true)
  const [styleId, setStyleId] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [trackId, setTrackId] = useState<string>('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMessage, setDoneMessage] = useState<string | null>(null)

  function loadSpeakers(): void {
    setLoadingSpeakers(true)
    setConnError(null)
    window.api
      .voicevoxListSpeakers()
      .then((list) => {
        setSpeakers(list)
        const zundamon = list.find((s) => s.name.includes('ずんだもん'))
        const firstStyle = (zundamon ?? list[0])?.styles[0]
        if (firstStyle) setStyleId(firstStyle.id)
      })
      .catch((e) => setConnError(formatIpcError(e)))
      .finally(() => setLoadingSpeakers(false))
  }

  useEffect(() => {
    // Kicks off an async IPC call to check for a locally running VOICEVOX Engine on mount —
    // an external system fetch, not state derivable from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSpeakers()
  }, [])

  async function handleGenerate(): Promise<void> {
    if (!text.trim() || styleId === null) return
    setError(null)
    setDoneMessage(null)
    setGenerating(true)
    try {
      const filePath = await window.api.voicevoxSynthesize(text, styleId)
      const meta = await window.api.probeMedia(filePath)
      // Asset + track + clip as one undoable step, so a single undo doesn't leave
      // an empty narration track and an unused asset behind.
      addAudioClipWithAsset(
        {
          id: uuid(),
          filePath,
          fileName: fileNameFromPath(filePath),
          duration: meta.duration,
          width: 0,
          height: 0,
          fps: 0,
          hasAudio: true,
          hasVideo: false
        },
        { trackId: trackId || undefined, trackName: 'ナレーション' }
      )
      setDoneMessage('ナレーションを音声トラックに追加しました。')
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="panel narration-panel">
      <div className="panel-header">
        <h2>ナレーション音声合成</h2>
      </div>
      <p className="hint-text">
        VOICEVOX(無料の音声合成ソフト)と連携してナレーションを生成します。事前にVOICEVOXを起動しておいてください。
      </p>
      {loadingSpeakers && <p className="hint-text">VOICEVOXに接続中...</p>}
      {connError && (
        <div className="error-text">
          {connError}
          <div>
            <button className="small-button" onClick={loadSpeakers}>
              再接続
            </button>
          </div>
        </div>
      )}
      {!loadingSpeakers && !connError && (
        <>
          <div className="export-field">
            <label>話者</label>
            <select value={styleId ?? ''} onChange={(e) => setStyleId(Number(e.target.value))}>
              {speakers.map((sp) => (
                <optgroup key={sp.name} label={sp.name}>
                  {sp.styles.map((st) => (
                    <option key={st.id} value={st.id}>
                      {sp.name} - {st.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="export-field">
            <label>追加先の音声トラック</label>
            <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
              <option value="">新しいトラックを作成</option>
              {audioTracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="narration-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="読み上げたいテキストを入力"
            rows={4}
          />
          <button
            className="primary-button narration-generate"
            onClick={handleGenerate}
            disabled={generating || !text.trim()}
          >
            {generating ? (
              <>
                <WandIcon width={14} height={14} />
                生成中...
              </>
            ) : (
              <>
                <MicIcon width={14} height={14} />
                音声を生成して追加
              </>
            )}
          </button>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
      {doneMessage && <p className="success-text">{doneMessage}</p>}
    </div>
  )
}
