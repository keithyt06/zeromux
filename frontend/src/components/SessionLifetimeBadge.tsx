import { formatCost, formatDuration } from '../lib/format'

type Lifetime = { turns: number; duration_ms: number; cost_usd: number }

export function SessionLifetimeBadge({ agentType, lifetime }: { agentType: string; lifetime: Lifetime }) {
  const isClaude = agentType === 'claude'
  return (
    <span className="text-xs text-zinc-400">
      总计 {lifetime.turns} 轮 · {formatDuration(lifetime.duration_ms)} ·{' '}
      {isClaude ? formatCost(lifetime.cost_usd, 'short') : <span title="该后端不上报成本">—</span>}
    </span>
  )
}
