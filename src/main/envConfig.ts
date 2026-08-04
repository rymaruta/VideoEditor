import { app } from 'electron'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import dotenv from 'dotenv'
import type { EnvApiKeys } from '@shared/types'

function candidateEnvPaths(): string[] {
  const paths = [join(process.cwd(), '.env')]
  if (app.isPackaged) {
    paths.push(join(dirname(app.getPath('exe')), '.env'))
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
