# 前端重设计 S1「地基」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 S2/S3/S4 共用的地基——构建期 br 预压 + 体积门禁、语义 token(修正全局对比度与字号)、三态主题无闪烁、响应式 hooks、零依赖 primitives、统一数据层——并把「不会被后续重写」的面板迁到新体系。

**Architecture:** 纯增量 + 逐文件迁移。先上「护栏」(体积门禁、token 棘轮、截图基线、对比度校验),再加「零视觉变化」的 token 别名层,然后一次性做**有意的**全局视觉修正(对比度 / 字体 / 主题),最后建 primitives 与数据层 hooks 并迁移 S1 负责的组件。不引入任何运行时依赖。

**Tech Stack:** React 19 + Vite 8 + Tailwind v4(`@theme inline`)+ vitest/happy-dom 15/@testing-library/react;Rust axum 0.8 + rust-embed 8;Node 内置 `zlib`(brotli/gzip 预压);playwright-core 1.58(截图,开发机已装 chromium-1208)。

**Spec:** `docs/superpowers/specs/2026-09-26-frontend-triage-focus-redesign-design.md` —— **§0.4(v2 修订 R1–R17)与 §3(S1 地基 v2)**,验收见 §3.6。审计 `docs/superpowers/audits/2026-09-26-frontend-ux-audit.md` §7(不变量 I-1~I-19)。

## Global Constraints

- **零新增运行时依赖**(不引 Radix / Ariakit / Base UI / motion / cmdk / 虚拟列表 / zustand);devDependency 仅允许本计划显式列出的(无)。
- 首屏入口 JS + CSS **br ≤ 330KB**(`scripts/check-size.mjs`,接入 `npm run build`)。
- 审计 §7 不变量 I-1 ~ I-19 全部保持。**App.tsx 的轮询 / 焦点 / 认证分级逻辑(I-2、I-3)本计划一行不改**;App.tsx 只允许改:`isMobile` 判定来源、主题 hook 接线、面板挂载点、toast 接线。
- **不改**:`AcpChatView.tsx`、`GitViewer.tsx`、`FileBrowser.tsx`、`SessionInfoBar.tsx`、`TerminalView.tsx` 的 WS / 输入 / resize 路径(S2/S3 重写)。TerminalView 只允许改:主题读取(T4)、触屏判定来源(T6)、字体栈(T3)。
- 输入框字号保持 16px(`text-ui-input` 或现有 `text-base`,I-15)。
- 用户可见文案中文;代码 / 注释英文(已有中文注释的文件可沿用中文)。
- 图标只用 `lucide-react`;本计划触及的文件中 emoji 图标清零。
- 每个 Task 结束:`cd frontend && npm test` 全绿、`npx tsc -b` 通过、`npm run lint`(含棘轮)通过;涉及 Rust 的 Task `cargo test` 全绿。lint 基线:现有 20 个 eslint error 不要求修,**不得新增**。
- 部署只用 `./deploy.sh --build`,**先 commit + push 再 deploy**;冒烟 / 截图实例必须 `--data-dir <临时目录>` + `--tmux-socket <专用名>` 隔离,端口 ≥ 18090,绝不碰 8090 与 systemctl。
- 每个「视觉变化」Task(T3、T4、T11、T12、T13、T14)在收尾步骤用 T2 的截图脚本出前后对比图,存 `docs/superpowers/screens/s1/<task>/`。

## Review Focus

1. **浅色系统主题冷启动**:用户系统为浅色、localStorage 无偏好,首帧必须已是浅色(无暗色闪烁),xterm 与 mermaid 也为浅色(T4 测试 + 截图)。
2. **预压资源与 SPA fallback / 非资源路径**:`/`、`/?session=x`、`/favicon.svg`、`/sw.js`、`/manifest.json` 在带 / 不带 `Accept-Encoding: br` 时都返回正确 MIME 与正文;`sw.js` 不能因为 `.br` 返回错 `Content-Type` 导致 SW 注册失败(T1 测试)。
3. **iOS 软键盘弹出时的 bottom Sheet**:Sheet 内有输入框(PromptManager、prompt 对话框)聚焦时,输入框不被键盘遮挡、Sheet 不被顶出屏幕(T9 测试断言 VisualViewport 高度被采用;T13 真机截图)。
4. **push 开启时 subscribe 失败**:用户看到失败提示、本地不写「已启用」、开关保持关闭(T11 测试)。
5. **撤销关闭 toast 与失败 toast 同时出现**:两条都显示,撤销仍在 `pending_until - now - 500` 内有效,点击撤销后失败 toast 不遮挡(T10 测试)。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `frontend/scripts/precompress.mjs` | Create | 构建后为 dist 生成 `.br`(q11)/`.gz`(9) |
| `frontend/scripts/check-size.mjs` | Create | 入口 JS+CSS br 体积门禁 |
| `frontend/scripts/lint-tokens.mjs` + `lint-tokens.baseline.json` | Create | 五类棘轮计数 |
| `frontend/scripts/contrast.mjs` | Create | 解析 index.css token,校验对比度 |
| `frontend/scripts/screens.mjs` | Create | 隔离实例截图(playwright-core) |
| `frontend/scripts/__tests__/*.test.mjs` | Create | 脚本纯函数单测(vitest 覆盖 `scripts/**`) |
| `src/web.rs` | Modify | `try_serve_embedded` 优先返回预压变体 |
| `frontend/src/index.css` | Modify | v2 token(新语义变量 + 旧名别名 + `@theme inline` + 密度 + 工具类) |
| `frontend/public/theme-boot.js` | Create | 首帧前设主题 class / color-scheme |
| `frontend/index.html`、`frontend/public/manifest.json` | Modify | 引 theme-boot、双 theme-color、`#overlay-root` |
| `frontend/src/lib/theme.ts` | Modify | 三态 `system/dark/light` + resolved |
| `frontend/src/lib/terminalTheme.ts` | Create | 从 CSS 变量读 xterm 主题 |
| `frontend/src/lib/useMediaQuery.ts` | Create | `useMediaQuery / useIsNarrow / useIsTouch` |
| `frontend/src/lib/format.ts` | Create | 成本 / 耗时 / 相对时间 |
| `frontend/src/components/ui/*` | Create | Dialog、Sheet、Popover、Menu、Toaster+toast、confirm/promptText、IconButton、Tooltip、Kbd、Badge、SegmentedControl、Skeleton |
| `frontend/src/lib/http.ts` | Create | `request<T>` |
| `frontend/src/lib/api/*.ts` + `lib/api.ts` | Create / Modify | 按域拆分,`api.ts` 聚合 re-export |
| `frontend/src/lib/useLatestRequest.ts`、`useAsyncResource.ts`、`usePolling.ts`、`useDirBrowser.ts`、`usePathSearch.ts` | Create | 数据层 hooks |
| 组件迁移 | Modify | 见 T11–T14 |

---

### Task 1: 构建期 br/gzip 预压 + 后端返回预压 + 体积门禁

**Files:**
- Create: `frontend/scripts/precompress.mjs`、`frontend/scripts/check-size.mjs`、`frontend/scripts/__tests__/precompress.test.mjs`
- Modify: `frontend/package.json`(`build` 脚本)、`frontend/vitest.config.ts`(`include` 加 `scripts/**`)
- Modify: `src/web.rs:221-240`(`try_serve_embedded`)+ 末尾新增 `#[cfg(test)] mod precompressed_tests`

**Interfaces:**
- Produces: `frontend/scripts/precompress.mjs` 导出 `shouldCompress(path: string, size: number): boolean`、`compressFile(abs: string): Promise<{br?: number, gz?: number}>`;CLI `node scripts/precompress.mjs dist`。`check-size.mjs` 导出 `entryAssets(indexHtml: string): string[]`、`budgetReport(dir: string, limitBytes: number): {total: number, files: {path: string, br: number}[], ok: boolean}`;CLI `node scripts/check-size.mjs dist 337920`(330KB)。
- Rust:`fn pick_encoding(accept: &str) -> Option<&'static str>` 返回 `Some("br")` / `Some("gzip")` / `None`;`fn try_serve_embedded_enc(path: &str, accept: &str) -> Option<Response>`。

- [ ] **Step 1: vitest 覆盖 scripts 目录**

vitest 配置在 `frontend/vitest.config.ts`(已核实:`environment: 'happy-dom'`、`globals`、`setupFiles`、`css: false`、`exclude` 含 `.zeromux-worktrees`)。在其 `test` 块内**新增**一行(其余字段不动):

```ts
    include: ['src/**/*.test.{ts,tsx}', 'scripts/__tests__/**/*.test.mjs'],
```

- [ ] **Step 2: 写 precompress / check-size 的失败测试**

`frontend/scripts/__tests__/precompress.test.mjs`:

```js
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
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
    writeFileSync(f, Buffer.from(Array.from({ length: 1200 }, (_, i) => (i * 7919) % 256)))
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
```

- [ ] **Step 3: 运行确认失败**

Run: `cd frontend && npx vitest run scripts/__tests__/precompress.test.mjs`
Expected: FAIL(`Failed to resolve import "../precompress.mjs"`)。

- [ ] **Step 4: 实现两个脚本**

`frontend/scripts/precompress.mjs`:

```js
// Build-time precompression: emit .br (q11) and .gz (level 9) next to every
// compressible dist asset. The Rust server serves these verbatim (web.rs
// try_serve_embedded), so the expensive q11 cost is paid once per build, not
// per request (runtime tower-http br defaults to q4 ≈ 77KB larger on the main
// bundle). A variant that isn't smaller is skipped.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'
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
  const gz = gzipSync(src, { level: 9 })
  if (gz.length < src.length) { writeFileSync(abs + '.gz', gz); out.gz = gz.length }
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
```

`frontend/scripts/check-size.mjs`:

```js
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
```

`frontend/package.json` 的 `build`:

```json
"build": "tsc -b && vite build && node scripts/precompress.mjs dist && node scripts/check-size.mjs dist 337920",
```

- [ ] **Step 5: 运行测试 + 真实构建**

Run: `cd frontend && npx vitest run scripts/__tests__/precompress.test.mjs && npm run build 2>&1 | tail -4`
Expected: 测试 PASS;构建末尾打印 `first-screen br total ≈ 313KB / limit 330KB`,退出码 0。若 `shouldCompress` 的 random-bytes 用例不稳定(两种变体都更小),把输入改为 `crypto.randomBytes(1200)`。

- [ ] **Step 6: 写 Rust 失败测试**

`src/web.rs` 末尾追加:

```rust
#[cfg(test)]
mod precompressed_tests {
    use super::*;

    #[test]
    fn pick_encoding_prefers_br_then_gzip() {
        assert_eq!(pick_encoding("gzip, deflate, br"), Some("br"));
        assert_eq!(pick_encoding("gzip"), Some("gzip"));
        assert_eq!(pick_encoding("br;q=0, gzip"), Some("gzip"));
        assert_eq!(pick_encoding("identity"), None);
        assert_eq!(pick_encoding(""), None);
    }

    #[test]
    fn serves_br_variant_with_original_mime_when_present() {
        // index.html is always in dist and ≥1KB, so precompress emits index.html.br.
        let res = try_serve_embedded_enc("index.html", "br").expect("index.html embedded");
        let h = res.headers();
        assert_eq!(h.get("content-type").unwrap(), "text/html");
        assert_eq!(h.get("content-encoding").unwrap(), "br");
        assert_eq!(h.get("vary").unwrap(), "Accept-Encoding");
        assert!(h.get("content-security-policy").is_some());
    }

    #[test]
    fn falls_back_to_identity_without_accept() {
        let res = try_serve_embedded_enc("index.html", "").expect("index.html embedded");
        assert!(res.headers().get("content-encoding").is_none());
        assert_eq!(res.headers().get("vary").unwrap(), "Accept-Encoding");
    }

    #[test]
    fn never_serves_a_variant_as_its_own_path() {
        // Requesting the .br file directly must not be served (would give the
        // browser compressed bytes with an octet-stream type).
        assert!(try_serve_embedded_enc("index.html.br", "br").is_none());
    }
}
```

- [ ] **Step 7: 运行确认失败**

Run: `cargo test precompressed_tests`
Expected: 编译失败 `cannot find function pick_encoding`。

- [ ] **Step 8: 实现**

`src/web.rs`,替换 `serve_embedded` / `try_serve_embedded` 为下列代码,并让 `serve_asset` / `spa_fallback` 传入请求头:

```rust
/// Pick the best precompressed variant the client accepts. `q=0` disables.
fn pick_encoding(accept: &str) -> Option<&'static str> {
    let allows = |name: &str| {
        accept.split(',').any(|part| {
            let mut it = part.trim().split(';');
            let tok = it.next().unwrap_or("").trim();
            let q0 = it.any(|p| p.trim().replace(' ', "") == "q=0");
            tok.eq_ignore_ascii_case(name) && !q0
        })
    };
    if allows("br") { Some("br") } else if allows("gzip") { Some("gzip") } else { None }
}

fn serve_embedded(path: &str, accept: &str) -> Response {
    try_serve_embedded_enc(path, accept).unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

/// Serve an embedded dist file, preferring the build-time `.br` / `.gz`
/// sibling (frontend/scripts/precompress.mjs, brotli q11) when the client
/// accepts it. MIME is always derived from the ORIGINAL path. The runtime
/// CompressionLayer skips responses that already carry Content-Encoding.
fn try_serve_embedded_enc(path: &str, accept: &str) -> Option<Response> {
    if path.ends_with(".br") || path.ends_with(".gz") {
        return None;
    }
    let original = FrontendAssets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let (body, enc) = match pick_encoding(accept) {
        Some("br") => FrontendAssets::get(&format!("{path}.br"))
            .map(|f| (f.data, Some("br")))
            .unwrap_or((original.data, None)),
        Some("gzip") => FrontendAssets::get(&format!("{path}.gz"))
            .map(|f| (f.data, Some("gzip")))
            .unwrap_or((original.data, None)),
        _ => (original.data, None),
    };
    let mut b = Response::builder()
        .header("Content-Type", mime.as_ref())
        .header("Cache-Control", "public, max-age=3600")
        .header("Vary", "Accept-Encoding")
        // Global CSP backstop (defense-in-depth): even if a raw endpoint were
        // misconfigured, agent-generated content can't execute in the app origin.
        .header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
             script-src 'self'; worker-src 'self'; \
             connect-src 'self' ws: wss:; frame-src 'self'; \
             object-src 'none'; base-uri 'self'",
        );
    if let Some(e) = enc {
        b = b.header("Content-Encoding", e);
    }
    Some(b.body(axum::body::Body::from(body.to_vec())).unwrap())
}
```

`serve_asset` 与 `spa_fallback` 改为接收 `headers: axum::http::HeaderMap`:

```rust
async fn serve_asset(
    axum::extract::Path(path): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    serve_embedded(&format!("assets/{}", path), accept_encoding(&headers))
}

async fn spa_fallback(uri: axum::http::Uri, headers: axum::http::HeaderMap) -> Response {
    let accept = accept_encoding(&headers);
    let path = uri.path().trim_start_matches('/');
    if !path.is_empty() && !path.contains("..") {
        if let Some(resp) = try_serve_embedded_enc(path, accept) {
            return resp;
        }
    }
    serve_embedded("index.html", accept)
}

fn accept_encoding(headers: &axum::http::HeaderMap) -> &str {
    headers.get(axum::http::header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or("")
}
```

然后 `grep -n "try_serve_embedded(\|serve_embedded(" src/*.rs`:其它调用点(若有)一律改为 `try_serve_embedded_enc(path, "")` / `serve_embedded(path, "")`,并删除旧 `try_serve_embedded`。

- [ ] **Step 9: 运行 Rust 测试**

Run: `cd frontend && npm run build >/dev/null && cd .. && cargo test precompressed_tests && cargo test compression_tests && cargo test 2>&1 | grep "^test result"`
Expected: 全 PASS(rust-embed 在编译期读取 dist,所以必须先 build 前端)。

