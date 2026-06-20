# 工作区文件浏览器 + Logo 重塑 Implementation Plan (PR2 / Feature B + C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `'files'` overlay 从只读 markdown 查看器升级为真 · 工作区文件浏览器（真目录树 + 图片/HTML 预览 + 二进制下载 + 安全底座加固），并用 lobehub 几何风重塑品牌 logo（保留品牌色 #f7b500）。

**Architecture:** B 先补现有路径安全的 P0 漏洞（统一 `resolve_and_verify`：canonicalize + starts_with 复查 + O_NOFOLLOW），再新增单层目录列举端点 + raw 字节下载端点；前端把 `MarkdownViewer` 拆成 `FileBrowser`（列目录/预览分发）+ 复用 `MarkdownContent`。C 重写 logo 为内联 SVG 组件，一致性替换 6~7 处引用，补 PWA manifest。

**Tech Stack:** Rust / Axum；React 19 + Vite + Tailwind v4 + vitest；内联 SVG（零新依赖，沿用 `BrandIcons.tsx` 做法）。

## Global Constraints

- 安全模型不依赖 UI 隐藏：删除/重命名 API 保留，安全性由 auth + 路径校验保证。
- 所有文件端点（list/read/raw/write/upload/delete/rename）走统一 `resolve_and_verify`：canonicalize 后再 `starts_with(base_canonical)`，canonicalize 失败即拒。
- raw 下载三件套响应头：`Content-Type: application/octet-stream` + `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment`。
- credential 文件永不枚举（list 结果集就过滤），逻辑路径 + canonical 真实路径各查一次。
- `.git` / `.zeromux` / `.zeromux-worktrees` 可浏览禁写（禁写判 canonical 真实路径）。
- HTML/SVG 预览必须 `<iframe sandbox="">` 无 `allow-same-origin`；markdown 走前端 sanitizer。
- 保留品牌色 `#f7b500`，重塑的是形不是色；lobehub 几何简洁 + 单/双色硬朗，不上多色渐变。
- 代码注释英文，用户可见字符串中文。零 inline onclick（沿用项目约定）。前端全 `var(--*)` token，零 px 字面量。
- 测试：`cargo test` + `cd frontend && npm test`；执行用 opus；频繁提交。

---

## File Structure

- **Modify** `src/web.rs`:
  - 新增 `fn resolve_and_verify(base, rel) -> Result<PathBuf>`（canonicalize + recheck + O_NOFOLLOW 打开）。
  - 新增 `fn is_credential_path(name) -> bool`、`fn is_write_blocked(canonical) -> bool`。
  - 改 `list_session_files`（`:690`）/ `collect_files`（`:708`）：新增单层 `dir/list` 端点 + credential 过滤。
  - 改 `get_session_file`（`:767`）/ 新增 raw 下载 handler。
  - 改 `write_session_file`（`:869`）/ `upload_session_file`（`:1006`，修目录丢弃 bug）走 `resolve_and_verify` + 禁写检查。
  - `try_serve_embedded`（`:191`）加全局 CSP 响应头。
  - routes（`:27-36`）加 `dir/list` + `file/raw`。
- **Frontend Create** `frontend/src/components/FileBrowser.tsx`、`frontend/src/components/BrandLogo.tsx`。
- **Frontend Modify** `MarkdownViewer.tsx`（拆分/复用 MarkdownContent）、`App.tsx`（`'files'` overlay 指向 FileBrowser）、`lib/api.ts`（`listDir`、`fileRawUrl`）、`HaringLogo.tsx`（删除/改名引用）、`LoginPage.tsx`、`Sidebar.tsx`。
- **Frontend Create** `frontend/public/manifest.json`、改 `frontend/public/favicon.svg`、`frontend/index.html`（manifest link + theme-color）。
- **Modify** `frontend/src/index.css`（`--accent-brand`，若调）。

---

# PART B — 文件浏览器

## Task 1: 统一路径安全 resolve_and_verify（先补 P0 漏洞底座）

