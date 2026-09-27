import { api } from './core'

// Git
export interface GitCommit {
  hash: string
  short_hash: string
  author: string
  date: string
  subject: string
  body: string
  refs: string
}

export interface GitGraphEntry {
  graph: string
  commit: GitCommit | null
}

export interface GitFileChange {
  additions: number
  deletions: number
  path: string
}

export interface WorktreeFile {
  path: string
  status: string
  staged: boolean
  old_path?: string
}

export async function getGitLog(id: string, limit = 50): Promise<{ entries: GitGraphEntry[]; total: number }> {
  const res = await api(`/api/sessions/${id}/git/log?limit=${limit}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function getGitShow(id: string, commit: string): Promise<{ commit: GitCommit; diff: string; files: GitFileChange[] }> {
  const res = await api(`/api/sessions/${id}/git/show?commit=${encodeURIComponent(commit)}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function getGitWorktree(id: string): Promise<{ is_git: boolean; files: WorktreeFile[]; diff: string; truncated: boolean }> {
  const res = await api(`/api/sessions/${id}/git/worktree`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
