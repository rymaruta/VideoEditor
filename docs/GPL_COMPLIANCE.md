# FFmpeg の GPL への対応

持ち主が決めた方針と、配布の前に持ち主がする作業。

## 1. 方針(決定)

- 動画・音声の読み書きには、GPL の **ffmpeg / ffprobe の実行ファイル**(npm の `ffmpeg-static`・`ffprobe-static`)を
  **アプリとは別の実行ファイルとして同梱し、別のプロセスとして呼び出す**(集合物。アプリ本体のコードは GPL にしない)。
  - アプリは ffmpeg を `child_process` で起動して引数を渡すだけで、ffmpeg のライブラリをリンクしない
  - 実行ファイルには手を加えない(配られたものをそのまま入れる)。利用者はインストール先の
    `resources/app.asar.unpacked/node_modules/ffmpeg-static/` の ffmpeg を差し替えられる
- その上で GPL の義務を満たす:
  1. **表記**: `resources/THIRD_PARTY_NOTICES.txt`(ビルドのたびに `npm run licenses` が作る)に、GPL の全文・
     同梱した ffmpeg / ffprobe の版とビルドの設定(`-version` の出力と ffmpeg-static の README)を載せる
  2. **バイナリと同じ場所からのソースの提供**(2026-10-28 に持ち主が決定): インストーラを配る公開の GitHub の
     Releases(`src/shared/product.json` の `sourceOfferUrl` = https://github.com/rymaruta/VideoEditor/releases)の
     **各版のリリースに、その版の対応するソース一式を一緒に置く**。GPLv3 の 6 条 d(「指定した場所からの
     アクセスで目的コードを渡すとき、同じ場所から同じ方法で、追加の費用なしに対応するソースへのアクセスを
     提供する」)・GPLv2 の 3 条の最後の段落(「指定した場所から写す手段で実行形式を配るとき、同じ場所から
     ソースを写す手段を用意すれば、ソースの配布とみなす」)の形。表記の文書とバージョン情報には、
     入手先の URL だけを案内する文を載せる:
     「同梱の FFmpeg の対応するソース一式は、<URL> の各版のリリースから入手できます(版ごとに置いています)」
     - この形では、**書面による申し出(3 年間・媒体での請求)は要らない**ので、連絡先のメール(`vendorEmail`)は
       使わない(空文字)。代わりに、**その版のインストーラを Releases に置いている間は、同じリリースのソース一式を
       消さない**(GPLv3 6 条 d の「目的コードを提供している間は」)
     - ソースはインストーラと同じリリースに置く(別の場所に置くときは、インストーラの横に入手先をはっきり書く)
     - **GitHub の Releases 以外(ストア・販売サイト・メディアなど)で配るときは、この形にはならない。**
       その場所にもソース一式を同じように置くか、連絡先を決めて `vendorEmail` に入れ、書面による申し出を出す
     - `vendorEmail` を入れた場合は、表記の文書とバージョン情報に、**最後の配布から 3 年間**のソースの提供と
       媒体での請求の宛先を書いた**書面による申し出**(GPLv3 6 条 b・GPLv2 3 条 b)も自動で載る
  3. **対応するソース一式**: `npm run gpl-sources` が、同梱した実行ファイルと同じ版の FFmpeg 本体と、
     ビルドに使われた GPL のライブラリ(x264・x265・xvid・rubberband・frei0r・vid.stab)のソースを集め、
     取得元と SHA-256 を記録した 1 つのアーカイブにする。これを、同じ版のインストーラと同じ Releases の
     リリースに置く
- アプリの中では、**ヘルプ > バージョン情報** から
  - 「オープンソースの表記…」(THIRD_PARTY_NOTICES.txt を開く。ヘルプ > オープンソースの表記 も同じ)
  - 「ソースの入手方法」(入手先の URL の案内。連絡先があれば書面による申し出も。入手先が決まっていれば「入手先を開く」)
  が見られる。

## 2. 配布用のビルドの検査

`vendor`・`sourceOfferUrl` が未定(`TBD`・空・`example.*` の宛先)のままでは、配布用のビルドが止まる
(`scripts/release-check.cjs`)。`sourceOfferUrl` は https の URL でないと止まる。

連絡先の `vendorEmail` は任意で、空・未定でも止めない(上の 2 の形でソースを配るため)。ただし、何か書いてあるのに
メールの宛先の形でなければ止める(書面による申し出の宛先になるため)。linux のパッケージの maintainer は、連絡先が
無ければ `product.json` の `homepage` を使う(`VideoEditor <https://github.com/rymaruta/VideoEditor>`)。

| コマンド | 検査 | 用途 |
| --- | --- | --- |
| `npm run build:win` / `build:mac` / `build:linux` | する(最初に止まる) | 配布するインストーラ |
| `electron-builder`(--dir 以外の出力)を直接 | する(`beforePack` で止まる) | 同上 |
| `npm run build` / `build:unpack` / `build:win:test` | しない | 開発・社内の確認 |

`npm run release-check` で、今の値で配布できるかだけを確かめられる。

## 3. ソース一式の作り方(`npm run gpl-sources`)

**配布するインストーラを作るのと同じ OS・同じ `node_modules` で走らせる。** ffmpeg-static は npm install のときに
その OS 用の実行ファイルを取ってくるので、Windows 版のソースは Windows で作る。

```
npm ci
npm run gpl-sources -- --dry-run      # 集める物と取得元の一覧だけ(ダウンロードしない)
npm run gpl-sources                   # dist/gpl-sources/ にアーカイブを作る
```

- 実行ファイルを動かして、版・ビルドの設定・x264 の版の印(1 コマだけ書いて読む)を確かめ、ffmpeg-static の README
  からライブラリの版を読む
- 出力: `dist/gpl-sources/<製品名>-<版>-ffmpeg-<ffmpeg の版>-<OS>-<CPU>-sources.tar` と `.sha256`。
  中に `sources/`(各ソース)・`MANIFEST.txt`(部品ごとの版・ライセンス・取得元・SHA-256、GPL 以外のライブラリの一覧)・
  `manifest.json`・`ffmpeg-version.txt`・`ffprobe-version.txt`・`ffmpeg.README.txt`・`COPYING.GPLv3.txt`
- 取ってきた物がアーカイブでない(案内のページなど)と止まる。Debian のパッケージの版(frei0r の `1.6.1-2` など)は
  snapshot.debian.org から元の版と Debian の変更の両方を取り、SHA-1 を照らし合わせる
- 入手先を自動で決められない部品が残ると止まる。入手先が分かれば `--source <id>=<url>` で与える
  (`--allow-missing` は確かめるだけ。そのアーカイブは配布に使わない)

### 2026-10-23 にこの開発環境(Linux x64)で 1 度走らせた結果

`npm run gpl-sources -- --allow-missing` で 23.0 MB のアーカイブができた。取れたもの:

| 部品 | 版 | 取得元 |
| --- | --- | --- |
| FFmpeg(ffmpeg 用) | 7.0.2 | https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz |
| x264 | core 164 r3191 4613ac3 | code.videolan.org の 4613ac3 の snapshot |
| x265 | 3.5+1-f0c1022b6 | bitbucket.org/multicoreware/x265_git の f0c1022b6 |
| xvid | 1.3.7 | downloads.xvid.com |
| rubberband | 1.8.2 | breakfastquay.com |
| frei0r | 1.6.1-2(Debian) | snapshot.debian.org(orig + debian.tar.xz) |
| FFmpeg(ffprobe 用) | 4.0.2 | https://ffmpeg.org/releases/ffmpeg-4.0.2.tar.xz |

**取れなかったもの(配布の前に片付ける):**

- **vid.stab**: Linux 版のビルド(John Van Sickle)の README の版は `1.20` で、vid.stab のタグと対応しない。
  ビルドした人に版を問い合わせて `--source vidstab=<url>` で与える
- **ffprobe の GPL のライブラリ一式**: `ffprobe-static` の ffprobe は **ffmpeg とは別のビルド**(Linux 版は 4.0.2、
  2018 年)で、ライブラリの版を示す README が無い。x264 などの版を決められない
  → **推奨**: ffprobe を ffmpeg と同じビルドのもの(ffmpeg-static の同じリリースが配る ffprobe)に揃える。
  そうすれば 1 組のソースで両方を賄え、ffprobe 4.0.2 という古い版も無くなる(コードの変更が要るので、持ち主が決める)

### Windows 版について

Windows の ffmpeg-static(b6.1.1)の実行ファイルは gyan.dev のビルド(`6.1.1-essentials_build-www.gyan.dev`、
ソースは FFmpeg の e38092ef93 = 6.1.1)。

- ffmpeg-static の install.js は README・LICENSE を「実行ファイルのパス + `.README` / `.LICENSE`」に落とすので、
  Windows では **`ffmpeg.exe.README`・`ffmpeg.exe.LICENSE`**(ほかの OS は `ffmpeg.README`・`ffmpeg.LICENSE`)。
  表記(`npm run licenses`)と `npm run gpl-sources` はどちらの名前も探す。LICENSE が落とせなかったときは、
  リポジトリの `scripts/license-texts/GPL-3.0.txt`(FSF の GPL v3 の全文)を使う(`--enable-version3` のビルドに限る)
- gyan.dev の README のライブラリの版は「`x265 3.5-153-gce8642f22`」の並び(`external libraries' versions:` の下)。
  これも読み、x265・vid.stab の git describe の形の版はそのコミットのソースを取る
  (b6.1.1 の Windows 版: x265 `ce8642f22`・vid.stab `05829db`・xvid 1.3.7・rubberband 1.8.1。x264 は版の印から)
- 配布の前に、Windows で `npm run gpl-sources -- --dry-run` を走らせて「入手先を決められません」が無いことを確かめる

### 静的にリンクされた GPL 以外のライブラリ

同梱の ffmpeg は libaom・libvpx・opus・gnutls などの GPL 以外(LGPL・BSD など)のライブラリも静的にリンクしている。
GPL の「対応するソース」は実行ファイル全体のソースを指すので、これらも求められたら出せるようにしておくのが安全
(`MANIFEST.txt` に版を記録してある)。より確実にするなら、ソース一式を自分で用意できるビルド(自前で ffmpeg を
ビルドする・ソースを公開しているビルド元を使う)に切り替える。**法的な判断は専門家に確認すること。**

## 4. 持ち主の作業

1. 販売者の名義(`src/shared/product.json` の `vendor` と `package.json` の `author`)は `VideoEditor`、
   ソースの入手先(`sourceOfferUrl`)は https://github.com/rymaruta/VideoEditor/releases、連絡先(`vendorEmail`)は
   使わない(空文字。`package.json` の `author` にも email を置かない)。2026-10-28 に決定済み
2. 上の「取れなかったもの」を片付ける(vid.stab の版、ffprobe を揃えるか)
3. 配布する OS ごとに `npm run gpl-sources` を走らせ、できたアーカイブと `.sha256` を、**同じ版のインストーラと同じ
   GitHub の Releases のリリース**に置く(製品の版・ffmpeg の版ごとに。インストーラを置いている間はソースも消さない)
4. `npm run build:win` で配布用のインストーラを作り、ヘルプ > バージョン情報 の「ソースの入手方法」に入手先の URL が出ること、
   「入手先を開く」で Releases が開くことを確かめる
5. GitHub の Releases 以外で配ることにしたら、「1. 方針」の 2 に戻って方式を決め直す(その場所にもソースを置くか、
   連絡先を決めて書面による申し出を出す)
