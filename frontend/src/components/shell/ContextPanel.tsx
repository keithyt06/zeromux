import { Suspense, useState } from 'react'
import { X } from 'lucide-react'
import type { SessionInfo } from '../../lib/api'
import { IconButton, SegmentedControl, Sheet, Skeleton } from '../ui'
import { GitViewer, FileBrowser, RunMetricsPanel, AgentDashboard } from './lazyPanels'
import type { ContextTab } from './useShellState'
import type { GitSendTo } from '../GitViewer'

const TAB_LABEL: Record<ContextTab, string> = { git: 'Git', files: '文件', runs: '运行' }

export interface ContextPanelProps {
  session: SessionInfo
  open: boolean
  tab: ContextTab
  onTab(t: ContextTab): void
  onClose(): void
  asSheet: boolean
  /** GitViewer 「让 agent 处理」 → SendToMenu. */
  sendTo?: GitSendTo
  /** false while this session is not the focused one (the inline column keeps every
   *  session's panel mounted, hidden, so tab state survives switching — I-1). */
  active?: boolean
  /** Bumped by a push deep link / summary-card file chip: reopen Git on 改动. */
  gitNonce?: number
}

/** Session side panel (S3 V1/V3): Git / 文件 / 运行. Tabs mount on first visit and
 *  then stay mounted (hidden) so GitViewer's commit / FileBrowser's cwd survive. */
export function ContextPanel({ session, open, tab: wanted, onTab, onClose, asSheet, sendTo, active = true, gitNonce }: ContextPanelProps) {
  const agent = session.type !== 'tmux'
  const tabs: ContextTab[] = agent ? ['git', 'files', 'runs'] : ['git', 'files']
  const tab: ContextTab = tabs.includes(wanted) ? wanted : 'git'
  const [visited, setVisited] = useState<ReadonlySet<ContextTab>>(() => new Set())
  const showing = open && active
  if (showing && !visited.has(tab)) setVisited(new Set([...visited, tab]))
  // An inline panel that was never shown renders nothing (every session has one).
  if (!asSheet && visited.size === 0 && !showing) return null

  const pane = (t: ContextTab, node: React.ReactNode) => (visited.has(t) || (showing && t === tab)) && (
    <div key={t} className={`@container h-full ${t === tab ? '' : 'hidden'}`}>
      <Suspense fallback={<Skeleton rows={4} />}>{node}</Suspense>
    </div>
  )

  const content = (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--border-subtle)] shrink-0">
        <SegmentedControl label="面板" value={tab} onChange={onTab} options={tabs.map(t => ({ value: t, label: TAB_LABEL[t] }))} />
        {!asSheet && <span className="flex-1" />}
        {!asSheet && <IconButton label="关闭面板" icon={X} onClick={onClose} />}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {pane('git', <GitViewer key={gitNonce ?? 0} sessionId={session.id} sendTo={sendTo} initialTab={gitNonce ? 'worktree' : undefined} />)}
        {pane('files', <FileBrowser sessionId={session.id} />)}
        {agent && pane('runs', (
          <div className="h-full overflow-y-auto">
            <RunMetricsPanel sessionId={session.id} running={session.turn_state === 'running'}
              turnStartedMs={session.turn_started_ms} refreshKey={session.last_outcome_ms ?? 0} />
            <details className="border-t border-[var(--border-subtle)]">
              <summary className="row flex items-center px-3 cursor-pointer text-ui-sm text-[var(--fg-muted)]">事件</summary>
              <div className="h-[60vh]"><AgentDashboard sessionId={session.id} /></div>
            </details>
          </div>
        ))}
      </div>
    </div>
  )

  if (asSheet) {
    return (
      <Sheet open={showing} side="bottom" snap="full" onClose={onClose} title={session.name}>
        <div className="h-full min-h-[50dvh]">{content}</div>
      </Sheet>
    )
  }
  return <div className={`h-full ${showing ? '' : 'hidden'}`} data-context-panel={session.id}>{content}</div>
}
