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
  const m = /^([A-Za-z_\-\s]*?)[-_\s]?\d/.exec(base)
  const prefix = (m ? m[1] : base).replace(/[-_\s]+$/, '')
  return prefix.toUpperCase()
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

  // フォルダ1つに1グループなら「フォルダ名」、混ざっていれば「フォルダ名 + 頭の文字/機種」で呼ぶ
  const perFolder = new Map<string, number>()
  for (const g of groups.values()) perFolder.set(g.folder, (perFolder.get(g.folder) ?? 0) + 1)

  const list = [...groups.values()].map((g) => {
    g.files.sort(byRecordingOrder)
    const folderName = g.folder.split('/').pop() ?? ''
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
