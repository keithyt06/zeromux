import type { HostTmux } from './api'

/** A `zmx-*` tmux session with no zeromux session: left over (e.g. DB reset). */
export function isOrphan(h: HostTmux): boolean {
  return h.name.startsWith('zmx-')
}

export function matchHostTmux(list: HostTmux[], q: string): HostTmux[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  return list.filter(h => h.name.toLowerCase().includes(needle) || h.path.toLowerCase().includes(needle))
}
