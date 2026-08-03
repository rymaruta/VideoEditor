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
  publishedAt: string
  thumbnails: ApiThumbnails
}

interface VideosListItem {
  id: string
  snippet: ApiSnippet
  contentDetails: { duration: string }
  statistics?: { viewCount?: string }
}

interface SearchListItem {
  id: { videoId?: string }
  snippet: ApiSnippet
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

function pickThumbnail(thumbnails: ApiThumbnails): string {
  return thumbnails.medium?.url ?? thumbnails.default?.url ?? ''
}

async function fetchVideoDetails(
  apiKey: string,
  ids: string[]
): Promise<Map<string, { duration: number; views: number }>> {
  if (ids.length === 0) return new Map()
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids.join(',')}&key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url)
  const data: ApiError & { items?: VideosListItem[] } = await res.json()
  if (!res.ok) throw new Error(data?.error?.message ?? 'YouTube API エラー')
  const map = new Map<string, { duration: number; views: number }>()
  for (const item of data.items ?? []) {
    map.set(item.id, {
      duration: parseIsoDuration(item.contentDetails.duration),
      views: Number(item.statistics?.viewCount ?? 0)
    })
  }
  return map
}

export async function fetchTrendingVideos(apiKey: string): Promise<YouTubeVideoInfo[]> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&chart=mostPopular&regionCode=JP&maxResults=15&key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url)
  const data: ApiError & { items?: VideosListItem[] } = await res.json()
  if (!res.ok) throw new Error(data?.error?.message ?? 'YouTube API エラー')
  return (data.items ?? []).map((item) => ({
    id: item.id,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    thumbnailUrl: pickThumbnail(item.snippet.thumbnails),
    durationSeconds: parseIsoDuration(item.contentDetails.duration),
    viewCount: Number(item.statistics?.viewCount ?? 0),
    publishedAt: item.snippet.publishedAt
  }))
}

export async function searchVideos(apiKey: string, query: string): Promise<YouTubeVideoInfo[]> {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=15&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`
  const res = await fetch(searchUrl)
  const data: ApiError & { items?: SearchListItem[] } = await res.json()
  if (!res.ok) throw new Error(data?.error?.message ?? 'YouTube API エラー')
  const items = data.items ?? []
  const ids = items.map((i) => i.id.videoId).filter((id): id is string => Boolean(id))
  const details = await fetchVideoDetails(apiKey, ids)
  return items
    .filter((i): i is SearchListItem & { id: { videoId: string } } => Boolean(i.id.videoId))
    .map((item) => {
      const d = details.get(item.id.videoId)
      return {
        id: item.id.videoId,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        thumbnailUrl: pickThumbnail(item.snippet.thumbnails),
        durationSeconds: d?.duration ?? 0,
        viewCount: d?.views ?? 0,
        publishedAt: item.snippet.publishedAt
      }
    })
}