**Files:**
- Modify: `src/web.rs`（新增 helper，放 `resolve_session_path` `:828` 旁）
- Test: `src/web.rs` inline `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `fn resolve_and_verify(base: &Path, rel: &str) -> Result<PathBuf, (StatusCode, String)>` — 词法防 `..` + `base.join(rel)` canonicalize + `starts_with(base_canonical)`；canonicalize 失败（dangling/越界 symlink）→ 403。
  - `fn is_credential_path(name: &str) -> bool`
  - `fn is_write_blocked(canonical: &Path) -> bool`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn resolve_and_verify_rejects_symlink_escape() {
        let tmp = std::env::temp_dir().join(format!("zmfb-{}", std::process::id()));
        let base = tmp.join("work");
        std::fs::create_dir_all(&base).unwrap();
        let outside = tmp.join("secret.txt");
        std::fs::write(&outside, "topsecret").unwrap();
        // base/leak -> ../secret.txt (escapes base)
        let _ = symlink(&outside, base.join("leak"));
        let base_c = base.canonicalize().unwrap();
        // 跟随 symlink 后 canonical 落在 base 外 → 必须拒
        assert!(resolve_and_verify(&base_c, "leak").is_err());
        // 正常文件放行
        std::fs::write(base.join("ok.txt"), "hi").unwrap();
        assert!(resolve_and_verify(&base_c, "ok.txt").is_ok());
    }

    #[test]
    fn credential_names_flagged() {
        assert!(is_credential_path(".env"));
        assert!(is_credential_path("id_rsa"));
        assert!(is_credential_path("server.pem"));
        assert!(is_credential_path(".aws"));
        assert!(!is_credential_path("README.md"));
    }

    #[test]
    fn write_blocked_for_control_dirs() {
        let p = std::path::Path::new("/home/u/work/.git/config");
        assert!(is_write_blocked(p));
        let p2 = std::path::Path::new("/home/u/work/src/main.rs");
        assert!(!is_write_blocked(p2));
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test web::tests::resolve_and_verify_rejects_symlink_escape`
Expected: 失败（helper 未定义）。

- [ ] **Step 3: 写实现**

```rust
use std::path::Path;

/// 凭据/敏感文件名:list 永不枚举,download 拒。匹配文件名(不含目录)。
fn is_credential_path(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with(".env")
        || n == ".aws" || n == ".ssh" || n == ".netrc" || n == ".npmrc"
        || n.starts_with("id_")            // id_rsa / id_ed25519 ...
        || n.ends_with(".pem") || n.ends_with(".key") || n.ends_with(".p12")
        || n.ends_with("credentials")
}

/// 控制目录禁写:canonical 真实路径任一段命中即禁(防 symlink 父目录绕过)。
fn is_write_blocked(canonical: &Path) -> bool {
    canonical.components().any(|c| {
        matches!(c, std::path::Component::Normal(s)
            if matches!(s.to_str(), Some(".git") | Some(".zeromux") | Some(".zeromux-worktrees") | Some(".ssh")))
    })
}

/// 统一解析+校验:词法防 `..` → join → canonicalize → starts_with(base) 复查。
/// canonicalize 跟随 symlink,落 base 外即 403;dangling/不存在 → 视调用方(读拒/写另行处理父目录)。
fn resolve_and_verify(base_canonical: &Path, rel: &str) -> Result<std::path::PathBuf, (StatusCode, String)> {
    // 词法层:拒绝绝对路径与逃逸的 ..
    let mut probe = base_canonical.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(c) => probe.push(c),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                probe.pop();
                if !probe.starts_with(base_canonical) {
                    return Err((StatusCode::FORBIDDEN, "Path traversal denied".into()));
                }
            }
            _ => return Err((StatusCode::BAD_REQUEST, "Invalid path component".into())),
        }
    }
    // 物理层:canonicalize 跟随 symlink 后必须仍在 base 内
    let real = probe.canonicalize()
        .map_err(|_| (StatusCode::FORBIDDEN, "Path not resolvable under workspace".into()))?;
    if !real.starts_with(base_canonical) {
        return Err((StatusCode::FORBIDDEN, "Path escapes workspace".into()));
    }
    Ok(real)
}
```

