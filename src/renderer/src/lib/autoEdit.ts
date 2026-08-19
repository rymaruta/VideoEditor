import { fetchJson, parseModelJsonObject } from './httpJson'
import { v4 as uuid } from 'uuid'
import type {
  AudioTrack,
  AutoEditPattern,
  AutoEditStyle,
  MediaAsset,
  TransitionType
} from '@shared/types'
import { useEditPreferenceStore } from '../store/editPreferenceStore'
import { STYLE_DESCRIPTIONS, STYLE_LABELS } from './autoEditStyles'
import { beatGridFromAnalysis } from './beatGrid'
import { formatIpcError } from './ipcError'

interface FlatCandidate {
  assetId: string
  assetIndex: number
  start: number
  end: number
  score: number
  hasSceneChange: boolean
  hasAudioPeak: boolean
}

interface StyleBuild {
  style: AutoEditStyle
  segments: FlatCandidate[]
  transition: TransitionType
  description?: string
}

export interface AutoEditResult {
  patterns: AutoEditPattern[]
  recommendedPatternId?: string
  thumbnails: Record<string, string>
  aiScoredCandidateCount: number
  bgmBeat: { bpm: number; assetName: string } | null
  referenceStyle: { avgCutSeconds: number; cutCount: number } | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function mulberry32(seed: number): () => number {
  let a = seed
  return function random(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededShuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 素材ごとのハイライト検出。**1本の失敗で全体を止めないが、理由は捨てない。**
 *
 * 捨てていたころは、壊れたファイル・音声ストリームの無いファイルを渡しても
 * 「候補0件」になり、**静かな動画と同じ「ハイライトを検出できませんでした」**しか
 * 出なかった(解析側は `describeFfmpegExit` で日本語の理由を投げているのに、
 * ここで握りつぶしていた)。全部失敗したときに理由を添えられるよう持ち帰る。
 */
async function collectHighlights(assets: MediaAsset[]): Promise<{
  results: { asset: MediaAsset; candidates: FlatCandidate[] }[]
  failed: number
  firstFailure: string | null
}> {
  const results: { asset: MediaAsset; candidates: FlatCandidate[] }[] = []
  let failed = 0
  let firstFailure: string | null = null
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]
    try {
      const found = await window.api.detectHighlights(asset.filePath, asset.duration)
      results.push({
        asset,
        candidates: found.map((c) => ({
          assetId: asset.id,
          assetIndex: i,
          start: c.start,
          end: c.end,
          score: c.score,
          hasSceneChange: c.hasSceneChange,
          hasAudioPeak: c.hasAudioPeak
        }))
      })
    } catch (e) {
      failed++
      if (firstFailure === null) firstFailure = formatIpcError(e)
      results.push({ asset, candidates: [] })
    }
  }
  return { results, failed, firstFailure }
}

/**
 * 候補が1件も無いときの文言。**失敗があったならその理由を必ず添える。**
 * 「静かな動画だから0件」と「解析が失敗して0件」は利用者から見て同じに見えるので、
 * 分けて伝えないと、直せる原因(壊れたファイル)を素材のせいだと思って探し回ることになる。
 */
export function noHighlightsMessage(
  assetCount: number,
  failed: number,
  firstFailure: string | null
): string {
  if (failed <= 0 || !firstFailure) return 'ハイライトを検出できませんでした'
  if (failed >= assetCount) {
    return `ハイライトを検出できませんでした(${assetCount}件すべての解析に失敗しました: ${firstFailure})`
  }
  return `ハイライトを検出できませんでした(${assetCount}件中${failed}件の解析に失敗しました: ${firstFailure})`
}

function trimToMax(c: FlatCandidate, maxSeconds: number): FlatCandidate {
  const duration = c.end - c.start
  if (duration <= maxSeconds) return c
  const center = (c.start + c.end) / 2
  const half = maxSeconds / 2
  return { ...c, start: Math.max(c.start, center - half), end: Math.min(c.end, center + half) }
}

function forceExactDuration(
  c: FlatCandidate,
  duration: number,
  assetDuration: number
): FlatCandidate {
  const clampedDuration = Math.min(duration, assetDuration)
  const center = (c.start + c.end) / 2
  let start = center - clampedDuration / 2
  let end = center + clampedDuration / 2
  if (start < 0) {
    end -= start
    start = 0
  }
  if (end > assetDuration) {
    start -= end - assetDuration
    end = assetDuration
  }
  start = Math.max(0, start)
  return { ...c, start, end: start + clampedDuration }
}

function byAssetThenStart(a: FlatCandidate, b: FlatCandidate): number {
  return a.assetIndex - b.assetIndex || a.start - b.start
}

function normalizeScoresInPlace(candidates: FlatCandidate[]): void {
  if (candidates.length === 0) return
  const scores = candidates.map((c) => c.score)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min || 1
  for (const c of candidates) {
    c.score = ((c.score - min) / range) * 100
  }
}

function buildScorePattern(
  flat: FlatCandidate[],
  targetSeconds: number,
  cap: number
): FlatCandidate[] {
  const sorted = [...flat].sort((a, b) => b.score - a.score)
  const chosen: FlatCandidate[] = []
  let total = 0
  for (const c of sorted) {
    if (chosen.length > 0 && total >= targetSeconds) break
    const trimmed = trimToMax(c, cap)
    chosen.push(trimmed)
    total += trimmed.end - trimmed.start
  }
  return chosen.sort(byAssetThenStart)
}

function buildJumpcutPattern(
  flat: FlatCandidate[],
  rand: () => number,
  targetSeconds: number,
  cap: number
): FlatCandidate[] {
  const sorted = [...flat].sort((a, b) => b.score - a.score)
  const pool = sorted.slice(0, Math.max(6, Math.min(sorted.length, 24)))
  const shuffled = seededShuffle(pool, rand)
  const chosen: FlatCandidate[] = []
  let total = 0
  for (const c of shuffled) {
    if (chosen.length > 0 && total >= targetSeconds) break
    const trimmed = trimToMax(c, cap)
    chosen.push(trimmed)
    total += trimmed.end - trimmed.start
  }
  return chosen
}

function buildStoryPattern(
  flat: FlatCandidate[],
  assetCount: number,
  targetSeconds: number,
  cap: number
): FlatCandidate[] {
  const chosen: FlatCandidate[] = []
  const perAssetTarget = targetSeconds / Math.max(1, assetCount)
  for (let idx = 0; idx < assetCount; idx++) {
    const list = flat.filter((c) => c.assetIndex === idx).sort((a, b) => b.score - a.score)
    let assetTotal = 0
    for (const c of list) {
      if (chosen.length > 0 && assetTotal >= perAssetTarget) break
      const trimmed = trimToMax(c, cap)
      chosen.push(trimmed)
      assetTotal += trimmed.end - trimmed.start
    }
  }
  return chosen.sort(byAssetThenStart)
}

function mergeNearby(cands: FlatCandidate[], gapThreshold: number): FlatCandidate[] {
  const sorted = [...cands].sort((a, b) => a.start - b.start)
  const merged: FlatCandidate[] = []
  for (const c of sorted) {
    const last = merged[merged.length - 1]
    if (last && c.start - last.end <= gapThreshold) {
      last.end = Math.max(last.end, c.end)
      last.score = Math.max(last.score, c.score)
    } else {
      merged.push({ ...c })
    }
  }
  return merged
}

function buildLongtakePattern(
  flat: FlatCandidate[],
  assetCount: number,
  targetSeconds: number,
  cap: number
): FlatCandidate[] {
  const merged: FlatCandidate[] = []
  for (let i = 0; i < assetCount; i++) {
    merged.push(
      ...mergeNearby(
        flat.filter((c) => c.assetIndex === i),
        1.5
      )
    )
  }
  const sorted = merged.sort((a, b) => b.score - a.score)
  const chosen: FlatCandidate[] = []
  let total = 0
  for (const c of sorted) {
    if (chosen.length > 0 && total >= targetSeconds) break
    const trimmed = trimToMax(c, cap)
    chosen.push(trimmed)
    total += trimmed.end - trimmed.start
  }
  return chosen.sort(byAssetThenStart)
}

function buildMixPattern(
  flat: FlatCandidate[],
  assetCount: number,
  rand: () => number,
  targetSeconds: number,
  cap: number
): FlatCandidate[] {
  const queues: FlatCandidate[][] = []
  for (let i = 0; i < assetCount; i++) {
    queues.push(flat.filter((c) => c.assetIndex === i).sort((a, b) => b.score - a.score))
  }
  const order = seededShuffle(
    Array.from({ length: assetCount }, (_, i) => i),
    rand
  )
  const chosen: FlatCandidate[] = []
  let total = 0
  let progressed = true
  while (progressed && (chosen.length === 0 || total < targetSeconds)) {
    progressed = false
    for (const assetIdx of order) {
      const q = queues[assetIdx]
      if (q.length === 0) continue
      const c = q.shift()!
      const trimmed = trimToMax(c, cap)
      chosen.push(trimmed)
      total += trimmed.end - trimmed.start
      progressed = true
      if (chosen.length > 0 && total >= targetSeconds) break
    }
  }
  return chosen
}

const BEATSYNC_ANALYZE_MAX_SECONDS = 60
const BEATSYNC_TARGET_SECONDS = 24

async function detectBgmBeat(
  audioTracks: AudioTrack[],
  assets: MediaAsset[]
): Promise<{ bpm: number; offsetSeconds: number; assetName: string } | null> {
  for (const track of audioTracks) {
    const clip = track.clips[0]
    if (!clip) continue
    const asset = assets.find((a) => a.id === clip.assetId)
    if (!asset) continue
    try {
      const duration = Math.min(BEATSYNC_ANALYZE_MAX_SECONDS, clip.outPoint - clip.inPoint)
      const result = await window.api.analyzeBpm(asset.filePath, clip.inPoint, duration)
      if (result.bpm > 0) {
        // 解析が返すのは**素材の秒**での BPM。カット間隔も画面に出す数字も
        // **タイムラインの秒**なので、速度を変えたクリップでは倍率ぶん食い違う
        // (規則は `beatGridFromAnalysis`。ビートグリッドと同じ換算をここでも通す)。
        // 実測: 120BPM の音源を速度2倍で置くと、実際に聞こえるのは 239.8BPM
        // (書き出しのクリック間隔 0.2502秒)なのに、案の説明は「約120 BPM」と出て、
        // カット間隔も 1.000秒(意図した2拍ぶんではなく4拍ぶん)になっていた。
        const timeline = beatGridFromAnalysis(result, clip)
        return {
          bpm: timeline.bpm,
          offsetSeconds: timeline.offsetSeconds,
          assetName: asset.fileName
        }
      }
    } catch {
      // Try the next audio track if BPM analysis fails for this one.
    }
  }
  return null
}

function buildBeatSyncPattern(
  flat: FlatCandidate[],
  videoAssets: MediaAsset[],
  bpm: number,
  preferredSegmentSeconds: number | null,
  rand: () => number
): FlatCandidate[] {
  const beatInterval = 60 / bpm
  const beatsPerCut = preferredSegmentSeconds
    ? clamp(Math.round(preferredSegmentSeconds / beatInterval), 1, 4)
    : 2
  const cutInterval = beatInterval * beatsPerCut
  const numCuts = Math.max(6, Math.round(BEATSYNC_TARGET_SECONDS / cutInterval))
  const pool = [...flat].sort((a, b) => b.score - a.score).slice(0, Math.max(numCuts, 24))
  if (pool.length === 0) return []
  const shuffled = seededShuffle(pool, rand)
  const chosen: FlatCandidate[] = []
  for (let i = 0; i < numCuts; i++) {
    const source = shuffled[i % shuffled.length]
    const asset = videoAssets.find((a) => a.id === source.assetId)
    if (!asset || asset.duration < cutInterval) continue
    chosen.push(forceExactDuration(source, cutInterval, asset.duration))
  }
  return chosen
}

const REFERENCE_CUT_MIN_GAP = 0.3
const REFERENCE_CUT_MAX_GAP = 15
const REFERENCE_TARGET_SECONDS = 26

async function analyzeReferenceStyle(
  filePath: string
): Promise<{ avgCutSeconds: number; cutCount: number } | null> {
  try {
    const { cutTimes } = await window.api.analyzeReferenceStyle(filePath)
    if (cutTimes.length < 2) return null
    const sorted = [...cutTimes].sort((a, b) => a - b)
    const intervals: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1]
      if (gap >= REFERENCE_CUT_MIN_GAP && gap <= REFERENCE_CUT_MAX_GAP) intervals.push(gap)
    }
    if (intervals.length === 0) return null
    const avgCutSeconds = intervals.reduce((a, b) => a + b, 0) / intervals.length
    return { avgCutSeconds: clamp(avgCutSeconds, 0.5, 8), cutCount: intervals.length }
  } catch {
    return null
  }
}

