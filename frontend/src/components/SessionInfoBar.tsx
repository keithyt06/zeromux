import { useState, useEffect, useCallback, useRef } from 'react'
import type { SessionInfo, SessionMetaStatus, NoteEntry } from '../lib/api'
import { updateSession, listNotes, createNote, deleteNote } from '../lib/api'
import { ChevronDown, ChevronRight, FileText, StickyNote, GitBranch, X, Activity, BarChart3 } from 'lucide-react'

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

export default function SessionInfoBar({ session, onUpdate, onToggleFiles, onToggleGit, onToggleEvents, showFiles, showGit, showEvents, onOpenSidebar, onQueueMode, queueMode = 'collect', onToggleMetrics, showMetrics }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [desc, setDesc] = useState(session.description)
  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [noteInput, setNoteInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const save = useCallback(async (data: { description?: string; status?: SessionMetaStatus }) => {
    try {
      await updateSession(session.id, data)
      onUpdate(data)
    } catch { /* ignore */ }
  }, [session.id, onUpdate])

  // Notes list is fetched from `~/.zeromux/notes/{dir_hash}/` — a multi-second
  // JuiceFS/S3 directory read — every time the info bar is expanded. The note
  // input + delete buttons live INSIDE that just-expanded panel, so the user can
  // add/delete a note (optimistic `setNotes` below) BEFORE the expand's `loadNotes`
  // resolves. Without a stale guard the slow list (a pre-mutation snapshot) would
  // resolve last and unconditionally overwrite state: an added note vanishes (though
  // it persisted server-side → user re-adds → duplicate), or a deleted note reappears
  // as a ghost row (delete again 404s, swallowed). Same optimistic-mutation-vs-
  // in-flight-refresh race AgentDashboard was hardened against (reqRef, review
  // 2026-08-11): bump at the top of loadNotes and before each optimistic write, drop
  // superseded responses. (review 2026-08-15, F-FE.)
  const reqRef = useRef(0)
  const loadNotes = useCallback(async () => {
    const req = ++reqRef.current
    try {
      const data = await listNotes(session.id)
      if (reqRef.current !== req) return
      setNotes(data.notes)
    } catch { /* ignore */ }
  }, [session.id])

  useEffect(() => {
    if (expanded) loadNotes()
  }, [expanded, loadNotes])

  const handleDescBlur = () => {
    if (desc !== session.description) {
      save({ description: desc })
    }
  }

  const handleStatusChange = (status: SessionMetaStatus) => {
    save({ status })
  }

  const handleAddNote = async () => {
    const text = noteInput.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      const note = await createNote(session.id, text)
      // Invalidate any loadNotes already in flight so its pre-add snapshot can't
      // clobber the note we're optimistically prepending.
      reqRef.current++
      setNotes(prev => [note, ...prev])
      setNoteInput('')
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  const handleDeleteNote = async (noteId: string) => {
    try {
      await deleteNote(session.id, noteId)
      // Invalidate any in-flight loadNotes so its pre-delete snapshot can't
      // resurrect the row we're optimistically removing.
      reqRef.current++
      setNotes(prev => prev.filter(n => n.id !== noteId))
    } catch { /* ignore */ }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleAddNote()
    }
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
                    (Codex drops mid-turn prompt → wedge; Claude/Kiro mis-stamp).
                    Server also degrades it to Collect. review 2026-06-11. */}
              </select>
            </div>
          )}

          {/* Notes */}
          <div>
            <div className="flex items-center gap-1 mb-1">
              <StickyNote size={10} className="text-[var(--text-muted)]" />
              <span className="text-[10px] text-[var(--text-muted)] uppercase">
                Notes {notes.length > 0 && `(${notes.length})`}
              </span>
            </div>

            {/* Input */}
            <input
              value={noteInput}
              onChange={e => setNoteInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add a note... (Enter to save)"
              disabled={submitting}
              className="w-full text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-2 py-1.5 text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)] placeholder-[var(--text-muted)] mb-1"
            />

            {/* Notes list */}
            {notes.length > 0 && (
              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {notes.map(note => (
                  <NoteItem
                    key={note.id}
                    note={note}
                    onDelete={() => handleDeleteNote(note.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NoteItem({ note, onDelete }: { note: NoteEntry; onDelete: () => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="flex items-start gap-1.5 px-1.5 py-1 rounded hover:bg-[var(--bg-primary)] group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="text-[10px] text-[var(--text-muted)] shrink-0 w-[72px] pt-px">
        {formatNoteDate(note.created_at)}
      </span>
      <span className="text-[11px] text-[var(--text-primary)] flex-1 break-words leading-snug">
        {note.text}
      </span>
      {note.tags.length > 0 && (
        <span className="flex gap-0.5 shrink-0">
          {note.tags.map(tag => (
            <span
              key={tag}
              className="text-[9px] px-1 py-0 rounded bg-[var(--bg-tertiary)] text-[var(--accent-blue)]"
            >
              {tag}
            </span>
          ))}
        </span>
      )}
      {hovered && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="p-0.5 text-[var(--text-muted)] hover:text-[var(--accent-red)] shrink-0 transition-colors"
        >
          <X size={10} />
        </button>
      )}
    </div>
  )
}

function formatNoteDate(iso: string): string {
  try {
    const d = new Date(iso)
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${mo}-${day} ${h}:${m}`
  } catch {
    return iso.slice(0, 16)
  }
}
