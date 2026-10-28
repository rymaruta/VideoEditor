# Windows のコード署名

署名すると、起動時の「Windows によって PC が保護されました」(SmartScreen)の警告が減り、
発行元に販売者名(product.json の vendor)が表示されます。

## 持ち主の作業

1. コード署名の証明書を用意する(どれか1つ)
   - **OV(組織認証)コード署名証明書**: 認証局(Sectigo・DigiCert・GlobalSign など)から購入。
     2023 年 6 月以降、秘密鍵はハードウェア(USB トークンかクラウドの HSM)に置くことが必須になった。
     .pfx ファイルを CI に置く方式は、クラウドの HSM の署名サービスを使う形に置き換える必要がある
   - **EV コード署名証明書**: OV と同じくハードウェアに鍵を置く。SmartScreen の評価が最初から付きやすい
   - **Microsoft の Trusted Signing(Azure の署名サービス)**: 月額の安い署名サービス。
     利用できる国・個人か法人かの条件があるので、申し込み前に Microsoft の案内で確認する
   - 名義は販売者(法人か個人事業)の正式な名前にする。product.json の vendor も同じ名前にそろえる
2. 署名の方法が決まったら、CI(.github/workflows/windows-release-gates.yml の package と、正式版の
   .github/workflows/release.yml。docs/RELEASE.md)に組み込む
   - .pfx を使える場合: リポジトリの Settings > Secrets and variables > Actions に
     `WIN_CSC_LINK`(.pfx を base64 にした文字列)と `WIN_CSC_KEY_PASSWORD` を入れるだけで、次のビルドから署名される
   - クラウドの HSM や Azure の署名サービスの場合: electron-builder の `win.signtoolOptions` / `azureSignOptions`
     を設定する(使うサービスが決まったら組み込む)

## 署名しないとき

ビルドは署名なしで続く。初回の起動で「詳細情報」→「実行」を押せば起動できる(持ち主の PC で試す版)。
