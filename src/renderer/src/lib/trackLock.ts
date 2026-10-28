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
