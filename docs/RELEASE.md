# 正式版を出す手順(Windows)

持ち主が、利用者に配る正式版を GitHub の Releases(https://github.com/rymaruta/VideoEditor/releases)に出す手順。
作るのは GitHub Actions のワークフロー `.github/workflows/release.yml` で、手元の PC でビルドする必要はない。

## 1. 出し方

1. **版を上げる**: `package.json` の `version` を新しい版にしてコミットする(例: `1.0.0` → `1.1.0`)。
   版は `1.2.3` の形。`1.3.0-beta.1` のように `-` を付けるとプレリリースになり、自動更新では正式版の利用者に配らない
2. **タグを付けて push する**: タグの名前は `v` + 版(`package.json` が `1.1.0` なら `v1.1.0`)

   ```bash
   git commit -am "1.1.0"
   git tag v1.1.0
   git push origin HEAD
   git push origin v1.1.0
   ```

3. **Release ができる**: タグを push すると Actions の「Release (Windows)」が走り(40〜60 分)、通れば
   `v1.1.0` の Release が公開される。中身は
   - `VideoEditor-1.1.0-setup.exe` … 正式のインストーラ
   - `VideoEditor-1.1.0-setup.exe.blockmap`・`latest.yml` … 自動更新が読む(消さない)
   - `VideoEditor-1.1.0-ffmpeg-<版>-win32-x64-sources.tar` と `.sha256` … 同梱の FFmpeg / FFprobe(GPL)の対応するソース一式
     (docs/GPL_COMPLIANCE.md。**インストーラを置いている間は消さない**)
4. 公開されると、正式版を入れている利用者のアプリは次に起動したときに(その後は 6 時間ごとに)新しい版を見つけ、
   裏でダウンロードし、「再起動して更新」か、次に終了したときに入れ替わる

### ワークフローの中身

| ジョブ  | すること                                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gates   | タグのコミットで lint・typecheck・試験                                                                                                                                                                                                    |
| build   | タグと `package.json` の version の照合 → `npm run release-check`(販売者・ソースの入手先)→ `npm run gpl-sources`(ソース一式をネットから集める)→ 正式のインストーラ → 作ったアプリを起動して確かめる(煙の試験)→ 置く物が揃っているかの確認 |
| publish | 上の 2 つが通ったときだけ。Release を下書きで作って全部を置き、最後に公開する。`contents: write` はこのジョブだけ                                                                                                                         |

止まるとき(Release は作られない)

- タグと `package.json` の version が食い違う(例: `v1.1.0` に `1.0.0`)→ version を直してコミットし、タグを付け直す
  (`git tag -d v1.1.0 && git push origin :refs/tags/v1.1.0` で消してから付け直す)
- GPL のソースを取れない(ffmpeg.org などが落ちている・入手先を決められない部品がある)→ ソースの無い Release は出さない。
  時間をおいて、Actions の画面から「Re-run jobs」でやり直す
- 起動の試験が通らない(下の 3)
- その版の Release がもう公開されている → 上書きしない。版を上げて新しいタグで出す
  (前の失敗で残った下書きは、やり直したときに作り直す)

### 手で走らせる(workflow_dispatch)

Actions の「Release (Windows)」→「Run workflow」で、出すタグ(push 済みのもの)を入れて走らせる。
「dry_run」に印を付けると Release は作らず、作った物を Actions の Artifacts(`VideoEditor-release-<タグ>`)に置くだけになる
(手順を試すとき)。

## 2. 署名(Secrets)

リポジトリの Settings > Secrets and variables > Actions に次の 2 つを入れると、正式版も持ち主が試す版も署名して作る。
無ければ署名せずに作り、ワークフローに警告を出す(利用者の PC で SmartScreen の警告が出る)。

| Secret                 | 中身                                           |
| ---------------------- | ---------------------------------------------- |
| `WIN_CSC_LINK`         | コード署名の証明書(.pfx)を base64 にした文字列 |
| `WIN_CSC_KEY_PASSWORD` | その .pfx のパスワード                         |

証明書の選び方(ハードウェアの鍵・クラウドの署名サービスの場合)は docs/WINDOWS_SIGNING.md。

- 自動更新は、ダウンロードした新しい版のインストーラの署名の発行元が、入っている版と同じかを確かめる
  (electron-updater)。**署名した版を一度出したら、その後も同じ名義の証明書で署名し続ける**。
  名義が変わると、それまでの利用者には自動更新が届かなくなる(新しいインストーラを手で入れてもらう)
- 署名していない版から署名した版への更新は届く

## 3. 起動の試験(煙の試験)

`scripts/smoke-electron.mjs` が、作った `dist/win-unpacked/VideoEditor.exe` を Playwright(`playwright-core` の
`_electron`。ブラウザは落とさない)で起動し、次を確かめる。どれかが駄目ならジョブが落ちる。

- 最初の窓が出て、上の帯の「書き出す」ボタンが描かれる。ページのエラーが無い
- 製品に部品が入っている(ffmpeg・ffprobe・onnxruntime と DirectML の DLL・ライセンスの表記)。
  正式版は `resources/app-update.yml` が GitHub の Releases を指し、持ち主が試す版には無い
- 環境チェック(ヘルプ > 環境チェック と同じ main の処理): ffmpeg で CPU の試し書き出しができる・onnxruntime を
  読める(Windows は DirectML も)・node-llama-cpp を読める
- 同梱の ffmpeg で作った 1 秒の動画を、アプリの probeMedia(同梱の ffprobe)で読める

画面の写真(`main-window.png`)・環境チェックの結果(`env-check.json`)・記録(`smoke.log`・`app-output.log`)は
Actions の Artifacts(正式版は `VideoEditor-release-smoke-<タグ>`、持ち主が試す版は `VideoEditor-windows-smoke-<コミット>`)に置く。

手元(Linux・macOS でも)で試すとき:

```bash
npx electron-vite build
node scripts/smoke-electron.mjs --dev --out smoke              # out/ を node_modules の Electron で
node scripts/smoke-electron.mjs --exe dist/win-unpacked/VideoEditor.exe --build personal --out smoke
```

Linux の画面の無い環境では `xvfb-run -a` を前に付ける。

## 4. 持ち主が試す版(personal)と正式版の違い

|                                 | 持ち主が試す版                                                                                     | 正式版                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 作るワークフロー                | `windows-release-gates.yml` の package(PR・作業ブランチの push のたび)                             | `release.yml`(`v*` のタグの push)            |
| 置き場                          | Actions の Artifacts(14 日で消える。配布しない)                                                    | GitHub の Releases(公開)                     |
| インストーラの名前              | `VideoEditor-<版>-personal-setup.exe`(と展開したフォルダ)                                          | `VideoEditor-<版>-setup.exe`                 |
| 販売者などの検査(release-check) | しない                                                                                             | する                                         |
| GPL のソース一式                | 作らない                                                                                           | 作って同じ Release に置く                    |
| 自動更新                        | **しない**(更新の行き先 `app-update.yml` を入れず、印を `personal` にする。正式版で置き換わらない) | する(Releases の `latest.yml` を見る)        |
| 起動の試験                      | 展開したフォルダで走らせる                                                                         | インストーラと一緒にできたフォルダで走らせる |

- どちらも同じアプリ(同じ appId)なので、同じ PC に入れると後から入れた方で置き換わる。持ち主が試す版を入れた PC で
  正式版の自動更新を試したいときは、正式版のインストーラを入れ直す
- 仕組み: `VE_PERSONAL_BUILD=1` で electron-builder を走らせると、`electron-builder.cjs` が `publish` を外し、
  製品の `package.json` に `"videoEditorBuild": "personal"` を書く(正式版は `"release"`)。アプリ(`src/main/autoUpdate.ts`)は
  `release` の印があり、Windows で、インストールした物のときだけ更新を確かめる。開発中(`npm run dev`)・macOS・Linux は確かめない。
  環境変数 `VE_DISABLE_AUTO_UPDATE=1` でも止められる(起動の試験はこれで止める)
- 手元で `npm run build:win` すると正式版の印の物ができる(自動更新もする)。手元で試すだけなら
  `VE_PERSONAL_BUILD=1` を付けるか、`npm run build:win:test`(展開したフォルダだけ。自動更新の行き先が入らない)を使う

## 5. 出した後に確かめること

- Release のページに 5 つのファイル(インストーラ・blockmap・latest.yml・ソース一式・その .sha256)があること
- 前の正式版を入れた PC で起動し、しばらく待つと「新しい版(…)の準備ができました」が出ること(初めての版では確かめられない)
- ヘルプ > バージョン情報 の「ソースの入手方法」から Releases が開くこと
