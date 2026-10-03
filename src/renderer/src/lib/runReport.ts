import type { StepId, StepStatus } from '../store/pipelineStore'
import type { SystemInfo } from '@shared/systemInfo'

/** かかった時間(1分以上は分と秒) */
export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s >= 3600)
    return `${Math.floor(s / 3600)}時間${String(Math.floor(s / 60) % 60).padStart(2, '0')}分`
  return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`
}

const STATE_LABEL: Record<StepStatus['state'], string> = {
  wait: '待機',
  run: '実行中',
  done: '完了',
  error: 'エラー',
  skipped: '省略'
}

/**
 * 処理の記録(実機での処理時間を測って、遅い工程から速くするための材料)。
 * 工程ごとの時間・使った装置・素材の量・PC の構成・ログを、1つの文章にまとめる。
 */
export function buildRunReport(input: {
  episode: string
  steps: { id: StepId; label: string; status: StepStatus }[]
  footage: { cameras: number; mics: number; totalSec: number; longestSec: number }
  system: SystemInfo | null
  log: { time: number; text: string }[]
  now?: Date
}): string {
  const lines: string[] = []
  const now = input.now ?? new Date()
  lines.push(`処理の記録 — ${input.episode}`)
  lines.push(`作成: ${now.toLocaleString()}`)
  lines.push('')
  lines.push('■ 素材')
  lines.push(
    `カメラ ${input.footage.cameras} 台 · マイク ${input.footage.mics} 本 · 合計 ${formatElapsed(input.footage.totalSec * 1000)}(一番長い機材 ${formatElapsed(input.footage.longestSec * 1000)})`
  )
  lines.push('')
  lines.push('■ 工程ごとの時間')
  let total = 0
  for (const s of input.steps) {
    const ms = s.status.elapsedMs
    if (ms !== undefined) total += ms
    lines.push(
      `${s.label}\t${STATE_LABEL[s.status.state]}\t${ms !== undefined ? formatElapsed(ms) : '—'}\t${s.status.note ?? ''}`
    )
  }
  lines.push(`合計\t\t${formatElapsed(total)}`)
  if (input.footage.longestSec > 0 && total > 0)
    lines.push(
      `収録の長さに対する処理時間: ${((total / 1000 / input.footage.longestSec) * 100).toFixed(0)}%(目標: 収録4時間を1時間以内 = 25%)`
    )
  lines.push('')
  lines.push('■ PC')
  if (input.system) {
    lines.push(`OS: ${input.system.os}`)
    lines.push(`CPU: ${input.system.cpu}(${input.system.cores} スレッド)`)
    lines.push(`メモリ: ${input.system.memoryGb} GB`)
    lines.push(`GPU: ${input.system.gpu.join(' / ') || '不明'}`)
    lines.push(`アプリ: ${input.system.app}`)
  } else lines.push('(取得できませんでした)')
  lines.push('')
  lines.push('■ ログ')
  for (const l of input.log) lines.push(`${new Date(l.time).toLocaleTimeString()}\t${l.text}`)
  return lines.join('\n') + '\n'
}
