/**
 * 自動編集の画面で、今いちばん先にやること(大きな主ボタン 1 つ + 短い説明)を決める純関数。
 * 開いた直後に、灰色の一覧と押せない「開始」だけが見えて何をすればよいか分からなかった。
 * 素材が無い・始める前・進行中・止まった・構成だけある・終わった後のそれぞれで 1 つに決める。
 * 数字は入力にあるものだけを使う(無い数字は書かない)。
 *
 * 失敗には 2 種類ある(pipelineStore):
 * - 続けて進む失敗: 色合わせ・ノイズ除去・笑い/歓声の検出・発言テロップの配置・演出テロップの提案・
 *   SE/BGM/CG。工程は先へ進み、仮編集はできる。「止まりました」にせず、できなかったことを添える
 * - 止まる失敗: 取り込み・同期・文字起こし など(以後の工程が動かない)と、仮編集の作り直しの失敗
 *   (カット・アングル)。作り直しの失敗は「作り直す」を主にする(全部やり直さない)
 * 「もう一度始める」(runPipeline)は前の結果と手で決めた残す/落とすを捨てて全部やり直すので、
 * 手で決めたものがあるときは確かめる(`confirm`)。
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
  /** 押す前に確かめる文(手で決めたものを捨てる操作) */
  confirm?: string
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
  /** 収録フォルダを読んだか(新しい回を作る)。開き直した企画では無い */
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
  /** 手で決めた残す / 落とすの数(やり直すと消える) */
  manualKeep?: number
}

/** 失敗しても工程が先へ進む工程(pipelineStore で失敗を記録して続ける所) */
export const CONTINUE_ON_ERROR: ReadonlySet<string> = new Set([
  'color',
  'denoise',
  'events',
  'placement',
  'effects',
  'sound'
])

/** 仮編集の作り直しで失敗する工程(作り直せば直る) */
const REBUILD_ERRORS: ReadonlySet<string> = new Set(['cut', 'angles'])

export const RESTART_CONFIRM =
  'もう一度始めると、同期からすべてやり直します。手で決めた残す/落とすは消えます(仮編集を作り直すだけなら「仮編集を作り直す」)。\n\n始めますか?'

export function nextAction(input: NextActionInput): NextAction {
  const { steps, running } = input
  const review: NextActionButton[] =
    input.openIssues > 0
      ? [{ id: 'review', label: `要確認 ${input.openIssues.toLocaleString()} 件を見る` }]
      : []
  const restartConfirm = (input.manualKeep ?? 0) > 0 ? RESTART_CONFIRM : undefined
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
  const canStart = input.hasScan && input.cameras + input.mics > 0
  const errors = steps.filter((s) => s.state === 'error')
  const stopped = errors.find((s) => !CONTINUE_ON_ERROR.has(s.id))
  const soft = errors.filter((s) => CONTINUE_ON_ERROR.has(s.id))
  const softNote =
    soft.length > 0
      ? `(${soft.map((s) => s.label).join('・')}はできませんでした。ログのタブに理由があります)`
      : ''

  if (stopped) {
    const why = stopped.note ? `${stopped.note}。` : ''
    // 作り直しの失敗: 作り直す(全部はやり直さない)
    if (REBUILD_ERRORS.has(stopped.id) && input.scenes > 0) {
      return {
        kind: 'error',
        title: `「${stopped.label}」で止まりました`,
        detail: `${why}残す場面を確かめて、仮編集を作り直してください。`,
        primary: { id: 'rebuild', label: '仮編集を作り直す' },
        secondary: input.roughCut ? [{ id: 'finish', label: '今の仮編集で仕上げる' }] : []
      }
    }
    if (canStart) {
      return {
        kind: 'error',
        title: `「${stopped.label}」で止まりました`,
        detail: `${why}直してから、もう一度始めてください。`,
        primary: {
          id: 'retry',
          label: 'もう一度始める',
          ...(restartConfirm ? { confirm: restartConfirm } : {})
        },
        secondary: input.roughCut ? [{ id: 'finish', label: '今の仮編集で仕上げる' }] : []
      }
    }
    // 開き直した企画(収録フォルダを読んでいない): 企画に残っている物で続ける
    if (input.roughCut || input.scenes > 0) {
      return {
        kind: 'error',
        title: `「${stopped.label}」で止まりました`,
        detail: `${why}${input.roughCut ? '今の仮編集で仕上げられます。' : '残っている構成から仮編集を作れます。'}工程を最初からやり直すには、ファイル > 新しい回を作る… で収録フォルダを指定してください。`,
        primary: input.roughCut
          ? { id: 'finish', label: '今の仮編集で仕上げる' }
          : { id: 'rebuild', label: '仮編集を作る' },
        secondary: [{ id: 'newEpisode', label: '収録フォルダを選ぶ…' }]
      }
    }
    return {
      kind: 'error',
      title: `「${stopped.label}」で止まりました`,
      detail: `${why}収録フォルダを選び直して、もう一度始めてください。`,
      primary: { id: 'newEpisode', label: '収録フォルダを選ぶ…' },
      secondary: []
    }
  }

  if (input.roughCut) {
    return {
      kind: 'done',
      title: '仮編集ができました',
      detail: `${input.roughCut.kept.toLocaleString()} 場面を残し、仕上がりは ${formatDuration(input.roughCut.duration)} です。${softNote}${input.openIssues > 0 ? '自信の低い所を確かめてから、' : ''}編集画面で仕上げて書き出してください。`,
      primary: { id: 'finish', label: '編集画面で仕上げる' },
      secondary: [...review, { id: 'export', label: '書き出す' }]
    }
  }
  if (input.scenes > 0) {
    return {
      kind: 'rebuild',
      title: '構成ができています',
      detail: `${input.scenes.toLocaleString()} 場面の判定があります。${softNote}残す場面を確かめて、仮編集を作ってください。`,
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
      primary: {
        id: 'start',
        label: started ? 'もう一度始める' : '自動編集を始める',
        ...(started && restartConfirm ? { confirm: restartConfirm } : {})
      },
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
