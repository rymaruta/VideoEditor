import { useEffect, useMemo, useState } from 'react'
import type { SyncIssue } from '@shared/sync/solve'
import { sourceDuration } from '@shared/ingest/classify'
import { usePipelineStore, STEPS, type StepStatus } from '../store/pipelineStore'
import { useProjectStore } from '../store/projectStore'
import { useMenuCommand } from '../lib/menuCommands'
import { formatTimecode } from '../lib/timelineRuler'
import { placedUtterances, telopsFromTranscript } from '../lib/transcriptTimeline'
import { usePresetStore } from '../store/presetStore'
import { useSettingsStore } from '../store/settingsStore'
import { parseDictionary } from '@shared/telop/polish'
import { speakerColor } from '@shared/speaker'

/**
 * 自動編集の画面(自動編集 > 自動編集の画面)。デザイン案の「AutoEdit」。
 *
 * 左に工程と進み具合、中央に今の工程の中身(素材の整理・同期の結果・ログ)、右に要確認の一覧。
 * 工程は裏で進むので、この画面を閉じて編集画面に戻っても止まらない。
 */

type CenterTab = 'sources' | 'sync' | 'transcript' | 'structure' | 'log'

const SOURCE_COLORS = ['#9ea7e0', '#7fb5d8', '#d8a77f', '#c49ee0', '#7fcf96', '#e0d27f', '#e08ab0']

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

function issueKey(issue: SyncIssue): string {
  return issue.kind === 'unsynced'
    ? `unsynced:${issue.fileId}`
    : `${issue.kind}:${issue.a}:${issue.b}`
}

function stepMark(state: StepStatus['state']): string {
  return state === 'done' ? '✓' : state === 'error' ? '!' : ''
}

function stepStateLabel(step: StepStatus): string {
  switch (step.state) {
    case 'done':
      return '完了'
    case 'run':
      return `実行中 ${Math.round(step.percent)}%`
    case 'error':
      return 'エラー'
    case 'skipped':
      return '省略'
    default:
      return '待機'
  }
}

