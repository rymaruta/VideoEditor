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
  const results: (unknown | null)[] = []
  for (let i = 0; i < requests.length; i++) {
    onProgress?.({
      note: `AI が判定中(${i + 1}/${requests.length})`,
      percent: (i / requests.length) * 100
    })
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
    const data = await fetchJson<GeminiResponse>(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: requests[i].prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      },
      'Gemini API'
    )
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    results.push(text ? parseModelJsonObject(text, 'Gemini API') : null)
  }
  return { results, model: 'Gemini' }
}
