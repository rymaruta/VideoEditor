import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { applyWhenNotTrying, useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import { useVoicevoxStore } from '../store/voicevoxStore'
import { afterTrialNotice, NARRATION_NOTICE } from '../lib/afterTrial'
import { MicIcon, WandIcon } from './icons'

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/**
 * `active`: パネルが開いているか。VOICEVOX へは開いた時に初めてつなぐ(`useVoicevoxStore`)。左のパネルは
 * 切り替えても消さないので、置いた時につなぐと、使わない人でも起動のたびに接続のエラーが記録に残っていた
 */
export function NarrationPanel({ active = true }: { active?: boolean }): React.JSX.Element {
  const audioTracks = useProjectStore((s) => s.project.audioTracks)
  const addAudioClipWithAsset = useProjectStore((s) => s.addAudioClipWithAsset)

  const speakers = useVoicevoxStore((s) => s.speakers)
  const status = useVoicevoxStore((s) => s.status)
  const connError = useVoicevoxStore((s) => s.error)
  const connect = useVoicevoxStore((s) => s.connect)
  const connectIfNeeded = useVoicevoxStore((s) => s.connectIfNeeded)
  const loadingSpeakers = status === 'idle' || status === 'loading'
  /** 選んだ話者(選んでいなければ、ずんだもん → 最初の話者の最初の型) */
  const [pickedStyleId, setStyleId] = useState<number | null>(null)
  const zundamon = speakers.find((s) => s.name.includes('ずんだもん'))
  const styleId = pickedStyleId ?? (zundamon ?? speakers[0])?.styles[0]?.id ?? null
  const [text, setText] = useState('')
  const [trackId, setTrackId] = useState<string>('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMessage, setDoneMessage] = useState<string | null>(null)

  useEffect(() => {
    if (active) connectIfNeeded()
  }, [active, connectIfNeeded])

  async function handleGenerate(): Promise<void> {
    if (!text.trim() || styleId === null) return
    setError(null)
    setDoneMessage(null)
    setGenerating(true)
    const session = useProjectStore.getState().projectSession
    try {
      const filePath = await window.api.voicevoxSynthesize(text, styleId)
      const meta = await window.api.probeMedia(filePath)
      // Asset + track + clip as one undoable step, so a single undo doesn't leave
      // an empty narration track and an unused asset behind.
      // 範囲の自動編集を試している間は、試しを終えてから入れる(知らせもそのとおりに)
      const status = applyWhenNotTrying(
        () =>
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
            { trackId: trackId || undefined, trackName: 'ナレーション', session }
          ),
        session
      )
      setDoneMessage(afterTrialNotice(status, NARRATION_NOTICE))
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
      {loadingSpeakers && <p className="hint-text">VOICEVOXに接続中…</p>}
      {connError && (
        <div className="error-text">
          {connError}
          <div>
            <button className="small-button" onClick={() => void connect()}>
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
                生成中…
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