function buildReferenceStylePattern(
  flat: FlatCandidate[],
  videoAssets: MediaAsset[],
  avgCutSeconds: number,
  rand: () => number
): FlatCandidate[] {
  const numCuts = Math.max(6, Math.round(REFERENCE_TARGET_SECONDS / avgCutSeconds))
  const pool = [...flat].sort((a, b) => b.score - a.score).slice(0, Math.max(numCuts, 24))
  if (pool.length === 0) return []
  const shuffled = seededShuffle(pool, rand)
  const chosen: FlatCandidate[] = []
  for (let i = 0; i < numCuts; i++) {
    const source = shuffled[i % shuffled.length]
    const asset = videoAssets.find((a) => a.id === source.assetId)
    if (!asset || asset.duration < avgCutSeconds) continue
    chosen.push(forceExactDuration(source, avgCutSeconds, asset.duration))
  }
  return chosen
}

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  error?: { message?: string }
}

const GEMINI_HIGHLIGHT_SAMPLE_COUNT = 20

async function scoreHighlightsWithGemini(
  candidates: FlatCandidate[],
  videoAssets: MediaAsset[],
  apiKey: string
): Promise<Map<FlatCandidate, number>> {
  const ranked = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, GEMINI_HIGHLIGHT_SAMPLE_COUNT)

  const frames: { candidate: FlatCandidate; dataUrl: string }[] = []
  for (const c of ranked) {
    const asset = videoAssets.find((a) => a.id === c.assetId)
    if (!asset) continue
    try {
      const mid = (c.start + c.end) / 2
      const dataUrl = await window.api.generateFrame(asset.filePath, mid, 320, 180)
      frames.push({ candidate: c, dataUrl })
    } catch {
      // Skip candidates whose frame extraction fails; they keep their local score.
    }
  }
  if (frames.length === 0) return new Map()

  const GEMINI_MODEL = 'gemini-flash-latest'
  const parts: GeminiPart[] = [
    {
      text: `あなたはYouTube Shorts編集AIです。以下は動画から抽出した${frames.length}個のハイライト候補シーンの代表フレーム画像です。画像は1〜${frames.length}の番号順に添付されています。

# 依頼内容
各画像について、表情の盛り上がり・驚き/笑いなどの感情の強さ・動きの激しさを基準に、そのシーンが「見せ場」としてどれくらい魅力的かを0〜100点で採点してください。人物が映っていない、または単調な画像は低い点数にしてください。

# 出力形式(このJSONのみを出力してください)
{ "scores": [{ "index": number, "score": number }] }`
    }
  ]
  frames.forEach((f) => {
    const commaIdx = f.dataUrl.indexOf(',')
    const base64 = commaIdx >= 0 ? f.dataUrl.slice(commaIdx + 1) : ''
    const mimeMatch = f.dataUrl.match(/^data:([^;]+);/)
    parts.push({ inlineData: { mimeType: mimeMatch?.[1] ?? 'image/png', data: base64 } })
  })

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<GeminiResponse>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    },
    'Gemini API'
  )
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Geminiからの応答が空でした')
  const parsed = parseModelJsonObject(text, 'Gemini API') as {
    scores?: { index: number; score: number }[]
  }

  const map = new Map<FlatCandidate, number>()
  if (Array.isArray(parsed.scores)) {
    for (const s of parsed.scores) {
      // **要素を1件ずつ確かめる。** モデルは採点できなかった1件を `null` で返すことがあり、
      // `s.index` を直に読むとそこで例外になる。この呼び出しは呼び出し側が
      // `try/catch` で包んでいるので**画面は壊れないが、同じ応答に入っていた他の採点も
      // まとめて捨てられる**——エラーも出ないので「AIが効いていない」ようにしか見えない。
      // (実測: 5件中1件を `null` にすると、採点された候補が **5件 → 0件**になり、
      //  「Geminiが候補シーン◯件を採点し…」の帯ごと消えた)
      const frame = frames[(s?.index ?? 0) - 1]
      if (frame && typeof s?.score === 'number') {
        map.set(frame.candidate, Math.max(0, Math.min(100, s.score)))
      }
    }
  }
  return map
}

