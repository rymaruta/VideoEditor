/**
 * 取り消し・やり直しの振り分け(メニュー・上の帯のボタン・キーで同じ扱いにする)。
 * - 文字を打っている欄にフォーカスがあれば、欄の取り消し(文字単位。execCommand)
 * - ダイアログの上なら何もしない(裏のプロジェクトを取り消さない)
 * - それ以外はプロジェクトの取り消し
 */
export interface UndoDeps {
  /** フォーカスのある要素が文字を打つ欄か */
  typing: boolean
  modalOpen: boolean
  execCommand: (cmd: 'undo' | 'redo') => unknown
  undo: () => void
  redo: () => void
}

export type UndoRoute = 'field' | 'blocked' | 'project'

export function performUndoRedo(kind: 'undo' | 'redo', deps: UndoDeps): UndoRoute {
  if (deps.typing) {
    deps.execCommand(kind)
    return 'field'
  }
  if (deps.modalOpen) return 'blocked'
  if (kind === 'undo') deps.undo()
  else deps.redo()
  return 'project'
}

/**
 * 上の帯の取り消し・やり直しのボタン。フォーカスがどこにあっても(文字の欄・選択欄・数値欄でも)
 * プロジェクトの取り消しにする。欄の文字単位の取り消しはキーとメニューだけ。ダイアログの上では何もしない
 */
export function workflowBarUndo(
  kind: 'undo' | 'redo',
  deps: { modalOpen: boolean; undo: () => void; redo: () => void }
): 'blocked' | 'project' {
  if (deps.modalOpen) return 'blocked'
  if (kind === 'undo') deps.undo()
  else deps.redo()
  return 'project'
}

/** ボタンの見出しに出すキー(mac は Cmd、ほかは Ctrl) */
export function modifierLabel(userAgent: string): 'Cmd' | 'Ctrl' {
  return /Mac/i.test(userAgent) ? 'Cmd' : 'Ctrl'
}
