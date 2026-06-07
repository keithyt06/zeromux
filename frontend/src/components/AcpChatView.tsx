import { useState, useEffect, useRef, useCallback, memo, createElement } from 'react'
import { wsUrl } from '../lib/api'
import { ChevronDown, Wrench, Brain, AlertCircle, FileText, Terminal, Search, Bot, type LucideIcon } from 'lucide-react'
import MarkdownContent from './markdown/MarkdownContent'
import Composer from './Composer'
import { MicButton } from './MicButton'
import { useTranscribe } from '../lib/transcribe'

// ── Message types ──

interface BaseMsg { id: string }
interface SystemMsg    extends BaseMsg { kind: 'system'; text: string }
interface UserMsg      extends BaseMsg { kind: 'user'; text: string }
interface AssistantMsg extends BaseMsg {
  kind: 'assistant'
  blocks: ContentBlock[]
  cost?: number
  complete: boolean
}
interface ErrorMsg     extends BaseMsg { kind: 'error'; text: string }

type ChatMessage = SystemMsg | UserMsg | AssistantMsg | ErrorMsg

const newId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  name?: string
  input?: any
  summary?: string
}

// ── Server events ──

interface ServerEvent {
  type: string
  subtype?: string
  session_id?: string
  block_type?: string
  text?: string
  name?: string
  input?: any
  cost_usd?: number
  message?: string
  code?: number
  streaming?: boolean
  summary?: string
}

interface Props {
  sessionId: string
  active: boolean
  agentType?: 'claude' | 'kiro' | 'codex'
}

