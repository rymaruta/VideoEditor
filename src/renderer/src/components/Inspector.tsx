import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { isAspectMismatch } from '../lib/aspect'
import { buildTimedClips } from '../lib/timelineMath'
import type { TransitionType } from '@shared/types'
import { GaugeIcon, LayersIcon, MusicIcon, ScissorsIcon, TargetIcon } from './icons'

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const MIN_CLIP_SOURCE_DURATION = 0.1

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00.00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

/**
 * Properties of the selected clip, gathered in one place.
 *
 * The timeline toolbar keeps the *operations* (split, delete, duplicate, the AI cut
 * tools) — those act on a clip and finish. What lives here are the *values* a clip
 * carries, which previously had to be hunted down across a modal (trim, crop) and the
 * toolbar (speed, transition, audio), with no single place showing a clip's actual state.
 */
export function Inspector(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const multiSelectedClipIds = useProjectStore((s) => s.multiSelectedClipIds)
  const updateClipTrim = useProjectStore((s) => s.updateClipTrim)
  const updateClipSpeed = useProjectStore((s) => s.updateClipSpeed)
  const updateClipsSpeed = useProjectStore((s) => s.updateClipsSpeed)
  const updateClipCrop = useProjectStore((s) => s.updateClipCrop)
  const updateClipTransition = useProjectStore((s) => s.updateClipTransition)
  const detachClipAudio = useProjectStore((s) => s.detachClipAudio)
  const reattachClipAudio = useProjectStore((s) => s.reattachClipAudio)
  const seekTo = useProjectStore((s) => s.seekTo)

  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  const clip = project.clips.find((c) => c.id === selectedClipId) ?? null
  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined
  const timedClips = buildTimedClips(project)
  const index = timedClips.findIndex((tc) => tc.clip.id === selectedClipId)
  const timed = index >= 0 ? timedClips[index] : null

  if (multiSelectedClipIds.length > 1) {
    return (
      <div className="panel inspector-panel">
        <div className="panel-header">
          <h2>インスペクタ</h2>
        </div>
        <p className="hint-text">{multiSelectedClipIds.length}個のクリップを選択中です。</p>
        <div className="inspector-section">
          <h3>
            <GaugeIcon width={13} height={13} />
            再生速度(一括)
          </h3>
          <div className="inspector-speed-row">
            {SPEED_OPTIONS.map((s) => (
              <button
                key={s}
                className="small-button"
                onClick={() => updateClipsSpeed(multiSelectedClipIds, s)}
              >
                {s}x
              </button>
            ))}
          </div>
          <p className="hint-text">
            音声を分離済みのクリップは、音声トラックとズレるため速度変更の対象から外れます。
          </p>
        </div>
      </div>
    )
  }

  if (!clip || !asset) {
    return (
      <div className="panel inspector-panel">
        <div className="panel-header">
          <h2>インスペクタ</h2>
        </div>
        <div className="inspector-empty">
          <TargetIcon width={26} height={26} />
          <p>タイムラインのクリップを選択すると、そのクリップの設定がここに表示されます。</p>
        </div>
      </div>
    )
  }

  const speed = clip.speed || 1
  const sourceDuration = clip.outPoint - clip.inPoint
  const timelineDuration = sourceDuration / speed
  const mismatch = isAspectMismatch(asset, project.aspectRatio)
  const targetAspect = project.aspectRatio === '9:16' ? 9 / 16 : 16 / 9
  const cropCenter = clip.cropCenter ?? { x: 0.5, y: 0.5 }

  // In/out are clamped against each other so a clip can never be driven to a zero or
  // negative length by typing, which would make it vanish from the timeline.
  function setIn(value: number): void {
    if (!clip) return
    const next = Math.min(Math.max(0, value), clip.outPoint - MIN_CLIP_SOURCE_DURATION)
    updateClipTrim(clip.id, next, clip.outPoint)
  }

  function setOut(value: number): void {
    if (!clip || !asset) return
    const next = Math.max(Math.min(asset.duration, value), clip.inPoint + MIN_CLIP_SOURCE_DURATION)
    updateClipTrim(clip.id, clip.inPoint, next)
  }

  async function handleDetectCrop(): Promise<void> {
    if (!clip || !asset) return
    setDetecting(true)
    setDetectError(null)
    try {
      const center = await window.api.analyzeSmartCrop(
        asset.filePath,
        clip.inPoint,
        clip.outPoint,
        asset.width,
        asset.height,
        targetAspect
      )
      updateClipCrop(clip.id, true, center)
    } catch {
      setDetectError('被写体の自動検出に失敗しました')
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="panel inspector-panel">
      <div className="panel-header">
        <h2>インスペクタ</h2>
      </div>

      <div className="inspector-asset">
        {asset.thumbnailDataUrl && <img src={asset.thumbnailDataUrl} alt="" />}
        <div className="inspector-asset-info">
          <div className="inspector-asset-name" title={asset.fileName}>
            {asset.fileName}
          </div>
          <div className="media-meta">
            {index >= 0 && `${index + 1}番目 ・ `}
            {asset.width}x{asset.height} ・ {Math.round(asset.fps)}fps
          </div>
        </div>
      </div>

      <div className="inspector-section">
        <h3>
          <ScissorsIcon width={13} height={13} />
          尺とトリム
        </h3>
        <div className="inspector-field">
          <label>イン点(素材内)</label>
          <input
            type="number"
            min={0}
            max={asset.duration}
            step={0.1}
            value={Number(clip.inPoint.toFixed(2))}
            onChange={(e) => setIn(Number(e.target.value))}
          />
        </div>
        <input
          type="range"
          min={0}
          max={asset.duration}
          step={0.01}
          value={clip.inPoint}
          onChange={(e) => setIn(Number(e.target.value))}
        />
        <div className="inspector-field">
          <label>アウト点(素材内)</label>
          <input
            type="number"
            min={0}
            max={asset.duration}
            step={0.1}
            value={Number(clip.outPoint.toFixed(2))}
            onChange={(e) => setOut(Number(e.target.value))}
          />
        </div>
        <input
          type="range"
          min={0}
          max={asset.duration}
          step={0.01}
          value={clip.outPoint}
          onChange={(e) => setOut(Number(e.target.value))}
        />
        <div className="inspector-readout">
          <span>素材内の長さ {formatTime(sourceDuration)}</span>
          <span>タイムライン上 {formatTime(timelineDuration)}</span>
        </div>
        {timed && (
          <button className="small-button" onClick={() => seekTo(timed.start)}>
            このクリップの先頭へ移動
          </button>
        )}
      </div>

      <div className="inspector-section">
        <h3>
          <GaugeIcon width={13} height={13} />
          再生速度
        </h3>
        <select
          value={speed}
          disabled={clip.audioDetached}
          onChange={(e) => updateClipSpeed(clip.id, Number(e.target.value))}
        >
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        {clip.audioDetached && (
          <p className="hint-text">
            音声を分離済みのため変更できません(音声トラックとズレるため)。
          </p>
        )}
      </div>

      {mismatch && (
        <div className="inspector-section">
          <h3>
            <TargetIcon width={13} height={13} />
            フレーミング
          </h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={clip.fillCrop ?? false}
              onChange={(e) => updateClipCrop(clip.id, e.target.checked, clip.cropCenter)}
            />
            クロップして画面いっぱいに表示(黒帯なし)
          </label>
          <p className="hint-text">
            素材の比率がプロジェクトと異なります。有効にすると余白は消えますが、左右(または上下)が切り取られます。
          </p>
          {clip.fillCrop && (
            <>
              <div className="inspector-field">
                <label>切り取り位置 横 {Math.round(cropCenter.x * 100)}%</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={cropCenter.x}
                  onChange={(e) =>
                    updateClipCrop(clip.id, true, { ...cropCenter, x: Number(e.target.value) })
                  }
                />
              </div>
              <div className="inspector-field">
                <label>切り取り位置 縦 {Math.round(cropCenter.y * 100)}%</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={cropCenter.y}
                  onChange={(e) =>
                    updateClipCrop(clip.id, true, { ...cropCenter, y: Number(e.target.value) })
                  }
                />
              </div>
              <div className="inspector-button-row">
                <button className="small-button" onClick={handleDetectCrop} disabled={detecting}>
                  {detecting ? '検出中...' : '被写体を自動検出'}
                </button>
                <button
                  className="small-button"
                  onClick={() => updateClipCrop(clip.id, true, { x: 0.5, y: 0.5 })}
                  disabled={detecting}
                >
                  中央に戻す
                </button>
              </div>
              {detectError && <p className="error-text">{detectError}</p>}
            </>
          )}
        </div>
      )}

      {index > 0 && (
        <div className="inspector-section">
          <h3>
            <LayersIcon width={13} height={13} />
            前のクリップからの繋ぎ
          </h3>
          <select
            value={clip.transitionIn?.type ?? 'none'}
            onChange={(e) =>
              updateClipTransition(
                clip.id,
                e.target.value === 'none'
                  ? undefined
                  : {
                      type: e.target.value as TransitionType,
                      duration: clip.transitionIn?.duration ?? 0.5
                    }
              )
            }
          >
            <option value="none">カット(繋ぎなし)</option>
            <option value="crossfade">クロスフェード</option>
            <option value="fade">フェード</option>
            <option value="wipe">ワイプ</option>
          </select>
          {clip.transitionIn && (
            <div className="inspector-field">
              <label>長さ(秒)</label>
              <input
                type="number"
                min={0.1}
                max={2}
                step={0.1}
                value={clip.transitionIn.duration}
                onChange={(e) =>
                  updateClipTransition(clip.id, {
                    type: clip.transitionIn?.type ?? 'crossfade',
                    duration: Number(e.target.value)
                  })
                }
              />
            </div>
          )}
        </div>
      )}

      <div className="inspector-section">
        <h3>
          <MusicIcon width={13} height={13} />
          音声
        </h3>
        {!asset.hasAudio ? (
          <p className="hint-text">この素材に音声は含まれていません。</p>
        ) : clip.audioDetached ? (
          <p className="hint-text">
            音声トラックに分離済みです。音量やタイミングは音声トラック側で調整します。
          </p>
        ) : null}
        {clip.audioDetached ? (
          <button
            className="small-button"
            title="分離をやめて、このクリップ自身の音声を鳴らします。分離した音声トラックが残っている場合は二重に鳴るので、不要なら音声トラック側を削除してください"
            onClick={() => reattachClipAudio(clip.id)}
          >
            <MusicIcon width={12} height={12} />
            音声を戻す
          </button>
        ) : (
          <>
            <button
              className="small-button"
              disabled={speed !== 1}
              title={
                speed !== 1
                  ? '再生速度が1x以外のクリップは音声を分離できません'
                  : '動画から音声を切り離し、独立した音声トラックに分けます'
              }
              onClick={() => detachClipAudio(clip.id)}
            >
              <MusicIcon width={12} height={12} />
              音声を分離
            </button>
            {speed !== 1 && <p className="hint-text">再生速度が1x以外のため分離できません。</p>}
          </>
        )}
      </div>
    </div>
  )
}
