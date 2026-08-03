import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { VoicevoxSpeaker } from '@shared/types'

const ENGINE_BASE = 'http://127.0.0.1:50021'

interface RawStyle {
  id: number
  name: string
}

interface RawSpeaker {
  name: string
  styles: RawStyle[]
}

function connectionError(e: unknown): Error {
  return new Error(
    `VOICEVOX Engineに接続できません。VOICEVOX(https://voicevox.hiroshiba.jp/)を起動してから再度お試しください。 (${
      e instanceof Error ? e.message : String(e)
    })`
  )
}

export async function listSpeakers(): Promise<VoicevoxSpeaker[]> {
  let res: Response
  try {
    res = await fetch(`${ENGINE_BASE}/speakers`)
  } catch (e) {
    throw connectionError(e)
  }
  if (!res.ok) throw new Error(`VOICEVOX Engineがエラーを返しました (status ${res.status})`)
  const data = (await res.json()) as RawSpeaker[]
  return data.map((s) => ({
    name: s.name,
    styles: s.styles.map((st) => ({ id: st.id, name: st.name }))
  }))
}

export async function synthesizeSpeech(text: string, speakerId: number): Promise<string> {
  let queryRes: Response
  try {
    queryRes = await fetch(
      `${ENGINE_BASE}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: 'POST' }
    )
  } catch (e) {
    throw connectionError(e)
  }
  if (!queryRes.ok) {
    throw new Error(`音声クエリの生成に失敗しました (status ${queryRes.status})`)
  }
  const query = await queryRes.json()

  const synthRes = await fetch(`${ENGINE_BASE}/synthesis?speaker=${speakerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query)
  })
  if (!synthRes.ok) {
    throw new Error(`音声合成に失敗しました (status ${synthRes.status})`)
  }

  const buf = Buffer.from(await synthRes.arrayBuffer())
  const dir = mkdtempSync(join(tmpdir(), 've-voicevox-'))
  const outPath = join(dir, `narration-${Date.now()}.wav`)
  writeFileSync(outPath, buf)
  return outPath
}
