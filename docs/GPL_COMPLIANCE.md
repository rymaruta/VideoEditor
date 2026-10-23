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
  2. **書面による申し出**: 同じ文書に、**最後の配布から 3 年間**、同梱した ffmpeg と同じ版の完全なソースを
     提供する申し出を載せる。宛先は `src/shared/product.json` の `vendorEmail`、入手先は同じファイルの
     `sourceOfferUrl`
  3. **対応するソース一式**: `npm run gpl-sources` が、同梱した実行ファイルと同じ版の FFmpeg 本体と、
     ビルドに使われた GPL のライブラリ(x264・x265・xvid・rubberband・frei0r・vid.stab)のソースを集め、
     取得元と SHA-256 を記録した 1 つのアーカイブにする。これを `sourceOfferUrl` に置く
- アプリの中では、**ヘルプ > バージョン情報** から
  - 「オープンソースの表記…」(THIRD_PARTY_NOTICES.txt を開く。ヘルプ > オープンソースの表記 も同じ)
  - 「ソースの入手方法」(申し出の文・入手先・連絡先。入手先が決まっていれば「入手先を開く」)
  が見られる。

## 2. 配布用のビルドの検査

`vendor`・`vendorEmail`・`sourceOfferUrl` が未定(`TBD`・空・`example.*` の宛先)のままでは、配布用のビルドが止まる
(`scripts/release-check.cjs`)。

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

Windows の ffmpeg-static(b6.1.1)の実行ファイルは gyan.dev のビルド(この開発環境では Windows 版を動かせないので未確認)。
gyan.dev のビルドのページ・同梱の説明にライブラリの版があるはずなので確かめ、Windows で `npm run gpl-sources -- --dry-run` を走らせ、「入手先を決められません」と出た
部品は gyan.dev の一覧の版で `--source` を与える。

### 静的にリンクされた GPL 以外のライブラリ

同梱の ffmpeg は libaom・libvpx・opus・gnutls などの GPL 以外(LGPL・BSD など)のライブラリも静的にリンクしている。
GPL の「対応するソース」は実行ファイル全体のソースを指すので、これらも求められたら出せるようにしておくのが安全
(`MANIFEST.txt` に版を記録してある)。より確実にするなら、ソース一式を自分で用意できるビルド(自前で ffmpeg を
ビルドする・ソースを公開しているビルド元を使う)に切り替える。**法的な判断は専門家に確認すること。**

## 4. 持ち主の作業

1. 販売者の名義・連絡先を決め、`src/shared/product.json` の `vendor`・`vendorEmail` と `package.json` の `author` を直す
2. ソースを置く URL を決め(https。最後の配布から 3 年以上置き続けられる場所)、`product.json` の `sourceOfferUrl` に入れる
3. 上の「取れなかったもの」を片付ける(vid.stab の版、ffprobe を揃えるか)
4. 配布する OS ごとに `npm run gpl-sources` を走らせ、できたアーカイブと `.sha256` を `sourceOfferUrl` に置く
   (製品の版・ffmpeg の版ごとに残す。古い版も最後の配布から 3 年は消さない)
5. `npm run build:win` で配布用のインストーラを作り、ヘルプ > バージョン情報 の「ソースの入手方法」に入手先と連絡先が出ること、
   「入手先を開く」で置いた場所が開くことを確かめる
6. 媒体での請求(メール)が来たら応じられる体制にしておく(実費のみ)