// `active` is accepted (App passes it for all session views) but no longer used:
// the Composer owns its own textarea and we intentionally don't auto-focus it,
// so switching to a chat session doesn't pop the mobile keyboard.
export default function AcpChatView({ sessionId, agentType = 'claude' }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [turnStartedMs, setTurnStartedMs] = useState<number | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentAssistant = useRef<AssistantMsg | null>(null)

  const transcribe = useTranscribe({
    language: 'zh-CN',
    onFinal: (text) => setInput(prev => prev + text),
  })

  const scrollBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    })
  }, [])

  const pushMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => [...prev, msg])
    scrollBottom()
  }, [scrollBottom])

  useEffect(() => {
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(wsUrl(`/ws/acp/${sessionId}`))
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        // The server replays full scrollback on (re)connect, so start clean to
        // avoid duplicating already-rendered messages. Matches page-reload behavior.
        setMessages([])
        currentAssistant.current = null
        setBusy(false)
        setTurnStartedMs(null)
      }

      ws.onmessage = (evt) => {
        try {
          const msg: ServerEvent = JSON.parse(evt.data)
          handleEvent(msg)
        } catch { /* ignore */ }
      }

      ws.onclose = () => {
        wsRef.current = null
        const activeId = currentAssistant.current?.id
        if (activeId) {
          setMessages(prev => prev.map(m =>
            m.kind === 'assistant' && m.id === activeId ? { ...m, complete: true } : m
          ))
        }
        currentAssistant.current = null
        setBusy(false)
        setTurnStartedMs(null)
        // Auto-reconnect: an idle-timeout proxy or transient drop must not leave
        // the session permanently unable to send. Reconnect re-runs ensure_running
        // server-side and replays scrollback. Exponential backoff, capped at 10s.
        if (!disposed) {
          const delay = Math.min(1000 * 2 ** attempt, 10000)
          attempt += 1
          retryTimer = setTimeout(connect, delay)
        }
      }
      ws.onerror = () => { ws.close() }
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      wsRef.current?.close()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleEvent = useCallback((evt: ServerEvent) => {
    switch (evt.type) {
      case 'system': {
        const labelMap: Record<string, string> = {
          init: 'session ready',
          resume_failed: '⚠ 上下文恢复失败，已重置为新会话',
        }
        const label = labelMap[evt.subtype || ''] || evt.subtype || 'system'
        const sid = evt.session_id ? ` ${evt.session_id.substring(0, 8)}...` : ''
        pushMessage({ id: newId(), kind: 'system', text: `${label}${sid}` })
        break
      }

      case 'content_block': {
        const delta = evt.text || ''
        // Ensure there's an active assistant message
        if (!currentAssistant.current) {
          const msg: AssistantMsg = { id: newId(), kind: 'assistant', blocks: [], complete: false }
          currentAssistant.current = msg
          setMessages(prev => [...prev, msg])
        }
        const activeId = currentAssistant.current.id
        setMessages(prev => prev.map(m => {
          if (m.kind !== 'assistant' || m.id !== activeId) return m   // reference stable, memo skips
          const blocks = [...m.blocks]
          const mergeable = evt.block_type === 'text' || evt.block_type === 'thinking'
          if (evt.streaming && mergeable && blocks.length > 0
              && blocks[blocks.length - 1].type === evt.block_type) {
            const last = blocks[blocks.length - 1]
            blocks[blocks.length - 1] = { ...last, text: (last.text || '') + delta }
          } else {
            blocks.push({
              type: (evt.block_type as ContentBlock['type']) || 'text',
              text: evt.text,
              name: evt.name,
              input: evt.input,
              summary: evt.summary,
            })
          }
          // Mirror onto the ref so subsequent events still see the latest blocks.
          const next = { ...m, blocks }
          currentAssistant.current = next
          return next
        }))
        setBusy(true)
        // Stamp turn start if not already running (e.g. a turn observed from
        // another tab via replay, where this client didn't call sendPrompt).
        setTurnStartedMs(prev => prev ?? Date.now())
        scrollBottom()
        break
      }

      case 'result': {
        const activeId = currentAssistant.current?.id
        if (activeId) {
          const cost = evt.cost_usd
          const finalText = (evt.text || '').trim()
          setMessages(prev => prev.map(m => {
            if (!(m.kind === 'assistant' && m.id === activeId)) return m
            // 协议契约（见后端 AcpEvent::Result doc）：result.text 始终是
            // 完整最终文本，但本轮若已通过流式 text ContentBlock 呈现过正文，
            // 就不能再注入 result.text（否则重复渲染）。判据：blocks 里是否已
            // 存在非空 text block。
            // - Codex/Kiro 流式：已有 text block → 不注入。
            // - Codex 非流式（Bedrock thinking 一次性返回）：无 text block → 注入。
            // - Claude：assistant text block 已渲染 → 不注入。
            const hasStreamedText = m.blocks.some(
              b => b.type === 'text' && (b.text || '').length > 0,
            )
            const blocks = (finalText && !hasStreamedText)
              ? [...m.blocks, { type: 'text', text: finalText } as ContentBlock]
              : m.blocks
            return { ...m, blocks, complete: true, ...(cost ? { cost } : {}) }
          }))
        }
        currentAssistant.current = null
        setBusy(false)
        setTurnStartedMs(null)
        break
      }

      case 'error': {
        const activeId = currentAssistant.current?.id
        if (activeId) {
          setMessages(prev => prev.map(m =>
            m.kind === 'assistant' && m.id === activeId ? { ...m, complete: true } : m
          ))
        }
        pushMessage({ id: newId(), kind: 'error', text: evt.message || 'Unknown error' })
        currentAssistant.current = null
        setBusy(false)
        setTurnStartedMs(null)
        break
      }

      case 'exit': {
        const activeId = currentAssistant.current?.id
        if (activeId) {
          setMessages(prev => prev.map(m =>
            m.kind === 'assistant' && m.id === activeId ? { ...m, complete: true } : m
          ))
        }
        pushMessage({ id: newId(), kind: 'system', text: `Process exited (code: ${evt.code || 0})` })
        currentAssistant.current = null
        setBusy(false)
        setTurnStartedMs(null)
        break
      }

      case 'replay_done': {
        const activeId = currentAssistant.current?.id
        if (activeId) {
          setMessages(prev => prev.map(m =>
            m.kind === 'assistant' && m.id === activeId ? { ...m, complete: true } : m
          ))
        }
        currentAssistant.current = null
        setBusy(false)
        setTurnStartedMs(null)
        break
      }
    }
  }, [pushMessage, scrollBottom])

  // Composer 已 trim 且非空才回调；后端 fan-out 会在重发前自动打断在途轮次，
  // 前端只需发 prompt。
  const sendPrompt = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    pushMessage({ id: newId(), kind: 'user', text })
    wsRef.current.send(JSON.stringify({ type: 'prompt', text }))
    setInput('')
    setBusy(true)
    setTurnStartedMs(Date.now())
  }, [pushMessage])

  // Stuck-turn timer: tick a 1s clock while busy so the elapsed display
  // updates. turnStartedMs is stamped in the event handlers (turn start) and
  // cleared at turn end — set-state lives in handlers, not in this effect.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])

  const elapsed = turnStartedMs ? Math.floor((nowMs - turnStartedMs) / 1000) : 0
  const stuck = elapsed > 180

  const interrupt = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'interrupt' }))
    }
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {messages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} agentName={agentType === 'kiro' ? 'Kiro' : agentType === 'codex' ? 'Codex' : 'Claude'} />
        ))}
      </div>

      <div className="flex flex-col px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        {(transcribe.partial || transcribe.error) && (
          <div className="px-2 pb-1 text-xs italic text-[var(--text-muted)]">
            {transcribe.error
              ? <span className="text-[var(--accent-red)]">⚠ {transcribe.error}</span>
              : transcribe.partial}
          </div>
        )}
        {busy && (
          <div className="flex items-center gap-2 px-2 pb-1 text-xs">
            {stuck ? (
              <>
                <span className="text-[var(--accent-red)]">已运行 {elapsed}s，可能卡住</span>
                <button
                  onClick={interrupt}
                  className="px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-red)] border border-[var(--accent-red)] rounded hover:bg-[var(--accent-red)] hover:text-white transition-colors"
                >
                  中断
                </button>
              </>
            ) : (
              <span className="text-[var(--text-muted)] italic">已运行 {elapsed}s…</span>
            )}
          </div>
        )}
        <Composer
          value={input}
          onChange={setInput}
          onSend={sendPrompt}
          submitOnEnter={true}
          placeholder={`Send a message to ${agentType === 'kiro' ? 'Kiro' : agentType === 'codex' ? 'Codex' : 'Claude'}...`}
          rightSlot={
            <MicButton
              isRecording={transcribe.isRecording}
              supported={transcribe.supported}
              onPressStart={transcribe.start}
              onPressEnd={transcribe.stop}
            />
          }
        />
      </div>
    </div>
  )
}

