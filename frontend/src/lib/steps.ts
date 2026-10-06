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
  /** Crew Mode reply kind (G1): ask = a question for the user, meta = a routing note. */
  crew?: 'crew_ask' | 'crew_meta'
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
      case 'text': {
        const crew = b.summary === 'crew_ask' || b.summary === 'crew_meta' ? b.summary : undefined
        // Crew ask/meta are standalone messages: never merge them into neighbouring prose.
        if (!crew && last?.kind === 'text' && !last.crew) last.text = `${last.text}${b.text ?? ''}`
        else { closeOpenTools(); out.push({ kind: 'text', text: b.text ?? '', status: 'done', ...(crew ? { crew } : {}) }) }
        break
      }
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

/** Full text of the turn's last non-empty text step (the card's 「展开全文」).
 *  Crew ask/meta steps are routing chatter, never the conclusion; crew_result is plain text. */
export function lastText(group: TurnGroup): string {
  const texts = toSteps(group.blocks, group.complete).filter(s => s.kind === 'text' && !s.crew && (s.text ?? '').trim())
  return (texts[texts.length - 1]?.text ?? '').trim()
}

const CONCLUSION_MIN = 40
const CONCLUSION_MAX = 600
const HEADING = /^#{1,6}\s/

/** First paragraph of the last text step; a heading (`## 总结`) or a < 40-char
 *  first paragraph keeps pulling in the next paragraphs until >= 40 chars (A5).
 *  Capped at 600 chars. */
export function conclusion(group: TurnGroup): string {
  const paras = lastText(group).split(/\n\s*\n/)
  let out = paras[0] ?? ''
  for (let i = 1; i < paras.length && (HEADING.test(out.split('\n').pop() ?? '') || [...out].length < CONCLUSION_MIN) && [...out].length < CONCLUSION_MAX; i++) {
    out += `\n\n${paras[i]}`
  }
  return [...out].slice(0, CONCLUSION_MAX).join('')
}
