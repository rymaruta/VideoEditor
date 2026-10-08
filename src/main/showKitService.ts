import { readdir } from 'fs/promises'
import { extname, join } from 'path'
import { probeMedia } from './ffmpegService'
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isImagePath
} from '@shared/mediaExtensions'
import { normalizeCategory, type KitFile, type ShowKit } from '@shared/finish/sound'

/**
 * 番組素材フォルダを読む(計画書 §5.9)。
 *   <フォルダ>/SE/<分類>/…  <フォルダ>/BGM/<雰囲気>/…  <フォルダ>/CG/<きっかけの言葉>/…
 * 分類のフォルダ名は言い換えも受け付ける(`normalizeCategory`)。読めないファイルは飛ばす。
 */
const AUDIO = new Set<string>(AUDIO_EXTENSIONS)
// 版面CG は動画(透過付きの .mov / .webm など)と静止画(透過 PNG など)
const VIDEO = new Set<string>([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS])

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
}

async function listFiles(dir: string, exts: Set<string>): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && exts.has(extname(d.name).slice(1).toLowerCase()))
      .map((d) => join(dir, d.name))
      .sort()
  } catch {
    return []
  }
}

/** 大文字小文字・言い換えを吸収して、SE / BGM / CG のフォルダを探す */
async function findTop(root: string, names: string[]): Promise<string | null> {
  const dirs = await listDirs(root)
  // 全角の「ＢＧＭ」・macOS の濁点を分けた名前(NFD)も同じ名前とみなす
  const hit = dirs.find((d) => names.includes(d.normalize('NFKC').trim().toLowerCase()))
  return hit ? join(root, hit) : null
}

async function readGroup(
  top: string | null,
  exts: Set<string>
): Promise<Record<string, KitFile[]>> {
  const out: Record<string, KitFile[]> = {}
  if (!top) return out
  for (const dir of await listDirs(top)) {
    const files: KitFile[] = []
    for (const path of await listFiles(join(top, dir), exts)) {
      const name = path.split(/[/\\]/).pop() ?? path
      if (isImagePath(path)) {
        files.push({ path, name, duration: 0, still: true })
        continue
      }
      const info = await probeMedia(path).catch(() => null)
      if (!(info && info.duration > 0)) continue
      files.push({ path, name, duration: info.duration })
    }
    if (files.length > 0) {
      const key = normalizeCategory(dir)
      out[key] = [...(out[key] ?? []), ...files]
    }
  }
  return out
}

export async function scanShowKit(root: string): Promise<ShowKit> {
  const [se, bgm, cg] = await Promise.all([
    findTop(root, ['se', '効果音']),
    findTop(root, ['bgm', '音楽']),
    findTop(root, ['cg', 'グラフィック'])
  ])
  return {
    se: await readGroup(se, AUDIO),
    bgm: await readGroup(bgm, AUDIO),
    cg: await readGroup(cg, VIDEO)
  }
}
