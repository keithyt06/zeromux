import type { SessionInfo } from './api'

export type CrewVariant = 'chat' | 'topics' | 'goal'
export const GOAL_AGENT = 'kirocrew-conductor'

/** D1: 目标指挥 ships in S5 only if the SP probe saw conductor normal mode end its turn
 *  with chat_done (spec §5 fallback). Measured 2026-10-04 (Task 1, kiro-crew-gap-research.md §7):
 *  CONDUCTOR_CHAT_DONE = yes (conductor verified via Gateway list read-back, chat_done ≈3.8s) → true. */
export const GOAL_ENABLED: boolean = true

/** Display variant from the raw Gateway values (spec §7.3). null = not a Crew session. */
export function variantOf(s: Pick<SessionInfo, 'type' | 'crew_mode' | 'crew_agent'>): CrewVariant | null {
  if (s.type !== 'crew') return null
  if (s.crew_agent === GOAL_AGENT) return 'goal'
  if (s.crew_mode === 'crew') return 'topics'
  return 'chat'
}

export interface CrewOpts { crew_mode: string; crew_agent: string }

/** variant → POST /api/sessions fields. S6 T3 exposes `topics`. */
export const CREW_VARIANT_FIELDS: Record<CrewVariant, CrewOpts> = {
  chat: { crew_mode: '', crew_agent: '' },
  goal: { crew_mode: '', crew_agent: GOAL_AGENT },
  topics: { crew_mode: 'crew', crew_agent: '' },
}

/** ⌘K 二级 chip (D1: S5 offers 聊天 / 目标指挥; S6 T3 appends 并行话题). */
export const CREW_VARIANT_OPTIONS: { value: CrewVariant; label: string }[] = [
  { value: 'chat', label: '聊天' },
  ...(GOAL_ENABLED ? [{ value: 'goal' as const, label: '目标指挥' }] : []),
]

/** First-token keywords → variant (lower-case). */
export const CREW_VARIANT_WORDS: Record<string, CrewVariant> = GOAL_ENABLED ? { 'crew:goal': 'goal' } : {}