export function AutoEditScreen(): React.JSX.Element | null {
  const open = usePipelineStore((s) => s.screenOpen)
  const setOpen = usePipelineStore((s) => s.setScreenOpen)
  const steps = usePipelineStore((s) => s.steps)
  const sources = usePipelineStore((s) => s.sources)
  const report = usePipelineStore((s) => s.report)
  const syncedFiles = usePipelineStore((s) => s.syncedFiles)
  const log = usePipelineStore((s) => s.log)
  const reviewed = usePipelineStore((s) => s.reviewed)
  const running = usePipelineStore((s) => s.running)
  const scan = usePipelineStore((s) => s.scan)
  const runPipeline = usePipelineStore((s) => s.runPipeline)
  const cancel = usePipelineStore((s) => s.cancel)
  const markReviewed = usePipelineStore((s) => s.markReviewed)
  const project = useProjectStore((s) => s.project)
  const projectName = project.name
  const asrDevice = usePipelineStore((s) => s.asrDevice)
  const [telopsMade, setTelopsMade] = useState<number | null>(null)
  const [dictOpen, setDictOpen] = useState(false)
  const dictionary = useSettingsStore((s) => s.telopDictionary)
  const scenes = usePipelineStore((s) => s.scenes)
  const judgements = usePipelineStore((s) => s.judgements)
  const judgeSource = usePipelineStore((s) => s.judgeSource)
  const keep = usePipelineStore((s) => s.keep)
  const roughCut = usePipelineStore((s) => s.roughCut)
  const targetMinutes = usePipelineStore((s) => s.targetMinutes)
  const editNote = usePipelineStore((s) => s.editNote)

  const [tab, setTab] = useState<CenterTab>('sync')
  const [reviewTab, setReviewTab] = useState<'open' | 'done'>('open')

  useMenuCommand((id) => {
    if (id === 'auto.screen') setOpen(true)
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const sourceOf = useMemo(() => new Map(syncedFiles.map((f) => [f.id, f.sourceId])), [syncedFiles])
  const sourceName = (id: string): string => sources.find((s) => s.id === id)?.name ?? ''
  const fileLabel = (fileId: string): string =>
    `${sourceName(sourceOf.get(fileId) ?? '')} ${fileName(fileId)}`.trim()

  if (!open) return null

  const doneCount = STEPS.filter((s) => steps[s.id].state === 'done').length
  const overall =
    STEPS.reduce((t, s) => t + (steps[s.id].state === 'done' ? 100 : steps[s.id].percent), 0) /
    STEPS.length
  const current = STEPS.find((s) => steps[s.id].state === 'run')

  const utterances = placedUtterances(project)
  const placementOf = new Map((report?.placements ?? []).map((p) => [p.id, p]))
  const durationOf = new Map(syncedFiles.map((f) => [f.id, f.duration]))

  function describe(issue: SyncIssue): { kind: string; text: string; at?: number } {
    switch (issue.kind) {
      case 'unsynced':
        return {
          kind: '同期',
          text: `${fileLabel(issue.fileId)} は、ほかの素材と音が一致しませんでした(タイムラインには並べていません)`
        }
      case 'conflict':
        return {
          kind: '食い違い',
          text: `${fileLabel(issue.a)} と ${fileLabel(issue.b)} の位置が ${Math.abs(issue.difference * 1000).toFixed(0)}ms 食い違っています`,
          at: placementOf.get(issue.b)?.start
        }
      case 'overlap':
        return {
          kind: '重なり',
          text: `${fileLabel(issue.a)} と ${fileLabel(issue.b)} が同じ機材で ${issue.overlap.toFixed(1)} 秒重なっています`,
          at: placementOf.get(issue.b)?.start
        }
    }
  }

  // 要確認: 同期の問題 + 声の重なり(テロップの話者を確かめる)
  const reviewItems: { key: string; kind: string; text: string; at?: number }[] = [
    ...(report?.issues ?? []).map((i) => ({ key: issueKey(i), ...describe(i) })),
    ...utterances
      .filter((p) => p.utterance.overlap)
      .map((p) => ({
        key: `overlap-voice:${p.utterance.id}`,
        kind: '声の重なり',
        text: `${p.utterance.speaker ?? '話者不明'}「${p.utterance.text.slice(0, 40)}」— ほかの人と同時に話しています。話者と文字を確かめてください`,
        at: p.start
      }))
  ]
  const openIssues = reviewItems.filter((i) => !reviewed.includes(i.key))
  const doneIssues = reviewItems.filter((i) => reviewed.includes(i.key))

  function makeTelops(): void {
    const overlays = telopsFromTranscript(
      project,
      usePresetStore.getState().captionPresets,
      parseDictionary(useSettingsStore.getState().telopDictionary)
    )
    if (overlays.length === 0) return
    const store = useProjectStore.getState()
    store.addTextOverlays(overlays)
    setTelopsMade(overlays.length)
  }

  // 同期の結果: 共通の時間軸
  const span = Math.max(
    1,
    ...[...placementOf.values()].map((p) => p.start + (durationOf.get(p.id) ?? 0))
  )
  // 目盛りは6本前後になる切りのよい間隔(10秒〜2時間)
  const tickStep =
    [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find((v) => v >= span / 6) ?? 7200
  const ticks: number[] = []
  for (let t = 0; t <= span; t += tickStep) ticks.push(t)
  const usedSources = sources.filter((s) => s.kind !== 'skip')

  return (
    <div className="auto-edit-screen" role="region" aria-label="自動編集">
      <div className="auto-edit-header">
        <span className="auto-edit-title">自動編集 — {projectName}</span>
        <div className="dialog-footer-spacer" />
        <button className="small-button" onClick={() => setOpen(false)}>
          編集画面に戻る
        </button>
      </div>

      <div className="auto-edit-body">
        {/* 工程 */}
        <section className="auto-edit-steps" aria-label="自動編集の工程">
          <div className="auto-edit-overall">
            <div className="auto-edit-overall-row">
              <span>全体</span>
              <span>
                {doneCount} / {STEPS.length} 工程
              </span>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${overall}%` }} />
            </div>
            <div className="auto-edit-overall-row form-note">
              <span>
                {current ? `${current.label}: ${steps[current.id].note ?? ''}` : running ? '' : ' '}
              </span>
            </div>
          </div>
          <ol className="auto-edit-step-list">
            {STEPS.map((s) => {
              const st = steps[s.id]
              return (
                <li key={s.id} className={`auto-edit-step ${s.id} ${st.state}`}>
                  <span className="auto-edit-step-mark">{stepMark(st.state)}</span>
                  <span className="auto-edit-step-body">
                    <span className="auto-edit-step-name">{s.label}</span>
                    {st.note && st.state !== 'run' && (
                      <span className="auto-edit-step-note" title={st.note}>
                        {st.note}
                      </span>
                    )}
                  </span>
                  <span className="auto-edit-step-state">{stepStateLabel(st)}</span>
                </li>
              )
            })}
          </ol>
          <p className="form-note auto-edit-next">
            この後の工程(テロップの整え・演出テロップ・SE/BGM・CG版面・音声の仕上げ・色合わせ・書き出し後の自動チェック)は、
            できたものから順にここへ加わります。
          </p>
          <div className="dialog-footer-spacer" />
          <div className="auto-edit-step-actions">
            {running ? (
              <button className="small-button danger" onClick={cancel}>
                中止
              </button>
            ) : (
              <button
                className="small-button"
                disabled={!scan || sources.length === 0}
                onClick={() => void runPipeline()}
                title="同期からやり直します(タイムラインには新しいトラックとして加わります)"
              >
                {steps.sync.state === 'wait' ? '開始' : 'やり直す'}
              </button>
            )}
          </div>
        </section>

        {/* 今の工程の中身 */}
        <section className="auto-edit-center" aria-label="工程の中身">
          <div className="panel-tabs" role="tablist">
            {(
              [
                ['sources', '素材の整理'],
                ['sync', '同期の結果'],
                ['transcript', '文字起こし'],
                ['structure', '構成'],
                ['log', 'ログ']
              ] as [CenterTab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={`panel-tab ${tab === id ? 'active' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'sources' && (
            <div className="auto-edit-pane">
              {sources.length === 0 ? (
                <p className="hint-text">
                  ファイル &gt; 新しい回を作る… で収録フォルダを指定すると、ここに出ます。
                </p>
              ) : (
                <table className="auto-edit-table">
                  <thead>
                    <tr>
                      <th>名前</th>
                      <th>役割</th>
                      <th>本数</th>
                      <th>長さ</th>
                      <th>振り分けの手がかり</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s) => (
                      <tr key={s.id} className={s.kind === 'skip' ? 'skipped' : ''}>
                        <td>{s.name}</td>
                        <td>
                          {s.kind === 'camera'
                            ? 'カメラ'
                            : s.kind === 'mic'
                              ? 'マイク'
                              : '使わない'}
                        </td>
                        <td>{s.files.length}</td>
                        <td className="mono">{formatTimecode(sourceDuration(s), 30)}</td>
                        <td className="form-note">{s.basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'sync' && (
            <div className="auto-edit-pane">
              {!report ? (
                <p className="hint-text">
                  {steps.sync.state === 'run'
                    ? `同期しています… ${steps.sync.note ?? ''}`
                    : steps.sync.state === 'error'
                      ? steps.sync.note
                      : '同期が終わると、各カメラ・マイクの録画がどの時刻にあるかをここに並べます。'}
                </p>
              ) : (
                <>
                  <div className="sync-lanes-head">
                    <span>同期の結果(共通の時間軸)</span>
                    <span className="form-note">
                      <span className="sync-legend audio" /> 音で一致
                      <span className="sync-legend clock" /> 録画時刻で推定
                      <span className="sync-legend none" /> 同期できず
                    </span>
                  </div>
                  <div className="sync-lanes">
                    {usedSources.map((s, i) => (
                      <div key={s.id} className="sync-lane">
                        <span className="sync-lane-name" title={s.basis}>
                          {s.name}
                        </span>
                        <div className="sync-lane-track">
                          {s.files.map((f) => {
                            const p = placementOf.get(f.path)
                            if (!p) return null
                            return (
                              <div
                                key={f.path}
                                className={`sync-bar ${p.method}`}
                                style={{
                                  left: `${(p.start / span) * 100}%`,
                                  width: `${Math.max(0.3, (f.duration / span) * 100)}%`,
                                  background:
                                    p.method === 'audio'
                                      ? SOURCE_COLORS[i % SOURCE_COLORS.length]
                                      : undefined
                                }}
                                title={`${fileName(f.path)}\n${formatTimecode(p.start, 30)} 〜 ${formatTimecode(p.start + f.duration, 30)}`}
                              />
                            )
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="sync-lane sync-axis">
                      <span className="sync-lane-name" />
                      <div className="sync-lane-track">
                        {ticks.map((t) => (
                          <span
                            key={t}
                            className="sync-tick"
                            style={{ left: `${(t / span) * 100}%` }}
                          >
                            {formatTimecode(t, 30).slice(0, 8)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="auto-edit-stats">
                    {[
                      [
                        '同期できた素材',
                        `${report.placements.filter((p) => p.method !== 'none').length} / ${report.placements.length}`
                      ],
                      [
                        '照らし合わせた組',
                        `${report.pairs.filter((p) => p.reliable).length} / ${report.pairs.length}`
                      ],
                      [
                        '時計のずれ(最大)',
                        (() => {
                          const d = report.pairs
                            .map((p) => p.driftPpm)
                            .filter((v): v is number => v !== undefined)
                          return d.length
                            ? `${Math.max(...d.map(Math.abs)).toFixed(0)} ppm`
                            : '測定なし'
                        })()
                      ],
                      ['処理時間', `${(report.elapsedMs / 1000).toFixed(1)} 秒`]
                    ].map(([k, v]) => (
                      <div key={k} className="auto-edit-stat">
                        <span className="form-note">{k}</span>
                        <span>{v}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'transcript' && (
            <div className="auto-edit-pane auto-edit-transcript">
              {utterances.length === 0 ? (
                <p className="hint-text">
                  {steps.transcribe.state === 'run'
                    ? `文字起こし中… ${steps.transcribe.note ?? ''}`
                    : steps.transcribe.state === 'error'
                      ? steps.transcribe.note
                      : '文字起こしが終わると、話者と発言がここに時刻順に並びます。'}
                </p>
              ) : (
                <>
                  <div className="transcript-head">
                    <span>
                      発言 {utterances.length.toLocaleString()} 件
                      {asrDevice && (
                        <span className="form-note">
                          {' '}
                          · 認識: {asrDevice === 'cpu' ? 'CPU' : 'GPU'}
                        </span>
                      )}
                    </span>
                    <div className="dialog-footer-spacer" />
                    <button
                      className="small-button"
                      onClick={() => setDictOpen(!dictOpen)}
                      title="聞き違い・出演者名・地名の表記を登録すると、テロップを作るときに直します"
                    >
                      用語の辞書…
                    </button>
                    {telopsMade !== null ? (
                      <span className="form-note">
                        発言テロップを {telopsMade} 枚並べました(取り消しは Ctrl+Z)
                      </span>
                    ) : (
                      <button
                        className="small-button"
                        onClick={makeTelops}
                        title="話者に割り当てたテロップスタイルで、発言テロップをタイムラインに並べます"
                      >
                        発言テロップとして並べる
                      </button>
                    )}
                  </div>
                  {dictOpen && (
                    <div className="dictionary-editor">
                      <p className="form-note">
                        1行に「誤 → 正」(例: 定選 →
                        停戦)。発言テロップを作るとき・仮編集を作り直すときに当てます。番組をまたいで使います。
                      </p>
                      <textarea
                        rows={5}
                        value={dictionary}
                        placeholder={'定選 → 停戦\n基礎川 → 木曽川'}
                        onChange={(e) =>
                          useSettingsStore.getState().setTelopDictionary(e.target.value)
                        }
                      />
                    </div>
                  )}
                  <ul className="transcript-list">
                    {utterances.map(({ utterance: u, start }) => (
                      <li
                        key={u.id}
                        className="transcript-row"
                        style={{ borderLeftColor: speakerColor(u.speaker) }}
                        onClick={() => useProjectStore.getState().seekTo(start)}
                        title="クリックでこの位置へ移ります"
                      >
                        <span className="mono form-note">{formatTimecode(start, 30)}</span>
                        <span className="transcript-speaker">{u.speaker ?? '—'}</span>
                        <span className="transcript-text">{u.text}</span>
                        {u.overlap && <span className="transcript-tag">重なり</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {tab === 'structure' && (
            <div className="auto-edit-pane auto-edit-structure">
              <div className="structure-controls">
                <label>
                  仕上がりの長さ
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={targetMinutes || ''}
                    placeholder="決めない"
                    onChange={(e) =>
                      usePipelineStore.getState().setTargetMinutes(Number(e.target.value) || 0)
                    }
                  />
                  分
                </label>
                <label className="structure-note">
                  方針
                  <input
                    type="text"
                    placeholder="例: 笑いを優先、食レポは短く(AI に伝えます)"
                    value={editNote}
                    onChange={(e) => usePipelineStore.getState().setEditNote(e.target.value)}
                  />
                </label>
                <div className="dialog-footer-spacer" />
                <button
                  className="small-button"
                  disabled={running || scenes.length === 0}
                  onClick={() => void usePipelineStore.getState().rebuildRoughCut()}
                  title="残す/落とすと長さに合わせて、カット・アングル・発言テロップを作り直します(取り消しは Ctrl+Z)"
                >
                  仮編集を作り直す
                </button>
              </div>
              {roughCut && (
                <p className="form-note structure-summary">
                  {roughCut.kept} 場面を残す · {roughCut.dropped} 場面を落とす · 仕上がり{' '}
                  {formatTimecode(roughCut.duration, 30)} · ショット {roughCut.shots} · 発言テロップ{' '}
                  {roughCut.telops}
                  {judgeSource === 'heuristic' &&
                    ' · 判定は簡易の点数(Gemini の鍵を設定すると AI で判定します)'}
                </p>
              )}
              {scenes.length === 0 ? (
                <p className="hint-text">
                  {steps.structure.state === 'run'
                    ? `判定中… ${steps.structure.note ?? ''}`
                    : '文字起こしが終わると、話のまとまり(場面)ごとに見どころ・不要を判定してここに並べます。'}
                </p>
              ) : (
                <ul className="structure-list">
                  {scenes.map((sc) => {
                    const j = judgements.find((x) => x.sceneId === sc.id)
                    const kept = keep[sc.id] ?? roughCut?.keptIds.includes(sc.id) ?? false
                    const manual = keep[sc.id] !== undefined
                    return (
                      <li key={sc.id} className={`structure-row ${kept ? 'kept' : 'dropped'}`}>
                        <input
                          type="checkbox"
                          aria-label="残す"
                          checked={kept}
                          onChange={(e) =>
                            usePipelineStore.getState().setKeep(sc.id, e.target.checked)
                          }
                        />
                        <span className="mono form-note">
                          {formatTimecode(sc.start, 30).slice(0, 8)}
                          <br />
                          {Math.round(sc.end - sc.start)}秒
                        </span>
                        <span className={`structure-kind ${j?.kind ?? 'normal'}`}>
                          {j?.kind === 'highlight'
                            ? '見どころ'
                            : j?.kind === 'unneeded'
                              ? '不要'
                              : '普通'}
                        </span>
                        <span className="structure-score" title={`点数 ${j?.score ?? '-'}`}>
                          <span style={{ width: `${j?.score ?? 0}%` }} />
                        </span>
                        <span className="structure-body">
                          <span className="structure-title">
                            {j?.title ??
                              (sc.lines[0]
                                ? `${sc.lines[0].speaker ?? ''}「${sc.lines[0].text.slice(0, 30)}」`
                                : '(会話なし)')}
                            {manual && <span className="transcript-tag">手で変更</span>}
                          </span>
                          <span className="form-note">{j?.reason}</span>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}

          {tab === 'log' && (
            <div className="auto-edit-pane auto-edit-log">
              {log.length === 0 ? (
                <p className="hint-text">まだ記録はありません。</p>
              ) : (
                log.map((l, i) => (
                  <div key={i}>
                    <span className="mono form-note">{new Date(l.time).toLocaleTimeString()}</span>{' '}
                    {l.text}
                  </div>
                ))
              )}
            </div>
          )}
        </section>

        {/* 要確認 */}
        <section className="auto-edit-review" aria-label="要確認">
          <div className="panel-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={reviewTab === 'open'}
              className={`panel-tab ${reviewTab === 'open' ? 'active' : ''}`}
              onClick={() => setReviewTab('open')}
            >
              要確認 {openIssues.length}
            </button>
            <button
              role="tab"
              aria-selected={reviewTab === 'done'}
              className={`panel-tab ${reviewTab === 'done' ? 'active' : ''}`}
              onClick={() => setReviewTab('done')}
            >
              確認済み {doneIssues.length}
            </button>
          </div>
          <ul className="auto-edit-review-list">
            {(reviewTab === 'open' ? openIssues : doneIssues).map((d) => {
              const key = d.key
              return (
                <li key={key} className="auto-edit-review-item">
                  <div className="auto-edit-review-meta">
                    <span className="mono">
                      {d.at !== undefined ? formatTimecode(d.at, 30) : '—'}
                    </span>
                    <span className="auto-edit-review-kind">{d.kind}</span>
                  </div>
                  <p>{d.text}</p>
                  <button
                    className="small-button"
                    onClick={() => markReviewed(key, reviewTab === 'open')}
                  >
                    {reviewTab === 'open' ? 'このままでよい' : '要確認に戻す'}
                  </button>
                </li>
              )
            })}
            {(reviewTab === 'open' ? openIssues : doneIssues).length === 0 && (
              <li className="hint-text auto-edit-review-empty">
                {reviewTab === 'open'
                  ? report
                    ? '確認が必要な箇所はありません。'
                    : '工程が進むと、自信の低い箇所がここに並びます。'
                  : 'まだありません。'}
              </li>
            )}
          </ul>
        </section>
      </div>
    </div>
  )
}
