import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { usePipelineStore, type EditableSource } from '../store/pipelineStore'
import { useMenuCommand } from '../lib/menuCommands'
import { formatTimecode } from '../lib/timelineRuler'
import { sourceDuration } from '@shared/ingest/classify'

/**
 * 新しい回を作る(ファイル > 新しい回を作る… / Ctrl+Shift+N)。デザイン案の「NewEpisode」。
 *
 * 収録フォルダ(カードごとコピーしたフォルダ)を指定すると、中の素材をカメラ・マイクに振り分けて見せる。
 * 違っていればここで直してから作る。作ったあとは、そのまま自動編集(同期 → タイムラインに並べる …)を始められる。
 * 素材はコピーせず、元の場所を参照する。
 */

const KIND_COLOR: Record<EditableSource['kind'], string> = {
  camera: '#9ea7e0',
  mic: '#7fcf96',
  skip: '#666666'
}

function formatLength(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0
    ? `${h}時間${String(m).padStart(2, '0')}分`
    : `${m}分${String(Math.round(seconds % 60)).padStart(2, '0')}秒`
}

function folderSummary(source: EditableSource): string {
  const first = source.files[0]?.relativePath ?? ''
  const folder = first.includes('/') ? first.slice(0, first.lastIndexOf('/') + 1) : ''
  return source.files.length === 1 ? first : `${folder}…(${source.files.length}本)`
}

export function NewEpisodeDialog(): React.JSX.Element | null {
  const isDirty = useProjectStore((s) => s.isDirty)
  const root = usePipelineStore((s) => s.root)
  const sources = usePipelineStore((s) => s.sources)
  const scan = usePipelineStore((s) => s.scan)
  const ingest = usePipelineStore((s) => s.steps.ingest)
  const running = usePipelineStore((s) => s.running)
  const scanFolder = usePipelineStore((s) => s.scanFolder)
  const updateSource = usePipelineStore((s) => s.updateSource)

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [startNow, setStartNow] = useState(true)

  useMenuCommand((id) => {
    if (id !== 'file.newEpisode') return
    if (running) {
      // 前の回の自動編集が走っている間は、そちらを見せる(状態は1つしか持たない)
      usePipelineStore.getState().setScreenOpen(true)
      return
    }
    usePipelineStore.getState().reset()
    setName('')
    setOpen(true)
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const scanning = ingest.state === 'run'
  const usable = sources.filter((s) => s.kind !== 'skip')
  const canCreate =
    name.trim() !== '' && scan !== null && !scanning && usable.some((s) => s.kind === 'camera')

  async function pickFolder(): Promise<void> {
    const folder = await window.api.footageSelectFolder()
    if (!folder) return
    if (!name.trim()) setName(folder.split(/[/\\]/).filter(Boolean).pop() ?? '')
    await scanFolder(folder)
  }

  function handleCreate(): void {
    if (!canCreate) return
    if (
      isDirty &&
      !window.confirm(
        '今のプロジェクトに保存していない変更があります。破棄して新しい回を作りますか?'
      )
    )
      return
    const store = useProjectStore.getState()
    store.newProject()
    store.setProjectName(name.trim())
    setOpen(false)
    const pipeline = usePipelineStore.getState()
    pipeline.setScreenOpen(true)
    if (startNow) void pipeline.runPipeline()
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="new-episode-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新しい回を作る"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-titlebar">
          <span>新しい回を作る</span>
          <button className="dialog-close" aria-label="閉じる" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>

        <div className="new-episode-body">
          <label className="form-stack">
            <span>回の名前</span>
            <input
              type="text"
              placeholder="例: #297 浄土ヶ浜"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="form-stack">
            <span>収録フォルダ(カードごとコピーしたフォルダをそのまま指定)</span>
            <div className="new-episode-folder">
              <input
                type="text"
                readOnly
                value={root ?? ''}
                placeholder="(未選択)"
                aria-label="収録フォルダ"
              />
              <button
                className="small-button"
                disabled={scanning}
                onClick={() => void pickFolder()}
              >
                参照…
              </button>
            </div>
          </div>

          <div className="new-episode-found">
            <div className="new-episode-found-head">
              <span>見つかった素材(自動で振り分け)</span>
              <span className="form-note">
                {scanning
                  ? `読み込み中… ${ingest.note ?? ''}`
                  : sources.length > 0
                    ? '違っていれば右の欄で直せます(マイクは付けていた出演者の名前に)'
                    : ''}
              </span>
            </div>
            {ingest.state === 'error' && <p className="error-text">{ingest.note}</p>}
            {!scanning && scan && sources.length === 0 && (
              <p className="hint-text new-episode-empty">
                動画・音声のファイルが見つかりませんでした。
              </p>
            )}
            {!scan && !scanning && (
              <p className="hint-text new-episode-empty">
                フォルダを選ぶと、中の動画と音声をカメラ・マイクごとに振り分けて表示します。
              </p>
            )}
            <ul>
              {sources.map((s) => (
                <li
                  key={s.id}
                  className={`new-episode-source ${s.kind === 'skip' ? 'skipped' : ''}`}
                >
                  <span className="new-episode-chip" style={{ background: KIND_COLOR[s.kind] }} />
                  <span
                    className="new-episode-path"
                    title={s.files.map((f) => f.relativePath).join('\n')}
                  >
                    {folderSummary(s)}
                  </span>
                  <span className="new-episode-info">
                    {formatLength(sourceDuration(s))}
                    <span className="form-note"> · {s.basis}</span>
                  </span>
                  <select
                    aria-label="役割"
                    value={s.kind}
                    onChange={(e) =>
                      updateSource(s.id, { kind: e.target.value as EditableSource['kind'] })
                    }
                  >
                    <option value="camera">カメラ</option>
                    <option value="mic">マイク</option>
                    <option value="skip">使わない</option>
                  </select>
                  <input
                    type="text"
                    aria-label="名前"
                    placeholder={s.kind === 'mic' ? '付けていた出演者' : 'カメラの名前'}
                    title={
                      s.kind === 'mic'
                        ? 'ピンマイクは付けていた出演者の名前にすると、文字起こしとテロップの話者になります'
                        : undefined
                    }
                    value={s.name}
                    disabled={s.kind === 'skip'}
                    onChange={(e) => updateSource(s.id, { name: e.target.value })}
                  />
                </li>
              ))}
            </ul>
            {scan && scan.skipped.length > 0 && (
              <p className="form-note new-episode-skipped">
                読み込めなかったファイル {scan.skipped.length} 本(
                {scan.skipped
                  .slice(0, 3)
                  .map((x) => x.path.split(/[/\\]/).pop())
                  .join('、')}
                {scan.skipped.length > 3 ? ' ほか' : ''})
              </p>
            )}
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={startNow}
              onChange={(e) => setStartNow(e.target.checked)}
            />
            作ったあと、そのまま自動編集を始める(同期 → タイムラインに並べる)
          </label>
        </div>

        <div className="dialog-footer">
          <span className="dialog-footer-label">
            素材はコピーせず、元の場所を参照します
            {sources.length > 0 &&
              ` · 合計 ${formatTimecode(
                usable.reduce((t, s) => t + sourceDuration(s), 0),
                30
              )}`}
          </span>
          <div className="dialog-footer-spacer" />
          <button className="small-button" onClick={() => setOpen(false)}>
            キャンセル
          </button>
          <button className="primary-button" disabled={!canCreate} onClick={handleCreate}>
            作成
          </button>
        </div>
      </div>
    </div>
  )
}