- [ ] **Step 10: 隔离冒烟(Review Focus #2)**

```bash
cargo build
SMOKE=$(mktemp -d)
./target/debug/zeromux --port 18093 --password smoke --data-dir "$SMOKE" --tmux-socket zmx-smoke-s1t1 > "$SMOKE/log" 2>&1 &
PID=$!; sleep 3
B=http://127.0.0.1:18093
JS=$(curl -s $B/ | grep -o '/assets/index-[^"]*\.js' | head -1)
for p in / "/?session=x" /favicon.svg /sw.js /manifest.json "$JS"; do
  for enc in br gzip identity; do
    curl -s -o /tmp/s1t1.out -D /tmp/s1t1.h -H "Accept-Encoding: $enc" "$B$p"
    printf '%-28s %-8s %s %s %s\n' "$p" "$enc" "$(grep -i '^content-type' /tmp/s1t1.h | tr -d '\r' | cut -d' ' -f2)" "$(grep -i '^content-encoding' /tmp/s1t1.h | tr -d '\r' | cut -d' ' -f2)" "$(stat -c%s /tmp/s1t1.out)"
  done
done
curl -s -o /dev/null -w 'ws=%{http_code}\n' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Accept-Encoding: br' --max-time 2 "$B/ws/term/nonexistent?token=smoke"
kill $PID; tmux -L zmx-smoke-s1t1 kill-server 2>/dev/null; rm -rf "$SMOKE" /tmp/s1t1.*
```

Expected:`sw.js` 在三种编码下 `Content-Type` 均为 `text/javascript` 或 `application/javascript`;`/?session=x` 为 `text/html`;br 行的主 JS 大小 ≈ 305–315KB;`ws` 为 101 或 4xx(非 5xx;`000` = 升级成功后超时,也算通过)。

- [ ] **Step 11: Commit**

```bash
git add frontend/scripts frontend/package.json frontend/vitest.config.ts src/web.rs
git commit -m "perf(build): precompress dist at brotli q11 and serve variants; first-screen budget gate"
```

---

### Task 2: 护栏 —— token 棘轮 + 对比度校验 + 截图脚本

**Files:**
- Create: `frontend/scripts/lint-tokens.mjs`、`frontend/scripts/lint-tokens.baseline.json`、`frontend/scripts/contrast.mjs`、`frontend/scripts/screens.mjs`、`frontend/scripts/__tests__/lint-tokens.test.mjs`、`frontend/scripts/__tests__/contrast.test.mjs`
- Modify: `frontend/package.json`(`lint` 脚本)

**Interfaces:**
- Produces: `lint-tokens.mjs` 导出 `countViolations(source: string): Record<Category, number>`,`Category = 'smallText' | 'paletteColor' | 'zIndex' | 'nativeDialog' | 'emojiIcon'`;CLI 退出码 1 = 任一类超过 baseline。`contrast.mjs` 导出 `contrastRatio(a: string, b: string): number`、`parseThemes(css: string): { dark: Record<string,string>, light: Record<string,string> }`、`checkPairs(theme, pairs: [fg, bg, min][]): {fg, bg, ratio, min, ok}[]`;CLI 读 `src/index.css`,规则见 T3。`screens.mjs` CLI:`node scripts/screens.mjs <baseUrl> <outDir> [--theme dark|light] [--sessions id1,id2]`。

- [ ] **Step 1: 写棘轮失败测试**

`frontend/scripts/__tests__/lint-tokens.test.mjs`:

```js
import { describe, it, expect } from 'vitest'
import { countViolations } from '../lint-tokens.mjs'

describe('countViolations', () => {
  it('counts sub-12px arbitrary text sizes only', () => {
    const c = countViolations('<a className="text-[10px] text-[11px] text-[12px] text-[9px] text-[8px]" />')
    expect(c.smallText).toBe(4)
  })
  it('counts raw Tailwind palette colors', () => {
    const c = countViolations('className="text-yellow-400 bg-orange-500 border-zinc-700 text-[var(--fg)]"')
    expect(c.paletteColor).toBe(3)
  })
  it('counts z-N utilities but not z-(--z-modal) or z-sticky', () => {
    const c = countViolations('className="z-10 z-50 z-(--z-modal) z-sticky"')
    expect(c.zIndex).toBe(2)
  })
  it('counts native dialogs, ignoring comments and window.confirm mentions in comments', () => {
    const src = [
      "if (!confirm('x')) return",
      "window.alert('y')",
      "const n = prompt('name')",
      "// do not use window.confirm here",
      "  /* alert( */",
      "promptText({ title: 't' })",
      "await confirmDialog()",
    ].join('\n')
    expect(countViolations(src).nativeDialog).toBe(3)
  })
  it('counts emoji icons from the deny-list', () => {
    expect(countViolations("<span>📜</span><b>👍 👎</b>{'⧉ x'}🖱").emojiIcon).toBe(5)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run scripts/__tests__/lint-tokens.test.mjs`
Expected: FAIL(无法 resolve)。

- [ ] **Step 3: 实现 lint-tokens.mjs**

```js
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
```

> 注:emoji 类对**含注释的原文**计数(注释里的 emoji 不影响 UI,但计数简单稳定;若因注释 emoji 导致 baseline 偏高,迁移时顺手删注释里的 emoji 即可降)。

- [ ] **Step 4: 写 baseline 并接入 lint**

Run: `cd frontend && node scripts/lint-tokens.mjs --write-baseline && cat scripts/lint-tokens.baseline.json`
Expected: 近似 `{"smallText":180,"paletteColor":16,"zIndex":26,"nativeDialog":17,"emojiIcon":N}`(与主会话 2026-09-27 实测一致;N 为实际值)。

`package.json`:`"lint": "eslint . && node scripts/lint-tokens.mjs"`。

- [ ] **Step 5: 写对比度失败测试**

`frontend/scripts/__tests__/contrast.test.mjs`:

```js
import { describe, it, expect } from 'vitest'
import { contrastRatio, parseThemes, checkPairs } from '../contrast.mjs'

describe('contrast', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#484f58', '#11161d')).toBeCloseTo(2.19, 2)
  })
  it('parses :root and :root.light custom properties', () => {
    const css = ':root { --a: #111111; --b: #eeeeee; }\n:root.light { --a: #ffffff; }'
    const t = parseThemes(css)
    expect(t.dark['--a']).toBe('#111111')
    expect(t.light['--a']).toBe('#ffffff')
    expect(t.light['--b']).toBe('#eeeeee') // light inherits unspecified dark values
  })
  it('resolves var() aliases', () => {
    const t = parseThemes(':root { --x: #222222; --y: var(--x); }')
    expect(t.dark['--y']).toBe('#222222')
  })
  it('reports failing pairs', () => {
    const r = checkPairs({ '--fg': '#484f58', '--bg': '#11161d' }, [['--fg', '--bg', 4.5]])
    expect(r[0].ok).toBe(false)
  })
})
```

- [ ] **Step 6: 实现 contrast.mjs**

```js
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
```

> 本 Task 不接入 `lint`(当前 index.css 还没有新 token,会报 missing);T3 接入。

- [ ] **Step 7: 截图脚本**

`frontend/scripts/screens.mjs`:

```js
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
```

> 截图脚本从 `/tmp/zmx-pw`(P0 时安装的 playwright-core 1.58)解析,**不**给 frontend 加依赖。若该目录不存在:`mkdir -p /tmp/zmx-pw && cd /tmp/zmx-pw && npm init -y >/dev/null && npm i playwright-core@1.58 >/dev/null`。

- [ ] **Step 8: 运行全部测试 + lint + 生成 S1 起点基线截图**

```bash
cd frontend && npx vitest run scripts/__tests__ && npm run lint 2>&1 | tail -6 && npm test 2>&1 | grep -E "Test Files|Tests "
```

Expected: 脚本测试 PASS;lint 输出五行 `= …`(eslint 部分仍是既有 20 error —— **注意**:若 `eslint .` 非零退出导致 `&&` 短路,把 lint 脚本改为 `"lint": "eslint . ; node scripts/lint-tokens.mjs"`?**不**——那会让 eslint 错误被吞。保留 `&&`,并在本 Task 报告中记录「eslint 基线 20 error 使 `npm run lint` 本就非零;棘轮单独用 `node scripts/lint-tokens.mjs` 验证」。各 Task 的 lint 门禁 = `npx eslint <touched files>` 无新增 + `node scripts/lint-tokens.mjs` 退出 0)。

起隔离实例截图(沿用 T1 Step 10 的启动方式,端口 18093),对 dark / light 各跑一次:

```bash
node scripts/screens.mjs http://127.0.0.1:18093 ../docs/superpowers/screens/s1/t2-baseline --theme dark
node scripts/screens.mjs http://127.0.0.1:18093 ../docs/superpowers/screens/s1/t2-baseline --theme light
```

Expected: 生成 4 张 `home` 截图(m/d × dark/light)。

- [ ] **Step 9: Commit**

```bash
git add frontend/scripts frontend/package.json docs/superpowers/screens/s1/t2-baseline
git commit -m "chore(frontend): token ratchet, contrast checker and isolated screenshot tool"
```

---

### Task 3: v2 token 层 + 全局对比度 / 字体修正(有意的全局视觉变化)

**Files:**
- Modify: `frontend/src/index.css:1-94`(token 区)、`frontend/package.json`(lint 接 contrast)
- Test: `frontend/src/lib/__tests__/tokens.test.ts`(新建)

**Interfaces:**
- Produces(CSS 变量,S2/S3 依赖其名字):`--surface-0..3`、`--surface-hover`、`--border`、`--border-subtle`、`--fg-strong`、`--fg`、`--fg-muted`、`--fg-subtle`、`--accent`、`--accent-hover`、`--on-accent`、`--danger`、`--stuck`、`--attention`、`--success`、`--success-solid`、`--success-solid-hover`、`--running`、`--brand`、`--peer`、`--focus-ring`、`--code-bg`、`--disabled-bg`、`--disabled-fg`、`--term-selection`、`--ansi-0..15`、`--row-h`、`--ctl-h`、`--hit`、`--pad-x`、`--radius-{sm,md,lg,sheet}`、`--shadow-overlay`、`--shadow-card`、`--z-{sticky,drawer,popover,modal,toast}`、`--ease-out`、`--dur-fast`、`--dur-base`、`--font-sans`、`--font-mono`。
- Tailwind 工具类(由 `@theme inline` 生成):`bg-surface-0..3`、`text-fg`、`text-fg-muted`、`text-fg-subtle`、`text-fg-strong`、`text-accent`、`text-danger`、`text-stuck`、`text-attention`、`text-success`、`border-border`、`border-border-subtle` 等;字号 `text-ui-2xs|xs|sm|base|input|lg|xl`;`font-sans`、`font-mono`。
- 自定义工具类:`.num`、`.row`、`.ctl`、`.z-sticky|drawer|popover|modal|toast`、`.focus-ring`。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error — plain ESM script without types
import { parseThemes, TEXT, SURFACES, STATES, contrastRatio } from '../../../scripts/contrast.mjs'

const css = readFileSync(join(__dirname, '../../index.css'), 'utf8')
const t = parseThemes(css)

describe('design tokens v2', () => {
  it('defines every semantic token in both themes', () => {
    for (const k of [...TEXT, ...SURFACES, ...STATES, '--surface-hover', '--border', '--border-subtle', '--on-accent', '--brand', '--peer', '--focus-ring', '--term-selection']) {
      expect(t.dark[k], `dark ${k}`).toMatch(/^#[0-9a-f]{6,8}$/i)
      expect(t.light[k], `light ${k}`).toMatch(/^#[0-9a-f]{6,8}$/i)
    }
  })
  it('legacy names alias the semantic layer (no divergent values)', () => {
    for (const [legacy, semantic] of [
      ['--bg-primary', '--surface-1'], ['--bg-secondary', '--surface-2'], ['--bg-tertiary', '--surface-3'],
      ['--bg-hover', '--surface-hover'], ['--text-primary', '--fg'], ['--text-bright', '--fg-strong'],
      ['--text-secondary', '--fg-muted'], ['--text-muted', '--fg-subtle'], ['--accent-blue', '--accent'],
      ['--accent-red', '--danger'], ['--accent-yellow', '--attention'], ['--accent-green-text', '--success'],
      ['--accent-brand', '--brand'], ['--border-light', '--border-subtle'],
    ] as const) {
      expect(t.dark[legacy], legacy).toBe(t.dark[semantic])
      expect(t.light[legacy], legacy).toBe(t.light[semantic])
    }
  })
  it('text tokens clear 4.5:1 on every surface, both themes', () => {
    for (const theme of [t.dark, t.light]) {
      for (const fg of TEXT) for (const bg of SURFACES) {
        expect(contrastRatio(theme[fg], theme[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
  it('keeps --text-muted distinct from the old failing value', () => {
    expect(t.dark['--text-muted']).not.toBe('#484f58')
  })
  it('ANSI palette matches the xterm palette the user actually sees', () => {
    expect(t.dark['--ansi-0']).toBe('#484f58')
    expect(t.light['--ansi-15']).toBe('#8c959f')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/tokens.test.ts`
Expected: FAIL(`--surface-0` 未定义等)。

- [ ] **Step 3: 替换 `index.css` 的 token 区(行 1–94)**

保留第 1–2 行两个 `@import`。把现有 `:root { … }` 与 `:root.light { … }` 两块**整体替换**为:

```css
/* ── Design tokens v2 (spec 2026-09-26 §3.1) ─────────────────────────────
   Semantic variables below are the single source of truth. Legacy names
   (--bg-*, --text-*, --accent-*) are aliases kept so existing call sites keep
   working; new code must use the semantic names (enforced by review, and the
   ratchet in scripts/lint-tokens.mjs blocks new raw palette colors). */

:root {
  color-scheme: dark;
  --surface-0: #0d1117;
  --surface-1: #11161d;
  --surface-2: #161c25;
  --surface-3: #1f2630;
  --surface-hover: #243040;
  --border: #2a323d;
  --border-subtle: #1f252e;
  --fg-strong: #e6edf3;
  --fg: #cdd6e0;
  --fg-muted: #9aa5b1;
  --fg-subtle: #848d97;
  --accent: #58a6ff;
  --accent-hover: #79c0ff;
  --on-accent: #0d1117;
  --danger: #f85149;
  --stuck: #f0883e;
  --attention: #d29922;
  --success: #3fb950;
  --success-solid: #238636;
  --success-solid-hover: #2ea043;
  --running: var(--accent);
  --brand: #f7b500;
  --peer: #a371f7;
  --peer-dim: #8b5cf6;
  --peer-bg: #1c1c2e;
  --peer-fg: #a5a0c8;
  --focus-ring: #58a6ff99;
  --code-bg: #1c2128;
  --disabled-bg: #21262d;
  --disabled-fg: #6e7681;
  --term-selection: #264f78;
  --shadow-overlay: 0 8px 24px rgb(0 0 0 / 0.45);
  --shadow-card: none;

  /* ANSI 16 — xterm reads these at runtime (lib/terminalTheme.ts). */
  --ansi-0: #484f58;  --ansi-1: #ff7b72;  --ansi-2: #3fb950;  --ansi-3: #d29922;
  --ansi-4: #58a6ff;  --ansi-5: #bc8cff;  --ansi-6: #39c5cf;  --ansi-7: #b1bac4;
  --ansi-8: #6e7681;  --ansi-9: #ffa198;  --ansi-10: #56d364; --ansi-11: #e3b341;
  --ansi-12: #79c0ff; --ansi-13: #d2a8ff; --ansi-14: #56d4dd; --ansi-15: #f0f6fc;
  --term-fg: #c9d1d9;

  /* Legacy aliases */
  --bg-primary: var(--surface-1);
  --bg-secondary: var(--surface-2);
  --bg-tertiary: var(--surface-3);
  --bg-hover: var(--surface-hover);
  --border-light: var(--border-subtle);
  --text-primary: var(--fg);
  --text-bright: var(--fg-strong);
  --text-secondary: var(--fg-muted);
  --text-muted: var(--fg-subtle);
  --accent-blue: var(--accent);
  --accent-blue-hover: var(--accent-hover);
  --accent-green: var(--success-solid);
  --accent-green-hover: var(--success-solid-hover);
  --accent-green-text: var(--success);
  --accent-purple: var(--peer);
  --accent-purple-dim: var(--peer-dim);
  --accent-purple-bg: var(--peer-bg);
  --accent-purple-text: var(--peer-fg);
  --accent-yellow: var(--attention);
  --accent-red: var(--danger);
  --accent-brand: var(--brand);
  --btn-disabled-bg: var(--disabled-bg);
  --btn-disabled-text: var(--disabled-fg);

  /* Density (pointer-driven, spec R5) */
  --row-h: 32px;
  --ctl-h: 28px;
  --hit: 28px;
  --pad-x: 12px;

  /* Shape / layering / motion */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-sheet: 16px;
  --z-sticky: 10;
  --z-drawer: 30;
  --z-popover: 40;
  --z-modal: 50;
  --z-toast: 60;
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --dur-fast: 120ms;
  --dur-base: 200ms;

  --font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}

:root.light {
  color-scheme: light;
  --surface-0: #ffffff;
  --surface-1: #f6f8fa;
  --surface-2: #eef1f4;
  --surface-3: #e4e8ec;
  --surface-hover: #dce3ea;
  --border: #d0d7de;
  --border-subtle: #e4e8ec;
  --fg-strong: #1f2328;
  --fg: #1f2328;
  --fg-muted: #59636e;
  --fg-subtle: #5f6873;
  --accent: #0969da;
  --accent-hover: #0550ae;
  --on-accent: #ffffff;
  --danger: #cf222e;
  --stuck: #bc4c00;
  --attention: #9a6700;
  --success: #1a7f37;
  --success-solid: #1a7f37;
  --success-solid-hover: #15803d;
  --brand: #b08800;
  --peer: #8250df;
  --peer-dim: #6639ba;
  --peer-bg: #f3f0ff;
  --peer-fg: #6e5494;
  --focus-ring: #0969da80;
  --code-bg: #f6f8fa;
  --disabled-bg: #eaeef2;
  --disabled-fg: #8c959f;
  --term-selection: #b6d4fe;
  --shadow-overlay: 0 8px 24px rgb(31 35 40 / 0.12);
  --shadow-card: 0 1px 2px rgb(31 35 40 / 0.06);

  --ansi-0: #24292f;  --ansi-1: #cf222e;  --ansi-2: #1a7f37;  --ansi-3: #9a6700;
  --ansi-4: #0969da;  --ansi-5: #8250df;  --ansi-6: #1b7c83;  --ansi-7: #6e7781;
  --ansi-8: #57606a;  --ansi-9: #a40e26;  --ansi-10: #116329; --ansi-11: #7d4e00;
  --ansi-12: #0550ae; --ansi-13: #6639ba; --ansi-14: #136061; --ansi-15: #8c959f;
  --term-fg: #1f2328;
}

@media (pointer: coarse) {
  :root { --row-h: 44px; --ctl-h: 36px; --hit: 44px; --pad-x: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur-fast: 0ms; --dur-base: 0ms; }
}

@theme inline {
  --color-surface-0: var(--surface-0);
  --color-surface-1: var(--surface-1);
  --color-surface-2: var(--surface-2);
  --color-surface-3: var(--surface-3);
  --color-surface-hover: var(--surface-hover);
  --color-border: var(--border);
  --color-border-subtle: var(--border-subtle);
  --color-fg-strong: var(--fg-strong);
  --color-fg: var(--fg);
  --color-fg-muted: var(--fg-muted);
  --color-fg-subtle: var(--fg-subtle);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-on-accent: var(--on-accent);
  --color-danger: var(--danger);
  --color-stuck: var(--stuck);
  --color-attention: var(--attention);
  --color-success: var(--success);
  --color-running: var(--running);
  --color-peer: var(--peer);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --text-ui-2xs: 12px;   --text-ui-2xs--line-height: 16px;
  --text-ui-xs: 13px;    --text-ui-xs--line-height: 18px;
  --text-ui-sm: 14px;    --text-ui-sm--line-height: 20px;
  --text-ui-base: 15px;  --text-ui-base--line-height: 24px;
  --text-ui-input: 16px; --text-ui-input--line-height: 24px;
  --text-ui-lg: 17px;    --text-ui-lg--line-height: 24px;
  --text-ui-xl: 20px;    --text-ui-xl--line-height: 28px;
  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
}

html { font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
.num { font-variant-numeric: tabular-nums; }
.row { min-height: var(--row-h); }
.ctl { min-height: var(--ctl-h); }
.z-sticky { z-index: var(--z-sticky); }
.z-drawer { z-index: var(--z-drawer); }
.z-popover { z-index: var(--z-popover); }
.z-modal { z-index: var(--z-modal); }
.z-toast { z-index: var(--z-toast); }
.focus-ring:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
```

> `--text-ui-*--line-height` 是 Tailwind v4 字号 token 的配套行高写法;`@theme inline` 中 `--radius-sm: var(--radius-sm)` 自引用可能被 Tailwind 视为循环 —— 若构建报错或 `rounded-sm` 失效,把这三行删掉(直接用 `rounded-[var(--radius-md)]` 或 Tailwind 默认 `rounded-md` = 6px 也可,S1 不强制),在报告中说明。

`--disabled-fg` 从 `#484f58` 改为 `#6e7681`:禁用态文字原值与 `--text-muted` 同为 2.19:1,禁用态不要求 4.5,但 3:1 以下在手机阳光下不可读。

- [ ] **Step 4: 字体栈接线**

`TerminalView.tsx:301` 附近 `fontFamily: "'JetBrains Mono', 'Fira Code', …"`(`grep -n fontFamily src/components/TerminalView.tsx`)改为:

```ts
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'ui-monospace, Menlo, monospace',
```

- [ ] **Step 5: 接入对比度门禁**

`package.json`:`"lint": "eslint . && node scripts/lint-tokens.mjs && node scripts/contrast.mjs"`。

- [ ] **Step 6: 运行**

Run: `cd frontend && npx vitest run src/lib/__tests__/tokens.test.ts && node scripts/contrast.mjs && node scripts/lint-tokens.mjs && npm test 2>&1 | grep -E "Test Files|Tests " && npm run build 2>&1 | tail -2`
Expected: 全 PASS;`contrast ok`;体积门禁通过。

- [ ] **Step 7: 截图对比**

起隔离实例(T1 Step 10 方式),`node scripts/screens.mjs http://127.0.0.1:18093 ../docs/superpowers/screens/s1/t3 --theme dark` 与 `--theme light`,与 `t2-baseline` 并排检查:次要文字明显更亮、字体改为 SF / 苹方系统字体;布局无错位。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/index.css frontend/src/lib/__tests__/tokens.test.ts frontend/src/components/TerminalView.tsx frontend/package.json docs/superpowers/screens/s1/t3
git commit -m "feat(ui): v2 semantic design tokens; fix secondary-text contrast (2.2→4.5+:1), system font stack"
```

---

### Task 4: 三态主题(system / dark / light)无闪烁 + xterm / mermaid 跟随

**Files:**
- Create: `frontend/public/theme-boot.js`、`frontend/src/lib/terminalTheme.ts`
- Modify: `frontend/src/lib/theme.ts`、`frontend/index.html`、`frontend/public/manifest.json`、`frontend/src/components/TerminalView.tsx`(仅 THEMES 与主题 effect)、`frontend/src/components/markdown/MermaidBlock.tsx`、`frontend/src/components/markdown/cache.ts`(若需按主题分 key)、`frontend/src/App.tsx`(仅 `themeCtx` 传参)、`frontend/src/components/Sidebar.tsx`(仅 Settings 主题项)
- Test: `frontend/src/lib/__tests__/theme.test.ts`(新建)、`frontend/src/lib/__tests__/terminalTheme.test.ts`(新建)、`frontend/src/components/markdown/__tests__/MermaidBlock.test.tsx`(追加)

**Interfaces:**
- Consumes: T3 的 `--surface-0`、`--term-fg`、`--accent`、`--term-selection`、`--ansi-0..15`。
- Produces:
  ```ts
  // lib/theme.ts
  export type ThemePref = 'system' | 'dark' | 'light'
  export type Theme = 'dark' | 'light'           // resolved (unchanged name, existing importers keep compiling)
  export function resolveTheme(pref: ThemePref, systemLight: boolean): Theme
  export function applyResolvedTheme(t: Theme): void   // sync: <html>.light + style.colorScheme
  export function useTheme(): { pref: ThemePref; theme: Theme; setPref(p: ThemePref): void; toggle(): void }
  // lib/terminalTheme.ts
  export function readTerminalTheme(): import('@xterm/xterm').ITheme
  ```
  `useTheme().theme` 仍是解析后的 `'dark' | 'light'`(App/TerminalView/Sidebar 现有用法不变);`toggle()` 在 dark ↔ light 间切换并把 pref 设为具体值。

**时序要点(CTO 评审)**:`applyResolvedTheme` 必须在 `setPref` 与 media 回调里**同步**调用,早于 `setState`;这样子组件(TerminalView)在随后渲染的 effect 里 `getComputedStyle` 读到的已是新主题变量。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/theme.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { resolveTheme, applyResolvedTheme, useTheme } from '../theme'

function mockSystem(light: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = []
  const mq = { matches: light, addEventListener: (_: string, f: (e: { matches: boolean }) => void) => listeners.push(f), removeEventListener: () => {} }
  vi.stubGlobal('matchMedia', (q: string) => (q.includes('prefers-color-scheme: light') ? mq : { matches: false, addEventListener() {}, removeEventListener() {} }))
  return { flip(v: boolean) { mq.matches = v; listeners.forEach(f => f({ matches: v })) } }
}

describe('theme', () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.className = ''; vi.unstubAllGlobals() })

  it('resolves system to the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
  })
  it('applyResolvedTheme sets class and color-scheme synchronously', () => {
    applyResolvedTheme('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('light')
    applyResolvedTheme('dark')
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })
  it('defaults to system and follows OS changes live', () => {
    const sys = mockSystem(false)
    const { result } = renderHook(() => useTheme())
    expect(result.current.pref).toBe('system')
    expect(result.current.theme).toBe('dark')
    act(() => sys.flip(true))
    expect(result.current.theme).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })
  it('explicit pref overrides OS and persists', () => {
    mockSystem(true)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setPref('dark'))
    expect(result.current.theme).toBe('dark')
    expect(localStorage.getItem('zeromux_theme')).toBe('dark')
  })
  it('class is applied BEFORE state commits (child effects read new vars)', () => {
    mockSystem(false)
    const { result } = renderHook(() => useTheme())
    let classAtSet = false
    act(() => { result.current.setPref('light'); classAtSet = document.documentElement.classList.contains('light') })
    expect(classAtSet).toBe(true)
  })
  it('legacy stored value keeps working', () => {
    mockSystem(false)
    localStorage.setItem('zeromux_theme', 'light')
    const { result } = renderHook(() => useTheme())
    expect(result.current.pref).toBe('light')
  })
})
```

`frontend/src/lib/__tests__/terminalTheme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readTerminalTheme } from '../terminalTheme'

describe('readTerminalTheme', () => {
  it('maps CSS variables to an xterm ITheme', () => {
    const s = document.documentElement.style
    s.setProperty('--surface-0', '#0d1117'); s.setProperty('--term-fg', '#c9d1d9')
    s.setProperty('--accent', '#58a6ff'); s.setProperty('--term-selection', '#264f78')
    for (let i = 0; i < 16; i++) s.setProperty(`--ansi-${i}`, `#0000${i.toString(16).padStart(2, '0')}`)
    const t = readTerminalTheme()
    expect(t.background).toBe('#0d1117')
    expect(t.foreground).toBe('#c9d1d9')
    expect(t.cursor).toBe('#58a6ff')
    expect(t.selectionBackground).toBe('#264f78')
    expect(t.black).toBe('#000000')
    expect(t.brightWhite).toBe('#00000f')
  })
})
```

`MermaidBlock.test.tsx` 追加(先读该文件现有 mock 方式 `grep -n "vi.mock\|initialize" src/components/markdown/__tests__/MermaidBlock.test.tsx`,沿用其 mermaid mock):

```tsx
  it('initializes mermaid with the resolved app theme', async () => {
    document.documentElement.classList.add('light')
    render(<MermaidBlock code={'graph TD; A-->B'} />)
    await waitFor(() => expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'default' })))
    document.documentElement.classList.remove('light')
  })
```

> `mermaidMock` 为该测试文件现有的 mermaid 模块 mock 对象名 —— 若命名不同,按现有名称改写;若现有 mock 不暴露 `initialize`,在其 mock 工厂里加 `initialize: vi.fn()` 并导出引用。

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/theme.test.ts src/lib/__tests__/terminalTheme.test.ts src/components/markdown/__tests__/MermaidBlock.test.tsx`
Expected: theme/terminalTheme FAIL(导出不存在);Mermaid 新用例 FAIL(`theme: 'dark'`)。

- [ ] **Step 3: 实现 `lib/theme.ts`**

```ts
import { useState, useEffect, useCallback } from 'react'

export type ThemePref = 'system' | 'dark' | 'light'
/** Resolved theme actually painted. Name kept for existing importers. */
export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'zeromux_theme'
const LIGHT_MQ = '(prefers-color-scheme: light)'

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* storage blocked */ }
  return 'system'
}

function systemLight(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(LIGHT_MQ).matches
}

export function resolveTheme(pref: ThemePref, sysLight: boolean): Theme {
  return pref === 'system' ? (sysLight ? 'light' : 'dark') : pref
}

/** Synchronous DOM write. Must run BEFORE the React state update so child
 *  effects (xterm, mermaid) that read CSS variables see the new theme. */
export function applyResolvedTheme(t: Theme) {
  const el = document.documentElement
  el.classList.toggle('light', t === 'light')
  el.style.colorScheme = t
}

export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref)
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(readPref(), systemLight()))

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia(LIGHT_MQ)
    const on = (e: { matches: boolean }) => {
      if (readPref() !== 'system') return
      const t: Theme = e.matches ? 'light' : 'dark'
      applyResolvedTheme(t)
      setTheme(t)
    }
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const setPref = useCallback((p: ThemePref) => {
    try { localStorage.setItem(STORAGE_KEY, p) } catch { /* ignore */ }
    const t = resolveTheme(p, systemLight())
    applyResolvedTheme(t)
    setPrefState(p)
    setTheme(t)
  }, [])

  const toggle = useCallback(() => setPref(theme === 'dark' ? 'light' : 'dark'), [theme, setPref])

  return { pref, theme, setPref, toggle }
}
```

- [ ] **Step 4: 首帧脚本 + index.html + manifest**

`frontend/public/theme-boot.js`:

```js
// Runs synchronously before first paint (referenced from index.html <head>).
// CSP is script-src 'self', so this cannot be inline. Mirrors lib/theme.ts.
(function () {
  var pref = 'system'
  try { pref = localStorage.getItem('zeromux_theme') || 'system' } catch (e) {}
  var light = pref === 'light' || (pref !== 'dark' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches)
  var el = document.documentElement
  if (light) el.classList.add('light')
  el.style.colorScheme = light ? 'light' : 'dark'
})()
```

`frontend/index.html`:`<head>` 中 `<meta name="viewport" …>` 之后插入 `<script src="/theme-boot.js"></script>`(**不加** `type=module` / `defer` / `async`,保证同步);把 `<meta name="theme-color" content="#f7b500" />` 替换为:

```html
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#11161d" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f6f8fa" />
```

`<html lang="en" class="h-full">` 改 `lang="zh-CN"`。`public/manifest.json`:`"theme_color"` 改 `"#11161d"`,`"background_color"`(若有)改 `"#11161d"`。

- [ ] **Step 5: `lib/terminalTheme.ts` + TerminalView 接线**

```ts
import type { ITheme } from '@xterm/xterm'

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

/** xterm theme derived from the CSS tokens of the currently applied theme
 *  (index.css). Single source for the terminal palette — replaces the
 *  hard-coded THEMES table that duplicated --ansi-*. */
export function readTerminalTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  const t: ITheme = {
    background: v('--surface-0'),
    foreground: v('--term-fg'),
    cursor: v('--accent'),
    selectionBackground: v('--term-selection'),
  }
  ANSI.forEach((k, i) => { (t as Record<string, string>)[k] = v(`--ansi-${i}`) })
  return t
}
```

`TerminalView.tsx`:删除 `const THEMES = {…}`(`:29-74`);`import { readTerminalTheme } from '../lib/terminalTheme'`;`theme: THEMES[theme]`(`:306`)改 `theme: readTerminalTheme()`;`termRef.current.options.theme = THEMES[theme]`(`:459`)改 `termRef.current.options.theme = readTerminalTheme()`(该 effect 仍依赖 `[theme]` prop,prop 由 App 在 `applyResolvedTheme` 之后才变,时序满足)。

- [ ] **Step 6: Mermaid 跟随主题**

`MermaidBlock.tsx`:

```ts
        const light = document.documentElement.classList.contains('light')
        m.initialize({ startOnLoad: false, theme: light ? 'default' : 'dark', securityLevel: 'strict' })
```

缓存 key 带主题,避免切主题后复用旧 SVG:`const key = fnv1a(code)` 改为 `const themeKey = typeof document !== 'undefined' && document.documentElement.classList.contains('light') ? 'l' : 'd'` 与 `const key = fnv1a(themeKey + code)`。主题切换后已渲染的块不会自动重渲(下次渲染或 key 变化时生效)——可接受(mermaid 块随会话内容重渲的频率足够),在报告中注明。

- [ ] **Step 7: 设置入口三态**

`Sidebar.tsx` Settings 菜单中主题按钮(`:1025-1031` 附近,`grep -n "浅色模式" src/components/Sidebar.tsx`)替换为三个选项行(S1 此时 SegmentedControl 尚未建,先用三按钮行,T12 统一换成 SegmentedControl):

```tsx
              <div className="flex items-center gap-1 px-3 py-2">
                <ThemeIcon size={14} className="shrink-0 text-[var(--fg-muted)]" />
                {(['system', 'light', 'dark'] as const).map(p => (
                  <button key={p} onClick={() => onSetThemePref(p)} aria-pressed={themePref === p}
                    className={`flex-1 px-2 py-1 rounded-md text-ui-xs ${themePref === p ? 'bg-[var(--surface-hover)] text-[var(--fg-strong)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>
                    {p === 'system' ? '跟随系统' : p === 'light' ? '浅色' : '深色'}
                  </button>
                ))}
              </div>
```

Sidebar Props 加 `themePref: ThemePref; onSetThemePref: (p: ThemePref) => void`(保留 `theme` / `onToggleTheme` 以免破坏折叠栏 `:416` 的切换按钮);App 传 `themePref={themeCtx.pref} onSetThemePref={themeCtx.setPref}`。Sidebar 测试 `setup()` 的 props 默认值补这两项(`themePref: 'dark' as const, onSetThemePref: vi.fn()`)。

- [ ] **Step 8: 运行**

Run: `cd frontend && npx vitest run src/lib/__tests__/theme.test.ts src/lib/__tests__/terminalTheme.test.ts src/components/markdown/__tests__ src/components/__tests__/Sidebar.newflow.test.tsx src/components/__tests__/TerminalView.mobileLayout.test.tsx && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npm run build 2>&1 | tail -1`
Expected: 全 PASS。

- [ ] **Step 9: 冷启动无闪烁截图(Review Focus #1)**

隔离实例上,用 `screens.mjs` 的 light 模式但**不写** `zeromux_theme`(验证 system 路径):临时运行

```bash
node -e "
const { createRequire } = require('module'); const r = createRequire('/tmp/zmx-pw/package.json'); const { chromium } = r('playwright-core');
(async () => { const b = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome' });
const c = await b.newContext({ colorScheme: 'light' }); await c.addInitScript(() => localStorage.setItem('zeromux_token','smoke'));
const p = await c.newPage(); await p.goto('http://127.0.0.1:18093/', { waitUntil: 'commit' });
console.log('first-commit light class:', await p.evaluate(() => document.documentElement.classList.contains('light')));
await p.waitForTimeout(2000); await p.screenshot({ path: '../docs/superpowers/screens/s1/t4/cold-light.png' }); await b.close() })()"
```

Expected: `first-commit light class: true`。

- [ ] **Step 10: Commit**

```bash
git add frontend/public/theme-boot.js frontend/index.html frontend/public/manifest.json frontend/src/lib/theme.ts frontend/src/lib/terminalTheme.ts frontend/src/lib/__tests__/theme.test.ts frontend/src/lib/__tests__/terminalTheme.test.ts frontend/src/components/TerminalView.tsx frontend/src/components/markdown frontend/src/App.tsx frontend/src/components/Sidebar.tsx frontend/src/components/__tests__ docs/superpowers/screens/s1/t4
git commit -m "feat(theme): system/dark/light with no first-paint flash; xterm and mermaid follow tokens"
```

---

### Task 5: 响应式 hooks + `lib/format.ts`

**Files:**
- Create: `frontend/src/lib/useMediaQuery.ts`、`frontend/src/lib/format.ts`
- Modify: `frontend/src/App.tsx:72`(仅 isMobile 来源)、`frontend/src/components/TerminalView.tsx:131-136`(仅 isTouch 来源)
- Test: `frontend/src/lib/__tests__/useMediaQuery.test.ts`、`frontend/src/lib/__tests__/format.test.ts`(新建)

**Interfaces:**
- Produces:
  ```ts
  export function useMediaQuery(query: string): boolean
  export const NARROW_MQ = '(max-width: 767px)'
  export const TOUCH_MQ = '(any-pointer: coarse)'
  export function useIsNarrow(): boolean
  export function useIsTouch(): boolean     // any-pointer:coarse OR maxTouchPoints>0 (preserves TerminalView semantics)
  // lib/format.ts
  export function formatCost(usd: number | null | undefined, precision: 'short' | 'long'): string   // '$0.42' / '$0.4213' / '' for null
  export function formatDuration(ms: number | null | undefined): string                            // '0.4s' | '12s' | '3m12s' | '1h05m' | ''
  export function formatRelative(ms: number, now: number): string                                  // '刚刚' | '3 分钟前' | '2 小时前' | '昨天' | 'M月D日'
  ```

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/useMediaQuery.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMediaQuery, useIsTouch } from '../useMediaQuery'

function stubMq(initial: Record<string, boolean>) {
  const state = { ...initial }
  const ls: Record<string, (() => void)[]> = {}
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return !!state[q] },
    addEventListener: (_: string, f: () => void) => { (ls[q] ||= []).push(f) },
    removeEventListener: (_: string, f: () => void) => { ls[q] = (ls[q] || []).filter(x => x !== f) },
  }))
  return { set(q: string, v: boolean) { state[q] = v; (ls[q] || []).forEach(f => f()) } }
}

describe('useMediaQuery', () => {
  beforeEach(() => vi.unstubAllGlobals())
  it('reflects changes live (not computed once)', () => {
    const mq = stubMq({ '(max-width: 767px)': true })
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    expect(result.current).toBe(true)
    act(() => mq.set('(max-width: 767px)', false))
    expect(result.current).toBe(false)
  })
  it('useIsTouch is true for maxTouchPoints>0 even without coarse pointer', () => {
    stubMq({})
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
    const { result } = renderHook(() => useIsTouch())
    expect(result.current).toBe(true)
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true })
  })
})
```

`frontend/src/lib/__tests__/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatCost, formatDuration, formatRelative } from '../format'

describe('format', () => {
  it('cost', () => {
    expect(formatCost(0.4213, 'short')).toBe('$0.42')
    expect(formatCost(0.4213, 'long')).toBe('$0.4213')
    expect(formatCost(0.004, 'short')).toBe('<$0.01')
    expect(formatCost(0, 'short')).toBe('$0.00')
    expect(formatCost(null, 'short')).toBe('')
    expect(formatCost(undefined, 'long')).toBe('')
  })
  it('duration', () => {
    expect(formatDuration(400)).toBe('0.4s')
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(192_000)).toBe('3m12s')
    expect(formatDuration(3_900_000)).toBe('1h05m')
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(-5)).toBe('')
  })
  it('relative', () => {
    const now = new Date('2026-09-27T12:00:00+08:00').getTime()
    expect(formatRelative(now - 20_000, now)).toBe('刚刚')
    expect(formatRelative(now - 3 * 60_000, now)).toBe('3 分钟前')
    expect(formatRelative(now - 2 * 3600_000, now)).toBe('2 小时前')
    expect(formatRelative(now - 26 * 3600_000, now)).toBe('昨天')
    expect(formatRelative(new Date('2026-09-01T09:00:00+08:00').getTime(), now)).toBe('9月1日')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/useMediaQuery.test.ts src/lib/__tests__/format.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`frontend/src/lib/useMediaQuery.ts`:

```ts
import { useSyncExternalStore } from 'react'

export const NARROW_MQ = '(max-width: 767px)'
export const TOUCH_MQ = '(any-pointer: coarse)'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia === 'undefined') return () => {}
      const mq = matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => typeof matchMedia !== 'undefined' && matchMedia(query).matches,
    () => false,
  )
}

/** Layout: phone-width viewport. Live — rotation / window resize update it (B11). */
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_MQ)
}

/** Input: touch-capable device. maxTouchPoints catches touch laptops / iPad
 *  with a trackpad, matching TerminalView's previous detection. */
export function useIsTouch(): boolean {
  const coarse = useMediaQuery(TOUCH_MQ)
  return coarse || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
}
```

`frontend/src/lib/format.ts`:

```ts
// Shared display formatting (spec R15). Lists / headers use 'short' cost,
// detail views use 'long'. Callers render numbers inside `.num`.

export function formatCost(usd: number | null | undefined, precision: 'short' | 'long'): string {
  if (usd == null || !Number.isFinite(usd)) return ''
  if (precision === 'short') return usd > 0 && usd < 0.005 ? '<$0.01' : `$${usd.toFixed(2)}`
  return `$${usd.toFixed(4)}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function formatRelative(ms: number, now: number): string {
  const d = now - ms
  if (d < 60_000) return '刚刚'
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 24 * 3600_000) return `${Math.floor(d / 3600_000)} 小时前`
  if (d < 48 * 3600_000) return '昨天'
  const t = new Date(ms)
  return `${t.getMonth() + 1}月${t.getDate()}日`
}
```

> `formatDuration(400)` 期望 `0.4s`,`formatDuration(12_000)` 期望 `12s`:`< 10s` 走一位小数,`12s` 走整数分支。`3m12s` 的秒补零为 `12`(已两位),`1h05m` 分补零。

- [ ] **Step 4: 替换判定来源(不改其余逻辑)**

`App.tsx:72`:`const isMobile = useMemo(() => window.innerWidth < 768, [])` → `const isMobile = useIsNarrow()`;加 `import { useIsNarrow } from './lib/useMediaQuery'`;若 `useMemo` 因此在 App 中不再被使用,从 import 中移除。**注意** `useState(!isMobile)`(`:73`)只在挂载时取初值——行为与之前相同(侧栏开合仍由用户控制),不追加 effect。

`TerminalView.tsx:133-136`:`const [isTouch] = useState(() => …)` → `const isTouch = useIsTouch()`;import 之。

- [ ] **Step 5: 运行**

Run: `cd frontend && npx vitest run src/lib/__tests__/useMediaQuery.test.ts src/lib/__tests__/format.test.ts src/components/__tests__/TerminalView.mobileLayout.test.tsx && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b`
Expected: 全 PASS(TerminalView 测试的 `forceTouch` stub 了 matchMedia 与 maxTouchPoints,新 hook 读取同样的信号)。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/useMediaQuery.ts frontend/src/lib/format.ts frontend/src/lib/__tests__/useMediaQuery.test.ts frontend/src/lib/__tests__/format.test.ts frontend/src/App.tsx frontend/src/components/TerminalView.tsx
git commit -m "feat(ui): live media-query hooks (fix one-shot isMobile) and shared cost/duration formatting"
```

---

### Task 6: `request<T>` + `lib/api` 按域拆分(只搬不改语义)

**Files:**
- Create: `frontend/src/lib/http.ts`、`frontend/src/lib/api/{core,sessions,git,files,vault,scheduler,push,memory,prompts,auth,search,events}.ts`
- Modify: `frontend/src/lib/api.ts`(变为聚合 re-export)
- Test: `frontend/src/lib/__tests__/http.test.ts`(新建)

**Interfaces:**
- Produces:
  ```ts
  // lib/http.ts
  export async function request<T = unknown>(path: string, init?: RequestInit & { timeoutMs?: number; parse?: 'json' | 'text' | 'none' }): Promise<T>
  ```
  - 复用 `api()` 的 header / credentials;`!res.ok` → `throw new ApiError(res.status, <body text trimmed to 300 chars> || res.statusText)`;`timeoutMs` 仅显式传入时启用 AbortController,超时抛 `ApiError(0, '请求超时')`;`parse` 默认 `'json'`,`'none'` 返回 `undefined`。
  - `lib/api.ts` 继续导出**全部现有符号**(含 `api`、`ApiError`、`isAuthError`、所有函数与类型),`import … from '../lib/api'` 与 `vi.spyOn(api, 'x')` 全部不变。

**关键约束**:本 Task **不改任何函数的错误语义**(`throw new Error(...)` 保持),只移动代码。`vi.spyOn(api, 'listDir')` 能工作的前提是组件从**聚合模块**的命名空间调用;ES 模块下 `export * from` 的 re-export 绑定对 `vi.spyOn` 可能不可写 —— **先验证**(Step 1)。

- [ ] **Step 1: 验证 `vi.spyOn` 穿透 re-export(决定拆分方式)**

创建临时文件 `src/lib/__probe_a.ts`:`export async function f() { return 1 }`;`src/lib/__probe.ts`:`export * from './__probe_a'`;`src/lib/__tests__/__probe.test.ts`:

```ts
import { it, expect, vi } from 'vitest'
import * as m from '../__probe'
it('spyOn works through export *', async () => {
  vi.spyOn(m, 'f').mockResolvedValue(2)
  expect(await m.f()).toBe(2)
})
```

Run: `cd frontend && npx vitest run src/lib/__tests__/__probe.test.ts`
- 若 PASS:用 `export * from './api/<domain>'` 方式拆分,继续 Step 2。
- 若 FAIL(`Cannot redefine property`):**不拆文件**,本 Task 只新建 `lib/http.ts` 并在 `api.ts` 内部按域加分节注释 `// ── sessions ──` 重排函数顺序(无语义变化),记录 Ruling。
删除三个 probe 文件。

- [ ] **Step 2: 写 `request` 失败测试**

`frontend/src/lib/__tests__/http.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { request } from '../http'
import { ApiError, isAuthError } from '../api'

const respond = (status: number, body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, headers }))

describe('request', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('parses json on 2xx', async () => {
    respond(200, '{"a":1}')
    expect(await request<{ a: number }>('/api/x')).toEqual({ a: 1 })
  })
  it('throws ApiError with status and body on non-2xx', async () => {
    respond(500, 'boom')
    await expect(request('/api/x')).rejects.toMatchObject({ status: 500, message: 'boom' })
  })
  it('401 is an auth error (drives logout, I-3)', async () => {
    respond(401, '')
    const e = await request('/api/x').catch(x => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(isAuthError(e)).toBe(true)
  })
  it('text and none parse modes', async () => {
    respond(200, 'hello', {})
    expect(await request('/x', { parse: 'text' })).toBe('hello')
    respond(204, '', {})
    expect(await request('/x', { parse: 'none' })).toBeUndefined()
  })
  it('no timeout unless asked', async () => {
    vi.useFakeTimers()
    let aborted = false
    vi.spyOn(globalThis, 'fetch').mockImplementation((_u, init) => new Promise((_r, rej) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; rej(new DOMException('a', 'AbortError')) })
    }))
    const p = request('/slow').catch(e => e)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(aborted).toBe(false)
    const q = request('/slow', { timeoutMs: 1000 }).catch(e => e)
    await vi.advanceTimersByTimeAsync(1001)
    expect(aborted).toBe(true)
    expect(await q).toMatchObject({ status: 0, message: '请求超时' })
    void p
  })
  it('sends auth header and same-origin credentials like api()', async () => {
    localStorage.setItem('zeromux_token', 't0k')
    const spy = respond(200, '{}')
    await request('/api/x')
    const init = spy.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer t0k')
    expect(init.credentials).toBe('same-origin')
    localStorage.removeItem('zeromux_token')
  })
})
```

> `getToken()` 的 localStorage key 以 `lib/api.ts` 实现为准(`grep -n "function getToken" -A4 src/lib/api.ts`);若 key 不是 `zeromux_token`,改测试里的 key。

- [ ] **Step 3: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/http.test.ts`
Expected: FAIL(`../http` 不存在)。

- [ ] **Step 4: 实现 `lib/http.ts`**

```ts
import { api, ApiError } from './api/core'

type Parse = 'json' | 'text' | 'none'

/** Typed fetch wrapper: every non-2xx becomes an ApiError carrying the HTTP
 *  status, so callers (and isAuthError) can tell 401/403 from 5xx/network.
 *  No default timeout (spec R9): createSession with worktree isolation (~24s),
 *  uploads and JuiceFS-backed git diffs would be killed by one. */
export async function request<T = unknown>(
  path: string,
  init: RequestInit & { timeoutMs?: number; parse?: Parse } = {},
): Promise<T> {
  const { timeoutMs, parse = 'json', ...rest } = init
  const ctl = timeoutMs ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined
  let res: Response
  try {
    res = await api(path, ctl ? { ...rest, signal: ctl.signal } : rest)
  } catch (e) {
    if (ctl?.signal.aborted) throw new ApiError(0, '请求超时')
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).trim().slice(0, 300)
    throw new ApiError(res.status, body || res.statusText)
  }
  if (parse === 'none') return undefined as T
  if (parse === 'text') return (await res.text()) as T
  return (await res.json()) as T
}
```

- [ ] **Step 5: 拆分 `api.ts`(若 Step 1 PASS)**

按现有注释分段(`grep -n "^// ──\|^// ---\|^/\*\* ─" src/lib/api.ts` 找分节;若无分节,按函数名前缀归类)把代码**原样移动**到:

| 文件 | 内容 |
|---|---|
| `api/core.ts` | `getToken`/`setToken`/`clearToken`(若存在)、`ApiError`、`isAuthError`、`api`、`wsUrl`(若存在) |
| `api/auth.ts` | `getAuthMode`、`getMe`、`logout`、`UserInfo`、`AuthMode`、`listUsers`/`approveUser`/`deleteUser` |
| `api/sessions.ts` | `SessionInfo`、`SessionType`、`HostTmux`、`listSessionsWithHost`、`listSessions`、`createSession`、`updateSession`、`renameSession`、`deleteSession`、`restoreSession`、`closeCheck`、`getSessionStatus`、`SessionStatus`、history/logs/runs |
| `api/git.ts` | `getGitLog`、`getGitShow`、`getGitWorktree`、相关类型 |
| `api/files.ts` | `listDir`、`listDirectories`、`DirListing`、`DirListEntry`、upload/mkdir/rename/delete/raw |
| `api/vault.ts` | `getVaultMeta`、`listVault`、`readVaultNote`、`resolveWikiLink` |
| `api/search.ts` | `searchPaths`、`warmSearchIndex`、`SearchResult`、`DirHit`、`NoteHit`、quick targets |
| `api/scheduler.ts` | scheduled tasks、runs、confirmations、scheduler health、`ScheduleInput` |
| `api/prompts.ts` | prompt presets |
| `api/memory.ts` | crew memory |
| `api/events.ts` | agent events、run metrics |
| `api/push.ts` | 仅在 `api.ts` 中存在 push 相关函数时 |

每个域文件顶部 `import { api, ApiError } from './core'`(按需);跨域类型引用用 `import type`。`lib/api.ts` 最终内容:

```ts
// Aggregated API surface. Domain modules live in ./api/*; this file keeps the
// historical import path (`../lib/api`) and the `vi.spyOn(api, …)` namespace.
export * from './api/core'
export * from './api/auth'
export * from './api/sessions'
export * from './api/git'
export * from './api/files'
export * from './api/vault'
export * from './api/search'
export * from './api/scheduler'
export * from './api/prompts'
export * from './api/memory'
export * from './api/events'
```

`lib/http.ts` 从 `./api/core` 导入(避免与聚合模块循环)。

**验收拆分完整性**:

```bash
cd frontend && git show HEAD:frontend/src/lib/api.ts | grep -oE "^export (async function|function|class|interface|type|const) \w+" | awk '{print $NF}' | sort > /tmp/before.txt
cat src/lib/api/*.ts | grep -oE "^export (async function|function|class|interface|type|const) \w+" | awk '{print $NF}' | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "exports identical"
```

Expected: `exports identical`。

- [ ] **Step 6: 运行**

Run: `cd frontend && npx vitest run src/lib/__tests__/http.test.ts && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npx eslint src/lib`
Expected: 全 PASS;测试数与 T5 后一致 +6。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib
git commit -m "refactor(api): add typed request<T> and split api.ts by domain (no behaviour change)"
```

---

### Task 7: 数据层 hooks —— `useLatestRequest` / `useAsyncResource` / `usePolling`

**Files:**
- Create: `frontend/src/lib/useLatestRequest.ts`、`frontend/src/lib/useAsyncResource.ts`、`frontend/src/lib/usePolling.ts`
- Test: `frontend/src/lib/__tests__/useLatestRequest.test.ts`、`useAsyncResource.test.ts`、`usePolling.test.ts`(新建)

**Interfaces:**
- Produces:
  ```ts
  export function useLatestRequest(): { begin(): number; isCurrent(token: number): boolean; bump(): void }
  export function useAsyncResource<T>(key: string | null, fetcher: () => Promise<T>): {
    data: T | undefined; loading: boolean; error: unknown; reload(): void; setData(updater: (prev: T | undefined) => T | undefined): void
  }
  export function usePolling(fn: () => void | Promise<void>, intervalMs: number, opts?: { enabled?: boolean; immediate?: boolean }): void
  ```
  语义(spec §3.4、I-8):
  - `useAsyncResource`:`key` 变化 → **render 期同步**清 `data`、`loading=true`、`error=undefined`,然后请求;`reload()` **不清 data**(`loading` 置 true,旧数据仍显示);`setData` 先 `bump()` 使在途请求作废,再同步更新(乐观写);过期响应一律丢弃;`key === null` 不请求,`data=undefined, loading=false`;`fetcher` 用 ref 保存最新引用(调用方无需 memo)。
  - `usePolling`:`enabled`(默认 true)为 false 或 `document.visibilityState === 'hidden'` 时不跑;从 hidden 变回 visible 立即跑一次再按间隔;`immediate`(默认 true)挂载即跑一次;上一次 `fn` 返回的 Promise 未结束时跳过本轮(防堆积)。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/useLatestRequest.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLatestRequest } from '../useLatestRequest'

describe('useLatestRequest', () => {
  it('only the latest begin() is current', () => {
    const { result } = renderHook(() => useLatestRequest())
    const a = result.current.begin()
    const b = result.current.begin()
    expect(result.current.isCurrent(a)).toBe(false)
    expect(result.current.isCurrent(b)).toBe(true)
  })
  it('bump() invalidates in-flight requests (optimistic write guard)', () => {
    const { result } = renderHook(() => useLatestRequest())
    const t = result.current.begin()
    result.current.bump()
    expect(result.current.isCurrent(t)).toBe(false)
  })
  it('is stable across renders', () => {
    const { result, rerender } = renderHook(() => useLatestRequest())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
```

`frontend/src/lib/__tests__/useAsyncResource.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAsyncResource } from '../useAsyncResource'

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

describe('useAsyncResource', () => {
  it('loads data for a key', async () => {
    const { result } = renderHook(() => useAsyncResource('k', async () => 42))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.data).toBe(42))
    expect(result.current.loading).toBe(false)
  })
  it('key change clears data synchronously (no stale rows)', async () => {
    const d2 = deferred<string>()
    const { result, rerender } = renderHook(({ k }) => useAsyncResource(k, k === 'a' ? async () => 'A' : () => d2.promise), { initialProps: { k: 'a' } })
    await waitFor(() => expect(result.current.data).toBe('A'))
    rerender({ k: 'b' })
    expect(result.current.data).toBeUndefined()
    expect(result.current.loading).toBe(true)
    await act(async () => d2.resolve('B'))
    expect(result.current.data).toBe('B')
  })
  it('reload keeps showing old data while refetching', async () => {
    let n = 0
    const d = deferred<number>()
    const { result } = renderHook(() => useAsyncResource('k', () => (n++ === 0 ? Promise.resolve(1) : d.promise)))
    await waitFor(() => expect(result.current.data).toBe(1))
    act(() => result.current.reload())
    expect(result.current.data).toBe(1)
    expect(result.current.loading).toBe(true)
    await act(async () => d.resolve(2))
    expect(result.current.data).toBe(2)
  })
  it('a slow earlier response never overwrites a newer key', async () => {
    const slowA = deferred<string>()
    const { result, rerender } = renderHook(({ k }) => useAsyncResource(k, k === 'a' ? () => slowA.promise : async () => 'B'), { initialProps: { k: 'a' } })
    rerender({ k: 'b' })
    await waitFor(() => expect(result.current.data).toBe('B'))
    await act(async () => slowA.resolve('A'))
    expect(result.current.data).toBe('B')
  })
  it('setData (optimistic) wins over an in-flight reload', async () => {
    let n = 0
    const d = deferred<string[]>()
    const { result } = renderHook(() => useAsyncResource('k', () => (n++ === 0 ? Promise.resolve(['x', 'y']) : d.promise)))
    await waitFor(() => expect(result.current.data).toEqual(['x', 'y']))
    act(() => result.current.reload())
    act(() => result.current.setData(prev => (prev ?? []).filter(v => v !== 'x')))
    await act(async () => d.resolve(['x', 'y']))  // stale snapshot from before the delete
    expect(result.current.data).toEqual(['y'])
  })
  it('null key does not fetch', () => {
    let called = false
    const { result } = renderHook(() => useAsyncResource(null, async () => { called = true; return 1 }))
    expect(called).toBe(false)
    expect(result.current.loading).toBe(false)
  })
  it('exposes errors and clears them on success', async () => {
    let fail = true
    const { result } = renderHook(() => useAsyncResource('k', async () => { if (fail) throw new Error('x'); return 1 }))
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    fail = false
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.data).toBe(1))
    expect(result.current.error).toBeUndefined()
  })
})
```

`frontend/src/lib/__tests__/usePolling.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePolling } from '../usePolling'

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('usePolling', () => {
  afterEach(() => { vi.useRealTimers(); setVisibility('visible') })

  it('runs immediately then every interval', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000))
    expect(fn).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fn).toHaveBeenCalledTimes(4)
  })
  it('pauses while hidden and fires once on return', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000))
    act(() => setVisibility('hidden'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fn).toHaveBeenCalledTimes(1)
    act(() => setVisibility('visible'))
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('disabled does nothing', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    renderHook(() => usePolling(fn, 1000, { enabled: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fn).not.toHaveBeenCalled()
  })
  it('skips a tick while the previous run is still pending', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const fn = vi.fn(() => new Promise<void>(r => { release = r }))
    renderHook(() => usePolling(fn, 1000))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fn).toHaveBeenCalledTimes(1)
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(1000) })
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/useLatestRequest.test.ts src/lib/__tests__/useAsyncResource.test.ts src/lib/__tests__/usePolling.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`frontend/src/lib/useLatestRequest.ts`:

```ts
import { useRef, useMemo } from 'react'

/** Monotonic stale-response guard (I-8). The three touch points stay explicit
 *  at the call site: begin() before the request, isCurrent(t) after every
 *  await, bump() before any optimistic setState. Deliberately no run()
 *  wrapper — it would hide the third point, which is the one that regresses. */
export function useLatestRequest() {
  const seq = useRef(0)
  return useMemo(() => ({
    begin: () => ++seq.current,
    isCurrent: (t: number) => t === seq.current,
    bump: () => { seq.current++ },
  }), [])
}
```

`frontend/src/lib/useAsyncResource.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLatestRequest } from './useLatestRequest'

