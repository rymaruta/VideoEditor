import product from './product.json'

/**
 * 製品の身元(名前・ID・販売者)。**製品名を変えるときは `product.json` の `name` だけを変える。**
 * メニュー・バージョン情報・ファイルの種類の名前・ライセンス表記・インストーラ(`electron-builder.cjs`)・
 * 窓の題名(`electron.vite.config.ts` が index.html に入れる)がここから読む。
 *
 * - 製品名は「Tsunagi」(つなぎ。収録をつないで番組にする)。商標の調査は持ち主の作業(docs/PRODUCT_NAME.md)
 * - 販売者(`vendor`・`vendorEmail`)と、GPL のソースの入手先(`sourceOfferUrl`)はまだ未定(`TBD`)。
 *   決まったら `product.json` を直し、`package.json` の `author` も同じ値にする
 *   (試験 `tests/shared/product.test.ts` が食い違いを止める)。未定のままでは配布用のビルド
 *   (build:win など)が止まる(`scripts/release-check.mjs`。開発用のビルドは止めない)
 * - **`appId` は変えない。** Windows のタスクバー・通知・インストール済みの識別に使われ、変えると
 *   別のアプリとして入る
 * - 設定・自動保存の置き場(userData)は `package.json` の `name`(`video-editor`)で決まり、
 *   製品名を変えても動かない(動くと、前の版の設定・自動保存が見えなくなる)。
 *   `package.json` に `productName` を足さないこと(足すと userData の置き場が変わる)
 */
export const PRODUCT_NAME: string = product.name
export const APP_ID: string = product.appId
export const PRODUCT_DESCRIPTION: string = product.description
export const PRODUCT_VENDOR: string = product.vendor
/** 販売者の連絡先(GPL のソースの提供の申し出の宛先) */
export const PRODUCT_VENDOR_EMAIL: string = product.vendorEmail
/** 同梱した FFmpeg の対応するソース一式を置く場所(docs/GPL_COMPLIANCE.md) */
export const SOURCE_OFFER_URL: string = product.sourceOfferUrl

/** 未定の値(`TBD`・空・example の宛先)。配布用のビルドを止める・画面では「未定」と出す */
export function isPlaceholder(value: string | undefined | null): boolean {
  const v = (value ?? '').trim()
  return (
    v === '' ||
    /^tbd$/i.test(v) ||
    /(^|[@.])example\.(invalid|com|org|net)$/i.test(v) ||
    /^https?:\/\/([^/]+\.)?example\.(invalid|com|org|net)(\/|$)/i.test(v)
  )
}
