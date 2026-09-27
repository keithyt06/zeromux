import { useState, useEffect, useCallback, useRef } from 'react'
import type { SessionInfo, SessionType, UserInfo, SearchResult, DirHit, NoteHit, HostTmux } from '../lib/api'
import { isOrphan, matchHostTmux } from '../lib/hostTmux'
import { getSchedulerHealth, getVaultMeta, warmSearchIndex } from '../lib/api'
import { shouldShowVault } from '../lib/vault'
import type { Theme, ThemePref } from '../lib/theme'
import { Terminal, Plus, X, PanelLeftClose, PanelLeft, Sun, Moon, Folder, FolderGit2, ChevronLeft, Home, LogOut, Users, Clock, Bell, BookOpen, Settings, Pencil, Search } from 'lucide-react'
import { type DocTab } from '../lib/docTabs'
import PromptManager from './PromptManager'
import { Popover, Menu, SegmentedControl } from './ui'
import { usePromptPresets } from '../lib/usePromptPresets'
import { usePolling } from '../lib/usePolling'
import { useIsNarrow } from '../lib/useMediaQuery'
import { useDirBrowser } from '../lib/useDirBrowser'
import { usePathSearch } from '../lib/usePathSearch'
import { applyPreset } from '../lib/applyPreset'
import { isStuck } from '../lib/stuck'
import { ClaudeCodeIcon, CrewIcon, CodexIcon } from './BrandIcons'
import QuickTargets from './QuickTargets'
import SearchResults from './SearchResults'
import SessionRowMenu from './SessionRowMenu'
import { askAgentPrompt, type AskAgentTarget } from '../lib/askAgent'

interface Props {
  sessions: SessionInfo[]
  docTabs: DocTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, initialPrompt?: string) => Promise<void>
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  hasUnread: (s: SessionInfo) => boolean
  onLogout: () => void
  theme: Theme
  onToggleTheme: () => void
  themePref: ThemePref
  onSetThemePref: (p: ThemePref) => void
  user: UserInfo | null
  open: boolean
  onToggle: () => void
  mobile: boolean
  confirmCount?: number
  /** Optional only so this task compiles before App wires it (Task 10); App always passes it. */
  onOpenVault?: (target: { path: string; kind: 'note' | 'folder' }) => void
  askAgentRequest?: (AskAgentTarget & { nonce: number }) | null
  /** Untracked host tmux sessions (admin only; empty otherwise). Click = attach. */
  hostTmux?: HostTmux[]
  onOpenHistory?: (id: string) => void
  /** Full-screen panels (and the prompt manager) are mounted at App level. */
  onOpenPanel: (p: 'admin' | 'scheduled' | 'push' | 'prompts') => void
}

/** Relative "last activity" label. <60s 刚刚, <60m Xm, <24h Xh, else Xd. */
function relativeTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

/** Turn-state dot: hollow=hibernated, amber=stuck, green=running, gray=idle. */
function TurnDot({ s }: { s: SessionInfo }) {
  // Coarse stuck hint: re-evaluated on the 3s session-list poll re-render.
  // Date.now() at render is intentional and harmless here (cosmetic dot, no
  // dependent state/effect), so the purity rule is suppressed for this line.
  // eslint-disable-next-line react-hooks/purity
  const stuck = isStuck(s.turn_state, s.last_activity_ms, Date.now())
  const cls = !s.running
    ? 'border border-[var(--text-secondary)]'
    : stuck
      ? 'bg-[var(--accent-yellow)]'
      : s.turn_state === 'running'
        ? 'bg-green-400'
        : 'bg-[var(--text-secondary)]'
  return <span className={`w-2 h-2 rounded-full shrink-0 ${cls}`} title={stuck ? '可能卡住' : undefined} />
}

// Still building (indexing) or rebuilding with no hits → re-query in 4s so the
// user never has to retype after a restart. Dirs: re-query on refreshing+empty
// (scheduled rebuild). Notes: re-query only during indexing (initial build can
// take 50s+). Once built, inotify keeps live, so zero results during refresh
// are real misses. Module-level so usePathSearch gets a stable predicate.
const sidebarRequery = (r: SearchResult) => {
  const pending = (s: { indexing: boolean; refreshing: boolean; items: unknown[] } | null) =>
    !!s && (s.indexing || (s.refreshing && s.items.length === 0))
  return pending(r.dirs) || !!r.notes?.indexing
}

type NewSessionStep = 'closed' | 'quick' | 'pick-type' | 'pick-dir' | 'pick-prompt' | 'manage-prompts'

