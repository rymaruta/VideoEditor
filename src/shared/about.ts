/**
 * バージョン情報(ヘルプ > バージョン情報)に出す中身。OS の白い確認の窓をやめ、アプリの中の
 * ダイアログ(AboutDialog)で出す。文言は前の確認の窓(aboutWindow.ts の showAboutDialog)と同じ。
 */
export interface AboutInfo {
  product: string
  version: string
  electron: string
  chrome: string
  node: string
}

/** ライセンスの文書(main が別の窓で開く) */
export type LicenseDoc = 'notices' | 'chromium'

export const ABOUT_NOTE =
  'この製品は FFmpeg(GPL)などのオープンソースのソフトウェア・フォント・AI のモデルを使っています。' +
  '著作権と各ライセンスは「サードパーティのライセンス」「Chromium のライセンス」で読めます。'

/** 見出し(製品名と版)と、部品の版の 1 行 */
export function aboutLines(info: AboutInfo): { title: string; runtime: string } {
  return {
    title: `${info.product} ${info.version}`,
    runtime: `Electron ${info.electron} / Chromium ${info.chrome} / Node.js ${info.node}`
  }
}

/** 画面から来たライセンスの文書の名前を確かめる(知らない値は開かない) */
export function isLicenseDoc(v: unknown): v is LicenseDoc {
  return v === 'notices' || v === 'chromium'
}
