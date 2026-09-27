// Shared display formatting (spec R15). Lists / headers use 'short' cost,
// detail views use 'long'. Callers render numbers inside `.num`.

export function formatCost(usd: number | null | undefined, precision: 'short' | 'long'): string {
  if (usd == null || !Number.isFinite(usd)) return ''
  if (precision === 'short') return usd > 0 && usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`
  return `$${usd.toFixed(4)}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function formatRelative(ms: number, now: number): string {
  const d = now - ms
  if (d < 60_000) return '刚刚'
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 24 * 3600_000) return `${Math.floor(d / 3600_000)} 小时前`
  if (d < 48 * 3600_000) return '昨天'
  const t = new Date(ms)
  return `${t.getMonth() + 1}月${t.getDate()}日`
}
