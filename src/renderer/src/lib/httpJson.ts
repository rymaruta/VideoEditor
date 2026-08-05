/**
 * Reads a JSON API response defensively.
 *
 * Calling `res.json()` before checking `res.ok` means an error response that is
 * not JSON — a proxy's HTML 502 page, an empty body, a rate-limit page — throws a
 * raw `SyntaxError` ("Unexpected token '<'..."), which is what the user ends up
 * seeing instead of anything actionable. Read the body once as text, then decide.
 */
export async function readJsonResponse<T>(res: Response, apiLabel: string): Promise<T> {
  const raw = await res.text()
  let parsed: unknown = undefined
  if (raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
  }

  if (parsed === undefined) {
    if (!res.ok) {
      throw new Error(`${apiLabel}がエラーを返しました (HTTP ${res.status} ${res.statusText})`)
    }
    throw new Error(`${apiLabel}の応答を解析できませんでした`)
  }
  return parsed as T
}
