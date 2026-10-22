import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import type { LlmLoadFailure, LlmWorkerMessage } from '@shared/llm'

/**
 * このPCで読み込めなかった(読み込みの途中で解析のプロセスが落ちた)AI のモデルの記録。
 * 次からは同じモデルを試さず、すぐ簡易の判定へ回す(毎回ダウンロード・読み込みを待たせて落ちない)。
 * 利用者は自動編集の画面の「このPCの AI をもう一度試す」で消せる(GPU を足した・メモリを増やした等)。
 * 読めない・壊れたファイルは記録なしとして扱う(試すだけなので害はない)。
 */
export class LlmLoadFailures {
  constructor(private readonly path: string) {}

  list(): LlmLoadFailure[] {
    try {
      if (!existsSync(this.path)) return []
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw.filter(
        (f): f is LlmLoadFailure =>
          !!f &&
          typeof f === 'object' &&
          typeof (f as LlmLoadFailure).uri === 'string' &&
          typeof (f as LlmLoadFailure).label === 'string' &&
          typeof (f as LlmLoadFailure).at === 'string'
      )
    } catch {
      return []
    }
  }

  has(uri: string): boolean {
    return this.list().some((f) => f.uri === uri)
  }

  add(uri: string, label: string, now = new Date()): void {
    const next = [
      ...this.list().filter((f) => f.uri !== uri),
      { uri, label, at: now.toISOString() }
    ].slice(-20)
    this.write(next)
  }

  clear(): void {
    try {
      if (existsSync(this.path)) unlinkSync(this.path)
    } catch {
      // 消せなければ空で上書き
      this.write([])
    }
  }

  private write(list: LlmLoadFailure[]): void {
    try {
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
      renameSync(tmp, this.path)
    } catch {
      // 覚えられなくても、次にまた試して落ちるだけ(本体は落ちない)
    }
  }
}

/**
 * 解析のプロセスからの知らせを見て、いま読み込み中のモデルを持つ。
 * どのモデルかを知らせた後(device)、読み込み終わり(load の 100%)の前に落ちたら、読み込めなかったモデル。
 * ダウンロード中・答えを作っている途中で落ちたものは、読み込めないモデルとしては覚えない。
 */
export class LlmLoadTracker {
  private current: { uri?: string; label: string } | null = null

  observe(m: LlmWorkerMessage): void {
    if (m.type === 'device') this.current = { uri: m.uri, label: m.model }
    else if (m.type === 'status' && m.stage === 'load' && m.percent >= 100) this.current = null
  }

  /** 落ちたときに読み込み中だったモデル(読み込み中でなければ null) */
  loading(): { uri?: string; label: string } | null {
    return this.current
  }
}
