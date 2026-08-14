import { asArray, fetchJson } from './httpJson'
export interface YouTubeVideoInfo {
  id: string
  title: string
  channelTitle: string
  thumbnailUrl: string
  durationSeconds: number
  viewCount: number
  publishedAt: string
}

interface ApiThumbnails {
  default?: { url: string }
  medium?: { url: string }
}

interface ApiSnippet {
  title: string
  channelTitle: string
  publishedAt?: string
  thumbnails?: ApiThumbnails
}

interface VideosListItem {
  id: string
  // snippet / contentDetails are only present when the API actually returned that
  // part for this video; typing them as required hid the crash below from tsc.
  snippet?: ApiSnippet
  contentDetails?: { duration: string }
  statistics?: { viewCount?: string }
}

interface SearchListItem {
  id?: { videoId?: string }
  snippet?: ApiSnippet
}

interface ApiError {
  error?: { message?: string }
}

function parseIsoDuration(iso: string): number {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso)
  if (!match) return 0
  const h = Number(match[1] ?? 0)
  const m = Number(match[2] ?? 0)
  const s = Number(match[3] ?? 0)
  return h * 3600 + m * 60 + s
}

function pickThumbnail(thumbnails: ApiThumbnails | undefined): string {
  return thumbnails?.medium?.url ?? thumbnails?.default?.url ?? ''
}

// The API omits parts for videos that went private or were deleted between the chart
// query and the response, and `items` can carry nulls. Reading `item.snippet.title`
// straight off such an entry threw "Cannot read properties of undefined", and because
// it happened inside `.map()` it took the **whole list** down — the trend panel showed
// a raw JS error instead of the other 14 videos. Skip the unusable entry instead.
// (`statistics` was already treated as optional: YouTube hides view counts on request.)
function toVideoInfo(
  item: VideosListItem | null | undefined,
  details?: { duration: number; views: number }
): YouTubeVideoInfo | null {
  if (!item?.id || !item.snippet) return null
  return {
    id: item.id,
    title: item.snippet.title ?? '',
    channelTitle: item.snippet.channelTitle ?? '',
    thumbnailUrl: pickThumbnail(item.snippet.thumbnails),
    durationSeconds: details?.duration ?? parseIsoDuration(item.contentDetails?.duration ?? ''),
    viewCount: details?.views ?? Number(item.statistics?.viewCount ?? 0),
    publishedAt: item.snippet.publishedAt ?? ''
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

async function fetchVideoDetails(
  apiKey: string,
  ids: string[]
): Promise<Map<string, { duration: number; views: number }>> {
  if (ids.length === 0) return new Map()
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids.join(',')}&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: VideosListItem[] }>(
    url,
    undefined,
    'YouTube API'
  )
  const map = new Map<string, { duration: number; views: number }>()
  for (const item of asArray(data.items) as VideosListItem[]) {
    if (!item?.id) continue
    map.set(item.id, {
      duration: parseIsoDuration(item.contentDetails?.duration ?? ''),
      views: Number(item.statistics?.viewCount ?? 0)
    })
  }
  return map
}

export async function fetchTrendingVideos(apiKey: string): Promise<YouTubeVideoInfo[]> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&chart=mostPopular&regionCode=JP&maxResults=15&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: VideosListItem[] }>(
    url,
    undefined,
    'YouTube API'
  )
  return (asArray(data.items) as VideosListItem[])
    .map((item) => toVideoInfo(item))
    .filter(isPresent)
}

const GAMING_CATEGORY_ID = '20'

export async function fetchTrendingGamingVideos(apiKey: string): Promise<YouTubeVideoInfo[]> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&chart=mostPopular&regionCode=JP&videoCategoryId=${GAMING_CATEGORY_ID}&maxResults=25&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: VideosListItem[] }>(
    url,
    undefined,
    'YouTube API'
  )
  return (asArray(data.items) as VideosListItem[])
    .map((item) => toVideoInfo(item))
    .filter(isPresent)
}

export async function searchVideos(apiKey: string, query: string): Promise<YouTubeVideoInfo[]> {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=15&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: SearchListItem[] }>(
    searchUrl,
    undefined,
    'YouTube API'
  )
  const items = asArray(data.items) as SearchListItem[]
  const ids = items.map((i) => i?.id?.videoId).filter((id): id is string => Boolean(id))
  const details = await fetchVideoDetails(apiKey, ids)
  return items
    .map((item) => {
      const videoId = item?.id?.videoId
      if (!videoId) return null
      return toVideoInfo(
        { id: videoId, snippet: item.snippet },
        details.get(videoId) ?? { duration: 0, views: 0 }
      )
    })
    .filter(isPresent)
}