/** Per-agent-type icon used in session list rows. Kept in one place so the
 *  sidebar's two render sites (active row, condensed row) stay in sync as
 *  agent types are added. */
function SessionTypeIcon({ type, size = 14, className }: { type: SessionType; size?: number; className?: string }) {
  switch (type) {
    case 'claude': return <ClaudeCodeIcon size={size} className={className} />
    case 'crew':   return <CrewIcon size={size} className={className} />
    case 'codex':  return <CodexIcon size={size} className={className} />
    case 'tmux':
    default:       return <Terminal size={size} className={className} />
  }
}

export default function Sidebar({ sessions, docTabs, activeId, onSelect, onCreate, onDelete, onRename, hasUnread, onLogout, theme, onToggleTheme, themePref, onSetThemePref, user, open, onToggle, mobile, confirmCount = 0, onOpenVault, askAgentRequest, hostTmux = [], onOpenHistory, onOpenPanel }: Props) {
  const [step, setStep] = useState<NewSessionStep>('closed')
  const [pendingType, setPendingType] = useState<SessionType | null>(null)
  const [promptDraft, setPromptDraft] = useState('')
  const [pendingDir, setPendingDir] = useState<string | null>(null)
  // Search on the New Session first screen. The query lives at Sidebar level so
  // going pick-type → back keeps it; openTypePicker clears it.
  const [query, setQuery] = useState('')
  // Set when a search hit fixed the dir: after picking a type, create directly
  // instead of showing the prompt page (a middle page would undo "one tap").
  const [pendingSkipPrompt, setPendingSkipPrompt] = useState(false)
  // Set by ⚡: the session must carry context → hide Terminal (tmux ignores
  // initial_prompt) and prefill the prompt page.
  const [pendingAgentContext, setPendingAgentContext] = useState<AskAgentTarget | null>(null)
  const presetStore = usePromptPresets()
  const [showSettings, setShowSettings] = useState(false)
  // Same predicate Popover uses to render as a bottom Sheet (which has its own title).
  const narrow = useIsNarrow()
  // Anchors as state (not refs): the collapsed rail / ⚡ open the popover in the
  // same render that first mounts the button, when a ref would still be null.
  const [newBtn, setNewBtn] = useState<HTMLButtonElement | null>(null)
  const [settingsBtn, setSettingsBtn] = useState<HTMLButtonElement | null>(null)
  const [vaultEnabled, setVaultEnabled] = useState(false)
  const [schedulerHealthy, setSchedulerHealthy] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  // Synchronous in-flight guard: two taps can land in the same tick before a
  // re-render, so state alone can't stop a double create. `creating` mirrors it
  // for the pending UI.
  const creatingRef = useRef(false)
  const [creating, setCreating] = useState(false)

  const commitRename = (id: string, name: string) => {
    setEditingId(null)
    onRename(id, name)
  }
  const isAdmin = user?.role === 'admin'

  // Poll scheduler health (once on mount, then every 60s)
  const pollSchedulerHealth = useCallback(async () => {
    try { setSchedulerHealthy((await getSchedulerHealth()).healthy) } catch { /* ignore */ }
  }, [])
  usePolling(pollSchedulerHealth, 60_000)

  // Vault availability (gate the Obsidian sidebar entry on server config)
  useEffect(() => { getVaultMeta().then(m => setVaultEnabled(shouldShowVault(m))).catch(() => {}) }, [])

  // Directory browser state. Failures (timeout/network/permission) surface as
  // dir.error with a 「重试」 button instead of hanging on Loading….
  const dir = useDirBrowser()

  const ThemeIcon = theme === 'dark' ? Sun : Moon

  const search = usePathSearch(query, {
    scope: vaultEnabled ? 'dirs,notes' : 'dirs', debounceMs: 150, enabled: step === 'quick', requeryWhile: sidebarRequery,
  })

  const openTypePicker = () => {
    setStep('quick')
    setPendingType(null)
    setPendingDir(null)   // start clean on every open so a leftover dir can't leak in
    setPendingSkipPrompt(false)
    setPendingAgentContext(null)
    setQuery('')          // also clears the search result (empty query → null)
    dir.reset()           // a stale browse path must not hijack pick-prompt's Back
    setCreateError(null)  // a failed earlier attempt must not bleed into the next one
    warmSearchIndex('dirs,notes')
  }

  const selectType = (type: SessionType) => {
    setPendingType(type)
    if (type === 'tmux') {
      // Terminals are always tmux now: dir fixed by a quick card/search → create;
      // otherwise pick a dir. (Attaching existing tmux lives in the session list.)
      if (pendingDir) { runCreate(() => onCreate('tmux', pendingDir)); return }
      setStep('pick-dir')
      dir.load()
    } else if (pendingDir && pendingSkipPrompt) {
      runCreate(() => onCreate(type, pendingDir))
    } else if (pendingDir) {
      // Arrived from a quick card's "换 agent 类型" or from ⚡: the dir is fixed,
      // only the type changes → straight to the prompt page (prefilled for ⚡).
      setPromptDraft(pendingAgentContext ? askAgentPrompt(pendingAgentContext) : '')
      presetStore.reload()
      setStep('pick-prompt')
    } else {
      setStep('pick-dir')
      dir.load()
    }
  }

  const selectDir = (path: string) => {
    if (!pendingType) { setStep('closed'); return }
    if (pendingType === 'tmux') {
      runCreate(() => onCreate('tmux', path))
    } else {
      setPendingDir(path)
      setPromptDraft('')
      presetStore.reload()
      setStep('pick-prompt')
    }
  }

  const pickDirHit = (h: DirHit) => {
    if (h.agent) { runCreate(() => onCreate(h.agent!, h.path)); return }
    setPendingDir(h.path); setPendingSkipPrompt(true); setPendingAgentContext(null); setStep('pick-type')
  }
  const pickNoteHit = (h: NoteHit) => {
    onOpenVault?.({ path: h.path, kind: h.kind })
    closeAfterCreate()
  }
  const askAgent = (t: AskAgentTarget) => {
    setPendingDir(t.absDir); setPendingSkipPrompt(false); setPendingAgentContext(t); setStep('pick-type')
  }
  const openHere = (h: NoteHit) => {
    setPendingDir(h.abs_dir); setPendingSkipPrompt(true); setPendingAgentContext(null); setStep('pick-type')
  }

  const close = () => {
    setStep('closed')
    setPendingType(null)
    setPromptDraft('')
    setPendingDir(null)
    setPendingSkipPrompt(false)
    setPendingAgentContext(null)
    setCreateError(null)
  }

  // Post-creation teardown: close the popover, and on mobile the full-screen
  // sidebar too — otherwise the user finishes creating a session and is left
  // staring at a backdrop that hides it, so "1 tap" would not be true. The
  // existing handleSelect only toggles on *selecting* an existing session.
  const closeAfterCreate = () => {
    close()
    if (mobile) onToggle()
  }

  // Await creation; only tear the popover down on success. On failure keep the
  // user where they are with a visible reason (audit B3) — never close silently.
  const runCreate = async (create: () => Promise<void>, after: () => void = closeAfterCreate) => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setCreateError(null)
    try {
      await create()
      after()
    } catch (e) {
      setCreateError(`创建失败:${(e as Error).message || '未知错误'}`)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  const submitWithPrompt = () => {
    if (!pendingType || !pendingDir) { setStep('closed'); return }
    const trimmed = promptDraft.trim()
    runCreate(() => onCreate(pendingType, pendingDir, undefined, trimmed ? promptDraft : undefined), () => { setPromptDraft(''); setPendingDir(null); closeAfterCreate() })
  }
  const submitSkip = () => {
    if (!pendingType || !pendingDir) { setStep('closed'); return }
    runCreate(() => onCreate(pendingType, pendingDir), () => { setPromptDraft(''); setPendingDir(null); closeAfterCreate() })
  }

  // One-shot external request (VaultReader's ⚡), consumed once per nonce.
  const lastAskNonce = useRef(0)
  useEffect(() => {
    if (!askAgentRequest || askAgentRequest.nonce === lastAskNonce.current) return
    lastAskNonce.current = askAgentRequest.nonce
    // Collapsed sidebar (desktop icon rail, or mobile hidden) doesn't render the
    // popover at all — open it, or the ⚡ tap silently does nothing.
    if (!open) onToggle()
    // Consuming an external one-shot request is exactly an effect's job.
    setPendingType(null)
    setQuery('')            // never show the previous open's query/results
    askAgent(askAgentRequest)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAgentRequest])

  const handleSelect = (id: string) => {
    onSelect(id)
    if (mobile) onToggle() // auto-close on mobile after selection
  }

  // Collapsed state (icon-only rail)
  if (!open && !mobile) {
    return (
      <div className="w-10 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col items-center py-2 gap-1 shrink-0">
        <button
          onClick={onToggle}
          className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
          title="Expand sidebar"
        >
          <PanelLeft size={16} />
        </button>
        <div className="w-6 h-px bg-[var(--border)] my-1" />
        {sessions.map(s => (
          <button
            key={s.id}
            onClick={() => handleSelect(s.id)}
            className={`relative p-1.5 rounded transition-colors ${
              s.id === activeId
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-bright)] shadow-[inset_2px_0_0_var(--accent-brand)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title={s.name}
          >
            <SessionTypeIcon type={s.type} size={14} />
            {s.source_task_id && (
              <Clock size={8} className="absolute bottom-0 right-0 text-[var(--text-muted)]" />
            )}
          </button>
        ))}
        {docTabs.map(t => (
          <button
            key={t.id}
            onClick={() => handleSelect(t.id)}
            className={`relative p-1.5 rounded transition-colors ${
              t.id === activeId
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-bright)] shadow-[inset_2px_0_0_var(--accent-brand)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title={t.title}
          >
            <BookOpen size={14} />
          </button>
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          <button
            onClick={onToggleTheme}
            className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            <ThemeIcon size={14} />
          </button>
          <button
            onClick={() => { onToggle(); openTypePicker() }}
            className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-blue)] rounded transition-colors"
            title="New session"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={onLogout}
            className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)] rounded transition-colors"
            title="Sign out"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
    )
  }

  // Mobile: hidden when closed
  if (!open && mobile) {
    return null
  }

  // Full sidebar panel
  const panel = (
    <div className={`${mobile ? 'w-64' : 'w-56'} bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col shrink-0 h-full`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 min-w-0">
          {user?.avatar ? (
            <img src={user.avatar} alt="" className="w-5 h-5 rounded-full shrink-0" />
          ) : (
            <span className="text-xs font-bold text-[var(--accent-blue)] tracking-wide uppercase">ZM</span>
          )}
          <span className="text-xs font-medium text-[var(--text-primary)] truncate">
            {user?.login || 'ZeroMux'}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => onOpenPanel('scheduled')}
            className="relative p-1 text-[var(--text-secondary)] hover:text-[var(--accent-blue)] rounded transition-colors"
            title={schedulerHealthy ? '定时任务' : '调度器异常'}
          >
            <Clock size={14} />
            {!schedulerHealthy && (
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-red-500" title="调度器异常" />
            )}
            {confirmCount > 0 && (
              <span
                className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[14px] h-3.5 px-1 text-[9px] font-bold leading-none text-white bg-[var(--accent-red)] rounded-full"
                title={`${confirmCount} 条待确认`}
              >
                {confirmCount}
              </span>
            )}
          </button>
          <button
            onClick={onLogout}
            className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-red)] rounded transition-colors"
            title="Sign out"
          >
            <LogOut size={14} />
          </button>
          <button
            onClick={onToggle}
            className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
            title="Collapse sidebar"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* Sessions */}
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.map(s => (
          <div
            key={s.id}
            onClick={() => handleSelect(s.id)}
            className={`group flex items-center gap-2 px-3 py-1.5 mx-1 rounded cursor-pointer text-xs transition-colors ${
              s.id === activeId
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-bright)] shadow-[inset_2px_0_0_var(--accent-brand)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <TurnDot s={s} />
            <span className="relative shrink-0 flex items-center" title={s.source_task_id ? '定时任务' : undefined}>
              <SessionTypeIcon type={s.type} size={13} />
              {s.source_task_id && (
                <Clock size={9} className="absolute -bottom-1 -right-1 text-[var(--text-muted)]" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                {editingId === s.id ? (
                  <input
                    autoFocus
                    defaultValue={s.name}
                    onClick={e => e.stopPropagation()}
                    onBlur={e => commitRename(s.id, e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename(s.id, (e.target as HTMLInputElement).value)
                      else if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--accent-blue)] rounded px-1 py-0 text-xs text-[var(--text-primary)] outline-none"
                  />
                ) : (
                  <span
                    className="truncate"
                    onDoubleClick={e => { e.stopPropagation(); setEditingId(s.id) }}
                    title="Double-click to rename"
                  >
                    {s.name}
                  </span>
                )}
                {hasUnread(s) && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="New activity" />}
                {s.other_clients > 0 && <span className="text-[10px] text-[var(--accent-blue)] shrink-0" title="其他终端也在查看">🖥+{s.other_clients}</span>}
                <span className="ml-auto text-[10px] text-[var(--text-muted)] shrink-0">{relativeTime(s.last_activity_ms)}</span>
              </div>
              {s.description && (
                <div className="truncate text-[10px] text-[var(--text-muted)] -mt-0.5">{s.description}</div>
              )}
            </div>
            <SessionRowMenu
              session={s}
              onRename={() => setEditingId(s.id)}
              onClose={() => onDelete(s.id)}
              onHistory={onOpenHistory ? () => onOpenHistory(s.id) : undefined}
            />
          </div>
        ))}
        {docTabs.map(t => (
          <div
            key={t.id}
            onClick={() => handleSelect(t.id)}
            className={`group flex items-center gap-2 px-3 py-1.5 mx-1 rounded cursor-pointer text-xs transition-colors ${
              t.id === activeId
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-bright)] shadow-[inset_2px_0_0_var(--accent-brand)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <BookOpen size={13} className="shrink-0 text-[var(--accent-blue)]" />
            <span className="flex-1 min-w-0 truncate">{t.title}</span>
            <button
              onClick={e => { e.stopPropagation(); onDelete(t.id) }}
              className="p-0.5 opacity-0 group-hover:opacity-100 text-[var(--text-secondary)] hover:text-[var(--accent-red)] transition-all"
              title="关闭文档"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {hostTmux.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">本机 tmux</div>
            {createError && (
              <div role="alert" className="mx-2 my-1 px-2 py-1.5 rounded text-xs text-[var(--accent-red)] bg-[var(--bg-tertiary)] border border-[var(--accent-red)]/40">
                {createError}
              </div>
            )}
            {creating && (
              <div className="mx-2 my-1 px-2 py-1.5 text-xs text-[var(--text-muted)]">创建中…</div>
            )}
            {hostTmux.map(h => (
              <button
                key={h.name}
                onClick={() => runCreate(() => onCreate('tmux', undefined, h.name), () => { if (mobile) onToggle() })}
                title={`${h.path}\n点击接入`}
                className="flex items-center gap-2 w-[calc(100%-0.5rem)] px-3 py-1.5 mx-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                <span className="w-2 h-2 rounded-full border border-[var(--text-muted)] shrink-0" />
                <span className="truncate">{h.name}</span>
                {isOrphan(h) && <span className="text-[10px] text-[var(--accent-yellow)] shrink-0">zeromux 遗留</span>}
                <span className="ml-auto text-[10px] text-[var(--text-muted)] shrink-0">{h.windows} win{h.attached > 0 ? ` · 🖥${h.attached}` : ''}</span>
              </button>
            ))}
          </>
        )}
      </div>

      {/* New session */}
      <div className="relative px-2 py-3 border-t border-[var(--border)]">
        <button
          ref={setNewBtn}
          onClick={openTypePicker}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-[var(--accent-brand)] border border-[var(--accent-brand)]/40 hover:bg-[var(--accent-brand)]/10 rounded-lg transition-colors min-h-[40px]"
        >
          <Plus size={14} />
          <span>New session</span>
        </button>

        <Popover open={step !== 'closed'} onClose={close} anchor={newBtn} placement="bottom" sheetTitle="新建会话">
            <div className={mobile ? '' : step === 'quick' || step === 'manage-prompts' ? 'w-80 max-w-full' : 'w-56'}>
              {createError && (
                <div role="alert" className="mx-2 my-1 px-2 py-1.5 rounded text-xs text-[var(--accent-red)] bg-[var(--bg-tertiary)] border border-[var(--accent-red)]/40">
                  {createError}
                </div>
              )}
              {creating && (
                <div className="mx-2 my-1 px-2 py-1.5 text-xs text-[var(--text-muted)]">创建中…</div>
              )}
              {step === 'quick' && (
                <>
                  {!narrow && (
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                      新建会话
                    </div>
                  )}
                  {/* Results area is the only part that grows; capped so the popover (which
                      grows UPWARD from the bottom anchor) never pushes the input off-screen. */}
                  <div className="max-h-[40vh] overflow-y-auto border-b border-[var(--border)]">
                    {query.trim() ? (<>
                      {matchHostTmux(hostTmux, query).map(h => (
                        <button key={`tmux-${h.name}`} disabled={creating} onClick={() => runCreate(() => onCreate('tmux', undefined, h.name))}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                          <Terminal size={13} className="text-[var(--accent-green-text)] shrink-0" />
                          <span className="truncate">接入 tmux：{h.name}</span>
                          <span className="ml-auto text-[10px] text-[var(--text-muted)] truncate">{h.path}</span>
                        </button>
                      ))}
                      {search.result || search.failed ? (
                        <SearchResults
                          result={search.result ?? { dirs: null, notes: null }}
                          failed={search.failed}
                          onRetry={search.retry}
                          showNotes={vaultEnabled}
                          onPickDir={pickDirHit}
                          onDirMenu={{
                            changeAgent: (h) => { setPendingDir(h.path); setPendingSkipPrompt(false); setStep('pick-type') },
                            withPrompt: (h) => { setPendingDir(h.path); setPendingType(h.agent); setPromptDraft(''); presetStore.reload(); setStep(h.agent ? 'pick-prompt' : 'pick-type') },
                          }}
                          onPickNote={pickNoteHit}
                          onAskAgent={(h) => askAgent({ absDir: h.abs_dir, relPath: h.path, kind: h.kind })}
                          onOpenHere={openHere}
                        />
                      ) : <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">搜索中…</div>}
                    </>) : (
                      /* 一击直达：点一行 = 用该行的 agent 直接创建，0 次列目录请求。
                         刻意跳过 prompt 页——中间插一页就退化成「少点两下的老流程」，
                         而且信息零丢失：会话建好后 AcpChatView 的 composer 里有一模一样的
                         preset 选择器。要带 prompt 的场景走行级操作单。 */
                      <QuickTargets
                        kind="dir"
                        onPick={(path, agent) => {
                          if (!agent) { setPendingDir(path); setStep('pick-type'); return }
                          runCreate(() => onCreate(agent as SessionType, path))
                        }}
                        onChangeAgent={(path) => { setPendingDir(path); setStep('pick-type') }}
                        onPickWithPrompt={(path, agent) => {
                          setPendingDir(path)
                          setPendingType(agent ?? null)
                          setPromptDraft('')
                          presetStore.reload()
                          setStep(agent ? 'pick-prompt' : 'pick-type')
                        }}
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { setPendingDir(null); setPendingSkipPrompt(false); setStep('pick-type') }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 min-h-[44px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Folder size={13} className="shrink-0" />
                    <span>其他目录…</span>
                  </button>
                  {/* Obsidian 显式保底入口：'vault' 在 App.tsx 于前端短路，
                      不经过 create_session，所以它永远不会出现在 dir 榜上。若只靠
                      「其他目录…」里的那份，入口会从今天的 2 tap 退化到 3 tap。 */}
                  {vaultEnabled && (
                    <button
                      type="button"
                      onClick={() => runCreate(() => onCreate('vault'))}
                      disabled={creating}
                      className="flex items-center gap-2 w-full px-3 py-2.5 min-h-[44px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <BookOpen size={13} className="shrink-0" />
                      <span>Obsidian 笔记库</span>
                    </button>
                  )}
                  {/* Input at the BOTTOM: next to the anchor and the thumb; results growing
                      upward never move it. No autoFocus on phones (the QuickTargets one-tap is
                      still the main path and a keyboard would cover it). */}
                  <div className="flex items-center gap-2 mx-2 my-1.5 px-2 py-1.5 rounded bg-[var(--bg-secondary)] border border-[var(--border)]">
                    <Search size={13} className="text-[var(--text-muted)] shrink-0" />
                    <input
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      onKeyDown={e => {
                        // Ignore Enter while an IME is composing (pinyin), and when the
                        // shown results belong to an older query (debounce not yet fired).
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing || !search.result || search.resultQuery !== query) return
                        e.preventDefault()
                        const first = [...(search.result.dirs?.items ?? []).map(h => ({ t: 'd' as const, h, s: h.score })),
                          ...(vaultEnabled ? search.result.notes?.items ?? [] : []).map(h => ({ t: 'n' as const, h, s: h.score }))]
                          .sort((a, b) => b.s - a.s)[0]
                        if (!first) return
                        if (first.t === 'd') pickDirHit(first.h as DirHit); else pickNoteHit(first.h as NoteHit)
                      }}
                      maxLength={128}
                      autoFocus={!mobile}
                      placeholder={vaultEnabled ? '搜索目录或笔记…' : '搜索目录…'}
                      /* text-base = 16px: below 16px iOS Safari zooms the whole page on focus. */
                      className="flex-1 min-w-0 bg-transparent text-base outline-none text-[var(--text-primary)]"
                    />
                  </div>
                </>
              )}

              {step === 'pick-type' && (
                <>
                  {/* `quick` is the first screen now, so pick-type is a second screen and
                      needs a way back — matching pick-dir. */}
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <button
                      onClick={() => { setPendingDir(null); setPendingSkipPrompt(false); setPendingAgentContext(null); dir.reset(); setStep('quick') }}
                      className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                      title="返回"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider truncate flex-1">
                      {pendingAgentContext
                        ? `问 agent：${pendingAgentContext.relPath.split('/').pop() || pendingAgentContext.relPath}`
                        : 'Select type'}
                    </span>
                  </div>
                  {/* tmux ignores initial_prompt, so ⚡'s context would be silently dropped. */}
                  {!pendingAgentContext && (
                    <button
                      onClick={() => selectType('tmux')}
                      disabled={creating}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <Terminal size={14} className="text-[var(--accent-green-text)] shrink-0" />
                      <div className="text-left">
                        <div className="font-medium">Terminal</div>
                        <div className="text-[10px] text-[var(--text-secondary)]">持久 tmux 会话，可在 VSCode 接续</div>
                      </div>
                    </button>
                  )}
                  <button
                    onClick={() => selectType('claude')}
                    disabled={creating}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <ClaudeCodeIcon size={14} className="shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Claude Code</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent</div>
                    </div>
                  </button>
                  {/* 原位替换。仍是 4 项、不重排顺序 —— 现有顺序已是肌肉记忆，
                      为一个 10% 路径（QuickTargets 才是日常入口）重排全表不值得。
                      副标题是唯一能解释「它和 Claude 有何不同」的位置。 */}
                  <button
                    onClick={() => selectType('crew')}
                    disabled={creating}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <CrewIcon size={14} className="shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Kiro Crew</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">有记忆的 AI agent</div>
                    </div>
                  </button>
                  <button
                    onClick={() => selectType('codex')}
                    disabled={creating}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <CodexIcon size={14} className="text-[var(--text-primary)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Codex</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent (MCP)</div>
                    </div>
                  </button>
                  {vaultEnabled && !pendingAgentContext && (
                    <button
                      onClick={() => runCreate(() => onCreate('vault'))}
                      disabled={creating}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <BookOpen size={14} className="text-[var(--accent-blue)] shrink-0" />
                      <div className="text-left">
                        <div className="font-medium">Obsidian 文档</div>
                        <div className="text-[10px] text-[var(--text-secondary)]">笔记库(与会话无缝切换)</div>
                      </div>
                    </button>
                  )}
                </>
              )}

              {step === 'pick-dir' && (
                <>
                  {/* Header with back and current path */}
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <button
                      onClick={() => setStep('pick-type')}
                      className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                      title="Back"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider truncate flex-1">
                      Select directory
                    </span>
                    {dir.parentPath && (
                      <button
                        onClick={() => dir.load(dir.homePath)}
                        className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                        title="Home"
                      >
                        <Home size={12} />
                      </button>
                    )}
                  </div>

                  {/* Current path display + use-this button */}
                  <div className="px-3 py-1.5 border-b border-[var(--border)]">
                    <div className="text-[10px] text-[var(--text-muted)] truncate mb-1" title={dir.currentPath}>
                      {dir.currentPath.replace(dir.homePath, '~')}
                    </div>
                    <button
                      onClick={() => selectDir(dir.currentPath)}
                      disabled={!dir.currentPath || creating}
                      className="w-full py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Use this directory
                    </button>
                  </div>

                  {/* Navigation: parent */}
                  {dir.parentPath && (
                    <button
                      onClick={() => dir.load(dir.parentPath ?? undefined)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <ChevronLeft size={12} className="shrink-0" />
                      <span>..</span>
                    </button>
                  )}

                  {/* Directory list */}
                  <div className="max-h-48 overflow-y-auto">
                    {dir.loading ? (
                      <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">Loading...</div>
                    ) : dir.error ? (
                      <div className="px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-[var(--accent-red)] truncate">{dir.error}</span>
                        <button
                          onClick={dir.retry}
                          className="shrink-0 px-2 py-0.5 text-[10px] font-semibold bg-[var(--bg-hover)] hover:bg-[var(--border)] text-[var(--text-primary)] rounded transition-colors"
                        >
                          重试
                        </button>
                      </div>
                    ) : dir.dirs.length === 0 ? (
                      <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">No subdirectories</div>
                    ) : (
                      dir.dirs.map(d => (
                        <button
                          key={d.path}
                          onClick={() => dir.load(d.path)}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                        >
                          {d.is_git ? (
                            <FolderGit2 size={13} className="text-[var(--accent-green-text)] shrink-0" />
                          ) : (
                            <Folder size={13} className="text-[var(--text-muted)] shrink-0" />
                          )}
                          <span className="truncate">{d.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}

              {step === 'pick-prompt' && (
                <>
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <button
                      onClick={() => setStep(dir.currentPath && !pendingAgentContext && !pendingSkipPrompt ? 'pick-dir' : 'pick-type')}
                      className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                      title="Back"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Initial prompt (optional)</span>
                  </div>
                  <div className="p-2 flex flex-col gap-2">
                    {/* Always render the row so "✎ 管理" is reachable even with 0 presets / load failure. */}
                    <div className="flex flex-wrap items-center gap-1">
                      {presetStore.presets.map(p => (
                        <button
                          key={p.id}
                          onClick={() => setPromptDraft(applyPreset(p.body, promptDraft))}
                          title={p.body}
                          className="px-2 py-0.5 text-[10px] rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-blue)] transition-colors truncate max-w-[120px]"
                        >
                          {p.title}
                        </button>
                      ))}
                      <button
                        onClick={() => setStep('manage-prompts')}
                        className="px-2 py-0.5 text-[10px] rounded-full text-[var(--accent-blue)] hover:opacity-80"
                      >
                        ✎ 管理
                      </button>
                    </div>
                    <textarea
                      autoFocus
                      value={promptDraft}
                      onChange={e => setPromptDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitWithPrompt() }
                        else if (e.key === 'Escape') { e.preventDefault(); close() }
                      }}
                      placeholder="给 agent 的第一条指令，留空则只创建会话"
                      className="w-full h-24 resize-none rounded bg-[var(--bg-secondary)] border border-[var(--border)] p-2 text-base text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                    />
                    <div className="flex justify-end gap-2">
                      {promptDraft.trim() ? (
                        <>
                          <button
                            onClick={submitSkip}
                            disabled={creating}
                            className="px-2 py-1 text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                          >
                            Skip &amp; create
                          </button>
                          <button
                            onClick={submitWithPrompt}
                            disabled={creating}
                            className="px-3 py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors"
                          >
                            Create &amp; send
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={submitSkip}
                          disabled={creating}
                          className="px-3 py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors"
                        >
                          Create
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* A sub-view of the same popover, never a second Sheet: on phones the
                  popover already IS a bottom Sheet (no Sheet-in-Sheet). */}
              {step === 'manage-prompts' && (
                <>
                  <div className="flex items-center gap-1 px-2 min-h-[var(--row-h)] border-b border-[var(--border)]">
                    <button
                      onClick={() => setStep('pick-prompt')}
                      aria-label="返回"
                      className="inline-flex items-center justify-center min-w-[var(--hit)] min-h-[var(--hit)] text-[var(--fg-muted)] hover:text-[var(--fg)] rounded-[var(--r-sm)] transition-colors"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-ui-2xs font-semibold text-[var(--fg-subtle)] uppercase tracking-wider">管理常用 prompt</span>
                  </div>
                  <PromptManager
                    embedded
                    presets={presetStore.presets}
                    error={presetStore.error}
                    onAdd={presetStore.add}
                    onEdit={presetStore.edit}
                    onRemove={presetStore.remove}
                    onClose={() => setStep('pick-prompt')}
                  />
                </>
              )}
            </div>
        </Popover>

        <div className="flex justify-center py-2">
          <SegmentedControl
            label="主题"
            value={themePref}
            onChange={onSetThemePref}
            options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
          />
        </div>

        <button
          ref={setSettingsBtn}
          onClick={() => setShowSettings(v => !v)}
          aria-haspopup="menu"
          aria-expanded={showSettings}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors min-h-[40px]"
        >
          <Settings size={14} />
          <span>Settings</span>
        </button>

        <Menu
          open={showSettings}
          onClose={() => setShowSettings(false)}
          anchor={settingsBtn}
          title="设置"
          items={[
            { label: '推送通知', icon: Bell, onSelect: () => onOpenPanel('push') },
            { label: '常用 prompt 管理', icon: Pencil, onSelect: () => onOpenPanel('prompts') },
            ...(isAdmin ? [{ label: '用户管理', icon: Users, onSelect: () => onOpenPanel('admin') }] : []),
          ]}
        />

      </div>
    </div>
  )

  // Mobile: overlay with backdrop
  if (mobile) {
    return (
      <div className="fixed inset-0 z-50 flex">
        {panel}
        <div className="flex-1 bg-black/50" onClick={onToggle} />
      </div>
    )
  }

  return panel
}
