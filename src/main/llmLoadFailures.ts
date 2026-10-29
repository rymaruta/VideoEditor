import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import {
  sameLoadEnv,
  type LlmLoadEnvStamp,
  type LlmLoadFailure,
  type LlmWorkerMessage
} from '@shared/llm'

/**
 * このPCで読み込めなかった(読み込みの途中で解析のプロセスが落ちた)AI のモデルの記録。
 * 次からは同じモデルを試さず、すぐ簡易の判定へ回す(毎回ダウンロード・読み込みを待たせて落ちない)。
 * 記録には落ちたときの環境(アプリの版・GPU の種類・GPU と PC のメモリ)を入れ、変わったら効かない。
 * 利用者は自動編集の画面の「このPCの AI をもう一度試す」で消せる。
 * 読めない・壊れたファイル、環境の無い古い記録は記録なしとして扱う(試すだけなので害はない)。
 */
export class LlmLoadFailures {
  constructor(private readonly path: string) {}

  list(): LlmLoadFailure[] {
    try {
      if (!existsSync(this.path)) return []
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw.filter(isFailure)
    } catch {
      return []
    }
  }

  /** 今の環境で効く記録(版・PC のメモリが同じもの。GPU は解析のプロセスが比べる) */
  current(appVersion: string, ramGb: number): LlmLoadFailure[] {
    return this.list().filter(
      (f) => f.env.appVersion === appVersion && Math.abs(f.env.ramGb - ramGb) < 0.5
    )
  }

  add(uri: string, label: string, env: LlmLoadEnvStamp, now = new Date()): void {
    const next = [
      ...this.list().filter((f) => !(f.uri === uri && sameLoadEnv(f.env, env))),
      { uri, label, at: now.toISOString(), env }
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

function isFailure(f: unknown): f is LlmLoadFailure {
  if (!f || typeof f !== 'object') return false
  const x = f as Partial<LlmLoadFailure>
  const env = x.env as Partial<LlmLoadEnvStamp> | undefined
  return (
    typeof x.uri === 'string' &&
    typeof x.label === 'string' &&
    typeof x.at === 'string' &&
    !!env &&
    typeof env.appVersion === 'string' &&
    typeof env.gpu === 'string' &&
    typeof env.vramGb === 'number' &&
    typeof env.ramGb === 'number'
  )
}

/** 読み込み中のモデル */
export interface LoadingModel {
  uri?: string
  label: string
  gpu: string
  vramGb: number
  /** モデルのファイル(ダウンロードを終えたもの) */
  path?: string
}

/**
 * 読み込めなかったモデルのファイルを消す(次からは試さないので、数 GB を残さない)。
 * 消すのはモデルの置き場(`cacheDir`)の中の .gguf だけ。分割したモデル(…-00001-of-00003.gguf)は
 * 同じ組のファイルを全部消す。ダウンロード中のもの(.gguf 以外の途中のファイル)は触らない。
 * 消したファイルの名前を返す。
 */
export function deleteModelFiles(modelPath: string, cacheDir: string): string[] {
  const removed: string[] = []
  try {
    const dir = resolve(dirname(modelPath))
    const root = resolve(cacheDir)
    const rel = relative(root, dir)
    if (rel.startsWith('..') || isAbsolute(rel)) return removed
    const name = basename(modelPath)
    if (!/\.gguf$/i.test(name)) return removed
    const split = /^(.*)-\d{5}-of-(\d{5})\.gguf$/i.exec(name)
    const targets = split
      ? readdirSync(dir).filter((f) => {
          const m = /^(.*)-\d{5}-of-(\d{5})\.gguf$/i.exec(f)
          return !!m && m[1] === split[1] && m[2] === split[2]
        })
      : [name]
    for (const f of targets) {
      try {
        unlinkSync(join(dir, f))
        removed.push(f)
      } catch {
        // 消せなくても(使用中など)次の起動で困らない
      }
    }
  } catch {
    // 消せなくても困らない
  }
  return removed
}

/**
 * 解析のプロセスからの知らせを見て、いま読み込み中のモデルを持つ。
 * どのモデルかを知らせた後(device)、読み込み終わり(load の 100%)の前に落ちたら、読み込めなかったモデル。
 * ダウンロード中・答えを作っている途中で落ちたものは、読み込めないモデルとしては覚えない。
 */
export class LlmLoadTracker {
  private current: LoadingModel | null = null

  observe(m: LlmWorkerMessage): void {
    if (m.type === 'device')
      this.current = {
        uri: m.uri,
        label: m.model,
        gpu: m.device,
        vramGb: m.vramGb ?? 0,
        path: m.path
      }
    else if (m.type === 'status' && m.stage === 'load' && m.percent >= 100) this.current = null
  }

  /** 落ちたときに読み込み中だったモデル(読み込み中でなければ null) */
  loading(): LoadingModel | null {
    return this.current
  }
}

/**
 * 解析のプロセスが答えずに終わったときの扱い。
 * - canceled: 利用者が中止した
 * - quitting: アプリの終了中(終了で閉じられた。読み込めなかったとは覚えない)
 * - clean: 終了コード 0(落ちたのではない。覚えない)
 * - crashed: 異常終了。読み込み中なら、そのモデルを読み込めなかったと覚える
 */
export type LlmExitKind = 'canceled' | 'quitting' | 'clean' | 'crashed'

/**
 * 読み込みの途中で落ちたモデルを「読み込めなかった」と覚えるか。構成の区切りの確認(試験的な後段。
 * `recordLoadFailures: false`)で落ちたものは覚えない(覚えると、同じ回の場面の判定が小さいモデルに下がる)
 */
export function shouldRecordLoadFailure(options: { recordLoadFailures?: boolean }): boolean {
  return options.recordLoadFailures !== false
}

export function classifyLlmExit(e: {
  canceled: boolean
  quitting: boolean
  code: number
}): LlmExitKind {
  if (e.canceled) return 'canceled'
  if (e.quitting) return 'quitting'
  if (e.code === 0) return 'clean'
  return 'crashed'
}

/**
 * アプリの終了が決まったか。before-quit は取り消せる(閉じる前の確認で「キャンセル」)ので、
 * 取り消せない will-quit で立てる(before-quit で立てると、取り消した後に落ちたモデルを覚えなかった)。
 */
export function trackQuitting(app: {
  on(event: 'will-quit', listener: () => void): unknown
}): () => boolean {
  let quitting = false
  app.on('will-quit', () => {
    quitting = true
  })
  return () => quitting
}
