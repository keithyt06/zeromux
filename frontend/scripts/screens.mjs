// Screenshot baseline tool (spec §3.6 / R17). Runs against an ISOLATED smoke
// instance only — never the live :8090. Captures fixed scenes at two viewports.
// Requires playwright-core + a local chromium; resolve both at runtime so the
// frontend has no dependency on them.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [base, outDir, ...rest] = process.argv.slice(2)
if (!base || !outDir || /:8090\b/.test(base)) {
  console.error('usage: node scripts/screens.mjs http://127.0.0.1:<port≠8090> <outDir> [--theme dark|light] [--sessions id,id] [--token T]')
  process.exit(2)
}
const arg = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d }
const theme = arg('--theme', 'dark')
const sessions = (arg('--sessions', '') || '').split(',').filter(Boolean)
const token = arg('--token', 'smoke')

const req = createRequire(process.env.PLAYWRIGHT_CORE_FROM || '/tmp/zmx-pw/package.json')
const { chromium } = req('playwright-core')
const exe = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`

const VIEWPORTS = [
  { name: 'm', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' },
  { name: 'd', width: 1440, height: 900, deviceScaleFactor: 1 },
]
mkdirSync(outDir, { recursive: true })
const b = await chromium.launch({ executablePath: exe })
for (const vp of VIEWPORTS) {
  const { name, ...opts } = vp
  const ctx = await b.newContext({ viewport: { width: opts.width, height: opts.height }, ...opts, colorScheme: theme })
  await ctx.addInitScript(([t, th]) => { localStorage.setItem('zeromux_token', t); localStorage.setItem('zeromux_theme', th) }, [token, theme])
  const p = await ctx.newPage()
  const shot = async (label, url) => {
    await p.goto(base + url); await p.waitForTimeout(2500)
    await p.screenshot({ path: join(outDir, `${name}-${theme}-${label}.png`) })
  }
  await shot('home', '/')
  for (const id of sessions) await shot(`session-${id.slice(0, 6)}`, `/?session=${id}`)
  await ctx.close()
}
await b.close()
console.log('screens written to', outDir)
