import product from './product.json'

/**
 * 製品の身元(名前・ID・販売者)。**製品名を変えるときは `product.json` の `name` だけを変える。**
 * メニュー・バージョン情報・ファイルの種類の名前・ライセンス表記・インストーラ(`electron-builder.cjs`)・
 * 窓の題名(`electron.vite.config.ts` が index.html に入れる)がここから読む。
 *
 * - 名前・販売者はまだ仮(販売者は未定のため `TBD`)。決まったら `product.json` を直し、
 *   `package.json` の `author` も同じ値にする(試験 `tests/shared/product.test.ts` が食い違いを止める)
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
