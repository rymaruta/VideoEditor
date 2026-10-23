import { isPlaceholder } from './product'

/**
 * バージョン情報(ヘルプ > バージョン情報)に出す中身。アプリの中のダイアログ(AboutDialog)で出す。
 * 「オープンソースの表記」(同梱した部品のライセンス)と「ソースの入手方法」(GPL の FFmpeg の
 * ソースの提供の申し出。docs/GPL_COMPLIANCE.md)もここから見られる。
 */
export interface AboutInfo {
  product: string
  version: string
  electron: string
  chrome: string
  node: string
  /** GPL のソースの提供の申し出の宛先(product.json。未定は TBD のまま来る) */
  sourceOffer?: SourceOfferInfo
}

export interface SourceOfferInfo {
  vendor: string
  vendorEmail: string
  url: string
}

/** ライセンスの文書(main が別の窓で開く) */
export type LicenseDoc = 'notices' | 'chromium'

export const ABOUT_NOTE =
  'この製品は FFmpeg(GPL)などのオープンソースのソフトウェア・フォント・AI のモデルを使っています。' +
  '著作権と各ライセンスは「オープンソースの表記」「Chromium のライセンス」で、' +
  'FFmpeg のソースの入手のしかたは「ソースの入手方法」で読めます。'

/** 未定の値は「(未定)」と出す(仮の宛先を見せない) */
function shown(v: string | undefined): string {
  return isPlaceholder(v) ? '(未定)' : (v ?? '').trim()
}

/**
 * 「ソースの入手方法」の文(GPL の書面による申し出。THIRD_PARTY_NOTICES の申し出と同じ中身)。
 * `url` は入手先が決まっていれば開ける URL、未定なら null
 */
export function sourceOfferView(offer: SourceOfferInfo | undefined): {
  paragraphs: string[]
  url: string | null
  email: string
} {
  const vendor = isPlaceholder(offer?.vendor) ? '販売者(未定)' : (offer?.vendor ?? '').trim()
  const email = shown(offer?.vendorEmail)
  const url = shown(offer?.url)
  return {
    paragraphs: [
      'この製品には、動画・音声の読み書きのために FFmpeg / FFprobe の実行ファイル(GPL)を、' +
        'アプリとは別のプログラムとして同梱しています。',
      `${vendor} は、同梱した FFmpeg / FFprobe と同じ版の完全なソース(FFmpeg 本体と、ビルドに使われた ` +
        'x264・x265 などのライブラリのソース、ビルドの設定)を、この版を最後に配布した日から少なくとも ' +
        '3 年間、この製品を受け取ったどなたにも提供します。',
      `入手先: ${url}`,
      `媒体での請求: ${email} 宛に、製品名・版・OS を書いてご連絡ください(媒体と送料の実費のみ)。`
    ],
    url: isPlaceholder(offer?.url) ? null : (offer?.url ?? '').trim(),
    email
  }
}

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
