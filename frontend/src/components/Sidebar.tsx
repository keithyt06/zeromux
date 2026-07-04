import { useState, useEffect, useCallback, useRef } from 'react'
import type { SessionInfo, SessionType, DirEntry, UserInfo, TmuxSession } from '../lib/api'
import { listDirectories, listTmuxSessions, getSchedulerHealth, getVaultMeta } from '../lib/api'
import { shouldShowVault } from '../lib/vault'
import type { Theme } from '../lib/theme'
import { Terminal, Plus, X, PanelLeftClose, PanelLeft, Sun, Moon, Folder, FolderGit2, ChevronLeft, Home, LogOut, Users, MonitorUp, Link, Clock, Bell, BookOpen, Settings, Pencil } from 'lucide-react'
import { type DocTab } from '../lib/docTabs'
import AdminPanel from './AdminPanel'
import ScheduledTasksPanel from './ScheduledTasksPanel'
import PromptManager from './PromptManager'
import PushSettings from './PushSettings'
import { usePromptPresets } from '../lib/usePromptPresets'
import { applyPreset } from '../lib/applyPreset'
import { isStuck } from '../lib/stuck'
import { ClaudeCodeIcon, KiroIcon, CodexIcon } from './BrandIcons'

interface Props {
  sessions: SessionInfo[]
  docTabs: DocTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (type: SessionType | 'vault', workDir?: string, tmuxTarget?: string, initialPrompt?: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  hasUnread: (s: SessionInfo) => boolean
  onLogout: () => void
  theme: Theme
  onToggleTheme: () => void
  user: UserInfo | null
  open: boolean
  onToggle: () => void
  mobile: boolean
  confirmCount?: number
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

type NewSessionStep = 'closed' | 'pick-type' | 'pick-terminal-mode' | 'pick-dir' | 'pick-tmux' | 'pick-prompt' | 'manage-prompts'

/** Per-agent-type icon used in session list rows. Kept in one place so the
 *  sidebar's two render sites (active row, condensed row) stay in sync as
 *  agent types are added. */
function SessionTypeIcon({ type, size = 14, className }: { type: SessionType; size?: number; className?: string }) {
  switch (type) {
    case 'claude': return <ClaudeCodeIcon size={size} className={className} />
    case 'kiro':   return <KiroIcon size={size} className={className} />
    case 'codex':  return <CodexIcon size={size} className={className} />
    case 'tmux':
    default:       return <Terminal size={size} className={className} />
  }
}

export default function Sidebar({ sessions, docTabs, activeId, onSelect, onCreate, onDelete, onRename, hasUnread, onLogout, theme, onToggleTheme, user, open, onToggle, mobile, confirmCount = 0 }: Props) {
  const [step, setStep] = useState<NewSessionStep>('closed')
  const [pendingType, setPendingType] = useState<SessionType | null>(null)
  const [promptDraft, setPromptDraft] = useState('')
  const [pendingDir, setPendingDir] = useState<string | null>(null)
  const presetStore = usePromptPresets()
  const [showAdmin, setShowAdmin] = useState(false)
  const [showScheduled, setShowScheduled] = useState(false)
  const [showPushSettings, setShowPushSettings] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPromptManager, setShowPromptManager] = useState(false)
  const [vaultEnabled, setVaultEnabled] = useState(false)
  const [schedulerHealthy, setSchedulerHealthy] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)

  const commitRename = (id: string, name: string) => {
    setEditingId(null)
    onRename(id, name)
  }
  const isAdmin = user?.role === 'admin'

