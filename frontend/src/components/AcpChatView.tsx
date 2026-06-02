import { useState, useEffect, useRef, useCallback, memo, createElement, type KeyboardEvent } from 'react'
import { wsUrl } from '../lib/api'
import { Send, ChevronDown, Wrench, Brain, AlertCircle, FileText, Terminal, Search, Bot, type LucideIcon } from 'lucide-react'
import MarkdownContent from './markdown/MarkdownContent'
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
  type: 'text' | 'thinking' | 'tool_use'
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

export default function AcpChatView({ sessionId, active, agentType = 'claude' }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const currentAssistant = useRef<AssistantMsg | null>(null)

  const autoResize = (t: HTMLTextAreaElement) => {
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 120) + 'px'
  }

  const transcribe = useTranscribe({
    language: 'zh-CN',
    onFinal: (text) => {
      setInput(prev => prev + text)
      requestAnimationFrame(() => {
        if (inputRef.current) autoResize(inputRef.current)
      })
    },
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
    const ws = new WebSocket(wsUrl(`/ws/acp/${sessionId}`))
    wsRef.current = ws

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
    }
    ws.onerror = () => { ws.close() }

    return () => { ws.close() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const handleEvent = useCallback((evt: ServerEvent) => {
    switch (evt.type) {
      case 'system': {
        const label = evt.subtype || 'system'
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
        break
      }
    }
  }, [pushMessage, scrollBottom])

  const sendPrompt = useCallback(() => {
    const text = input.trim()
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    pushMessage({ id: newId(), kind: 'user', text })
    wsRef.current.send(JSON.stringify({ type: 'prompt', text }))
    setInput('')
    setBusy(true)
  }, [input, pushMessage])

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendPrompt()
    }
  }

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
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
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Send a message to ${agentType === 'kiro' ? 'Kiro' : agentType === 'codex' ? 'Codex' : 'Claude'}...`}
            rows={1}
            className="flex-1 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)] resize-none min-h-[40px] max-h-[120px]"
            style={{ height: 'auto', overflow: 'hidden' }}
            onInput={e => autoResize(e.target as HTMLTextAreaElement)}
          />
          <MicButton
            isRecording={transcribe.isRecording}
            supported={transcribe.supported}
            onPressStart={transcribe.start}
            onPressEnd={transcribe.stop}
          />
          <button
            onClick={sendPrompt}
            disabled={busy || !input.trim()}
            className="self-end p-2 bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white rounded-lg transition-colors"
            title="Send"
          >
            <Send size={16} />
          </button>
        </div>
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

    default:
      return null
  }
}
