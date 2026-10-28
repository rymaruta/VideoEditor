import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePipelineStore } from '../store/pipelineStore'
import { getTotalDuration, useProjectStore } from '../store/projectStore'
import { useReviewItems } from '../lib/useReviewItems'
import type { ReviewItem } from '../lib/reviewItems'
import { formatTimecode } from '../lib/timelineRuler'
import { buildTimedClips, findTimedClipAt } from '../lib/timelineMath'
import {
  foreignBetweenOf,
  lineAtTime,
  rangeOfLines,
  reviewTranscriptLines,
  type LinesRange,
  type TranscriptLine
} from '../lib/reviewTranscript'
import { timelineAudioPieces, useWaveLevels, type WavePiece } from '../lib/timelineWave'
import { dockRectOf, useProgramDock } from '../lib/programDock'
import { requestRangeAutoEdit } from '../lib/timelineRange'
import { rangedEditBlockedReason } from '../lib/rangedAutoEdit'
import { lockTimelineRange, rippleDeleteRange, switchRangesAngle } from '../lib/editCommands'
import { cameraLabel, decisionForClip } from '../lib/clipDecision'
import { commonSpan } from '../lib/autoEditView'
import { isModalOpen, isTypingTarget } from '../lib/useKeyboardShortcuts'
import { speakerOrderIndex, speakersInOrder } from '@shared/speaker'
import { fileAt, toCommon, toSource } from '@shared/sync/multicam'
import { frameSeconds } from '@shared/frameRate'
import type { TimelineRange } from '@shared/roughCut/range'
import type { Project } from '@shared/types'
import { WaveBars } from './WaveBars'
import { DecisionSummary } from './DecisionSummary'
import { LockIcon, PauseIcon, PlayIcon, SparklesIcon } from './icons'

/**
 * 確認の画面(上の帯の「確認」)。デザイン案の Review。
 *
 * 左に要確認の一覧(カード)とこの回の仮編集の数、中央に文字起こし(削った所は取り消し線・選んだ文が範囲)、
 * 右にプログラム(範囲を再生)・範囲の波形・カメラの一覧・AI の判断、下に全体の帯。
 * 新しい編集の仕組みは作らない: 範囲の作り直しは範囲の自動編集(案を選ぶ)、削除は Shift+Delete と同じ
 * リップル削除、ロックは範囲のロック、カメラはクリップのアングルの差し替えをそのまま使う。
 */

type FixTab = 'sync' | 'transcript' | 'effects'

