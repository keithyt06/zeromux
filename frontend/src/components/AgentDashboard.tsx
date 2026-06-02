import { useState, useEffect, useCallback } from 'react'
import { listEvents, deleteEvent } from '../lib/api'
import type { AgentEvent } from '../lib/api'
import { Trash2, RefreshCw, Bot, Wrench, CheckCircle, AlertCircle, Flag, Zap } from 'lucide-react'

interface Props {
  sessionId?: string
}

const EVENT_ICONS: Record<string, typeof Bot> = {
  task_start: Zap,
  tool_use: Wrench,
  task_done: CheckCircle,
  error: AlertCircle,
  milestone: Flag,
  custom: Bot,
}

const EVENT_COLORS: Record<string, string> = {
  task_start: 'text-yellow-400',
  tool_use: 'text-[var(--text-secondary)]',
  task_done: 'text-green-400',
  error: 'text-red-400',
  milestone: 'text-blue-400',
  custom: 'text-purple-400',
}

const AGENT_COLORS: Record<string, string> = {
  'claude-code': 'bg-orange-500/20 text-orange-300',
  'codex': 'bg-green-500/20 text-green-300',
  'kiro': 'bg-blue-500/20 text-blue-300',
}

export default function AgentDashboard({ sessionId }: Props) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<{ agent?: string; event?: string }>({})

  const loadEvents = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listEvents({
        session_id: sessionId,
        agent: filter.agent,
        event: filter.event,
        limit: 100,
      })
      setEvents(data.events)
    } catch { /* ignore */ }
    setLoading(false)
  }, [sessionId, filter])

  useEffect(() => { loadEvents() }, [loadEvents])

  // Auto-refresh every 10s
  useEffect(() => {
    const interval = setInterval(loadEvents, 10000)
    return () => clearInterval(interval)
  }, [loadEvents])

  const handleDelete = async (id: string) => {
    try {
      await deleteEvent(id)
      setEvents(prev => prev.filter(e => e.id !== id))
    } catch { /* ignore */ }
  }

  const uniqueAgents = [...new Set(events.map(e => e.agent))]
  const uniqueEventTypes = [...new Set(events.map(e => e.event))]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
        <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Agent Activity
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={loadEvents}
            className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)] flex-wrap">
        <button
          onClick={() => setFilter({})}
          className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
            !filter.agent && !filter.event
              ? 'bg-[var(--accent-blue)]/15 text-[var(--accent-blue)] font-medium'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
          }`}
        >
          All
        </button>
        {uniqueAgents.map(agent => (
          <button
            key={agent}
            onClick={() => setFilter(f => ({ ...f, agent: f.agent === agent ? undefined : agent }))}
            className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
              filter.agent === agent
                ? 'bg-[var(--accent-blue)]/15 text-[var(--accent-blue)] font-medium'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {agent}
          </button>
        ))}
        <span className="text-[var(--border)]">|</span>
        {uniqueEventTypes.map(evt => (
          <button
            key={evt}
            onClick={() => setFilter(f => ({ ...f, event: f.event === evt ? undefined : evt }))}
            className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
              filter.event === evt
                ? 'bg-[var(--accent-blue)]/15 text-[var(--accent-blue)] font-medium'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {evt}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto">
        {loading && events.length === 0 ? (
          <div className="p-4 text-center text-[10px] text-[var(--text-muted)]">Loading...</div>
        ) : events.length === 0 ? (
          <div className="p-6 text-center">
            <Bot size={24} className="mx-auto text-[var(--text-muted)] mb-2" />
            <p className="text-[11px] text-[var(--text-muted)]">No agent events yet</p>
            <p className="text-[9px] text-[var(--text-muted)] mt-1">
              Events will appear here when agents report activity
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {events.map(event => (
              <EventRow key={event.id} event={event} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>

      {/* Footer stats */}
      {events.length > 0 && (
        <div className="px-3 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
          <span className="text-[9px] text-[var(--text-muted)]">
            {events.length} events
            {uniqueAgents.length > 0 && ` · ${uniqueAgents.join(', ')}`}
          </span>
        </div>
      )}
    </div>
  )
}

function EventRow({ event, onDelete }: { event: AgentEvent; onDelete: (id: string) => void }) {
  const [hovered, setHovered] = useState(false)
  const Icon = EVENT_ICONS[event.event] || Bot
  const color = EVENT_COLORS[event.event] || 'text-[var(--text-secondary)]'
  const agentStyle = AGENT_COLORS[event.agent] || 'bg-gray-500/20 text-gray-300'

  const time = formatEventTime(event.timestamp)
  const toolName = event.metadata?.tool_name

  return (
    <div
      className="flex items-start gap-2 px-3 py-2 hover:bg-[var(--bg-tertiary)] transition-colors group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`mt-0.5 shrink-0 ${color}`}>
        <Icon size={12} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className={`text-[9px] px-1 py-0 rounded ${agentStyle}`}>
            {event.agent}
          </span>
          <span className="text-[9px] text-[var(--text-muted)] px-1 py-0 rounded bg-[var(--bg-primary)]">
            {event.event}
          </span>
          {toolName && (
            <span className="text-[9px] text-[var(--text-muted)]">
              {toolName}
            </span>
          )}
        </div>
        {event.summary && (
          <p className="text-[11px] text-[var(--text-primary)] leading-snug truncate">
            {event.summary}
          </p>
        )}
        {event.work_dir && (
          <p className="text-[9px] text-[var(--text-muted)] font-mono truncate mt-0.5">
            {event.work_dir}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <span className="text-[9px] text-[var(--text-muted)]">{time}</span>
        {hovered && (
          <button
            onClick={() => onDelete(event.id)}
            className="p-0.5 text-[var(--text-muted)] hover:text-[var(--accent-red)] transition-colors"
          >
            <Trash2 size={10} />
          </button>
        )}
      </div>
    </div>
  )
}

function formatEventTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)

    if (diffMin < 1) return 'now'
    if (diffMin < 60) return `${diffMin}m`
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`

    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${mo}-${day} ${h}:${m}`
  } catch {
    return iso.slice(11, 16)
  }
}
