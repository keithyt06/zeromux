import type { SessionType } from './api'

export type NewType = SessionType | 'vault'
export interface ParsedNew { type: NewType | null; dir: string; prompt: string; literalPath: boolean }

export const TYPE_WORDS: Record<string, NewType> = { claude: 'claude', codex: 'codex', crew: 'crew', tmux: 'tmux', term: 'tmux', vault: 'vault' }

/** Rule-based, no LLM (spec §4.6). The preview row is what disambiguates. */
export function parseNew(input: string): ParsedNew {
  const toks = input.trim().split(/\s+/).filter(Boolean)
  let type: NewType | null = null
  if (toks.length && TYPE_WORDS[toks[0].toLowerCase()]) type = TYPE_WORDS[toks.shift()!.toLowerCase()]
  const dir = toks.shift() ?? ''
  return { type, dir, prompt: toks.join(' '), literalPath: dir.startsWith('/') || dir.startsWith('~') }
}

export const LAST_TYPE_KEY = 'zmx_last_type'
const VALID: SessionType[] = ['claude', 'codex', 'crew', 'tmux']
export function loadLastType(): SessionType {
  try { const v = localStorage.getItem(LAST_TYPE_KEY); return VALID.includes(v as SessionType) ? (v as SessionType) : 'claude' } catch { return 'claude' }
}
export function saveLastType(t: SessionType): void { try { localStorage.setItem(LAST_TYPE_KEY, t) } catch { /* ignore */ } }
