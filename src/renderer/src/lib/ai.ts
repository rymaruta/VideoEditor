import type { AiProvider, LlmRequest } from '@shared/llm'
import { fetchJson, parseModelJsonObject } from './httpJson'

/**
 * 構成の判定・演出テロップの提案で、AI に JSON を答えさせる(頼み先は設定で選ぶ)。
 * - local: このPCの AI(`window.api.llmRun`)。出力の形はスキーマで縛られる
 * - gemini: Gemini API(鍵が要る)。出力の形は文面で頼む
 * 答えられなかった頼みは null。
 */

const GEMINI_MODEL = 'gemini-flash-latest'

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

export interface AiProgress {
  note: string
  percent: number
}

/**
 * Gemini に頼んでいる途中の問い合わせ。自動編集の「中止」で止める(止めないと、残りの区切りを
 * 全部問い合わせ終えるまで(1件数秒)中止が効かなかった)
 */
let geminiAbort: AbortController | null = null

/** 頼んでいる途中の Gemini の問い合わせを止める(このPCの AI は `window.api.llmCancel`) */
export function cancelAiRequests(): void {
  geminiAbort?.abort()
}

export async function askAiJson(
  provider: Exclude<AiProvider, 'off'>,
  apiKey: string,
  requests: LlmRequest[],
  onProgress?: (p: AiProgress) => void
): Promise<{ results: (unknown | null)[]; device?: string; model?: string }> {
  if (provider === 'local') {
    let device: string | undefined
    let model: string | undefined
    const off = window.api.onLlmProgress((m) => {
      if (m.type === 'status') onProgress?.({ note: m.note, percent: m.percent })
      else if (m.type === 'device') {
        device = m.device
        model = m.model
      } else if (m.type === 'progress')
        onProgress?.({
          note: `AI が判定中(${m.done}/${m.total})`,
          percent: (m.done / Math.max(1, m.total)) * 100
        })
    })
    try {
      return { results: await window.api.llmRun(requests), device, model }
    } catch (e) {
      // Electron が付ける前置き(Error invoking remote method 'llm:run': Error: …)を外して、理由だけにする
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      off()
    }
  }
  const abort = new AbortController()
  geminiAbort = abort
  try {
    return { results: await askGemini(apiKey, requests, abort.signal, onProgress), model: 'Gemini' }
  } finally {
    if (geminiAbort === abort) geminiAbort = null
  }
}

async function askGemini(
  apiKey: string,
  requests: LlmRequest[],
  signal: AbortSignal,
  onProgress?: (p: AiProgress) => void
): Promise<(unknown | null)[]> {
  const results: (unknown | null)[] = []
  for (let i = 0; i < requests.length; i++) {
    if (signal.aborted) throw new Error('LLM_CANCELED')
    onProgress?.({
      note: `AI が判定中(${i + 1}/${requests.length})`,
      percent: (i / requests.length) * 100
    })
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
    let data: GeminiResponse
    try {
      data = await fetchJson<GeminiResponse>(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: requests[i].prompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
          }),
          signal
        },
        'Gemini API'
      )
    } catch (e) {
      // 中止で切った問い合わせは「接続できませんでした」ではなく中止
      if (signal.aborted) throw new Error('LLM_CANCELED')
      throw e
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    // 1件の答えが壊れていても(途中で切れた・オブジェクトでない)、その件だけ答え無しにする
    // (投げると、ほかの件のちゃんとした答えまで捨てることになる。このPCの AI と同じ扱い)
    let parsed: unknown = null
    try {
      parsed = text ? parseModelJsonObject(text, 'Gemini API') : null
    } catch {
      parsed = null
    }
    results.push(parsed)
  }
  return results
}
