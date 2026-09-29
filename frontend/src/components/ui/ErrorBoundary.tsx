import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'

interface Props { children: ReactNode; onReload?: () => void }

/** Catches render/lazy-load errors (e.g. a chunk 404 after a deploy) so one
 *  panel failing can't unmount the whole React root into a white screen. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('ErrorBoundary caught', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    const reload = this.props.onReload ?? (() => location.reload())
    return (
      <div className="h-full w-full flex items-center justify-center p-4">
        <button type="button" onClick={reload}
          className="ctl inline-flex items-center gap-1.5 px-3 rounded-[var(--r-md)] border border-[var(--border)] text-ui-sm text-[var(--fg)] hover:bg-[var(--surface-hover)]">
          <RefreshCw size={14} />出错了,点此刷新
        </button>
      </div>
    )
  }
}