/** Keyed async resource with stale-response protection.
 *  - key change: data is cleared DURING render (no stale rows under a new key, B4)
 *  - reload(): refetch without clearing (no "flash empty" after writes, fe5396b)
 *  - setData(): optimistic write; invalidates any in-flight fetch first (I-8) */
export function useAsyncResource<T>(key: string | null, fetcher: () => Promise<T>) {
  const req = useLatestRequest()
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const [data, setDataState] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(key !== null)
  const [error, setError] = useState<unknown>(undefined)
  const [tick, setTick] = useState(0)

  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setDataState(undefined)
    setError(undefined)
    setLoading(key !== null)
  }

  useEffect(() => {
    if (key === null) return
    const t = req.begin()
    fetcherRef.current().then(
      v => { if (req.isCurrent(t)) { setDataState(v); setError(undefined); setLoading(false) } },
      e => { if (req.isCurrent(t)) { setError(e); setLoading(false) } },
    )
  }, [key, tick, req])

  const reload = useCallback(() => { setLoading(true); setTick(n => n + 1) }, [])
  const setData = useCallback((updater: (prev: T | undefined) => T | undefined) => {
    req.bump()
    setDataState(updater)
    setLoading(false)
  }, [req])

  return { data, loading, error, reload, setData }
}
```

> `fetcherRef.current = fetcher` 在 render 中赋值:eslint `react-hooks` v7 可能报 `react-hooks/refs`。若报,改为 `useEffect(() => { fetcherRef.current = fetcher })`(无 deps,commit 后同步;首次 effect 运行顺序在数据 effect 之前,因为声明在前)。

`frontend/src/lib/usePolling.ts`:

```ts
import { useEffect, useRef } from 'react'