const DIRECTOR_CANDIDATE_POOL_SIZE = 30
const VALID_TRANSITIONS: TransitionType[] = ['none', 'crossfade', 'fade', 'wipe']

interface DirectorPlan {
  segments: FlatCandidate[]
  transitions: TransitionType[]
  reasoning: string
}

async function planDirectorPattern(
  flat: FlatCandidate[],
  videoAssets: MediaAsset[],
  preferenceSummary: string,
  apiKey: string
): Promise<DirectorPlan | null> {
  const pool = [...flat].sort((a, b) => b.score - a.score).slice(0, DIRECTOR_CANDIDATE_POOL_SIZE)
  if (pool.length === 0) return null

  const lines = pool
    .map((c, i) => {
      const asset = videoAssets.find((a) => a.id === c.assetId)
      const flags =
        [c.hasSceneChange ? 'カット点' : null, c.hasAudioPeak ? '音量ピーク' : null]
          .filter(Boolean)
          .join('/') || '特徴なし'
      return `${i + 1}. 素材=${asset?.fileName ?? '不明'} / ${c.start.toFixed(1)}〜${c.end.toFixed(1)}秒 / スコア=${c.score.toFixed(0)} / ${flags}`
    })
    .join('\n')

  const prompt = `あなたはYouTube Shorts専門のプロ編集者です。以下は動画素材から検出したハイライト候補のリストです(番号・素材名・区間・スコア・検出特徴)。

# ハイライト候補
${lines}

# ユーザーの編集の好み傾向
${preferenceSummary}

# 依頼内容
このリストから、視聴維持率が高くなるよう考え抜かれた1本の編集を組み立ててください。以下をあなた自身の編集判断で決めてください。
- 使うカットの取捨選択(全部使う必要はありません。多すぎる/単調な構成は避けてください)
- 再生する順番(素材の時系列順である必要はありません。冒頭でインパクトのあるカットを見せる、テンポの緩急をつけるなど、明確な編集意図を持って決めてください)
- 各カットの前のつなぎ方(1カット目以外、"none"(カット)/"crossfade"/"fade"/"wipe"のいずれか)
- 合計尺は20〜40秒程度を目安にしてください

# 出力形式(このJSONのみを出力してください)
{
  "segments": [{ "index": number, "transition": "none" | "crossfade" | "fade" | "wipe" }],
  "reasoning": "この構成にした編集意図を日本語2〜3文で"
}`

  const GEMINI_MODEL = 'gemini-flash-latest'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<GeminiResponse>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    },
    'Gemini API'
  )
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Geminiからの応答が空でした')
  const parsed = parseModelJsonObject(text, 'Gemini API') as {
    segments?: { index: number; transition?: string }[]
    reasoning?: string
  }
  if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) return null

  const segments: FlatCandidate[] = []
  const transitions: TransitionType[] = []
  for (const s of parsed.segments) {
    // 採点と同じ理由で、要素が `null` でも読めるようにする。ここで例外になると
    // **「AIディレクター」の案が丸ごと出なくなる**(実測: 3件中1件を `null` にすると
    // 案が6件 → 5件になり、ディレクターの札だけが消えた)。
    const candidate = pool[(s?.index ?? 0) - 1]
    if (!candidate) continue
    segments.push(candidate)
    transitions.push(
      VALID_TRANSITIONS.includes(s.transition as TransitionType)
        ? (s.transition as TransitionType)
        : 'crossfade'
    )
  }
  if (segments.length === 0) return null

  return {
    segments,
    transitions,
    reasoning: parsed.reasoning?.trim() || STYLE_DESCRIPTIONS.director
  }
}

