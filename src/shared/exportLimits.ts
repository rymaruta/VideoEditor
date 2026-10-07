import type { Project } from './types'

/**
 * 標準の書き出し(ffmpeg を1回だけ起こす)が、OS の決まりに収まるか。
 *
 * 標準の書き出しは、本編・ワイプ・音声トラックのクリップ1本ごとに `-ss … -t … -i <パス>` を
 * コマンドラインに載せる(フィルタグラフはファイルで渡しているが、入力は載る)。
 * Windows はコマンドライン全体で 32,767 文字まで。超えると `spawn` が同期的に投げ、
 * main プロセスごと落ちる(`ffmpegService` の注記)。仮編集を細かく切ったゲーム実況
 * (区間 60・音声トラック 8 本)で 13 万文字に届く。また入力を一度に数千開くと、
 * ファイルの数・メモリの上限に掛かる。収まらなければ区間ごとの書き出しを使う。
 */

/** 入力1つあたりのコマンドラインの文字数(パスを除く `-ss 123.456 -t 12.345 -i ""` と区切り) */
const PER_INPUT_OVERHEAD = 40
/** Windows のコマンドラインの上限(余裕を見て、ffmpeg 自身の引数・出力先のぶんを引く) */
const WINDOWS_COMMAND_LIMIT = 32_767 - 4_000
/** どの OS でも、一度に開く入力の数の上限 */
const MAX_INPUTS = 400

export interface StandardExportCheck {
  fits: boolean
  inputs: number
  commandChars: number
}

export function standardExportFits(
  project: Pick<Project, 'assets' | 'clips' | 'audioTracks' | 'videoOverlayTracks'>,
  platform: string
): StandardExportCheck {
  const pathOf = new Map(project.assets.map((a) => [a.id, a.filePath]))
  const paths: string[] = []
  // 本編は音の枝で同じ素材をもう1度開くことがあるので2つと数える
  for (const c of project.clips) {
    const p = pathOf.get(c.assetId)
    if (p) paths.push(p, p)
  }
  for (const t of project.videoOverlayTracks) {
    if (t.hidden) continue
    for (const c of t.clips) {
      const p = pathOf.get(c.assetId)
      if (p) paths.push(p, p)
    }
  }
  for (const t of project.audioTracks) {
    if (t.muted) continue
    for (const c of t.clips) {
      const p = pathOf.get(c.assetId)
      if (p) paths.push(p)
    }
  }
  const commandChars = paths.reduce((n, p) => n + p.length + PER_INPUT_OVERHEAD, 0)
  const fits =
    paths.length <= MAX_INPUTS && (platform !== 'win32' || commandChars <= WINDOWS_COMMAND_LIMIT)
  return { fits, inputs: paths.length, commandChars }
}
