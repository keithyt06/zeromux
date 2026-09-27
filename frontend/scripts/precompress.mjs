// Build-time precompression: emit .br (q11) next to every compressible dist
// asset. The Rust server serves these verbatim (web.rs
// try_serve_embedded), so the expensive q11 cost is paid once per build, not
// per request (runtime tower-http br defaults to q4 ≈ 77KB larger on the main
// bundle). A variant that isn't smaller is skipped. No .gz: browsers on HTTPS
// always send br, and a .gz set would embed ~1.26MB more into the binary for
// nothing — gzip-only clients get identity → runtime CompressionLayer gzip.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const EXT = /\.(js|mjs|css|html|svg|json|txt|map)$/i
const MIN_BYTES = 1024

export function shouldCompress(path, size) {
  return EXT.test(path) && size >= MIN_BYTES
}

export async function compressFile(abs) {
  const src = readFileSync(abs)
  const out = {}
  const br = brotliCompressSync(src, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: src.length,
    },
  })
  if (br.length < src.length) { writeFileSync(abs + '.br', br); out.br = br.length }
  return out
}

function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || 'dist'
  let n = 0
  for (const f of walk(dir)) {
    const rel = relative(dir, f)
    if (!shouldCompress(rel, statSync(f).size)) continue
    await compressFile(f)
    n++
  }
  console.log(`precompress: ${n} files`)
}
