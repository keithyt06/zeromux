// First-screen budget gate: entry JS + CSS referenced by dist/index.html,
// measured as their precompressed .br size (what browsers actually download).
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function entryAssets(indexHtml) {
  const out = []
  for (const m of indexHtml.matchAll(/<script[^>]+src="\/(assets\/[^"]+\.js)"/g)) out.push(m[1])
  for (const m of indexHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/(assets\/[^"]+\.css)"/g)) out.push(m[1])
  return out
}

export function budgetReport(dir, limitBytes) {
  const files = entryAssets(readFileSync(join(dir, 'index.html'), 'utf8')).map(path => {
    const br = join(dir, path + '.br')
    return { path, br: existsSync(br) ? statSync(br).size : statSync(join(dir, path)).size }
  })
  const total = files.reduce((s, f) => s + f.br, 0)
  return { total, files, ok: total <= limitBytes }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || 'dist'
  const limit = Number(process.argv[3] || 337920)
  const r = budgetReport(dir, limit)
  for (const f of r.files) console.log(`  ${f.path}  ${(f.br / 1024).toFixed(1)}KB br`)
  console.log(`first-screen br total ${(r.total / 1024).toFixed(1)}KB / limit ${(limit / 1024).toFixed(0)}KB`)
  if (!r.ok) { console.error('BUDGET EXCEEDED'); process.exit(1) }
}
