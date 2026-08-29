import { app } from 'electron'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import dotenv from 'dotenv'
import type { EnvApiKeys } from '@shared/types'

function candidateEnvPaths(): string[] {
  const paths = [join(process.cwd(), '.env')]
  if (app.isPackaged) {
    // AppImage は起動のたびに **/tmp へ展開して**そこから動くので、`exe` の隣は
    // 展開先(`/tmp/appimage_extracted_.../`)であって、利用者が本体を置いた場所ではない。
    // README は「アプリ実行ファイルと同じフォルダに .env」と案内しているのに、
    // Linux の配布版だけ**その置き方が効かない**(実測: .AppImage の隣に
    // `GEMINI_API_KEY=...` を置いて起動しても、読み込まれたキーは4つとも空)。
    // AppImage は本体のパスを `$APPIMAGE` で教えてくれるので、そこを先に見る。
    const appImagePath = process.env.APPIMAGE
    if (appImagePath) paths.push(join(dirname(appImagePath), '.env'))
    const exeDir = dirname(app.getPath('exe'))
    paths.push(join(exeDir, '.env'))
    // macOS の `exe` は `VideoEditor.app/Contents/MacOS/` の中。利用者から見た
    // 「アプリと同じフォルダ」は **.app の隣**なので、そちらも候補にする。
    if (process.platform === 'darwin') paths.push(join(exeDir, '..', '..', '..', '.env'))
  }
  paths.push(join(app.getPath('userData'), '.env'))
  return paths
}

export function loadEnvFile(): void {
  for (const path of candidateEnvPaths()) {
    if (existsSync(path)) {
      dotenv.config({ path })
      return
    }
  }
}

export function getEnvApiKeys(): EnvApiKeys {
  return {
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    youtubeApiKey: process.env.YOUTUBE_API_KEY ?? '',
    jamendoClientId: process.env.JAMENDO_CLIENT_ID ?? '',
    freesoundApiKey: process.env.FREESOUND_API_KEY ?? ''
  }
}
