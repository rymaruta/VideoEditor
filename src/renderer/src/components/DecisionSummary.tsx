import {
  cameraLabel,
  decisionConclusion,
  reasonStats,
  SCENE_KIND_LABEL,
  type ClipDecision
} from '../lib/clipDecision'

/**
 * AI の判断のまとめ(確認の画面のカードと、インスペクタの「AI の判断」のタブで同じものを使う)。
 * 1 行目に結論の文、その下に場面ごとの数の小さな表(名前は灰・値は白)、最後に手の判断
 */
export function DecisionSummary({
  decision: d,
  withNotes = true
}: {
  decision: ClipDecision
  /** 手の判断・カメラの文も出す(インスペクタは別の欄に出すので出さない) */
  withNotes?: boolean
}): React.JSX.Element {
  const notes: string[] = []
  if (withNotes) {
    if (d.camera) notes.push(`${cameraLabel(d.camera.name, d.camera.subject)}を映しています。`)
    if (d.manualAngle) notes.push('手でカメラを替えた所です。')
    if (d.manualAdded) notes.push('手で足した所です。')
    if (d.locked) notes.push('ロックした範囲です(全体の作り直しでも今のまま残ります)。')
  }
  return (
    <div className="ve-decision-summary">
      <p className="ve-decision-conclusion">{decisionConclusion(d)}</p>
      {d.scenes.slice(0, 2).map((sc) => {
        const { stats, rest } = reasonStats(sc.reason)
        return (
          <div key={sc.id} className="ve-decision-scene-block">
            <span className="ve-decision-scene-name">
              {sc.kind ? SCENE_KIND_LABEL[sc.kind] : '場面'}
              {sc.title ? `「${sc.title}」` : ''}
              {sc.keep === true ? '(手で残す)' : sc.keep === false ? '(手で落とす)' : ''}
            </span>
            {(stats.length > 0 || sc.score !== null) && (
              <dl className="ve-decision-table">
                {sc.score !== null && (
                  <div>
                    <dt>点数</dt>
                    <dd>{Math.round(sc.score)}</dd>
                  </div>
                )}
                {stats.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {rest.length > 0 && <span className="ve-decision-text">{rest.join('。')}</span>}
          </div>
        )
      })}
      {notes.length > 0 && <span className="ve-decision-text">{notes.join('')}</span>}
    </div>
  )
}
