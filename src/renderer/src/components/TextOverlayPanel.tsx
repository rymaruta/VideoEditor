import { useProjectStore } from '../store/projectStore'
import { getTotalDuration } from '../store/projectStore'
import type { TextPosition } from '@shared/types'

export function TextOverlayPanel(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const addTextOverlay = useProjectStore((s) => s.addTextOverlay)
  const updateTextOverlay = useProjectStore((s) => s.updateTextOverlay)
  const removeTextOverlay = useProjectStore((s) => s.removeTextOverlay)

  const total = getTotalDuration(project)

  return (
    <div className="panel text-overlay-panel">
      <div className="panel-header">
        <h2>テキスト / 字幕</h2>
        <button
          className="small-button"
          onClick={() =>
            addTextOverlay({
              text: '新しいテキスト',
              startTime: 0,
              endTime: Math.min(3, total || 3),
              style: {
                fontSize: 40,
                color: '#ffffff',
                position: 'bottom',
                bold: true,
                outline: true
              }
            })
          }
        >
          + 追加
        </button>
      </div>
      <div className="overlay-list">
        {project.textOverlays.length === 0 && <p className="hint-text">テキストはありません</p>}
        {project.textOverlays.map((o) => (
          <div key={o.id} className="overlay-item">
            <input
              type="text"
              value={o.text}
              onChange={(e) => updateTextOverlay(o.id, { text: e.target.value })}
            />
            <div className="overlay-item-row">
              <label>
                開始
                <input
                  type="number"
                  step={0.1}
                  value={o.startTime}
                  onChange={(e) => updateTextOverlay(o.id, { startTime: Number(e.target.value) })}
                />
              </label>
              <label>
                終了
                <input
                  type="number"
                  step={0.1}
                  value={o.endTime}
                  onChange={(e) => updateTextOverlay(o.id, { endTime: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="overlay-item-row">
              <label>
                位置
                <select
                  value={o.style.position}
                  onChange={(e) =>
                    updateTextOverlay(o.id, {
                      style: { ...o.style, position: e.target.value as TextPosition }
                    })
                  }
                >
                  <option value="top">上</option>
                  <option value="center">中央</option>
                  <option value="bottom">下</option>
                </select>
              </label>
              <label>
                色
                <input
                  type="color"
                  value={o.style.color}
                  onChange={(e) =>
                    updateTextOverlay(o.id, { style: { ...o.style, color: e.target.value } })
                  }
                />
              </label>
              <button className="small-button danger" onClick={() => removeTextOverlay(o.id)}>
                削除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
