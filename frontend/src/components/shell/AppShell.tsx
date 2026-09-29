import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, PanelLeft, PanelLeftClose, Plus, Search, SkipForward, X } from 'lucide-react'
import type { SessionInfo, TmuxHealth, UserInfo } from '../../lib/api'
import { getTmuxHealth, getVaultMeta } from '../../lib/api'
import { shouldShowVault } from '../../lib/vault'
import type { useTheme } from '../../lib/theme'
import { useIsNarrow, useMediaQuery } from '../../lib/useMediaQuery'
import { usePolling } from '../../lib/usePolling'
import { groupTriage, needsYouCount, nextNeedsYou, triage, toneOf, labelOf } from '../../lib/triage'
import { sessionActions } from '../../lib/sessionActions'
import { peerNamesKey, peerNamesFromKey } from '../../lib/peer'
import { loadLastType } from '../../lib/paletteParse'
import { askAgentPrompt, type AskAgentTarget } from '../../lib/askAgent'
import TerminalView from '../TerminalView'
import { SendToMenu } from '../SendToMenu'
import AcpChatView from '../AcpChatView'
import { Toaster, DialogHost, Sheet, IconButton, StatusDot, toast, ErrorBoundary } from '../ui'
import { useShellState, type ContextTab } from './useShellState'
import { TriageHeader, type ShellPanel } from './TriageHeader'
import { TriageList } from './TriageList'
import { CommandPalette } from './CommandPalette'
import { FocusHeader } from './FocusHeader'
import { ContextPanel } from './ContextPanel'
import { RenameDialog } from './RenameDialog'
import { TypeIcon } from './TypeIcon'
import { useNextKeys } from './useNextKeys'
import { buildPaletteActions, askAgentPaletteText } from './paletteActions'
import { VaultReader, MemoryPanel, AdminPanel, ScheduledTasksPanel, PushSettings, PromptsSheet } from './lazyPanels'

type ThemeCtx = ReturnType<typeof useTheme>
type PaletteInit = { mode: 'search' | 'new'; text?: string }

const WIDE_MQ = '(min-width: 1280px)'   // ContextPanel is an inline 360px column (S3 V3)
const LG_MQ = '(min-width: 1024px)'     // full 272px triage column; md–lg gets the 56px rail

