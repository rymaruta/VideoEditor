import { describeColorMatch } from '@shared/color/match'
import { useEffect, useRef, useState } from 'react'
import { LibraryPanel } from './LibraryPanel'
import { ClipContextMenu, type ContextMenuItem } from './ClipContextMenu'
import { formatTimecode } from '../lib/timelineRuler'
import { useMenuCommand } from '../lib/menuCommands'
import { createPortal } from 'react-dom'
import { v4 as uuid } from 'uuid'
import { onProjectSwitch, useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import { canPreviewFile, planLoadedAssetPreview } from '../lib/canPreview'
import { isAspectMismatch } from '../lib/aspect'
import { isImagePath, isSupportedMediaPath, MEDIA_EXTENSIONS } from '@shared/mediaExtensions'
import { stillAssetFrom } from '../lib/stillAsset'
import { relinkRefusal } from '../lib/relinkCheck'
import { ASSET_DRAG_TYPE } from '../lib/assetDrag'
import type { MediaAsset } from '@shared/types'
import { HighlightModal } from './HighlightModal'
import { RoughCutModal } from './RoughCutModal'
import { AutoEditModal } from './AutoEditModal'
import { LongFormShortModal } from './LongFormShortModal'
import { UploadIcon, ClapperboardIcon, MusicIcon, AlertTriangleIcon } from './icons'

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

function unsupportedMessage(names: string[]): string {
  return `対応していない形式のため${names.length}件を取り込みませんでした(${MEDIA_EXTENSIONS.join(' / ')}) — ${names.join(' / ')}`
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
  const importingRef = useRef(false)
  /** 取り込みの途中に来て入れなかったファイルがあったか(終わったときの知らせが上書きしないように) */
  const busyDroppedRef = useRef(false)
  /** プロジェクトを替えた回数(読み込みの途中で替えたかを見る) */
  const projectGeneration = useRef(0)
  useEffect(
    () =>
      onProjectSwitch(() => {
        projectGeneration.current++
      }),
    []
  )
  // 「プロジェクト」(この企画の素材)と「ライブラリ」(全プロジェクト共通)の切り替え
  const [view, setView] = useState<'project' | 'library'>('project')
  // 素材の右クリックメニュー(操作のボタンを行に並べないため)
  const [assetMenu, setAssetMenu] = useState<{ asset: MediaAsset; x: number; y: number } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const [highlightAssetId, setHighlightAssetId] = useState<string | null>(null)
  const [showRoughCut, setShowRoughCut] = useState(false)
  const [showAutoEdit, setShowAutoEdit] = useState(false)
  const [showLongForm, setShowLongForm] = useState(false)
  const [relinkingId, setRelinkingId] = useState<string | null>(null)
  const [proxyProgress, setProxyProgress] = useState<Record<string, number>>({})
  const [fileDragActive, setFileDragActive] = useState(false)
  const hasVideoAssets = assets.some((a) => a.hasVideo)

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
    hasVideo: boolean,
    /** そのまま再生できても、試聴用の素材で聞かせる(4.0 の音声。音の畳み方を書き出しとそろえる) */
    audioNeedsFold = false
  ): Promise<void> {
    if (audioNeedsFold) {
      await buildPreviewProxy(assetId, filePath)
      return
    }
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
      setAssetProxyPath(assetId, proxyPath, filePath)
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
    // 静止画は <img> でそのまま見せるので、プレビュー用の変換は要らない
    const playable = loaded.filter((a) => !a.still)
    for (const asset of playable) {
      // 調べている間に別のプロジェクトを開かれたら、そこで止める。**遅れて返ってきた
      // 結果を今の画面に書かない**(実測: 消えた素材を調べている最中に別のプロジェクトを
      // 開くと、開いたあとの画面に前のプロジェクトのメッセージが出た)。
      if (!stillCurrent()) return
      const plan = await planLoadedAssetPreview(asset, canPreviewFile, (path) =>
        // 尺は使わない(尺の無い素材を開くたびに全体を読まない)
        window.api.probeMedia(path, { skipDurationScan: true })
      )
      if (!stillCurrent()) return
      if (plan.kind === 'clearProxy') setAssetProxyPath(asset.id, undefined)
      else if (plan.kind === 'probeFailed')
        setError(
          `${asset.fileName}: プレビューで読み込めませんでした。ファイルが移動・削除されていないか確認してください。`
        )
      else if (plan.kind === 'build') {
        if (plan.clearStaleProxy) setAssetProxyPath(asset.id, undefined)
        await ensurePreviewable(
          asset.id,
          asset.filePath,
          plan.codecSaysUnplayable,
          asset.hasVideo,
          plan.audioNeedsFold
        )
      }
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
      // 静止画は静止画として読む(動画として読むと、サムネイルが取れず、要らない変換が走っていた)
      if (isImagePath(filePath)) {
        const still = await stillAssetFrom(filePath)
        const refusal = relinkRefusal(useProjectStore.getState().project, assetId, filePath, still)
        if (refusal) {
          setError(refusal)
          return
        }
        relinkAsset(assetId, filePath, fileNameFromPath(filePath), still, still.thumbnailDataUrl)
        return
      }
      const meta = await window.api.probeMedia(filePath)
      const refusal = relinkRefusal(useProjectStore.getState().project, assetId, filePath, meta)
      if (refusal) {
        setError(refusal)
        return
      }
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
      void ensurePreviewable(
        assetId,
        filePath,
        meta.needsPreviewProxy,
        meta.hasVideo,
        meta.previewAudioNeedsFold
      )
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
    // メニュー(Ctrl+I)からも来るので、ここで二重に始めない
    // 取り込みの途中に来たものは、黙って捨てずに知らせる(落としたファイルが入らないまま気づけなかった)
    if (importingRef.current) {
      busyDroppedRef.current = true
      setError('取り込み中です。終わってから、もう一度入れてください')
      return
    }
    importingRef.current = true
    // 読み込みの途中で別のプロジェクトを開いたら、読んだ素材を後のプロジェクトに入れない
    const generation = projectGeneration.current
    setImporting(true)
    try {
      await importInto(paths, unsupported, generation)
    } finally {
      importingRef.current = false
      setImporting(false)
      // 取り込み中に入れたものがあれば、終わったときの知らせ(失敗の一覧)に足す
      if (busyDroppedRef.current) {
        busyDroppedRef.current = false
        const note = '取り込み中に入れたファイルは取り込んでいません。もう一度入れてください'
        setError((prev) => (prev && !prev.startsWith('取り込み中です') ? `${prev}\n${note}` : note))
      }
    }
  }

  async function importInto(
    paths: string[],
    unsupported: string[],
    generation: number
  ): Promise<void> {
    // One bad file must not abort the batch: the files after it would silently
    // never be imported while the user assumes every valid selection was added.
    const failures: string[] = []
    const imported: MediaAsset[] = []
    const proxyCandidates: {
      asset: MediaAsset
      codecSaysUnplayable: boolean
      audioNeedsFold: boolean
    }[] = []
    for (const filePath of paths) {
      try {
        // 静止画はワイプ・全面(CG)のトラック用の素材にする(プレビュー用の変換は要らない)
        if (isImagePath(filePath)) {
          imported.push(await stillAssetFrom(filePath))
          continue
        }
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
        proxyCandidates.push({
          asset,
          codecSaysUnplayable: meta.needsPreviewProxy,
          audioNeedsFold: meta.previewAudioNeedsFold ?? false
        })
      } catch (e) {
        failures.push(`${fileNameFromPath(filePath)}: ${formatIpcError(e)}`)
      }
    }
    if (generation !== projectGeneration.current) return
    // One history entry for the whole import, not one per file.
    addAssets(imported)
    // 読み込んだフォルダを共通ライブラリに覚える(次の回からは選ぶだけで使える)。
    // 覚えられなくても取り込みそのものは済んでいるので、失敗は黙って捨てる
    if (imported.length > 0) {
      void window.api.libraryRemember(imported.map((a) => a.filePath)).catch(() => {})
    }
    // Assets are added first and the (potentially slow) transcode runs afterwards, so
    // the media list appears immediately instead of freezing until ffmpeg finishes.
    for (const { asset, codecSaysUnplayable, audioNeedsFold } of proxyCandidates) {
      void ensurePreviewable(
        asset.id,
        asset.filePath,
        codecSaysUnplayable,
        asset.hasVideo,
        audioNeedsFold
      )
    }
    const messages: string[] = []
    if (unsupported.length > 0) messages.push(unsupportedMessage(unsupported))
    if (failures.length > 0) {
      messages.push(
        `${failures.length}件のファイルを読み込めませんでした — ${failures.join(' / ')}`
      )
    }
    if (messages.length > 0) setError(messages.join(' / '))
  }

  async function denoiseAsset(asset: MediaAsset): Promise<void> {
    setError(null)
    try {
      const [r] = await window.api.denoiseRun([asset.filePath])
      if (r?.cleaned)
        useProjectStore
          .getState()
          .setAssetsDenoised(
            { [asset.id]: r.cleaned },
            { expectFilePath: { [asset.id]: asset.filePath } }
          )
      else setError(r?.error ?? 'ノイズ除去ができませんでした')
    } catch (e) {
      setError(formatIpcError(e))
    }
  }

  /** 素材の右クリックメニューの中身。行に常に並べていたボタンと同じ操作 */
  function assetMenuItems(asset: MediaAsset): ContextMenuItem[] {
    const isMissing = missingAssetIds.includes(asset.id)
    const items: ContextMenuItem[] = []
    if (isMissing) {
      items.push({
        label: '再リンク…(ファイルの場所を選び直す)',
        onSelect: () => void handleRelink(asset.id),
        disabled: relinkingId === asset.id
      })
    } else {
      items.push({ label: 'ソースで開く', onSelect: () => openInSourceViewer(asset.id) })
      // 静止画は本編には置かない(長さを持たない)が、ワイプ・CG のトラックには置ける(ドラッグと同じ)
      if (asset.hasVideo && !asset.still) {
        items.push({ label: '本編(V1)の末尾に追加', onSelect: () => addClipToTimeline(asset.id) })
      }
      if (asset.hasVideo) {
        for (const t of videoOverlayTracks) {
          items.push({
            label: `${t.name}(ワイプ)に追加`,
            onSelect: () => addClipToVideoOverlayTrack(t.id, asset.id)
          })
        }
      }
      if (asset.hasAudio) {
        for (const t of audioTracks) {
          items.push({
            label: `${t.name} に追加`,
            onSelect: () => addClipToAudioTrack(t.id, asset.id)
          })
        }
      }
      if (asset.hasVideo && !asset.still) {
        items.push({ label: 'ハイライトを検出…', onSelect: () => setHighlightAssetId(asset.id) })
      }
      // ピンマイクのノイズ除去(声だけの素材)。外すと元の録音に戻る(元に戻すで再び掛かる)
      if (asset.denoisedFrom) {
        items.push({
          label: 'ノイズ除去を外す(元の録音に戻す)',
          onSelect: () => useProjectStore.getState().setAssetsDenoised({ [asset.id]: null })
        })
      } else if (asset.hasAudio && !asset.hasVideo) {
        items.push({
          label: 'ノイズ除去をかける(声を残して雑音を減らす)',
          onSelect: () => void denoiseAsset(asset)
        })
      }
      // 自動編集のカメラの色合わせ。合っていなければ外して元の色に戻せる(元に戻すで再び掛かる)
      if (asset.colorMatch) {
        items.push({
          label: `色合わせを外す(${describeColorMatch(asset.colorMatch)})`,
          onSelect: () => useProjectStore.getState().setColorMatches({ [asset.id]: undefined })
        })
      }
    }
    items.push({
      label: 'プロジェクトから削除',
      danger: true,
      onSelect: () => handleRemoveAsset(asset)
    })
    return items
  }

  async function handleImportVideo(): Promise<void> {
    setError(null)
    await importFiles(await window.api.selectMediaFiles())
  }

  // メニューバー(ファイル・表示・自動編集)から来る操作
  useMenuCommand((id) => {
    // 自動編集で収録素材をまとめて入れたあと(再生できない形式ならプレビュー用に変換する)
    if (id === 'assets.checkPreview') {
      // 調べている間に別のプロジェクトを開かれたら止める(前のプロジェクトのメッセージを出さない)
      const { id: checkingId, assets: checking } = useProjectStore.getState().project
      void ensureLoadedAssetsPreviewable(
        checking,
        () => useProjectStore.getState().project.id === checkingId
      )
    } else if (id === 'file.importVideo') void handleImportVideo()
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
    if (importing || importingRef.current) {
      busyDroppedRef.current = true
      setError('取り込み中です。終わってから、もう一度入れてください')
      return
    }
    setError(null)
    const paths: string[] = []
    const unsupported: string[] = []
    for (const file of files) {
      // 実ファイルに紐づかないドラッグ(ブラウザからの画像など)は空文字が返る。
      // フォルダはパスが取れても拡張子が無いのでここで落ちる。
      const filePath = window.api.getPathForFile(file)
      if (!filePath || !(isSupportedMediaPath(filePath) || isImagePath(filePath))) {
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
          {/* 自動編集(AIおまかせ・ラフカット・長尺からショート)はメニューバーの「自動編集」から開く */}
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
            {assets.length > 0 && (
              <div className="media-list-head" aria-hidden>
                <span className="media-col-name">名前</span>
                <span className="media-col-dur">デュレーション</span>
                <span className="media-col-res">解像度</span>
              </div>
            )}
            {assets.map((asset) => {
              const isMissing = missingAssetIds.includes(asset.id)
              const mismatch = asset.hasVideo && !isMissing && isAspectMismatch(asset, aspectRatio)
              return (
                <div
                  key={asset.id}
                  className={`media-row ${isMissing ? 'missing' : ''} ${
                    sourceAssetId === asset.id ? 'in-source' : ''
                  } ${assetMenu?.asset.id === asset.id ? 'menu-open' : ''}`}
                  onDoubleClick={() => !isMissing && openInSourceViewer(asset.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setAssetMenu({ asset, x: e.clientX, y: e.clientY })
                  }}
                  title={
                    isMissing
                      ? `ファイルが見つかりません: ${asset.filePath}(右クリックで再リンク)`
                      : `${asset.filePath}\nタイムラインへドラッグして配置・ダブルクリックでソースを開く・右クリックで操作`
                  }
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
                  <span
                    className={`media-kind ${asset.hasVideo ? 'video' : 'audio'}`}
                    aria-hidden
                  />
                  <span className="media-col-name">
                    {(isMissing || mismatch) && (
                      <AlertTriangleIcon
                        width={11}
                        height={11}
                        className="media-warn"
                        aria-label={
                          isMissing
                            ? 'ファイルが見つかりません'
                            : 'プロジェクトと縦横比が違うため、書き出しで黒帯が入ります'
                        }
                      />
                    )}
                    {asset.fileName}
                  </span>
                  <span className="media-col-dur">
                    {formatTimecode(asset.duration, asset.fps || 30)}
                  </span>
                  <span className="media-col-res">
                    {asset.hasVideo ? `${asset.width}×${asset.height}` : '音声'}
                  </span>
                  {proxyProgress[asset.id] !== undefined && (
                    <span
                      className="media-row-progress"
                      title={`プレビュー用に変換中 ${proxyProgress[asset.id]}%(書き出しは元のファイルを使います)`}
                      style={{ width: `${proxyProgress[asset.id]}%` }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
      {assetMenu && (
        <ClipContextMenu
          x={assetMenu.x}
          y={assetMenu.y}
          items={assetMenuItems(assetMenu.asset)}
          onClose={() => setAssetMenu(null)}
        />
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