/** Interval polling that pauses while the tab is hidden and fires once on
 *  return (phones background tabs constantly). Overlapping runs are skipped. */
export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  { enabled = true, immediate = true }: { enabled?: boolean; immediate?: boolean } = {},
) {
  const fnRef = useRef(fn)
  useEffect(() => { fnRef.current = fn })

  useEffect(() => {
    if (!enabled) return
    let inFlight = false
    let timer: ReturnType<typeof setInterval> | undefined
    const run = () => {
      if (inFlight || document.visibilityState === 'hidden') return
      const r = fnRef.current()
      if (r && typeof (r as Promise<void>).finally === 'function') {
        inFlight = true
        ;(r as Promise<void>).catch(() => {}).finally(() => { inFlight = false })
      }
    }
    const start = () => { if (!timer) timer = setInterval(run, intervalMs) }
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined } }
    const onVis = () => {
      if (document.visibilityState === 'hidden') stop()
      else { run(); start() }
    }
    if (immediate) run()
    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [enabled, intervalMs, immediate])
}
```

- [ ] **Step 4: 运行**

Run: `cd frontend && npx vitest run src/lib/__tests__/useLatestRequest.test.ts src/lib/__tests__/useAsyncResource.test.ts src/lib/__tests__/usePolling.test.ts && npx eslint src/lib/useLatestRequest.ts src/lib/useAsyncResource.ts src/lib/usePolling.ts && npm test 2>&1 | grep -E "Test Files|Tests "`
Expected: 全 PASS;eslint 无报错。

- [ ] **Step 5: 验红(证明测试不是空转)**

临时把 `useAsyncResource.ts` 中 `setData` 里的 `req.bump()` 注释掉,运行 `npx vitest run src/lib/__tests__/useAsyncResource.test.ts -t "optimistic"` → Expected FAIL;恢复。再把 render 期 reset 块注释掉,运行 `-t "key change clears"` → FAIL;恢复。两次输出记入报告。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/useLatestRequest.ts frontend/src/lib/useAsyncResource.ts frontend/src/lib/usePolling.ts frontend/src/lib/__tests__/useLatestRequest.test.ts frontend/src/lib/__tests__/useAsyncResource.test.ts frontend/src/lib/__tests__/usePolling.test.ts
git commit -m "feat(data): useLatestRequest, useAsyncResource and visibility-aware usePolling"
```

---
### Task 8: 迁移 S1 负责的 stale-guard 站点 + 轮询

**Files:**
- Modify: `frontend/src/lib/usePromptPresets.ts:30`、`frontend/src/components/QuickTargets.tsx:39`、`frontend/src/components/MemoryPanel.tsx:23`、`frontend/src/components/RunMetricsPanel.tsx:64`、`frontend/src/components/AgentDashboard.tsx:46,68-71`、`frontend/src/components/Sidebar.tsx`(仅调度健康 60s 轮询,`grep -n "getSchedulerHealth" -B2 -A10`)、`frontend/src/components/WaitingPage.tsx:14-24`
- Test: 既有 `lib/__tests__/usePromptPresets.test.ts`、`components/__tests__/QuickTargets.test.tsx`、`RunMetricsPanel.stale.test.tsx`、`AgentDashboard.stale.test.tsx`;新建 `components/__tests__/MemoryPanel.stale.test.tsx`、`components/__tests__/WaitingPage.test.tsx`

**Interfaces:**
- Consumes: T7 `useLatestRequest()`、`usePolling(fn, ms, opts)`;T6 `request<T>`。

**迁移规则**:这 5 处的 loading / error / 乐观写形状各不相同,**一律迁到 `useLatestRequest`**(一一对应替换,行为逐字节不变),**不**改用 `useAsyncResource`(那会改变 loading 与 error 的呈现时机)。对应关系:

| 旧 | 新 |
|---|---|
| `const reqRef = useRef(0)` | `const req = useLatestRequest()` |
| `const r = ++reqRef.current` / `const myReq = ++reqRef.current` | `const r = req.begin()` |
| `if (reqRef.current !== r) return` / `if (myReq !== reqRef.current) return` | `if (!req.isCurrent(r)) return` |
| `if (reqRef.current === r) setX(…)` | `if (req.isCurrent(r)) setX(…)` |
| `reqRef.current++`(乐观写前) | `req.bump()` |

`useCallback` 的依赖数组中加入 `req`(稳定对象,不引起额外重建)。**保留所有既有注释**(它们解释为什么需要守卫)。

- [ ] **Step 1: 为 MemoryPanel 补 stale 测试(当前无测试保护)**

`frontend/src/components/__tests__/MemoryPanel.stale.test.tsx`:

```tsx
import { render, screen, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import MemoryPanel from '../MemoryPanel'
import * as api from '../../lib/api'
import type { CrewMemory } from '../../lib/api'

const mem = (keys: string[]): CrewMemory => ({
  preferences: '', projects: '', lessons: [], gateway_ok: true,
  semantic: keys.map(k => ({ key: k, value: 'v', source: 'user_explicit', confidence: 1 })),
} as unknown as CrewMemory)

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

describe('MemoryPanel stale guard', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('a slow earlier load cannot resurrect a row removed afterwards', async () => {
    const slow = deferred<CrewMemory>()
    const get = vi.spyOn(api, 'getCrewMemory')
      .mockResolvedValueOnce(mem(['pref.a', 'pref.b']))   // mount
      .mockImplementationOnce(() => slow.promise)          // a refresh in flight
      .mockResolvedValue(mem(['pref.b']))                  // after delete
    vi.spyOn(api, 'deleteCrewSemantic').mockResolvedValue(undefined as never)
    render(<MemoryPanel onClose={() => {}} />)
    expect(await screen.findByText(/pref\.a/)).toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(1)
  })
})
```

