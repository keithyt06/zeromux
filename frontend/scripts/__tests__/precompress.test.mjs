import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { shouldCompress, compressFile } from '../precompress.mjs'
import { entryAssets, budgetReport } from '../check-size.mjs'

describe('precompress', () => {
  it('only compresses text-like assets >= 1KB', () => {
    expect(shouldCompress('assets/index-a.js', 2048)).toBe(true)
    expect(shouldCompress('assets/index-a.css', 2048)).toBe(true)
    expect(shouldCompress('index.html', 2048)).toBe(true)
    expect(shouldCompress('assets/a.woff2', 2048)).toBe(false) // already compressed
    expect(shouldCompress('icon-192.png', 9000)).toBe(false)
    expect(shouldCompress('assets/tiny.js', 500)).toBe(false)
    expect(shouldCompress('assets/index-a.js.br', 9000)).toBe(false)
  })
  it('writes .br and .gz that round-trip', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pc-'))
    const f = join(d, 'a.js')
    writeFileSync(f, 'const x = 1;\n'.repeat(500))
    await compressFile(f)
    expect(brotliDecompressSync(readFileSync(f + '.br')).toString()).toBe(readFileSync(f, 'utf8'))
    expect(gunzipSync(readFileSync(f + '.gz')).toString()).toBe(readFileSync(f, 'utf8'))
  })
  it('skips a variant that would not be smaller', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pc-'))
    const f = join(d, 'r.js')
    writeFileSync(f, randomBytes(1200))
    await compressFile(f)
    // random-ish bytes: at least one variant must be skipped rather than bloating
    expect(existsSync(f + '.br') && existsSync(f + '.gz')).toBe(false)
  })
})

describe('check-size', () => {
  it('finds entry js/css from index.html', () => {
    const html = '<script type="module" crossorigin src="/assets/index-Ab.js"></script><link rel="stylesheet" crossorigin href="/assets/index-Cd.css">'
    expect(entryAssets(html)).toEqual(['assets/index-Ab.js', 'assets/index-Cd.css'])
  })
  it('counts <link rel="modulepreload"> targets as first-screen (the browser fetches them eagerly)', () => {
    const html = '<script type="module" crossorigin src="/assets/index-Ab.js"></script>'
      + '<link rel="modulepreload" crossorigin href="/assets/mermaid-Zz.js">'
      + '<link rel="stylesheet" crossorigin href="/assets/index-Cd.css">'
    expect(entryAssets(html).sort()).toEqual(['assets/index-Ab.js', 'assets/index-Cd.css', 'assets/mermaid-Zz.js'])
  })
  it('sums .br sizes against the limit', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cs-'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(d, 'assets'))
    writeFileSync(join(d, 'index.html'), '<script type="module" src="/assets/index-A.js"></script><link rel="stylesheet" href="/assets/index-B.css">')
    writeFileSync(join(d, 'assets/index-A.js'), 'x'.repeat(4000)); await compressFile(join(d, 'assets/index-A.js'))
    writeFileSync(join(d, 'assets/index-B.css'), 'y'.repeat(4000)); await compressFile(join(d, 'assets/index-B.css'))
    const r = budgetReport(d, 10)
    expect(r.files).toHaveLength(2)
    expect(r.ok).toBe(false)
    expect(budgetReport(d, 1_000_000).ok).toBe(true)
  })
})
