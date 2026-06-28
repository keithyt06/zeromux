import React, { useState, useEffect, useCallback } from 'react'
import { getGitLog, getGitShow, getGitWorktree, getSessionStatus } from '../lib/api'
import type { GitCommit, GitFileChange, GitGraphEntry, WorktreeFile } from '../lib/api'
import { GitCommit as GitCommitIcon, RefreshCw, FileText, User, Calendar } from 'lucide-react'
import { defaultGitTab, COMMIT_PROMPT, DISCARD_PROMPT } from '../lib/gitviewer'

interface Props {
  sessionId: string
  onForward?: (text: string) => void
}

// Colors for graph lanes
const LANE_COLORS = [
  'var(--accent-green-text)',
  'var(--accent-blue)',
  'var(--accent-purple)',
  'var(--accent-red)',
  '#e5a00d',
  '#00bcd4',
  '#ff7043',
  '#ab47bc',
]

function laneColor(index: number): string {
  return LANE_COLORS[index % LANE_COLORS.length]
}

export default function GitViewer({ sessionId, onForward }: Props) {
  const [entries, setEntries] = useState<GitGraphEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [commitMeta, setCommitMeta] = useState<GitCommit | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)

  const [tab, setTab] = useState<'worktree' | 'history'>('history')
  const [wt, setWt] = useState<{ files: WorktreeFile[]; diff: string; truncated: boolean; is_git: boolean } | null>(null)
  const [wtSelected, setWtSelected] = useState<string | null>(null)

  const loadLog = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getGitLog(sessionId, 200)
      setEntries(data.entries)
      setTotal(data.total)
      // Auto-select first commit
      const firstCommit = data.entries.find(e => e.commit)?.commit
      if (firstCommit && !selectedHash) {
        selectCommit(firstCommit.hash)
      }
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }, [sessionId])

  const selectCommit = async (hash: string) => {
    setSelectedHash(hash)
    setLoadingDiff(true)
    try {
      const data = await getGitShow(sessionId, hash)
      setDiff(data.diff)
      setFiles(data.files)
      setCommitMeta(data.commit)
    } catch (e: any) {
      setDiff(`Error: ${e.message}`)
      setFiles([])
      setCommitMeta(null)
    }
    setLoadingDiff(false)
  }

  useEffect(() => { loadLog() }, [loadLog])

  useEffect(() => {
    let alive = true
    getSessionStatus(sessionId).then(st => {
      if (alive) setTab(defaultGitTab(st.git_dirty))
    }).catch(() => {})
    return () => { alive = false }
  }, [sessionId])

  const loadWorktree = useCallback(() => {
    getGitWorktree(sessionId).then(setWt).catch(() => setWt(null))
  }, [sessionId])
  useEffect(() => { if (tab === 'worktree') loadWorktree() }, [tab, loadWorktree])

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-2 h-9 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
        <button
          onClick={() => setTab('worktree')}
          className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
            tab === 'worktree'
              ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] font-medium'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          工作区改动
        </button>
        <button
          onClick={() => setTab('history')}
          className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
            tab === 'history'
              ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] font-medium'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          历史提交
        </button>
      </div>

      {tab === 'worktree' ? (
        <WorktreePanel
          wt={wt}
          selected={wtSelected}
          onSelect={setWtSelected}
          onRefresh={loadWorktree}
          onForward={onForward}
        />
      ) : (
    <div className="flex flex-1 min-h-0">
      {/* Commit list with graph */}
      <div className="w-80 border-r border-[var(--border)] flex flex-col bg-[var(--bg-secondary)] shrink-0">
        <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)]">
          <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Commits {total > 0 && <span className="normal-case font-normal">({total})</span>}
          </span>
          <button
            onClick={loadLog}
            className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">Loading...</div>
          ) : error ? (
            <div className="px-3 py-4 text-center">
              <GitCommitIcon size={20} className="mx-auto text-[var(--text-muted)] mb-2" />
              <p className="text-[10px] text-[var(--text-muted)]">{error}</p>
            </div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <GitCommitIcon size={20} className="mx-auto text-[var(--text-muted)] mb-2" />
              <p className="text-[10px] text-[var(--text-muted)]">No commits</p>
            </div>
          ) : (
            <GraphList
              entries={entries}
              selectedHash={selectedHash}
              onSelect={selectCommit}
            />
          )}
        </div>
      </div>

      {/* Diff view */}
      <div className="flex-1 flex flex-col min-w-0">
        {commitMeta && (
          <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
            <div className="flex items-center gap-2 mb-1">
              <code className="text-[10px] font-mono text-[var(--accent-purple)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">
                {commitMeta.short_hash}
              </code>
              {commitMeta.refs && (
                <RefBadges refs={commitMeta.refs} />
              )}
              <span className="text-xs font-medium text-[var(--text-primary)] truncate flex-1">
                {commitMeta.subject}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
              <span className="flex items-center gap-1">
                <User size={10} />
                {commitMeta.author}
              </span>
              <span className="flex items-center gap-1">
                <Calendar size={10} />
                {formatDate(commitMeta.date)}
              </span>
              {files.length > 0 && (
                <span className="flex items-center gap-1">
                  <FileText size={10} />
                  {files.length} file{files.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            {commitMeta.body && (
              <p className="text-[11px] text-[var(--text-secondary)] mt-1 whitespace-pre-wrap">{commitMeta.body}</p>
            )}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-2">
                {files.map(f => (
                  <span key={f.path} className="text-[10px] font-mono text-[var(--text-secondary)]">
                    {f.path}
                    {f.additions > 0 && <span className="text-[var(--accent-green-text)] ml-1">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="text-[var(--accent-red)] ml-1">-{f.deletions}</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {loadingDiff ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">Loading...</div>
          ) : selectedHash ? (
            <DiffView diff={diff} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
              Select a commit to view
            </div>
          )}
        </div>
      </div>
    </div>
      )}
    </div>
  )
}

// ── Worktree panel ──

function WorktreePanel({ wt, selected, onSelect, onRefresh, onForward }: {
  wt: { files: WorktreeFile[]; diff: string; truncated: boolean; is_git: boolean } | null
  selected: string | null
  onSelect: (path: string) => void
  onRefresh: () => void
  onForward?: (text: string) => void
}) {
  // After a forward, show a brief "已发送给 agent" line and disable both buttons so
  // a second tap can't queue a duplicate prompt (the chat where it lands is hidden
  // behind this overlay, so the panel itself must give the only feedback).
  const [sent, setSent] = useState(false)
  const forward = useCallback((text: string, confirmMsg?: string) => {
    if (!onForward) return
    if (confirmMsg && !window.confirm(confirmMsg)) return
    onForward(text)
    setSent(true)
    setTimeout(() => setSent(false), 4000)
  }, [onForward])

  if (wt && !wt.is_git) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
        非 git 仓库
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* File list */}
      <div className="w-80 border-r border-[var(--border)] flex flex-col bg-[var(--bg-secondary)] shrink-0">
        <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)]">
          <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Files {wt && wt.files.length > 0 && <span className="normal-case font-normal">({wt.files.length})</span>}
          </span>
          <button
            onClick={onRefresh}
            className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {!wt ? (
            <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">Loading...</div>
          ) : wt.files.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <GitCommitIcon size={20} className="mx-auto text-[var(--text-muted)] mb-2" />
              <p className="text-[10px] text-[var(--text-muted)]">No changes</p>
            </div>
          ) : (
            wt.files.map(f => {
              const isSelected = selected === f.path
              return (
                <button
                  key={f.path}
                  onClick={() => onSelect(f.path)}
                  className={`w-full text-left flex items-center gap-2 px-3 py-1 transition-colors ${
                    isSelected ? 'bg-[var(--bg-primary)]' : 'hover:bg-[var(--bg-tertiary)]'
                  }`}
                >
                  <StatusBadge status={f.status} />
                  <span className="text-[11px] font-mono text-[var(--text-primary)] truncate flex-1">
                    {f.path}
                  </span>
                </button>
              )
            })
          )}
        </div>
        {wt?.is_git && wt.files.length > 0 && onForward && (
          <div className="border-t border-[var(--border)]">
            {sent && (
              <div className="px-2 pt-2 text-[10px] text-[var(--accent-green)]">
                已发送给 agent,切到 Chat 查看执行
              </div>
            )}
            <div className="flex gap-2 p-2">
              <button onClick={() => forward(COMMIT_PROMPT)} disabled={sent}
                className="px-2 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed">让 agent 提交</button>
              <button onClick={() => forward(DISCARD_PROMPT, '确认让 agent 撤销当前工作区的全部未提交改动?此操作不可恢复。')} disabled={sent}
                className="px-2 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--accent-red)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed">让 agent 撤销改动</button>
            </div>
          </div>
        )}
      </div>

      {/* Diff view */}
      <div className="flex-1 flex flex-col min-w-0">
        {wt?.truncated && (
          <div className="px-4 py-1.5 text-[11px] text-[#e5a00d] bg-[color:rgba(229,160,13,0.12)] border-b border-[var(--border)] shrink-0">
            diff 过大,已截断显示
          </div>
        )}
        <div className="flex-1 overflow-auto">
          <DiffView diff={wt?.diff ?? ''} />
        </div>
      </div>
    </div>
  )
}

