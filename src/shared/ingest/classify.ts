/**
 * 収録フォルダの素材を、カメラ・マイクごとに振り分ける(計画書 §5.1)。
 *
 * ロケの収録は「カードごとにフォルダへコピー」が普通なので、まずフォルダで分ける。
 * 同じフォルダに複数の機材が混ざっていれば、機種名とファイル名の頭(A-0388 の A、
 * GX010123 の GX、ZOOM0001 の ZOOM)で分ける。違っていれば画面で直せる前提で、
 * ここは「たいてい合う」ことを目指す。
 */

export type SourceKind = 'camera' | 'mic'

export interface ProbedFile {
  path: string
  /** 収録フォルダからの相対パス(区切りは / にそろえる) */
  relativePath: string
  duration: number
  hasVideo: boolean
  hasAudio: boolean
  width?: number
  height?: number
  /** 録画を始めた時刻(秒、Unix 時刻)。分からなければ undefined */
  recordedAt?: number
  /** 機種名(make + model) */
  device?: string
  /** ファイルの大きさ(バイト) */
  size: number
}

export interface FootageSource {
  id: string
  /** 画面に出す名前(例: カメラA・ピン 1) */
  name: string
  kind: SourceKind
  /** 振り分けに使った手がかり(例: フォルダ CAM_A、ファイル名 GX) */
  basis: string
  files: ProbedFile[]
}

/** ファイル名の頭の「機材を表す部分」。数字の手前まで(区切り記号は落とす) */
export function fileNamePrefix(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '')
  // 「カメラ_0001」「Ä-01」のような英字以外の名前もあるので、文字は Unicode の文字全般で見る
  const m = /^([\p{L}_\-\s]*?)[-_\s]?\d/u.exec(base)
  const prefix = (m ? m[1] : base).replace(/[-_\s]+$/, '')
  return prefix.toUpperCase()
}

function parentOf(folder: string): string {
  const i = folder.lastIndexOf('/')
  return i < 0 ? '' : folder.slice(0, i)
}

/** 録画時刻が全部分かっているときだけ、その素材群の [始まり, 終わり](秒) */
function recordedRange(files: readonly ProbedFile[]): [number, number] | undefined {
  let start = Infinity
  let end = -Infinity
  for (const f of files) {
    if (f.recordedAt === undefined) return undefined
    start = Math.min(start, f.recordedAt)
    end = Math.max(end, f.recordedAt + f.duration)
  }
  return files.length > 0 ? [start, end] : undefined
}

function folderOf(relativePath: string): string {
  const parts = relativePath.split('/')
  parts.pop()
  return parts.join('/')
}

