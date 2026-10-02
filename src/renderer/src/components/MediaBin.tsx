import { useEffect, useRef, useState } from 'react'
import { LibraryPanel } from './LibraryPanel'
import { useMenuCommand } from '../lib/menuCommands'
import { createPortal } from 'react-dom'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import { useAutoEditRunStore } from '../store/autoEditRunStore'
import { formatIpcError } from '../lib/ipcError'
import { assetsNeedingPreviewProxy, canPreviewFile } from '../lib/canPreview'
import { isAspectMismatch } from '../lib/aspect'
import { isSupportedMediaPath, MEDIA_EXTENSIONS } from '@shared/mediaExtensions'
import { ASSET_DRAG_TYPE } from '../lib/assetDrag'
import type { MediaAsset } from '@shared/types'
import { HighlightModal } from './HighlightModal'
import { RoughCutModal } from './RoughCutModal'
import { AutoEditModal } from './AutoEditModal'
import { LongFormShortModal } from './LongFormShortModal'
import {
  UploadIcon,
  PlusIcon,
  ClapperboardIcon,
  MusicIcon,
  AlertTriangleIcon,
  TargetIcon,
  WandIcon,
  RefreshIcon,
  TrashIcon
} from './icons'

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

function unsupportedMessage(names: string[]): string {
  return `対応していない形式のため${names.length}件を取り込みませんでした(${MEDIA_EXTENSIONS.join(' / ')}) — ${names.join(' / ')}`
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function MediaBin(): React.JSX.Element {
  const assets = useProjectStore((s) => s.project.assets)
  const projectId = useProjectStore((s) => s.project.id)
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio)
  const audioTracks = useProjectStore((s) => s.project.audioTracks)
  const videoOverlayTracks = useProjectStore((s) => s.project.videoOverlayTracks)
  const addAssets = useProjectStore((s) => s.addAssets)
  const addClipToTimeline = useProjectStore((s) => s.addClipToTimeline)
  const addClipToAudioTrack = useProjectStore((s) => s.addClipToAudioTrack)
  const addClipToVideoOverlayTrack = useProjectStore((s) => s.addClipToVideoOverlayTrack)
  const missingAssetIds = useProjectStore((s) => s.missingAssetIds)
  const relinkAsset = useProjectStore((s) => s.relinkAsset)
  const setAssetProxyPath = useProjectStore((s) => s.setAssetProxyPath)
  const openInSourceViewer = useProjectStore((s) => s.openInSourceViewer)
  const removeAsset = useProjectStore((s) => s.removeAsset)
  const textOverlays = useProjectStore((s) => s.project.textOverlays)
  const sourceAssetId = useProjectStore((s) => s.sourceAssetId)
  const setDraggingAssetId = useProjectStore((s) => s.setDraggingAssetId)
  const [importing, setImporting] = useState(false)
  // 「プロジェクト」(この企画の素材)と「ライブラリ」(全プロジェクト共通)の切り替え
  const [view, setView] = useState<'project' | 'library'>('project')
  const [error, setError] = useState<string | null>(null)
  const [trackChoice, setTrackChoice] = useState<Record<string, string>>({})
  const [videoTrackChoice, setVideoTrackChoice] = useState<Record<string, string>>({})
  const [highlightAssetId, setHighlightAssetId] = useState<string | null>(null)
  const [showRoughCut, setShowRoughCut] = useState(false)
  const [showAutoEdit, setShowAutoEdit] = useState(false)
  const [showLongForm, setShowLongForm] = useState(false)
  const [relinkingId, setRelinkingId] = useState<string | null>(null)
  const [proxyProgress, setProxyProgress] = useState<Record<string, number>>({})
  const [fileDragActive, setFileDragActive] = useState(false)
  const hasVideoAssets = assets.some((a) => a.hasVideo)
  // 全自動編集はモーダルを閉じても走り続けるので、走っていることがここから分かるようにする
  const autoEditRunning = useAutoEditRunStore(
    (s) => s.status === 'running' || s.finishingId !== null
  )

  // Progress arrives on a main-process channel keyed by asset id, so several files
  // being transcoded at once each drive their own row.
  useEffect(() => {
    return window.api.onPreviewProxyProgress(({ assetId, percent }) => {
      setProxyProgress((prev) => ({ ...prev, [assetId]: percent }))
    })
  }, [])

  // Transcoding is the expensive fallback, so it only runs once the preview element
  // itself has said it cannot play the file. Chromium can decode HEVC on machines with
  // OS support, where transcoding would be pure waste.
  async function ensurePreviewable(
    assetId: string,
    filePath: string,
    codecSaysUnplayable: boolean,
    hasVideo: boolean
  ): Promise<void> {
    if (await canPreviewFile(filePath, hasVideo)) return
    if (!codecSaysUnplayable) {
      // The file failed to load for a reason a transcode won't fix (corrupt, or a
      // container the demuxer rejects). Say so rather than burning minutes on ffmpeg.
      setError(
        `${fileNameFromPath(filePath)}: プレビューで読み込めませんでした。ファイルが壊れている可能性があります。`
      )
      return
    }
    await buildPreviewProxy(assetId, filePath)
  }

  async function buildPreviewProxy(assetId: string, filePath: string): Promise<void> {
    setProxyProgress((prev) => ({ ...prev, [assetId]: 0 }))
    try {
      const proxyPath = await window.api.ensurePreviewProxy(filePath, assetId)
      setAssetProxyPath(assetId, proxyPath)
    } catch (e) {
      // The asset stays usable — it just can't be previewed. Surfacing this beats
      // leaving the user with a black preview and no explanation.
      setError(
        `${fileNameFromPath(filePath)}: プレビュー用の変換に失敗しました。編集と書き出しは可能ですが、プレビューでは再生できません — ${formatIpcError(e)}`
      )
    } finally {
      setProxyProgress((prev) => {
        const next = { ...prev }
        delete next[assetId]
        return next
      })
    }
  }

  /**
   * 開いた/復元したプロジェクトの素材にも、必要ならプロキシを用意する。
   *
   * プロキシを作っていたのは**取り込みのときだけ**だった。取り込み直後は再生できるのに、
   * 保存して開き直すと同じ素材が**プレビューで再生できなくなる**——変換が終わる前に保存
   * すれば `proxyPath` は保存されず、変換が一度失敗した場合・別の環境で開いた場合も同じ。
   * しかも開いたあとは**誰も作り直さない**ので、その状態から回復する手段が無い
   * (実測: HEVC を取り込むと videoWidth 960 で再生できるのに、保存して開き直すと
   * videoWidth 0 のまま「プレビューで再生できません」が出続け、60秒待っても変換は
   * 始まらなかった)。
   *
   * 判定は取り込みと同じで、**実際に読み込ませてみる**(`canPreviewFile`)。
   * コーデック名で決め打ちすると環境ごとに答えが変わる。
   */
  async function ensureLoadedAssetsPreviewable(
    loaded: MediaAsset[],
    stillCurrent: () => boolean
  ): Promise<void> {
    // 前のプロジェクトのメッセージを残したままにしない(取り込みの入り口と同じ扱い)。
    setError(null)
    for (const asset of await assetsNeedingPreviewProxy(loaded, canPreviewFile)) {
      // 調べている間に別のプロジェクトを開かれたら、そこで止める。**遅れて返ってきた
      // 結果を今の画面に書かない**(実測: 消えた素材を調べている最中に別のプロジェクトを
      // 開くと、開いたあとの画面に前のプロジェクトのメッセージが出た)。
      if (!stillCurrent()) return
      // 取り込みと同じ「コーデックのせいか、壊れているか」の判定材料をここで取る
      // (プレビューできなかった素材だけなので、ffprobe は最小限しか走らない)。
      let codecSaysUnplayable = false
      try {
        codecSaysUnplayable = (await window.api.probeMedia(asset.filePath)).needsPreviewProxy
      } catch {
        if (!stillCurrent()) return
        setError(
          `${asset.fileName}: プレビューで読み込めませんでした。ファイルが移動・削除されていないか確認してください。`
        )
        continue
      }
      if (!stillCurrent()) return
      await ensurePreviewable(asset.id, asset.filePath, codecSaysUnplayable, asset.hasVideo)
    }
  }

  // プロジェクトを開いた/自動保存から復元したときだけ走る。`project.id` は保存・読込を
  // 通して保たれ、素材を足しただけでは変わらないので、取り込みのたびに走り直さない。
  // 見るのは**この描画時点の** `assets`。`getState()` で読み直すと、開いた直後に
  // 取り込まれた素材まで拾って二重に調べにいく(取り込み側が既に面倒を見ている)。
  useEffect(() => {
    let canceled = false
    // 画面の状態(進捗・メッセージ)を更新するのが目的の副作用。props から導ける値ではない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void ensureLoadedAssetsPreviewable(assets, () => !canceled)
    return () => {
      canceled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Deleting an asset also deletes every clip made from it, so the count is shown
  // before doing it — losing a cut you spent time on to a stray click is much worse
  // than one extra confirmation.
  function handleRemoveAsset(asset: MediaAsset): void {
    const timelineUses = useProjectStore
      .getState()
      .project.clips.filter((c) => c.assetId === asset.id).length
    const audioUses = audioTracks.reduce(
      (n, t) => n + t.clips.filter((c) => c.assetId === asset.id).length,
      0
    )
    const pipUses = videoOverlayTracks.reduce(
      (n, t) => n + t.clips.filter((c) => c.assetId === asset.id).length,
      0
    )
    const total = timelineUses + audioUses + pipUses
    if (total > 0) {
      const parts: string[] = []
      if (timelineUses > 0) parts.push(`タイムライン ${timelineUses}箇所`)
      if (audioUses > 0) parts.push(`音声トラック ${audioUses}箇所`)
      if (pipUses > 0) parts.push(`動画トラック(PiP) ${pipUses}箇所`)
      // Captions hold absolute times, so removing clips shifts the material out from
      // under them. Saying so up front beats letting the user discover it later.
      const captionWarning =
        timelineUses > 0 && textOverlays.length > 0
          ? '\n\nタイムラインが詰まるため、テロップの位置がずれます。'
          : ''
      if (
        !confirm(
          `「${asset.fileName}」は${parts.join(' / ')}で使用中です。\n削除するとこれらのクリップも一緒に消えます。${captionWarning}\n\n削除しますか?(Ctrl+Zで元に戻せます)`
        )
      ) {
        return
      }
    }
    setError(null)
    removeAsset(asset.id)
  }

  async function handleRelink(assetId: string): Promise<void> {
    setError(null)
    setRelinkingId(assetId)
    try {
      const filePath = await window.api.selectRelinkFile()
      if (!filePath) return
      const meta = await window.api.probeMedia(filePath)
      let thumbnailDataUrl: string | undefined
      if (meta.hasVideo) {
        try {
          thumbnailDataUrl = await window.api.generateThumbnail(
            filePath,
            Math.min(1, meta.duration / 2)
          )
        } catch {
          thumbnailDataUrl = undefined
        }
      }
      relinkAsset(assetId, filePath, fileNameFromPath(filePath), meta, thumbnailDataUrl)
      void ensurePreviewable(assetId, filePath, meta.needsPreviewProxy, meta.hasVideo)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setRelinkingId(null)
    }
  }

  async function importFiles(paths: string[], unsupported: string[] = []): Promise<void> {
    if (paths.length === 0) {
      if (unsupported.length > 0) setError(unsupportedMessage(unsupported))
      return
    }
    setImporting(true)
    // One bad file must not abort the batch: the files after it would silently
    // never be imported while the user assumes every valid selection was added.
    const failures: string[] = []
    const imported: MediaAsset[] = []
    const proxyCandidates: { asset: MediaAsset; codecSaysUnplayable: boolean }[] = []
    for (const filePath of paths) {
      try {
        const meta = await window.api.probeMedia(filePath)
        let thumbnailDataUrl: string | undefined
        if (meta.hasVideo) {
          try {
            thumbnailDataUrl = await window.api.generateThumbnail(
              filePath,
              Math.min(1, meta.duration / 2)
            )
          } catch {
            thumbnailDataUrl = undefined
          }
        }
        const asset: MediaAsset = {
          id: uuid(),
          filePath,
          fileName: fileNameFromPath(filePath),
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          fps: meta.fps,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          thumbnailDataUrl
        }
        imported.push(asset)
        proxyCandidates.push({ asset, codecSaysUnplayable: meta.needsPreviewProxy })
      } catch (e) {
        failures.push(`${fileNameFromPath(filePath)}: ${formatIpcError(e)}`)
      }
    }
    // One history entry for the whole import, not one per file.
    addAssets(imported)
    // 読み込んだフォルダを共通ライブラリに覚える(次の回からは選ぶだけで使える)。
    // 覚えられなくても取り込みそのものは済んでいるので、失敗は黙って捨てる
    if (imported.length > 0) {
      void window.api.libraryRemember(imported.map((a) => a.filePath)).catch(() => {})
    }
    // Assets are added first and the (potentially slow) transcode runs afterwards, so
    // the media list appears immediately instead of freezing until ffmpeg finishes.
    for (const { asset, codecSaysUnplayable } of proxyCandidates) {
      void ensurePreviewable(asset.id, asset.filePath, codecSaysUnplayable, asset.hasVideo)
    }
    const messages: string[] = []
    if (unsupported.length > 0) messages.push(unsupportedMessage(unsupported))
    if (failures.length > 0) {
      messages.push(
        `${failures.length}件のファイルを読み込めませんでした — ${failures.join(' / ')}`
      )
    }
    if (messages.length > 0) setError(messages.join(' / '))
    setImporting(false)
  }

  async function handleImportVideo(): Promise<void> {
    setError(null)
    await importFiles(await window.api.selectMediaFiles())
  }

  // メニューバー(ファイル・表示・自動編集)から来る操作
  useMenuCommand((id) => {
    if (id === 'file.importVideo') void handleImportVideo()
    else if (id === 'file.importAudio') void handleImportAudio()
    else if (id === 'view.library') setView('library')
    else if (id === 'file.addLibraryFolder') {
      setView('library')
      void window.api.libraryAddFolder().catch((e) => setError(formatIpcError(e)))
    } else if (id === 'auto.allInOne' || id === 'auto.roughCut' || id === 'auto.longFormShort') {
      if (!hasVideoAssets) {
        setView('project')
        setError('先に動画の素材を読み込んでください')
        return
      }
      if (id === 'auto.allInOne') setShowAutoEdit(true)
      else if (id === 'auto.roughCut') setShowRoughCut(true)
      else setShowLongForm(true)
    }
  })

  async function handleImportAudio(): Promise<void> {
    setError(null)
    await importFiles(await window.api.selectAudioFiles())
  }

  // ドロップされたものの取り込み。取り込み経路はダイアログと同じ importFiles に集約する
  // (プロキシ生成・履歴1件・失敗の集約が経路ごとにばらけないようにするため)。
  async function importDroppedFiles(files: File[]): Promise<void> {
    if (importing) return
    setError(null)
    const paths: string[] = []
    const unsupported: string[] = []
    for (const file of files) {
      // 実ファイルに紐づかないドラッグ(ブラウザからの画像など)は空文字が返る。
      // フォルダはパスが取れても拡張子が無いのでここで落ちる。
      const filePath = window.api.getPathForFile(file)
      if (!filePath || !isSupportedMediaPath(filePath)) {
        unsupported.push(file.name)
        continue
      }
      paths.push(filePath)
    }
    await importFiles(paths, unsupported)
  }

  // ウィンドウ全体でファイルのドロップを受ける。メディアパネルだけを的にすると、
  // 畳んでいるときや外した場所へ落としたときに Electron が既定動作でその動画へ
  // 画面遷移してしまい、編集中のプロジェクトごと表示が飛ぶ。
  const dropHandlerRef = useRef(importDroppedFiles)
  useEffect(() => {
    dropHandlerRef.current = importDroppedFiles
  })
  useEffect(() => {
    // クリップの並び替えなどアプリ内のドラッグには反応しない
    const isFileDrag = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')
    let depth = 0
    const onDragEnter = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      depth += 1
      setFileDragActive(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      // ウィンドウの外へ出た場合は relatedTarget が無い。取りこぼすと案内が出たまま残る。
      depth = e.relatedTarget ? depth - 1 : 0
      if (depth <= 0) {
        depth = 0
        setFileDragActive(false)
      }
    }
    const onDrop = (e: DragEvent): void => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      depth = 0
      setFileDragActive(false)
      void dropHandlerRef.current(Array.from(e.dataTransfer?.files ?? []))
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <div className="panel media-bin">
      <div className="panel-header">
        <div className="media-bin-tabs" role="tablist" aria-label="素材の表示">
          <button
            role="tab"
            aria-selected={view === 'project'}
            className={`media-bin-tab ${view === 'project' ? 'active' : ''}`}
            onClick={() => setView('project')}
          >
            プロジェクト
          </button>
          <button
            role="tab"
            aria-selected={view === 'library'}
            className={`media-bin-tab ${view === 'library' ? 'active' : ''}`}
            onClick={() => setView('library')}
            title="一度読み込んだフォルダの素材を、どのプロジェクトからでも使えます"
          >
            ライブラリ
          </button>
        </div>
        <div className="media-import-buttons">
          <button className="primary-button" onClick={handleImportVideo} disabled={importing}>
            <UploadIcon width={14} height={14} />
            動画
          </button>
          <button
            className="icon-button"
            onClick={handleImportAudio}
            disabled={importing}
            title="音楽/音声を追加"
          >
            <MusicIcon width={14} height={14} />
          </button>
        </div>
      </div>
      {view === 'library' ? (
        <>
          {error && <p className="error-text">{error}</p>}
          <LibraryPanel
            busy={importing}
            usedPaths={new Set(assets.map((x) => x.filePath))}
            onUse={(paths) => importFiles(paths)}
          />
        </>
      ) : (
        <>
          {hasVideoAssets && (
            <div className="media-bin-auto-buttons">
              <button
                className="small-button longform-trigger"
                onClick={() => setShowLongForm(true)}
                title="2時間などの長い動画から、音声の盛り上がりを手がかりに30秒前後のショートをAIが組み立てます"
              >
                <WandIcon width={13} height={13} />
                長尺からショートを自動生成
              </button>
              <button
                className={`small-button autoedit-trigger ${autoEditRunning ? 'running' : ''}`}
                onClick={() => setShowAutoEdit(true)}
                title={
                  autoEditRunning
                    ? '生成中です。押すと進み具合と結果を開けます(閉じても生成は続きます)'
                    : '配置した動画素材から5種類の編集パターンをAIが自動生成します。良し悪しを評価すると次回以降の生成に反映されます'
                }
              >
                <WandIcon width={13} height={13} />
                {autoEditRunning
                  ? 'AIおまかせ全自動編集(生成中...)'
                  : 'AIおまかせ全自動編集(5パターン)'}
              </button>
              <button
                className="small-button roughcut-trigger"
                onClick={() => setShowRoughCut(true)}
                title="すべての動画素材からハイライトを検出し、タイムラインへ自動でラフカットを組み立てます"
              >
                <WandIcon width={13} height={13} />
                複数素材から自動ラフカット
              </button>
            </div>
          )}
          {importing && <p className="hint-text">読み込み中...</p>}
          {error && <p className="error-text">{error}</p>}
          <div className="media-list">
            {assets.length === 0 && (
              <div className="empty-state">
                <ClapperboardIcon width={28} height={28} />
                <p className="hint-text">動画・音声ファイルを追加してください</p>
                <p className="hint-text">ファイルをこのウィンドウにドロップしても追加できます</p>
              </div>
            )}
            {assets.map((asset) => {
              const isMissing = missingAssetIds.includes(asset.id)
              return (
                <div
                  key={asset.id}
                  className={`media-item ${isMissing ? 'media-item-missing' : ''} ${
                    sourceAssetId === asset.id ? 'media-item-in-source' : ''
                  }`}
                  onDoubleClick={() => !isMissing && openInSourceViewer(asset.id)}
                  title="タイムラインへドラッグして配置。ダブルクリックでソースビューアで開く"
                  // 見つからない素材は掴めない(置いた先で「素材がありません」になるだけなので)
                  draggable={!isMissing}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'copy'
                    e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id)
                    // ドラッグ中に中身は読めないので、どの素材かはストア越しに伝える
                    setDraggingAssetId(asset.id)
                  }}
                  onDragEnd={() => setDraggingAssetId(null)}
                >
                  <div className="media-thumb">
                    {asset.thumbnailDataUrl ? (
                      <img src={asset.thumbnailDataUrl} alt={asset.fileName} />
                    ) : (
                      <div className="media-thumb-placeholder">
                        {asset.hasVideo ? (
                          <ClapperboardIcon width={16} height={16} />
                        ) : (
                          <MusicIcon width={16} height={16} />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="media-info">
                    <div className="media-name" title={asset.fileName}>
                      {asset.fileName}
                    </div>
                    <div className="media-meta">
                      {formatDuration(asset.duration)}
                      {asset.hasVideo && ` ・ ${asset.width}x${asset.height}`}
                      {asset.hasVideo && !isMissing && isAspectMismatch(asset, aspectRatio) && (
                        <span
                          className="mismatch-badge"
                          title="プロジェクトのアスペクト比と異なるため、書き出し時に上下または左右に黒帯が入ります"
                        >
                          <AlertTriangleIcon width={11} height={11} />
                          比率が異なる
                        </span>
                      )}
                      {isMissing && (
                        <span
                          className="mismatch-badge missing-badge"
                          title={`ファイルが見つかりません: ${asset.filePath}`}
                        >
                          <AlertTriangleIcon width={11} height={11} />
                          ファイルが見つかりません
                        </span>
                      )}
                    </div>
                    {proxyProgress[asset.id] !== undefined && (
                      <div
                        className="media-proxy-progress"
                        title="プレビューで再生できない形式のため、プレビュー専用の変換をしています。書き出しは元のファイルを使うので画質は落ちません。"
                      >
                        <div className="media-proxy-bar">
                          <div
                            className="media-proxy-bar-fill"
                            style={{ width: `${proxyProgress[asset.id]}%` }}
                          />
                        </div>
                        <span>プレビュー用に変換中 {proxyProgress[asset.id]}%</span>
                      </div>
                    )}
                  </div>
                  <div className="media-item-actions">
                    <button
                      className="icon-button danger media-item-remove"
                      onClick={() => handleRemoveAsset(asset)}
                      title="この素材をプロジェクトから削除(使用中のクリップも一緒に消えます)"
                    >
                      <TrashIcon width={12} height={12} />
                    </button>
                    {!isMissing && (
                      <button
                        className="small-button"
                        onClick={() => openInSourceViewer(asset.id)}
                        title="ソースビューアで開いて、使う範囲を決めてから配置する"
                      >
                        ソースで開く
                      </button>
                    )}
                    {isMissing && (
                      <button
                        className="small-button"
                        onClick={() => handleRelink(asset.id)}
                        disabled={relinkingId === asset.id}
                        title="移動・改名されたファイルの場所を選び直します"
                      >
                        <RefreshIcon width={13} height={13} />
                        再リンク
                      </button>
                    )}
                    {!isMissing && asset.hasVideo && (
                      <button
                        className="icon-button"
                        onClick={() => setHighlightAssetId(asset.id)}
                        title="ハイライトを検出"
                      >
                        <TargetIcon width={14} height={14} />
                      </button>
                    )}
                    {!isMissing && asset.hasVideo && (
                      <button
                        className="icon-button"
                        onClick={() => addClipToTimeline(asset.id)}
                        title="動画トラックに追加"
                      >
                        <PlusIcon width={14} height={14} />
                      </button>
                    )}
                    {!isMissing && asset.hasAudio && audioTracks.length > 0 && (
                      <div className="media-track-add">
                        <select
                          value={trackChoice[asset.id] ?? audioTracks[0].id}
                          onChange={(e) =>
                            setTrackChoice((prev) => ({ ...prev, [asset.id]: e.target.value }))
                          }
                        >
                          {audioTracks.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="icon-button"
                          title="音声トラックに追加"
                          onClick={() =>
                            addClipToAudioTrack(
                              trackChoice[asset.id] ?? audioTracks[0].id,
                              asset.id
                            )
                          }
                        >
                          <PlusIcon width={14} height={14} />
                        </button>
                      </div>
                    )}
                    {!isMissing && asset.hasVideo && videoOverlayTracks.length > 0 && (
                      <div className="media-track-add">
                        <select
                          value={videoTrackChoice[asset.id] ?? videoOverlayTracks[0].id}
                          onChange={(e) =>
                            setVideoTrackChoice((prev) => ({ ...prev, [asset.id]: e.target.value }))
                          }
                        >
                          {videoOverlayTracks.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="icon-button"
                          title="動画トラック(PiP)に追加"
                          onClick={() =>
                            addClipToVideoOverlayTrack(
                              videoTrackChoice[asset.id] ?? videoOverlayTracks[0].id,
                              asset.id
                            )
                          }
                        >
                          <PlusIcon width={14} height={14} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
      {highlightAssetId && (
        <HighlightModal assetId={highlightAssetId} onClose={() => setHighlightAssetId(null)} />
      )}
      {showRoughCut && <RoughCutModal onClose={() => setShowRoughCut(false)} />}
      {showAutoEdit && <AutoEditModal onClose={() => setShowAutoEdit(false)} />}
      {showLongForm && <LongFormShortModal onClose={() => setShowLongForm(false)} />}
      {/* メディアパネルは折りたためるので、案内はパネルの中ではなく body に出す。
          pointer-events を切ってあるので、案内自体がドロップを吸うことはない。 */}
      {fileDragActive &&
        createPortal(
          <div className="file-drop-overlay">
            <div className="file-drop-card">
              <UploadIcon width={26} height={26} />
              <p className="file-drop-title">ドロップして素材に追加</p>
              <p className="hint-text">{MEDIA_EXTENSIONS.join(' / ')}</p>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
