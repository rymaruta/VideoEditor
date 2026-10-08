import { useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { onProjectSwitch, useProjectStore } from '../store/projectStore'
import { usePresetStore } from '../store/presetStore'
import { useSettingsStore, type ExportLoudness } from '../store/settingsStore'
import { useMenuCommand } from '../lib/menuCommands'
import { formatIpcError } from '../lib/ipcError'
import { formatTimecode } from '../lib/timelineRuler'
import { buildTimedClips, totalExportDuration } from '../lib/timelineMath'
import { prepareTelopLayerForExport } from '../lib/telopRaster'
import { safeFileBaseName } from '@shared/fileName'
import { frameSeconds } from '@shared/frameRate'
import { targetResolution } from '@shared/resolution'
import { LOUDNESS_TARGETS } from '@shared/loudness'
import type { TelopLayerPayload } from '@shared/telop/layer'
import type { AspectRatio, ExportEngine, QualityPreset, ResolutionHeight } from '@shared/types'
import { FolderIcon, PlayCircleIcon, TrashIcon } from './icons'
import { ExportQcPanel } from './ExportQcPanel'
import { reportBusy } from '../lib/busyReporter'
import { useQcStore } from '../store/qcStore'

/**
 * 書き出し設定(ファイル > 書き出し… / Ctrl+M)。デザイン案の「書き出し設定」ダイアログ。
 *
 * 左に「何が書き出されるか」の概要、右に 映像 / 音声 / テロップ / 出力先 の設定、
 * 下にプリセットと実行ボタン。設定は次回も覚えておく(毎回選び直さなくて済むように)。
 *
 * 閉じても書き出しは止まらない(このコンポーネントは常に置いておき、見せ方だけを切り替える)。
 * 書き出し中に開き直せば、進み具合がそのまま見える。
 */

interface QueueJob {
  id: string
  aspectRatio: AspectRatio
  resolutionHeight: ResolutionHeight
  quality: QualityPreset
}

type JobStatus = 'pending' | 'running' | 'done' | 'error'
type SettingsTab = 'video' | 'audio' | 'telop' | 'output'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'video', label: '映像' },
  { id: 'audio', label: '音声' },
  { id: 'telop', label: 'テロップ' },
  { id: 'output', label: '出力先' }
]

const QUALITY_LABEL: Record<QualityPreset, string> = {
  high: '高画質',
  standard: '標準',
  small: '軽量'
}

const RESOLUTION_LABEL: Record<ResolutionHeight, string> = {
  2160: '4K(2160)',
  1440: '2K(1440)',
  1080: 'フルHD(1080)',
  720: 'HD(720)',
  480: 'SD(480)'
}

const MISSING_ASSET_MESSAGE =
  '見つからない素材ファイルがタイムラインで使われています。プロジェクトの素材一覧で再リンクしてから書き出してください。'

/**
 * キューの書き出し先のファイル名。一覧に見えている違い(縦横比・解像度・画質)をすべて名前に入れる。
 * どれかが欠けると、2つのジョブが同じ名前になり、後のジョブが先のファイルを黙って上書きする。
 */
function jobFileName(projectName: string, job: QueueJob): string {
  const aspect = job.aspectRatio === '9:16' ? '9x16' : '16x9'
  return `${safeFileBaseName(projectName)}_${aspect}_${job.resolutionHeight}p_${QUALITY_LABEL[job.quality]}.mp4`
}

function displayFps(fps: number): string {
  // 29.97 / 59.94 などは小数2桁、整数のレートはそのまま
  return Math.abs(fps - Math.round(fps)) < 0.005 ? String(Math.round(fps)) : fps.toFixed(2)
}

