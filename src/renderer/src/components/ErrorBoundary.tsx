import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryState {
  error: Error | null
}

// Last line of defense: without this, any uncaught render error (e.g. an
// unexpected shape in an API response reaching JSX) unmounts the entire tree and
// leaves a blank window, taking all in-memory editing state with it. Autosave
// keeps running up to the crash, so a reload restores the last snapshot.
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Uncaught render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h2>予期しないエラーが発生しました</h2>
          <p className="error-boundary-message">{this.state.error.message}</p>
          <p>編集内容は自動保存されています。再読み込みすると直前の状態から再開できます。</p>
          <button className="primary-button" onClick={() => window.location.reload()}>
            再読み込み
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