  // Poll scheduler health (once on mount, then every 60s)
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const h = await getSchedulerHealth()
        if (!cancelled) setSchedulerHealthy(h.healthy)
      } catch { /* ignore */ }
    }
    check()
    const id = setInterval(check, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Vault availability (gate the Obsidian sidebar entry on server config)
  useEffect(() => { getVaultMeta().then(m => setVaultEnabled(shouldShowVault(m))).catch(() => {}) }, [])

  // Directory browser state
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [homePath, setHomePath] = useState('')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  // 加载失败（超时/网络/权限）时记下来，连同上次的 path，供「重试」按钮用。
  // 没有它时 fetch 卡住会永远停在 Loading…（手机弱网下的实际表现）。
  const [dirError, setDirError] = useState<string | null>(null)
  const lastDirPath = useRef<string | undefined>(undefined)

  // Tmux session list state
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([])
  const [tmuxLoading, setTmuxLoading] = useState(false)

  const ThemeIcon = theme === 'dark' ? Sun : Moon

  const loadDirs = useCallback(async (path?: string) => {
    lastDirPath.current = path
    setLoading(true)
    setDirError(null)
    try {
      const data = await listDirectories(path)
      setCurrentPath(data.current)
      setParentPath(data.parent)
      setHomePath(data.home)
      setDirs(data.entries)
    } catch (e) {
      // 超时（AbortError）或网络/权限错误：显式报错 + 让用户重试，
      // 而不是静默停在 Loading…。
      const msg = e instanceof DOMException && e.name === 'AbortError'
        ? '加载超时，请重试'
        : (e instanceof Error ? e.message : '加载失败')
      setDirError(msg)
    }
    setLoading(false)
  }, [])

  const loadTmuxSessions = useCallback(async () => {
    setTmuxLoading(true)
    try {
      const sessions = await listTmuxSessions()
      setTmuxSessions(sessions)
    } catch { setTmuxSessions([]) }
    setTmuxLoading(false)
  }, [])

  const openTypePicker = () => {
    setStep('pick-type')
    setPendingType(null)
  }

  const selectType = (type: SessionType) => {
    setPendingType(type)
    if (type === 'tmux') {
      setStep('pick-terminal-mode')
    } else {
      setStep('pick-dir')
      loadDirs()
    }
  }

  const selectNewShell = () => {
    setStep('pick-dir')
    loadDirs()
  }

  const selectAttachTmux = () => {
    setStep('pick-tmux')
    loadTmuxSessions()
  }

  const attachTmuxSession = (name: string) => {
    onCreate('tmux', undefined, name)
    setStep('closed')
  }

  const selectDir = (path: string) => {
    if (!pendingType) { setStep('closed'); return }
    if (pendingType === 'tmux') {
      onCreate('tmux', path)
      setStep('closed')
    } else {
      setPendingDir(path)
      setPromptDraft('')
      presetStore.reload()
      setStep('pick-prompt')
    }
  }

  const close = () => {
    setStep('closed')
    setPendingType(null)
    setPromptDraft('')
    setPendingDir(null)
  }

  const submitWithPrompt = () => {
    if (!pendingType || !pendingDir) { setStep('closed'); return }
    const trimmed = promptDraft.trim()
    onCreate(pendingType, pendingDir, undefined, trimmed ? promptDraft : undefined)
    setPromptDraft('')
    setPendingDir(null)
    setStep('closed')
  }
  const submitSkip = () => {
    if (!pendingType || !pendingDir) { setStep('closed'); return }
    onCreate(pendingType, pendingDir)
    setPromptDraft('')
    setPendingDir(null)
    setStep('closed')
  }

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
            onClick={() => setShowScheduled(true)}
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

      {/* Admin Panel overlay */}
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}

      {/* Scheduled Tasks overlay */}
      {showScheduled && <ScheduledTasksPanel onClose={() => setShowScheduled(false)} />}

      {/* Push Settings overlay */}
      {showPushSettings && <PushSettings onClose={() => setShowPushSettings(false)} />}

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
                <span className="ml-auto text-[10px] text-[var(--text-muted)] shrink-0">{relativeTime(s.last_activity_ms)}</span>
              </div>
              {s.description && (
                <div className="truncate text-[10px] text-[var(--text-muted)] -mt-0.5">{s.description}</div>
              )}
            </div>
            <button
              onClick={e => { e.stopPropagation(); onDelete(s.id) }}
              className="p-0.5 opacity-0 group-hover:opacity-100 text-[var(--text-secondary)] hover:text-[var(--accent-red)] transition-all"
              title="Delete session"
            >
              <X size={12} />
            </button>
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
      </div>

      {/* New session */}
      <div className="relative px-2 py-3 border-t border-[var(--border)]">
        <button
          onClick={() => setShowSettings(true)}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors min-h-[40px]"
        >
          <Settings size={14} />
          <span>Settings</span>
        </button>

        {showSettings && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowSettings(false)} />
            <div className="absolute bottom-full left-2 mb-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg py-1 w-56 z-20 shadow-xl">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Settings</div>
              <button
                onClick={onToggleTheme}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <ThemeIcon size={14} className="shrink-0" />
                <span className="flex-1 text-left">{theme === 'dark' ? '浅色模式' : '深色模式'}</span>
              </button>
              <button
                onClick={() => { setShowSettings(false); setShowPushSettings(true) }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <Bell size={14} className="shrink-0" />
                <span className="flex-1 text-left">推送通知</span>
              </button>
              <button
                onClick={() => { setShowSettings(false); presetStore.reload(); setShowPromptManager(true) }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <Pencil size={14} className="shrink-0" />
                <span className="flex-1 text-left">常用 prompt 管理</span>
              </button>
              {isAdmin && (
                <button
                  onClick={() => { setShowSettings(false); setShowAdmin(true) }}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <Users size={14} className="shrink-0" />
                  <span className="flex-1 text-left">用户管理</span>
                </button>
              )}
            </div>
          </>
        )}

        {showPromptManager && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowPromptManager(false)} />
            <div className="absolute bottom-full left-2 mb-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg py-1 w-56 z-20 shadow-xl">
              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider flex-1">管理常用 prompt</span>
              </div>
              <PromptManager
                presets={presetStore.presets}
                error={presetStore.error}
                onAdd={presetStore.add}
                onEdit={presetStore.edit}
                onRemove={presetStore.remove}
                onClose={() => setShowPromptManager(false)}
              />
            </div>
          </>
        )}

        <button
          onClick={openTypePicker}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors min-h-[40px]"
        >
          <Plus size={14} />
          <span>New session</span>
        </button>

        {step !== 'closed' && (
          <>
            <div className="fixed inset-0 z-10" onClick={close} />
            <div className="absolute bottom-full left-2 mb-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg py-1 w-56 z-20 shadow-xl">
              {step === 'pick-type' && (
                <>
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Select type</div>
                  <button
                    onClick={() => selectType('tmux')}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Terminal size={14} className="text-[var(--accent-green-text)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Terminal</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">bash / tmux shell</div>
                    </div>
                  </button>
                  <button
                    onClick={() => selectType('claude')}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <ClaudeCodeIcon size={14} className="shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Claude Code</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent</div>
                    </div>
                  </button>
                  <button
                    onClick={() => selectType('kiro')}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <KiroIcon size={14} className="shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Kiro</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent (ACP)</div>
                    </div>
                  </button>
                  <button
                    onClick={() => selectType('codex')}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <CodexIcon size={14} className="text-[var(--text-primary)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Codex</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent (MCP)</div>
                    </div>
                  </button>
                  {vaultEnabled && (
                    <button
                      onClick={() => { onCreate('vault'); setStep('closed') }}
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

              {step === 'pick-terminal-mode' && (
                <>
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <button
                      onClick={() => setStep('pick-type')}
                      className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                      title="Back"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">Terminal mode</span>
                  </div>
                  <button
                    onClick={selectNewShell}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <MonitorUp size={14} className="text-[var(--accent-green-text)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">New Shell</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">Start a fresh terminal</div>
                    </div>
                  </button>
                  <button
                    onClick={selectAttachTmux}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Link size={14} className="text-[var(--accent-blue)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Attach tmux</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">Connect to existing session</div>
                    </div>
                  </button>
                </>
              )}

              {step === 'pick-tmux' && (
                <>
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <button
                      onClick={() => setStep('pick-terminal-mode')}
                      className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                      title="Back"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">tmux sessions</span>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {tmuxLoading ? (
                      <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">Loading...</div>
                    ) : tmuxSessions.length === 0 ? (
                      <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">No tmux sessions running</div>
                    ) : (
                      tmuxSessions.map(s => (
                        <button
                          key={s.name}
                          onClick={() => attachTmuxSession(s.name)}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                        >
                          <Terminal size={13} className="text-[var(--accent-green-text)] shrink-0" />
                          <div className="flex-1 min-w-0 text-left">
                            <div className="font-medium truncate">{s.name}</div>
                            <div className="text-[10px] text-[var(--text-secondary)]">
                              {s.windows} window{s.windows !== 1 ? 's' : ''}{s.attached > 0 ? ' · attached' : ''}
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
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
                    {parentPath && (
                      <button
                        onClick={() => loadDirs(homePath)}
                        className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                        title="Home"
                      >
                        <Home size={12} />
                      </button>
                    )}
                  </div>

                  {/* Current path display + use-this button */}
                  <div className="px-3 py-1.5 border-b border-[var(--border)]">
                    <div className="text-[10px] text-[var(--text-muted)] truncate mb-1" title={currentPath}>
                      {currentPath.replace(homePath, '~')}
                    </div>
                    <button
                      onClick={() => selectDir(currentPath)}
                      className="w-full py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors"
                    >
                      Use this directory
                    </button>
                  </div>

                  {/* Navigation: parent */}
                  {parentPath && (
                    <button
                      onClick={() => loadDirs(parentPath)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <ChevronLeft size={12} className="shrink-0" />
                      <span>..</span>
                    </button>
                  )}

                  {/* Directory list */}
                  <div className="max-h-48 overflow-y-auto">
                    {loading ? (
                      <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">Loading...</div>
                    ) : dirError ? (
                      <div className="px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-[var(--accent-red)] truncate">{dirError}</span>
                        <button
                          onClick={() => loadDirs(lastDirPath.current)}
                          className="shrink-0 px-2 py-0.5 text-[10px] font-semibold bg-[var(--bg-hover)] hover:bg-[var(--border)] text-[var(--text-primary)] rounded transition-colors"
                        >
                          重试
                        </button>
                      </div>
                    ) : dirs.length === 0 ? (
                      <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">No subdirectories</div>
                    ) : (
                      dirs.map(d => (
                        <button
                          key={d.path}
                          onClick={() => loadDirs(d.path)}
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
                      onClick={() => setStep('pick-dir')}
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
                      className="w-full h-24 resize-none rounded bg-[var(--bg-secondary)] border border-[var(--border)] p-2 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
                    />
                    <div className="flex justify-end gap-2">
                      {promptDraft.trim() ? (
                        <>
                          <button
                            onClick={submitSkip}
                            className="px-2 py-1 text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                          >
                            Skip &amp; create
                          </button>
                          <button
                            onClick={submitWithPrompt}
                            className="px-3 py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors"
                          >
                            Create &amp; send
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={submitSkip}
                          className="px-3 py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors"
                        >
                          Create
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}

              {step === 'manage-prompts' && (
                <>
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <button
                      onClick={() => setStep('pick-prompt')}
                      className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                      title="Back"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">管理常用 prompt</span>
                  </div>
                  <PromptManager
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
          </>
        )}
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