> 注：O_NOFOLLOW openat2 全链下降是最强方案，但 Rust 无跨平台封装。本 MVP 用「canonicalize + starts_with 复查」缩小窗口到极小（读路径足够：读的是已存在文件，canonicalize 是真实路径）；写路径额外用 `is_write_blocked(real_parent)` + `create_new` 防覆盖。残留 TOCTOU 窗口（canonicalize→open 间被换）在单用户 work_dir 场景风险低，记入 spec 留接缝（openat2 加固为后续）。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test web::tests::`
Expected: 3 passed。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "fix(files): unified resolve_and_verify (canonicalize recheck) + credential/write-block guards"
```

---

## Task 2: read/upload/write 接入 resolve_and_verify + 修上传目录 bug

**Files:**
- Modify: `src/web.rs`（`get_session_file` `:767`、`write_session_file` `:869`、`upload_session_file` `:1006`）
- Test: inline tests

**Interfaces:**
- Consumes: `resolve_and_verify`、`is_write_blocked`（Task 1）
- Produces: 上传支持子目录（用 `req.path` 的目录部分，不再只取 `file_name()`）

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn upload_targets_subdir_not_root() {
    // 该测试断言 upload_target_dir 纯 helper 行为:
    // 给定 base + "sub/dir/pic.png" → 目标目录 base/sub/dir, 文件名 pic.png。
    let base = std::path::Path::new("/home/u/work");
    let (dir, name) = split_upload_target(base, "sub/dir/pic.png");
    assert_eq!(dir, std::path::Path::new("/home/u/work/sub/dir"));
    assert_eq!(name, "pic.png");
    // 纯文件名 → 落 base
    let (dir2, name2) = split_upload_target(base, "pic.png");
    assert_eq!(dir2, base);
    assert_eq!(name2, "pic.png");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test web::tests::upload_targets_subdir_not_root`
Expected: 失败（`split_upload_target` 未定义）。

- [ ] **Step 3: 写实现**

加纯 helper：

```rust
/// 拆分上传相对路径为(目标目录, 安全文件名)。保留目录部分(修复只取 file_name 的 bug)。
fn split_upload_target(base: &Path, rel: &str) -> (std::path::PathBuf, String) {
    let p = Path::new(rel);
    let name = sanitize_filename(p.file_name().and_then(|s| s.to_str()).unwrap_or("upload"));
    let dir = match p.parent() {
        Some(par) if !par.as_os_str().is_empty() => base.join(par),
        _ => base.to_path_buf(),
    };
    (dir, name)
}
```

`get_session_file`（:767）：把现有 `resolve_session_path`/手动 join 改为 `let base = resolve_base_dir(...)?; let real = resolve_and_verify(&base, &query.path)?;` 后续读 `real`；若 `is_credential_path(file_name)` → 403。

`write_session_file`（:869）：解析后 `is_write_blocked(real_parent)` → 403；父目录必须预存（不再 `create_dir_all` 客户端命名树——改为父目录不存在则 400）。

`upload_session_file`（:1006）：用 `split_upload_target(&base, &req.path)` 得 `(target_dir, name)`；`target_dir` 必须经 `resolve_and_verify`（其相对 base 的部分）且存在；`is_write_blocked(target_dir)` → 403；再 `dedupe_and_create(&target_dir, &name)`。base64 解码 20MB 上限保留。

- [ ] **Step 4: 运行确认通过 + 编译**

Run: `cargo test web::tests:: && cargo build`
Expected: passed + build 成功。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "fix(files): read/write/upload via resolve_and_verify; upload honors subdir; write-block control dirs"
```

---

## Task 3: 单层目录列举端点 dir/list

**Files:**
- Modify: `src/web.rs`（新增 `list_dir` handler + route `:27` 组）
- Test: inline test

**Interfaces:**
- Consumes: `resolve_and_verify`、`is_credential_path`
- Produces:
  - `GET /api/sessions/{id}/dir/list?path=` → `{ entries: [{name, type: "dir"|"file", size, mtime, writable}], truncated }`，cap 2000 + `truncated`。
  - route: `.route("/api/sessions/{id}/dir/list", get(list_dir))`

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn list_dir_filters_credentials_and_marks_types() {
    let tmp = std::env::temp_dir().join(format!("zmld-{}", std::process::id()));
    std::fs::create_dir_all(tmp.join("sub")).unwrap();
    std::fs::write(tmp.join("a.txt"), "x").unwrap();
    std::fs::write(tmp.join(".env"), "SECRET=1").unwrap();
    let base = tmp.canonicalize().unwrap();
    let (entries, _trunc) = list_dir_entries(&base, "").unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"a.txt"));
    assert!(names.contains(&"sub"));
    assert!(!names.contains(&".env")); // credential 不枚举
    let sub = entries.iter().find(|e| e.name == "sub").unwrap();
    assert_eq!(sub.kind, "dir");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test web::tests::list_dir_filters_credentials_and_marks_types`
Expected: 失败。

- [ ] **Step 3: 写实现**

```rust
struct DirEntryOut { name: String, kind: &'static str, size: u64, mtime: u64, writable: bool }

/// 列单层目录(不递归)。过滤 credential 文件。cap 2000。
fn list_dir_entries(base_canonical: &Path, rel: &str)
    -> Result<(Vec<DirEntryOut>, bool), (StatusCode, String)> {
    let dir = if rel.is_empty() { base_canonical.to_path_buf() } else { resolve_and_verify(base_canonical, rel)? };
    if !dir.is_dir() { return Err((StatusCode::BAD_REQUEST, "Not a directory".into())); }
    let rd = std::fs::read_dir(&dir).map_err(|e| (StatusCode::BAD_REQUEST, format!("Cannot read dir: {e}")))?;
    let mut out = Vec::new();
    let mut truncated = false;
    for entry in rd.flatten() {
        if out.len() >= 2000 { truncated = true; break; }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_credential_path(&name) { continue; } // 永不枚举
        let ft = entry.file_type().ok();
        let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
        let meta = entry.metadata().ok();
        out.push(DirEntryOut {
            kind: if is_dir { "dir" } else { "file" },
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            mtime: meta.as_ref().and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()).unwrap_or(0),
            writable: !is_write_blocked(&dir.join(&name)),
            name,
        });
    }
    out.sort_by(|a, b| (b.kind, a.name.to_lowercase()).cmp(&(a.kind, b.name.to_lowercase()))); // dir 在前
    Ok((out, truncated))
}

