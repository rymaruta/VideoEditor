import { describeBodyFailure, fetchJson } from './httpJson'
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
  const data = await fetchJson<JamendoResponse>(
    `https://api.jamendo.com/v3.0/tracks/?${params.toString()}`,
    undefined,
    'Jamendo API'
  )
  // Jamendo は失敗しても HTTP 200 を返し、本文の `headers.status` にだけ書く。
  if (data.headers?.status === 'failed') {
    throw new Error(describeBodyFailure('Jamendo API', data.headers?.error_message))
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
  const data = await fetchJson<FreesoundResponse>(
    `https://freesound.org/apiv2/search/text/?${params.toString()}`,
    undefined,
    'Freesound API'
  )
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
