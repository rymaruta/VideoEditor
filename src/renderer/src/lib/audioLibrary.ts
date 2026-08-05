import { readJsonResponse } from './httpJson'
export interface MusicTrackInfo {
  id: string
  title: string
  artistName: string
  durationSeconds: number
  audioUrl: string
  licenseUrl: string
}

export interface SoundEffectInfo {
  id: string
  name: string
  durationSeconds: number
  previewUrl: string
  username: string
  licenseUrl: string
}

interface JamendoTrack {
  id: string
  name: string
  artist_name: string
  duration: number
  audio: string
  audiodownload: string
  audiodownload_allowed: boolean
  license_ccurl: string
}

interface JamendoResponse {
  headers?: { status: string; error_message?: string }
  results?: JamendoTrack[]
}

export async function searchJamendoMusic(
  clientId: string,
  query: string
): Promise<MusicTrackInfo[]> {
  const params = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    limit: '20',
    audioformat: 'mp32',
    namesearch: query
  })
  const res = await fetch(`https://api.jamendo.com/v3.0/tracks/?${params.toString()}`)
  const data = await readJsonResponse<JamendoResponse>(res, 'Jamendo API')
  if (!res.ok || data.headers?.status === 'failed') {
    throw new Error(data.headers?.error_message ?? 'Jamendo API エラー')
  }
  return (data.results ?? []).map((t) => ({
    id: t.id,
    title: t.name,
    artistName: t.artist_name,
    durationSeconds: t.duration,
    audioUrl: t.audiodownload_allowed && t.audiodownload ? t.audiodownload : t.audio,
    licenseUrl: t.license_ccurl
  }))
}

interface FreesoundResult {
  id: number
  name: string
  duration: number
  previews: { 'preview-hq-mp3'?: string; 'preview-lq-mp3'?: string }
  username: string
  license: string
}

interface FreesoundResponse {
  results?: FreesoundResult[]
  detail?: string
}

export async function searchFreesoundEffects(
  apiKey: string,
  query: string
): Promise<SoundEffectInfo[]> {
  const params = new URLSearchParams({
    query,
    fields: 'id,name,duration,previews,username,license',
    filter: 'duration:[0.1 TO 20]',
    page_size: '20',
    token: apiKey
  })
  const res = await fetch(`https://freesound.org/apiv2/search/text/?${params.toString()}`)
  const data = await readJsonResponse<FreesoundResponse>(res, 'Freesound API')
  if (!res.ok) throw new Error(data.detail ?? 'Freesound API エラー')
  return (data.results ?? [])
    .filter((r) => r.previews?.['preview-hq-mp3'] || r.previews?.['preview-lq-mp3'])
    .map((r) => ({
      id: String(r.id),
      name: r.name,
      durationSeconds: r.duration,
      previewUrl: (r.previews['preview-hq-mp3'] ?? r.previews['preview-lq-mp3']) as string,
      username: r.username,
      licenseUrl: r.license
    }))
}
