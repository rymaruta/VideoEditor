import { Component, type ErrorInfo, type ReactNode } from 'react'

interface PanelBoundaryState {
  error: Error | null
}

/**
 * パネル1つぶんのエラーの受け止め役。
 *
 * これまで受け止め役はアプリ全体に1つ(`ErrorBoundary`)だけで、どこか1つのパネルが描画中に
 * 落ちると(想定外の形の値・壊れた企画の一部など)、**プレビューもタイムラインも丸ごと消えて
 * 再読み込みしか手が無かった**。編集中の取り消し履歴もそこで失われる。
 * パネルごとに包めば、落ちたパネルだけが「表示できませんでした」になり、ほかのパネルで
 * 保存・書き出し・取り消しを続けられる。「もう一度表示する」で、そのパネルだけ描き直す
 * (取り消しで原因の値を戻してから押せば、そのまま復帰する)。
 */
export class PanelBoundary extends Component<
  { name: string; children: ReactNode },
  PanelBoundaryState
> {
  state: PanelBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PanelBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`パネル「${this.props.name}」の描画エラー:`, error, info.componentStack)
  }

  retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="panel-error" role="alert">
        <p className="panel-error-title">「{this.props.name}」を表示できませんでした</p>
        <p className="panel-error-message">{error.message || String(error)}</p>
        <p className="panel-error-note">
          ほかのパネルはそのまま使えます。直前の操作を取り消してから、もう一度表示してください。
        </p>
        <button type="button" className="small-button" onClick={this.retry}>
          もう一度表示する
        </button>
      </div>
    )
  }
}
