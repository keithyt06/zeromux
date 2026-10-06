import type { SessionType } from './api'
import { CREW_VARIANT_WORDS, type CrewVariant } from './crewVariant'

export type NewType = SessionType | 'vault'
export interface ParsedNew { type: NewType | null; dir: string; prompt: string; literalPath: boolean; crewVariant?: CrewVariant }

export const TYPE_WORDS: Record<string, NewType> = { claude: 'claude', codex: 'codex', crew: 'crew', tmux: 'tmux', term: 'tmux', vault: 'vault' }

/** Rule-based, no LLM (spec §4.6). The preview row is what disambiguates.
 *  `crew:<variant>` (G2) is a crew keyword that also picks the Crew variant. */
export function parseNew(input: string): ParsedNew {
  const toks = input.trim().split(/\s+/).filter(Boolean)
  let type: NewType | null = null
  let crewVariant: CrewVariant | undefined
  const first = toks[0]?.toLowerCase()
  if (first && TYPE_WORDS[first]) { type = TYPE_WORDS[first]; toks.shift() }
  else if (first && CREW_VARIANT_WORDS[first]) { type = 'crew'; crewVariant = CREW_VARIANT_WORDS[first]; toks.shift() }
  const dir = toks.shift() ?? ''
  const out: ParsedNew = { type, dir, prompt: toks.join(' '), literalPath: dir.startsWith('/') || dir.startsWith('~') }
  return crewVariant ? { ...out, crewVariant } : out
}

export const LAST_TYPE_KEY = 'zmx_last_type'
const VALID: SessionType[] = ['claude', 'codex', 'crew', 'tmux']
export function loadLastType(): SessionType {
  try { const v = localStorage.getItem(LAST_TYPE_KEY); return VALID.includes(v as SessionType) ? (v as SessionType) : 'claude' } catch { return 'claude' }
}
export function saveLastType(t: SessionType): void { try { localStorage.setItem(LAST_TYPE_KEY, t) } catch { /* ignore */ } }
