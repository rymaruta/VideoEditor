// third-party-notices.mjs の型(試験から読むため)
export interface NoticePackage {
  name: string
  version: string
  license: string
  source: string
  author: string
  files: { file: string; text: string }[]
  standardText?: string
}

export interface NoticeModel {
  name: string
  bundled: boolean
  license: string
  source: string
  licenseFile?: string
  text?: string
}

export const BUNDLED_FROM_DEV: string[]
export const CHROMIUM_LICENSES: string
export const MODELS: NoticeModel[]
export function licenseOf(pkg: Record<string, unknown>): string
export function sourceOf(pkg: Record<string, unknown>): string
export function collectPackages(
  projectDir: string,
  roots: string[]
): { packages: NoticePackage[]; missing: string[] }
export function productRoots(projectPkg: Record<string, unknown>): string[]
export function standardLicenseText(
  license: string,
  author: string,
  name: string,
  textsDir: string
): string | undefined
export function renderNotices(input: {
  productName: string
  productVersion: string
  packages: NoticePackage[]
  ffmpeg: {
    ffmpeg?: { version: string; readme: string; license: string }
    ffprobe?: { version: string }
  }
  electron: { version: string; license: string }
  models: NoticeModel[]
}): string
export function buildNotices(projectDir: string): {
  text: string
  packages: NoticePackage[]
  missing: string[]
  /** 表記が欠けるもの(あれば CLI は失敗で終わる) */
  problems: string[]
  /** Electron が配る Chromium の表記の場所 */
  chromiumLicenses: string
}
