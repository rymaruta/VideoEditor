import { asArray, describeBodyFailure, fetchJson } from './httpJson'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

/**
 * 一覧の1件を、画面が前提にしている形へ直す。
 *
 * **使えない1件で一覧を全滅させない。** 型定義で必須にしていても tsc は実際の応答を
 * 守ってくれないので、`t.id` のような素の読み取りは `null` が1件混ざるだけで
 * `.map()` の外まで例外が飛び、**残りの曲もろとも消えて生の英語が画面に出る**。
 * (実測: 3件のうち1件を `null` にすると、Jamendo は
 *  `Cannot read properties of null (reading 'id')`、Freesound は同 `(reading 'previews')` が
 *  画面に出て**1件も表示されなくなった**。同じ形の YouTube は先に直してあり、
 *  使える2件をそのまま並べていた)
 *
 * 捨てるのは**指す手段が無いもの**(オブジェクトでない・`id` が無い)だけ。
 * 項目が欠けているだけのものは空文字・0 に直して残す——落とすと利用者からは
 * 「検索結果が黙って減った」ようにしか見えない。
 */
function toMusicTrack(raw: unknown): MusicTrackInfo | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : ''
  if (!id) return null
  const download = asText(raw.audiodownload)
  return {
    id,
    title: asText(raw.name),
    artistName: asText(raw.artist_name),
    durationSeconds: asSeconds(raw.duration),
    // 落とせるなら落とし版、駄目なら試聴用のストリーム(元の規則のまま)
    audioUrl: raw.audiodownload_allowed === true && download ? download : asText(raw.audio),
    licenseUrl: asText(raw.license_ccurl)
  }
}

/** 効果音の1件。試聴URLが無いものは元から一覧に出していないので、そこは変えない。 */
function toSoundEffect(raw: unknown): SoundEffectInfo | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : ''
  if (!id) return null
  const previews = isRecord(raw.previews) ? raw.previews : {}
  const previewUrl = asText(previews['preview-hq-mp3']) || asText(previews['preview-lq-mp3'])
  if (!previewUrl) return null
  return {
    id,
    name: asText(raw.name),
    durationSeconds: asSeconds(raw.duration),
    previewUrl,
    username: asText(raw.username),
    licenseUrl: asText(raw.license)
  }
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
  return asArray(data.results).map(toMusicTrack).filter(isPresent)
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
  return asArray(data.results).map(toSoundEffect).filter(isPresent)
}
