import { TelopInspector } from './TelopInspector'
import { useState } from 'react'
import { MIN_CLIP_SOURCE_DURATION, useProjectStore } from '../store/projectStore'
import { isAspectMismatch } from '../lib/aspect'
import { buildTimedClips, speedSelectChoices } from '../lib/timelineMath'
import { CLIP_COLORS } from '../lib/clipColors'
import { transitionSecondsForClip } from '@shared/transition'
import { frameSeconds } from '@shared/frameRate'
import type { ClipColorLabel, TransitionType } from '@shared/types'
import { GaugeIcon, LayersIcon, MusicIcon, ScissorsIcon, TagIcon, TargetIcon } from './icons'
import { DraftNumber } from './DraftNumber'

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

/**
 * 色ラベルの選択欄。単一選択でも複数選択でも同じものを使う。
 * `current` は複数選択でばらばらのときに undefined になり、どれも選択中に見えない。
 */
function ClipColorPicker({
  current,
  mixed = false,
  onPick
}: {
  current: ClipColorLabel | undefined
  /** 複数選択で色がばらばらのとき。どのボタンも選択中にしない */
  mixed?: boolean
  onPick: (label: ClipColorLabel | undefined) => void
}): React.JSX.Element {
  return (
    <div className="clip-color-row">
      <button
        type="button"
        className={`clip-color-swatch clip-color-none ${
          !mixed && current === undefined ? 'active' : ''
        }`}
        title="色ラベルを外す"
        onClick={() => onPick(undefined)}
      >
        なし
      </button>
      {CLIP_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`clip-color-swatch ${!mixed && current === c.id ? 'active' : ''}`}
          style={{ background: c.color }}
          title={c.label}
          aria-label={c.label}
          onClick={() => onPick(c.id)}
        />
      ))}
    </div>
  )
}

