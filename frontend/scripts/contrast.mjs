// Token contrast gate: parses :root / :root.light in src/index.css and checks
// every text-token × surface-token pair (spec §3.6). Aliases (var(--x)) resolve.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function lum(hex) {
  const h = hex.replace('#', '').slice(0, 6)
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
  const f = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
export function contrastRatio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

function block(css, selector) {
  const re = new RegExp(selector.replace(/[.:]/g, m => '\\' + m) + '\\s*\\{([^}]*)\\}', 'g')
  const out = {}
  for (const m of css.matchAll(re)) {
    for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim()
  }
  return out
}
function resolve(map) {
  const get = (v, depth = 0) => {
    const m = /^var\((--[\w-]+)\)$/.exec(v)
    return m && depth < 8 ? get(map[m[1]] ?? v, depth + 1) : v
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, get(v)]))
}
export function parseThemes(css) {
  const dark = block(css, ':root')
  const light = { ...dark, ...block(css, ':root.light') }
  return { dark: resolve(dark), light: resolve(light) }
}
export function checkPairs(theme, pairs) {
  return pairs.map(([fg, bg, min]) => {
    const ratio = contrastRatio(theme[fg], theme[bg])
    return { fg, bg, ratio: Math.round(ratio * 100) / 100, min, ok: ratio >= min }
  })
}

export const TEXT = ['--fg-strong', '--fg', '--fg-muted', '--fg-subtle']
export const SURFACES = ['--surface-0', '--surface-1', '--surface-2', '--surface-3']
export const STATES = ['--danger', '--stuck', '--attention', '--accent', '--success']

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const t = parseThemes(readFileSync(join(here, '..', 'src', 'index.css'), 'utf8'))
  const pairs = [
    ...TEXT.flatMap(fg => SURFACES.map(bg => [fg, bg, 4.5])),
    ...STATES.map(fg => [fg, '--surface-1', 4.5]),
  ]
  let fail = false
  for (const name of ['dark', 'light']) {
    const missing = [...TEXT, ...SURFACES, ...STATES].filter(k => !t[name][k])
    if (missing.length) { console.error(`${name}: missing ${missing.join(', ')}`); fail = true; continue }
    for (const r of checkPairs(t[name], pairs)) {
      if (!r.ok) { console.error(`✗ ${name} ${r.fg} on ${r.bg} = ${r.ratio} < ${r.min}`); fail = true }
    }
  }
  if (fail) process.exit(1)
  console.log('contrast ok')
}