> 已核实 api 名:`getCrewMemory`(`api.ts:342`)、`deleteCrewSemantic(key)`(`:357`)、`putCrewMemoryDoc`(`:363`)。MemoryPanel 的 props 与 DOM 需按实际文件对齐: `sed -n 1,100p src/components/MemoryPanel.tsx` 读出真实函数名、props、删除交互(二段确认:点 ✕ → 「确认移除」)。**测试必须覆盖的场景**(写不出就报 NEEDS_CONTEXT,不要写空测):① 挂载加载列表;② 触发一次会在途的 reload(若组件无手动刷新入口,用「写入后 reload」路径:写入 → 写入成功触发的 reload 被 `slow` 挂起);③ 在 slow 在途期间完成一次删除(乐观移除);④ `slow.resolve(含已删行的旧快照)`;⑤ 断言已删行**不**复活。先在**当前代码**上跑确认 PASS(证明测试描述的是现有正确行为),再注释掉 `MemoryPanel.tsx` 中删除路径的 `reqRef.current++` 确认 FAIL,恢复。

- [ ] **Step 2: 逐站点迁移,每处「验红 → 迁移 → 变绿」**

对下表每一行按顺序执行:(a) 在**迁移前**注释掉该文件中的一个守卫(列出的那一处),运行对应测试 → 必须 FAIL;(b) 恢复;(c) 按上面对应关系迁移;(d) 运行对应测试 → PASS;(e) 迁移后再注释掉**新代码**中同一守卫(`req.bump()` 或 `isCurrent` 检查)→ 必须 FAIL;(f) 恢复。(a) 与 (e) 的失败输出各摘一行记入报告。

| # | 文件 | 验红时注释的守卫 | 测试 |
|---|---|---|---|
| 1 | `lib/usePromptPresets.ts` | reload 中 `if (myReq !== reqRef.current) return`(第一个) | `lib/__tests__/usePromptPresets.test.ts` |
| 2 | `components/QuickTargets.tsx` | `forget` 中 `reqRef.current++` | `components/__tests__/QuickTargets.test.tsx` |
| 3 | `components/MemoryPanel.tsx` | 删除路径的 `reqRef.current++` | `MemoryPanel.stale.test.tsx`(Step 1) |
| 4 | `components/RunMetricsPanel.tsx` | `setVerdict` 中 `reqRef.current++` | `RunMetricsPanel.stale.test.tsx` |
| 5 | `components/AgentDashboard.tsx` | `loadEvents` 中 `if (reqRef.current !== req) return` | `AgentDashboard.stale.test.tsx` |

若某行 (a) 注释守卫后测试**仍 PASS**(测试空转),停止该行迁移,先修测试使其能验红(参考记忆:三点时序缺一即退化 —— 需要「慢请求在途 → 乐观写 / 新请求 → 慢请求后到」完整序列),再继续。

- [ ] **Step 3: 轮询迁到 `usePolling`**

`AgentDashboard.tsx:68-71`:

```tsx
  // Auto-refresh every 10s (paused while the tab is hidden).
  usePolling(loadEvents, 10_000, { immediate: false })
```

(挂载加载仍由 `useEffect(() => { loadEvents() }, [loadEvents])` 负责,因此 `immediate: false`。)

`Sidebar.tsx` 调度健康轮询:把 `useEffect(() => { … setInterval(…, 60000) … }, …)` 整块替换为

```tsx
  const pollSchedulerHealth = useCallback(async () => {
    try { setSchedulerHealthy((await getSchedulerHealth()).healthy) } catch { /* ignore */ }
  }, [])
  usePolling(pollSchedulerHealth, 60_000)
```

> 替换 `Sidebar.tsx:129-141` 的 `useEffect(() => { let cancelled = false … setInterval(check, 60_000) … }, [])` 整块(已核实原文;state setter 名为 `setSchedulerHealthy`)。`cancelled` 标志删除:卸载后 `usePolling` 不再调度;在途请求 resolve 后对已卸载组件 setState 为 no-op。

`WaitingPage.tsx:14-24`:5s 轮询改为 `usePolling`,并把裸 `fetch('/api/me')` 改为 `request<UserInfo>('/api/me')`(B12);原来「status === 'active' → onApproved()」的判断保持。补测试 `WaitingPage.test.tsx`:mock `fetch` 先返回 `{status:'pending'}` 再返回 `{status:'active'}`,fake timers 推进 5s,断言 `onApproved` 被调用一次;以及页面 hidden 时推进 20s 不发请求。

- [ ] **Step 4: 运行**

Run: `cd frontend && npx vitest run src/lib/__tests__/usePromptPresets.test.ts src/components/__tests__/QuickTargets.test.tsx src/components/__tests__/MemoryPanel.stale.test.tsx src/components/__tests__/RunMetricsPanel.stale.test.tsx src/components/__tests__/AgentDashboard.stale.test.tsx src/components/__tests__/WaitingPage.test.tsx src/components/__tests__/Sidebar.newflow.test.tsx && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npx eslint src/lib/usePromptPresets.ts src/components/QuickTargets.tsx src/components/MemoryPanel.tsx src/components/RunMetricsPanel.tsx src/components/AgentDashboard.tsx src/components/WaitingPage.tsx`
Expected: 全 PASS;eslint 无新增。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/usePromptPresets.ts frontend/src/components/QuickTargets.tsx frontend/src/components/MemoryPanel.tsx frontend/src/components/RunMetricsPanel.tsx frontend/src/components/AgentDashboard.tsx frontend/src/components/Sidebar.tsx frontend/src/components/WaitingPage.tsx frontend/src/components/__tests__/MemoryPanel.stale.test.tsx frontend/src/components/__tests__/WaitingPage.test.tsx
git commit -m "refactor(data): migrate S1-owned stale guards to useLatestRequest; visibility-aware polling"
```

---

### Task 9: 合并重复 —— `useDirBrowser` 与 `usePathSearch`

**Files:**
- Create: `frontend/src/lib/useDirBrowser.ts`、`frontend/src/lib/usePathSearch.ts`
- Modify: `frontend/src/components/DirectoryPicker.tsx:16-48`、`frontend/src/components/Sidebar.tsx:94-215`(目录浏览 + 搜索状态)、`frontend/src/components/VaultReader.tsx:33-64`(仅搜索)
- Test: `frontend/src/lib/__tests__/useDirBrowser.test.ts`、`usePathSearch.test.ts`(新建);既有 `DirectoryPicker.stale.test.tsx`、`Sidebar.newflow.test.tsx`、`Sidebar.search.test.tsx`、`VaultReader.test.tsx`

**Interfaces:**
- Consumes: T7 `useLatestRequest`;`listDirectories(path?)`、`searchPaths(q, scope, limit?)`(现有 api)。
- Produces:
  ```ts
  export function useDirBrowser(): {
    currentPath: string; parentPath: string | null; homePath: string; dirs: DirEntry[]
    loading: boolean; error: string | null
    load(path?: string): Promise<void>; retry(): void; reset(): void
  }
  export function usePathSearch(query: string, opts: { scope: string; limit?: number; debounceMs: number; enabled?: boolean; requeryWhile: (r: SearchResult) => boolean }): {
    result: SearchResult | null; resultQuery: string; failed: boolean; retry(): void
  }
  ```
  - `useDirBrowser.error`:超时(`AbortError`)→ `'加载超时，请重试'`;其他 `Error` → `e.message`;非 Error → `'加载失败'`(与 Sidebar 现有文案一致;DirectoryPicker 原文案 `'无法加载目录'` 改为同一套 —— 统一文案是本 Task 的有意变化)。
  - `usePathSearch`:`query.trim()` 为空 → `result=null, failed=false`,不请求;防抖 `debounceMs`;每次请求 `begin()`;响应若 `requeryWhile(r)` 为真,4s 后以同一 query 重查(仍受 `isCurrent` 约束);`enabled=false` 时不请求且不清空。Sidebar 的 `requeryWhile` = 现有 `pending(r.dirs) || !!r.notes?.indexing`;VaultReader = `!!r.notes?.indexing`。

- [ ] **Step 1: 写 hook 失败测试**

`frontend/src/lib/__tests__/useDirBrowser.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDirBrowser } from '../useDirBrowser'
import * as api from '../api'

function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const listing = (current: string) => ({ current, parent: '/h', home: '/h', entries: [{ name: 'x', path: current + '/x' }] })

describe('useDirBrowser', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('a slower earlier listing never overwrites a newer one', async () => {
    const slow = deferred<ReturnType<typeof listing>>()
    vi.spyOn(api, 'listDirectories').mockImplementationOnce(() => slow.promise as never).mockResolvedValueOnce(listing('/h/b') as never)
    const { result } = renderHook(() => useDirBrowser())
    act(() => { void result.current.load('/h/a') })
    await act(async () => { await result.current.load('/h/b') })
    await act(async () => slow.resolve(listing('/h/a')))
    expect(result.current.currentPath).toBe('/h/b')
  })
  it('reset() drops state and an in-flight listing cannot repopulate it', async () => {
    const slow = deferred<ReturnType<typeof listing>>()
    vi.spyOn(api, 'listDirectories').mockImplementationOnce(() => slow.promise as never)
    const { result } = renderHook(() => useDirBrowser())
    act(() => { void result.current.load('/h/a') })
    act(() => result.current.reset())
    await act(async () => slow.resolve(listing('/h/a')))
    expect(result.current.currentPath).toBe('')
    expect(result.current.loading).toBe(false)
  })
  it('timeout surfaces a retryable message', async () => {
    vi.spyOn(api, 'listDirectories').mockRejectedValueOnce(new DOMException('x', 'AbortError')).mockResolvedValueOnce(listing('/h') as never)
    const { result } = renderHook(() => useDirBrowser())
    await act(async () => { await result.current.load('/h') })
    expect(result.current.error).toBe('加载超时，请重试')
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.currentPath).toBe('/h'))
    expect(result.current.error).toBeNull()
  })
})
```

`frontend/src/lib/__tests__/usePathSearch.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePathSearch } from '../usePathSearch'
import * as api from '../api'

const res = (indexing: boolean) => ({ dirs: null, notes: { indexing, refreshing: false, items: [] } })

describe('usePathSearch', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
  it('debounces and ignores empty queries', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, 'searchPaths').mockResolvedValue(res(false) as never)
    const { rerender } = renderHook(({ q }) => usePathSearch(q, { scope: 'notes', debounceMs: 200, requeryWhile: r => !!r.notes?.indexing }), { initialProps: { q: '' } })
    rerender({ q: 'a' }); rerender({ q: 'ab' })
    await act(async () => { await vi.advanceTimersByTimeAsync(199) })
    expect(spy).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('ab', 'notes', undefined)
  })
  it('re-queries every 4s while indexing, stops when superseded', async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, 'searchPaths').mockResolvedValue(res(true) as never)
    const { rerender } = renderHook(({ q }) => usePathSearch(q, { scope: 'notes', debounceMs: 0, requeryWhile: r => !!r.notes?.indexing }), { initialProps: { q: 'a' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(spy).toHaveBeenCalledTimes(2)
    rerender({ q: '' })
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/useDirBrowser.test.ts src/lib/__tests__/usePathSearch.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现两个 hook**

`frontend/src/lib/useDirBrowser.ts`:

```ts
import { useCallback, useRef, useState } from 'react'
import { listDirectories } from './api'
import type { DirEntry } from './api'
import { useLatestRequest } from './useLatestRequest'

/** Directory browser state shared by the New Session flow and DirectoryPicker.
 *  Out-of-order guard matters: currentPath is what gets committed as a
 *  session's / scheduled task's work_dir, and JuiceFS listings take seconds. */
export function useDirBrowser() {
  const req = useLatestRequest()
  const lastPath = useRef<string | undefined>(undefined)
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [homePath, setHomePath] = useState('')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (path?: string) => {
    const t = req.begin()
    lastPath.current = path
    setLoading(true)
    setError(null)
    try {
      const data = await listDirectories(path)
      if (!req.isCurrent(t)) return
      setCurrentPath(data.current)
      setParentPath(data.parent)
      setHomePath(data.home)
      setDirs(data.entries)
    } catch (e) {
      if (!req.isCurrent(t)) return
      setError(e instanceof DOMException && e.name === 'AbortError'
        ? '加载超时，请重试'
        : (e instanceof Error ? e.message : '加载失败'))
    }
    if (req.isCurrent(t)) setLoading(false)
  }, [req])

  const retry = useCallback(() => { void load(lastPath.current) }, [load])

  /** Forget the previous browse location (New Session reopens clean) and
   *  invalidate any in-flight listing so it can't repopulate afterwards. */
  const reset = useCallback(() => {
    req.bump()
    lastPath.current = undefined
    setCurrentPath(''); setParentPath(null); setDirs([]); setError(null); setLoading(false)
  }, [req])

  return { currentPath, parentPath, homePath, dirs, loading, error, load, retry, reset }
}
```

> `DirEntry` 类型名以 api 实际导出为准(`grep -n "DirEntry\b" src/lib/api*.ts src/lib/api/*.ts`)。

`frontend/src/lib/usePathSearch.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'
import { searchPaths } from './api'
import type { SearchResult } from './api'
import { useLatestRequest } from './useLatestRequest'

const REQUERY_MS = 4000

/** Debounced fuzzy path search with the "index still building → re-query in
 *  4s" behaviour. Shared by the New Session search, VaultReader and (S2) ⌘K. */
export function usePathSearch(
  query: string,
  { scope, limit, debounceMs, enabled = true, requeryWhile }: {
    scope: string; limit?: number; debounceMs: number; enabled?: boolean; requeryWhile: (r: SearchResult) => boolean
  },
) {
  const req = useLatestRequest()
  const [result, setResult] = useState<SearchResult | null>(null)
  const [resultQuery, setResultQuery] = useState('')
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let again: ReturnType<typeof setTimeout> | undefined
    const run = (q: string) => {
      const t = req.begin()
      if (!q.trim()) { setResult(null); setFailed(false); return }
      searchPaths(q, scope, limit)
        .then(r => {
          if (!req.isCurrent(t)) return
          setResult(r); setResultQuery(q); setFailed(false)
          if (requeryWhile(r)) again = setTimeout(() => { if (req.isCurrent(t)) run(q) }, REQUERY_MS)
        })
        .catch(() => { if (req.isCurrent(t)) { setResult(null); setFailed(true) } })
    }
    const d = setTimeout(() => run(query), debounceMs)
    return () => { clearTimeout(d); if (again) clearTimeout(again) }
    // requeryWhile is a predicate; callers pass a stable module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, limit, debounceMs, enabled, tick, req])

  const retry = useCallback(() => setTick(n => n + 1), [])
  return { result, resultQuery, failed, retry }
}
```

> 调用方的 `requeryWhile` 必须定义在**模块级**(非组件内箭头函数),否则虽不会死循环(不在 deps 中),但语义上应稳定 —— 在 Step 4 按此写。

- [ ] **Step 4: 迁移三个调用方**

- `DirectoryPicker.tsx`:删 `currentPath/parentPath/homePath/dirs/loading/error` 六个 state、`dirReqRef` 与 `loadDirs`,改为 `const b = useDirBrowser()`,`useEffect(() => { b.load(initialPath || undefined) }, [b.load, initialPath])`,JSX 中 `currentPath` → `b.currentPath` 等;原「重试」若无则不加(保持现状)。**保留**原注释中关于 work_dir 提交的说明(移到 `useDirBrowser` 顶部注释已覆盖,删去重复)。
- `Sidebar.tsx`:删 `:147-186` 对应 state 与 `loadDirs`、`lastDirPath`、`dirReqRef`,改 `const dir = useDirBrowser()`;所有 `loadDirs(x)` → `dir.load(x)`,`loadDirs(lastDirPath.current)` → `dir.retry()`,`currentPath` → `dir.currentPath`,`setCurrentPath('')`(`openTypePicker` 中)→ **保留语义**:该处是「清空上次浏览路径」,新 hook 无 setter —— 调 `dir.reset()`(已在上面 hook 中定义)。搜索:删 `searchResult/searchResultQuery/searchFailed/searchReqRef/runSearch` 与 150ms effect,改

  ```tsx
  const search = usePathSearch(query, {
    scope: vaultEnabled ? 'dirs,notes' : 'dirs', debounceMs: 150, enabled: step === 'quick', requeryWhile: sidebarRequery,
  })
  ```
  模块级 `const sidebarRequery = (r: SearchResult) => { const pending = (s: { indexing: boolean; refreshing: boolean; items: unknown[] } | null) => !!s && (s.indexing || (s.refreshing && s.items.length === 0)); return pending(r.dirs) || !!r.notes?.indexing }`。`setSearchResult(null)`(`openTypePicker` 中)→ 由 `setQuery('')` 自然清空(空 query 分支 `setResult(null)`),删除该调用。**不动** `creatingRef` / `runCreate` / `creating` 与步骤状态机。
- `VaultReader.tsx`:删 `searchReqRef` 与搜索 effect(`:46-64`),改 `const s = usePathSearch(query, { scope: 'notes', limit: 50, debounceMs: 200, requeryWhile: vaultRequery })`,模块级 `const vaultRequery = (r: SearchResult) => !!r.notes?.indexing`;`retryTick` 驱动的重试改调 `s.retry()`。`openReqRef`(打开笔记)**不动**(S1 不迁;属于 VaultReader 自有的打开守卫,与搜索无关 —— 若想迁也只能 1:1 换 `useLatestRequest`,本 Task 不做)。

- [ ] **Step 5: 运行**

Run: `cd frontend && npx vitest run src/lib/__tests__/useDirBrowser.test.ts src/lib/__tests__/usePathSearch.test.ts src/components/__tests__/DirectoryPicker.stale.test.tsx src/components/__tests__/Sidebar.newflow.test.tsx src/components/__tests__/Sidebar.search.test.tsx src/components/__tests__/VaultReader.test.tsx src/components/__tests__/SearchResults.test.tsx && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npx eslint src/lib/useDirBrowser.ts src/lib/usePathSearch.ts src/components/DirectoryPicker.tsx src/components/Sidebar.tsx src/components/VaultReader.tsx`
Expected: 全 PASS;若 `DirectoryPicker` 原测试断言 `'无法加载目录'` 文案,改为新文案(这是有意统一,记入报告)。

- [ ] **Step 6: 验红**

注释 `useDirBrowser.ts` 的第一个 `if (!req.isCurrent(t)) return` → `DirectoryPicker.stale.test.tsx` 与 `useDirBrowser.test.ts` 必须 FAIL;恢复。注释 `usePathSearch.ts` 的 `if (!req.isCurrent(t)) return` → `Sidebar.search.test.tsx` 或 `usePathSearch.test.ts` 至少一个 FAIL;若都 PASS,在 `usePathSearch.test.ts` 补「慢的旧 query 响应后到不覆盖新 query 结果」用例使之可验红。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/useDirBrowser.ts frontend/src/lib/usePathSearch.ts frontend/src/lib/__tests__/useDirBrowser.test.ts frontend/src/lib/__tests__/usePathSearch.test.ts frontend/src/components/DirectoryPicker.tsx frontend/src/components/Sidebar.tsx frontend/src/components/VaultReader.tsx frontend/src/components/__tests__
git commit -m "refactor(ui): one directory browser and one path search (dedupe Sidebar/DirectoryPicker/VaultReader)"
```

---

### Task 10: Primitives ①:Dialog / Sheet / confirm / promptText / toast

**Files:**
- Create: `frontend/src/components/ui/Dialog.tsx`、`Sheet.tsx`、`dialogs.tsx`(confirm / promptText)、`toast.tsx`(队列 + `<Toaster/>`)、`index.ts`
- Modify: `frontend/src/App.tsx`(仅:挂 `<Toaster/>`、`<DialogHost/>`;undo / fail toast 改 `toast.push`)、删除 `frontend/src/components/Toast.tsx` 与 `__tests__/Toast.test.tsx`(被新测试取代)
- Test: `frontend/src/components/ui/__tests__/Dialog.test.tsx`、`Sheet.test.tsx`、`dialogs.test.tsx`、`toast.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export function Dialog(p: { open: boolean; onClose(): void; title?: string; children: ReactNode; className?: string; labelledBy?: string }): JSX.Element | null
  export function Sheet(p: { open: boolean; onClose(): void; side: 'bottom' | 'right' | 'full'; title?: string; actions?: ReactNode; snap?: 'half' | 'full'; children: ReactNode }): JSX.Element | null
  export function DialogHost(): JSX.Element            // mount once in App; renders confirm()/promptText() requests
  export function confirm(o: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean>
  export function promptText(o: { title: string; initial?: string; placeholder?: string; confirmLabel?: string }): Promise<string | null>
  export const toast: { push(t: { message: string; action?: { label: string; onClick(): void | Promise<void> }; durationMs?: number; key?: string }): string; dismiss(id: string): void }
  export function Toaster(): JSX.Element               // mount once in App
  ```
  - `Dialog`/`Sheet` 用原生 `<dialog>`:`open` 变 true → `if (!el.open) el.showModal()`;变 false → `el.close()`;`cancel` 事件(Esc)→ `preventDefault()` + `onClose()`;点击 `<dialog>` 自身(backdrop 区域,`e.target === el`)→ `onClose()`;关闭后焦点回到打开前的 `document.activeElement`。
  - `Sheet side="bottom"`:两档 `snap`(默认 `'half'`);软键盘弹出(`visualViewport.height < innerHeight - 120`)时强制 full 并以 `visualViewport.height` 为高度;把手区域 pointer 拖动:位移 > 30% 高度或速度 > 0.5px/ms → `onClose()`;内容区 `scrollTop > 0` 时不响应拖动。**Sheet 嵌套**:模块级计数,已有打开的 Sheet 时再打开一个 → dev 下 `console.error('Sheet inside Sheet is not allowed')`(仍渲染,不抛)。
  - `toast`:同 `key` 覆盖旧条;同屏最多 3 条(超出丢弃最旧);默认 `durationMs = 3000`;带 `action` 时 pointerdown 暂停计时、pointerup 恢复;点击 action → 执行后关闭。

- [ ] **Step 1: 写失败测试**

`frontend/src/components/ui/__tests__/Dialog.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { Dialog } from '../Dialog'

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (<>
    <button onClick={() => setOpen(true)}>open</button>
    <Dialog open={open} onClose={() => { setOpen(false); onClose() }} title="标题"><button>inside</button></Dialog>
  </>)
}

describe('Dialog', () => {
  it('opens as a modal and exposes an accessible name', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('open'))
    const d = screen.getByRole('dialog', { hidden: true })
    expect((d as HTMLDialogElement).open).toBe(true)
    expect(d).toHaveAccessibleName('标题')
  })
  it('Esc (cancel event) closes via onClose', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByText('open'))
    fireEvent(screen.getByRole('dialog', { hidden: true }), new Event('cancel', { cancelable: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('backdrop click closes, inner click does not', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByText('inside'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog', { hidden: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('restores focus to the opener on close', () => {
    render(<Harness />)
    const opener = screen.getByText('open')
    opener.focus()
    fireEvent.click(opener)
    fireEvent(screen.getByRole('dialog', { hidden: true }), new Event('cancel', { cancelable: true }))
    expect(document.activeElement).toBe(opener)
  })
  it('StrictMode double effects do not throw on showModal', async () => {
    const { StrictMode } = await import('react')
    render(<StrictMode><Dialog open onClose={() => {}}>x</Dialog></StrictMode>)
    expect((screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement).open).toBe(true)
  })
})
```

`frontend/src/components/ui/__tests__/Sheet.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Sheet } from '../Sheet'

describe('Sheet', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('full sheet stays full-viewport even under a relative ancestor (top-layer)', () => {
    render(<div style={{ position: 'relative', width: 224 }}><Sheet open side="full" onClose={() => {}} title="定时任务">x</Sheet></div>)
    const d = screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement
    expect(d.open).toBe(true)
    expect(d.dataset.side).toBe('full')
    expect(d.className).toMatch(/\binset-0\b|\bw-screen\b|\bmax-w-none\b/)
  })
  it('bottom sheet adopts visualViewport height when the keyboard is open', () => {
    vi.stubGlobal('visualViewport', { height: 400, offsetTop: 0, addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('innerHeight', 844)
    render(<Sheet open side="bottom" onClose={() => {}}><input /></Sheet>)
    const d = screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement
    expect(d.dataset.snap).toBe('full')
    expect(d.style.height).toBe('400px')
  })
  it('warns on Sheet-in-Sheet', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Sheet open side="bottom" onClose={() => {}}><Sheet open side="bottom" onClose={() => {}}>inner</Sheet></Sheet>)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Sheet inside Sheet'))
    err.mockRestore()
  })
})
```

`frontend/src/components/ui/__tests__/dialogs.test.tsx`:

```tsx
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DialogHost, confirm, promptText } from '../dialogs'

describe('confirm / promptText', () => {
  it('confirm resolves true on confirm, false on cancel', async () => {
    render(<DialogHost />)
    let p!: Promise<boolean>
    act(() => { p = confirm({ title: '删除？', confirmLabel: '删除', danger: true }) })
    fireEvent.click(await screen.findByText('删除'))
    expect(await p).toBe(true)
    act(() => { p = confirm({ title: '再删？' }) })
    fireEvent.click(await screen.findByText('取消'))
    expect(await p).toBe(false)
  })
  it('promptText returns trimmed text or null', async () => {
    render(<DialogHost />)
    let p!: Promise<string | null>
    act(() => { p = promptText({ title: '重命名为', initial: 'a.txt' }) })
    const input = await screen.findByDisplayValue('a.txt')
    expect(input).toHaveClass('text-ui-input')
    fireEvent.change(input, { target: { value: '  b.txt ' } })
    fireEvent.click(screen.getByText('确定'))
    expect(await p).toBe('b.txt')
    act(() => { p = promptText({ title: 'x' }) })
    fireEvent(screen.getByRole('dialog', { hidden: true }), new Event('cancel', { cancelable: true }))
    expect(await p).toBeNull()
  })
})
```

`frontend/src/components/ui/__tests__/toast.test.tsx`:

```tsx
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Toaster, toast } from '../toast'

