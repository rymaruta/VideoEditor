import { useState } from 'react'
import { useQcStore } from '../store/qcStore'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { formatTimecode } from '../lib/timelineRuler'
import { QC_KIND_LABEL } from '@shared/qc/types'
import { frameSeconds } from '@shared/frameRate'

/**
 * 書き出し後の自動確認の結果(書き出しダイアログの下)。
 * 項目を押すと、ダイアログを閉じてその位置へ移る(テロップならそのテロップを選ぶ)。
 */
export function ExportQcPanel({ onJump }: { onJump: () => void }): React.JSX.Element | null {
  const report = useQcStore((s) => s.report)
  const cancel = useQcStore((s) => s.cancel)
  const fps = useProjectStore((s) => 1 / frameSeconds(s.project.clips, s.project.assets))
  const qcWords = useSettingsStore((s) => s.qcWords)
  const setQcWords = useSettingsStore((s) => s.setQcWords)
  const [editingWords, setEditingWords] = useState(false)

  if (!report) return null
  const errors = report.issues.filter((i) => i.severity === 'error').length
  const warns = report.issues.length - errors
  const fileName = report.path.split(/[/\\]/).pop()

  return (
    <div className="export-qc" aria-label="書き出し後の自動確認">
      <div className="export-qc-head">
        <span className="export-qc-title">自動確認</span>
        <span className="form-note" title={report.path}>
          {fileName}
        </span>
        <div className="dialog-footer-spacer" />
        {report.state === 'run' ? (
          <>
            <span className="form-note">映像と音声を確認中… {report.percent}%</span>
            <button className="small-button" onClick={cancel}>
              中止
            </button>
          </>
        ) : (
          <span className={`export-qc-summary ${errors > 0 ? 'error' : warns > 0 ? 'warn' : 'ok'}`}>
            {report.issues.length === 0
              ? '問題は見つかりませんでした'
              : `直すべき ${errors} 件 · 確かめる ${warns} 件`}
          </span>
        )}
        <button
          className="small-button"
          title="テロップに入っていたら知らせる言葉(放送で使わない言葉など)"
          onClick={() => setEditingWords((v) => !v)}
        >
          確認する言葉…
        </button>
      </div>
      {editingWords && (
        <label className="form-stack export-qc-words">
          <span>テロップに入っていたら知らせる言葉(1行に1つ。次の確認から効きます)</span>
          <textarea rows={4} value={qcWords} onChange={(e) => setQcWords(e.target.value)} />
        </label>
      )}
      {report.error && <p className="error-text">{report.error}</p>}
      {report.measurement?.loudness && (
        <p className="form-note export-qc-loudness">
          ラウドネス {report.measurement.loudness.integrated.toFixed(1)} LUFS · ピーク{' '}
          {report.measurement.loudness.truePeak.toFixed(1)} dBTP · LRA{' '}
          {report.measurement.loudness.lra.toFixed(1)} LU
        </p>
      )}
      {report.issues.length > 0 && (
        <ul className="export-qc-list">
          {report.issues.map((issue) => (
            <li key={issue.id}>
              <button
                className={`export-qc-item ${issue.severity}`}
                title="その位置へ移る"
                onClick={() => {
                  const store = useProjectStore.getState()
                  store.seekTo(issue.start)
                  if (issue.overlayId) store.selectOverlay(issue.overlayId)
                  onJump()
                }}
              >
                <span className="export-qc-time">{formatTimecode(issue.start, fps)}</span>
                <span className="export-qc-kind">{QC_KIND_LABEL[issue.kind]}</span>
                <span className="export-qc-message">{issue.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