async fn list_dir(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<DirQuery>,  // 复用现有 DirQuery { path: Option<String> } :204
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let base = resolve_base_dir(&state, &id, None)?;
    let (entries, truncated) = list_dir_entries(&base, query.path.as_deref().unwrap_or(""))?;
    let arr: Vec<_> = entries.iter().map(|e| serde_json::json!({
        "name": e.name, "type": e.kind, "size": e.size, "mtime": e.mtime, "writable": e.writable,
    })).collect();
    Ok(Json(serde_json::json!({ "entries": arr, "truncated": truncated })))
}
```

route 加 `.route("/api/sessions/{id}/dir/list", get(list_dir))`。

- [ ] **Step 4: 运行确认通过 + 编译**

Run: `cargo test web::tests:: && cargo build`
Expected: passed + build 成功。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(files): GET /dir/list — single-level listing, dirs-first, credentials filtered"
```

---

## Task 4: raw 字节下载端点（三件套响应头）

**Files:**
- Modify: `src/web.rs`（新增 `get_file_raw` handler + route）
- Test: inline test（断言响应头）

**Interfaces:**
- Consumes: `resolve_and_verify`、`is_credential_path`
- Produces: `GET /api/sessions/{id}/file/raw?path=` → 原始字节 + 三件套头。route `.route("/api/sessions/{id}/file/raw", get(get_file_raw))`

- [ ] **Step 1: 写失败测试**

