import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { usePipelineStore } from '../store/pipelineStore'
import { useTimelineSubSelection } from '../lib/timelineSelection'
import { useInspectorTab, INSPECTOR_TABS } from '../lib/inspectorTab'
import { decisionForClip, SCENE_KIND_LABEL } from '../lib/clipDecision'
import { emitMenuCommand } from '../lib/menuCommands'
import {
  COLOR_VERDICT_TEXT,
  describeColorMatch,
  GAIN_LIMIT,
  OFFSET_LIMIT,
  type ColorMatch
} from '@shared/color/match'
import type { MediaAsset } from '@shared/types'
import { LockIcon, SparklesIcon, TargetIcon, WandIcon } from './icons'

/** インスペクタの見出しのタブ(プロパティ / 色 / AI の判断) */
export function InspectorTabBar(): React.JSX.Element {
  const tab = useInspectorTab((s) => s.tab)
  const setTab = useInspectorTab((s) => s.setTab)
  return (
    <div className="panel-tabs-list ve-inspector-tabs" role="tablist" aria-label="インスペクタ">
      {INSPECTOR_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className={`panel-tab ${tab === t.id ? 'active' : ''}`}
          title={t.description}
          onClick={() => setTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** 色・AI の判断のタブが相手にするクリップ(本編、無ければ選んだワイプ) */
function useTargetAsset(): { asset: MediaAsset; what: 'main' | 'overlay' } | null {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const overlaySel = useTimelineSubSelection((s) => s.videoOverlay)
  const clip = project.clips.find((c) => c.id === selectedClipId)
  if (clip) {
    const asset = project.assets.find((a) => a.id === clip.assetId)
    return asset ? { asset, what: 'main' } : null
  }
  if (overlaySel) {
    const oc = project.videoOverlayTracks
      .find((t) => t.id === overlaySel.trackId)
      ?.clips.find((c) => c.id === overlaySel.clipId)
    const asset = oc ? project.assets.find((a) => a.id === oc.assetId) : undefined
    return asset && !asset.still ? { asset, what: 'overlay' } : null
  }
  return null
}

function EmptyNote({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="inspector-empty">
      <TargetIcon width={32} height={32} />
      <p>{text}</p>
    </div>
  )
}

const IDENTITY: ColorMatch = { gain: [1, 1, 1], offset: [0, 0, 0] }
const CHANNELS = ['赤', '緑', '青'] as const

/** つまみを離したときに反映する(取り消しは 1 回で戻る) */
function ColorSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  const commit = (): void => {
    if (draft === null) return
    setDraft(null)
    onCommit(draft)
  }
  return (
    <label className="ve-color-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-valuetext={format(shown)}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="ve-color-slider-value">{format(shown)}</span>
    </label>
  )
}

/** 色: 素材(カメラ)の色合わせ。自動編集が合わせた値を見て直す・外す。手で合わせ始めることもできる */
export function InspectorColor(): React.JSX.Element {
  const target = useTargetAsset()
  const setColorMatches = useProjectStore((s) => s.setColorMatches)
  const colorIssues = usePipelineStore((s) => s.colorIssues)
  if (!target)
    return <EmptyNote text="本編かワイプのクリップを選ぶと、その素材の色合わせがここに出ます。" />
  const { asset } = target
  const m = asset.colorMatch
  // 自動で合わせなかったカメラ(同期した素材の機材の名前で覚えている)
  const multicam = useProjectStore.getState().project.multicam
  const sourceId = multicam?.files.find((f) => f.assetId === asset.id)?.sourceId
  const cameraName = multicam?.sources.find((src) => src.id === sourceId)?.name
  const issue = cameraName ? colorIssues.find((c) => c.name === cameraName) : undefined
  const set = (next: ColorMatch | undefined): void => setColorMatches({ [asset.id]: next })
  const update = (kind: 'gain' | 'offset', ch: number, v: number): void => {
    const base = m ?? IDENTITY
    const arr = [...base[kind]] as [number, number, number]
    arr[ch] = v
    set({ ...base, [kind]: arr })
  }
  return (
    <div className="panel inspector-panel ve-inspector-color">
      <div className="inspector-asset">
        {asset.thumbnailDataUrl && <img src={asset.thumbnailDataUrl} alt="" />}
        <div className="inspector-asset-info">
          <div className="inspector-asset-name" title={asset.fileName}>
            {asset.fileName}
          </div>
          <div className="media-meta">
            {m ? `色合わせ: ${describeColorMatch(m)}` : '色合わせ: なし(元の色)'}
          </div>
        </div>
      </div>
      <div className="inspector-section">
        <h3>
          <WandIcon width={14} height={14} />
          色合わせ
        </h3>
        <p className="hint-text">
          同じ素材(カメラ)を使うクリップすべてに掛かり、書き出しにも入ります。自動編集はカメラごとの色を基準のカメラに合わせます。
        </p>
        {issue && (
          <p className="hint-text">
            {cameraName}: {COLOR_VERDICT_TEXT[issue.verdict]}。
          </p>
        )}
        {CHANNELS.map((name, ch) => (
          <div key={name} className="ve-color-channel">
            <ColorSlider
              label={`${name}の倍率`}
              value={(m ?? IDENTITY).gain[ch]}
              min={GAIN_LIMIT[0]}
              max={GAIN_LIMIT[1]}
              step={0.005}
              format={(v) => `×${v.toFixed(3)}`}
              onCommit={(v) => update('gain', ch, v)}
            />
            <ColorSlider
              label={`${name}の足し込み`}
              value={(m ?? IDENTITY).offset[ch]}
              min={-OFFSET_LIMIT}
              max={OFFSET_LIMIT}
              step={0.002}
              format={(v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`}
              onCommit={(v) => update('offset', ch, v)}
            />
          </div>
        ))}
        <div className="inspector-button-row">
          <button
            type="button"
            className="small-button"
            disabled={!m}
            title="色合わせを外して元の色に戻します(元に戻すで再び掛かります)"
            onClick={() => set(undefined)}
          >
            色合わせを外す
          </button>
        </div>
      </div>
    </div>
  )
}

/** AI の判断: 自動編集がこのクリップをなぜこうしたか(今あるデータから) */
export function InspectorDecision(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const scenes = usePipelineStore((s) => s.scenes)
  const judgements = usePipelineStore((s) => s.judgements)
  const planJudgements = usePipelineStore((s) => s.planJudgements)
  const keep = usePipelineStore((s) => s.keep)
  const judgeSource = usePipelineStore((s) => s.judgeSource)
  const clip = project.clips.find((c) => c.id === selectedClipId)
  if (!clip) return <EmptyNote text="本編のクリップを選ぶと、自動編集の判断がここに出ます。" />
  if (!project.multicam)
    return (
      <EmptyNote text="この企画は素材を手で並べたもので、自動編集の判断はありません(同期した収録素材から自動編集した企画で出ます)。" />
    )
  const d = decisionForClip(clip, project, {
    scenes,
    judgements: planJudgements ?? judgements,
    keep,
    judgeSource
  })
  const actions = (
    <div className="inspector-button-row">
      <button
        type="button"
        className="small-button"
        title="選んだ範囲(無ければこのクリップ)だけを、指示を変えて自動編集し直します"
        onClick={() => emitMenuCommand('edit.rangeAutoEdit')}
      >
        <SparklesIcon width={12} height={12} />
        この範囲を再編集
      </button>
      <button
        type="button"
        className="small-button"
        title="選んだ範囲(無ければこのクリップ)を、自動編集で作り直さない範囲にします"
        onClick={() => emitMenuCommand('edit.rangeLock')}
      >
        <LockIcon width={12} height={12} />
        ロック
      </button>
    </div>
  )
  if (!d)
    return (
      <div className="panel inspector-panel">
        <EmptyNote text="このクリップは同期した収録素材から作られていないため、判断の記録がありません。" />
        {actions}
      </div>
    )
  return (
    <div className="panel inspector-panel ve-inspector-decision">
      <div className="inspector-section">
        <h3>
          <SparklesIcon width={14} height={14} />
          場面の判定
          {d.judgeSource && (
            <span className="ve-decision-source">
              {d.judgeSource === 'ai' ? 'AI' : '簡易の点数'}
            </span>
          )}
        </h3>
        {d.scenes.length === 0 ? (
          <p className="hint-text">
            {scenes.length === 0
              ? '場面の解析の結果がまだ読み込まれていません(自動編集の画面を開くと戻ります)。'
              : 'このクリップに重なる場面はありません。'}
          </p>
        ) : (
          <ul className="ve-decision-scenes">
            {d.scenes.map((sc) => (
              <li key={sc.id} className="ve-decision-scene">
                <div className="ve-decision-scene-head">
                  {sc.kind && (
                    <span className={`structure-kind ${sc.kind}`}>{SCENE_KIND_LABEL[sc.kind]}</span>
                  )}
                  <span className="ve-decision-title">{sc.title ?? '場面'}</span>
                  {sc.score !== null && (
                    <span className="ve-decision-score" title="残したい度合い(0〜100)">
                      {Math.round(sc.score)}点
                    </span>
                  )}
                </div>
                {sc.reason && <p className="ve-decision-reason">{sc.reason}</p>}
                {sc.keep !== undefined && (
                  <p className="hint-text">
                    {sc.keep
                      ? '画面で「残す」に決めた場面です。'
                      : '画面で「落とす」に決めた場面です。'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="inspector-section">
        <h3>
          <WandIcon width={14} height={14} />
          カメラと手の判断
        </h3>
        <dl className="ve-decision-facts">
          <dt>カメラ</dt>
          <dd>
            {d.camera ? `${d.camera.name}${d.camera.subject ? `(${d.camera.subject})` : ''}` : '—'}
            {d.manualAngle ? '・手で替えた' : ''}
          </dd>
          <dt>手の修正</dt>
          <dd>{d.manualAdded ? '手で足した区間を含む' : 'なし'}</dd>
          <dt>ロック</dt>
          <dd>{d.locked ? '作り直さない範囲に入っている' : 'なし'}</dd>
        </dl>
        {actions}
      </div>
    </div>
  )
}