describe('toast', () => {
  afterEach(() => { vi.useRealTimers(); act(() => { document.querySelectorAll('[data-toast-id]').forEach(el => toast.dismiss(el.getAttribute('data-toast-id')!)) }) })
  it('auto-dismisses after duration', async () => {
    vi.useFakeTimers()
    render(<Toaster />)
    act(() => { toast.push({ message: 'hello', durationMs: 1000 }) })
    expect(screen.getByText('hello')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1001) })
    expect(screen.queryByText('hello')).toBeNull()
  })
  it('same key replaces; at most 3 on screen', () => {
    render(<Toaster />)
    act(() => { toast.push({ message: 'a', key: 'k' }); toast.push({ message: 'b', key: 'k' }) })
    expect(screen.queryByText('a')).toBeNull()
    act(() => { ['1', '2', '3', '4'].forEach(m => toast.push({ message: m })) })
    expect(screen.queryByText('b')).toBeNull()
    expect(screen.queryByText('1')).toBeNull()
    expect(screen.getByText('4')).toBeInTheDocument()
  })
  it('action runs then dismisses', async () => {
    render(<Toaster />)
    const onClick = vi.fn()
    act(() => { toast.push({ message: '已关闭 api', action: { label: '撤销', onClick } }) })
    await act(async () => { fireEvent.click(screen.getByText('撤销')) })
    expect(onClick).toHaveBeenCalled()
    expect(screen.queryByText('已关闭 api')).toBeNull()
  })
  it('undo + failure toasts coexist (Review Focus #5)', () => {
    render(<Toaster />)
    act(() => { toast.push({ message: '已关闭 api', action: { label: '撤销', onClick() {} }, durationMs: 4500 }); toast.push({ message: '创建会话失败' }) })
    expect(screen.getByText('已关闭 api')).toBeInTheDocument()
    expect(screen.getByText('创建会话失败')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/ui/__tests__`
Expected: FAIL(模块不存在)。happy-dom 15 已实测支持 `HTMLDialogElement.showModal`;若 `open` 属性或 `cancel` 事件行为不符,在 `src/test/setup.ts` 中补最小 polyfill(`showModal(){ this.setAttribute('open','') }`、`close(){ this.removeAttribute('open'); this.dispatchEvent(new Event('close')) }`),并在报告中说明。

- [ ] **Step 3: 实现 Dialog**

`frontend/src/components/ui/Dialog.tsx`:

```tsx
import { useEffect, useId, useRef, type ReactNode, type MouseEvent } from 'react'

/** Native <dialog> modal. Lives in the browser top layer, so ancestors'
 *  `contain: paint` / overflow / z-index can't clip or reorder it (replaces
 *  the "full-screen only because no positioned ancestor" panels, audit §4.2). */
export function Dialog({ open, onClose, title, children, className = '', labelledBy }: {
  open: boolean; onClose: () => void; title?: string; children: ReactNode; className?: string; labelledBy?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  const titleId = useId()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) {
      opener.current = document.activeElement
      el.showModal()
    } else if (!open && el.open) {
      el.close()
      ;(opener.current as HTMLElement | null)?.focus?.()
    }
  }, [open])

  useEffect(() => () => { (opener.current as HTMLElement | null)?.focus?.() }, [])

  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => { if (e.target === e.currentTarget) onClose() }

  if (!open) return null
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
      onCancel={e => { e.preventDefault(); onClose() }}
      onClick={onBackdrop}
      className={`bg-transparent p-0 m-auto backdrop:bg-black/50 ${className}`}
    >
      <div className="bg-[var(--surface-2)] text-[var(--fg)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-overlay)] w-[min(480px,calc(100vw-24px))]">
        {title && <h2 id={titleId} className="px-4 pt-4 text-ui-lg font-semibold text-[var(--fg-strong)]">{title}</h2>}
        {children}
      </div>
    </dialog>
  )
}
```

> `onClick={onBackdrop}` 与 `onCancel` 放在 `<dialog>` 上:eslint `jsx-a11y` 未启用,无额外告警。`return null` 放在 hooks 之后,满足 hooks 规则;`open` false 时不渲染 DOM,因此上面「close + 还原焦点」分支在卸载 cleanup 中完成(第二个 effect)。

- [ ] **Step 4: 实现 Sheet**

`frontend/src/components/ui/Sheet.tsx`:

```tsx
import { useEffect, useId, useRef, useState, type ReactNode, type PointerEvent } from 'react'

let openSheets = 0
const KEYBOARD_PX = 120

function keyboardHeight(): number | null {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return null
  return window.innerHeight - vv.height > KEYBOARD_PX ? vv.height : null
}

/** Panel / drawer on a native modal <dialog>. bottom: two snap points, drag
 *  the handle down to dismiss, full height while the soft keyboard is up so
 *  focused inputs aren't covered. Only one Sheet may be open at a time. */
export function Sheet({ open, onClose, side, title, actions, snap = 'half', children }: {
  open: boolean; onClose: () => void; side: 'bottom' | 'right' | 'full'; title?: string; actions?: ReactNode; snap?: 'half' | 'full'; children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const titleId = useId()
  const [kb, setKb] = useState<number | null>(() => (side === 'bottom' ? keyboardHeight() : null))
  const drag = useRef<{ y: number; t: number } | null>(null)
  const [dy, setDy] = useState(0)

  useEffect(() => {
    if (!open) return
    if (openSheets > 0 && import.meta.env.DEV) console.error('Sheet inside Sheet is not allowed')
    openSheets++
    const el = ref.current
    opener.current = document.activeElement
    if (el && !el.open) el.showModal()
    return () => {
      openSheets--
      if (el?.open) el.close()
      ;(opener.current as HTMLElement | null)?.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (!open || side !== 'bottom' || !window.visualViewport) return
    const vv = window.visualViewport
    const on = () => setKb(keyboardHeight())
    vv.addEventListener('resize', on)
    return () => vv.removeEventListener('resize', on)
  }, [open, side])

  if (!open) return null

  const effSnap = side === 'bottom' && kb != null ? 'full' : snap
  const height = side === 'bottom' ? (kb != null ? `${kb}px` : effSnap === 'full' ? 'calc(100dvh - env(safe-area-inset-top) - 8px)' : '50dvh') : undefined

  const onDown = (e: PointerEvent) => {
    if ((bodyRef.current?.scrollTop ?? 0) > 0) return
    drag.current = { y: e.clientY, t: performance.now() }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: PointerEvent) => { if (drag.current) setDy(Math.max(0, e.clientY - drag.current.y)) }
  const onUp = (e: PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const dist = Math.max(0, e.clientY - d.y)
    const v = dist / Math.max(1, performance.now() - d.t)
    const h = ref.current?.getBoundingClientRect().height ?? 1
    setDy(0)
    if (dist > h * 0.3 || v > 0.5) onClose()
  }

  const base = 'p-0 m-0 max-w-none max-h-none bg-[var(--surface-1)] text-[var(--fg)] backdrop:bg-black/50'
  const bySide = {
    full: 'inset-0 w-screen h-[100dvh]',
    right: 'ml-auto mr-0 h-[100dvh] w-[360px] border-l border-[var(--border)]',
    bottom: 'mt-auto mb-0 w-screen rounded-t-[var(--radius-sheet)] border-t border-[var(--border)] shadow-[var(--shadow-overlay)]',
  }[side]

  return (
    <dialog
      ref={ref}
      data-side={side}
      data-snap={effSnap}
      aria-labelledby={title ? titleId : undefined}
      onCancel={e => { e.preventDefault(); onClose() }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{ height, transform: dy ? `translateY(${dy}px)` : undefined, transition: dy ? 'none' : 'transform var(--dur-base) var(--ease-out)' }}
      className={`${base} ${bySide} flex flex-col`}
    >
      {side === 'bottom' && (
        <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} className="flex justify-center py-2 touch-none cursor-grab" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-[var(--border)]" />
        </div>
      )}
      {(title || actions) && (
        <header className="flex items-center gap-2 px-4 min-h-[var(--row-h)] border-b border-[var(--border-subtle)]">
          {title && <h2 id={titleId} className="flex-1 text-ui-lg font-semibold text-[var(--fg-strong)] truncate">{title}</h2>}
          {actions}
        </header>
      )}
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        {children}
      </div>
    </dialog>
  )
}
```

> 嵌套检测放在 `open` effect 内(父 Sheet 的 effect 先执行完才会轮到子 Sheet?—— React 子 effect **先于**父 effect 执行,导致检测反向)。若测试「warns on Sheet-in-Sheet」因顺序而不触发,改为在两个 effect 中任一方检测到 `openSheets > 0` 时报错(即:谁后打开谁报),测试只断言「被调用过」。

- [ ] **Step 5: 实现 dialogs(confirm / promptText)与 toast**

`frontend/src/components/ui/dialogs.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Dialog } from './Dialog'

type Req =
  | { kind: 'confirm'; title: string; body?: string; confirmLabel: string; cancelLabel: string; danger: boolean; resolve(v: boolean): void }
  | { kind: 'prompt'; title: string; initial: string; placeholder?: string; confirmLabel: string; resolve(v: string | null): void }

let push: ((r: Req) => void) | null = null
const pending: Req[] = []

/** Promise-based replacements for window.confirm / window.prompt (bad on
 *  mobile, unstyled, and block the event loop). DialogHost renders them. */
