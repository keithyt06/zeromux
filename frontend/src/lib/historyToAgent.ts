export const AGENT_MAX_BYTES = 32 * 1024

/** Wrap terminal output (selection or tail) into a prompt for a new agent session.
 *  Keeps only the tail under AGENT_MAX_BYTES, aligned on line boundaries, so the
 *  agent gets whole lines instead of a byte-truncated fragment. */
export function historyPrompt({ name, workDir, text }: { name: string; workDir: string; text: string }): string {
  const enc = new TextEncoder()
  let body = text.replace(/\s+$/, '')
  let truncated = false
  if (enc.encode(body).length > AGENT_MAX_BYTES) {
    truncated = true
    const lines = body.split('\n')
    const kept: string[] = []
    let size = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const n = enc.encode(lines[i]).length + 1
      if (size + n > AGENT_MAX_BYTES) break
      kept.unshift(lines[i]); size += n
    }
    body = kept.join('\n')
  }
  const note = truncated ? `（已截取最后 ${body.split('\n').length} 行）` : ''
  return `下面是终端「${name}」（${workDir}）的输出${note}，请帮我分析：\n\n\`\`\`\n${body}\n\`\`\``
}
