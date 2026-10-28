import { findTimedClipAt, findTimedClipById, type TimedClip } from './timelineMath'

/**
 * 本編(クリップの並び)が変わったときに、プログラムの映像を読み込み直すか(`PreviewPlayer`)。
 *
 * - `load`: 再生位置のクリップを読み込み直す(`time` へ。`initial` は最初の読み込みで、再生は始めない)
 * - `keep`: 読み込んでいるクリップのまま(今の並びの同じクリップ `current` に差し替えるだけ。再生を止めない)
 *
 * 読み込み直すのは、(1) 読み込んでいたクリップが消えた、(2) 何も読み込んでいない(最初)、
 * (3) 読み込んでいたクリップの素材のファイルが替わった(プレビュー用の軽い素材ができた)、
 * (4) 再生位置に当たるクリップが、読み込んでいたクリップでなくなった とき。
 *
 * (4) が無かったため、確認の画面で範囲のカメラを替えた直後、範囲の頭のコマに前のカメラの絵が残っていた:
 * 替える範囲の頭で分けると、前のクリップ(id はそのまま)は範囲の頭で終わり、範囲は新しいクリップ(別のカメラ)
 * になる。読み込んでいたクリップは並びに残り、素材も同じなので「そのまま」と判断していた(再生位置は範囲の頭)。
 * 再生を始めると次のクリップへ進むので直り、書き出しも正しかった。
 *
 * (4) は止めているときだけ見る(`playing`)。再生中に今のクリップの速さを上げる・前のクリップを詰めるなどで
 * 再生位置が隣のクリップに掛かっても、読み込み直すと別の絵へ飛んで音も切れる。再生中は今のクリップを続け、
 * 再生位置は tick が今のクリップから求め直す
 */
export function previewClipFollow(
  timedClips: readonly TimedClip[],
  activeId: string | null | undefined,
  activeUrl: string | null,
  playheadTime: number,
  urlOf: (tc: TimedClip) => string,
  playing = false
): { kind: 'load'; time: number; initial?: boolean } | { kind: 'keep'; current: TimedClip | null } {
  const clips = timedClips as TimedClip[]
  const current = findTimedClipById(clips, activeId)
  if (activeId != null && !current) return { kind: 'load', time: playheadTime }
  if (activeId == null && clips.length > 0) return { kind: 'load', time: 0, initial: true }
  if (current && urlOf(current) !== activeUrl) return { kind: 'load', time: playheadTime }
  if (current && !playing) {
    const atPlayhead = findTimedClipAt(clips, playheadTime)
    if (atPlayhead && atPlayhead.clip.id !== current.clip.id)
      return { kind: 'load', time: playheadTime }
  }
  return { kind: 'keep', current }
}
