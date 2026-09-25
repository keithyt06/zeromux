export interface AskAgentTarget { absDir: string; relPath: string; kind: 'note' | 'folder' }

/** The context line prefilled into the new agent's first prompt. Only the PATH is
 *  passed — notes can be ~300KB; the agent reads the file itself. ABSOLUTE, because
 *  the session's cwd is the note's folder and a vault-relative path would not
 *  resolve there. Presets wrap it via `{{input}}`. */
export function askAgentPrompt(t: AskAgentTarget): string {
  if (t.kind === 'folder') return `当前目录：${t.absDir}/\n\n`
  const base = t.relPath.split('/').pop() || t.relPath
  return `当前笔记：${t.absDir}/${base}\n\n`
}
