// Claude Code cross-session peer names (spec 2026-09-26 v2 §3d). ZeroMux names
// each Claude agent session `zmx-ai-<id6>`; show the session title for those.
export function peerLabel(fromName: string, peerNames: Record<string, string>): string {
  return peerNames[fromName] ?? fromName
}

// Content key for the peer-name map: the 3s session poll replaces the sessions
// array every tick, so memoizing on the array would give peerNames a new
// identity each poll and defeat TurnGroupView's memo. Memoize on this instead.
// JSON (not ad-hoc separators) so the key is injective: a session name holding
// separator characters cannot forge another peer's label.
export function peerNamesKey(sessions: { peer_name?: string | null; name: string }[]): string {
  return JSON.stringify(sessions.filter(s => s.peer_name).map(s => [s.peer_name, s.name]))
}

export function peerNamesFromKey(key: string): Record<string, string> {
  return Object.fromEntries(JSON.parse(key) as [string, string][])
}
