import { useState, useCallback } from 'react'
import type { SessionInfo, SessionType, DirEntry, UserInfo, TmuxSession } from '../lib/api'
import { listDirectories, listTmuxSessions } from '../lib/api'
import type { Theme } from '../lib/theme'
import { Terminal, Bot, Plus, X, PanelLeftClose, PanelLeft, Sun, Moon, Sparkles, Folder, FolderGit2, ChevronLeft, Home, LogOut, Users, MonitorUp, Link, Cpu } from 'lucide-react'
import AdminPanel from './AdminPanel'
import { StatusDot } from './SessionInfoBar'

interface Props {
  sessions: SessionInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (type: SessionType, workDir?: string, tmuxTarget?: string) => void
  onDelete: (id: string) => void
  onLogout: () => void
  theme: Theme
  onToggleTheme: () => void
  user: UserInfo | null
  open: boolean
  onToggle: () => void
  mobile: boolean
}

type NewSessionStep = 'closed' | 'pick-type' | 'pick-terminal-mode' | 'pick-dir' | 'pick-tmux'

/** Per-agent-type icon used in session list rows. Kept in one place so the
 *  sidebar's two render sites (active row, condensed row) stay in sync as
 *  agent types are added. */
function SessionTypeIcon({ type, size = 14, className }: { type: SessionType; size?: number; className?: string }) {
  switch (type) {
    case 'claude': return <Bot size={size} className={className} />
    case 'kiro':   return <Sparkles size={size} className={className} />
    case 'codex':  return <Cpu size={size} className={className} />
    case 'tmux':
    default:       return <Terminal size={size} className={className} />
  }
}

export default function Sidebar({ sessions, activeId, onSelect, onCreate, onDelete, onLogout, theme, onToggleTheme, user, open, onToggle, mobile }: Props) {
  const [step, setStep] = useState<NewSessionStep>('closed')
  const [pendingType, setPendingType] = useState<SessionType | null>(null)
  const [showAdmin, setShowAdmin] = useState(false)
  const isAdmin = user?.role === 'admin'

  // Directory browser state
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [homePath, setHomePath] = useState('')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)

  // Tmux session list state
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([])
  const [tmuxLoading, setTmuxLoading] = useState(false)

  const ThemeIcon = theme === 'dark' ? Sun : Moon

  const loadDirs = useCallback(async (path?: string) => {
    setLoading(true)
    try {
      const data = await listDirectories(path)
      setCurrentPath(data.current)
      setParentPath(data.parent)
      setHomePath(data.home)
      setDirs(data.entries)
    } catch { /* ignore */ }
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
    if (pendingType) {
      onCreate(pendingType, path)
    }
    setStep('closed')
  }

  const close = () => {
    setStep('closed')
    setPendingType(null)
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
            className={`p-1.5 rounded transition-colors ${
              s.id === activeId
                ? 'bg-[var(--bg-primary)] text-[var(--accent-blue)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title={s.name}
          >
            <SessionTypeIcon type={s.type} size={14} />
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
          {isAdmin && (
            <button
              onClick={() => setShowAdmin(true)}
              className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-purple)] rounded transition-colors"
              title="User management"
            >
              <Users size={14} />
            </button>
          )}
          <button
            onClick={onToggleTheme}
            className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            <ThemeIcon size={14} />
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

      {/* Sessions */}
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.map(s => (
          <div
            key={s.id}
            onClick={() => handleSelect(s.id)}
            className={`group flex items-center gap-2 px-3 py-1.5 mx-1 rounded cursor-pointer text-xs transition-colors ${
              s.id === activeId
                ? 'bg-[var(--bg-primary)] text-[var(--accent-blue)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <StatusDot status={s.status} />
            <SessionTypeIcon type={s.type} size={13} className="shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="truncate">{s.name}</div>
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
      </div>

      {/* New session */}
      <div className="relative px-2 py-3 border-t border-[var(--border)]">
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
                    <Bot size={14} className="text-[var(--accent-purple)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Claude Code</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent</div>
                    </div>
                  </button>
                  <button
                    onClick={() => selectType('kiro')}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Sparkles size={14} className="text-[var(--accent-yellow)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Kiro</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent (ACP)</div>
                    </div>
                  </button>
                  <button
                    onClick={() => selectType('codex')}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Cpu size={14} className="text-[var(--accent-blue)] shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Codex</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">AI coding agent (MCP)</div>
                    </div>
                  </button>
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