async function enhanceWithGemini(
  patterns: AutoEditPattern[],
  thumbnails: Record<string, string>,
  preferenceSummary: string,
  apiKey: string
): Promise<Record<string, string>> {
  const GEMINI_MODEL = 'gemini-flash-latest'
  /**
   * **添付できる画像を先に確定させる。** 依頼文は「並べたパターンと画像が1対1で対応する」
   * 前提で書かれているのに、画像は `thumbnails` にあるものだけを後から並べていたので、
   * **サムネイルの生成に失敗したパターンがあるとその前提が崩れていた**。
   * しかも画像には id が付いていないので、モデルは「k枚目 = k番目のパターン」と読むしかなく、
   * 穴より後ろの画像は**全部1つ手前のパターンの絵**として扱われる。
   * (実測・映像が5秒で終わるのに音声は20秒続く素材3本＝先頭カットの絵が取れない企画:
   *  依頼文に並べたパターン **5件**に対し添付した画像は **0枚**。それでも依頼文は
   *  「それぞれの先頭カットのサムネイル画像です。**画像から読み取れる内容を根拠に
   *  判断してください**」と名乗り、**画像が無いときの断り書きも無かった**
   *  ——モデルは在りもしない絵を根拠に説明文を書くことになる。
   *  素材1本だけが同じ状態のときは 5件に対し **4枚**で、こちらは穴の位置しだいで
   *  画像が1つずつずれて別のパターンの絵として読まれる)
   *
   * 同じ画面の**ゲームトレンド分析はこの手当てが済んでいる**(実際に添付した枚数を名乗り、
   * 0枚なら「添付されていない」と断る)。こちらだけ育っていなかった。
   */
  const attachable = patterns
    .map((p) => {
      const dataUrl = thumbnails[p.id]
      if (!dataUrl) return null
      const commaIdx = dataUrl.indexOf(',')
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : ''
      // 中身の無いデータURLを「画像1枚」として数えない(名乗る枚数が実物とずれる)。
      if (!base64) return null
      return { p, mimeType: dataUrl.match(/^data:([^;]+);/)?.[1] ?? 'image/png', data: base64 }
    })
    .filter((x): x is { p: AutoEditPattern; mimeType: string; data: string } => x !== null)

  const infoLines = patterns
    .map(
      (p, i) =>
        `${i + 1}. id=${p.id} / スタイル=${STYLE_LABELS[p.style]} / カット数=${p.segments.length} / 尺=${p.totalDuration.toFixed(1)}秒 / サムネイル画像=${thumbnails[p.id] ? 'あり' : 'なし'}`
    )
    .join('\n')
  // 名乗るのは**実際に添付する枚数**。0枚なら画像を根拠にしろとは言わない。
  const imageNote =
    attachable.length > 0
      ? `あわせて、先頭カットのサムネイル画像を${attachable.length}枚添付しています。**各画像の直前に、それがどのidのものかを書いてあります**(画像が取れなかったパターンには画像がありません)。画像があるものは画像の内容も根拠にし、無いものは文字情報だけで判断してください。`
      : 'サムネイル画像は添付されていません。文字情報だけで判断してください。'
  const parts: GeminiPart[] = [
    {
      text: `あなたはYouTube Shorts編集AIです。以下は動画素材から自動生成した編集パターンの情報です。${imageNote}

# ユーザーの編集の好み傾向(これまでのフィードバックの蓄積)
${preferenceSummary}

# 生成された編集パターン
${infoLines}

# 依頼内容
各パターンについて、スタイル・好み傾向(と、あれば画像の内容)を踏まえた日本語1文の短いキャッチーな説明文(description)を作ってください。好み傾向に最も合いそうなパターンのidを1つ選んでrecommendedIdとしてください。

# 出力形式(このJSONのみを出力してください)
{ "descriptions": [{ "id": "string", "description": "string" }], "recommendedId": "string" }`
    }
  ]
  for (const item of attachable) {
    // 画像そのものには id を持たせられないので、**直前の一行で結び付ける**。
    // 並び順に頼ると、穴が1つ空いた瞬間に後ろが全部ずれる。
    parts.push({ text: `次の画像は id=${item.p.id} のパターンの先頭カットです。` })
    parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } })
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<GeminiResponse>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    },
    'Gemini API'
  )
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Geminiからの応答が空でした')
  const parsed = parseModelJsonObject(text, 'Gemini API') as {
    descriptions?: { id: string; description: string }[]
    recommendedId?: string
  }
  const map: Record<string, string> = {}
  if (Array.isArray(parsed.descriptions)) {
    for (const d of parsed.descriptions) {
      if (d?.id && d?.description) map[d.id] = d.description
    }
  }
  if (parsed.recommendedId) map.__recommendedId = parsed.recommendedId
  return map
}