/** 撮影順(録画時刻、無ければファイル名の自然な順) */
function byRecordingOrder(a: ProbedFile, b: ProbedFile): number {
  if (a.recordedAt !== undefined && b.recordedAt !== undefined && a.recordedAt !== b.recordedAt) {
    return a.recordedAt - b.recordedAt
  }
  return a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true })
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function classifyFootage(files: readonly ProbedFile[]): FootageSource[] {
  const media = files.filter((f) => f.hasVideo || f.hasAudio)
  const groups = new Map<
    string,
    {
      kind: SourceKind
      folder: string
      prefix: string
      device?: string
      files: ProbedFile[]
      chain?: number
      /** カードを替えて続けて撮ったとまとめた、ほかのフォルダ */
      moreFolders?: string[]
    }
  >()
  for (const f of media) {
    const kind: SourceKind = f.hasVideo ? 'camera' : 'mic'
    const folder = folderOf(f.relativePath)
    const prefix = fileNamePrefix(f.relativePath.split('/').pop() ?? '')
    const key = [kind, folder, f.device ?? '', prefix].join('|')
    const g = groups.get(key) ?? { kind, folder, prefix, device: f.device, files: [] }
    g.files.push(f)
    groups.set(key, g)
  }

  // マイクは、同じ頭の名前でも人ごとに別の録音機であることが多い(PIN_01 と PIN_02)。
  // 録音時刻から「前の録音が終わった後に始まっている」と分かるものだけを1つの録音機の続きとし、
  // それ以外は別のマイクにする(違っていれば画面でまとめられる)
  for (const [key, g] of [...groups.entries()]) {
    if (g.kind !== 'mic' || g.files.length < 2) continue
    groups.delete(key)
    const sorted = [...g.files].sort(byRecordingOrder)
    const chains: ProbedFile[][] = []
    for (const f of sorted) {
      const chain =
        f.recordedAt === undefined
          ? undefined
          : chains.find((c) => {
              const last = c[c.length - 1]
              return (
                last.recordedAt !== undefined &&
                last.recordedAt + last.duration <= f.recordedAt! + 1
              )
            })
      if (chain) chain.push(f)
      else chains.push([f])
    }
    chains.forEach((files, i) => groups.set(`${key}#${i}`, { ...g, files, chain: i }))
  }

  // カメラはカードを替えると別のフォルダ(CamA/Card1 → Card2、DCIM/100CANON → 101CANON)に入り、
  // ファイル名も C0001 からやり直すことがある。同じ親フォルダ・同じ機種・同じ頭の名前で、
  // 録画時刻が重ならない(前のカードが終わった後に始まっている)ものは1台のカメラの続きとする。
  // 同じ時間に撮っていれば、同じ機種でも別のカメラ。時刻が分からないものはまとめない
  const camGroups = [...groups.entries()]
    .filter(([, g]) => g.kind === 'camera')
    .map(([key, g]) => ({ key, g, range: recordedRange(g.files) }))
    .filter((c): c is typeof c & { range: [number, number] } => c.range !== undefined)
    .sort((a, b) => a.range[0] - b.range[0])
  const camChains: { group: (typeof camGroups)[number]['g']; parent: string; end: number }[] = []
  for (const c of camGroups) {
    const parent = parentOf(c.g.folder)
    const chain = camChains.find(
      (x) =>
        x.parent === parent &&
        x.group.device === c.g.device &&
        x.group.prefix === c.g.prefix &&
        x.end <= c.range[0] + 1
    )
    if (!chain) {
      camChains.push({ group: c.g, parent, end: c.range[1] })
      continue
    }
    chain.group.files.push(...c.g.files)
    if (c.g.folder !== chain.group.folder && !chain.group.moreFolders?.includes(c.g.folder)) {
      chain.group.moreFolders = [...(chain.group.moreFolders ?? []), c.g.folder]
    }
    chain.end = Math.max(chain.end, c.range[1])
    groups.delete(c.key)
  }

  // フォルダ1つに1グループなら「フォルダ名」、混ざっていれば「フォルダ名 + 頭の文字/機種」で呼ぶ
  const perFolder = new Map<string, number>()
  for (const g of groups.values()) perFolder.set(g.folder, (perFolder.get(g.folder) ?? 0) + 1)

  const list = [...groups.values()].map((g) => {
    g.files.sort(byRecordingOrder)
    const folderName = [g.folder, ...(g.moreFolders ?? [])]
      .map((f) => f.split('/').pop() ?? '')
      .join('・')
    const detail = g.prefix || g.device || ''
    const basis =
      (perFolder.get(g.folder) ?? 0) > 1 || !folderName
        ? [folderName && `フォルダ ${folderName}`, g.prefix && `ファイル名 ${g.prefix}`, g.device]
            .filter(Boolean)
            .join(' · ')
        : `フォルダ ${folderName}`
    return { ...g, detail, folderName, basis }
  })
  // カメラ → マイクの順、その中はフォルダ名の順
  list.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'camera' ? -1 : 1) ||
      a.folder.localeCompare(b.folder, undefined, { numeric: true }) ||
      a.detail.localeCompare(b.detail) ||
      a.files[0].relativePath.localeCompare(b.files[0].relativePath, undefined, { numeric: true })
  )

  let cam = 0
  let mic = 0
  return list.map((g) => {
    const name = g.kind === 'camera' ? `カメラ${LETTERS[cam++] ?? cam}` : `マイク${++mic}`
    return {
      id: `${g.kind}:${g.folder}|${g.device ?? ''}|${g.prefix}${g.chain !== undefined ? `#${g.chain}` : ''}`,
      name,
      kind: g.kind,
      basis: g.basis || 'ファイル名',
      files: g.files
    }
  })
}

/** 素材の合計の長さ(秒) */
export function sourceDuration(source: Pick<FootageSource, 'files'>): number {
  return source.files.reduce((s, f) => s + (Number.isFinite(f.duration) ? f.duration : 0), 0)
}

/** 収録フォルダを読んだ結果 */
export interface FootageScan {
  root: string
  sources: FootageSource[]
  /** 読めなかったファイル(壊れている・対応していない) */
  skipped: { path: string; reason: string }[]
  /** 解析結果の使い回しの判定に使う(パス → 大きさ・更新時刻) */
  stats: Record<string, { size: number; mtimeMs: number }>
}
