// Claude Code cross-session peer names (spec 2026-09-26 v2 §3d). ZeroMux names
// each Claude agent session `zmx-ai-<id6>`; show the session title for those.
export function peerLabel(fromName: string, peerNames: Record<string, string>): string {
  return peerNames[fromName] ?? fromName
}
