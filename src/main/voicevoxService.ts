import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
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

  // **ここも `try` で包む。** 上2つの `fetch` だけ包んでいて、合成の呼び出しだけ
  // 素通しだった。合成は音声を作るぶん一番時間がかかる=**その最中に VOICEVOX を
  // 閉じられる可能性が一番高い**呼び出しなのに、そこだけ生の
  // `TypeError: fetch failed`(23文字・日本語なし)が画面に出ていた。
  // 本文の読み出し(`arrayBuffer`)も同じ接続の上なので、まとめて包む。
  let synthRes: Response
  try {
    synthRes = await fetch(`${ENGINE_BASE}/synthesis?speaker=${speakerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query)
    })
  } catch (e) {
    throw connectionError(e)
  }
  if (!synthRes.ok) {
    throw new Error(`音声合成に失敗しました (status ${synthRes.status})`)
  }

  let buf: Buffer
  try {
    buf = Buffer.from(await synthRes.arrayBuffer())
  } catch (e) {
    throw connectionError(e)
  }
  // Narration is saved project content, not scratch: writing it to the OS temp
  // directory meant a reboot (which clears /tmp) silently emptied the narration
  // track of any project that referenced it.
  const dir = join(app.getPath('userData'), 'narration')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const outPath = join(dir, `narration-${randomUUID()}.wav`)
  writeFileSync(outPath, buf)
  return outPath
}
