/**
 * 組ごとのずれ(どの2本が何秒ずれているか)から、全部の素材を1本の時間軸に並べる(計画書 §5.2)。
 *
 * - 確かな組から順につなぐ(最大全域木)。音で合った組を先に、同じ機材の録画時刻の差を後に使う。
 *   同じ機材の中の録画時刻は同じ時計なので信頼できるが、機材をまたぐと時計がずれているので使わない。
 * - つながらなかった素材は「同期できず」として最後に並べ、要確認に出す。
 * - 使わなかった組で位置が食い違うもの、同じカメラで録画が重なるものも要確認に出す。
 */

export interface SyncFile {
  id: string
  sourceId: string
  duration: number
  /** 録画を始めた時刻(機材の時計、秒)。分からなければ undefined */
  recordedAt?: number
}

export interface SyncEdge {
  a: string
  b: string
  /** b の頭が a の頭から何秒後か */
  offset: number
  confidence: number
}

export type PlacementMethod = 'audio' | 'clock' | 'none'

export interface Placement {
  id: string
  /** 共通の時間軸での頭の位置(秒、最小が 0) */
  start: number
  method: PlacementMethod
}

export type SyncIssue =
  | { kind: 'unsynced'; fileId: string }
  | { kind: 'conflict'; a: string; b: string; difference: number }
  | { kind: 'overlap'; a: string; b: string; overlap: number }

export interface SyncSolution {
  placements: Placement[]
  issues: SyncIssue[]
}

/** 食い違いとして報告する差(秒)。29.97p の 2フレーム */
export const CONFLICT_TOLERANCE = 2 / 29.97

interface InternalEdge extends SyncEdge {
  kind: 'audio' | 'clock'
}

export function solvePlacements(
  files: readonly SyncFile[],
  audioEdges: readonly SyncEdge[]
): SyncSolution {
  const ids = new Set(files.map((f) => f.id))
  const edges: InternalEdge[] = audioEdges
    .filter((e) => ids.has(e.a) && ids.has(e.b) && e.a !== e.b)
    .map((e) => ({ ...e, kind: 'audio' as const }))
    .sort((x, y) => y.confidence - x.confidence)

  // 同じ機材の中の録画時刻の差(音の組より後に使う)
  const bySource = new Map<string, SyncFile[]>()
  for (const f of files) {
    const list = bySource.get(f.sourceId) ?? []
    list.push(f)
    bySource.set(f.sourceId, list)
  }
  for (const list of bySource.values()) {
    const timed = list
      .filter((f) => f.recordedAt !== undefined)
      .sort((x, y) => x.recordedAt! - y.recordedAt!)
    for (let i = 1; i < timed.length; i++) {
      edges.push({
        a: timed[i - 1].id,
        b: timed[i].id,
        offset: timed[i].recordedAt! - timed[i - 1].recordedAt!,
        confidence: 0,
        kind: 'clock'
      })
    }
  }

  // 最大全域木(クラスカル法)。つないだ辺だけで位置を決める
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = x
    while (parent.get(c) !== r) {
      const next = parent.get(c)!
      parent.set(c, r)
      c = next
    }
    return r
  }
  for (const f of files) parent.set(f.id, f.id)
  const tree: InternalEdge[] = []
  const unused: InternalEdge[] = []
  for (const e of edges) {
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra === rb) {
      unused.push(e)
      continue
    }
    parent.set(ra, rb)
    tree.push(e)
  }

  const adjacency = new Map<string, { to: string; delta: number; kind: InternalEdge['kind'] }[]>()
  for (const e of tree) {
    adjacency.set(e.a, [...(adjacency.get(e.a) ?? []), { to: e.b, delta: e.offset, kind: e.kind }])
    adjacency.set(e.b, [...(adjacency.get(e.b) ?? []), { to: e.a, delta: -e.offset, kind: e.kind }])
  }

  // まとまりごとに位置を決める
  const pos = new Map<string, number>()
  const method = new Map<string, PlacementMethod>()
  const groups: string[][] = []
  for (const f of files) {
    if (pos.has(f.id)) continue
    const group: string[] = [f.id]
    pos.set(f.id, 0)
    for (let i = 0; i < group.length; i++) {
      const cur = group[i]
      for (const n of adjacency.get(cur) ?? []) {
        if (pos.has(n.to)) continue
        pos.set(n.to, pos.get(cur)! + n.delta)
        group.push(n.to)
      }
    }
    groups.push(group)
  }
  for (const f of files) {
    const kinds = (adjacency.get(f.id) ?? []).map((n) => n.kind)
    method.set(f.id, kinds.includes('audio') ? 'audio' : kinds.includes('clock') ? 'clock' : 'none')
  }

  // いちばん長く録れているまとまりを基準にし、ほかは「同期できず」として後ろへ並べる
  const durationOf = new Map(files.map((f) => [f.id, f.duration]))
  const span = (g: string[]): number => g.reduce((s, id) => s + (durationOf.get(id) ?? 0), 0)
  groups.sort((x, y) => span(y) - span(x))
  const issues: SyncIssue[] = []
  const main = groups[0] ?? []
  const shiftGroup = (g: string[], by: number): void =>
    g.forEach((id) => pos.set(id, pos.get(id)! + by))
  const minOf = (g: string[]): number => Math.min(...g.map((id) => pos.get(id)!))
  const maxEnd = (g: string[]): number =>
    Math.max(...g.map((id) => pos.get(id)! + (durationOf.get(id) ?? 0)))
  if (main.length > 0) shiftGroup(main, -minOf(main))
  let tail = main.length > 0 ? maxEnd(main) : 0
  for (const g of groups.slice(1)) {
    shiftGroup(g, tail - minOf(g))
    tail = maxEnd(g)
    for (const id of g) {
      method.set(id, 'none')
      issues.push({ kind: 'unsynced', fileId: id })
    }
  }
  // 素材が1本だけのまとまり(=基準)しかないときは、同期の必要がないので要確認にしない
  if (main.length === 1 && groups.length > 1) {
    method.set(main[0], 'none')
    issues.unshift({ kind: 'unsynced', fileId: main[0] })
  }

  // 使わなかった音の組で、位置が食い違うもの
  for (const e of unused) {
    if (e.kind !== 'audio') continue
    const diff = pos.get(e.b)! - pos.get(e.a)! - e.offset
    if (Math.abs(diff) > CONFLICT_TOLERANCE)
      issues.push({ kind: 'conflict', a: e.a, b: e.b, difference: diff })
  }

  // 同じカメラ・マイクで録画が重なる(1台で同時に2本は録れないので、どこかが誤っている)
  for (const list of bySource.values()) {
    const placed = list
      .filter((f) => method.get(f.id) !== 'none')
      .sort((x, y) => pos.get(x.id)! - pos.get(y.id)!)
    for (let i = 1; i < placed.length; i++) {
      const prevEnd = pos.get(placed[i - 1].id)! + placed[i - 1].duration
      const overlap = prevEnd - pos.get(placed[i].id)!
      if (overlap > 0.5)
        issues.push({ kind: 'overlap', a: placed[i - 1].id, b: placed[i].id, overlap })
    }
  }

  return {
    placements: files.map((f) => ({ id: f.id, start: pos.get(f.id)!, method: method.get(f.id)! })),
    issues
  }
}
