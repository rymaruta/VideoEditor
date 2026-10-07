import { useState } from 'react'
import { usePipelineStore } from '../store/pipelineStore'
import { useProjectStore } from '../store/projectStore'

const COUNTS = [3, 5, 10]
const LENGTHS = [30, 45, 60]

/**
 * 見どころから縦型のショートを作る欄(自動編集の画面の「構成」の上)。
 * 本数と長さの上限を選び、書き出すフォルダを選ぶと、1本ずつ企画(.veproj)と動画(.mp4)を書く。
 * 企画を開けば、テロップや区間を直して書き出し直せる。
 */
export function ShortsPanel({ disabled }: { disabled: boolean }): React.JSX.Element {
  const shorts = usePipelineStore((s) => s.shorts)
  const hasMulticam = useProjectStore((s) => Boolean(s.project.multicam))
  const [count, setCount] = useState(5)
  const [maxSec, setMaxSec] = useState(60)
  const running = shorts.state === 'run'

  async function start(): Promise<void> {
    const folder = await window.api.selectExportFolder()
    if (!folder) return
    await usePipelineStore.getState().makeShorts(folder, { count, maxSec })
  }

  return (
    <div className="shorts-panel" aria-label="ショートを作る">
      <span className="shorts-title">ショート(縦型)</span>
      <label>
        本数
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={running}>
          {COUNTS.map((c) => (
            <option key={c} value={c}>
              {c} 本まで
            </option>
          ))}
        </select>
      </label>
      <label>
        長さ
        <select
          value={maxSec}
          onChange={(e) => setMaxSec(Number(e.target.value))}
          disabled={running}
        >
          {LENGTHS.map((l) => (
            <option key={l} value={l}>
              {l} 秒まで
            </option>
          ))}
        </select>
      </label>
      <button
        className="small-button"
        disabled={disabled || running || !hasMulticam}
        onClick={() => void start()}
        title="叫び・笑いの山から、強い順に縦型の動画を作ります(ゲーム画面の真ん中 + 上に顔カメラ + 発言テロップ)"
      >
        {running ? '作成中…' : 'ショートを作る…'}
      </button>
      <span className="form-note" role="status">
        {shorts.state === 'run'
          ? shorts.note
          : shorts.state === 'done'
            ? shorts.files.length > 0
              ? `${shorts.files.length} 本を書き出しました`
              : shorts.note
            : shorts.state === 'error'
              ? `作れませんでした: ${shorts.note}`
              : ''}
      </span>
      {shorts.state === 'done' && shorts.files.length > 0 && (
        <button
          className="small-button"
          onClick={() => void window.api.showItemInFolder(shorts.files[0])}
        >
          フォルダを開く
        </button>
      )}
    </div>
  )
}
