import { reportError } from '../diagnostics'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ChevronDown, TriangleAlert } from 'lucide-react'

export function isModuleLoadError(error: Error): boolean {
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk .* failed/i.test(error.message)
}

/** Keep a broken conversation from unmounting the sidebar and the whole app. */
export class ChatErrorBoundary extends Component<{ children: ReactNode; root?: boolean; fallbackText?: string }, { error?: Error; open: boolean }> {
  state: { error?: Error; open: boolean } = { open: false }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(this.props.root ? 'app.render-error' : 'chat.render-error', error, info.componentStack || '')
    console.error('[foundry] Chat rendering failed', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    const moduleFailure = isModuleLoadError(this.state.error)
    const inline = this.props.fallbackText !== undefined
    return <div className={inline ? 'message-render-error' : `chat-render-error${this.props.root ? ' messenger' : ''}`}>
      {inline && <span className="message-plain-fallback">{this.props.fallbackText}</span>}
      <div className={`system-message is-error ${this.state.open ? 'is-open' : ''}`} role="alert">
        <div className="system-line">
          <TriangleAlert size={13} />
          <div className="system-summary">
            <strong>{moduleFailure ? '消息显示组件加载失败' : inline ? '消息格式暂时无法显示' : '这个聊天暂时无法显示'}</strong>
            <div className="system-guidance"><span>{inline ? '已保留消息原文。' : '聊天记录未被删除。'}{moduleFailure ? '重新加载窗口后可重试。' : '可以重试，或切换到其他聊天。'}</span></div>
          </div>
          <button type="button" className="system-toggle" aria-expanded={this.state.open} onClick={() => this.setState({ open: !this.state.open })}>
            {this.state.open ? '收起' : '详情'}<ChevronDown size={11} className={this.state.open ? 'open' : ''} />
          </button>
        </div>
        {this.state.open && <div className="system-detail"><pre>{this.state.error.message || String(this.state.error)}</pre></div>}
        <div className="system-detail-actions">
          {moduleFailure || this.props.root
            ? <button type="button" className="system-copy" onClick={() => window.location.reload()}>重新加载窗口</button>
            : <button type="button" className="system-copy" onClick={() => this.setState({ error: undefined, open: false })}>重试</button>}
        </div>
      </div>
    </div>
  }
}
