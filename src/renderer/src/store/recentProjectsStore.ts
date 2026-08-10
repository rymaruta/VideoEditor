import { create } from 'zustand'

const RECENT_PROJECTS_KEY = 've-recent-projects'
const MAX_RECENT = 10

export interface RecentProject {
  filePath: string
  /** 最後に開いた/保存した時刻(ミリ秒)。並び順は配列の順で決まるので表示用 */
  usedAt: number
}

// localStorage は外部入力。JSON.parse が通っても形が期待どおりとは限らないので、
// 配列かどうかと要素の形を確かめ、使えない分は捨てて残りを使う。
function loadRecent(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return (
      parsed
        .filter((e): e is RecentProject => {
          if (typeof e !== 'object' || e === null) return false
          const v = e as Record<string, unknown>
          return (
            typeof v.filePath === 'string' &&
            v.filePath.length > 0 &&
            typeof v.usedAt === 'number' &&
            Number.isFinite(v.usedAt)
          )
        })
        // 手で書き換えられた結果、同じパスが複数入っていることもある
        .filter((e) => (seen.has(e.filePath) ? false : (seen.add(e.filePath), true)))
        .slice(0, MAX_RECENT)
    )
  } catch {
    return []
  }
}

/** パスからファイル名だけを取り出す。Windows の `\` と POSIX の `/` の両方を扱う */
export function projectFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/).filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : filePath
}

interface RecentProjectsState {
  recentProjects: RecentProject[]
  /** 開く/保存に成功したときに呼ぶ。同じパスは重複させず先頭へ移す */
  rememberProject: (filePath: string, usedAt: number) => void
  forgetProject: (filePath: string) => void
}

export const useRecentProjectsStore = create<RecentProjectsState>((set, get) => ({
  recentProjects: loadRecent(),

  rememberProject: (filePath, usedAt) => {
    if (!filePath) return
    const next = [
      { filePath, usedAt },
      ...get().recentProjects.filter((e) => e.filePath !== filePath)
    ].slice(0, MAX_RECENT)
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next))
    set({ recentProjects: next })
  },

  forgetProject: (filePath) => {
    const next = get().recentProjects.filter((e) => e.filePath !== filePath)
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next))
    set({ recentProjects: next })
  }
}))
