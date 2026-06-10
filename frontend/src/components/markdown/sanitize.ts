// Heuristic sanitizer for STREAMING (incomplete) markdown only. Narrowed to the
// three high-frequency breakages that make react-markdown misrender mid-stream:
// unclosed code fences, half-written table rows, unbalanced $$ math. NOT a full
// parser — once isComplete, MarkdownContent uses the raw text so final render is
// always exact (spec G1). Single-$ is deliberately left alone to avoid corrupting
// shell/currency text.

export function sanitizeStreamingMarkdown(text: string): string {
  let out = text
  // 1. Unclosed code fence: odd count of ``` → append a closing fence.
  const fences = (out.match(/```/g) || []).length
  if (fences % 2 === 1) {
    out += (out.endsWith('\n') ? '' : '\n') + '```'
  }
  // 2. Unbalanced $$ block math: odd count → append closing $$.
  const blockMath = (out.match(/\$\$/g) || []).length
  if (blockMath % 2 === 1) {
    out += '$$'
  }
  // 3. Half-written final table row: a last line that begins with `|` but has no
  // trailing newline (still streaming) → escape the leading pipe so gfm doesn't
  // try to parse a malformed table. Only the LAST line, only mid-stream.
  if (!text.endsWith('\n')) {
    const lines = out.split('\n')
    const last = lines[lines.length - 1]
    if (/^\s*\|/.test(last)) {
      lines[lines.length - 1] = last.replace(/^(\s*)\|/, '$1\\|')
      out = lines.join('\n')
    }
  }
  return out
}