// ── Worktree status badge ──

function StatusBadge({ status }: { status: string }) {
  const ch = status.trim()[0] ?? ''
  let color = 'var(--text-secondary)'
  if (ch === 'A') color = 'var(--accent-green)'
  else if (ch === 'D') color = 'var(--accent-red)'
  else if (ch === 'M') color = 'var(--accent-yellow)'
  return (
    <span
      className="text-[10px] font-mono font-bold shrink-0 w-4 text-center"
      style={{ color }}
    >
      {ch || '?'}
    </span>
  )
}

// ── Graph list ──

function GraphList({ entries, selectedHash, onSelect }: {
  entries: GitGraphEntry[]
  selectedHash: string | null
  onSelect: (hash: string) => void
}) {
  // Assign colors to graph lanes based on column position of characters
  return (
    <div className="font-mono text-[11px] leading-[1.5]">
      {entries.map((entry, i) => {
        const isCommit = entry.commit !== null
        const isSelected = isCommit && selectedHash === entry.commit!.hash

        if (!isCommit) {
          // Graph-only line (connector)
          return (
            <div key={`g-${i}`} className="flex px-2 h-[18px]">
              <GraphChars graph={entry.graph} />
            </div>
          )
        }

        return (
          <button
            key={entry.commit!.hash}
            onClick={() => onSelect(entry.commit!.hash)}
            className={`w-full text-left flex items-start px-2 py-0.5 transition-colors ${
              isSelected
                ? 'bg-[var(--bg-primary)]'
                : 'hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            <GraphChars graph={entry.graph} />
            <div className="min-w-0 flex-1 ml-1">
              <div className="flex items-center gap-1.5">
                <code className={`text-[10px] shrink-0 ${
                  isSelected ? 'text-[var(--accent-blue)]' : 'text-[var(--accent-purple)]'
                }`}>
                  {entry.commit!.short_hash}
                </code>
                {entry.commit!.refs && (
                  <RefBadges refs={entry.commit!.refs} compact />
                )}
                <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                  {formatDate(entry.commit!.date)}
                </span>
              </div>
              <p className="text-[11px] text-[var(--text-primary)] truncate leading-snug">
                {entry.commit!.subject}
              </p>
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Graph character renderer ──

function GraphChars({ graph }: { graph: string }) {
  // Render each character with lane-based coloring
  const spans: React.ReactNode[] = []
  let col = 0

  for (let i = 0; i < graph.length; i++) {
    const ch = graph[i]
    if (ch === ' ') {
      spans.push(<span key={i}> </span>)
      col++
    } else if (ch === '|' || ch === '*' || ch === '\\' || ch === '/' || ch === '_') {
      // Determine lane index: count non-space columns
      const laneIdx = Math.floor(col / 2)
      const color = laneColor(laneIdx)
      const weight = ch === '*' ? 'font-bold' : ''
      spans.push(
        <span key={i} style={{ color }} className={weight}>
          {ch === '*' ? '\u25CF' : ch}
        </span>
      )
      col++
    } else {
      spans.push(<span key={i} className="text-[var(--text-muted)]">{ch}</span>)
      col++
    }
  }

  return <span className="shrink-0 whitespace-pre">{spans}</span>
}

// ── Ref badges ──

function RefBadges({ refs, compact }: { refs: string; compact?: boolean }) {
  if (!refs) return null
  const parts = refs.split(', ').map(r => r.trim()).filter(Boolean)
  if (parts.length === 0) return null

  return (
    <span className="flex items-center gap-1 shrink-0">
      {parts.map(ref => {
        const isHead = ref.startsWith('HEAD')
        const isBranch = ref.includes('->') || !ref.startsWith('tag:')
        const isTag = ref.startsWith('tag:')
        const label = ref.replace('tag: ', '')

        let bg = 'bg-[var(--bg-tertiary)]'
        let text = 'text-[var(--accent-purple)]'
        if (isHead) { bg = 'bg-[color:rgba(63,185,80,0.15)]'; text = 'text-[var(--accent-green-text)]' }
        else if (isTag) { bg = 'bg-[color:rgba(229,160,13,0.15)]'; text = 'text-[#e5a00d]' }
        else if (isBranch) { bg = 'bg-[color:rgba(110,118,129,0.15)]'; text = 'text-[var(--accent-blue)]' }

        return (
          <span
            key={ref}
            className={`${bg} ${text} ${compact ? 'text-[8px] px-1 py-0' : 'text-[9px] px-1.5 py-0.5'} rounded font-medium font-sans`}
          >
            {label}
          </span>
        )
      })}
    </span>
  )
}

// ── Diff renderer ──

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
        No changes in this commit
      </div>
    )
  }

  const lines = diff.split('\n')

  return (
    <pre className="text-[12px] font-mono leading-[1.6] p-0">
      {lines.map((line, i) => {
        let cls = 'text-[var(--text-secondary)]'
        let bg = ''

        if (line.startsWith('diff --git')) {
          cls = 'text-[var(--text-primary)] font-semibold'
          bg = 'bg-[var(--bg-tertiary)] border-t border-[var(--border)] mt-1'
        } else if (line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('rename')) {
          cls = 'text-[var(--text-muted)]'
        } else if (line.startsWith('---') || line.startsWith('+++')) {
          cls = 'text-[var(--text-primary)] font-medium'
          bg = 'bg-[var(--bg-secondary)]'
        } else if (line.startsWith('@@')) {
          cls = 'text-[var(--accent-blue)]'
          bg = 'bg-[var(--bg-secondary)]'
        } else if (line.startsWith('+')) {
          cls = 'text-[var(--accent-green-text)]'
          bg = 'bg-[color:rgba(63,185,80,0.1)]'
        } else if (line.startsWith('-')) {
          cls = 'text-[var(--accent-red)]'
          bg = 'bg-[color:rgba(248,81,73,0.1)]'
        }

        return (
          <div key={i} className={`px-4 ${bg} ${cls}`}>
            {line || '\u00A0'}
          </div>
        )
      })}
    </pre>
  )
}

// ── Helpers ──

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}
