import { useProjectStore } from '../store/projectStore'
import { getTotalDuration } from '../store/projectStore'
import type { FontFamily, TextAnimation, TextOverlay, TextPosition, TextStyle } from '@shared/types'
import { defaultTextStyle, FONT_FAMILY_OPTIONS } from '@shared/textStyle'
import { PlusIcon, TrashIcon, TypeIcon, CopyIcon } from './icons'

function defaultPositionFraction(position: TextPosition): { x: number; y: number } {
  if (position === 'top') return { x: 0.5, y: 0.08 }
  if (position === 'bottom') return { x: 0.5, y: 0.9 }
  return { x: 0.5, y: 0.5 }
}

export function TextOverlayPanel(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const addTextOverlay = useProjectStore((s) => s.addTextOverlay)
  const updateTextOverlay = useProjectStore((s) => s.updateTextOverlay)
  const removeTextOverlay = useProjectStore((s) => s.removeTextOverlay)

  const total = getTotalDuration(project)

  function patchStyle(id: string, current: TextStyle, patch: Partial<TextStyle>): void {
    updateTextOverlay(id, { style: { ...current, ...patch } })
  }

  function handleDuplicate(o: TextOverlay): void {
    addTextOverlay({
      text: o.text,
      startTime: o.startTime,
      endTime: o.endTime,
      style: { ...o.style },
      source: o.source
    })
  }

  return (
    <div className="panel text-overlay-panel">
      <div className="panel-header">
        <h2>テキスト / 字幕</h2>
        <button
          className="primary-button"
          onClick={() =>
            addTextOverlay({
              text: '新しいテキスト',
              startTime: 0,
              endTime: Math.min(3, total || 3),
              style: defaultTextStyle(),
              source: 'manual'
            })
          }
        >
          <PlusIcon width={14} height={14} />
          追加
        </button>
      </div>
      <p className="hint-text">
        プレビュー画面でテキストを直接ドラッグすると、自由な位置に配置できます。
      </p>
      <div className="overlay-list">
        {project.textOverlays.length === 0 && (
          <div className="empty-state">
            <TypeIcon width={26} height={26} />
            <p className="hint-text">テキストはありません</p>
          </div>
        )}
        {project.textOverlays.map((o) => (
          <div key={o.id} className="overlay-item">
            <textarea
              className="overlay-text-input"
              rows={2}
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
              {o.source === 'auto' && <span className="project-badge">自動</span>}
            </div>

            <div className="overlay-item-row">
              <label>
                位置
                <select
                  value={o.style.position}
                  onChange={(e) =>
                    patchStyle(o.id, o.style, {
                      position: e.target.value as TextPosition,
                      customPosition: undefined
                    })
                  }
                >
                  <option value="top">上</option>
                  <option value="center">中央</option>
                  <option value="bottom">下</option>
                </select>
              </label>
              {o.style.customPosition && (
                <button
                  className="small-button"
                  title="プレビュー画面でドラッグした自由配置を解除し、プリセット位置に戻します"
                  onClick={() => patchStyle(o.id, o.style, { customPosition: undefined })}
                >
                  自由配置を解除
                </button>
              )}
              <label>
                サイズ
                <input
                  type="number"
                  min={16}
                  max={96}
                  step={2}
                  value={o.style.fontSize}
                  onChange={(e) => patchStyle(o.id, o.style, { fontSize: Number(e.target.value) })}
                />
              </label>
              <label>
                色
                <input
                  type="color"
                  value={o.style.color}
                  onChange={(e) => patchStyle(o.id, o.style, { color: e.target.value })}
                />
              </label>
            </div>

            <div className="overlay-item-row">
              {(() => {
                const pos = o.style.customPosition ?? defaultPositionFraction(o.style.position)
                return (
                  <>
                    <label>
                      X(%)
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(pos.x * 100)}
                        onChange={(e) =>
                          patchStyle(o.id, o.style, {
                            customPosition: {
                              x: Math.min(100, Math.max(0, Number(e.target.value))) / 100,
                              y: pos.y
                            }
                          })
                        }
                      />
                    </label>
                    <label>
                      Y(%)
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(pos.y * 100)}
                        onChange={(e) =>
                          patchStyle(o.id, o.style, {
                            customPosition: {
                              x: pos.x,
                              y: Math.min(100, Math.max(0, Number(e.target.value))) / 100
                            }
                          })
                        }
                      />
                    </label>
                  </>
                )
              })()}
              <label>
                回転(度)
                <input
                  type="number"
                  min={-180}
                  max={180}
                  step={1}
                  value={o.style.rotation}
                  onChange={(e) => patchStyle(o.id, o.style, { rotation: Number(e.target.value) })}
                />
              </label>
            </div>

            <div className="overlay-item-row">
              <label>
                フォント
                <select
                  value={o.style.fontFamily}
                  onChange={(e) =>
                    patchStyle(o.id, o.style, { fontFamily: e.target.value as FontFamily })
                  }
                >
                  {FONT_FAMILY_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={`toggle-chip ${o.style.bold ? 'active' : ''}`}
                onClick={() => patchStyle(o.id, o.style, { bold: !o.style.bold })}
              >
                B
              </button>
              <button
                className={`toggle-chip italic ${o.style.italic ? 'active' : ''}`}
                onClick={() => patchStyle(o.id, o.style, { italic: !o.style.italic })}
              >
                I
              </button>
            </div>

            <details className="overlay-advanced">
              <summary>詳細な装飾設定</summary>
              <div className="overlay-item-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={o.style.outline}
                    onChange={(e) => patchStyle(o.id, o.style, { outline: e.target.checked })}
                  />
                  縁取り
                </label>
                {o.style.outline && (
                  <>
                    <input
                      type="color"
                      value={o.style.outlineColor}
                      onChange={(e) => patchStyle(o.id, o.style, { outlineColor: e.target.value })}
                    />
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={o.style.outlineWidth}
                      onChange={(e) =>
                        patchStyle(o.id, o.style, { outlineWidth: Number(e.target.value) })
                      }
                    />
                  </>
                )}
              </div>
              <div className="overlay-item-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={o.style.shadow}
                    onChange={(e) => patchStyle(o.id, o.style, { shadow: e.target.checked })}
                  />
                  影
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={o.style.background}
                    onChange={(e) => patchStyle(o.id, o.style, { background: e.target.checked })}
                  />
                  背景ボックス
                </label>
                {o.style.background && (
                  <>
                    <input
                      type="color"
                      value={o.style.backgroundColor}
                      onChange={(e) =>
                        patchStyle(o.id, o.style, { backgroundColor: e.target.value })
                      }
                    />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={o.style.backgroundOpacity}
                      onChange={(e) =>
                        patchStyle(o.id, o.style, { backgroundOpacity: Number(e.target.value) })
                      }
                    />
                  </>
                )}
              </div>
              <div className="overlay-item-row">
                <label>
                  文字間隔
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={o.style.letterSpacing}
                    onChange={(e) =>
                      patchStyle(o.id, o.style, { letterSpacing: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  アニメーション
                  <select
                    value={o.style.animation}
                    onChange={(e) =>
                      patchStyle(o.id, o.style, { animation: e.target.value as TextAnimation })
                    }
                  >
                    <option value="none">なし</option>
                    <option value="fadeIn">フェードイン</option>
                    <option value="popIn">ポップイン</option>
                    <option value="slideInUp">スライドイン(下から)</option>
                    <option value="slideInDown">スライドイン(上から)</option>
                    <option value="bounce">バウンス</option>
                    <option value="typewriter">タイプライター</option>
                  </select>
                </label>
              </div>
            </details>

            <div className="overlay-item-row">
              <button className="icon-button" title="複製" onClick={() => handleDuplicate(o)}>
                <CopyIcon width={13} height={13} />
              </button>
              <button
                className="icon-button danger"
                title="削除"
                onClick={() => removeTextOverlay(o.id)}
              >
                <TrashIcon width={13} height={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
