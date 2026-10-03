import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { usePipelineStore, type EditableSource } from '../store/pipelineStore'
import { useMenuCommand } from '../lib/menuCommands'
import { useSettingsStore } from '../store/settingsStore'
import type { Project } from '@shared/types'
import { DEFAULT_SHOW_STYLE, describeShowStyle, learnShowStyle } from '@shared/style/showStyle'
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
  const targetMinutes = usePipelineStore((s) => s.targetMinutes)
  const showKitFolder = useSettingsStore((s) => s.showKitFolder)
  const showStyle = useSettingsStore((s) => s.showStyle)
  const setShowStyle = useSettingsStore((s) => s.setShowStyle)
  const [learning, setLearning] = useState(false)
  const [styleError, setStyleError] = useState<string | null>(null)
  const setShowKitFolder = useSettingsStore((s) => s.setShowKitFolder)

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
  // カメラが「誰を映すか」の候補は、マイクに付けた出演者の名前
  const performers = sources
    .filter((s) => s.kind === 'mic' && s.name.trim())
    .map((s) => s.name.trim())
  const canCreate =
    name.trim() !== '' && scan !== null && !scanning && usable.some((s) => s.kind === 'camera')

  /** 過去回のプロジェクトを読み、番組スタイルを集計する */
  async function learnStyle(): Promise<void> {
    setStyleError(null)
    const paths = await window.api.selectProjectFiles()
    if (paths.length === 0) return
    setLearning(true)
    try {
      const projects: Project[] = []
      const names: string[] = []
      for (const p of paths) {
        try {
          projects.push(await window.api.loadProject(p))
          names.push(p.split(/[/\\]/).pop() ?? p)
        } catch {
          // 読めない回は飛ばす(全部読めなければ下で知らせる)
        }
      }
      if (projects.length === 0) {
        setStyleError('選んだプロジェクトを読めませんでした')
        return
      }
      const learned = learnShowStyle(projects)
      if (Object.keys(learned.learned).length === 0) {
        setStyleError('集計できる編集(本編のクリップ・テロップ・SE・BGM)が見つかりませんでした')
        return
      }
      setShowStyle({ style: learned.style, sources: names })
    } finally {
      setLearning(false)
    }
  }

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
                  {s.kind === 'camera' ? (
                    <select
                      aria-label="主に映す人"
                      title="このカメラが主に誰を映しているか。その人が話すとき、このカメラに切り替えます"
                      value={s.subject ?? ''}
                      onChange={(e) => updateSource(s.id, { subject: e.target.value || undefined })}
                    >
                      <option value="">全体</option>
                      {performers.map((p) => (
                        <option key={p} value={p}>
                          {p} を映す
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span />
                  )}
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

          <div className="form-stack">
            <span>
              番組素材フォルダ(SE・BGM。中に「SE/ツッコミ」「BGM/楽しい」のような分類のフォルダ)
            </span>
            <div className="new-episode-folder">
              <input
                type="text"
                readOnly
                value={showKitFolder}
                placeholder="(未設定: SE・BGM は置きません)"
                aria-label="番組素材フォルダ"
              />
              <button
                className="small-button"
                aria-label="番組素材フォルダを選ぶ"
                onClick={async () => {
                  const folder = await window.api.showKitSelectFolder()
                  if (folder) setShowKitFolder(folder)
                }}
              >
                参照…
              </button>
              {showKitFolder && (
                <button
                  className="small-button"
                  aria-label="番組素材フォルダを外す"
                  onClick={() => setShowKitFolder('')}
                >
                  外す
                </button>
              )}
            </div>
          </div>

          <div className="form-stack">
            <span>番組スタイル(間・ショットの長さ・SE の数・BGM と周りの音の音量)</span>
            <div className="new-episode-style">
              <span className="form-note" title={showStyle?.sources.join('\n')}>
                {showStyle
                  ? `過去回 ${showStyle.sources.length} 本から学んだ値: ${describeShowStyle(showStyle.style)}`
                  : `既定値: ${describeShowStyle(DEFAULT_SHOW_STYLE)}`}
              </span>
              <button
                className="small-button"
                aria-label="過去回から番組スタイルを学ぶ"
                title="人が仕上げた過去回のプロジェクト(.veproj)を選ぶと、その回の間・ショットの長さ・SE の数・音量を集計して、次の自動編集に使います"
                disabled={learning}
                onClick={() => void learnStyle()}
              >
                {learning ? '集計中…' : '過去回から学ぶ…'}
              </button>
              {showStyle && (
                <button
                  className="small-button"
                  aria-label="番組スタイルを既定に戻す"
                  onClick={() => setShowStyle(null)}
                >
                  既定に戻す
                </button>
              )}
            </div>
            {styleError && <p className="error-text">{styleError}</p>}
          </div>

          <label className="new-episode-target">
            仕上がりの長さ
            <input
              type="number"
              min={0}
              step={1}
              placeholder="決めない"
              value={targetMinutes || ''}
              onChange={(e) =>
                usePipelineStore.getState().setTargetMinutes(Number(e.target.value) || 0)
              }
            />
            分<span className="form-note">(空なら長さは決めず、不要な場面だけ落とします)</span>
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={startNow}
              onChange={(e) => setStartNow(e.target.checked)}
            />
            作ったあと、そのまま自動編集を始める(同期 → 色合わせ・ノイズ除去 → 文字起こし → 構成 →
            カット → アングル → テロップ → SE・BGM)
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
