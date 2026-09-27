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
  nativeDialog: /(?<![\w.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/g,
  emojiIcon: /[📜👍👎⧉🖱✎📎⏸⤓⤒🔔🔕]/gu,
}

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
  return out
}

function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    if (n === '__tests__' || n === 'node_modules') return []
    return statSync(p).isDirectory() ? walk(p) : (/\.tsx?$/.test(n) ? [p] : [])
  })
}

export function scan(root) {
  const total = Object.fromEntries(Object.keys(RULES).map(k => [k, 0]))
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
