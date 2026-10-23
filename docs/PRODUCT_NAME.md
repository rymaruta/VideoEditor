# 製品名「Tsunagi」

## 決定

- 製品名は **Tsunagi**(つなぎ)。収録をつないで番組にする、の意味
- 名前は `src/shared/product.json` の `name` の 1 か所で決める。メニュー・窓の題名・バージョン情報・
  インストーラ(`Tsunagi-<版>-setup.exe`・`Tsunagi.exe`)・ライセンスの表記・保存するファイルの名前がここから読む
  (コードに名前を直書きしない。試験 `tests/shared/product.test.ts` が止める)
- **変えないもの**: `appId`(`com.videoeditor.app`)と `package.json` の `name`(`video-editor`)。
  appId は Windows のタスクバー・通知・インストール済みの識別に、package.json の name は設定・自動保存の置き場
  (userData)に使われ、変えると別のアプリになる・前の設定が見えなくなる

## 持ち主の作業: 商標の調査

正式に売る前に、名前が使えるかを確かめる(この作業はコードではできない)。

1. **J-PlatPat**(https://www.j-platpat.inpit.go.jp/)の「商標」で調べる
   - 文字: 「Tsunagi」「TSUNAGI」「つなぎ」「ツナギ」「繋ぎ」(称呼検索で「ツナギ」も)
   - 区分: **第 9 類**(ダウンロード可能なコンピュータプログラム)、**第 42 類**(ソフトウェアの提供・SaaS)。
     動画の編集の役務として **第 41 類** も見る
   - 似た称呼(「ツナギー」「ツナグ」など)も見る
2. 海外でも売るなら、WIPO の Global Brand Database(https://branddb.wipo.int/)・米国 USPTO で同じように
3. ほかのソフト・サービスの名前(アプリストア・Web の検索・ドメイン `tsunagi.*` の空き)を見る
4. 迷う結果があれば弁理士に相談する。出すなら第 9 類・第 42 類で出願する(販売者の名義が決まってから)
5. 使えないと分かったら、`product.json` の `name` を変える(上の「変えないもの」以外は全部ついてくる)。
   README の見出しと docs の書き方は手で直す