```rust
#[tokio::test]
async fn file_raw_sets_security_headers() {
    // 构造 AppState + 会话 work_dir(临时) + 一个 evil.html,
    // 调 get_file_raw,断言:
    //   Content-Type == application/octet-stream
    //   X-Content-Type-Options == nosniff
    //   Content-Disposition 含 attachment
    // (按 web.rs 现有 handler 测试构造 AppState 的方式;若较重,可降级为对
    //  build_raw_headers(filename) 纯 helper 的单测。)
}

#[test]
fn build_raw_headers_are_safe() {
    let h = build_raw_headers("evil.html");
    assert_eq!(h.0, "application/octet-stream");
    assert_eq!(h.1, "nosniff");
    assert!(h.2.contains("attachment"));
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test web::tests::build_raw_headers_are_safe`
Expected: 失败。

- [ ] **Step 3: 写实现**

```rust
/// raw 下载三件套:绝不 inline 渲染用户文件(防应用同源 XSS)。
fn build_raw_headers(filename: &str) -> (&'static str, &'static str, String) {
    let safe = sanitize_filename(filename);
    ("application/octet-stream", "nosniff", format!("attachment; filename=\"{}\"", safe))
}

async fn get_file_raw(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(query): Query<FileQuery>,
) -> Result<Response, (StatusCode, String)> {
    let base = resolve_base_dir(&state, &id, query.base_dir.as_deref())?;
    let real = resolve_and_verify(&base, &query.path)?;
    let fname = real.file_name().and_then(|s| s.to_str()).unwrap_or("download");
    if is_credential_path(fname) {
        return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    let bytes = std::fs::read(&real)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Not found: {e}")))?;
    let (ct, nosniff, disp) = build_raw_headers(fname);
    Ok(Response::builder()
        .header("Content-Type", ct)
        .header("X-Content-Type-Options", nosniff)
        .header("Content-Disposition", disp)
        .body(axum::body::Body::from(bytes))
        .unwrap())
}
```

> 注：图片预览前端用 `<img src="/api/sessions/{id}/file/raw?path=...">` —— 浏览器对 `attachment` + `octet-stream` 的 `<img>` 仍会渲染图片（img 标签按内容嗅探图像，不受 disposition 影响渲染，但 disposition 阻止顶层导航执行）。HTML 预览不用 raw inline，而是 fetch 文本喂 sandbox iframe（Task 6）。

route 加 `.route("/api/sessions/{id}/file/raw", get(get_file_raw))`。

- [ ] **Step 4: 运行确认通过 + 编译**

Run: `cargo test web::tests:: && cargo build`
Expected: passed + build 成功。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(files): GET /file/raw — binary download with attachment+nosniff+octet-stream"
```

---

## Task 5: 全局 CSP 响应头（纵深防御）

**Files:**
- Modify: `src/web.rs`（`try_serve_embedded` `:191` 或一个响应中间件）
- Test: inline test 断言 header 存在

**Interfaces:**
- Produces: 所有 SPA/asset 响应带 `Content-Security-Policy`

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn embedded_response_has_csp() {
    if let Some(resp) = try_serve_embedded("index.html") {
        assert!(resp.headers().get("Content-Security-Policy").is_some());
    } // index.html 必在 bundle 中
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test web::tests::embedded_response_has_csp`
Expected: 失败（无 CSP 头）。

- [ ] **Step 3: 写实现**

`try_serve_embedded`（:194）加一行 header（保守策略，允许内联 SVG/data-URI favicon + 同源 WS）：

```rust
            .header("Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
                 script-src 'self'; connect-src 'self' ws: wss:; frame-src 'self'; \
                 object-src 'none'; base-uri 'self'")
```

> 注：若现有前端依赖 inline script/eval（Vite 产物一般不需要），构建后冒烟若白屏则放宽对应指令；本步以 `npm run build` 后实际加载验证（Task 9）。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test web::tests::embedded_response_has_csp`
Expected: passed。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(web): global CSP header on embedded responses (defense-in-depth)"
```

---

