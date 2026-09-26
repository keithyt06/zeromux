const MAX_MATCHES = 1000

// Case-insensitive, non-overlapping substring matches across history chunks.
export function findMatches(chunks: string[], q: string): { chunk: number; offset: number }[] {
  const needle = q.toLowerCase()
  if (!needle) return []
  const out: { chunk: number; offset: number }[] = []
  chunks.forEach((c, chunk) => {
    const hay = c.toLowerCase()
    for (let i = hay.indexOf(needle); i !== -1 && out.length < MAX_MATCHES; i = hay.indexOf(needle, i + needle.length)) {
      out.push({ chunk, offset: i })
    }
  })
  return out
}
