import type { MediaAsset } from '@shared/types'
import { applyWhenNotTrying, useProjectStore, type AfterTrialStatus } from '../store/projectStore'

/**
 * 裏の処理を終えて企画に当てるときの、範囲の自動編集の「試しに見る」との順番。試している間は当てるのを
 * 待つ(`applyWhenNotTrying`)ので、当てた後にすること(プロキシの用意)も当てた後に回し、知らせも
 * 「試しを終えたら〜します」にする
 */

/** プレビュー用の素材を用意する(MediaBin の ensurePreviewable) */
export type EnsurePreviewable = (
  assetId: string,
  filePath: string,
  codecSaysUnplayable: boolean,
  hasVideo: boolean,
  audioNeedsFold?: boolean
) => void

/**
 * 読み込んだ素材を入れてから、プレビュー用の素材を用意する(1件の履歴)。素材がまだ企画に無い間に
 * 用意を始めると、できた結果を当てる先が無く捨てられていた
 */
export function addAssetsThenPreview(
  assets: MediaAsset[],
  candidates: readonly {
    asset: MediaAsset
    codecSaysUnplayable: boolean
    audioNeedsFold: boolean
  }[],
  ensure: EnsurePreviewable,
  session?: number
): AfterTrialStatus {
  return applyWhenNotTrying(() => {
    useProjectStore.getState().addAssets(assets)
    // 重い変換は入れた後に回す(素材の一覧はすぐ出る)
    for (const { asset, codecSaysUnplayable, audioNeedsFold } of candidates)
      ensure(asset.id, asset.filePath, codecSaysUnplayable, asset.hasVideo, audioNeedsFold)
  }, session)
}

/**
 * 素材をつなぎ直してから、新しいファイルのプレビュー用の素材を用意する。つなぎ直す前(元の場所のまま)に
 * 用意すると、結果が今のファイルと合わず捨てられていた
 */
export function relinkThenPreview(
  relink: {
    assetId: string
    filePath: string
    fileName: string
    probe: Parameters<ReturnType<typeof useProjectStore.getState>['relinkAsset']>[3]
    thumbnailDataUrl: string | undefined
  },
  preview: { codecSaysUnplayable: boolean; hasVideo: boolean; audioNeedsFold?: boolean } | null,
  ensure: EnsurePreviewable,
  session?: number
): AfterTrialStatus {
  return applyWhenNotTrying(() => {
    useProjectStore
      .getState()
      .relinkAsset(
        relink.assetId,
        relink.filePath,
        relink.fileName,
        relink.probe,
        relink.thumbnailDataUrl
      )
    if (preview)
      ensure(
        relink.assetId,
        relink.filePath,
        preview.codecSaysUnplayable,
        preview.hasVideo,
        preview.audioNeedsFold
      )
  }, session)
}

/**
 * 当てた・待っている・やめた の知らせ。`waiting` は範囲の自動編集を試している間(閉じるか「この案にする」で
 * 当てる)。`dropped` は待つ間に企画を切り替えた
 */
export function afterTrialNotice(
  status: AfterTrialStatus,
  text: { applied: string; waiting: string; dropped: string }
): string {
  return text[status]
}

/** 試しを終えるとは(知らせの中の言い方) */
const AFTER_TRIAL = '範囲の自動編集の試しを終えたら(「この案にする」か閉じる)'

/** ナレーションを作り終えたときの知らせ */
export const NARRATION_NOTICE = {
  applied: 'ナレーションを音声トラックに追加しました。',
  waiting: `ナレーションを作りました。${AFTER_TRIAL}、音声トラックに追加します。`,
  dropped: '別の企画を開いたため、ナレーションは追加しませんでした。'
} as const

/** SRT を読み込んだときの知らせ(`n` 本) */
export function srtImportNotice(n: number): {
  applied: string
  waiting: string
  dropped: string
} {
  return {
    applied: `${n} 本の字幕を読み込みました`,
    waiting: `${n} 本の字幕を、${AFTER_TRIAL}テロップとして入れます`,
    dropped: '別の企画を開いたため、字幕ファイルは読み込んでいません'
  }
}