export function ExportDialog(): React.JSX.Element | null {
  const project = useProjectStore((s) => s.project)
  const missingAssetIds = useProjectStore((s) => s.missingAssetIds)
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio)

  const resolutionHeight = useSettingsStore((s) => s.exportResolutionHeight)
  const setResolutionHeight = useSettingsStore((s) => s.setExportResolutionHeight)
  const quality = useSettingsStore((s) => s.exportQuality)
  const setQuality = useSettingsStore((s) => s.setExportQuality)
  const loudness = useSettingsStore((s) => s.exportLoudness)
  const setLoudness = useSettingsStore((s) => s.setExportLoudness)
  const engine = useSettingsStore((s) => s.exportEngine)
  const setEngine = useSettingsStore((s) => s.setExportEngine)
  const openFolderAfter = useSettingsStore((s) => s.exportOpenFolderAfter)
  const setOpenFolderAfter = useSettingsStore((s) => s.setExportOpenFolderAfter)

  const exportPresets = usePresetStore((s) => s.exportPresets)
  const addExportPreset = usePresetStore((s) => s.addExportPreset)
  const removeExportPreset = usePresetStore((s) => s.removeExportPreset)

  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('video')
  const [encoder, setEncoder] = useState<'libx264' | 'h264_nvenc' | null>(null)
  const [running, setRunning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const [progress, setProgress] = useState<{ percent: number; stage: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [donePath, setDonePath] = useState<string | null>(null)
  const [presetName, setPresetName] = useState<string | null>(null)
  const [presetError, setPresetError] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueJob[]>([])
  const [queueStatus, setQueueStatus] = useState<Record<string, JobStatus>>({})

  useMenuCommand((id) => {
    if (id === 'file.export') setOpen(true)
  })

  // 前のプロジェクトの「書き出しが完了しました」・失敗・待ち行列を、別のプロジェクトに出さない
  // (完了の再生・フォルダを表示が、前のプロジェクトのファイルを開いていた)。書き出し中は残す
  useEffect(() => {
    if (running) return
    return onProjectSwitch(() => {
      setError(null)
      setDonePath(null)
      setProgress(null)
      setQueue([])
      setQueueStatus({})
    })
  }, [running])

  useEffect(() => window.api.onExportProgress((p) => setProgress(p)), [])
  // 書き出しの最中は、PC をスリープさせず、タスクバーに進み具合を出す
  useEffect(() => {
    reportBusy('export', running ? { label: '書き出し', percent: progress?.percent } : null)
  }, [running, progress?.percent])
  useEffect(() => () => reportBusy('export', null), [])

  // GPU が使えるかは開いたときに1回だけ調べる(main 側も結果を覚えている)
  useEffect(() => {
    if (!open || encoder) return
    let alive = true
    window.api.detectExportEncoder().then(
      (e) => alive && setEncoder(e),
      () => alive && setEncoder('libx264')
    )
    return () => {
      alive = false
    }
  }, [open, encoder])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const timedClips = useMemo(() => buildTimedClips(project), [project])
  const duration = totalExportDuration(timedClips)
  const fps = 1 / frameSeconds(project.clips, project.assets)
  const { w, h } = targetResolution(project.aspectRatio, resolutionHeight)
  const usesMissingAsset = useMemo(() => {
    if (missingAssetIds.length === 0) return false
    const missing = new Set(missingAssetIds)
    return (
      project.clips.some((c) => missing.has(c.assetId)) ||
      project.audioTracks.some((t) => t.clips.some((c) => missing.has(c.assetId))) ||
      project.videoOverlayTracks.some((t) => t.clips.some((c) => missing.has(c.assetId)))
    )
  }, [project, missingAssetIds])

  if (!open) return null

  const loudnessText = loudness === 'off' ? '音量の調整なし' : LOUDNESS_TARGETS[loudness].label
  const encoderText =
    engine === 'standard'
      ? 'CPU(x264)'
      : encoder === null
        ? '確認中…'
        : encoder === 'h264_nvenc'
          ? 'GPU(NVENC)'
          : 'CPU(x264)'

  /** 書き出し前の確認。問題があれば理由を返す */
  function blocker(): string | null {
    if (project.clips.length === 0) return 'タイムラインにクリップがありません'
    if (usesMissingAsset) return MISSING_ASSET_MESSAGE
    return null
  }

  async function telopLayerFor(
    aspect: AspectRatio,
    height: ResolutionHeight
  ): Promise<TelopLayerPayload | null> {
    // テロップは書き出し方式によらず、画面と同じ描画関数で先に画像にしておく
    // (見えているとおりに書き出すため。main は画像を時刻どおりに重ねるだけ)
    return prepareTelopLayerForExport(
      project,
      aspect,
      height,
      (done, total) => setProgress({ percent: 0, stage: `テロップを描画中(${done}/${total})` }),
      abortRef.current?.signal
    )
  }

  /** 書き出しの中止。テロップの描画中(main の書き出しが始まる前)にも効くよう、こちらでも覚える */
  function cancelExport(): void {
    abortRef.current?.abort()
    void window.api.cancelExport()
  }

  async function runOne(
    aspect: AspectRatio,
    height: ResolutionHeight,
    q: QualityPreset,
    outputPath: string
  ): Promise<void> {
    setProgress({ percent: 0, stage: '準備中' })
    const telopLayer = await telopLayerFor(aspect, height)
    try {
      // 描画のあいだに中止を押されていたら、書き出しを始めない(main 側の中止は、始まる前だと効かない)
      if (abortRef.current?.signal.aborted) throw new Error('EXPORT_CANCELED')
      await window.api.exportProject({
        project,
        aspectRatio: aspect,
        resolutionHeight: height,
        quality: q,
        outputPath,
        loudnessNormalization: loudness !== 'off',
        loudnessTarget: loudness === 'off' ? undefined : loudness,
        engine,
        telopLayer
      })
    } finally {
      // 層の画像(main の一時フォルダ。長尺の 4K で数 GB)は、書き出しに渡らなかったときもここで片付ける
      // (書き出しに渡ったぶんは main が終わりに片付けている。2回目は何もしない)
      if (telopLayer?.stagedId)
        void window.api.telopLayer.release(telopLayer.stagedId).catch(() => {})
    }
  }

  async function handleExport(): Promise<void> {
    abortRef.current = new AbortController()
    setError(null)
    setDonePath(null)
    const reason = blocker()
    if (reason) {
      setError(reason)
      return
    }
    const outputPath = await window.api.selectExportPath(`${safeFileBaseName(project.name)}.mp4`)
    if (!outputPath) return
    setRunning(true)
    try {
      await runOne(project.aspectRatio, resolutionHeight, quality, outputPath)
      setDonePath(outputPath)
      window.api.notifyDone('書き出しが終わりました', outputPath)
      // 書き出した動画をそのまま確認する(黒味・フリーズ・無音・ラウドネス・テロップ)
      void useQcStore.getState().run(outputPath, loudness)
      if (openFolderAfter) await window.api.showItemInFolder(outputPath).catch(() => {})
    } catch (e) {
      const message = formatIpcError(e)
      if (message !== 'EXPORT_CANCELED') {
        setError(message)
        window.api.notifyDone('書き出しに失敗しました', message)
      }
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  async function handleRunQueue(): Promise<void> {
    abortRef.current = new AbortController()
    setError(null)
    setDonePath(null)
    const reason = blocker()
    if (reason) {
      setError(reason)
      return
    }
    const folder = await window.api.selectExportFolder()
    if (!folder) return
    setRunning(true)
    setQueueStatus(Object.fromEntries(queue.map((j) => [j.id, 'pending' as JobStatus])))
    let lastPath: string | null = null
    let doneCount = 0
    let failedCount = 0
    let canceledCount = 0
    for (const [index, job] of queue.entries()) {
      setQueueStatus((prev) => ({ ...prev, [job.id]: 'running' }))
      try {
        lastPath = `${folder}/${jobFileName(project.name, job)}`
        await runOne(job.aspectRatio, job.resolutionHeight, job.quality, lastPath)
        setQueueStatus((prev) => ({ ...prev, [job.id]: 'done' }))
        doneCount++
      } catch (e) {
        const message = formatIpcError(e)
        if (message === 'EXPORT_CANCELED') {
          setQueueStatus((prev) => ({ ...prev, [job.id]: 'pending' }))
          // 中止したぶんと、まだ始めていないぶん
          canceledCount = queue.length - index
          break
        }
        setQueueStatus((prev) => ({ ...prev, [job.id]: 'error' }))
        setError(message)
        failedCount++
      }
    }
    setRunning(false)
    setProgress(null)
    // 失敗・中止があっても「終わりました」だけだと、離れていた人は全部できたと思い込む
    const summary =
      failedCount === 0 && canceledCount === 0
        ? 'まとめての書き出しが終わりました'
        : [
            `まとめての書き出し: ${doneCount}件完了`,
            failedCount > 0 ? `${failedCount}件失敗` : '',
            canceledCount > 0 ? `${canceledCount}件中止` : ''
          ]
            .filter(Boolean)
            .join('・')
    window.api.notifyDone(summary, folder)
    if (lastPath && openFolderAfter) await window.api.showItemInFolder(lastPath).catch(() => {})
  }

  function addToQueue(): void {
    const dup = queue.some(
      (j) =>
        j.aspectRatio === project.aspectRatio &&
        j.resolutionHeight === resolutionHeight &&
        j.quality === quality
    )
    if (dup) {
      setError('同じ組み合わせがすでにキューにあります(同じファイル名になり上書きされるため)')
      return
    }
    setError(null)
    setQueue((prev) => [
      ...prev,
      { id: uuid(), aspectRatio: project.aspectRatio, resolutionHeight, quality }
    ])
    setTab('output')
  }

  function applyPreset(id: string): void {
    const preset = exportPresets.find((p) => p.id === id)
    if (!preset) return
    setResolutionHeight(preset.resolutionHeight)
    setQuality(preset.quality)
    // 古いプリセットは「正規化する/しない」しか持たないので、するなら今の基準を保つ
    setLoudness(preset.loudnessNormalization ? (loudness === 'off' ? 'web' : loudness) : 'off')
  }

  function savePreset(): void {
    const ok = addExportPreset(presetName ?? '', {
      resolutionHeight,
      quality,
      loudnessNormalization: loudness !== 'off'
    })
    if (!ok) {
      setPresetError(
        (presetName ?? '').trim()
          ? 'その名前のプリセットはすでにあります'
          : '名前を入力してください'
      )
      return
    }
    setPresetError(null)
    setPresetName(null)
  }

  const matchingPreset = exportPresets.find(
    (p) =>
      p.resolutionHeight === resolutionHeight &&
      p.quality === quality &&
      p.loudnessNormalization === (loudness !== 'off')
  )

  const summary: [string, string][] = [
    ['長さ', formatTimecode(duration, fps)],
    ['映像', `${w}×${h} · ${displayFps(fps)}p · H.264 · ${QUALITY_LABEL[quality]}`],
    ['音声', `AAC 48kHz ステレオ · ${loudnessText}`],
    ['テロップ', `${project.textOverlays.length.toLocaleString()} 本(画面と同じ描画)`],
    ['エンコーダ', encoderText]
  ]

  return (
    <div className="modal-backdrop" onMouseDown={() => !running && setOpen(false)}>
      <div
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="書き出し設定"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-titlebar">
          <span>書き出し設定</span>
          <button
            className="dialog-close"
            aria-label="閉じる"
            title={running ? '閉じても書き出しは続きます' : '閉じる'}
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="export-dialog-body">
          <div className="export-dialog-summary">
            <span className="export-dialog-section">概要</span>
            <dl>
              {summary.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {usesMissingAsset && <p className="error-text">{MISSING_ASSET_MESSAGE}</p>}
            {(running || progress) && (
              <div className="export-dialog-progress">
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${progress?.percent ?? 0}%` }}
                  />
                  <span>
                    {progress?.stage ?? '準備中'} {Math.round(progress?.percent ?? 0)}%
                  </span>
                </div>
              </div>
            )}
            {donePath && (
              <div className="export-done">
                <p className="success-text" title={donePath}>
                  書き出しが完了しました
                </p>
                <div className="export-done-actions">
                  <button
                    className="small-button"
                    onClick={() =>
                      window.api.openPath(donePath).catch((e) => setError(formatIpcError(e)))
                    }
                  >
                    <PlayCircleIcon width={13} height={13} />
                    再生
                  </button>
                  <button
                    className="small-button"
                    onClick={() =>
                      window.api
                        .showItemInFolder(donePath)
                        .catch((e) => setError(formatIpcError(e)))
                    }
                  >
                    <FolderIcon width={13} height={13} />
                    フォルダを表示
                  </button>
                </div>
              </div>
            )}
            {error && <p className="error-text">{error}</p>}
          </div>

          <div className="export-dialog-settings">
            <div className="panel-tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`panel-tab ${tab === t.id ? 'active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="export-dialog-fields">
              {tab === 'video' && (
                <>
                  <div className="form-row">
                    <label>縦横比</label>
                    <select
                      value={project.aspectRatio}
                      disabled={running}
                      onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
                    >
                      <option value="16:9">16:9(横型)</option>
                      <option value="9:16">9:16(縦型・ショート)</option>
                    </select>
                    <span className="form-note">プロジェクトの設定</span>
                  </div>
                  <div className="form-row">
                    <label>解像度</label>
                    <select
                      value={resolutionHeight}
                      disabled={running}
                      onChange={(e) =>
                        setResolutionHeight(Number(e.target.value) as ResolutionHeight)
                      }
                    >
                      {([2160, 1440, 1080, 720, 480] as ResolutionHeight[]).map((r) => (
                        <option key={r} value={r}>
                          {RESOLUTION_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    <span className="form-note">
                      {w} × {h}
                    </span>
                  </div>
                  <div className="form-row">
                    <label>フレームレート</label>
                    <span className="form-value">{displayFps(fps)} fps</span>
                    <span className="form-note">シーケンスと同じ</span>
                  </div>
                  <div className="form-row">
                    <label>形式</label>
                    <span className="form-value">H.264 / MP4</span>
                  </div>
                  <div className="form-row">
                    <label>画質</label>
                    <select
                      value={quality}
                      disabled={running}
                      onChange={(e) => setQuality(e.target.value as QualityPreset)}
                    >
                      <option value="high">高画質</option>
                      <option value="standard">標準</option>
                      <option value="small">軽量(ファイルが小さい)</option>
                    </select>
                  </div>
                  <div className="form-row">
                    <label>エンコーダ</label>
                    <span className="form-value">{encoderText}</span>
                    <span className="form-note">
                      {engine === 'standard'
                        ? 'GPU は長尺向けの方式で使います'
                        : encoder === 'h264_nvenc'
                          ? 'NVIDIA の GPU を検出しました'
                          : encoder
                            ? 'GPU が使えないため CPU で書き出します'
                            : ''}
                    </span>
                  </div>
                  <div className="form-row form-row-top">
                    <label>書き出し方式</label>
                    <div className="choice-list">
                      {(
                        [
                          ['standard', '標準', '短い動画向け。全体を1回で書き出します'],
                          [
                            'segmented',
                            '長尺向け(区間に分けて並列)',
                            '長い番組向け。数十秒ずつ同時に書き出してつなぎます'
                          ]
                        ] as [ExportEngine, string, string][]
                      ).map(([value, label, note]) => (
                        <label key={value} className="choice">
                          <input
                            type="radio"
                            name="export-engine"
                            checked={engine === value}
                            disabled={running}
                            onChange={() => setEngine(value)}
                          />
                          <span>
                            <span className="choice-label">{label}</span>
                            <span className="choice-note">{note}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {tab === 'audio' && (
                <>
                  <div className="form-row">
                    <label>形式</label>
                    <span className="form-value">AAC 48kHz ステレオ</span>
                  </div>
                  <div className="form-row form-row-top">
                    <label>ラウドネス</label>
                    <div className="choice-list">
                      {(
                        [
                          ['web', '配信 −14 LUFS', 'YouTube などの配信向け(既定)'],
                          ['broadcast', '放送 −24 LKFS', 'テレビ放送の基準(ARIB TR-B32)'],
                          ['off', '調整しない', '素材・BGM・効果音の音量のまま書き出します']
                        ] as [ExportLoudness, string, string][]
                      ).map(([value, label, note]) => (
                        <label key={value} className="choice">
                          <input
                            type="radio"
                            name="export-loudness"
                            checked={loudness === value}
                            disabled={running}
                            onChange={() => setLoudness(value)}
                          />
                          <span>
                            <span className="choice-label">{label}</span>
                            <span className="choice-note">{note}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <p className="hint-text form-hint">
                    全体を一度測ってから、狙いの音量へ一定の量で上げ下げします(2パス)。
                    音の強弱の幅はそのまま残ります。
                  </p>
                </>
              )}

              {tab === 'telop' && (
                <>
                  <div className="form-row">
                    <label>本数</label>
                    <span className="form-value">
                      {project.textOverlays.length.toLocaleString()} 本
                    </span>
                  </div>
                  <div className="form-row form-row-top">
                    <label>描き方</label>
                    <span className="form-value">
                      画面と同じ描画(縁・グラデーション・背景の飾りもそのまま書き出せます)
                    </span>
                  </div>
                  <p className="hint-text form-hint">
                    どちらの書き出し方式でも、プレビューで見えているとおりに書き出します。
                  </p>
                </>
              )}

              {tab === 'output' && (
                <>
                  <div className="form-row">
                    <label>ファイル名</label>
                    <span className="form-value">{safeFileBaseName(project.name)}.mp4</span>
                    <span className="form-note">書き出し時に保存先を選びます</span>
                  </div>
                  <label className="checkbox-label form-check">
                    <input
                      type="checkbox"
                      checked={openFolderAfter}
                      onChange={(e) => setOpenFolderAfter(e.target.checked)}
                    />
                    書き出しが終わったらフォルダを開く
                  </label>
                  <div className="export-queue">
                    <div className="export-queue-head">
                      <span>キュー({queue.length})</span>
                      <button
                        className="small-button"
                        disabled={running || queue.length === 0}
                        onClick={handleRunQueue}
                        title="キューの組み合わせを、選んだフォルダへ順に書き出します"
                      >
                        キューを書き出す…
                      </button>
                    </div>
                    {queue.length === 0 ? (
                      <p className="hint-text">
                        縦横比・解像度・画質の組み合わせを「キューに追加」で並べると、まとめて書き出せます。
                      </p>
                    ) : (
                      <ul>
                        {queue.map((job) => (
                          <li
                            key={job.id}
                            className={`export-queue-item ${queueStatus[job.id] ?? ''}`}
                          >
                            <span>
                              {job.aspectRatio} · {job.resolutionHeight}p ·{' '}
                              {QUALITY_LABEL[job.quality]}
                            </span>
                            <span className="export-queue-status">
                              {
                                {
                                  pending: '待機',
                                  running: '書き出し中',
                                  done: '完了',
                                  error: '失敗'
                                }[queueStatus[job.id] ?? 'pending']
                              }
                            </span>
                            <button
                              className="icon-button danger"
                              title="キューから外す"
                              disabled={running}
                              onClick={() =>
                                setQueue((prev) => prev.filter((j) => j.id !== job.id))
                              }
                            >
                              <TrashIcon width={12} height={12} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <ExportQcPanel onJump={() => setOpen(false)} />
        <div className="dialog-footer">
          <span className="dialog-footer-label">プリセット:</span>
          {presetName === null ? (
            <>
              <select
                aria-label="プリセット"
                value={matchingPreset?.id ?? ''}
                disabled={running}
                onChange={(e) => applyPreset(e.target.value)}
              >
                <option value="" disabled>
                  {exportPresets.length === 0 ? '(なし)' : '(カスタム)'}
                </option>
                {exportPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="small-button" onClick={() => setPresetName('')}>
                保存…
              </button>
              {matchingPreset && (
                <button
                  className="icon-button danger"
                  title="このプリセットを削除"
                  onClick={() => removeExportPreset(matchingPreset.id)}
                >
                  <TrashIcon width={12} height={12} />
                </button>
              )}
            </>
          ) : (
            <>
              <input
                type="text"
                autoFocus
                placeholder="プリセット名(例: YouTube 1080p)"
                value={presetName}
                onChange={(e) => {
                  setPresetName(e.target.value)
                  setPresetError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') savePreset()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setPresetName(null)
                  }
                }}
              />
              <button className="small-button" onClick={savePreset}>
                保存
              </button>
              <button className="small-button" onClick={() => setPresetName(null)}>
                やめる
              </button>
              {presetError && <span className="error-text">{presetError}</span>}
            </>
          )}
          <div className="dialog-footer-spacer" />
          <button className="small-button" disabled={running} onClick={addToQueue}>
            キューに追加
          </button>
          {running ? (
            <button className="small-button danger" onClick={cancelExport}>
              書き出しを中止
            </button>
          ) : (
            <button className="small-button" onClick={() => setOpen(false)}>
              キャンセル
            </button>
          )}
          <button className="primary-button" disabled={running} onClick={handleExport}>
            {running ? '書き出し中…' : '書き出し…'}
          </button>
        </div>
      </div>
    </div>
  )
}
