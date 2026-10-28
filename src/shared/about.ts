import { isPlaceholder } from './product'

/**
 * バージョン情報(ヘルプ > バージョン情報)に出す中身。アプリの中のダイアログ(AboutDialog)で出す。
 * 「オープンソースの表記」(同梱した部品のライセンス)と「ソースの入手方法」(GPL の FFmpeg の
 * ソースの入手先。docs/GPL_COMPLIANCE.md)もここから見られる。
 */
export interface AboutInfo {
  product: string
  version: string
  electron: string
  chrome: string
  node: string
  /** GPL のソースの入手先と(あれば)連絡先(product.json。未定は TBD のまま来る) */
  sourceOffer?: SourceOfferInfo
}

export interface SourceOfferInfo {
  vendor: string
  /** 連絡先(任意。空・未定なら書面による申し出を出さない) */
  vendorEmail?: string
  url: string
}

/** ライセンスの文書(main が別の窓で開く) */
export type LicenseDoc = 'notices' | 'chromium'

export const ABOUT_NOTE =
  'この製品は FFmpeg(GPL)などのオープンソースのソフトウェア・フォント・AI のモデルを使っています。' +
  '著作権と各ライセンスは「オープンソースの表記」「Chromium のライセンス」で、' +
  'FFmpeg のソースの入手のしかたは「ソースの入手方法」で読めます。'

/**
 * 「ソースの入手方法」の文(THIRD_PARTY_NOTICES の「ソースの入手方法」と同じ中身)。
 * - 連絡先(vendorEmail)が無い(空・未定)とき: バイナリと同じ場所から写せる形での提供
 *   (GPL-3.0 の 6 条 d・GPL-2.0 の 3 条の最後の段落)。入手先の URL だけを案内する
 * - 連絡先があるとき: 書面による申し出(3 年間・媒体での請求の宛先)も出す
 * `url` は入手先が決まっていれば開ける URL、未定なら null。`email` は連絡先が無ければ null
 */
export function sourceOfferView(offer: SourceOfferInfo | undefined): {
  paragraphs: string[]
  url: string | null
  email: string | null
} {
  const vendor = isPlaceholder(offer?.vendor) ? '販売者(未定)' : (offer?.vendor ?? '').trim()
  const url = isPlaceholder(offer?.url) ? null : (offer?.url ?? '').trim()
  const email = isPlaceholder(offer?.vendorEmail) ? null : (offer?.vendorEmail ?? '').trim()
  const intro =
    'この製品には、動画・音声の読み書きのために FFmpeg / FFprobe の実行ファイル(GPL)を、' +
    'アプリとは別のプログラムとして同梱しています。'
  if (email === null) {
    return {
      paragraphs: [
        intro,
        url
          ? `同梱の FFmpeg の対応するソース一式は、${url} の各版のリリースから入手できます(版ごとに置いています)。`
          : '同梱の FFmpeg の対応するソース一式の入手先: (未定)',
        'ソース一式には、FFmpeg 本体と、ビルドに使われた x264・x265 などのライブラリのソース、ビルドの設定が入っています。' +
          `${vendor} は、各版のソース一式をその版と同じ場所に追加の費用なしで置き、その版を配布している間は置き続けます。`
      ],
      url,
      email
    }
  }
  return {
    paragraphs: [
      intro,
      `${vendor} は、同梱した FFmpeg / FFprobe と同じ版の完全なソース(FFmpeg 本体と、ビルドに使われた ` +
        'x264・x265 などのライブラリのソース、ビルドの設定)を、この版を最後に配布した日から少なくとも ' +
        '3 年間、この製品を受け取ったどなたにも提供します。',
      `入手先: ${url ?? '(未定)'}`,
      `媒体での請求: ${email} 宛に、製品名・版・OS を書いてご連絡ください(媒体と送料の実費のみ)。`
    ],
    url,
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