export function confirm(o: { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise(resolve => {
    const r: Req = { kind: 'confirm', title: o.title, body: o.body, confirmLabel: o.confirmLabel ?? '确定', cancelLabel: o.cancelLabel ?? '取消', danger: !!o.danger, resolve }
    if (push) push(r); else pending.push(r)
  })
}
export function promptText(o: { title: string; initial?: string; placeholder?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise(resolve => {
    const r: Req = { kind: 'prompt', title: o.title, initial: o.initial ?? '', placeholder: o.placeholder, confirmLabel: o.confirmLabel ?? '确定', resolve }
    if (push) push(r); else pending.push(r)
  })
}

export function DialogHost() {
  const [queue, setQueue] = useState<Req[]>(() => pending.splice(0))
  const [text, setText] = useState('')
  useEffect(() => {
    push = r => setQueue(q => [...q, r])
    return () => { push = null }
  }, [])
  const cur = queue[0]
  useEffect(() => { if (cur?.kind === 'prompt') setText(cur.initial) }, [cur])
  const done = (v: boolean | string | null) => {
    if (!cur) return
    if (cur.kind === 'confirm') cur.resolve(v === true)
    else cur.resolve(typeof v === 'string' ? (v.trim() || null) : null)
    setQueue(q => q.slice(1))
  }
  const btn = 'ctl px-3 rounded-[var(--radius-md)] text-ui-sm'
  return (
    <Dialog open={!!cur} onClose={() => done(cur?.kind === 'confirm' ? false : null)} title={cur?.title}>
      {cur && (
        <form className="p-4 pt-2 space-y-3" onSubmit={e => { e.preventDefault(); done(cur.kind === 'confirm' ? true : text) }}>
          {cur.kind === 'confirm' && cur.body && <p className="text-ui-sm text-[var(--fg-muted)] whitespace-pre-wrap">{cur.body}</p>}
          {cur.kind === 'prompt' && (
            <input autoFocus value={text} placeholder={cur.placeholder} onChange={e => setText(e.target.value)}
              className="w-full px-3 py-2 text-ui-input bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--radius-md)] outline-none focus:border-[var(--accent)]" />
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => done(cur.kind === 'confirm' ? false : null)} className={`${btn} text-[var(--fg-muted)] hover:bg-[var(--surface-hover)]`}>
              {cur.kind === 'confirm' ? cur.cancelLabel : '取消'}
            </button>
            <button type="submit" className={`${btn} ${cur.kind === 'confirm' && cur.danger ? 'text-[var(--danger)] border border-[var(--danger)]' : 'bg-[var(--accent)] text-[var(--on-accent)]'}`}>
              {cur.confirmLabel}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
```

> `useEffect(() => { if (cur?.kind === 'prompt') setText(cur.initial) }, [cur])` 可能触发 eslint `react-hooks/set-state-in-effect`。若触发,改为 render 期按 `cur` 身份重置(与 FileBrowser B4 同一模式:`const [shown, setShown] = useState(cur); if (shown !== cur) { setShown(cur); if (cur?.kind === 'prompt') setText(cur.initial) }`)。

`frontend/src/components/ui/toast.tsx`:

```tsx
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

type Item = { id: string; message: string; action?: { label: string; onClick(): void | Promise<void> }; durationMs: number; key?: string }
const MAX = 3
let items: Item[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
let seq = 0

export const toast = {
  push(t: { message: string; action?: Item['action']; durationMs?: number; key?: string }): string {
    const id = `t${++seq}`
    const it: Item = { id, message: t.message, action: t.action, durationMs: t.durationMs ?? 3000, key: t.key }
    items = [...items.filter(x => !(t.key && x.key === t.key)), it].slice(-MAX)
    emit()
    return id
  },
  dismiss(id: string) { items = items.filter(x => x.id !== id); emit() },
}

function ToastRow({ it }: { it: Item }) {
  const left = useRef(it.durationMs)
  const started = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = () => { started.current = Date.now(); timer.current = setTimeout(() => toast.dismiss(it.id), left.current) }
  const pause = () => { clearTimeout(timer.current); left.current -= Date.now() - started.current }
  useEffect(() => { start(); return () => clearTimeout(timer.current) }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div role="status" data-toast-id={it.id}
      onPointerDown={it.action ? pause : undefined} onPointerUp={it.action ? start : undefined}
      className="pointer-events-auto flex items-center gap-3 px-4 min-h-[var(--row-h)] rounded-[var(--radius-md)] bg-[var(--surface-3)] border border-[var(--border)] shadow-[var(--shadow-overlay)] text-ui-sm text-[var(--fg)]">
      <span className="flex-1">{it.message}</span>
      {it.action && (
        <button className="font-medium text-[var(--accent)]" onClick={async () => { await it.action!.onClick(); toast.dismiss(it.id) }}>{it.action.label}</button>
      )}
    </div>
  )
}

/** Toast stack. Desktop bottom-right; phone bottom-centre above the safe area. */
export function Toaster() {
  const list = useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => items, () => items)
  const [, force] = useState(0)
  useEffect(() => { force(n => n + 1) }, [])
  return (
    <div className="fixed z-toast pointer-events-none flex flex-col gap-2 left-1/2 -translate-x-1/2 md:left-auto md:translate-x-0 md:right-4 w-[min(420px,calc(100vw-24px))]"
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
      {list.map(it => <ToastRow key={it.id} it={it} />)}
    </div>
  )
}
```

> `force` 用于 happy-dom 下首次订阅前已 push 的条目也能渲染;若 eslint `set-state-in-effect` 报错,删去这两行并在测试中先 `render(<Toaster/>)` 再 push(测试已如此),即可。**`md:` 断点**:这是全仓第一个 `md:` 用法,属预期(spec §3.2)。

`frontend/src/components/ui/index.ts`:

```ts
export { Dialog } from './Dialog'
export { Sheet } from './Sheet'
export { DialogHost, confirm, promptText } from './dialogs'
export { Toaster, toast } from './toast'
```

- [ ] **Step 6: App 接线(I-18 不变)**

`App.tsx`:
- import `{ Toaster, DialogHost, toast } from './components/ui'`,删 `import Toast from './components/Toast'`。
- 删 `undoToast` / `failToast` 两个 state。`handleDelete` 中 `setUndoToast({ id, name: s.name, durationMs })` 改为:

  ```tsx
      toast.push({
        key: `undo-${id}`,
        message: `已关闭 ${s.name}`,
        durationMs,
        action: {
          label: '撤销',
          onClick: async () => {
            if (await restoreSession(id)) { await loadSessions(); setActiveId(id) }
            else toast.push({ message: '撤销失败，会话已关闭' })
          },
        },
      })
  ```
  `durationMs` 计算式(`Math.max(1000, (r.pending_until ?? 0) - Date.now() - 500) || 4500`)**原样保留**。所有 `setFailToast('…')` 改为 `toast.push({ message: '…' })`。
- `App.tsx:322` `window.confirm(msg)` 改为 `await confirm({ title: msg, confirmLabel: '关闭', danger: true })`(`handleDelete` 已是 async);import `confirm` from `./components/ui`。**这是 App.tsx 中唯一一处逻辑改动,闭包依赖不变。**
- JSX 末尾(`</main>` 前,原两个 `<Toast>` 位置)替换为 `<Toaster /><DialogHost />`。
- 删除 `components/Toast.tsx` 与 `components/__tests__/Toast.test.tsx`(`grep -rn "components/Toast\|from './Toast'\|from '../Toast'" src` 确认零引用)。

- [ ] **Step 7: 运行**

Run: `cd frontend && npx vitest run src/components/ui/__tests__ && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npx eslint src/components/ui src/App.tsx && node scripts/lint-tokens.mjs`
Expected: 全 PASS;棘轮 `nativeDialog` 下降 1 —— 按提示把 baseline 中 `nativeDialog` 减 1 并一并提交。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ui frontend/src/App.tsx frontend/scripts/lint-tokens.baseline.json
git rm frontend/src/components/Toast.tsx frontend/src/components/__tests__/Toast.test.tsx
git commit -m "feat(ui): native-dialog Dialog/Sheet, promise confirm/prompt, toast queue; App uses them (I-18 timing unchanged)"
```

---

### Task 11: 把三个全屏面板 + PromptManager 迁入 Sheet;push 修复

**Files:**
- Modify: `frontend/src/components/AdminPanel.tsx`、`ScheduledTasksPanel.tsx`、`PushSettings.tsx`、`PromptManager.tsx`(仅容器与 token 化)、`frontend/src/components/Sidebar.tsx`(删 `:498-504` 面板挂载与 `showAdmin/showScheduled/showPushSettings/showPromptManager` state;改为回调)、`frontend/src/App.tsx`(挂载面板)、`frontend/src/lib/push.ts`
- Test: `components/__tests__/PushSettings.test.tsx`(追加)、`ScheduledTasksPanel.test.tsx`(追加 B2)、`components/__tests__/AdminPanel.test.tsx`(新建)、`lib/__tests__/push.test.ts`(追加)

**Interfaces:**
- Consumes: T10 `Sheet`、`confirm`、`toast`;T6 `request<T>`;T3 token。
- Produces: 四个面板的 Props 变为 `{ open: boolean; onClose(): void }`(自带 `<Sheet side="full">`;PromptManager 仍是内容组件,由调用方包 `<Sheet side="bottom">`)。Sidebar Props 新增 `onOpenPanel: (p: 'admin' | 'scheduled' | 'push' | 'prompts') => void`,删除内部四个 show* state。App 新增 `const [panel, setPanel] = useState<null | 'admin' | 'scheduled' | 'push' | 'prompts'>(null)`。

- [ ] **Step 1: 写失败测试**

`lib/__tests__/push.test.ts` 追加(Review Focus #4):

```ts
  it('enablePush does not mark enabled when subscribe fails', async () => {
    localStorage.removeItem('zmx_push_enabled')
    vi.stubGlobal('Notification', { requestPermission: async () => 'granted', permission: 'granted' })
    const sub = { toJSON: () => ({ endpoint: 'https://p.example/x', keys: { p256dh: 'a', auth: 'b' } }), unsubscribe: vi.fn(async () => true) }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: { subscribe: async () => sub } }) } })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"key":"AAAA"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(enablePush()).rejects.toMatchObject({ status: 500 })
    expect(localStorage.getItem('zmx_push_enabled')).toBeNull()
    expect(sub.unsubscribe).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
```

> 若 `push.test.ts` 顶部未 import `enablePush` / `vi`,补上。

`PushSettings.test.tsx` 追加:

```tsx
  it('toggle failure shows a toast and keeps the switch off', async () => {
    vi.spyOn(push, 'getPushState').mockResolvedValue('disabled')
    vi.spyOn(push, 'enablePush').mockRejectedValue(new Error('subscribe failed'))
    render(<><Toaster /><PushSettings open onClose={() => {}} /></>)
    fireEvent.click(await screen.findByRole('switch'))
    expect(await screen.findByText(/开启失败/)).toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })
```

> 现有 PushSettings 开关若不是 `role="switch"`,本 Task 顺带改为 `<button role="switch" aria-checked={state==='enabled'}>`(可访问性改进,记入报告);`push` 为 `import * as push from '../../lib/push'`。

`ScheduledTasksPanel.test.tsx` 追加 B2(编辑时回填调度类型):

```tsx
  it('editing a daily 07:30 task pre-fills 每天 07:30, not cron 09:00 (B2)', async () => {
    const t = { id: 't', owner_id: 'u', name: 'n', trigger_type: 'cron', trigger_spec: '0 30 7 * * *', tz: 'Asia/Shanghai', agent_type: 'claude', work_dir: '/w', prompt: 'p', enabled: true, retention_n: 20, created_ms: 1, side_effects: false, max_runtime_min: null, idle_timeout_min: null }
    // render the form directly (exported TaskForm) or via the panel's ✎ button
    render(<TaskForm task={t} onCancel={() => {}} onSaved={() => {}} />)
    expect((screen.getByDisplayValue('每天') as HTMLSelectElement).value).toBe('daily')
    expect(screen.getByDisplayValue('7')).toBeInTheDocument()
    expect(screen.getByDisplayValue('30')).toBeInTheDocument()
  })
```

> `TaskForm` 当前未导出:本 Task 加 `export`。该文件顶部已有模块级 `vi.mock('../../lib/api', …)`(`ScheduledTasksPanel.test.tsx:28`),新用例放在该 mock 生效的 describe 中即可。select 的 option 文案以实际为准(`grep -n "<option" src/components/ScheduledTasksPanel.tsx`)。

`AdminPanel.test.tsx`(新建):

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import AdminPanel from '../AdminPanel'
import * as api from '../../lib/api'

describe('AdminPanel', () => {
  it('renders in a full-screen Sheet and lists users', async () => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([{ id: 'u1', login: 'alice', role: 'user', status: 'pending', avatar: null }] as never)
    render(<AdminPanel open onClose={() => {}} />)
    const d = screen.getByRole('dialog', { hidden: true })
    expect(d.dataset.side).toBe('full')
    expect(await screen.findByText('alice')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/push.test.ts src/components/__tests__/PushSettings.test.tsx src/components/__tests__/ScheduledTasksPanel.test.tsx src/components/__tests__/AdminPanel.test.tsx`
Expected: FAIL(`enablePush` 在 500 时仍 resolve 并写入;面板无 `open` prop;B2 回填为 cron)。

- [ ] **Step 3: push 修复(R10)**

`lib/push.ts` 的 `enablePush`:

```ts
export async function enablePush(): Promise<void> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return
  const reg = await navigator.serviceWorker.ready
  const { key } = await request<{ key: string }>('/api/push/vapid-key')
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyToUint8Array(key),
  })
  const j = sub.toJSON()
  try {
    await request('/api/push/subscribe', {
      method: 'POST', parse: 'none',
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, levels: getLevels() }),
    })
  } catch (e) {
    // Server never stored it: drop the browser subscription too, so local state
    // and server agree (previously a 500 still marked push as enabled).
    await sub.unsubscribe().catch(() => {})
    throw e
  }
  localStorage.setItem(ENABLED_KEY, '1')
}
```

`disablePush` 的 unsubscribe 请求、`sendTestPush` 改用 `request(..., { method: 'POST', parse: 'none' })`;`resyncPush` 保持 `.catch(() => {})`(后台自愈,失败静默是有意的)。`import { request } from './http'`,删除不再使用的 `api` import(若仍有使用则保留)。

`PushSettings.tsx` 的 `toggle`:

```tsx
    try {
      if (state === 'enabled') await disablePush()
      else await enablePush()
    } catch (e) {
      toast.push({ message: `${state === 'enabled' ? '关闭' : '开启'}失败:${e instanceof Error ? e.message : '未知错误'}` })
    } finally {
      setState(await getPushState().catch(() => state))
      setBusy(false)
    }
```

- [ ] **Step 4: 面板迁入 Sheet(统一模式)**

四个组件统一改为(以 AdminPanel 为例):

```tsx
export default function AdminPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  // …existing state/effects unchanged…
  return (
    <Sheet open={open} side="full" onClose={onClose} title="用户管理">
      {/* existing body, minus the old header row and its X button */}
    </Sheet>
  )
}
```

- 删除各面板自带的 `absolute inset-0 …` 根容器与「图标 + 标题 + X」头部(Sheet 提供标题;关闭 = Esc / 手机返回手势 / Sheet 的 actions 区放一个 `IconButton`?—— T12 才有 IconButton;本 Task 在 `actions` 放一个 `<button aria-label="关闭" onClick={onClose}><X size={18}/></button>`,T12 统一替换)。
- 面板内的数据加载 effect 在 `open` 为 false 时不应运行:由于 `Sheet` 在 `!open` 时 `return null`,但**面板组件本身**仍挂载 → 把「挂载即加载」的 effect 依赖加上 `open` 并在 `!open` 时 return(或由 App 仅在 `panel === 'x'` 时渲染该面板 —— **采用后者**,更简单:App `{panel === 'admin' && <AdminPanel open onClose={…} />}`,面板内部 effect 不改)。
- AdminPanel / ScheduledTasksPanel / ConfirmationQueue 的 `load` 加 `useLatestRequest` 守卫(审计列为无守卫,R11 第 8 项);ScheduledTasksPanel 删除确认改 `await confirm({ title: \`删除定时任务「${t.name}」？\`, confirmLabel: '删除', danger: true })`。
- **B2**:`TaskForm` 初始化从 `task.trigger_spec` 反解:新增纯函数(同文件导出,单测覆盖)

  ```ts
  export function parseCronToForm(spec: string): { kind: Kind; hour: number; minute: number; weekdays: number[] } | null {
    // 6-field seconds-first cron as produced by buildSchedule: "0 M H * * *" or "0 M H * * D,D"
    const f = spec.trim().split(/\s+/)
    if (f.length !== 6 || f[0] !== '0' || f[3] !== '*' || f[4] !== '*') return null
    const minute = Number(f[1]), hour = Number(f[2])
    if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null
    if (f[5] === '*') return { kind: 'daily', hour, minute, weekdays: [1, 2, 3, 4, 5] }
    const days = f[5].split(',').map(Number)
    if (days.some(d => !Number.isInteger(d) || d < 0 || d > 7)) return null
    return { kind: 'weekly', hour, minute, weekdays: days.map(d => (d === 7 ? 0 : d)) }
  }
  ```
  `useState` 初值:`const parsed = task ? parseCronToForm(task.trigger_spec) : null`;`kind` = `parsed?.kind ?? (task ? 'cron' : 'daily')`,`hour/minute/weekdays` 同理回退到现默认。已核实后端 `schedule_to_cron`(`src/scheduled_tasks.rs:95-103`):Daily → `"0 {m} {h} * * *"`,Weekly → `"0 {m} {h} * * 1,2,3,4,5"`(逗号列表),与上面解析器一致。单测(`ScheduledTasksPanel.test.tsx` 新增 `describe('parseCronToForm')`):`'0 30 7 * * *'` → daily 7:30;`'0 0 9 * * 1,2,3,4,5'` → weekly [1..5] 9:00;`'0 0 9 * * 0,6'` → weekly [0,6];`'0 */5 * * * *'` → null;`'0 0 9 1 * *'` → null。**文案顺带修正**:`<option value="weekly">每工作日</option>`(`:437`)实为任意星期组合(审计 §3.9)→ 改为「每周」。
- PromptManager:内容组件不变(仅 token 化字号/颜色);Sidebar Settings 与新建流程 `pick-prompt` 步里的两处 PromptManager 弹层都改为调用方包 `<Sheet side="bottom" title="管理常用 prompt">`。**不删**入口(入口收敛由 S2/S3 按 spec v2 执行,S1 只换容器)。
- Sidebar:删四个 show* state 与 `:498-504` 挂载;Settings 菜单项与 Clock 按钮改调 `onOpenPanel('push' | 'prompts' | 'admin' | 'scheduled')`;App 渲染四个面板(PromptManager 用 `usePromptPresets()` 在 App 层提供,或在 App 包一个 `PromptsSheet` 小组件内部调用 hook —— **采用后者**,新建 `components/PromptsSheet.tsx`,~20 行)。
- 这四个文件与 PromptManager 内的 `text-[8-11px]` 与调色板直用全部迁到 `text-ui-*` / 语义色(字号映射:`text-[10px]`/`text-[11px]` → `text-ui-2xs`(仅标签、计数、时间)或 `text-ui-xs`(正文性质);`text-xs` → `text-ui-xs`;`text-sm` → `text-ui-sm`)。

- [ ] **Step 5: 运行**

Run: `cd frontend && npx vitest run src/lib/__tests__/push.test.ts src/components/__tests__ && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && node scripts/lint-tokens.mjs --files | grep -E "AdminPanel|ScheduledTasksPanel|PushSettings|PromptManager|PromptsSheet" ; node scripts/lint-tokens.mjs`
Expected: 测试全 PASS;`--files` 输出中这五个文件**不出现**(零违规);棘轮各类下降 —— 按提示下调 baseline。

- [ ] **Step 6: 截图**

隔离实例:打开 Settings → 推送 / 定时任务 / 用户管理(legacy 模式无 admin,跳过)/ prompt 管理,`screens.mjs` 之外手动用 playwright 点击截图(或在 `screens.mjs` 增加 `--click <text>` 选项:`await p.getByText(text).click()` 后截图,支持多次),存 `docs/superpowers/screens/s1/t11/`,m/d × dark/light。

- [ ] **Step 7: Commit**

```bash
git add frontend/src frontend/scripts docs/superpowers/screens/s1/t11
git commit -m "feat(ui): panels move to full-screen Sheets mounted at App; fix push enable on subscribe failure; B2 schedule prefill"
```

---

### Task 12: Primitives ②:Popover / Menu / IconButton / Tooltip / Kbd / Badge / SegmentedControl / Skeleton;替换 Sidebar 手写遮罩

**Files:**
- Create: `frontend/src/components/ui/{Popover,Menu,IconButton,Tooltip,Kbd,Badge,SegmentedControl,Skeleton}.tsx`,更新 `ui/index.ts`
- Modify: `frontend/index.html`(`<div id="overlay-root">`)、`frontend/src/components/Sidebar.tsx`(Settings 菜单、主题三态 → SegmentedControl、新建弹层遮罩)、`frontend/src/components/SessionRowMenu.tsx`、`QuickTargets.tsx`、`SearchResults.tsx`(行内操作 → Menu)、T11 面板的关闭按钮 → IconButton
- Test: `frontend/src/components/ui/__tests__/{Popover,Menu,IconButton,SegmentedControl}.test.tsx`;既有 `SessionRowMenu.test.tsx`、`QuickTargets.test.tsx`、`SearchResults.test.tsx`、`Sidebar.*.test.tsx`

**Interfaces:**
- Consumes: T10 `Sheet`;T5 `useIsNarrow`。
- Produces:
  ```tsx
  export function Popover(p: { open: boolean; onClose(): void; anchor: HTMLElement | null; placement?: 'top' | 'bottom'; align?: 'start' | 'end'; children: ReactNode; sheetTitle?: string }): JSX.Element | null
  export type MenuItem = { label: string; icon?: LucideIcon; danger?: boolean; kbd?: string; disabled?: boolean; onSelect(): void }
  export function Menu(p: { open: boolean; onClose(): void; anchor: HTMLElement | null; items: MenuItem[]; title?: string }): JSX.Element | null
  export function IconButton(p: { label: string; icon: LucideIcon; onClick?(e): void; active?: boolean; danger?: boolean; size?: 'sm' | 'md'; className?: string } & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element
  export function Tooltip(p: { label: string; children: ReactElement }): JSX.Element
  export function Kbd(p: { children: ReactNode }): JSX.Element
  export function Badge(p: { count?: number; tone?: 'attention' | 'danger'; dot?: boolean }): JSX.Element | null
  export function SegmentedControl<T extends string>(p: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string }): JSX.Element
  export function Skeleton(p: { rows?: number }): JSX.Element
  ```
  - `Popover`:宽屏在 `#overlay-root`(`createPortal`)中 `position: fixed`,根据 `anchor.getBoundingClientRect()` 与 `visualViewport` 计算;空间不足翻转;`pointerdown`(capture,`document`)在浮层与 anchor 之外 → `onClose`;`Esc` → `onClose` 并把焦点还给 anchor。**窄屏(`useIsNarrow()`)改渲染 `<Sheet side="bottom" title={sheetTitle}>`**(R13)。
  - `Menu`:基于 Popover;`role="menu"` / `menuitem`;↑↓ 循环、Home/End、首字母跳转、Enter/Space 选择后 `onClose`;打开时焦点在第一项。
  - `IconButton`:`aria-label={label}`;桌面包 `Tooltip`;命中区 `min-w/min-h = var(--hit)`,视觉 28/36(`size`)。
  - `Tooltip`:仅 `matchMedia('(hover: hover)')` 为真时渲染,500ms 延迟,`role="tooltip"`。
  - `SegmentedControl`:`role="radiogroup"` + `aria-label`;每项 `role="radio" aria-checked`;←→ 切换。

- [ ] **Step 1: 写失败测试**

`ui/__tests__/Popover.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useRef, useState } from 'react'
import { Popover } from '../Popover'

function H({ narrow = false }: { narrow?: boolean }) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: narrow && q.includes('max-width'), addEventListener() {}, removeEventListener() {} }))
  const a = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(true)
  return (<><button ref={a}>anchor</button><button>outside</button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={a.current} sheetTitle="操作"><button>item</button></Popover></>)
}

describe('Popover', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('portals into #overlay-root (never inside .xterm-container / .vault-reading-surface)', () => {
    const root = document.createElement('div'); root.id = 'overlay-root'; document.body.appendChild(root)
    render(<div className="xterm-container"><H /></div>)
    expect(root.contains(screen.getByText('item'))).toBe(true)
    root.remove()
  })
  it('closes on outside pointerdown and Esc', () => {
    render(<H />)
    fireEvent.pointerDown(screen.getByText('outside'))
    expect(screen.queryByText('item')).toBeNull()
  })
  it('narrow viewport renders as a bottom Sheet', () => {
    render(<H narrow />)
    const d = screen.getByRole('dialog', { hidden: true })
    expect(d.dataset.side).toBe('bottom')
  })
})
```

`ui/__tests__/Menu.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Menu } from '../Menu'

describe('Menu', () => {
  it('keyboard: arrows move, Enter selects and closes; danger styled', () => {
    const a = document.createElement('button'); document.body.appendChild(a)
    const rename = vi.fn(), del = vi.fn(), onClose = vi.fn()
    render(<Menu open anchor={a} onClose={onClose} items={[{ label: '重命名', onSelect: rename }, { label: '删除', danger: true, onSelect: del }]} />)
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'Enter' })
    expect(del).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
    expect(items[1].className).toMatch(/danger/)
  })
  it('first-letter jump', () => {
    const a = document.createElement('button'); document.body.appendChild(a)
    render(<Menu open anchor={a} onClose={() => {}} items={[{ label: 'Alpha', onSelect() {} }, { label: 'Beta', onSelect() {} }]} />)
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'b' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[1])
  })
})
```

`ui/__tests__/IconButton.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { X } from 'lucide-react'
import { IconButton } from '../IconButton'

describe('IconButton', () => {
  it('requires and exposes an accessible label; hit area uses --hit', () => {
    render(<IconButton label="关闭" icon={X} />)
    const b = screen.getByRole('button', { name: '关闭' })
    expect(b.className).toMatch(/min-w-\[var\(--hit\)\]/)
    expect(b.className).toMatch(/min-h-\[var\(--hit\)\]/)
  })
})
```

`ui/__tests__/SegmentedControl.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SegmentedControl } from '../SegmentedControl'

describe('SegmentedControl', () => {
  it('radio semantics and arrow keys', () => {
    const onChange = vi.fn()
    render(<SegmentedControl label="主题" value="system" onChange={onChange} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} />)
    expect(screen.getByRole('radiogroup', { name: '主题' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByRole('radio', { name: '跟随系统' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('light')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/ui/__tests__`
Expected: 新文件 FAIL。

- [ ] **Step 3: 实现**

`frontend/index.html`:`<body>` 中 `<div id="root">` 之后加 `<div id="overlay-root"></div>`。

`ui/Popover.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Sheet } from './Sheet'
import { useIsNarrow } from '../../lib/useMediaQuery'

const GAP = 6
const MARGIN = 12

/** Anchored floating layer. Portals into #overlay-root so it's never inside
 *  .xterm-container (touch-action:none would block scrolling) or
 *  .vault-reading-surface (contain:paint would clip it). On phones it becomes
 *  a bottom Sheet — anchored layers get pushed off-screen by the soft keyboard. */
export function Popover({ open, onClose, anchor, placement = 'bottom', align = 'start', children, sheetTitle }: {
  open: boolean; onClose: () => void; anchor: HTMLElement | null; placement?: 'top' | 'bottom'; align?: 'start' | 'end'; children: ReactNode; sheetTitle?: string
}) {
  const narrow = useIsNarrow()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || narrow || !anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const p = ref.current.getBoundingClientRect()
    const vh = window.visualViewport?.height ?? window.innerHeight
    const vw = window.innerWidth
    const below = a.bottom + GAP + p.height <= vh - MARGIN
    const top = (placement === 'bottom' ? below : !(a.top - GAP - p.height >= MARGIN)) ? a.bottom + GAP : a.top - GAP - p.height
    let left = align === 'start' ? a.left : a.right - p.width
    left = Math.min(Math.max(MARGIN, left), vw - MARGIN - p.width)
    setPos({ top: Math.max(MARGIN, top), left })
  }, [open, narrow, anchor, placement, align])

  useEffect(() => {
    if (!open || narrow) return
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); anchor?.focus() } }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key) }
  }, [open, narrow, anchor, onClose])

  if (!open) return null
  if (narrow) return <Sheet open side="bottom" onClose={onClose} title={sheetTitle}>{children}</Sheet>
  const host = document.getElementById('overlay-root') ?? document.body
  return createPortal(
    <div ref={ref} className="fixed z-popover min-w-[160px] max-w-[min(320px,calc(100vw-24px))] rounded-[var(--radius-lg)] bg-[var(--surface-2)] border border-[var(--border)] shadow-[var(--shadow-overlay)] py-1"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}>
      {children}
    </div>,
    host,
  )
}
```

> `setPos` 在 layout effect 中:eslint `react-hooks/set-state-in-effect` 对 `useLayoutEffect` 同样适用可能报错 —— 测量定位是 layout effect 的正当用途,若报错,在该行加 `// eslint-disable-next-line react-hooks/set-state-in-effect -- measure-then-position is the documented useLayoutEffect use`。

`ui/Menu.tsx`:

```tsx
import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Popover } from './Popover'
import { Kbd } from './Kbd'

export type MenuItem = { label: string; icon?: LucideIcon; danger?: boolean; kbd?: string; disabled?: boolean; onSelect(): void }

export function Menu({ open, onClose, anchor, items, title }: { open: boolean; onClose(): void; anchor: HTMLElement | null; items: MenuItem[]; title?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => { if (open) requestAnimationFrame(() => refs.current.find(Boolean)?.focus()) }, [open])
  const focusAt = (i: number) => refs.current[(i + items.length) % items.length]?.focus()
  const onKey = (i: number) => (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0) }
    else if (e.key === 'End') { e.preventDefault(); focusAt(items.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i) }
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase()
      const j = items.findIndex((it, idx) => idx > i && it.label.toLowerCase().startsWith(k))
      const j2 = j >= 0 ? j : items.findIndex(it => it.label.toLowerCase().startsWith(k))
      if (j2 >= 0) focusAt(j2)
    }
  }
  const select = (i: number) => { const it = items[i]; if (it.disabled) return; it.onSelect(); onClose() }
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} align="end" sheetTitle={title}>
      <div role="menu" aria-label={title}>
        {items.map((it, i) => (
          <button key={it.label} role="menuitem" ref={el => { refs.current[i] = el }} disabled={it.disabled}
            onKeyDown={onKey(i)} onClick={() => select(i)}
            className={`row w-full flex items-center gap-2.5 px-3 text-left text-ui-sm outline-none focus:bg-[var(--surface-hover)] hover:bg-[var(--surface-hover)] disabled:opacity-50 ${it.danger ? 'text-[var(--danger)] danger' : 'text-[var(--fg)]'}`}>
            {it.icon && <it.icon size={16} className="shrink-0" />}
            <span className="flex-1">{it.label}</span>
            {it.kbd && <Kbd>{it.kbd}</Kbd>}
          </button>
        ))}
      </div>
    </Popover>
  )
}
```

`ui/IconButton.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip } from './Tooltip'

export function IconButton({ label, icon: Icon, active, danger, size = 'md', className = '', ...rest }: {
  label: string; icon: LucideIcon; active?: boolean; danger?: boolean; size?: 'sm' | 'md'
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const vis = size === 'sm' ? 'w-7 h-7' : 'w-7 h-7 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:h-9'
  const tone = danger ? 'text-[var(--danger)]' : active ? 'text-[var(--accent)] bg-[var(--surface-3)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-hover)]'
  return (
    <Tooltip label={label}>
      <button type="button" aria-label={label} {...rest}
        className={`relative inline-flex items-center justify-center min-w-[var(--hit)] min-h-[var(--hit)] rounded-[var(--radius-md)] transition-colors duration-[var(--dur-fast)] focus-ring ${tone} ${className}`}>
        <span className={`inline-flex items-center justify-center ${vis}`}><Icon size={size === 'sm' ? 16 : 18} /></span>
      </button>
    </Tooltip>
  )
}
```

`ui/Tooltip.tsx`:

```tsx
import { cloneElement, useId, useRef, useState, type ReactElement } from 'react'
import { useMediaQuery } from '../../lib/useMediaQuery'

/** Desktop-only hover label (touch devices get nothing — no hover exists). */
export function Tooltip({ label, children }: { label: string; children: ReactElement<Record<string, unknown>> }) {
  const hover = useMediaQuery('(hover: hover)')
  const id = useId()
  const [show, setShow] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  if (!hover) return children
  return (
    <span className="relative inline-flex" onMouseEnter={() => { t.current = setTimeout(() => setShow(true), 500) }} onMouseLeave={() => { clearTimeout(t.current); setShow(false) }}>
      {cloneElement(children, { 'aria-describedby': show ? id : undefined })}
      {show && <span id={id} role="tooltip" className="absolute top-full mt-1 left-1/2 -translate-x-1/2 z-popover whitespace-nowrap px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] text-ui-2xs text-[var(--fg)] pointer-events-none">{label}</span>}
    </span>
  )
}
```

`ui/Kbd.tsx`、`ui/Badge.tsx`、`ui/SegmentedControl.tsx`、`ui/Skeleton.tsx`:

```tsx
// Kbd.tsx
import type { ReactNode } from 'react'
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] border border-[var(--border)] text-ui-2xs font-mono text-[var(--fg-muted)]">{children}</kbd>
}
```

```tsx
// Badge.tsx
export function Badge({ count, tone = 'attention', dot }: { count?: number; tone?: 'attention' | 'danger'; dot?: boolean }) {
  if (!dot && !count) return null
  const bg = tone === 'danger' ? 'bg-[var(--danger)]' : 'bg-[var(--attention)]'
  if (dot) return <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${bg}`} />
  return <span className={`num inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-ui-2xs font-semibold text-[var(--on-accent)] ${bg}`}>{count! > 99 ? '99+' : count}</span>
}
```

```tsx
// SegmentedControl.tsx
import type { KeyboardEvent } from 'react'
export function SegmentedControl<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string }) {
  const i = options.findIndex(o => o.value === value)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onChange(options[(i + 1) % options.length].value) }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); onChange(options[(i - 1 + options.length) % options.length].value) }
  }
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 rounded-[var(--radius-md)] bg-[var(--surface-2)] border border-[var(--border-subtle)]">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1}
          onKeyDown={onKey} onClick={() => onChange(o.value)}
          className={`ctl px-3 rounded-[calc(var(--radius-md)-2px)] text-ui-xs transition-colors duration-[var(--dur-fast)] ${o.value === value ? 'bg-[var(--surface-3)] text-[var(--fg-strong)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
```

```tsx
// Skeleton.tsx
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="加载中" className="space-y-2 p-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 rounded-[var(--radius-sm)] bg-[var(--surface-3)] motion-safe:animate-pulse" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  )
}
```

`ui/index.ts` 追加导出这八个。

- [ ] **Step 4: 替换调用点**

- `Sidebar.tsx` Settings(`:1020-1055`):`{showSettings && (<><div className="fixed inset-0 z-10" …/><div className="absolute bottom-full …">…</div></>)}` → `<Menu open={showSettings} onClose={() => setShowSettings(false)} anchor={settingsBtnRef.current} title="设置" items={[…]} />`,菜单项:推送通知(`Bell`)、常用 prompt 管理(`Pencil`)、用户管理(`Users`,仅 admin)。**主题**不再是菜单项,而是 Settings 按钮上方一行 `<SegmentedControl label="主题" value={themePref} onChange={onSetThemePref} options={…} />`(侧栏底部常驻,替代 T4 的三按钮行)。Settings 按钮加 `ref={settingsBtnRef}`。
- `Sidebar.tsx` 新建弹层的透明遮罩(`grep -n 'fixed inset-0 z-10' src/components/Sidebar.tsx`,剩余处):**仅**把遮罩 + `absolute` 定位的容器换成 `<Popover open={step !== 'closed'} onClose={close} anchor={newBtnRef.current} placement="bottom" sheetTitle="新建会话">`,内部步骤 JSX **原样**保留;手机上它会自动成为 bottom Sheet(当前手机上是全屏侧栏内的 absolute 块 —— 这是有意的体验改进)。`Sidebar.newflow` / `Sidebar.search` 测试若依赖遮罩元素,改为依赖可见文本(断言不变)。
- `SessionRowMenu.tsx`:下拉改用 `<Menu>`;保持现有测试断言的项与回调。
- `QuickTargets.tsx`、`SearchResults.tsx`:行内操作单(`:120-151`、`:71-80,121-127`)改 `<Menu>`,触发按钮改 `<IconButton label="更多" icon={MoreHorizontal} size="sm" />`;hover-only 显示逻辑删除(按钮常显)。
- T11 四个面板 Sheet `actions` 中的关闭按钮 → `<IconButton label="关闭" icon={X} onClick={onClose} />`。
- 这些文件中触及到的 `text-[8-11px]`、调色板直用、`z-N` 一并迁移(QuickTargets、SearchResults、SessionRowMenu 全文件清零;Sidebar 只迁本 Task 改到的 JSX 块)。

- [ ] **Step 5: 运行**

Run: `cd frontend && npx vitest run src/components/ui/__tests__ src/components/__tests__ && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && npx eslint src/components/ui src/components/Sidebar.tsx src/components/SessionRowMenu.tsx src/components/QuickTargets.tsx src/components/SearchResults.tsx && node scripts/lint-tokens.mjs --files | grep -E "QuickTargets|SearchResults|SessionRowMenu|/ui/"; node scripts/lint-tokens.mjs && npm run build 2>&1 | tail -2`
Expected: 全 PASS;`--files` 中这些文件不出现;下调 baseline;体积门禁通过。

- [ ] **Step 6: 截图 + 真机提示**

隔离实例截图:侧栏 Settings 菜单、主题分段控件、新建会话(桌面 Popover / 手机 bottom Sheet)、QuickTargets 行菜单,m/d × dark/light,存 `docs/superpowers/screens/s1/t12/`。报告中列出「需真机确认」:iPhone Safari 上新建会话 Sheet 内搜索框聚焦时键盘不遮挡(Review Focus #3)。

- [ ] **Step 7: Commit**

```bash
git add frontend/index.html frontend/src frontend/scripts/lint-tokens.baseline.json docs/superpowers/screens/s1/t12
git commit -m "feat(ui): Popover/Menu/IconButton/Tooltip/Kbd/Badge/SegmentedControl/Skeleton; replace hand-rolled overlays"
```

---

### Task 13: S1 负责文件的 token / 字号 / 原生弹窗 / emoji 清零

**Files:**
- Modify: `frontend/src/components/HistoryView.tsx`、`MobileKeyBar.tsx`、`LoginPage.tsx`、`WaitingPage.tsx`、`VaultReader.tsx`、`DirectoryPicker.tsx`、`PromptManager.tsx`(若 T11 未清完)、`components/markdown/*`(仅调色板 / 小字号,若有)
- Test: 既有 `HistoryView.test.tsx`、`MobileKeyBar.test.tsx`、`VaultReader.test.tsx`、`DirectoryPicker.stale.test.tsx`

**Interfaces:**
- Consumes: T10 `confirm`、`toast`;T12 `IconButton`、`Skeleton`;T3 token。

**明确不在本 Task**:`AcpChatView.tsx`、`GitViewer.tsx`、`FileBrowser.tsx`、`SessionInfoBar.tsx`、`TerminalView.tsx`、`AgentDashboard.tsx`、`RunMetricsPanel.tsx`、`MemoryPanel.tsx`、`App.tsx`、`Sidebar.tsx` 的其余部分(S2/S3 重写,spec R11)。

- [ ] **Step 1: 列出本 Task 的违规清单**

Run: `cd frontend && node scripts/lint-tokens.mjs --files | grep -E "HistoryView|MobileKeyBar|LoginPage|WaitingPage|VaultReader|DirectoryPicker|PromptManager|/markdown/"`
把输出(每文件五类计数)粘进报告作为起点。

- [ ] **Step 2: 逐文件迁移(每个文件一个 commit)**

对每个文件:
1. 字号:`text-[10px]`/`text-[11px]`/`text-[9px]` → 标签/计数/时间戳用 `text-ui-2xs`,其余 `text-ui-xs`;`text-xs` → `text-ui-xs`;`text-sm` → `text-ui-sm`;输入框保持 16px(`text-base` → `text-ui-input`)。
2. 颜色:Tailwind 调色板 → 语义 token(`text-yellow-*` → `text-[var(--attention)]`,`text-red-*` → `text-[var(--danger)]`,`text-green-*` → `text-[var(--success)]`,`text-zinc-*`/`gray-*` → `text-[var(--fg-subtle)]`)。
3. `z-N` → `.z-sticky` 等语义类。
4. 原生弹窗:
   - `HistoryView.tsx:132` `window.confirm('内容可能包含密钥或令牌，确认发给 agent？')` → `if (await confirm({ title: '发给 agent？', body: '内容可能包含密钥或令牌,请确认后再发送。', confirmLabel: '发送' })) onSendToAgent(payload)`(onClick 改 async)。
   - `VaultReader.tsx:80,87,88` 三处 `alert(…)` → `toast.push({ message: … })`(文案不变);`resolveWikiLink` 补 `.catch(() => toast.push({ message: '无法解析链接' }))`(B9)。
5. emoji:`MobileKeyBar.tsx` 📜 → `<History size={18} />`(lucide);`HistoryView.tsx` 若有 emoji 同理。
6. VaultReader 列表加载中 → `<Skeleton rows={4} />`;加载失败 → 一行 `text-[var(--danger)]` 错误 + 「重试」按钮(`s.retry` 或 list reload)。
7. 每个文件迁移后:该文件的测试 + `node scripts/lint-tokens.mjs --files | grep <文件>` 无输出;下调 baseline;commit `style(<file>): design tokens, type scale, no native dialogs`。

- [ ] **Step 3: 运行**

Run: `cd frontend && npm test 2>&1 | grep -E "Test Files|Tests " && npx tsc -b && node scripts/lint-tokens.mjs --files | grep -E "HistoryView|MobileKeyBar|LoginPage|WaitingPage|VaultReader|DirectoryPicker|PromptManager|/markdown/"; node scripts/lint-tokens.mjs`
Expected: 全 PASS;grep 无输出;棘轮全部 `=` 或 `↓`。

- [ ] **Step 4: 截图**

隔离实例:登录页、等待页(OAuth 不可用时跳过)、tmux 终端(键栏 📜 → 图标)、历史视图、Vault 阅读,m/d × dark/light,存 `docs/superpowers/screens/s1/t13/`。

---

### Task 14: sanitize 回归 + S1 收尾验收 + 部署

**Files:**
- Modify: `frontend/src/components/markdown/__tests__/sanitize.test.ts`(追加)
- Create: `docs/superpowers/screens/s1/README.md`(截图索引)

- [ ] **Step 1: 写 sanitize 回归测试(R16)**

先 `sed -n 1,40p src/components/markdown/__tests__/sanitize.test.ts` 看现有调用方式(通常是渲染 `MarkdownContent` 带 `enableRawHtml` 或直接调用 sanitize 管线)。追加三例,沿用现有 helper:

```ts
  it('strips popover / popovertarget / dialog so notes cannot open top-layer overlays (R16)', () => {
    const out = renderSanitized('<div popover id="p">x</div><button popovertarget="p">go</button><dialog open>y</dialog>')
    expect(out).not.toMatch(/popover/i)
    expect(out).not.toMatch(/<dialog/i)
  })
```

> `renderSanitized` 为示意名 —— 用该测试文件现有的渲染/断言 helper(如 `render(<MarkdownContent content={…} enableRawHtml />)` 后取 `container.innerHTML`)。运行确认**当前即 PASS**(schema 本就不放行,`sanitizeSchema.ts:14-43`)—— 这是回归锁,不是修复;再临时在 schema 中放行 `popover` 属性确认 FAIL,恢复。

- [ ] **Step 2: 全量验收**

```bash
cd frontend
npm test 2>&1 | grep -E "Test Files|Tests "
npx tsc -b && echo TSC_OK
node scripts/lint-tokens.mjs && node scripts/contrast.mjs
npm run build 2>&1 | tail -3
cd .. && cargo test 2>&1 | grep "^test result"
```

Expected: 全绿;体积门禁 ≤ 330KB;对比度 ok;棘轮五类均**低于** T2 起始 baseline(报告中列出起止数字)。

- [ ] **Step 3: 最终截图集**

隔离实例,对 T2 基线同一组场景出最终图(`docs/superpowers/screens/s1/final/`),`README.md` 列出 t2-baseline ↔ final 的对照表(场景 × 视口 × 主题)。

- [ ] **Step 4: 不变量抽查**

Run: `cd frontend && npx vitest run src/components/__tests__/acpConnection.test.tsx src/components/__tests__/TerminalView.mobileLayout.test.tsx src/components/__tests__/SessionInfoBar.queuemode.test.tsx src/lib/__tests__/scrollReplay.test.ts src/lib/__tests__/stuck.test.ts src/lib/__tests__/terminalSize.test.ts src/lib/__tests__/terminalInput.test.ts`
Expected: PASS(P0 与 I-6/I-7/I-11/I-12/I-13 的保护未受影响)。

- [ ] **Step 4.5: 更新 CLAUDE.md**

仓库根 `CLAUDE.md` 的 Frontend 段落末尾追加一句:「设计系统:语义 token 在 `src/index.css`(旧 `--bg-*`/`--text-*` 为别名),primitives 在 `src/components/ui/`(原生 `<dialog>`,零依赖);`npm run lint` 含 token 棘轮与对比度校验,`npm run build` 含首屏 br ≤ 330KB 门禁。」

- [ ] **Step 5: push 后部署**

```bash
git add docs/superpowers/screens/s1 frontend/src/components/markdown/__tests__/sanitize.test.ts CLAUDE.md
git commit -m "test(sanitize): lock out popover/dialog; S1 screenshots and docs"
git push origin main
./deploy.sh --build
```

(若在 feature 分支 / worktree 上执行:先 fast-forward 合入 main 的**主 checkout**,在主 checkout 执行 `npm ci`(JuiceFS 上约 30 分钟,提前后台跑)与 `./deploy.sh --build` —— 线上 `--watch-build` 盯主 checkout 的 `target/release`,从 worktree 部署会被自动回滚。)

- [ ] **Step 6: 线上验证**

```bash
JS=$(curl -s https://zeromux.keithyu.cloud/ | grep -o '/assets/index-[^"]*\.js' | head -1)
curl -s -H 'Accept-Encoding: br' -D - -o /dev/null "https://zeromux.keithyu.cloud$JS" | grep -iE "content-encoding|content-length|vary"
curl -s -H 'Accept-Encoding: br' -o /dev/null -w 'br=%{size_download}\n' "https://zeromux.keithyu.cloud$JS"
curl -s -H 'Accept-Encoding: br' -D - -o /dev/null https://zeromux.keithyu.cloud/sw.js | grep -i content-type
systemctl is-active zeromux
```

Expected: `content-encoding: br`、`vary: Accept-Encoding`;`br` ≈ 305–315KB(q11,较 P0 的 388KB 下降);`sw.js` 为 JavaScript MIME;`active`。手机实测:浅色系统下首屏无暗色闪烁;设置 → 推送 / 定时任务为全屏 Sheet,下拉把手可关闭;次要文字清晰可读。
