import type { Block, TurnGroup } from './transcript'

// Turn blocks → display steps (spec S3 §3.2). Pure. Pairing is positional:
// no backend carries a tool_use_id; Claude never sends tool_result at all.

export type StepKind = 'tool' | 'thinking' | 'text' | 'error' | 'approval'
export interface Step {
  kind: StepKind
  name?: string
  summary?: string
  input?: unknown
  result?: string
  status: 'running' | 'done' | 'error'
  text?: string
  approvalId?: string
  count?: number
}

export function toSteps(blocks: Block[], complete: boolean): Step[] {
  const out: Step[] = []
  const closeOpenTools = () => { for (const s of out) if (s.kind === 'tool' && s.status === 'running') s.status = 'done' }
  for (const b of blocks) {
    const last = out[out.length - 1]
    switch (b.type) {
      case 'tool_use':
        closeOpenTools()
        out.push({ kind: 'tool', name: b.name, summary: b.summary, input: b.input, status: 'running' })
        break
      case 'tool_result': {
        let paired = false
        for (let i = out.length - 1; i >= 0; i--) {
          const s = out[i]
          if (s.kind === 'tool' && s.name === b.name && s.result === undefined) { s.result = b.text ?? ''; s.status = 'done'; paired = true; break }
        }
        // Orphan (use dropped, or a backend that only sends results): keep it visible.
        if (!paired) { closeOpenTools(); out.push({ kind: 'tool', name: b.name, result: b.text ?? '', status: 'done' }) }
        break
      }
      case 'thinking':
        if (last?.kind === 'thinking') { last.text = `${last.text}\n\n${b.text ?? ''}`; last.count = (last.count ?? 1) + 1 }
        else { closeOpenTools(); out.push({ kind: 'thinking', text: b.text ?? '', status: 'done', count: 1 }) }
        break
      case 'text':
        if (last?.kind === 'text') last.text = `${last.text}${b.text ?? ''}`
        else { closeOpenTools(); out.push({ kind: 'text', text: b.text ?? '', status: 'done' }) }
        break
      case 'error':
        out.push({ kind: 'error', text: b.text ?? '', status: 'error' })
        break
      case 'approval':
        out.push({ kind: 'approval', name: b.name, summary: b.summary, text: b.text, approvalId: b.approvalId, status: 'running' })
        break
    }
  }
  if (complete) for (const s of out) if (s.status === 'running') s.status = 'done'
  return out
}

export function stepCount(steps: Step[]): number {
  return steps.filter(s => s.kind === 'tool' || s.kind === 'approval').length
}

// Mirrors backend format.rs `shorten_path`: parent/name.
function shortLabel(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 1 ? (parts[0] ?? p) : parts.slice(-2).join('/')
}
const looksLikePath = (s: string) => !/\s/.test(s) && (s.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(s))
const WRITE_ISH = /write|edit|patch|create_file|str_replace/i

export function touchedFiles(steps: Step[]): { path: string; label: string }[] {
  const seen = new Set<string>()
  const out: { path: string; label: string }[] = []
  const add = (p: string | undefined) => {
    const v = p?.trim()
    if (!v || seen.has(v)) return
    seen.add(v); out.push({ path: v, label: shortLabel(v) })
  }
  for (const s of steps) {
    if (s.kind !== 'tool' || !s.name) continue
    const input = (s.input ?? {}) as Record<string, unknown>
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(s.name)) {
      add(typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined)
    } else if (s.name === 'apply_patch') {
      // Codex joins changed paths with ", " (codex_process.rs); paths may contain spaces.
      for (const p of (s.summary ?? '').split(', ')) if (p.trim()) add(p)
    } else if (WRITE_ISH.test(s.name) && s.summary && looksLikePath(s.summary)) {
      add(s.summary)
    }
  }
  return out
}

export function conclusion(group: TurnGroup): string {
  const texts = toSteps(group.blocks, group.complete).filter(s => s.kind === 'text' && (s.text ?? '').trim())
  const last = texts[texts.length - 1]?.text ?? ''
  const para = last.trim().split(/\n\s*\n/)[0] ?? ''
  return [...para].slice(0, 600).join('')
}