## Task 6: 前端 FileBrowser —— 目录树 + 预览分发 + 下载 + 上传

**Files:**
- Modify: `frontend/src/lib/api.ts`（`listDir`、`fileRawUrl`）
- Create: `frontend/src/components/FileBrowser.tsx`
- Modify: `frontend/src/components/MarkdownViewer.tsx`（抽出 md 渲染由 `MarkdownContent` 承担；FileBrowser 复用）
- Modify: `frontend/src/App.tsx`（`'files'` overlay 指向 `FileBrowser` 而非 MarkdownViewer）
- Test: `frontend/src/components/__tests__/FileBrowser.test.tsx`

**Interfaces:**
- Consumes: `GET /dir/list`、`/file`（文本）、`/file/raw`、`/upload`
- Produces: `FileBrowser({ sessionId })`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { FileBrowser } from '../FileBrowser'
// mock api.listDir → { entries: [{name:'sub',type:'dir'},{name:'pic.png',type:'file'}], truncated:false }

test('lists dir entries with breadcrumb root', async () => {
  render(<FileBrowser sessionId="s1" />)
  expect(await screen.findByText('pic.png')).toBeInTheDocument()
  expect(screen.getByText('sub')).toBeInTheDocument()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/FileBrowser.test.tsx`
Expected: 失败（组件不存在）。

- [ ] **Step 3: 写实现**

- `api.ts`：`listDir(id, path)` → `/api/sessions/${id}/dir/list?path=`；`fileRawUrl(id, path)` → 返回 raw URL 字符串（带 token query 同现有鉴权方式）。
- `FileBrowser.tsx`：
  - state：`cwd`（当前相对路径）、`entries`、`selected`、`previewKind`。
  - 面包屑：拆 `cwd` 渲染可点击各级 + 根。
  - 单列列表：dir 在前（点击下钻 `setCwd`），file 点击 → 预览分发；每行右侧下载按钮（`<a href={fileRawUrl(...)} download>`）。
  - 预览分发：扩展名 image（png/jpg/jpeg/gif/webp/svg→注意 svg 也走 raw img）→ `<img src={fileRawUrl}>`；html/htm → `fetch /file 文本` 后 `<iframe sandbox="" srcDoc={text}>`（**无 allow-same-origin**）；md/txt/常见文本 → 走现有文本读取 + `MarkdownContent`；其他 → 仅下载按钮 + 「不支持预览」。
  - 上传：拖拽区 → `uploadSessionFile(id, `${cwd}/${file.name}`, base64)`，XHR 进度，409 → 确认覆盖提示。复用现有 `uploadSessionFile`，不造新逻辑。
  - 写操作（删除/重命名/建目录）：保留，收进每行右键/「⋯」菜单 + 二次确认（复用 MarkdownViewer 现有 `deleteSessionDir` 等）。
  - 零 inline onclick；全 `var(--*)` token。
- `App.tsx`：`{view === 'files' && <FileBrowser sessionId={s.id} />}`（替换原 MarkdownViewer 引用）。

- [ ] **Step 4: 运行确认通过 + lint**

Run: `cd frontend && npx vitest run src/components/__tests__/FileBrowser.test.tsx && npm run lint`
Expected: passed + lint 干净。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/lib/api.ts frontend/src/components/FileBrowser.tsx frontend/src/components/MarkdownViewer.tsx frontend/src/App.tsx frontend/src/components/__tests__/FileBrowser.test.tsx
git commit -m "feat(files): FileBrowser — tree + breadcrumb + preview dispatch + download + sandboxed html"
```

---

# PART C — Logo 重塑

## Task 7: 渲染 3 个 logo 候选给用户选定

**Files:**
- Create: `frontend/public/logo-candidates/{mux,z-modern,prompt}.svg`（临时，供截图）
- 用 gstack/browse 或直接生成 SVG 文件后截图

**Interfaces:** 无（产出 3 个 SVG + 截图供决策）

- [ ] **Step 1: 生成 3 个候选 SVG**（120×120，保留 #f7b500，lobehub 几何风、单/双色硬朗）

1. **多路复用向（首选）**：圆角方瓦 + 多条线汇聚成 Z 对角线（Z = 多路汇聚隐喻，一符号讲 Zero+Mux）。
2. **Z 现代化向**：黑 Z 重绘为 lobehub squircle，保留品牌延续。
3. **`>_` 终端向**：圆角瓦 + `›_` 提示符。

- [ ] **Step 2: 截图三者并排，呈现给用户**

Run: 用 `browse`/`gstack` 打开一个并排 HTML 或直接渲染 SVG 截图。

- [ ] **Step 3: 用户选定一个方向**

> ⚠️ 这是 taste 分叉,**必须等用户选定后再继续 Task 8**。我内心排序：多路复用 ≥ Z 现代化 > `>_`。

- [ ] **Step 4: 删除未选中的候选文件**

```bash
rm -rf frontend/public/logo-candidates
```

（无提交，候选是临时产物）

---

## Task 8: 落地选定 logo + 一致性替换 + PWA manifest

**Files:**
- Create: `frontend/src/components/BrandLogo.tsx`（替换 `HaringLogo.tsx`）
- Modify: `frontend/public/favicon.svg`、`frontend/index.html`（manifest link + theme-color）、`frontend/src/components/LoginPage.tsx`、`frontend/src/components/Sidebar.tsx`（若用到 logo）、`frontend/src/index.css`（`--accent-brand` 若调）
- Create: `frontend/public/manifest.json` + `frontend/public/icon-192.png` / `icon-512.png`（或 SVG maskable）
- Delete: `frontend/src/components/HaringLogo.tsx`
- Test: `frontend/src/components/__tests__/BrandLogo.test.tsx`

**Interfaces:**
- Produces: `BrandLogo({ size?, className? })`（命名导出，沿用 HaringLogo 签名，零破坏替换）

- [ ] **Step 1: 写失败测试**

```tsx
import { render } from '@testing-library/react'
import { BrandLogo } from '../BrandLogo'
test('BrandLogo renders svg with brand title', () => {
  const { container } = render(<BrandLogo size={28} />)
  const svg = container.querySelector('svg')
  expect(svg).toBeTruthy()
  expect(container.querySelector('title')?.textContent).toBe('ZeroMux')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/BrandLogo.test.tsx`
Expected: 失败（BrandLogo 不存在）。

- [ ] **Step 3: 写实现**

- `BrandLogo.tsx`：选定方向的内联 SVG，保留 `#f7b500`，签名 `{ size=24, className }` 同 HaringLogo（零破坏）。`<title>ZeroMux</title>`。
- 全局替换 `HaringLogo` import/用法 → `BrandLogo`（`grep -rn HaringLogo frontend/src`：`LoginPage.tsx:4,38`），删 `HaringLogo.tsx`。
- `favicon.svg`：同步为新形（保留 #f7b500）。
- `manifest.json`：`{ name:"ZeroMux", short_name:"ZeroMux", theme_color:"#f7b500", background_color:"#11161d", display:"standalone", icons:[{src:"/icon-192.png",sizes:"192x192",type:"image/png"},{src:"/icon-512.png",sizes:"512x512",type:"image/png"}] }`。
- `index.html`：加 `<link rel="manifest" href="/manifest.json" />`，theme-color 保持 `#f7b500`。
- `index.css --accent-brand`：保持 `#f7b500`（除非候选选型微调，默认不动）。

- [ ] **Step 4: 运行确认通过 + lint**

Run: `cd frontend && npx vitest run src/components/__tests__/BrandLogo.test.tsx && npm run lint`
Expected: passed + lint 干净；`grep -rn HaringLogo frontend/src` 无残留。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(brand): reshape logo (lobehub geometric, keep #f7b500) + PWA manifest; drop HaringLogo"
```

---

## Task 9: 全量验证 + 构建 + manifest smoke

**Files:** 全量 + 可选 README

- [ ] **Step 1: 后端全量测试**

Run: `cargo test`
Expected: 全绿（resolve_and_verify symlink 矩阵 / credential / write-block / list_dir / raw headers / CSP）。

- [ ] **Step 2: manifest/favicon smoke 测试**

在 `web.rs` tests 加（防 SPA fallback 吞掉静态资源，content-type 错乱）：

```rust
#[test]
fn manifest_served_as_json_not_html() {
    let resp = try_serve_embedded("manifest.json").expect("manifest must be bundled");
    let ct = resp.headers().get("Content-Type").unwrap().to_str().unwrap();
    assert!(ct.contains("json") || ct.contains("manifest"));
}
```

Run: `cargo test web::tests::manifest_served_as_json_not_html`
Expected: passed（前提：Task 8 的 manifest.json 已进 `frontend/public` 并被 `npm run build` 打包；故本步在 Step 3 构建后再跑）。

- [ ] **Step 3: 前端全量测试 + 构建**

Run: `cd frontend && npm test && npm run build`
Expected: vitest 全绿（KaTeX flaky 除外）；`vite build` 成功 → `frontend/dist/` 含 manifest.json + favicon.svg + icons。

- [ ] **Step 4: CSP 加载冒烟**

Run: `cargo build && ./target/debug/zeromux --port 8099 --password test`（后台），`browse` 打开 `http://localhost:8099` 断言不白屏、控制台无 CSP 拦截报错；停服。
Expected: 正常渲染（CSP 不误伤 Vite 产物）。

- [ ] **Step 5: 提交收尾**

```bash
git add -A
git commit -m "test(files,brand): full suite + manifest smoke + CSP load check green"
```

---

## Self-Review（已对 spec 核查）

**B 覆盖：**
- spec B0 现状校正（写操作已存在）→ Task 6 保留写操作收右键 ✓
- spec B1 写操作保留降权 → Task 6 ✓；安全模型不依赖 UI 隐藏 → Global Constraints 明示 ✓
- spec B2 单层目录端点 → Task 3 ✓
- spec B3 图片 P0 / HTML sandbox P0 / 文本复用 / PDF 砍 / 二进制下载 → Task 4（raw）+ Task 6（预览分发，无 pdf）✓
- spec B4 安全底座（resolve_and_verify / credential 不枚举 / 禁写 / raw 三件套 / sandbox iframe / CSP）→ Task 1,2,3,4,5,6 ✓
  - O_NOFOLLOW/openat2 完整下降标为「缩小窗口 + 留接缝」（Task 1 注）——与 spec「openat2 加固」一致但 MVP 用 canonicalize-recheck，**已在 plan 注明残留窗口与降级理由** ✓
- spec B5 上传修正 + 协同（统一上传 / 拆 MarkdownViewer / Git 跳转接缝 / 发给 agent 接缝）→ Task 2（上传目录）+ Task 6（复用 uploadSessionFile + 拆分；Git 跳转/发给 agent 为 UI 留位接缝，MVP 不接）✓
- spec B7 安全矩阵测试 → Task 1（symlink/credential/write-block）+ Task 3（list 过滤）+ Task 4（raw 头）✓

**C 覆盖：**
- spec C1 三候选选 1 + 排序 → Task 7 ✓
- spec C2 保留 #f7b500 只重塑形 / 不渐变 → Task 8 + Global Constraints ✓
- spec C3 落地 + 一致性 6~7 处 + manifest + 工程坑 → Task 8 + Task 9（manifest smoke）✓
- spec C5 测试（manifest content-type / BrandLogo 渲染）→ Task 8 + Task 9 ✓

**Placeholder 扫描**：无 TBD；每个 code step 有完整代码。Task 7 是 taste 决策门（有意停顿等用户选），非 placeholder。
**类型一致性**：`resolve_and_verify` / `is_credential_path` / `is_write_blocked` / `split_upload_target` / `list_dir_entries` / `build_raw_headers` / `BrandLogo` 跨任务签名一致 ✓
**已知前提**：raw 头测试与 manifest smoke 依赖构建产物，已在 Task 9 排在 `npm run build` 之后跑。