// ── Message rendering ──

function MessageBubbleImpl({ msg, agentName = 'Claude' }: { msg: ChatMessage; agentName?: string }) {
  switch (msg.kind) {
    case 'system':
      return <p className="text-[11px] text-[var(--text-muted)] italic">{msg.text}</p>

    case 'user':
      return (
        <div>
          <p className="text-[11px] font-semibold text-[var(--accent-blue)] mb-0.5">You</p>
          <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">{msg.text}</p>
        </div>
      )

    case 'assistant':
      return (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-[var(--accent-purple)] mb-0.5">{agentName}</p>
          {msg.blocks.map((b, i) => <BlockView key={i} block={b} isComplete={msg.complete} />)}
          {msg.cost != null && (
            <p className="text-[10px] text-[var(--text-muted)] border-t border-[var(--border-light)] pt-1 mt-1">
              cost: ${msg.cost.toFixed(4)}
            </p>
          )}
        </div>
      )

    case 'error':
      return (
        <div className="flex items-start gap-1.5 text-[var(--accent-red)] text-xs">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          <span>{msg.text}</span>
        </div>
      )
  }
}

const MessageBubble = memo(
  MessageBubbleImpl,
  (prev, next) => prev.msg === next.msg && prev.agentName === next.agentName
)

// 工具名 → lucide 图标。未知/MCP 工具回落 Wrench。
const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText, Edit: FileText, Write: FileText,
  Bash: Terminal,
  Grep: Search, Glob: Search,
  Agent: Bot, Task: Bot,
}
const iconFor = (name?: string): LucideIcon =>
  (name && TOOL_ICONS[name]) || Wrench

function BlockView({ block, isComplete }: { block: ContentBlock; isComplete: boolean }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="text-sm text-[var(--text-primary)] leading-relaxed">
          <MarkdownContent text={block.text || ''} isComplete={isComplete} />
        </div>
      )

    case 'thinking':
      return (
        <details open={!isComplete} className="border-l-2 border-[var(--accent-purple-dim)] pl-2.5 text-xs text-[var(--accent-purple-text)]">
          <summary className="cursor-pointer text-[var(--accent-purple-dim)] font-medium flex items-center gap-1 select-none">
            <Brain size={12} />
            <span>thinking...</span>
            <ChevronDown size={12} />
          </summary>
          <div className="mt-1 leading-relaxed">
            <MarkdownContent text={block.text || ''} isComplete={isComplete} />
          </div>
        </details>
      )

    case 'tool_use': {
      const inputStr = block.input ? JSON.stringify(block.input, null, 2) : null
      const truncated = inputStr && inputStr.length > 2000
        ? inputStr.substring(0, 2000) + '\n...(truncated)'
        : inputStr
      const hasRawInput = !!truncated && truncated !== '{}' && truncated !== 'null'
      return (
        <div className="border-l-2 border-[var(--accent-yellow)] pl-2.5 py-1 text-xs">
          <div className="flex items-center gap-1 text-[var(--accent-yellow)] font-medium">
            {createElement(iconFor(block.name), { size: 12 })}
            <span>{block.name || 'tool'}</span>
            {block.summary && (
              <span className="text-[var(--text-secondary)] font-normal truncate min-w-0 flex-1">· {block.summary}</span>
            )}
          </div>
          {hasRawInput && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] text-[var(--text-muted)] select-none">input</summary>
              <pre className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border)] overflow-x-auto">
                {truncated}
              </pre>
            </details>
          )}
        </div>
      )
    }

    case 'tool_result': {
      const out = block.text || ''
      return (
        <div className="border-l-2 border-[var(--accent-green,#3fb950)] pl-2.5 py-1 text-xs">
          <div className="flex items-center gap-1 text-[var(--accent-green,#3fb950)] font-medium">
            {createElement(iconFor(block.name), { size: 12 })}
            <span>{block.name || 'tool'}</span>
            <span className="text-[var(--text-secondary)] font-normal">· result</span>
          </div>
          {out && (
            <pre className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border)] overflow-x-auto max-h-60 overflow-y-auto">
              {out.length > 4000 ? out.substring(0, 4000) + '\n...(truncated)' : out}
            </pre>
          )}
        </div>
      )
    }

    default:
      return null
  }
}
