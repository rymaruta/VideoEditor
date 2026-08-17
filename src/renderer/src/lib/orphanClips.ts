import type { Project } from '@shared/types'

export interface OrphanCleanup {
  project: Project
  /** 取り除いたクリップの本数(本編・音声・PiP の合計) */
  droppedCount: number
  /**
   * **取り除いた分離音声が紐づいていた本編クリップのID。**
   *
   * 並びを組み直すだけでなく「IDに何が起きたか」も返す。紐づき先が生き残るのに
   * 音声だけ落ちると、その本編クリップは `audioDetached` が立ったまま
   * **鳴らす相手が居ない**状態になり、書き出しが無音になる。
   * 呼び出し側が `reattachClipsWithoutLinkedAudio` へ渡して印を下ろす。
   */
  unlinkedClipIds: string[]
}

/**
 * **素材が `assets` に1件も無い**クリップを落とす。
 *
 * こうなったプロジェクトは**画面から直せない**。タイムラインもプレビューも
 * `buildTimedClips` が素材の無いクリップを捨てるので何も出ず、選ぶことも消すことも
 * できないのに、`project.clips` には残っている。そして本編トラックのぶんは
 * 書き出しのたびに `アセットが見つかりません: <id>` で失敗する
 * (音声・PiP は書き出し側が黙って読み飛ばすので、こちらは「消せない幽霊」だけが残る)。
 *
 * **落とす条件は「`assets` にエントリごと無いこと」だけ。**
 * ファイルが見つからないだけの素材(再リンク待ち)は `assets` に居るので**残す**。
 * ここを「ファイルが実在するか」で判断すると、**再リンクすれば直るはずのクリップまで
 * 開いた瞬間に消える**——取り返しがつかないうえ、利用者には理由も分からない。
 *
 * 何も落とさなかったときは**受け取った `project` をそのまま返す**(呼び出し側が
 * 参照の同一性で「掃除は起きなかった」と判定できるように)。
 */
export function dropOrphanClips(project: Project): OrphanCleanup {
  const assetIds = new Set(project.assets.map((a) => a.id))
  const alive = <T extends { assetId: string }>(c: T): boolean => assetIds.has(c.assetId)

  const clips = project.clips.filter(alive)
  let dropped = project.clips.length - clips.length

  const unlinkedClipIds: string[] = []
  const audioTracks = project.audioTracks.map((t) => {
    const kept = t.clips.filter(alive)
    if (kept.length === t.clips.length) return t
    dropped += t.clips.length - kept.length
    for (const c of t.clips) {
      if (!alive(c) && c.linkedClipId != null) unlinkedClipIds.push(c.linkedClipId)
    }
    return { ...t, clips: kept }
  })

  const videoOverlayTracks = project.videoOverlayTracks.map((t) => {
    const kept = t.clips.filter(alive)
    if (kept.length === t.clips.length) return t
    dropped += t.clips.length - kept.length
    return { ...t, clips: kept }
  })

  if (dropped === 0) return { project, droppedCount: 0, unlinkedClipIds: [] }
  return {
    project: { ...project, clips, audioTracks, videoOverlayTracks },
    droppedCount: dropped,
    unlinkedClipIds
  }
}

/** 掃除したことを利用者に伝える文面。件数を出さないと「何が消えたのか」が分からない。 */
export function orphanCleanupMessage(droppedCount: number): string {
  return `素材が見つからないクリップを${droppedCount}件取り除きました(プロジェクトファイルが壊れていた可能性があります)。保存すると確定します。`
}
