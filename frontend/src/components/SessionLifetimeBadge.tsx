type Lifetime = { turns: number; duration_ms: number; cost_usd: number }

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  return `${m}分`
}

export function SessionLifetimeBadge({ agentType, lifetime }: { agentType: string; lifetime: Lifetime }) {
  const isClaude = agentType === 'claude'
  return (
    <span className="text-xs text-zinc-400">
      总计 {lifetime.turns} 轮 · {fmtDur(lifetime.duration_ms)} ·{' '}
      {isClaude ? `$${lifetime.cost_usd.toFixed(2)}` : <span title="该后端不上报成本">—</span>}
    </span>
  )
}
