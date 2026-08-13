/**
 * 外部Web API(YouTube / Gemini / Jamendo / Freesound)を呼ぶための共通の入り口。
 *
 * **失敗をそのまま画面に出さない**のがここの役目。外の API が返す `error.message` は
 * 英語で、しかも YouTube の利用上限は **HTMLタグ入り**(`… exceeded your
 * <a href="…">quota</a>.`)。そのまま `<p>` に流すと、日本語の画面に英語とタグが並ぶ。
 * 通信自体が失敗したときはブラウザの `TypeError: Failed to fetch` がそのまま出て、
 * **何が起きたのかも、次に何をすればよいかも分からない**。
 *
 * 直すのは**読む側のここ1箇所**。呼び出し元ごとに `try/catch` を書くと、
 * 経路が増えるたびに片方だけ素通しに戻る(実測: 11経路すべてが素通しだった)。
 */

/** 原因の判定に使う、Google 系 API のエラーの形 */
interface ApiErrorBody {
  error?: {
    message?: string
    status?: string
    errors?: { reason?: string; message?: string }[]
  }
}

function errorInfo(body: unknown): { message: string; status: string; reason: string } {
  const e = (body as ApiErrorBody | null | undefined)?.error
  return {
    message: typeof e?.message === 'string' ? e.message : '',
    status: typeof e?.status === 'string' ? e.status : '',
    reason:
      Array.isArray(e?.errors) && typeof e.errors[0]?.reason === 'string' ? e.errors[0].reason : ''
  }
}

/**
 * 表に出す原文の掃除。HTMLタグを落として1行にし、長さで切る。
 * **捨てはしない**——見慣れない原因は原文が唯一の手がかりになる。
 */
const MAX_RAW_LENGTH = 120

function sanitize(message: string): string {
  const flat = message
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > MAX_RAW_LENGTH ? `${flat.slice(0, MAX_RAW_LENGTH)}…` : flat
}

/**
 * HTTPエラーを日本語にする。**原因はHTTPコードと構造化された理由から判定**する
 * (英文のパターン照合だけに頼ると、文言が変わった日から黙って未知扱いに戻る)。
 */
function describeApiFailure(apiLabel: string, status: number, body: unknown): string {
  const info = errorInfo(body)
  const isKeyProblem =
    info.reason === 'API_KEY_INVALID' ||
    info.reason === 'badRequest' ||
    /API key not valid|API_KEY_INVALID|keyInvalid/i.test(info.message)
  const isQuota =
    status === 429 ||
    info.status === 'RESOURCE_EXHAUSTED' ||
    /quota|rateLimitExceeded|dailyLimitExceeded/i.test(info.reason)
  const isDisabled = /accessNotConfigured|SERVICE_DISABLED/i.test(`${info.reason}${info.status}`)

  if (isQuota) {
    return `${apiLabel}の利用上限に達しました。時間をおいてから、もう一度お試しください。`
  }
  if (isKeyProblem && status === 400) {
    return `${apiLabel}のキーが正しくありません。入力したAPIキーを確認してください。`
  }
  if (isDisabled || status === 403) {
    return `${apiLabel}を利用する権限がありません。APIキーの設定と、そのキーでこのAPIが有効になっているかを確認してください。`
  }
  if (status === 401) {
    return `${apiLabel}のキーが受け付けられませんでした。入力したAPIキーを確認してください。`
  }
  if (status >= 500) {
    return `${apiLabel}が一時的に応答できませんでした。しばらく待ってから、もう一度お試しください。`
  }
  const raw = sanitize(info.message)
  return raw
    ? `${apiLabel}がエラーを返しました (HTTP ${status}): ${raw}`
    : `${apiLabel}がエラーを返しました (HTTP ${status})`
}

/**
 * **HTTP 200 のまま本文だけで失敗を伝えてくる API** 用。
 * (Jamendo は鍵が違っても 200 を返し、`headers.status = 'failed'` にだけ書く)
 * HTTPコードが無いので判定材料は原文しかないが、少なくとも
 * 「どのAPIの話か」を添えて、タグと長さを整えてから出す。
 */
export function describeBodyFailure(apiLabel: string, message: unknown): string {
  const raw = sanitize(typeof message === 'string' ? message : '')
  if (/credential|api ?key|client ?id|token|unauthor/i.test(raw)) {
    return `${apiLabel}のキーが受け付けられませんでした。入力したAPIキー(Client ID)を確認してください。`
  }
  return raw ? `${apiLabel}がエラーを返しました: ${raw}` : `${apiLabel}がエラーを返しました`
}

/**
 * JSON を返す API を呼ぶ。失敗はすべて**日本語の**エラーとして投げる。
 *
 * `res.json()` を `res.ok` の確認前に呼ぶと、JSONでないエラー応答(プロキシのHTML 502や
 * 空のボディ)で `SyntaxError: Unexpected token '<'` が飛び、それが利用者に見える。
 * 本文は一度テキストで読んでから判断する。
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit | undefined,
  apiLabel: string
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    // ここに来るのは通信そのものが成立しなかったとき(圏外・DNS・プロキシ断)。
    // ブラウザの生の文言は "Failed to fetch" だけで、何をすればよいか分からない。
    throw new Error(
      `${apiLabel}に接続できませんでした。インターネット接続を確認して、もう一度お試しください。`
    )
  }

  const raw = await res.text()
  let parsed: unknown = undefined
  if (raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
  }

  if (!res.ok) throw new Error(describeApiFailure(apiLabel, res.status, parsed))
  if (parsed === undefined) throw new Error(`${apiLabel}の応答を解析できませんでした`)
  return parsed as T
}

/**
 * 生成AIが返した JSON 文字列を、**オブジェクトとして**読む。
 *
 * `JSON.parse` が通っただけでは形の保証にならない。`"null"` は素通りして `null` になり、
 * その先の `parsed.titles` が **`Cannot read properties of null (reading 'titles')`** という
 * JS の内部例外を画面に出す(利用者にはアプリが壊れたようにしか見えない)。
 * 配列や数値も同じ理由で弾く。
 */
export function parseModelJsonObject(text: string, apiLabel: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${apiLabel}の応答を解析できませんでした`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${apiLabel}から期待した形の結果が返りませんでした。もう一度お試しください。`)
  }
  return parsed as Record<string, unknown>
}
