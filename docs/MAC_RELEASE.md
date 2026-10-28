# Mac 版の出し方

方針(決定): **当面は Windows を先に出す。** Mac は「ビルドが通る・起動する」状態を保ち、出すと決めたら下の
署名・公証をする。

## 1. 今の状態

- `electron-builder.cjs` の `mac` の設定: 利用目的の文(書類・ダウンロード・デスクトップ・外付け・ネットワークの
  フォルダ。日本語と英語)、`build/entitlements.mac.plist`(JIT など Electron に要る権限)、`notarize: false`
- 窓は `titleBarStyle: hiddenInset`(信号のボタンの分を帯で空ける)
- メニュー: 先頭に製品名の欄(「VideoEditor について」「VideoEditor を隠す ⌘H」「ほかを隠す ⌥⌘H」「すべてを表示」
  「VideoEditor を終了 ⌘Q」)。キーの表示は ⌘ ⌥ ⇧
- 書き出しの GPU は NVIDIA の NVENC だけなので、Mac は CPU(x264)で書き出す。環境チェックは VideoToolbox を試す
- ローカル AI は node-llama-cpp が Metal を選ぶ(Apple Silicon は GPU と PC のメモリが共有。判定はそれを考える)
- 文字起こしは CPU

### このたび直したこと(Mac だけで困る所)

- **アプリの欄に「隠す」(⌘H)・「ほかを隠す」・「バージョン情報」が無かった**(「終了」だけ)。macOS の決まりの
  並びにした

### 見つけた注意(コードでは直していない)

- **ffmpeg の実行ファイルは、`npm install` をした Mac の CPU 用の 1 つだけ**(ffmpeg-static は install のときに
  その PC 用を取ってくる)。Intel の Mac で作った dmg を Apple Silicon で動かすと Rosetta 2 が要り、逆は動かない。
  **Apple Silicon 用と Intel 用は、それぞれの Mac で作る**(universal にはしない)。ffprobe(@derhuerst/ffprobe-static)も同じで、その Mac の CPU 用の 1 つだけ
- ffprobe(@derhuerst/ffprobe-static)は ffmpeg と同じリリースの同じビルド(docs/GPL_COMPLIANCE.md)。Mac の GPL のソース一式も Mac で
  `npm run gpl-sources` を走らせて作る

## 2. 確認の手順(Mac が 1 台あればできる)

```
npm ci
npm run build:unpack          # 署名なしで dist/mac*/VideoEditor.app を作る(配布の検査はしない)
open dist/mac-arm64/VideoEditor.app   # Intel の Mac は dist/mac/
```

起動する・素材を読み込める・書き出せる・ヘルプ > 環境チェック… が終わる、を確かめる。署名していないので、
ほかの Mac に渡すと「開発元を確認できない」で開けない(右クリック > 開く で開ける)。

## 3. 署名と公証(出すと決めたら)

Mac で配る(ダウンロードしたものを Gatekeeper に止められずに開ける)には、**Apple Developer Program への登録
(年 99 米ドル。日本では 12,980 円 前後。法人なら D-U-N-S 番号が要る)** と、Developer ID での署名・Apple の公証が要る。

1. 販売者の名義で Apple Developer Program に登録する(個人か法人か。法人は D-U-N-S 番号を先に取る)
2. Xcode か developer.apple.com で **Developer ID Application** の証明書を作り、ビルドする Mac のキーチェーンに入れる
   (`security find-identity -v -p codesigning` で「Developer ID Application: 名義 (TEAMID)」が出る)
3. 公証のための鍵を用意する。どちらか:
   - App Store Connect の API キー(推奨): `APPLE_API_KEY`(.p8 のパス)・`APPLE_API_KEY_ID`・`APPLE_API_ISSUER`
   - Apple ID: `APPLE_ID`・`APPLE_APP_SPECIFIC_PASSWORD`(アプリ用パスワード)・`APPLE_TEAM_ID`
4. `electron-builder.cjs` の `mac.notarize` を `true` にする(鍵は環境変数で渡し、リポジトリに入れない)。
   electron-builder は既定で hardened runtime を有効にし、アプリの中の実行ファイル・ネイティブの部品
   (ffmpeg・ffprobe・node-llama-cpp・onnxruntime・sharp)も同じ証明書で署名する
5. `npm run build:mac`(販売者・連絡先・ソースの入手先が決まっていないと止まる)
6. 確かめる:
   ```
   spctl -a -vvv -t install dist/VideoEditor-1.0.0.dmg          # accepted / source=Notarized Developer ID
   codesign --verify --deep --strict --verbose=2 dist/mac-arm64/VideoEditor.app
   xcrun stapler validate dist/VideoEditor-1.0.0.dmg
   ```
   別の Mac にダウンロードして(ブラウザ経由で隔離の印を付けて)開けること、書き出し(ffmpeg の起動)・
   ローカル AI(Metal)・文字起こし・顔の検出が動くことを確かめる。hardened runtime で ffmpeg などが起動できない・
   ネイティブの部品を読めないときは、`build/entitlements.mac.plist` の権限を見直す
   (`com.apple.security.cs.disable-library-validation` が要ることがある)

## 4. 持ち主の作業

- Mac 版を出す時期を決める(Windows の販売の後)
- 出すと決めたら: Apple Developer Program に登録(販売者の名義で)、証明書・公証の鍵を用意、上の 3. を行う
- Apple Silicon 用と Intel 用のどちらを出すか(両方なら 2 台の Mac で作る)
