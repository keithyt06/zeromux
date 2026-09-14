import { useState, useCallback } from 'react'
import type { SessionInfo, SessionMetaStatus } from '../lib/api'
import { updateSession } from '../lib/api'
import { ChevronDown, ChevronRight, FileText, GitBranch, Activity, BarChart3, Brain } from 'lucide-react'

interface Props {
  session: SessionInfo
  onUpdate: (updated: Partial<SessionInfo>) => void
  onToggleFiles: () => void
  onToggleGit: () => void
  onToggleEvents: () => void
  showFiles: boolean
  showGit: boolean
  showEvents: boolean
  onOpenSidebar?: () => void
  onQueueMode?: (mode: string) => void
  // Backend-authoritative queue mode (owned by App, reported up by AcpChatView).
  // The dropdown is a CONTROLLED reflection of this — no local mirror — so an
  // observer/reconnected tab can't show a stale mode that misleads the user into
  // an unintended interrupt on send. (review 2026-07-28)
  queueMode?: string
  // Inline run-metrics panel toggle (agent sessions only). Lives alongside the
  // chat (not a full-screen overlay), so it's a simple boolean rather than an
  // overlay mode.
  onToggleMetrics?: () => void
  showMetrics?: boolean
  // 记忆面板开关（第 5 个 overlay view）。仅 Crew 会话由 App 传入，其余会话为
  // undefined → 第 5 个图标不渲染，照上面 onToggleMetrics 的门控 idiom。
  // 5 个是硬上限（375px 宽度核算：5×22 + 4×4 = 126px，加汉堡 22 + chevron 18 +
  // StatusDot 8 + 内边距 24 ≈ 198px，description 余 ~177px）。第 6 个会崩版 ——
  // 所以审批不占图标位，内联在对话里。
  onToggleMemory?: () => void
  showMemory?: boolean
}

const STATUS_OPTIONS: { value: SessionMetaStatus; label: string; color: string }[] = [
  { value: 'running', label: 'Running', color: 'bg-green-500' },
  { value: 'done', label: 'Done', color: 'bg-blue-500' },
  { value: 'blocked', label: 'Blocked', color: 'bg-yellow-500' },
  { value: 'idle', label: 'Idle', color: 'bg-gray-400' },
]

export function StatusDot({ status }: { status: SessionMetaStatus }) {
  const opt = STATUS_OPTIONS.find(o => o.value === status)
  return <span className={`inline-block w-2 h-2 rounded-full ${opt?.color || 'bg-gray-400'} shrink-0`} />
}

export default function SessionInfoBar({ session, onUpdate, onToggleFiles, onToggleGit, onToggleEvents, showFiles, showGit, showEvents, onOpenSidebar, onQueueMode, queueMode = 'collect', onToggleMetrics, showMetrics, onToggleMemory, showMemory }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [desc, setDesc] = useState(session.description)

  const save = useCallback(async (data: { description?: string; status?: SessionMetaStatus }) => {
    try {
      await updateSession(session.id, data)
      onUpdate(data)
    } catch { /* ignore */ }
  }, [session.id, onUpdate])

  const handleDescBlur = () => {
    if (desc !== session.description) {
      save({ description: desc })
    }
  }

  const handleStatusChange = (status: SessionMetaStatus) => {
    save({ status })
  }

  // Sync description from props
  if (desc !== session.description && document.activeElement?.tagName !== 'INPUT') {
    setDesc(session.description)
  }

  return (
    <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)]">
      {/* Collapsed bar */}
      <div className="flex items-center gap-2 px-3 h-9">
        {onOpenSidebar && (
          <button
            onClick={onOpenSidebar}
            className="p-1 -ml-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
        )}
        <button
          onClick={() => setExpanded(!expanded)}
          className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <StatusDot status={session.status} />

        {!expanded ? (
          <span className="text-xs text-[var(--text-secondary)] truncate flex-1">
            {session.description || session.name}
          </span>
        ) : (
          <input
            value={desc}
            onChange={e => setDesc(e.target.value)}
            onBlur={handleDescBlur}
            placeholder="What is this session doing?"
            className="text-xs text-[var(--text-primary)] bg-transparent flex-1 outline-none placeholder-[var(--text-muted)]"
          />
        )}

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onToggleFiles}
            className={`p-1 rounded transition-colors ${
              showFiles
                ? 'text-[var(--accent-blue)] bg-[var(--bg-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Browse files"
          >
            <FileText size={14} />
          </button>
          <button
            onClick={onToggleGit}
            className={`p-1 rounded transition-colors ${
              showGit
                ? 'text-[var(--accent-blue)] bg-[var(--bg-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Git history"
          >
            <GitBranch size={14} />
          </button>
          <button
            onClick={onToggleEvents}
            className={`p-1 rounded transition-colors ${
              showEvents
                ? 'text-[var(--accent-blue)] bg-[var(--bg-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Agent activity"
          >
            <Activity size={14} />
          </button>
          {onToggleMetrics && (
            <button
              onClick={onToggleMetrics}
              className={`p-1 rounded transition-colors ${
                showMetrics
                  ? 'text-[var(--accent-blue)] bg-[var(--bg-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title="运行记录"
            >
              <BarChart3 size={14} />
            </button>
          )}
          {onToggleMemory && (
            <button
              onClick={onToggleMemory}
              aria-label="memory panel"
              className={`p-1 rounded transition-colors ${
                showMemory
                  ? 'text-[var(--accent-purple)] bg-[var(--bg-primary)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title="记忆"
            >
              <Brain size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {/* Status selector */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-muted)] uppercase w-12">Status</span>
            <div className="flex gap-1">
              {STATUS_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors ${
                    session.status === opt.value
                      ? 'border-[var(--accent-blue)] text-[var(--accent-blue)] bg-[var(--bg-primary)]'
                      : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Queue mode (agent sessions only) */}
          {onQueueMode && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--text-muted)] uppercase w-12">Queue</span>
              <select
                value={queueMode}
                onChange={e => onQueueMode(e.target.value)}
                className="text-[10px] bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)]"
                title="多条消息同时在途时如何处理"
              >
                <option value="collect">Collect</option>
                <option value="interrupt">Interrupt</option>
                {/* Passthrough removed: unsound under single-turn_seq machinery
                    (Codex drops mid-turn prompt → wedge; Claude/Crew mis-stamp).
                    Server also degrades it to Collect. review 2026-06-11. */}
              </select>
            </div>
          )}

        </div>
      )}
    </div>
  )
}
