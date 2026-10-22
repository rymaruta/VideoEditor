/**
 * 自動編集の画面で、今いちばん先にやること(大きな主ボタン 1 つ + 短い説明)を決める純関数。
 * 開いた直後に、灰色の一覧と押せない「開始」だけが見えて何をすればよいか分からなかった。
 * 素材が無い・始める前・進行中・止まった・構成だけある・終わった後のそれぞれで 1 つに決める。
 * 数字は入力にあるものだけを使う(無い数字は書かない)。
 */
import { formatDuration, type StepState } from './autoEditView'

export type NextActionKind = 'no-footage' | 'ready' | 'running' | 'error' | 'rebuild' | 'done'

export type NextActionId =
  | 'newEpisode'
  | 'start'
  | 'background'
  | 'cancel'
  | 'retry'
  | 'rebuild'
  | 'finish'
  | 'export'
  | 'review'

export interface NextActionButton {
  id: NextActionId
  label: string
}

export interface NextAction {
  kind: NextActionKind
  title: string
  detail: string
  primary: NextActionButton
  /** 主ボタンの横に小さく出す(多くて 2 つ) */
  secondary: NextActionButton[]
}

export interface NextActionInput {
  /** 収録フォルダを読んだか(新しい回を作る) */
  hasScan: boolean
  /** 使う機材(カメラ・マイク)の数 */
  cameras: number
  mics: number
  running: boolean
  steps: readonly { id: string; label: string; state: StepState; percent: number; note?: string }[]
  /** 構成の場面の数(開き直した企画でも作り直せる) */
  scenes: number
  /** 仮編集の要約(できていれば) */
  roughCut: { kept: number; duration: number } | null
  openIssues: number
}

export function nextAction(input: NextActionInput): NextAction {
  const { steps, running } = input
  const review: NextActionButton[] =
    input.openIssues > 0
      ? [{ id: 'review', label: `要確認 ${input.openIssues.toLocaleString()} 件を見る` }]
      : []
  if (running) {
    const cur = steps.find((s) => s.state === 'run')
    const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length
    return {
      kind: 'running',
      title: cur ? `${cur.label}を進めています` : '自動編集を進めています',
      detail: `${done} / ${steps.length} 工程が済みました。この画面を閉じて編集画面に戻っても、裏で続きます(終わったら知らせます)。`,
      primary: { id: 'background', label: '編集画面に戻って待つ' },
      secondary: [{ id: 'cancel', label: '中止' }]
    }
  }
  const failed = steps.find((s) => s.state === 'error')
  const canStart = input.hasScan && input.cameras + input.mics > 0
  if (failed) {
    return {
      kind: 'error',
      title: `「${failed.label}」で止まりました`,
      detail: failed.note
        ? `${failed.note}。直してから、もう一度始めてください。`
        : '原因を確かめてから、もう一度始めてください(ログのタブに記録があります)。',
      primary: canStart
        ? { id: 'retry', label: 'もう一度始める' }
        : { id: 'newEpisode', label: '収録フォルダを選ぶ…' },
      secondary: input.roughCut ? [{ id: 'finish', label: '今の仮編集で仕上げる' }] : []
    }
  }
  if (input.roughCut) {
    return {
      kind: 'done',
      title: '仮編集ができました',
      detail: `${input.roughCut.kept.toLocaleString()} 場面を残し、仕上がりは ${formatDuration(input.roughCut.duration)} です。${input.openIssues > 0 ? '自信の低い所を確かめてから、' : ''}編集画面で仕上げて書き出してください。`,
      primary: { id: 'finish', label: '編集画面で仕上げる' },
      secondary: [...review, { id: 'export', label: '書き出す' }]
    }
  }
  if (input.scenes > 0) {
    return {
      kind: 'rebuild',
      title: '構成ができています',
      detail: `${input.scenes.toLocaleString()} 場面の判定があります。残す場面を確かめて、仮編集を作ってください。`,
      primary: { id: 'rebuild', label: '仮編集を作る' },
      secondary: review
    }
  }
  if (canStart) {
    const started = steps.some((s) => s.state !== 'wait')
    const gear = [
      input.cameras > 0 ? `カメラ ${input.cameras} 台` : '',
      input.mics > 0 ? `マイク ${input.mics} 本` : ''
    ]
      .filter(Boolean)
      .join('・')
    return {
      kind: 'ready',
      title: started ? 'もう一度始められます' : '準備ができました',
      detail: `${gear}を読み込みました。同期から文字起こし・構成・仮編集・テロップまで自動で進めます。`,
      primary: { id: 'start', label: started ? 'もう一度始める' : '自動編集を始める' },
      secondary: []
    }
  }
  return {
    kind: 'no-footage',
    title: '収録フォルダを選んでください',
    detail:
      'カメラ・ピンマイクの録画が入ったフォルダを選ぶと、機材ごとに振り分けて自動編集の準備をします。',
    primary: { id: 'newEpisode', label: '収録フォルダを選ぶ…' },
    secondary: []
  }
}
