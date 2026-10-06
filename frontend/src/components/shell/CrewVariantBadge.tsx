import { Layers, Target } from 'lucide-react'
import type { SessionInfo } from '../../lib/api'
import { variantOf } from '../../lib/crewVariant'

const MARK = { goal: [Target, '目标指挥'], topics: [Layers, '并行话题'] } as const

/** Tiny mark next to the TypeIcon: 目标指挥 / 并行话题. Plain chat shows nothing. */
export function CrewVariantBadge({ session, size = 12 }: { session: Pick<SessionInfo, 'type' | 'crew_mode' | 'crew_agent'>; size?: number }) {
  const v = variantOf(session)
  if (v !== 'goal' && v !== 'topics') return null
  const [Icon, label] = MARK[v]
  return <Icon size={size} role="img" aria-label={label} className="shrink-0 text-[var(--fg-subtle)]" />
}
