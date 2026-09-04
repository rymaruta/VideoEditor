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

/**
 * 候補を探す元になる一覧。**上限いっぱいの50件**を取る。
 *
 * `chart=mostPopular` の1回は25件でも50件でも**消費は同じ1ユニット**なのに、
 * 25件だと1ゲームあたり2〜3本しか集まらず、「何チャンネルが出しているか」で
 * 見分けようとしても差が付かない(件数が少ないほど、たまたま並んだ1本で
 * 順位が入れ替わる)。母数を広げるのがいちばん安い精度の上げ方。
 */
export async function fetchTrendingGamingVideos(apiKey: string): Promise<YouTubeVideoInfo[]> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&chart=mostPopular&regionCode=JP&videoCategoryId=${GAMING_CATEGORY_ID}&maxResults=50&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: VideosListItem[] }>(
    url,
    undefined,
    'YouTube API'
  )
  return (asArray(data.items) as VideosListItem[])
    .map((item) => toVideoInfo(item))
    .filter(isPresent)
}

/**
 * `search.list` に載せられる絞り込み。
 *
 * **`publishedAfter` が要点。** 「いま伸びているか」を測るのに、期間を切らない検索は
 * 使えない——`order=viewCount` は**何年前の動画でも**再生数が多ければ上に出すので、
 * 5年前の名作がそのまま「今のトレンド」として返ってくる。
 */
export interface VideoSearchOptions {
  /** この時刻より後に公開された動画だけ(RFC3339)。`Date` を渡してもよい */
  publishedAfter?: Date | string
  /** YouTube 側の粗い尺の区分。`short` は「4分未満」なので、正確な尺は呼び出し側で見直す */
  videoDuration?: 'any' | 'short' | 'medium' | 'long'
  order?: 'relevance' | 'viewCount' | 'date' | 'rating'
  maxResults?: number
  regionCode?: string
  relevanceLanguage?: string
}

function toRfc3339(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function buildSearchParams(query: string, apiKey: string, options: VideoSearchOptions): string {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    order: options.order ?? 'viewCount',
    maxResults: String(options.maxResults ?? 15),
    q: query,
    key: apiKey
  })
  if (options.publishedAfter) params.set('publishedAfter', toRfc3339(options.publishedAfter))
  if (options.videoDuration && options.videoDuration !== 'any') {
    params.set('videoDuration', options.videoDuration)
  }
  if (options.regionCode) params.set('regionCode', options.regionCode)
  if (options.relevanceLanguage) params.set('relevanceLanguage', options.relevanceLanguage)
  return params.toString()
}

export async function searchVideos(
  apiKey: string,
  query: string,
  options: VideoSearchOptions = {}
): Promise<YouTubeVideoInfo[]> {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?${buildSearchParams(query, apiKey, options)}`
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

/**
 * 1つのゲームについて、**直近に公開されたショート**を取りに行く(裏取り用)。
 *
 * 急上昇のゲームカテゴリはほぼ長尺で、そこに名前が出たからといって
 * **ショートでも回っている**とは限らない。「今日ショートを1本撮るなら」の答えを
 * 出すには、そのゲームのショートが実際に何本あって、どれくらいの速さで回っているかを
 * 別途数える必要がある。
 *
 * `search.list` は再生数を返さないので、`videos.list` で実数を取り直す
 * (この2段構えは `searchVideos` と同じ)。尺の絞り込みは YouTube 側が「4分未満」と
 * 粗いため、本当にショートかどうかは戻り値の `durationSeconds` で判断すること。
 */
export async function searchRecentShorts(
  apiKey: string,
  gameName: string,
  windowDays: number,
  maxResults = 10
): Promise<YouTubeVideoInfo[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  return searchVideos(apiKey, gameName, {
    publishedAfter: since,
    videoDuration: 'short',
    order: 'viewCount',
    maxResults,
    regionCode: 'JP',
    relevanceLanguage: 'ja'
  })
}
