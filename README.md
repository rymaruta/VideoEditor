# VideoEditor

YouTubeショート動画向けの動画編集デスクトップアプリ(Electron + React + TypeScript)。

## 主な機能

- 動画インポート・メタデータ取得・サムネイル生成
- タイムライン編集(トリム・カット・並び替え・削除)
- プレビュー再生(9:16 / 16:9 アスペクト比切替対応)
- テキスト/字幕オーバーレイ(位置・色・太字・縁取り)
- ショート動画のトレンド構成テンプレート(フック→本編→CTA、ジャンプカット等の定番パターンを自動適用)
- YouTube Data API(公式)によるトレンド・キーワード調査(メタデータ表示のみ、動画のダウンロードは行いません)
- 長尺(2時間級)ソース動画にも対応した書き出し(ffmpegによるカット済みクリップのみを処理)

## 使い方

1. 「メディア」から動画ファイルを追加
2. 「タイムラインに追加」でクリップを配置し、トリム・カット・並び替えで編集
3. 右パネルの「テンプレート」でショート動画の構成を適用、「テキスト」で字幕を編集
4. 「書き出し」でアスペクト比・解像度を選び、書き出し

YouTubeトレンド調査を使うには、右パネルの「YouTube」タブで [Google Cloud Console](https://console.cloud.google.com/) で発行した YouTube Data API v3 のAPIキーを入力してください。

## Project Setup

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
# For windows
npm run build:win

# For macOS
npm run build:mac

# For Linux
npm run build:linux
```

## 注意事項

- 字幕の焼き込みには `libass`(ffmpeg同梱)を使用しています。システムに日本語フォントが入っていない環境では字幕が正しく表示されない場合があります。
- YouTube関連機能は公式APIのみを使用し、動画・音声のダウンロードやスクレイピングは行いません。