export async function generateAutoEditPatterns(
  assets: MediaAsset[],
  options: {
    seed?: number
    geminiApiKey?: string
    audioTracks?: AudioTrack[]
    referenceFilePath?: string
  } = {}
): Promise<AutoEditResult> {
  const videoAssets = assets.filter((a) => a.hasVideo)
  if (videoAssets.length === 0) throw new Error('動画素材がありません')

  const collected = await collectHighlights(videoAssets)
  const withCandidates = collected.results
  const flat = withCandidates.flatMap((w) => w.candidates)
  if (flat.length === 0) {
    throw new Error(
      noHighlightsMessage(videoAssets.length, collected.failed, collected.firstFailure)
    )
  }

  normalizeScoresInPlace(flat)

  let aiScoredCandidateCount = 0
  if (options.geminiApiKey) {
    try {
      const aiScores = await scoreHighlightsWithGemini(flat, videoAssets, options.geminiApiKey)
      for (const c of flat) {
        const aiScore = aiScores.get(c)
        if (aiScore !== undefined) {
          c.score = c.score * 0.4 + aiScore * 0.6
          aiScoredCandidateCount++
        }
      }
    } catch {
      // AI scoring is best-effort; the local scene/audio-based scores remain in place.
    }
  }

  const prefStore = useEditPreferenceStore.getState()
  const preferredTransition = prefStore.getPreferredTransition()
  const preferredSegmentSeconds = prefStore.getPreferredSegmentSeconds()
  const preferenceSummary = prefStore.getSummaryText()

  const rand = mulberry32(options.seed ?? Date.now())
  const assetCount = videoAssets.length

  const scoreCap = clamp(preferredSegmentSeconds ?? 4, 2, 6)
  const jumpcutCap = clamp((preferredSegmentSeconds ?? 2) * 0.6, 0.8, 2.5)
  const mixCap = clamp(preferredSegmentSeconds ?? 3, 1.5, 5)

  const bgmBeat = options.audioTracks ? await detectBgmBeat(options.audioTracks, assets) : null
  const referenceStyle = options.referenceFilePath
    ? await analyzeReferenceStyle(options.referenceFilePath)
    : null

  const builds: StyleBuild[] = [
    {
      style: 'score',
      segments: buildScorePattern(flat, 30, scoreCap),
      transition: preferredTransition
    },
    {
      style: 'jumpcut',
      segments: buildJumpcutPattern(flat, rand, 22, jumpcutCap),
      transition: 'none'
    },
    { style: 'story', segments: buildStoryPattern(flat, assetCount, 40, 5), transition: 'fade' },
    {
      style: 'longtake',
      segments: buildLongtakePattern(flat, assetCount, 35, 9),
      transition: 'crossfade'
    },
    {
      style: 'mix',
      segments: buildMixPattern(flat, assetCount, rand, 30, mixCap),
      transition: preferredTransition
    }
  ]

  if (bgmBeat) {
    builds.push({
      style: 'beatsync',
      segments: buildBeatSyncPattern(flat, videoAssets, bgmBeat.bpm, preferredSegmentSeconds, rand),
      transition: 'none',
      description: `BGM「${bgmBeat.assetName}」のテンポ(約${Math.round(bgmBeat.bpm)} BPM)に合わせてカット点を打った編集です。`
    })
  }

  if (referenceStyle) {
    builds.push({
      style: 'reference',
      segments: buildReferenceStylePattern(flat, videoAssets, referenceStyle.avgCutSeconds, rand),
      transition: 'none',
      description: `参考動画の平均カット間隔(約${referenceStyle.avgCutSeconds.toFixed(1)}秒)のテンポで再構成した編集です。`
    })
  }

  let patterns: AutoEditPattern[] = builds
    .filter((b) => b.segments.length > 0)
    .map((b) => ({
      id: uuid(),
      style: b.style,
      label: STYLE_LABELS[b.style],
      description: b.description ?? STYLE_DESCRIPTIONS[b.style],
      segments: b.segments.map((s) => ({
        assetId: s.assetId,
        start: s.start,
        end: s.end,
        score: s.score
      })),
      transition: b.transition,
      totalDuration: b.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
    }))

  let directorPatternId: string | undefined
  if (options.geminiApiKey) {
    try {
      const plan = await planDirectorPattern(
        flat,
        videoAssets,
        preferenceSummary,
        options.geminiApiKey
      )
      if (plan) {
        const id = uuid()
        directorPatternId = id
        patterns.push({
          id,
          style: 'director',
          label: STYLE_LABELS.director,
          description: plan.reasoning,
          segments: plan.segments.map((s, i) => ({
            assetId: s.assetId,
            start: s.start,
            end: s.end,
            score: s.score,
            transitionIn: i === 0 ? undefined : plan.transitions[i]
          })),
          transition: preferredTransition,
          totalDuration: plan.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
        })
      }
    } catch {
      // Director planning is best-effort; the fixed-heuristic patterns remain available.
    }
  }

  if (patterns.length === 0) throw new Error('編集パターンを生成できませんでした')

  const preferredOrder = prefStore.getPreferredStyleOrder()
  patterns = [...patterns].sort(
    (a, b) => preferredOrder.indexOf(a.style) - preferredOrder.indexOf(b.style)
  )

  const thumbnails: Record<string, string> = {}
  for (const p of patterns) {
    const first = p.segments[0]
    const asset = videoAssets.find((a) => a.id === first.assetId)
    if (!asset) continue
    try {
      const mid = (first.start + first.end) / 2
      thumbnails[p.id] = await window.api.generateFrame(asset.filePath, mid, 480, 270)
    } catch {
      // Skip thumbnail generation failures; the card can render without one.
    }
  }

  let recommendedPatternId: string | undefined = directorPatternId
  if (options.geminiApiKey) {
    try {
      const describable = patterns.filter((p) => p.id !== directorPatternId)
      const enhancement = await enhanceWithGemini(
        describable,
        thumbnails,
        preferenceSummary,
        options.geminiApiKey
      )
      patterns = patterns.map((p) =>
        enhancement[p.id] ? { ...p, description: enhancement[p.id] } : p
      )
      if (!recommendedPatternId) recommendedPatternId = enhancement.__recommendedId
    } catch {
      // Gemini enhancement is best-effort; keep the local descriptions on failure.
    }
  }

  return {
    patterns,
    recommendedPatternId,
    thumbnails,
    aiScoredCandidateCount,
    bgmBeat: bgmBeat ? { bpm: bgmBeat.bpm, assetName: bgmBeat.assetName } : null,
    referenceStyle
  }
}
