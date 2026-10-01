import { Component, type ReactNode } from 'react'

/** A broken panel shows its error and a way back instead of taking the whole window down. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="absolute inset-0 z-50 flex items-center justify-center">
        <div className="glass max-w-lg rounded-2xl p-6">
          <div className="font-display text-lg font-bold text-red-200">Something broke in the interface</div>
          <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs text-red-100/80">{this.state.error.message}</pre>
          <button className="btn btn-primary mt-4" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    )
  }
}
