// Minimal SGR → span parser for the history view. Only colors + bold; every
// other escape (cursor moves, OSC titles, erase) is dropped. The 16 palette
// entries map to CSS vars so both themes work (index.css defines --ansi-0..15);
// 256-color indices 16..255 and truecolor resolve to literal rgb().
export type Span = { text: string; fg?: string; bg?: string; bold?: boolean }

// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-9;?]*)([@-~])/g

export function stripAnsi(s: string): string {
  return s.replace(OSC, '').replace(CSI, '')
}

export function xterm256(n: number): string {
  if (n < 16) return `var(--ansi-${n})`
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})` }
  const i = n - 16, r = Math.floor(i / 36), g = Math.floor(i / 6) % 6, b = i % 6
  const lv = (x: number) => (x ? 55 + x * 40 : 0)
  return `rgb(${lv(r)},${lv(g)},${lv(b)})`
}

function color(codes: number[], i: number): [string | undefined, number] {
  if (codes[i + 1] === 5) return [xterm256(codes[i + 2]), i + 2]
  if (codes[i + 1] === 2) return [`rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`, i + 4]
  return [undefined, i]
}

type Style = Omit<Span, 'text'>
function without(cur: Style, key: keyof Style): Style {
  const next = { ...cur }
  delete next[key]
  return next
}

export function parseAnsiLine(line: string): Span[] {
  const src = line.replace(OSC, '')
  const out: Span[] = []
  let cur: Style = {}
  let last = 0
  const push = (text: string) => { if (text) out.push({ text, ...cur }) }
  for (const m of src.matchAll(CSI)) {
    push(src.slice(last, m.index))
    last = (m.index ?? 0) + m[0].length
    if (m[2] !== 'm') continue
    const codes = (m[1] || '0').split(';').map(n => Number(n) || 0)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) cur = {}
      else if (c === 1) cur = { ...cur, bold: true }
      else if (c === 22) cur = without(cur, 'bold')
      else if (c >= 30 && c <= 37) cur = { ...cur, fg: `var(--ansi-${c - 30})` }
      else if (c >= 90 && c <= 97) cur = { ...cur, fg: `var(--ansi-${c - 82})` }
      else if (c === 39) cur = without(cur, 'fg')
      else if (c >= 40 && c <= 47) cur = { ...cur, bg: `var(--ansi-${c - 40})` }
      else if (c >= 100 && c <= 107) cur = { ...cur, bg: `var(--ansi-${c - 92})` }
      else if (c === 49) cur = without(cur, 'bg')
      else if (c === 38 || c === 48) {
        const [v, ni] = color(codes, i)
        if (v) cur = c === 38 ? { ...cur, fg: v } : { ...cur, bg: v }
        i = ni
      }
    }
  }
  push(src.slice(last))
  return out
}
