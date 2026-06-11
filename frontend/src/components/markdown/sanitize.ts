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

// Strip a single outer ```markdown / ```md fence that wraps an ENTIRE reply.
// kiro (when asked to "整理/输出 markdown") returns the whole answer inside a
// ```markdown fence that itself contains inner code blocks — nested same-level
// fences, which markdown does not support, so react-markdown mis-parses it
// (front half renders as one code block, the rest leaks out as prose). We detect
// "the content is one ```markdown block (plus optional leading/trailing prose)"
// and remove just the outer wrapper so the inner markdown renders correctly.
// Conservative: only fires when the FIRST fence is ```markdown/```md AND it has a
// matching closing fence; Claude/Codex don't wrap, so this is a no-op for them.
// Applied only on the completed text (isComplete), never mid-stream.
// Known limits (acceptable — kiro wraps the WHOLE reply in ONE fence): a reply
// with TWO separate top-level ```markdown blocks would collapse the gap between
// them; and a reply genuinely meant to SHOW raw ```markdown source gets rendered
// instead. Both are rare vs kiro's wrap-everything habit.
export function unwrapMarkdownFence(text: string): string {
  const lines = text.split('\n')
  // Find the opening ```markdown / ```md line (allow leading prose before it).
  const openIdx = lines.findIndex(l => /^```(markdown|md)\s*$/i.test(l.trim()))
  if (openIdx === -1) return text
  // The opener must be the first fence we encounter — if a bare ``` appears
  // earlier, this isn't a clean whole-reply wrapper; leave it alone.
  for (let i = 0; i < openIdx; i++) {
    if (/^```/.test(lines[i].trim())) return text
  }
  // Find the matching closing fence: the LAST bare ``` line after the opener.
  // (Inner blocks open with ```lang or ``` and close with ```; the outer wrapper
  // is closed by the final ``` in the text.)
  let closeIdx = -1
  for (let i = lines.length - 1; i > openIdx; i--) {
    if (lines[i].trim() === '```') { closeIdx = i; break }
  }
  if (closeIdx === -1) return text // no closing fence (still streaming) → leave
  const before = lines.slice(0, openIdx)
  const inner = lines.slice(openIdx + 1, closeIdx)
  const after = lines.slice(closeIdx + 1)
  // Reassemble: leading prose + inner (unwrapped) + trailing prose, trimming the
  // blank-line seams the wrapper introduced so we don't add spurious newlines.
  const parts: string[] = []
  if (before.length) parts.push(before.join('\n').replace(/\n*$/, ''))
  parts.push(inner.join('\n'))
  if (after.length) {
    const tail = after.join('\n').replace(/^\n*/, '')
    if (tail) parts.push(tail)
  }
  return parts.join('\n\n')
}
