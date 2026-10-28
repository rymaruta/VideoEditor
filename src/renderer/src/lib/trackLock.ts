import type { Project } from '@shared/types'

/**
 * トラックの固定で、操作を押せなくするときの理由(画面の title・案内に出す)。
 * 守るのはストア(`freezeLockedTracks`)。ここは「押しても何も起きない」ボタンを押せなくして、
 * なぜ押せないかを言うためのもの
 */
export type LockTarget =
  | { kind: 'main' }
  | { kind: 'telop' }
  | { kind: 'audio'; id?: string; name?: string }
  | { kind: 'overlay'; id: string }

export function lockReason(project: Project, target: LockTarget): string | null {
  switch (target.kind) {
    case 'main':
      return project.mainTrackLocked ? '本編は固定されています' : null
    case 'telop':
      return project.telopTrackLocked ? 'テロップは固定されています' : null
    case 'audio': {
      const t =
        project.audioTracks.find((x) => x.id === target.id) ??
        project.audioTracks.find((x) => target.name !== undefined && x.name === target.name)
      return t?.locked ? `${t.name}は固定されています` : null
    }
    case 'overlay': {
      const t = project.videoOverlayTracks.find((x) => x.id === target.id)
      return t?.locked ? `${t.name}は固定されています` : null
    }
  }
}

/** いくつかの対象のうち、最初に見つかった固定の理由 */
export function firstLockReason(project: Project, targets: readonly LockTarget[]): string | null {
  for (const t of targets) {
    const r = lockReason(project, t)
    if (r) return r
  }
  return null
}

/** トラックの固定を理由に断った・変えなかったときの知らせの文 */
export function lockRefusalMessage(r: { names: readonly string[]; partial: boolean }): string {
  const names = r.names.join('・')
  return r.partial
    ? `${names}は固定されているため変わりませんでした。外してから操作してください`
    : `${names}は固定されています。外してから操作してください`
}

/** その素材を固定したトラックで使っていれば、消せない理由(使っていなければ null) */
export function assetLockReason(project: Project, assetId: string): string | null {
  if (project.mainTrackLocked && project.clips.some((c) => c.assetId === assetId))
    return '固定した本編で使っています'
  const t =
    project.videoOverlayTracks.find(
      (x) => x.locked && x.clips.some((c) => c.assetId === assetId)
    ) ??
    project.audioTracks.find(
      (x) => x.locked && x.clips.some((c) => c.assetId === assetId && !c.linkedClipId)
    )
  return t ? `固定した${t.name}で使っています` : null
}