/** 時刻を「1:52」の形で(要確認・文字起こしの行) */
function clock(sec: number): string {
  const v = Math.max(0, Math.floor(sec))
  const h = Math.floor(v / 3600)
  const m = Math.floor((v % 3600) / 60)
  const s = v % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/** 選んだ文が本編で離れて並んでいるときの理由(削除・再編集・ロックは外枠に当たるので押せない) */
const APART_REASON = '選んだ文が本編で離れて並んでいます。続いている所だけを選んでください'

/** 範囲の自動編集の案を試している間の理由(試しの関所。RangeAutoEditDialog と同じ文) */
const TRIAL_REASON = '試している間は編集できません。この案にするか、閉じてから編集してください'

/** 話者の色の点(--ve-speaker-*。この回で出てきた順の番号) */
function SpeakerDot({ index: i }: { index: number | null }): React.JSX.Element {
  return (
    <span
      className="ve-review-dot"
      style={{ background: i === null ? 'var(--ve-text-icon)' : `var(--ve-speaker-${i})` }}
      aria-hidden="true"
    />
  )
}

/** 収録の長さ(同期した素材は共通の時間軸、手で並べた企画は本編の素材の長さの合計) */
function recordedLength(project: Project): number {
  const span = commonSpan(project)
  if (span > 0) return span
  const used = new Set(project.clips.map((c) => c.assetId))
  return project.assets.filter((a) => used.has(a.id)).reduce((t, a) => t + (a.duration || 0), 0)
}

/** そのカメラの、タイムラインの区間に当たる音(本編の各クリップの時刻を、そのカメラの素材の時刻へ) */
function cameraAudioPieces(
  project: Project,
  sourceId: string,
  start: number,
  end: number
): WavePiece[] {
  const info = project.multicam
  if (!info) return []
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const assetOf = new Map(project.assets.map((a) => [a.id, a]))
  const out: WavePiece[] = []
  for (const tc of buildTimedClips(project)) {
    const a = Math.max(start, tc.start)
    const b = Math.min(end, tc.end)
    if (b - a <= 1e-3) continue
    const f = fileOf.get(tc.clip.assetId)
    if (!f) continue
    const speed = tc.clip.speed || 1
    const ca = toCommon(f, tc.clip.inPoint + (a - tc.start) * speed)
    const cb = toCommon(f, tc.clip.inPoint + (b - tc.start) * speed)
    const g = fileAt(info, sourceId, ca)
    const asset = g ? assetOf.get(g.assetId) : undefined
    if (!g || !asset?.hasAudio) continue
    const gEnd = g.start + g.duration / (g.rate || 1)
    const cEnd = Math.min(cb, gEnd)
    if (cEnd - ca <= 1e-3) continue
    out.push({
      filePath: asset.filePath,
      srcStart: toSource(g, ca),
      srcEnd: toSource(g, cEnd),
      tlStart: a,
      tlEnd: a + (cEnd - ca) * ((b - a) / Math.max(1e-9, cb - ca))
    })
  }
  return out
}

/** 1 枚の絵(素材のその時刻)。同じ絵は使い回す */
const frameCache = new Map<string, Promise<string>>()
function FrameImage({
  filePath,
  at,
  alt
}: {
  filePath: string | null
  at: number
  alt: string
}): React.JSX.Element {
  const key = filePath ? `${filePath}|${at.toFixed(1)}` : ''
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null)
  useEffect(() => {
    if (!filePath) return
    let alive = true
    let p = frameCache.get(key)
    if (!p) {
      p = window.api.generateThumbnail(filePath, at)
      p.catch(() => frameCache.delete(key))
      frameCache.set(key, p)
      if (frameCache.size > 120) {
        const first = frameCache.keys().next().value
        if (first !== undefined) frameCache.delete(first)
      }
    }
    p.then(
      (url) => alive && setShown({ key, url }),
      () => {}
    )
    return () => {
      alive = false
    }
    // at・filePath は key から決まる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return shown ? <img src={shown.url} alt={alt} draggable={false} /> : <span aria-hidden="true" />
}

// ------------------------------------------------------------------ 左: 要確認

function ReviewCards({
  onSeek,
  onFix
}: {
  onSeek: (t: number) => void
  onFix: (item: ReviewItem) => void
}): React.JSX.Element {
  const { open, done } = useReviewItems()
  const project = useProjectStore((s) => s.project)
  const report = usePipelineStore((s) => s.report)
  const [showDone, setShowDone] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const list = showDone ? done : open
  const total = getTotalDuration(project)
  return (
    <aside className="ve-review-left" aria-label="要確認">
      <div className="ve-review-head">
        <span className="ve-review-title">
          {showDone ? '対応済み' : '要確認'}{' '}
          <span className={`mono ${showDone ? '' : 've-review-count'}`}>
            {(showDone ? done : open).length}
          </span>
        </span>
        <button
          type="button"
          className="ve-review-link"
          aria-pressed={showDone}
          onClick={() => setShowDone((v) => !v)}
          title={showDone ? '要確認の一覧へ戻る' : '「このままにする」にした項目を見る'}
        >
          {showDone ? '要確認' : '対応済み'}{' '}
          <span className="mono">{(showDone ? open : done).length}</span>
        </button>
      </div>
      <ul className="ve-review-cards">
        {list.map((d) => {
          const on = current === d.key
          const fixLabel = d.overlayId
            ? 'テロップを直す'
            : d.tab
              ? '直す'
              : d.at !== undefined
                ? 'この所を見る'
                : null
          return (
            <li key={d.key}>
              <div
                className={`ve-review-card ${on ? 'on' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                onClick={() => {
                  setCurrent(d.key)
                  if (d.at !== undefined) onSeek(d.at)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  setCurrent(d.key)
                  if (d.at !== undefined) onSeek(d.at)
                }}
              >
                <div className="ve-review-card-head">
                  <span className="ve-review-card-dot" aria-hidden="true" />
                  <span className="ve-review-card-title">{d.kind}</span>
                  {d.at !== undefined && d.at <= total + 1 && (
                    <span className="mono ve-review-card-at">{clock(d.at)}</span>
                  )}
                </div>
                <span className="ve-review-card-body">{d.text}</span>
                <div className="ve-review-card-actions">
                  {fixLabel && !showDone && (
                    <button
                      type="button"
                      className="ve-review-button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setCurrent(d.key)
                        onFix(d)
                      }}
                    >
                      {fixLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ve-review-button ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      usePipelineStore.getState().markReviewed(d.key, !showDone)
                    }}
                  >
                    {showDone ? '要確認に戻す' : 'このままにする'}
                  </button>
                </div>
              </div>
            </li>
          )
        })}
        {list.length === 0 && (
          <li className="ve-review-empty">
            {showDone
              ? 'まだありません。'
              : report || project.multicam
                ? '確認が必要な箇所はありません。'
                : '自動編集の工程が進むと、自信の低い箇所がここに並びます。'}
          </li>
        )}
      </ul>
      <div className="ve-review-stats" aria-label="この回の仮編集">
        <span className="ve-review-section">この回の仮編集</span>
        <div className="ve-review-stat-grid">
          <div>
            <span className="mono">{clock(recordedLength(project))}</span>
            <span>収録の長さ</span>
          </div>
          <div>
            <span className="mono">{clock(total)}</span>
            <span>仕上がり</span>
          </div>
          <div>
            <span className="mono">{project.clips.length.toLocaleString()}</span>
            <span>クリップ</span>
          </div>
        </div>
      </div>
    </aside>
  )
}

// ------------------------------------------------------------------ 中央: 文字起こし

function TranscriptRow({
  line,
  index,
  colorIndex,
  picked,
  apart,
  continues,
  hideCut,
  onPick
}: {
  line: TranscriptLine
  index: number
  colorIndex: number | null
  picked: boolean
  /** 選んだ文が本編で離れて並んでいる(下地を縞にして分かるようにする) */
  apart: boolean
  /** 次の行も選んでいる(下地を次の行までつなぐ) */
  continues: boolean
  hideCut: boolean
  onPick: (index: number, extend: boolean) => void
}): React.JSX.Element {
  return (
    <div
      className={`ve-review-line ${picked ? 'picked' : ''} ${picked && apart ? 'apart' : ''} ${continues ? 'continues' : ''} ${line.allCut ? 'all-cut' : ''}`}
      data-line={index}
    >
      <div className="ve-review-line-who">
        <span className="ve-review-speaker">
          <SpeakerDot index={colorIndex} />
          {line.speaker ?? '話者不明'}
        </span>
        <span className="mono ve-review-line-at">
          {line.start !== null ? clock(line.start) : '削除'}
        </span>
      </div>
      <p
        className="ve-review-line-text"
        role="button"
        tabIndex={0}
        aria-pressed={picked}
        title="押すとこの文を選びます(Shift で続けて選ぶ)"
        onClick={(e) => onPick(index, e.shiftKey)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          onPick(index, e.shiftKey)
        }}
      >
        {line.parts.map((p, i) =>
          p.cut && hideCut ? null : (
            <span key={i} className={p.cut ? 've-review-cut' : undefined}>
              {p.text}
            </span>
          )
        )}
        {line.overlap && <span className="ve-review-tag">重なり</span>}
      </p>
    </div>
  )
}

function RangeBar({
  range,
  fps,
  apart,
  onReEdit,
  onKeep,
  onDelete,
  onLock
}: {
  range: TimelineRange | null
  fps: number
  /** 選んだ文が本編で離れて並んでいる */
  apart: boolean
  onReEdit: () => void
  onKeep: () => void
  onDelete: () => void
  onLock: () => void
}): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const scenes = usePipelineStore((s) => s.scenes)
  const restored = usePipelineStore((s) => s.restored)
  const running = usePipelineStore((s) => s.running)
  const inTrial = useProjectStore((s) => s.trial !== null)
  const blocked = apart
    ? APART_REASON
    : inTrial
      ? TRIAL_REASON
      : rangedEditBlockedReason(project, { scenes, restored, running })
  const none = range === null
  const noneTitle = '削った所だけを選んでいます。前後の文も選んでください'
  const editBlocked = apart ? APART_REASON : inTrial ? TRIAL_REASON : null
  return (
    <div className="ve-review-line ve-review-barrow">
      <span />
      <div className="ve-review-rangebar" role="toolbar" aria-label="選んだ範囲">
        <span
          className="mono ve-review-rangebar-tc"
          title={
            range
              ? `選んだ範囲(イン ${formatTimecode(range.start, fps)} – アウト ${formatTimecode(range.end, fps)})`
              : undefined
          }
        >
          {range ? (
            <>
              {/* 狭い列(1366 幅)ではイン・アウトを 2 段に積み、コマまで出したまま幅を詰める */}
              <span className="ve-tc-full">
                {formatTimecode(range.start, fps)} – {formatTimecode(range.end, fps)}
              </span>
              <span className="ve-tc-short">
                <span>{formatTimecode(range.start, fps)}</span>
                <span>– {formatTimecode(range.end, fps)}</span>
              </span>
            </>
          ) : (
            '範囲なし'
          )}
        </span>
        <button
          type="button"
          className="ve-review-button strong"
          disabled={none || blocked !== null}
          title={
            none
              ? noneTitle
              : (blocked ?? 'この範囲だけを、案を見比べて自動で作り直します(取り消しは Ctrl+Z)')
          }
          onClick={onReEdit}
        >
          <SparklesIcon width={12} height={12} className="ve-review-ai-icon" />
          この範囲を再編集
        </button>
        <button
          type="button"
          className="ve-review-button flat"
          disabled={none || blocked !== null}
          title={
            none
              ? noneTitle
              : (blocked ??
                '案C「残す」(間を控えめに詰め、残す基準をゆるく)を選んだ状態で、範囲の作り直しを開きます')
          }
          onClick={onKeep}
        >
          残す
        </button>
        <button
          type="button"
          className="ve-review-button flat"
          disabled={none || project.mainTrackLocked === true || editBlocked !== null}
          title={
            none
              ? noneTitle
              : editBlocked
                ? editBlocked
                : project.mainTrackLocked
                  ? '本編は固定されています'
                  : 'この範囲を本編から抜いて詰めます(Shift+Delete と同じ。取り消しは Ctrl+Z)'
          }
          onClick={onDelete}
        >
          削除
        </button>
        <button
          type="button"
          className="ve-review-button flat"
          disabled={none || !project.multicam || editBlocked !== null}
          title={
            none
              ? noneTitle
              : editBlocked
                ? editBlocked
                : project.multicam
                  ? 'この範囲を、自動編集で作り直さない範囲(ロック)にします'
                  : '同期した収録素材の企画で使えます'
          }
          onClick={onLock}
        >
          <LockIcon width={12} height={12} />
          ロック
        </button>
        {apart && (
          <span className="ve-review-rangebar-warn" role="note">
            {APART_REASON}
          </span>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 右: プログラム

/** プログラムを重ねる枠。枠の位置をプログラムへ伝え、外れたら戻す(lib/programDock) */
function ProgramSlot({ label }: { label: string | null }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const rect = useProgramDock((s) => s.rect)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const scroller = el.closest('.ve-review-right-body')
    // 右の列を縦に送ったら付いていき、列の外(見出しの帯・下の帯)へはみ出す所は切り取る
    const update = (): void =>
      useProgramDock.getState().setRect(dockRectOf(el, scroller ?? undefined))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    scroller?.addEventListener('scroll', update, { passive: true })
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      scroller?.removeEventListener('scroll', update)
      useProgramDock.getState().setRect(null)
    }
  }, [])
  return (
    <div ref={ref} className="ve-review-program-slot">
      {/* 札はプログラム(画面の一番上に重ねてある)より上に出すので、画面の外(body)に置く */}
      {label &&
        rect &&
        rect.clipTop === 0 &&
        createPortal(
          <span
            className="ve-review-camera-label"
            style={{ left: rect.left + 8, top: rect.top + 8 }}
          >
            {label}
          </span>,
          document.body
        )}
    </div>
  )
}

function PlayControls({
  view,
  fps,
  onPlayRange
}: {
  view: TimelineRange
  fps: number
  onPlayRange: () => void
}): React.JSX.Element {
  const playhead = useProjectStore((s) => s.playheadTime)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  return (
    <div className="ve-review-controls">
      <button
        type="button"
        className="ve-review-play"
        aria-label={isPlaying ? '止める(スペース)' : '再生(スペース)'}
        onClick={() => useProjectStore.getState().setIsPlaying(!isPlaying)}
      >
        {isPlaying ? <PauseIcon width={14} height={14} /> : <PlayIcon width={14} height={14} />}
      </button>
      <span className="mono ve-review-tc">{formatTimecode(playhead, fps)}</span>
      <span className="ve-review-spacer" />
      <button
        type="button"
        className="ve-review-button"
        title={`${formatTimecode(view.start, fps)} から ${formatTimecode(view.end, fps)} までを再生します`}
        onClick={onPlayRange}
      >
        範囲の先頭から再生
      </button>
    </div>
  )
}

/** 範囲の波形と再生位置(押すとその位置へ) */
function RangeWave({
  view,
  project
}: {
  view: TimelineRange
  project: Project
}): React.JSX.Element {
  const playhead = useProjectStore((s) => s.playheadTime)
  const pieces = useMemo(
    () => timelineAudioPieces(project, view.start, view.end),
    [project, view.start, view.end]
  )
  const levels = useWaveLevels(pieces, view.start, view.end, 216)
  const span = Math.max(1e-6, view.end - view.start)
  const inView = playhead >= view.start && playhead <= view.end
  return (
    <div
      className="ve-review-wave"
      role="slider"
      tabIndex={0}
      aria-label="範囲の中の再生位置"
      aria-valuemin={Math.round(view.start * 100) / 100}
      aria-valuemax={Math.round(view.end * 100) / 100}
      aria-valuenow={Math.round(Math.min(view.end, Math.max(view.start, playhead)) * 100) / 100}
      onMouseDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
        useProjectStore.getState().seekTo(view.start + ratio * span)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const step = e.key === 'ArrowLeft' ? -1 : 1
        useProjectStore.getState().seekTo(Math.min(view.end, Math.max(view.start, playhead + step)))
      }}
    >
      {levels ? (
        <WaveBars levels={levels} width={432} height={24} />
      ) : (
        <span className="ve-review-wave-none">音がありません</span>
      )}
      {inView && (
        <span
          className="ve-review-playhead"
          style={{ left: `${((playhead - view.start) / span) * 100}%` }}
        />
      )}
    </div>
  )
}

/** カメラの一覧の1つ(そのカメラの絵と、範囲の音の波形) */
function CameraButton({
  project,
  sourceId,
  name,
  current,
  at,
  view,
  disabled,
  onPick
}: {
  project: Project
  sourceId: string
  name: string
  current: boolean
  /** 絵を出す共通の時刻 */
  at: number | null
  view: TimelineRange
  disabled: boolean
  onPick: () => void
}): React.JSX.Element {
  const info = project.multicam
  const f = info && at !== null ? fileAt(info, sourceId, at) : null
  const asset = f ? project.assets.find((a) => a.id === f.assetId) : undefined
  const pieces = useMemo(
    () => cameraAudioPieces(project, sourceId, view.start, view.end),
    [project, sourceId, view.start, view.end]
  )
  const levels = useWaveLevels(pieces, view.start, view.end, 64)
  return (
    <button
      type="button"
      className={`ve-review-camera ${current ? 'on' : ''}`}
      aria-pressed={current}
      disabled={disabled && !current}
      title={
        current
          ? `${name} を映しています`
          : disabled
            ? '本編は固定されています'
            : `選んだ範囲(無ければ再生位置のクリップ)を ${name} に替えます(取り消しは Ctrl+Z)`
      }
      onClick={onPick}
    >
      <span className="ve-review-camera-media">
        <span className="ve-review-camera-thumb">
          {f && asset && asset.hasVideo !== false ? (
            <FrameImage filePath={asset.filePath} at={toSource(f, at ?? 0)} alt="" />
          ) : (
            <span className="ve-review-camera-none">この時間は録っていません</span>
          )}
        </span>
        {levels && (
          <WaveBars levels={levels} width={128} height={14} className="ve-review-camera-wave" />
        )}
      </span>
      <span className="ve-review-camera-name">{name}</span>
    </button>
  )
}

/** AI の判断(再生位置・範囲の頭のクリップについて、自動編集がなぜそうしたか) */
function DecisionCard({ project, at }: { project: Project; at: number }): React.JSX.Element {
  const scenes = usePipelineStore((s) => s.scenes)
  const judgements = usePipelineStore((s) => s.planJudgements ?? s.judgements)
  const keep = usePipelineStore((s) => s.keep)
  const judgeSource = usePipelineStore((s) => s.judgeSource)
  const tc = findTimedClipAt(buildTimedClips(project), at)
  const d = tc ? decisionForClip(tc.clip, project, { scenes, judgements, keep, judgeSource }) : null
  return (
    <div className="ve-review-ai" aria-label="AI の判断">
      <span className="ve-review-ai-title">
        <SparklesIcon width={12} height={12} />
        AI の判断
        {d?.judgeSource === 'heuristic' && <span className="ve-review-ai-src">簡易の点数</span>}
      </span>
      {d ? (
        <DecisionSummary decision={d} />
      ) : (
        <span className="ve-review-ai-text">
          {project.multicam
            ? scenes.length === 0
              ? '場面の判定がまだありません(自動編集の画面で構成まで進めると出ます)。'
              : 'この所に重なる場面の判定はありません。'
            : 'この企画は素材を手で並べたもので、自動編集の判断はありません。'}
        </span>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ 下: 全体の帯

function OverviewPlayhead({ total }: { total: number }): React.JSX.Element {
  const playhead = useProjectStore((s) => s.playheadTime)
  return (
    <span
      className="ve-review-ov-playhead"
      style={{ left: `${(Math.min(total, Math.max(0, playhead)) / Math.max(1e-6, total)) * 100}%` }}
    />
  )
}

function Overview({
  project,
  range
}: {
  project: Project
  range: LinesRange | null
}): React.JSX.Element {
  const { open } = useReviewItems()
  const total = getTotalDuration(project)
  const timed = useMemo(() => buildTimedClips(project), [project])
  const pieces = useMemo(() => timelineAudioPieces(project, 0, total), [project, total])
  const levels = useWaveLevels(pieces, 0, total, 704)
  const pct = (t: number): string => `${(t / Math.max(1e-6, total)) * 100}%`
  return (
    <section className="ve-review-overview" aria-label="全体">
      <div className="ve-review-ov-head">
        <span>
          全体 <span className="mono">{clock(total)}</span>
        </span>
        <span className="ve-review-legend" aria-hidden="true">
          <span>
            <span className="ve-review-legend-cut" />
            クリップ
          </span>
          <span>
            <span className="ve-review-legend-mark" />
            要確認
          </span>
          <span>
            <span className="ve-review-legend-range" />
            選んだ範囲
          </span>
        </span>
      </div>
      <div
        className="ve-review-ov-strip"
        title="押すとその位置へ移ります"
        onMouseDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
          useProjectStore.getState().seekTo(ratio * total)
        }}
      >
        {levels && (
          <WaveBars levels={levels} width={1408} height={16} className="ve-review-ov-wave" />
        )}
        {timed.map((tc) => (
          <span
            key={tc.clip.id}
            className="ve-review-ov-cut"
            style={{ left: pct(tc.start), width: pct(tc.end - tc.start) }}
          />
        ))}
        {open
          .filter((d) => d.at !== undefined && d.at <= total)
          .map((d) => (
            <span
              key={d.key}
              className="ve-review-ov-mark"
              style={{ left: pct(d.at!) }}
              title={`${d.kind}(${clock(d.at!)})`}
            />
          ))}
        {/* 選んだ範囲の白い枠。本編で離れて並ぶときは、切れごとに枠を出す */}
        {range &&
          (range.contiguous ? [{ start: range.start, end: range.end }] : range.pieces).map((r) => (
            <span
              key={`${r.start}-${r.end}`}
              className={`ve-review-ov-range ${range.contiguous ? '' : 'apart'}`}
              style={{ left: pct(r.start), width: pct(r.end - r.start) }}
            />
          ))}
        <OverviewPlayhead total={total} />
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ 本体

export function ReviewScreen({ onFixTab }: { onFixTab: (tab: FixTab) => void }): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const lines = useMemo(() => reviewTranscriptLines(project), [project])
  // 選んだ行は id で持つ(取り消し・削除で企画が変わると、行の番号がずれる)
  const [pickedIds, setPickedIds] = useState<string[]>([])
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [hideCut, setHideCut] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [playRange, setPlayRange] = useState<TimelineRange | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fps = 1 / frameSeconds(project.clips, project.assets)
  const total = getTotalDuration(project)
  const picked = pickedIds
    .map((id) => lines.findIndex((l) => l.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
  const anchor = anchorId ? lines.findIndex((l) => l.id === anchorId) : -1
  const foreign = useMemo(() => foreignBetweenOf(project), [project])
  const range = rangeOfLines(lines, picked, foreign)
  const apart = range !== null && !range.contiguous
  const speakerOrder = useMemo(() => speakersInOrder(lines), [lines])
  // 再生位置(絵・AI の判断)は 1 秒単位、再生中は 5 秒単位で見る(毎コマ絵を作り直さない)
  const stillAt = useProjectStore((s) =>
    s.isPlaying ? Math.floor(s.playheadTime / 5) * 5 : Math.floor(s.playheadTime)
  )
  // 範囲が無ければ、再生位置を含む 30 秒を見る(波形・カメラの音)
  const page = Math.floor(stillAt / 30) * 30
  const view: TimelineRange = range ?? {
    start: Math.max(0, Math.min(page, Math.max(0, total - 30))),
    end: Math.min(total, Math.max(page, Math.max(0, total - 30)) + 30)
  }
  const info = project.multicam
  const timed = useMemo(() => buildTimedClips(project), [project])
  const lookAt = range ? range.start : stillAt
  const tcAt = findTimedClipAt(timed, lookAt)
  const fileOfAsset = new Map((info?.files ?? []).map((f) => [f.assetId, f]))
  const atFile = tcAt ? fileOfAsset.get(tcAt.clip.assetId) : undefined
  const commonAt =
    tcAt && atFile
      ? toCommon(
          atFile,
          tcAt.clip.inPoint + Math.max(0, lookAt - tcAt.start) * (tcAt.clip.speed || 1)
        )
      : null
  const cameras = (info?.sources ?? []).filter((s) => s.kind === 'camera')
  const currentSource = atFile?.sourceId ?? null
  const currentCamera = cameras.find((c) => c.id === currentSource)
  const programLabel = currentCamera ? cameraLabel(currentCamera.name, currentCamera.subject) : null

  // スペースで再生・停止(タイムラインのキーはこの画面の間は止めてあるので、ここで受ける)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) return
      if (isModalOpen() || isTypingTarget(e.target, e.key)) return
      // 押せる物(ボタン・文の行)の上のスペースは、その物を押す
      const el = e.target as HTMLElement | null
      if (el && el !== document.body && el.closest('button, [role="button"], [role="switch"]'))
        return
      e.preventDefault()
      const st = useProjectStore.getState()
      st.setIsPlaying(!st.isPlaying)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 範囲の先頭から再生したら、範囲の終わりで止める
  useEffect(() => {
    if (!playRange) return
    return useProjectStore.subscribe((s) => {
      if (!s.isPlaying) {
        setPlayRange(null)
        return
      }
      if (s.playheadTime >= playRange.end - 1e-3) {
        s.setIsPlaying(false)
        setPlayRange(null)
      }
    })
  }, [playRange])

  /** 選んだ行を、本編のイン点・アウト点(範囲の選択)にする */
  function applySelection(next: number[]): void {
    setPickedIds(next.map((i) => lines[i]?.id).filter((x): x is string => Boolean(x)))
    setNote(null)
    const r = rangeOfLines(lines, next, foreign)
    const st = useProjectStore.getState()
    if (!r) return
    st.setTimelineIn(null)
    st.setTimelineOut(r.end)
    st.setTimelineIn(r.start)
    st.seekTo(r.start)
  }

  function pick(index: number, extend: boolean): void {
    if (extend && anchor >= 0) {
      const lo = Math.min(anchor, index)
      const hi = Math.max(anchor, index)
      applySelection(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k))
      return
    }
    setAnchorId(lines[index]?.id ?? null)
    applySelection([index])
  }

  /** 時刻の行を選んで見せる(要確認のカード・全体の帯から) */
  function seekAndShow(t: number): void {
    const i = lineAtTime(lines, t)
    useProjectStore.getState().seekTo(t)
    if (i < 0) return
    setAnchorId(lines[i].id)
    setPickedIds([lines[i].id])
    listRef.current
      ?.querySelector(`[data-line="${i}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function fix(item: ReviewItem): void {
    if (item.overlayId) {
      // テロップは編集の画面で直す(その今の位置へ移って選ぶ)
      const store = useProjectStore.getState()
      const overlay = store.project.textOverlays.find((o) => o.id === item.overlayId)
      usePipelineStore.getState().setScreenOpen(false)
      if (overlay) {
        store.seekTo(overlay.startTime)
        store.selectOverlay(overlay.id)
      } else if (item.at !== undefined) store.seekTo(item.at)
      return
    }
    if (item.tab) {
      onFixTab(item.tab)
      return
    }
    if (item.at !== undefined) seekAndShow(item.at)
  }

  function afterEdit(changed: boolean, failure: string): void {
    if (changed) {
      setPickedIds([])
      setAnchorId(null)
      setNote(null)
    } else setNote(failure)
  }

  const lastPicked = picked.length > 0 ? Math.max(...picked) : -1

  return (
    // data-blocks-shortcuts: 隠れたタイムラインへのキー(Delete・分割など)を通さない(useKeyboardShortcuts)
    <div className="ve-review" role="region" aria-label="確認" data-blocks-shortcuts="">
      <ReviewCards onSeek={seekAndShow} onFix={fix} />

      <section className="ve-review-center" aria-label="文字起こし">
        <div className="ve-review-head">
          <span className="ve-review-title">文字起こし</span>
          <span className="ve-review-hint">文を選ぶと、その範囲を直せます</span>
          <span className="ve-review-spacer" />
          <span id="ve-review-hide-label" className="ve-review-switch-label">
            削除した部分を隠す
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={hideCut}
            aria-labelledby="ve-review-hide-label"
            className="ve-switch"
            onClick={() => setHideCut((v) => !v)}
          >
            <span className="ve-switch-knob" />
          </button>
        </div>
        <div className="ve-review-lines" ref={listRef}>
          {lines.length === 0 ? (
            <p className="ve-review-empty">
              {project.multicam
                ? '文字起こしがまだありません。自動編集の文字起こしが終わると、話者と発言がここに並びます。'
                : '文字起こしはありません。同期した収録素材から自動編集した企画で出ます(「新しい回を作る」)。'}
            </p>
          ) : (
            lines.map((l, i) => {
              if (hideCut && l.allCut && !picked.includes(i)) return null
              const on = picked.includes(i)
              return (
                <div key={l.id} className="ve-review-line-group">
                  <TranscriptRow
                    line={l}
                    index={i}
                    colorIndex={speakerOrderIndex(speakerOrder, l.speaker)}
                    picked={on}
                    apart={apart}
                    continues={on && picked.includes(i + 1)}
                    hideCut={hideCut}
                    onPick={pick}
                  />
                  {i === lastPicked && (
                    <>
                      <RangeBar
                        range={range}
                        fps={fps}
                        apart={apart}
                        onReEdit={() => range && requestRangeAutoEdit(range, { origin: 'marks' })}
                        onKeep={() =>
                          range && requestRangeAutoEdit(range, { origin: 'marks', prefer: 'C' })
                        }
                        onDelete={() => {
                          if (!range || apart) return
                          afterEdit(
                            rippleDeleteRange(range.start, range.end),
                            // 試している間は試しの関所が断る(その理由を出す)
                            useProjectStore.getState().trial
                              ? TRIAL_REASON
                              : '削除できませんでした(本編が固定されているか、範囲に本編がありません)'
                          )
                        }}
                        onLock={() => {
                          if (!range || apart) return
                          if (useProjectStore.getState().trial) return setNote(TRIAL_REASON)
                          const reason = lockTimelineRange(range, true)
                          setNote(
                            reason
                              ? `ロックできません: ${reason}`
                              : 'ロックしました(全体の作り直しでも今のまま残ります)'
                          )
                        }}
                      />
                      {note && (
                        <div className="ve-review-line ve-review-barrow">
                          <span />
                          <p className="ve-review-note" role="status">
                            {note}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })
          )}
        </div>
      </section>

      <aside className="ve-review-right" aria-label="映像">
        <div className="ve-review-head">
          <span className="ve-review-title">プログラム</span>
        </div>
        <div className="ve-review-right-body">
          <ProgramSlot label={programLabel} />
          <RangeWave view={view} project={project} />
          <PlayControls
            view={view}
            fps={fps}
            onPlayRange={() => {
              const st = useProjectStore.getState()
              st.seekTo(view.start)
              st.setIsPlaying(true)
              setPlayRange(view)
            }}
          />
          {cameras.length > 0 && (
            <div className="ve-review-cameras">
              <span className="ve-review-section">カメラ</span>
              <div className="ve-review-camera-grid" role="group" aria-label="カメラ">
                {cameras.map((c) => (
                  <CameraButton
                    key={c.id}
                    project={project}
                    sourceId={c.id}
                    name={cameraLabel(c.name, c.subject)}
                    current={c.id === currentSource}
                    at={commonAt}
                    view={view}
                    disabled={project.mainTrackLocked === true}
                    onPick={() => {
                      if (c.id === currentSource) return
                      // 本編で離れて並ぶ範囲は、切れごとに替える(間に挟まる別の中身は替えない)
                      const targets = range
                        ? range.contiguous
                          ? [{ start: range.start, end: range.end }]
                          : range.pieces
                        : tcAt
                          ? [{ start: tcAt.start, end: tcAt.end }]
                          : []
                      if (targets.length === 0) return
                      if (useProjectStore.getState().trial) return setNote(TRIAL_REASON)
                      const ok = switchRangesAngle(targets, c.id)
                      setNote(
                        ok
                          ? null
                          : project.mainTrackLocked
                            ? '本編は固定されています'
                            : `${cameraLabel(c.name, c.subject)} はこの時間を録っていないため、替えられませんでした`
                      )
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          <DecisionCard project={project} at={lookAt} />
          {note && picked.length === 0 && (
            <p className="ve-review-note" role="status">
              {note}
            </p>
          )}
        </div>
      </aside>

      <Overview project={project} range={range} />
    </div>
  )
}
