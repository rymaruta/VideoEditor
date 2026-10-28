// gpl-sources.mjs の型(試験から読むため)
export interface ParsedVersion {
  version: string
  release: string | null
  gitHash: string | null
  configuration: string
  enabled: string[]
}
export interface SourceItem {
  id: string
  usedBy: 'ffmpeg' | 'ffprobe'
  name: string
  version: string
  license: string
  url: string | null
  /** Debian のパッケージのソース(snapshot.debian.org から取る) */
  debian?: { package: string; version: string }
  gpl: boolean
}
export interface SourcePlan {
  kind: 'ffmpeg' | 'ffprobe'
  parsed: ParsedVersion
  items: SourceItem[]
  others: { name: string; version: string }[]
}
export function parseVersionOutput(text: string): ParsedVersion
export function parseReadmeVersions(readme: string): Record<string, string>
export function parseX264Banner(
  text: string
): { core: string; revision: string; hash: string } | null
export function ffmpegSourceUrl(parsed: ParsedVersion): string | null
export const GPL_LIBRARIES: { id: string; flag: string; license: string }[]
export function planSources(input: {
  kind: 'ffmpeg' | 'ffprobe'
  versionText: string
  readme?: string
  x264Banner?: string
  overrides?: Record<string, string>
}): SourcePlan
export function missingItems(plans: SourcePlan[]): SourceItem[]
export function renderManifest(input: {
  productName: string
  productVersion: string
  platform: string
  plans: SourcePlan[]
  files: { id: string; file: string; url: string; sha256: string; size: number }[]
  createdAt: string
}): string
export function main(
  argv: string[],
  projectDir: string
): { plans: SourcePlan[]; archive: string | null; missing?: SourceItem[] }
export function looksLikeArchive(head: Uint8Array): boolean
export function debianSourceFiles(
  json: unknown,
  wanted: { package: string; version: string }
): { name: string; sha1: string; url: string }[]
export function ffmpegStaticDocCandidates(
  exePath: string,
  pathApi?: typeof import('node:path')
): { readme: string[]; license: string[] }
export function findFfmpegStaticDocs(
  exePath: string,
  fallbackLicense?: string
): { readme: string | null; license: string | null; licenseFromPackage: boolean }
