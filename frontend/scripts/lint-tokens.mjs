// Token ratchet: counts five classes of design-system violations across
// src/**/*.tsx (tests excluded) and fails if ANY count rises above the
// committed baseline. Counts may only go down; when they do, the script asks
// you to lower the baseline in the same commit (spec §3.1.4, R7).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RULES = {
  smallText: /text-\[(?:8|9|10|11)px\]/g,
  paletteColor: /\b(?:text|bg|border|ring|fill|stroke)-(?:zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
  zIndex: /\bz-\d+\b/g,
  emojiIcon: /[📜👍👎⧉🖱✎📎⏸⤓⤒🔔🔕]/gu,
}

// window.alert/confirm/prompt are always counted — there is no legitimate
// reason to call them through the `window.` prefix once a sanctioned wrapper
// exists. Bare alert(/confirm(/prompt( are counted UNLESS the file imports
// that identifier (or, for `prompt`, the T11 wrapper `promptText`) from the
// sanctioned dialog primitives (components/ui, ./ui, ./dialogs) — a bare call
// in that case is the primitive itself, not the native dialog it wraps.
// `alert` has no sanctioned primitive (per T10/T11 scope), but gets the same
// check for symmetry — it is simply never satisfied in practice.
const ALWAYS_DIALOG = /\bwindow\.(?:alert|confirm|prompt)\s*\(/g
const BARE_DIALOG = { alert: ['alert'], confirm: ['confirm'], prompt: ['prompt', 'promptText'] }
const importsFromDialogPrimitives = (source, name) =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]*(components\\/ui|\\/ui|dialogs)['"]`).test(source)

// Heuristic, not a parser: this comment-stripping regex can misfire on a
// template-literal expression containing `//` (`` `${x}//not-a-comment` ``)
// or a string literal containing `/*`. The ratchet only needs to be
// directionally consistent commit-to-commit, not byte-perfect — it is a
// backstop, not a substitute for a real parser.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

export function countViolations(source) {
  const code = stripComments(source)
  const out = {}
  for (const [k, re] of Object.entries(RULES)) {
    const target = k === 'emojiIcon' ? source : code
    out[k] = (target.match(re) || []).length
  }
  out.nativeDialog = (code.match(ALWAYS_DIALOG) || []).length
  for (const [bareName, wrapperNames] of Object.entries(BARE_DIALOG)) {
    if (wrapperNames.some(w => importsFromDialogPrimitives(source, w))) continue
    const bareRe = new RegExp(`(?<![\\w.])${bareName}\\s*\\(`, 'g')
    out.nativeDialog += (code.match(bareRe) || []).length
  }
  return out
}

// components/ui/ holds the sanctioned dialog primitives' own definitions
// (`export function confirm(...)` etc.) — excluded so the primitives don't
// count as violations of the native-dialog rule they exist to replace.
function walk(dir, rel = '') {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    const nextRel = rel ? `${rel}/${n}` : n
    if (n === '__tests__' || n === 'node_modules' || nextRel === 'components/ui') return []
    return statSync(p).isDirectory() ? walk(p, nextRel) : (/\.tsx?$/.test(n) ? [p] : [])
  })
}

const CATEGORIES = ['smallText', 'paletteColor', 'zIndex', 'nativeDialog', 'emojiIcon']

export function scan(root) {
  const total = Object.fromEntries(CATEGORIES.map(k => [k, 0]))
  const perFile = {}
  for (const f of walk(root)) {
    const c = countViolations(readFileSync(f, 'utf8'))
    for (const k of Object.keys(c)) total[k] += c[k]
    if (Object.values(c).some(Boolean)) perFile[f] = c
  }
  return { total, perFile }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const baselinePath = join(here, 'lint-tokens.baseline.json')
  const { total, perFile } = scan(join(here, '..', 'src'))
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(baselinePath, JSON.stringify(total, null, 2) + '\n')
    console.log('baseline written', total)
    process.exit(0)
  }
  if (process.argv.includes('--files')) {
    for (const [f, c] of Object.entries(perFile)) console.log(f, JSON.stringify(c))
  }
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'))
  let fail = false
  for (const k of Object.keys(total)) {
    const d = total[k] - (base[k] ?? 0)
    if (d > 0) { console.error(`✗ ${k}: ${total[k]} > baseline ${base[k]} (+${d})`); fail = true }
    else if (d < 0) console.log(`↓ ${k}: ${total[k]} < baseline ${base[k]} — lower lint-tokens.baseline.json in this commit`)
    else console.log(`= ${k}: ${total[k]}`)
  }
  if (fail) process.exit(1)
}
