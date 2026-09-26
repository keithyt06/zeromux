// Claude Code cross-session peer names (spec 2026-09-26 v2 §3d). ZeroMux names
// each Claude agent session `zmx-ai-<id6>`; show the session title for those.
export function peerLabel(fromName: string, peerNames: Record<string, string>): string {
  return peerNames[fromName] ?? fromName
}

const FIELD_SEP = '\u0001'
const PAIR_SEP = '\u0002'

// Content key for the peer-name map: the 3s session poll replaces the sessions
// array every tick, so memoizing on the array would give peerNames a new
// identity each poll and defeat TurnGroupView's memo. Memoize on this instead.
export function peerNamesKey(sessions: { peer_name?: string | null; name: string }[]): string {
  return sessions
    .filter(s => s.peer_name)
    .map(s => `${s.peer_name}${FIELD_SEP}${s.name}`)
    .join(PAIR_SEP)
}

export function peerNamesFromKey(key: string): Record<string, string> {
  if (!key) return {}
  return Object.fromEntries(key.split(PAIR_SEP).map(pair => pair.split(FIELD_SEP, 2) as [string, string]))
}