/** つまみを動かしている間は欄の中だけで動かし、離したときに反映するスライダー(`DraftNumber` と同じ理由) */
function DraftRange({
  value,
  min,
  max,
  step,
  onCommit
}: {
  value: number
  min: number
  max: number
  step: number
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<number | null>(null)
  const commit = (): void => {
    if (draft === null) return
    setDraft(null)
    onCommit(draft)
  }
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={draft ?? value}
      onChange={(e) => setDraft(Number(e.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  )
}

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
  const updateClipsColorLabel = useProjectStore((s) => s.updateClipsColorLabel)
  const updateClipCrop = useProjectStore((s) => s.updateClipCrop)
  const updateClipBlurBackground = useProjectStore((s) => s.updateClipBlurBackground)
  const updateClipTransition = useProjectStore((s) => s.updateClipTransition)
  const detachClipAudio = useProjectStore((s) => s.detachClipAudio)
  const reattachClipAudio = useProjectStore((s) => s.reattachClipAudio)
  const seekTo = useProjectStore((s) => s.seekTo)

  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  const selectedOverlayId = useProjectStore((s) => s.selectedOverlayId)
  const selectedOverlay = project.textOverlays.find((o) => o.id === selectedOverlayId) ?? null
  const clip = project.clips.find((c) => c.id === selectedClipId) ?? null
  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined
  const timedClips = buildTimedClips(project)
  const index = timedClips.findIndex((tc) => tc.clip.id === selectedClipId)
  const timed = index >= 0 ? timedClips[index] : null
  // 指定した繋ぎの長さと、実際に掛かる長さ。詰められているときだけ画面に出す
  // 書き出しと同じく、尺をフレームに丸めてから実際に掛かる長さを出す
  const transitionSeconds = clip
    ? transitionSecondsForClip(
        project.clips,
        clip.id,
        1 / frameSeconds(project.clips, project.assets)
      )
    : null
  const trimmedTransition =
    transitionSeconds && transitionSeconds.effective < transitionSeconds.specified - 0.005
      ? transitionSeconds
      : null

  // 選択中の色がばらばらのときは undefined にして、どの色も選択中に見せない
  const multiSelectedClips = project.clips.filter((c) => multiSelectedClipIds.includes(c.id))
  const firstColorLabel = multiSelectedClips[0]?.colorLabel
  const multiColorsMixed = !multiSelectedClips.every((c) => c.colorLabel === firstColorLabel)

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
        <div className="inspector-section">
          <h3>
            <TagIcon width={13} height={13} />
            色ラベル(一括)
          </h3>
          <ClipColorPicker
            current={firstColorLabel}
            mixed={multiColorsMixed}
            onPick={(label) => updateClipsColorLabel(multiSelectedClipIds, label)}
          />
          <p className="hint-text">
            選択中のクリップにまとめて色を付けます。書き出しの内容には影響しません。
          </p>
        </div>
      </div>
    )
  }

  // 本編クリップではなくテロップが選ばれていれば、そのテロップの設定を出す
  if (!clip && selectedOverlay) {
    return (
      <div className="panel inspector-panel">
        <div className="panel-header">
          <h2>インスペクタ — テロップ</h2>
        </div>
        <TelopInspector key={selectedOverlay.id} overlay={selectedOverlay} />
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
          <p>タイムラインのクリップやテロップを選択すると、その設定がここに表示されます。</p>
        </div>
      </div>
    )
  }

  const speed = clip.speed || 1
  const speedChoices = speedSelectChoices(speed, SPEED_OPTIONS)
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
          <DraftNumber
            min={0}
            max={asset.duration}
            step={0.1}
            value={clip.inPoint}
            onCommit={setIn}
          />
        </div>
        <DraftRange
          min={0}
          max={asset.duration}
          step={0.01}
          value={clip.inPoint}
          onCommit={setIn}
        />
        <div className="inspector-field">
          <label>アウト点(素材内)</label>
          <DraftNumber
            min={0}
            max={asset.duration}
            step={0.1}
            value={clip.outPoint}
            onCommit={setOut}
          />
        </div>
        <DraftRange
          min={0}
          max={asset.duration}
          step={0.01}
          value={clip.outPoint}
          onCommit={setOut}
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
          value={speedChoices.value}
          onChange={(e) => updateClipSpeed(clip.id, Number(e.target.value))}
        >
          {speedChoices.options.map((s) => (
            <option key={s} value={s}>
              {Number(s.toFixed(4))}x
            </option>
          ))}
        </select>
        {clip.audioDetached && (
          <p className="hint-text">分離した音声トラックにも同じ速度が掛かります。</p>
        )}
      </div>

      <div className="inspector-section">
        <h3>
          <TagIcon width={13} height={13} />
          色ラベル
        </h3>
        <ClipColorPicker
          current={clip.colorLabel}
          onPick={(label) => updateClipsColorLabel([clip.id], label)}
        />
        <p className="hint-text">
          タイムライン上で見分けるための色です。書き出しの内容には影響しません。
        </p>
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
          {!clip.fillCrop && (
            <>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={clip.blurBackground ?? false}
                  onChange={(e) => updateClipBlurBackground(clip.id, e.target.checked)}
                />
                余白を素材のぼかしで埋める(黒帯にしない)
              </label>
              <p className="hint-text">
                切り取らずに余白だけを埋めます。端に情報がある素材でも、
                黒帯を出さずに画面全体を使えます。
              </p>
            </>
          )}
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
          {/* 隣に入らないぶんは書き出しが黙って詰めている。指定した数字だけを見せると、
              半分以下しか掛かっていないことに気付けない(理由と実測は transitionSecondsForClip)。 */}
          {trimmedTransition && (
            <p className="hint-text">
              隣のクリップに入らないため、実際は{' '}
              <strong>{trimmedTransition.effective.toFixed(2)}秒</strong>
              だけ掛かります(指定 {trimmedTransition.specified}秒)。
            </p>
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
              title="動画から音声を切り離し、独立した音声トラックに分けます(再生速度はそのまま引き継がれます)"
              onClick={() => detachClipAudio(clip.id)}
            >
              <MusicIcon width={12} height={12} />
              音声を分離
            </button>
          </>
        )}
      </div>
    </div>
  )
}