/** Triage + Focus shell (spec v3 §0.5). Owns layout only; state lives in useShellState. */
export function AppShell({ user, theme, onLogout, onAuthLost }: {
  user: UserInfo | null
  theme: ThemeCtx
  onLogout(): void
  onAuthLost(): void
}) {
  const narrow = useIsNarrow()
  const wide = useMediaQuery(WIDE_MQ)
  const lg = useMediaQuery(LG_MQ)
  const shell = useShellState(true, onAuthLost, { narrow, wide })
  const { sessions, docTabs, activeId, select } = shell
  const shellRef = useRef(shell)
  useEffect(() => { shellRef.current = shell })
  const wideRef = useRef(wide)
  useEffect(() => { wideRef.current = wide }, [wide])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 3000); return () => clearInterval(t) }, [])

  const [vaultEnabled, setVaultEnabled] = useState(false)
  useEffect(() => { getVaultMeta().then(m => setVaultEnabled(shouldShowVault(m))).catch(() => {}) }, [])

  // tmux health is a global endpoint (not per-session): poll it once here and
  // pass the result down to every terminal's TmuxHealthBar (§4.6), instead of
  // each TerminalView fetching its own redundant copy. GET /api/tmux/health is
  // admin-only (403 for others) and pointless with no tmux session open, so
  // gate the poll on both — otherwise a non-admin OAuth user, or anyone with
  // zero tmux sessions, would hit it every 30s forever for nothing.
  const [tmuxHealth, setTmuxHealth] = useState<TmuxHealth | null>(null)
  const pollTmuxHealth = useCallback(async () => { setTmuxHealth(await getTmuxHealth()) }, [])
  const hasTmuxSession = sessions.some(s => s.type === 'tmux')
  usePolling(pollTmuxHealth, 30_000, { enabled: hasTmuxSession && user?.role === 'admin' })

  const [palette, setPalette] = useState<PaletteInit | null>(null)
  const [panel, setPanel] = useState<ShellPanel | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [railExpanded, setRailExpanded] = useState(false)

  const peerKey = peerNamesKey(sessions)
  const peerNames = useMemo(() => peerNamesFromKey(peerKey), [peerKey])

  const groups = useMemo(() => groupTriage(sessions, { now, activeId, lastViewedMs: shell.lastViewedMs, confirmsBySession: shell.confirmsBySession }),
    [sessions, now, activeId, shell.lastViewedMs, shell.confirmsBySession])
  const needsYou = needsYouCount(groups)
  const groupsRef = useRef(groups)
  useEffect(() => { groupsRef.current = groups }, [groups])
  useEffect(() => { document.title = needsYou > 0 ? `(${needsYou}) ZeroMux` : 'ZeroMux' }, [needsYou])

  const active = sessions.find(s => s.id === activeId) ?? null
  const activeDoc = docTabs.find(t => t.id === activeId) ?? null
  const activeCtx = active ? shell.contextOf(active) : null

  // shell.close / openHistory are stable, so memoized rows' actions never go stale.
  const { close: closeSession, openHistory } = shell
  const actionEnv = useMemo(() => ({
    rename: (id: string) => setRenamingId(id),
    close: (id: string) => { closeSession(id) },
    openHistory,
  }), [closeSession, openHistory])
  const actionsFor = useCallback((s: SessionInfo) => sessionActions(s, actionEnv), [actionEnv])

  const openPalette = useCallback((init: PaletteInit = { mode: 'search' }) => {
    const sh = shellRef.current
    // Never stack the palette on the ContextPanel sheet (R13: no Sheet in Sheet).
    const cur = sh.sessions.find(s => s.id === sh.activeId)
    if (cur && !wideRef.current && sh.contextOf(cur).open) sh.setContext(cur.id, { open: false })
    setPalette(init)
  }, [])
  const next = useCallback(() => {
    const id = nextNeedsYou(groupsRef.current, shellRef.current.activeId)
    if (id) shellRef.current.select(id)
    else toast.push({ message: '都处理完了' })
  }, [])
  useNextKeys({ onNext: next, onPalette: openPalette })

  const setContext = shell.setContext
  // Stable (sid) => void; AcpChatView binds its own id, so TurnView's memo holds (I-9).
  const openChanges = useCallback((sid: string) => setContext(sid, { open: true, tab: 'git', nonce: Date.now() }), [setContext])
  const openContext = useCallback((sid: string, tab: ContextTab) => setContext(sid, { open: true, tab }), [setContext])
  const toggleContext = (s: SessionInfo) => {
    setContext(s.id, { open: !shell.contextOf(s).open })
  }
  // The inline column changes the terminal's width; TerminalView now watches its
  // own container with a ResizeObserver, so no synthetic window resize is needed.
  const ctxOpen = !!activeCtx?.open

  // SendToMenu「＋ 新开…」= ⌘K new mode prefilled (M24).
  const openNewPrefilled = useCallback(({ workDir, prompt }: { workDir: string | null; prompt: string }) => {
    openPalette({ mode: 'new', text: askAgentPaletteText(loadLastType(), workDir ?? '', prompt) })
  }, [openPalette])
  // VaultReader ⚡ → SendToMenu (M24/V6). VaultReader reports only the note, so the
  // ⚡ button is captured from the click on its way down (onClickCapture below).
  const askAnchorRef = useRef<HTMLElement | null>(null)
  const [noteSend, setNoteSend] = useState<{ anchor: HTMLElement | null; text: string; workDir: string } | null>(null)
  const askAgentFromNote = (t: AskAgentTarget) => {
    setNoteSend({ anchor: askAnchorRef.current, text: askAgentPrompt(t), workDir: t.absDir })
  }
  const sendTo = (workDir: string) => ({
    workDir, sessions, controls: shell.controls, queueModes: shell.queueModes, onSelectSession: select, onNew: openNewPrefilled,
  })
  // Terminal output is multi-line (fenced): 「＋ 新开…」 creates directly with the full
  // prompt — ⌘K's single-line input would strip the newlines (§B7a).
  const createWithPrompt = ({ workDir, prompt }: { workDir: string | null; prompt: string }) => {
    const last = loadLastType()
    shell.create(last === 'tmux' ? 'claude' : last, workDir ?? undefined, undefined, prompt).catch(() => toast.push({ message: '创建会话失败' }))
  }

  const openPrompts = useCallback(() => setPanel('prompts'), [])
  // The callbacks read refs only when an action runs (click / Enter), never during render.
  // eslint-disable-next-line react-hooks/refs
  const actions = buildPaletteActions({
    isAdmin: user?.role === 'admin', vaultEnabled, active,
    activeActions: active ? actionsFor(active) : [],
    next, toggleTheme: theme.toggle, openPanel: setPanel,
    openVault: () => { shell.create('vault') },
    openContext: tab => { if (active) openContext(active.id, tab) },
    openMemory: () => setMemoryOpen(true),
    logout: onLogout,
  })

  const header = (
    <TriageHeader user={user} narrow={narrow} orphanConfirms={shell.orphanConfirms} schedulerHealthy={shell.schedulerHealthy}
      themePref={theme.pref} onSetThemePref={theme.setPref} onOpenPalette={() => openPalette()} onOpenPanel={setPanel} onLogout={onLogout} />
  )
  const list = (
    <TriageList sessions={sessions} activeId={activeId} onSelect={select} lastViewedMs={shell.lastViewedMs}
      confirmsBySession={shell.confirmsBySession} controls={shell.controls} actionsFor={actionsFor} now={now}
      hostTmux={shell.hostTmux} onAttachTmux={name => { shell.create('tmux', undefined, name).catch(e => toast.push({ message: `接入失败:${(e as Error).message}` })) }}
      docTabs={docTabs} onCloseDocTab={shell.closeDocTab} onOpenConfirm={() => setPanel('scheduled')} />
  )

  const sessionLayer = (
    <div className="flex-1 min-h-0 relative">
      {sessions.map(s => {
        const isActive = s.id === activeId
        return (
          <div key={s.id} data-session-pane={s.id} data-active={isActive ? '1' : '0'} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}>
            {s.type === 'tmux' ? (
              <TerminalView sessionId={s.id} active={isActive} theme={theme.theme} tmuxName={s.tmux_name} tmuxOrigin={s.tmux_origin} tmuxHealth={tmuxHealth}
                onClose={() => shell.close(s.id)} historyRequest={shell.historyReq?.id === s.id ? shell.historyReq.nonce : 0}
                sendTo={{ ...sendTo(s.work_dir), excludeId: s.id, onNew: createWithPrompt }} />
            ) : (
              <AcpChatView sessionId={s.id} active={isActive} agentType={s.type} onRegisterControls={shell.registerControls}
                onQueueModeChange={shell.onQueueModeChange} queueMode={shell.queueModes[s.id] ?? 'collect'} onManagePresets={openPrompts} onOpenMemory={s.type === 'crew' ? () => setMemoryOpen(true) : undefined}
                peerNames={peerNames} onOpenChanges={openChanges}
                onCtxUsage={shell.onCtxUsage} />
            )}
          </div>
        )
      })}
      {docTabs.map(t => {
        const isActive = t.id === activeId
        return (
          <div key={t.id} className={`absolute inset-0 ${isActive ? '' : 'hidden'}`}
            onClickCapture={e => { askAnchorRef.current = (e.target as Element).closest('button') }}>
            <ErrorBoundary><Suspense fallback={null}>
              <VaultReader onTitleChange={(title) => shell.updateDocTabTitle(t.id, title)} target={shell.docTargets[t.id] ?? null} onAskAgent={askAgentFromNote} />
            </Suspense></ErrorBoundary>
          </div>
        )
      })}
      {!active && !activeDoc && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[var(--fg-subtle)]">
          {narrow && activeId ? (shell.sessionsLoaded && <>
            {/* Focused id vanished (closed elsewhere / push to a gone session): no FocusHeader, so give a way back. */}
            <p className="text-ui-sm">该会话已不存在</p>
            <button type="button" onClick={() => select(null)}
              className="ctl inline-flex items-center gap-1.5 px-3 rounded-[var(--r-md)] border border-[var(--border)] text-ui-sm text-[var(--fg)] hover:bg-[var(--surface-hover)]">
              <ChevronLeft size={14} />返回分诊
            </button>
          </>) : (<>
          <p className="text-ui-sm">{sessions.length === 0 && docTabs.length === 0 ? '创建一个会话开始' : '从左侧选择一个会话'}</p>
          <button type="button" onClick={() => openPalette({ mode: 'new' })}
            className="ctl inline-flex items-center gap-1.5 px-3 rounded-[var(--r-md)] border border-[var(--border)] text-ui-sm text-[var(--fg)] hover:bg-[var(--surface-hover)]">
            <Plus size={14} />新建…
          </button>
          </>)}
        </div>
      )}
    </div>
  )

  const focusHeader = active ? (
    <FocusHeader session={active} attention={triage(active, { now, activeId, lastViewedMs: shell.lastViewedMs, confirmsBySession: shell.confirmsBySession })}
      now={now} narrow={narrow} needsYou={needsYou} onBack={() => select(null)} actions={actionsFor(active)}
      panelOpen={ctxOpen} onTogglePanel={() => toggleContext(active)} ctxUsage={shell.ctxUsage[active.id]} />
  ) : activeDoc ? (
    <header className="shrink-0 flex items-center gap-2 px-2 min-h-[var(--row-h)] border-b border-[var(--border-subtle)] bg-[var(--surface-1)]">
      {narrow && (
        <button type="button" onClick={() => select(null)} aria-label={`返回分诊 (${needsYou})`}
          className="shrink-0 inline-flex items-center gap-0.5 min-h-[var(--hit)] px-1 rounded-[var(--r-md)] text-ui-sm text-[var(--accent)]">
          <ChevronLeft size={18} /><span>分诊</span>{needsYou > 0 && <span className="num">{`(${needsYou})`}</span>}
        </button>
      )}
      <BookOpen size={14} className="shrink-0 text-[var(--accent)]" />
      <span className="flex-1 min-w-0 truncate text-ui-sm font-medium text-[var(--fg-strong)]">{activeDoc.title}</span>
      <IconButton label="关闭文档" icon={X} onClick={() => shell.closeDocTab(activeDoc.id)} />
    </header>
  ) : null

  // ≥1280px: every session keeps its own inline panel mounted (hidden; tabs mount
  // lazily on first visit) so GitViewer's commit / FileBrowser's cwd survive
  // switching sessions and closing the panel (I-1). Below that, the active one as a Sheet.
  const contextColumn = wide && (
    <aside className={`w-[360px] shrink-0 border-l border-[var(--border-subtle)] bg-[var(--surface-1)] min-h-0 ${active && ctxOpen ? '' : 'hidden'}`}>
      {sessions.map(s => {
        const cc = shell.contextOf(s)
        return (
          <ContextPanel key={s.id} session={s} open={cc.open} tab={cc.tab} active={s.id === activeId} gitNonce={cc.nonce}
            onTab={t => setContext(s.id, { tab: t })} onClose={() => setContext(s.id, { open: false })} asSheet={false}
            sendTo={sendTo(s.work_dir)} onNotGit={shell.onNotGit} />
        )
      })}
    </aside>
  )
  const contextSheet = !wide && active && activeCtx && (
    <ContextPanel key={active.id} session={active} open={activeCtx.open} tab={activeCtx.tab} gitNonce={activeCtx.nonce}
      onTab={t => setContext(active.id, { tab: t })} onClose={() => setContext(active.id, { open: false })} asSheet
      sendTo={sendTo(active.work_dir)} onNotGit={shell.onNotGit} />
  )

  const rail = !narrow && !lg && !railExpanded
  const leftColumn = narrow ? null : rail ? (
    <nav aria-label="会话" className="w-14 shrink-0 flex flex-col items-center gap-1 py-2 border-r border-[var(--border-subtle)] bg-[var(--surface-2)] overflow-y-auto">
      <IconButton label="展开会话列表" icon={PanelLeft} onClick={() => setRailExpanded(true)} />
      <IconButton label="搜索或命令" icon={Search} onClick={() => openPalette()} />
      <span className="w-6 h-px bg-[var(--border)] my-1" />
      {groups.needsYou.concat(groups.running, groups.idle).map(({ s, attention }) => (
        <button key={s.id} type="button" onClick={() => select(s.id)} aria-label={s.name} title={s.name} aria-current={s.id === activeId ? 'true' : undefined}
          className={`relative min-w-[var(--hit)] min-h-[var(--hit)] w-10 h-10 inline-flex items-center justify-center rounded-[var(--r-md)] ${s.id === activeId ? 'bg-[var(--surface-3)] shadow-[inset_2px_0_0_var(--brand)]' : 'hover:bg-[var(--surface-hover)]'}`}>
          <TypeIcon type={s.type} size={16} />
          <span className="absolute top-1 right-1"><StatusDot tone={toneOf(attention)} label={labelOf(attention)} /></span>
        </button>
      ))}
      {docTabs.map(t => (
        <button key={t.id} type="button" onClick={() => select(t.id)} aria-label={t.title} title={t.title}
          className={`min-w-[var(--hit)] min-h-[var(--hit)] w-10 h-10 inline-flex items-center justify-center rounded-[var(--r-md)] ${t.id === activeId ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-hover)]'}`}>
          <BookOpen size={16} className="text-[var(--accent)]" />
        </button>
      ))}
    </nav>
  ) : (
    <div className="w-[272px] shrink-0 flex flex-col min-h-0 border-r border-[var(--border-subtle)] bg-[var(--surface-2)]">
      {header}
      <div className="flex-1 min-h-0 overflow-y-auto">{list}</div>
      {!lg && (
        <div className="shrink-0 border-t border-[var(--border-subtle)] p-1">
          <IconButton label="收起会话列表" icon={PanelLeftClose} onClick={() => setRailExpanded(false)} />
        </div>
      )}
    </div>
  )

  const fab = narrow && active && needsYou > 0 && (
    <div className="fixed right-3 z-sticky" style={{ bottom: active.type === 'tmux' ? 'calc(var(--composer-h, 72px) + 64px + env(safe-area-inset-bottom))' : 'calc(var(--composer-h, 72px) + 12px + env(safe-area-inset-bottom))' }}>
      <span className="inline-flex rounded-full bg-[var(--surface-3)] border border-[var(--border)] shadow-[var(--shadow-overlay)]">
        <IconButton label="下一个需要你的" icon={SkipForward} onClick={next} />
      </span>
    </div>
  )

  return (
    <div className="h-full flex bg-[var(--surface-1)] text-[var(--fg)]">
      {/* ONE stable tree for every width (I-1): crossing a breakpoint (rotation, window
          drag) only toggles classes, it never moves sessionLayer — moving it would
          remount every TerminalView/AcpChatView (new xterm, WS reconnect, replay). */}
      <div className={narrow && !activeId ? 'flex-1 min-w-0 flex flex-col min-h-0' : 'hidden'}>
        {narrow && header}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {narrow && list}
          {narrow && sessions.length === 0 && docTabs.length === 0 && <p className="px-4 py-8 text-center text-ui-sm text-[var(--fg-subtle)]">创建一个会话开始</p>}
        </div>
        <div className="shrink-0 p-2 border-t border-[var(--border-subtle)]" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}>
          <button type="button" onClick={() => openPalette()}
            className="w-full min-h-[48px] flex items-center gap-2 px-3 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-2)] text-left text-ui-input text-[var(--fg-subtle)]">
            <Search size={16} className="shrink-0" /><span>搜索或新建…</span>
          </button>
        </div>
      </div>
      {leftColumn}
      <main className={narrow && !activeId ? 'hidden' : 'flex-1 min-w-0 flex flex-col min-h-0'}>
        {focusHeader}
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col">{sessionLayer}</div>
          {contextColumn}
        </div>
      </main>
      {fab}
      {contextSheet}
      <CommandPalette open={!!palette} onClose={() => setPalette(null)} initial={palette ?? undefined} shell={shell} actions={actions} vaultEnabled={vaultEnabled} now={now} onManagePresets={openPrompts} />
      {noteSend && (
        <SendToMenu open anchor={noteSend.anchor} onClose={() => setNoteSend(null)} text={noteSend.text} {...sendTo(noteSend.workDir)} />
      )}
      <RenameDialog session={sessions.find(s => s.id === renamingId) ?? null} onClose={() => setRenamingId(null)} onSave={shell.rename} />
      {panel === 'admin' && <ErrorBoundary><Suspense fallback={null}><AdminPanel open onClose={() => setPanel(null)} /></Suspense></ErrorBoundary>}
      {panel === 'scheduled' && <ErrorBoundary><Suspense fallback={null}><ScheduledTasksPanel open onClose={() => setPanel(null)} /></Suspense></ErrorBoundary>}
      {panel === 'push' && <ErrorBoundary><Suspense fallback={null}><PushSettings open onClose={() => setPanel(null)} /></Suspense></ErrorBoundary>}
      {panel === 'prompts' && <ErrorBoundary><Suspense fallback={null}><PromptsSheet open onClose={() => setPanel(null)} /></Suspense></ErrorBoundary>}
      {memoryOpen && (
        <Sheet open side="bottom" snap="full" onClose={() => setMemoryOpen(false)} title="记忆">
          <div className="h-[75dvh]"><ErrorBoundary><Suspense fallback={null}><MemoryPanel /></Suspense></ErrorBoundary></div>
        </Sheet>
      )}
      <Toaster /><DialogHost />
    </div>
  )
}
