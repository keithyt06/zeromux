# Obsidian Vault 只读阅读器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ZeroMux 里加一个 admin-only、只读的 Obsidian vault 阅读器:浏览目录树、文件名搜索、双链跳转、Markdown 渲染(含图片),手机两段式阅读布局;并消除 feynote「笔记」入口的死路。

**Architecture:** 后端新增一组不绑 session 的 `/api/vault/*` 只读端点(admin-only),强制复用现有 path/敏感/凭证安全 helper,只新抽读取段与启动校验段;`--vault-dir` 配置 + 双链 basename 索引。前端新增全局 `VaultReader` 面板(仿 AdminPanel),`MarkdownContent` 加两个可选 prop(`resolveSrc` 图片、`onWikiLink` 双链)默认不影响 agent 聊天。

**Tech Stack:** Rust / Axum 0.8 / clap / `std::fs` + `std::process`;React 19 / TS / Tailwind v4 / react-markdown v10 / vitest。

## Global Constraints

- **只读**:vault 端点绝不写任何文件;无新建/编辑/删除/上传/重命名 UI。
- **admin-only**:每个 vault 端点开头 `if !user.is_admin() { 403 }`。legacy 模式 `CurrentUser::legacy()` 是合成 admin(role="admin")→ 单用户无感。
- **强制复用安全 helper,禁止重写路径/敏感/凭证判定**:`resolve_and_verify`、`list_dir_entries`、`descends_into_sensitive_dir`、`is_credential_path`(均在 src/web.rs)。只可新抽"读取段"与"启动校验段"。
- **图片端点不照抄 `get_file_raw`**:白名单 `png/jpg/jpeg/gif/webp` 发真实 `image/<t>` + inline(去 attachment);白名单外(含 `.svg`)仍 `octet-stream + attachment + nosniff`。
- **`--vault-dir` 无代码默认值**(`Option<String>`);未配置则功能禁用(`meta.enabled=false`,端点 404)。live 路径由 systemd unit 注入。
- `MarkdownContent` 新增 prop 必须可选且默认行为不变(agent 聊天渲染路径零影响)。
- 后端 `cargo test`(单 filter)/`cargo build`(debug,勿 release 迭代);前端改 `.ts/.tsx` 后必跑 `npx tsc -b`;中文 UI 字符串 / 英文代码注释。
- 提交信息结尾:`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 当前分支 `feat/obsidian-vault-reader`(spec 已在此分支)。

---

## File Structure

后端(`src/`):
- `main.rs` — `Args.vault_dir: Option<String>` + 启动校验(调 `validate_browse_root`)+ `AppState.vault_dir/vault_index`。
- `web.rs` — 抽 `read_text_file_capped` + `validate_browse_root`(`ensure_under_home` 改为调它);`VaultIndex` 类型 + 构建;6 个 vault handler + admin 守卫 + 图片白名单 header;路由注册。

前端(`frontend/src/`):
- `lib/api.ts` — 6 个 vault 客户端 + 类型。
- `lib/vault.ts`(新建) — 纯函数:`shouldShowVault`、`filterVaultEntries`、`resolveVaultImageSrc`、最近打开 localStorage 读写。
- `components/markdownStyles.tsx` 或 `components/markdown/MarkdownContent.tsx` — img/wikilink 注入点(走 MarkdownContent 的 components 合并 + 新 prop)。
- `components/markdown/MarkdownContent.tsx` — 加可选 `resolveSrc` + `onWikiLink`。
- `components/VaultReader.tsx`(新建) — 两段式只读阅读面板。
- `components/Sidebar.tsx` — 「Obsidian」入口(meta-gated)+ showVault。

feynote:
- `/home/ubuntu/feynote/frontend/index.html` — header 加「📓 我的笔记 / Obsidian」链接到 zeromux(消除死路;注:现状根本没有该按钮,footer 写"待接入")。

部署:
- live systemd unit `ExecStart` 追加 `--vault-dir /home/ubuntu/s3-workspace/keith-space/obsidian`。

---

## Task 1: 后端 `read_text_file_capped` + `validate_browse_root` 抽取

**Files:**
- Modify: `src/web.rs`(`get_session_file` ~842、`ensure_under_home` ~953 附近)

**Interfaces:**
- Produces:
  - `fn read_text_file_capped(file_path: &std::path::Path) -> Result<(String, bool), (StatusCode, String)>` —— 读文本,>1MB 时读前 1MB 并返回 `truncated=true`。
  - `fn validate_browse_root(dir: &str) -> Result<std::path::PathBuf, (StatusCode, String)>` —— `ensure_under_home` 的判定核心(canonicalize + 在 $HOME 下 + is_dir + 非敏感)。
- 二者供 session 端点与 vault 端点(及启动校验)共用,杜绝漂移。

- [ ] **Step 1: 写失败测试**

`src/web.rs` 的 `#[cfg(test)] mod path_safety_tests`(~2380)里加:

```rust
#[test]
fn read_text_file_capped_truncates_over_1mb() {
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!("zmx_cap_test_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let big = dir.join("big.md");
    let mut f = std::fs::File::create(&big).unwrap();
    f.write_all(&vec![b'x'; 1_048_576 + 100]).unwrap();
    let (content, truncated) = read_text_file_capped(&big).unwrap();
    assert!(truncated);
    assert_eq!(content.len(), 1_048_576);
    let small = dir.join("small.md");
    std::fs::write(&small, b"hello").unwrap();
    let (c2, t2) = read_text_file_capped(&small).unwrap();
    assert!(!t2);
    assert_eq!(c2, "hello");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn validate_browse_root_accepts_normal_rejects_sensitive() {
    let home = std::env::var("HOME").unwrap();
    // a normal existing dir under home: home itself's parent won't do; use home/.. is outside.
    // Use HOME itself (a dir under home boundary check: home starts_with home = ok, is_dir ok,
    // but base_dir_at_or_in_sensitive(home, home) → rel empty → false → accepted).
    assert!(validate_browse_root(&home).is_ok());
    let ssh = format!("{}/.ssh", home);
    std::fs::create_dir_all(&ssh).ok();
    assert!(validate_browse_root(&ssh).is_err()); // sensitive
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test read_text_file_capped 2>&1 | tail -15`
Expected: 编译错误(两函数未定义)。

- [ ] **Step 3: 抽取实现**

在 `src/web.rs` 加(放在 `get_session_file` 之前):

```rust
/// Read a text file, capping at 1MB. Over the cap, returns the first 1MB on a
/// char boundary plus truncated=true (reader scenario: partial beats nothing).
fn read_text_file_capped(
    file_path: &std::path::Path,
) -> Result<(String, bool), (StatusCode, String)> {
    let bytes = std::fs::read(file_path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("File not found: {}", e)))?;
    const CAP: usize = 1_048_576;
    if bytes.len() <= CAP {
        let s = String::from_utf8_lossy(&bytes).to_string();
        return Ok((s, false));
    }
    let mut end = CAP;
    while end > 0 && !bytes.is_char_boundary_compat(end) {
        end -= 1;
    }
    let s = String::from_utf8_lossy(&bytes[..end]).to_string();
    Ok((s, true))
}
```

注意 `is_char_boundary` 是 `str` 的方法,不是 `&[u8]`。改用对 `&[u8]` 安全的方式:直接 `String::from_utf8_lossy(&bytes[..CAP])`(lossy 会把截断处的半个多字节替换成 U+FFFD,安全无 panic)。即把上面替换为:

```rust
fn read_text_file_capped(
    file_path: &std::path::Path,
) -> Result<(String, bool), (StatusCode, String)> {
    let bytes = std::fs::read(file_path)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("File not found: {}", e)))?;
    const CAP: usize = 1_048_576;
    if bytes.len() <= CAP {
        Ok((String::from_utf8_lossy(&bytes).to_string(), false))
    } else {
        Ok((String::from_utf8_lossy(&bytes[..CAP]).to_string(), true))
    }
}
```

把 `validate_browse_root` 从 `ensure_under_home` 抽出:把 `ensure_under_home`(~953)的函数体整体改名为 `validate_browse_root`,然后让 `ensure_under_home` 变成薄包装:

```rust
fn ensure_under_home(dir: &str) -> Result<std::path::PathBuf, (StatusCode, String)> {
    validate_browse_root(dir)
}

/// Canonicalize + assert under $HOME + is a directory + not a sensitive dir.
/// Shared by HTTP base-dir validation and startup --vault-dir validation.
fn validate_browse_root(dir: &str) -> Result<std::path::PathBuf, (StatusCode, String)> {
    // ... (原 ensure_under_home 的完整函数体,逐行不动) ...
}
```

(`get_session_file` 的 size 检查 + `read_to_string` 段可选改用 `read_text_file_capped`,但**本任务不改 session 端点行为**——session 仍 >1MB 报 400。只新增共用函数。session 端点改用留给将来,避免本任务扩面。)

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test read_text_file_capped 2>&1 | tail -10 && cargo test validate_browse_root 2>&1 | tail -10`
Expected: 两测 PASS。

- [ ] **Step 5: 编译**

Run: `cargo build 2>&1 | tail -5`
Expected: 成功。

- [ ] **Step 6: 提交**

```bash
git add src/web.rs
git commit -m "refactor(web): extract read_text_file_capped + validate_browse_root for reuse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端配置 `--vault-dir` + AppState + 启动校验

**Files:**
- Modify: `src/main.rs`(`Args` ~27、`AppState` ~124、构造 ~308)

**Interfaces:**
- Consumes: `validate_browse_root`(Task 1)。
- Produces: `AppState.vault_dir: Option<String>`(canonical 绝对路径,校验通过才有值)。`VaultIndex` 字段在 Task 3 加。

- [ ] **Step 1: 加 Args 字段**

`src/main.rs` `Args` 结构体(~27,在 `data_dir` 附近)加:

```rust
    /// Obsidian vault directory to serve read-only (admin-only). No default;
    /// omitted = vault reader disabled. Must be under $HOME and not sensitive.
    #[arg(long)]
    vault_dir: Option<String>,
```

- [ ] **Step 2: 加 AppState 字段**

`AppState`(~124)加:

```rust
    pub vault_dir: Option<String>,
```

- [ ] **Step 3: 启动校验 + 构造**

在 `let state = Arc::new(AppState {` 之前,加 vault_dir 解析(仿 data_dir 的 `~` 展开 ~192):

```rust
    let vault_dir: Option<String> = args.vault_dir.as_ref().and_then(|v| {
        let expanded = if v.starts_with("~/") {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".into());
            v.replacen("~", &home, 1)
        } else {
            v.clone()
        };
        match web::validate_browse_root(&expanded) {
            Ok(p) => Some(p.to_string_lossy().to_string()),
            Err((_, msg)) => {
                eprintln!("[vault] --vault-dir ignored ({}): {}", expanded, msg);
                None
            }
        }
    });
    if let Some(ref v) = vault_dir {
        println!("[vault] serving read-only vault: {}", v);
    }
```

注意:`validate_browse_root` 当前是 `web.rs` 内的私有 fn → 需改 `pub(crate) fn validate_browse_root`。在 Task 1 抽取时即设为 `pub(crate)`(回到 Task 1 确保签名是 `pub(crate)`;若已写成私有,这里改一下并在 Task 1 报告注明)。

`AppState { ... }` 构造里加:

```rust
        vault_dir,
```

- [ ] **Step 4: 编译**

Run: `cargo build 2>&1 | tail -8`
Expected: 成功。可选手动验证:`./target/debug/zeromux --help | grep vault`,以及用一个临时目录 `--vault-dir /tmp` 启动看是否被拒(/tmp 不在 $HOME → ignored 日志)。

- [ ] **Step 5: 提交**

```bash
git add src/main.rs src/web.rs
git commit -m "feat(vault): --vault-dir config with startup validation + AppState field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 后端双链索引 `VaultIndex`

**Files:**
- Modify: `src/web.rs`(新增 `VaultIndex` + 构建函数)、`src/main.rs`(`AppState.vault_index` + 启动构建)

**Interfaces:**
- Produces:
  - `pub struct VaultIndex { pub by_basename: std::collections::HashMap<String, String> }`(basename 无扩展名 → vault 相对路径)。
  - `fn build_vault_index(vault_dir: &std::path::Path) -> VaultIndex`(递归遍历 `.md`,basename 冲突保留第一个)。
  - `AppState.vault_index: Option<std::sync::Arc<VaultIndex>>`。

- [ ] **Step 1: 写失败测试**

`src/web.rs` 测试 mod 加:

```rust
#[test]
fn build_vault_index_maps_basename_to_relpath() {
    let dir = std::env::temp_dir().join(format!("zmx_vidx_{}", std::process::id()));
    std::fs::create_dir_all(dir.join("knowledge/aws")).unwrap();
    std::fs::write(dir.join("knowledge/aws/EKS 网络模型.md"), b"x").unwrap();
    std::fs::write(dir.join("待处理区.md"), b"y").unwrap();
    let idx = build_vault_index(&dir);
    assert_eq!(idx.by_basename.get("EKS 网络模型").map(|s| s.as_str()),
               Some("knowledge/aws/EKS 网络模型.md"));
    assert_eq!(idx.by_basename.get("待处理区").map(|s| s.as_str()), Some("待处理区.md"));
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test build_vault_index 2>&1 | tail -15`
Expected: 编译错误(未定义)。

- [ ] **Step 3: 实现**

`src/web.rs` 加:

```rust
pub struct VaultIndex {
    pub by_basename: std::collections::HashMap<String, String>,
}

/// Walk the vault recursively, mapping each .md file's basename (sans extension)
/// to its vault-relative path. On basename collision the first seen wins
/// (Obsidian itself disambiguates by proximity; phase 1 keeps it simple).
fn build_vault_index(vault_dir: &std::path::Path) -> VaultIndex {
    let mut by_basename = std::collections::HashMap::new();
    let mut stack = vec![vault_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) { Ok(r) => r, Err(_) => continue };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; } // skip .obsidian/.trash/.git
            if path.is_dir() {
                stack.push(path);
            } else if name.to_ascii_lowercase().ends_with(".md") {
                if let Ok(rel) = path.strip_prefix(vault_dir) {
                    let base = name.trim_end_matches(".md").trim_end_matches(".MD").to_string();
                    by_basename.entry(base)
                        .or_insert_with(|| rel.to_string_lossy().to_string());
                }
            }
        }
    }
    VaultIndex { by_basename }
}
```

`src/main.rs`:`AppState` 加 `pub vault_index: Option<std::sync::Arc<web::VaultIndex>>;`;构造前:

```rust
    let vault_index = vault_dir.as_ref().map(|v| {
        std::sync::Arc::new(web::build_vault_index(std::path::Path::new(v)))
    });
```

构造里加 `vault_index,`。`VaultIndex` + `build_vault_index` 设 `pub(crate)`(供 main.rs 调)。

- [ ] **Step 4: 跑测试 + 编译**

Run: `cargo test build_vault_index 2>&1 | tail -10 && cargo build 2>&1 | tail -5`
Expected: PASS + 编译成功。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs src/main.rs
git commit -m "feat(vault): basename->relpath wikilink index built at startup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 后端 vault 端点(meta/list/file/search/resolve)+ admin 守卫

**Files:**
- Modify: `src/web.rs`(5 个 handler + 路由)

**Interfaces:**
- Consumes: `validate_browse_root`/`read_text_file_capped`(T1)、`VaultIndex`(T3)、`resolve_and_verify`/`list_dir_entries`/`descends_into_sensitive_dir`/`is_credential_path`(现有)、`DirEntryOut`(现有)、`CurrentUser::is_admin`(auth.rs)。
- Produces 路由:
  - `GET /api/vault/meta` → `{ enabled: bool, name: String }`
  - `GET /api/vault/list?path=<rel>` → `{ entries: [...], truncated: bool }`
  - `GET /api/vault/file?path=<rel>` → `{ path, content, truncated }`
  - `GET /api/vault/search?q=<query>` → `{ results: [{ path, name }] }`
  - `GET /api/vault/resolve?name=<basename>` → `{ path: String }` | 404
- 图片 raw 端点单列 Task 5。

- [ ] **Step 1: 写失败测试(admin 守卫纯逻辑 + search 匹配)**

端点依赖 AppState/真实目录,难直接单测;把可单测的 search 匹配抽成纯函数测:

```rust
#[test]
fn vault_search_matches_name_and_path() {
    let idx_paths = vec![
        "knowledge/aws/EKS 网络模型.md".to_string(),
        "journals/2026-06-29.md".to_string(),
    ];
    let r = vault_search_filter(&idx_paths, "eks");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0], "knowledge/aws/EKS 网络模型.md");
    let r2 = vault_search_filter(&idx_paths, "journals");
    assert_eq!(r2.len(), 1);
    let r3 = vault_search_filter(&idx_paths, "");
    assert_eq!(r3.len(), 0); // empty query → no results
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test vault_search_matches 2>&1 | tail -15`
Expected: 编译错误(`vault_search_filter` 未定义)。

- [ ] **Step 3: 实现纯函数 + handler + 路由**

`src/web.rs` 加纯函数:

```rust
/// Case-insensitive substring match over relative paths (filename + path).
/// Empty query → no results. Caps at 100.
fn vault_search_filter(paths: &[String], q: &str) -> Vec<String> {
    if q.trim().is_empty() { return Vec::new(); }
    let ql = q.to_ascii_lowercase();
    paths.iter()
        .filter(|p| p.to_ascii_lowercase().contains(&ql))
        .take(100)
        .cloned()
        .collect()
}
```

加一个 admin+enabled 守卫小函数:

```rust
/// vault endpoints: require admin (legacy mode synthesizes admin) and a configured vault.
fn vault_base<'a>(state: &'a AppState, user: &CurrentUser) -> Result<&'a str, (StatusCode, String)> {
    if !user.is_admin() {
        return Err((StatusCode::FORBIDDEN, "Admin only".into()));
    }
    state.vault_dir.as_deref()
        .ok_or((StatusCode::NOT_FOUND, "Vault not configured".into()))
}
```

handlers(均取 `user: axum::Extension<CurrentUser>`):

```rust
async fn vault_meta(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Json<serde_json::Value> {
    let enabled = user.is_admin() && state.vault_dir.is_some();
    let name = state.vault_dir.as_deref()
        .and_then(|v| std::path::Path::new(v).file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_default();
    Json(serde_json::json!({ "enabled": enabled, "name": name }))
}

#[derive(serde::Deserialize)]
struct VaultListQuery { path: Option<String> }

async fn vault_list(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<VaultListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let base = vault_base(&state, &user)?;
    let base_path = std::path::Path::new(base);
    let (entries, truncated) = list_dir_entries(base_path, q.path.as_deref().unwrap_or(""))?;
    Ok(Json(serde_json::json!({ "entries": entries, "truncated": truncated })))
}

#[derive(serde::Deserialize)]
struct VaultFileQuery { path: String }

async fn vault_file(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<VaultFileQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let base = vault_base(&state, &user)?;
    let base_path = std::path::Path::new(base);
    let real = resolve_and_verify(base_path, &q.path)?;
    if descends_into_sensitive_dir(base_path, &real) {
        return Err((StatusCode::FORBIDDEN, "Access to sensitive directory denied".into()));
    }
    if let Some(n) = real.file_name().and_then(|s| s.to_str()) {
        if is_credential_path(n) {
            return Err((StatusCode::FORBIDDEN, "Credential file access denied".into()));
        }
    }
    let (content, truncated) = read_text_file_capped(&real)?;
    Ok(Json(serde_json::json!({ "path": q.path, "content": content, "truncated": truncated })))
}

#[derive(serde::Deserialize)]
struct VaultSearchQuery { q: String }

async fn vault_search(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(query): Query<VaultSearchQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _base = vault_base(&state, &user)?;
    let paths: Vec<String> = state.vault_index.as_ref()
        .map(|idx| idx.by_basename.values().cloned().collect())
        .unwrap_or_default();
    let results: Vec<serde_json::Value> = vault_search_filter(&paths, &query.q).into_iter()
        .map(|p| {
            let name = std::path::Path::new(&p).file_name()
                .map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            serde_json::json!({ "path": p, "name": name })
        })
        .collect();
    Ok(Json(serde_json::json!({ "results": results })))
}

#[derive(serde::Deserialize)]
struct VaultResolveQuery { name: String }

async fn vault_resolve(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<VaultResolveQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _base = vault_base(&state, &user)?;
    let path = state.vault_index.as_ref()
        .and_then(|idx| idx.by_basename.get(&q.name).cloned())
        .ok_or((StatusCode::NOT_FOUND, "Wikilink target not found".into()))?;
    Ok(Json(serde_json::json!({ "path": path })))
}
```

注意 `vault_search` 用索引的 values 做 path 池(只含 `.md`,够文件名搜索);若想搜目录树全部文件,可改遍历——一期 `.md` 足够。

路由(`src/web.rs` 的 `let api = Router::new()` 组里,git/worktree 那行附近加):

```rust
        .route("/api/vault/meta", get(vault_meta))
        .route("/api/vault/list", get(vault_list))
        .route("/api/vault/file", get(vault_file))
        .route("/api/vault/search", get(vault_search))
        .route("/api/vault/resolve", get(vault_resolve))
```

- [ ] **Step 4: 跑测试 + 编译**

Run: `cargo test vault_search 2>&1 | tail -10 && cargo build 2>&1 | tail -5`
Expected: PASS + 编译成功。

- [ ] **Step 5: 全量后端测试(无回归)**

Run: `cargo test 2>&1 | tail -6`
Expected: 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/web.rs
git commit -m "feat(vault): admin-only read-only endpoints (meta/list/file/search/resolve)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 后端 vault 图片 raw 端点(白名单 Content-Type)

**Files:**
- Modify: `src/web.rs`(1 个 handler + 路由 + 扩展名→MIME helper)

**Interfaces:**
- Consumes: `vault_base`、`resolve_and_verify`、`descends_into_sensitive_dir`、`is_credential_path`、`sanitize_filename`(现有,get_file_raw 用过)。
- Produces: `GET /api/vault/file/raw?path=<rel>` → 图片 inline(白名单)或 attachment(其余)。`fn vault_image_mime(name: &str) -> Option<&'static str>`。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn vault_image_mime_whitelist() {
    assert_eq!(vault_image_mime("a.png"), Some("image/png"));
    assert_eq!(vault_image_mime("A.JPG"), Some("image/jpeg"));
    assert_eq!(vault_image_mime("b.jpeg"), Some("image/jpeg"));
    assert_eq!(vault_image_mime("c.gif"), Some("image/gif"));
    assert_eq!(vault_image_mime("d.webp"), Some("image/webp"));
    assert_eq!(vault_image_mime("e.svg"), None);  // SVG not inlined (XSS)
    assert_eq!(vault_image_mime("f.md"), None);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test vault_image_mime 2>&1 | tail -15`
Expected: 编译错误。

- [ ] **Step 3: 实现**

```rust
/// Whitelist of inline-renderable image types for the vault raw endpoint.
/// SVG is deliberately excluded (executable XSS vector) → falls back to download.
fn vault_image_mime(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".png") { Some("image/png") }
    else if n.ends_with(".jpg") || n.ends_with(".jpeg") { Some("image/jpeg") }
    else if n.ends_with(".gif") { Some("image/gif") }
    else if n.ends_with(".webp") { Some("image/webp") }
    else { None }
}

async fn vault_file_raw(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Query(q): Query<VaultFileQuery>,
) -> Result<Response, (StatusCode, String)> {
    let base = vault_base(&state, &user)?;
    let base_path = std::path::Path::new(base);
    let real = resolve_and_verify(base_path, &q.path)?;
    if descends_into_sensitive_dir(base_path, &real) {
        return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    let fname = real.file_name().and_then(|s| s.to_str()).unwrap_or("download");
    if is_credential_path(fname) {
        return Err((StatusCode::FORBIDDEN, "Forbidden".into()));
    }
    let bytes = std::fs::read(&real)
        .map_err(|e| (StatusCode::NOT_FOUND, format!("Not found: {e}")))?;
    let resp = match vault_image_mime(fname) {
        Some(mime) => Response::builder()
            .header("Content-Type", mime)
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Disposition", "inline")
            .body(axum::body::Body::from(bytes)).unwrap(),
        None => {
            // non-image (incl. svg): force download, never inline-render
            let safe = sanitize_filename(fname);
            Response::builder()
                .header("Content-Type", "application/octet-stream")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Disposition", format!("attachment; filename=\"{}\"", safe))
                .body(axum::body::Body::from(bytes)).unwrap()
        }
    };
    Ok(resp)
}
```

路由加:`.route("/api/vault/file/raw", get(vault_file_raw))`。`VaultFileQuery` 已在 T4 定义,复用。

注意 raw 端点没有 cookie/header 鉴权时,前端 `<img>` 走 `?token=` query(同 `fileRawUrl` 模式)——auth_middleware 是否支持 query token?**核实**:`get_file_raw` 的前端 `fileRawUrl` 已用 `?token=`,说明中间件支持。vault raw 同理。

- [ ] **Step 4: 跑测试 + 编译**

Run: `cargo test vault_image_mime 2>&1 | tail -10 && cargo build 2>&1 | tail -5`
Expected: PASS + 编译成功。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(vault): image raw endpoint with inline whitelist (svg excluded)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 前端 API + 纯函数 lib

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/vault.ts`
- Test: `frontend/src/lib/__tests__/vault.test.ts`

**Interfaces:**
- Produces (api.ts):
  - `getVaultMeta(): Promise<{ enabled: boolean; name: string }>`
  - `listVault(path?: string): Promise<{ entries: DirListEntry[]; truncated: boolean }>`
  - `getVaultFile(path: string): Promise<{ content: string; truncated: boolean }>`
  - `getVaultSearch(q: string): Promise<{ results: { path: string; name: string }[] }>`
  - `resolveWikiLink(name: string): Promise<string | null>`
  - `vaultRawUrl(path: string): string`
- Produces (vault.ts): `shouldShowVault(meta)`, `filterVaultEntries(entries)`, `resolveVaultImageSrc(src, noteRelPath)`, `getRecentNotes()/pushRecentNote(path)`。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/vault.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { shouldShowVault, filterVaultEntries, resolveVaultImageSrc, getRecentNotes, pushRecentNote } from '../vault'

describe('shouldShowVault', () => {
  it('true only when enabled', () => {
    expect(shouldShowVault({ enabled: true, name: 'obsidian' })).toBe(true)
    expect(shouldShowVault({ enabled: false, name: '' })).toBe(false)
    expect(shouldShowVault(null)).toBe(false)
  })
})

describe('filterVaultEntries', () => {
  it('keeps dirs and .md, drops dotdirs and non-md files', () => {
    const e = [
      { name: '.obsidian', type: 'dir', size: 0, mtime: 0, writable: false },
      { name: 'knowledge', type: 'dir', size: 0, mtime: 0, writable: false },
      { name: 'a.md', type: 'file', size: 1, mtime: 0, writable: false },
      { name: 'b.png', type: 'file', size: 1, mtime: 0, writable: false },
    ] as any
    const r = filterVaultEntries(e)
    expect(r.map((x: any) => x.name)).toEqual(['knowledge', 'a.md'])
  })
})

describe('resolveVaultImageSrc', () => {
  it('rewrites relative src to vault raw url, leaves absolute alone', () => {
    const out = resolveVaultImageSrc('attachments/x.png', 'knowledge/aws/note.md')
    expect(out).toContain('/api/vault/file/raw')
    expect(out).toContain('knowledge%2Faws%2Fattachments%2Fx.png')
    expect(resolveVaultImageSrc('https://x/y.png', 'a.md')).toBe('https://x/y.png')
  })
})

describe('recent notes', () => {
  beforeEach(() => localStorage.clear())
  it('pushes most-recent-first, dedupes, caps 10', () => {
    pushRecentNote('a.md'); pushRecentNote('b.md'); pushRecentNote('a.md')
    expect(getRecentNotes()).toEqual(['a.md', 'b.md'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/vault.test.ts 2>&1 | tail -15`
Expected: FAIL(`../vault` 不存在)。

- [ ] **Step 3: 实现 vault.ts + api.ts**

`frontend/src/lib/vault.ts`:

```ts
import type { DirListEntry } from './api'
import { vaultRawUrl } from './api'

export function shouldShowVault(meta: { enabled: boolean; name: string } | null): boolean {
  return !!meta && meta.enabled
}

// Reader tree shows directories and .md only; hide dot-dirs (.obsidian/.trash).
export function filterVaultEntries(entries: DirListEntry[]): DirListEntry[] {
  return entries.filter(e => {
    if (e.name.startsWith('.')) return false
    if (e.type === 'dir') return true
    return e.name.toLowerCase().endsWith('.md')
  })
}

// Rewrite a relative image src (relative to the note's dir) to the vault raw URL.
// Absolute URLs (http/https/data) pass through untouched.
export function resolveVaultImageSrc(src: string, noteRelPath: string): string {
  if (/^(https?:|data:|\/)/.test(src)) return src
  const noteDir = noteRelPath.includes('/') ? noteRelPath.slice(0, noteRelPath.lastIndexOf('/')) : ''
  const joined = noteDir ? `${noteDir}/${src}` : src
  // normalize ./ and ../ minimally
  const parts: string[] = []
  for (const seg of joined.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return vaultRawUrl(parts.join('/'))
}

const RECENT_KEY = 'zmx-vault-recent'
export function getRecentNotes(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { return [] }
}
export function pushRecentNote(path: string): void {
  const cur = getRecentNotes().filter(p => p !== path)
  cur.unshift(path)
  localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 10)))
}
```

`frontend/src/lib/api.ts`(在 git worktree 客户端附近加):

```ts
export async function getVaultMeta(): Promise<{ enabled: boolean; name: string }> {
  const res = await api('/api/vault/meta')
  if (!res.ok) return { enabled: false, name: '' }
  return res.json()
}
export async function listVault(path = ''): Promise<{ entries: DirListEntry[]; truncated: boolean }> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const qs = params.toString()
  const res = await api(`/api/vault/list${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function getVaultFile(path: string): Promise<{ content: string; truncated: boolean }> {
  const res = await api(`/api/vault/file?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error(await res.text())
  const d = await res.json()
  return { content: d.content, truncated: d.truncated }
}
export async function getVaultSearch(q: string): Promise<{ results: { path: string; name: string }[] }> {
  const res = await api(`/api/vault/search?q=${encodeURIComponent(q)}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
export async function resolveWikiLink(name: string): Promise<string | null> {
  const res = await api(`/api/vault/resolve?name=${encodeURIComponent(name)}`)
  if (!res.ok) return null
  const d = await res.json()
  return d.path ?? null
}
export function vaultRawUrl(path: string): string {
  const token = getToken()
  const jwt = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('zeromux_jwt='))?.split('=')[1] || ''
  const authToken = token || jwt
  const params = new URLSearchParams({ path })
  if (authToken) params.set('token', authToken)
  return `/api/vault/file/raw?${params}`
}
```

(`getToken` / `DirListEntry` 已存在于 api.ts;若 `getToken` 名称不同,对齐 `fileRawUrl` 里的取法。)

- [ ] **Step 4: 跑测试 + tsc**

Run: `cd frontend && npx vitest run src/lib/__tests__/vault.test.ts 2>&1 | tail -10 && npx tsc -b 2>&1 | tail -5`
Expected: 测试 PASS;tsc 无错。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/vault.ts frontend/src/lib/__tests__/vault.test.ts
git commit -m "feat(vault-ui): api client + pure helpers (filter/image-src/recent)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 前端 MarkdownContent 扩展(resolveSrc + onWikiLink)

**Files:**
- Modify: `frontend/src/components/markdown/MarkdownContent.tsx`、`frontend/src/components/markdownStyles.tsx`
- Test: `frontend/src/components/markdown/__tests__/MarkdownContent.vault.test.tsx`

**Interfaces:**
- Produces: `MarkdownContent` 新增可选 props `resolveSrc?: (src: string) => string` 与 `onWikiLink?: (basename: string) => void`;默认 undefined → 行为不变(agent 聊天零影响)。

- [ ] **Step 1: 写失败测试**

`frontend/src/components/markdown/__tests__/MarkdownContent.vault.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MarkdownContent from '../MarkdownContent'

describe('MarkdownContent vault props', () => {
  it('rewrites image src via resolveSrc', () => {
    render(<MarkdownContent text={'![](x.png)'} isComplete resolveSrc={(s) => `/api/vault/file/raw?path=${s}`} />)
    const img = document.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/vault/file/raw?path=x.png')
  })
  it('renders [[wikilink]] clickable and fires onWikiLink', () => {
    const cb = vi.fn()
    render(<MarkdownContent text={'see [[EKS 网络模型]] here'} isComplete onWikiLink={cb} />)
    const link = screen.getByText('EKS 网络模型')
    fireEvent.click(link)
    expect(cb).toHaveBeenCalledWith('EKS 网络模型')
  })
  it('without onWikiLink, [[x]] stays plain text', () => {
    render(<MarkdownContent text={'see [[X]] here'} isComplete />)
    expect(document.body.textContent).toContain('[[X]]')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/MarkdownContent.vault.test.tsx 2>&1 | tail -20`
Expected: FAIL(props 未实现)。

- [ ] **Step 3: 实现**

`MarkdownContent.tsx`:Props(~26)加:

```tsx
  resolveSrc?: (src: string) => string
  onWikiLink?: (basename: string) => void
```

签名(~35)解构加 `resolveSrc, onWikiLink`。

双链:在 `rendered` 文本进入 ReactMarkdown 前,**仅当 `onWikiLink` 存在**时,把 `[[basename]]` 替换为一个可被 components 捕获的标记。最简实现:用一个自定义 remark 风格不易;改用**渲染后字符串预处理 + 自定义 component 不可行**。改用最稳的:`onWikiLink` 存在时,把 `[[X]]` 转成 markdown 链接 `[X](#wikilink:X)`,并在 `components.a` 里拦截 `href` 以 `#wikilink:` 开头的点击。

在 MarkdownContent 里:

```tsx
  const wikiText = onWikiLink
    ? rendered.replace(/\[\[([^\]]+)\]\]/g, (_m, name) => `[${name}](#wikilink:${encodeURIComponent(name)})`)
    : rendered
```

把 `<ReactMarkdown>{rendered}` 改为 `{wikiText}`。

`components` 合并(~70)改为注入 img 与 a override(仅当对应回调存在时覆盖,否则用 markdownStyles 默认):

```tsx
  const vaultComponents = {
    ...markdownComponents,
    code: CodeBlock,
    ...(resolveSrc ? {
      img: (props: any) => <img {...props} src={resolveSrc(props.src || '')} />,
    } : {}),
    ...(onWikiLink ? {
      a: (props: any) => {
        const href: string = props.href || ''
        if (href.startsWith('#wikilink:')) {
          const name = decodeURIComponent(href.slice('#wikilink:'.length))
          return <a href="#" onClick={(e) => { e.preventDefault(); onWikiLink(name) }}
                    className="text-[var(--accent-blue)] underline cursor-pointer">{props.children}</a>
        }
        return (markdownComponents.a as any)(props)
      },
    } : {}),
  }
```

`<ReactMarkdown components={vaultComponents}>`。

(注意:react-markdown v10 的 `urlTransform` 默认会清洗非常规 scheme;`#wikilink:` 是 fragment,以 `#` 开头,应被保留——若被清洗,改用 `data-` 属性方案或给 ReactMarkdown 传 `urlTransform={(u) => u}`。实现时若双链测试因 url 清洗失败,加 `urlTransform={(url) => url}` 到这个 ReactMarkdown 实例,**但仅当传了 onWikiLink/resolveSrc**,不改默认实例。)

- [ ] **Step 4: 跑测试 + tsc**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/MarkdownContent.vault.test.tsx 2>&1 | tail -12 && npx tsc -b 2>&1 | tail -5`
Expected: 3 测 PASS;tsc 无错。

- [ ] **Step 5: 全量前端测试(无回归,尤其 agent 聊天渲染)**

Run: `cd frontend && npx vitest run 2>&1 | grep -E "Test Files|Tests " | tail -5`
Expected: 全绿(已知 KaTeX flaky 除外)。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/markdown/MarkdownContent.tsx frontend/src/components/markdownStyles.tsx frontend/src/components/markdown/__tests__/MarkdownContent.vault.test.tsx
git commit -m "feat(vault-ui): MarkdownContent resolveSrc + onWikiLink (opt-in, no chat impact)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 前端 VaultReader 面板 + 侧栏入口

**Files:**
- Create: `frontend/src/components/VaultReader.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`
- Test: `frontend/src/components/__tests__/VaultReader.test.tsx`

**Interfaces:**
- Consumes: api(`getVaultMeta/listVault/getVaultFile/getVaultSearch/resolveWikiLink/vaultRawUrl`)、vault.ts(`filterVaultEntries/resolveVaultImageSrc/getRecentNotes/pushRecentNote/shouldShowVault`)、`MarkdownContent`(T7 props)。
- Produces: `VaultReader({ onClose })` 全局只读面板。

- [ ] **Step 1: 写失败测试(只读断言 + 渲染冒烟)**

`frontend/src/components/__tests__/VaultReader.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import VaultReader from '../VaultReader'

vi.mock('../../lib/api', () => ({
  listVault: vi.fn(async () => ({ entries: [{ name: 'note.md', type: 'file', size: 1, mtime: 0, writable: false }], truncated: false })),
  getVaultFile: vi.fn(async () => ({ content: '# Hello', truncated: false })),
  getVaultSearch: vi.fn(async () => ({ results: [] })),
  resolveWikiLink: vi.fn(async () => null),
  vaultRawUrl: (p: string) => `/api/vault/file/raw?path=${p}`,
}))

describe('VaultReader', () => {
  beforeEach(() => localStorage.clear())
  it('renders directory tree and is read-only (no edit/upload/delete)', async () => {
    render(<VaultReader onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('note.md')).toBeInTheDocument())
    expect(screen.queryByText(/编辑|新建|上传|删除|保存|Edit|Upload|Delete|Save/i)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/VaultReader.test.tsx 2>&1 | tail -15`
Expected: FAIL(组件不存在)。

- [ ] **Step 3: 实现 VaultReader**

`frontend/src/components/VaultReader.tsx`(只读;两段式:list/read mode;搜索 + 最近 + 目录树 + 阅读区)。完整骨架:

```tsx
import { useState, useEffect, useCallback } from 'react'
import { X, ChevronLeft, Search, FileText, Folder } from 'lucide-react'
import { listVault, getVaultFile, getVaultSearch, resolveWikiLink } from '../lib/api'
import { filterVaultEntries, resolveVaultImageSrc, getRecentNotes, pushRecentNote } from '../lib/vault'
import MarkdownContent from './markdown/MarkdownContent'
import type { DirListEntry } from '../lib/api'

export default function VaultReader({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'list' | 'read'>('list')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<DirListEntry[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ path: string; name: string }[]>([])
  const [openPath, setOpenPath] = useState('')
  const [content, setContent] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => { setRecent(getRecentNotes()) }, [mode])

  const loadDir = useCallback((path: string) => {
    listVault(path).then(r => setEntries(filterVaultEntries(r.entries))).catch(() => setEntries([]))
  }, [])
  useEffect(() => { loadDir(cwd) }, [cwd, loadDir])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const t = setTimeout(() => { getVaultSearch(query).then(r => setResults(r.results)).catch(() => setResults([])) }, 200)
    return () => clearTimeout(t)
  }, [query])

  const openNote = useCallback((path: string) => {
    getVaultFile(path).then(r => {
      setContent(r.content); setTruncated(r.truncated); setOpenPath(path); setMode('read')
      pushRecentNote(path); setRecent(getRecentNotes())
    }).catch(() => {})
  }, [])

  const onWikiLink = useCallback((name: string) => {
    resolveWikiLink(name).then(p => { if (p) openNote(p); else alert('未找到对应笔记:' + name) })
  }, [openNote])

  // READ MODE
  if (mode === 'read') {
    return (
      <div className="absolute inset-0 bg-[var(--bg-primary)] z-50 flex flex-col">
        <div className="flex items-center gap-2 p-2 border-b border-[var(--border)]">
          <button onClick={() => setMode('list')} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><ChevronLeft size={18} /></button>
          <span className="text-sm truncate flex-1">{openPath}</span>
          <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-auto">
          <article className="mx-auto max-w-[72ch] px-4 py-6 leading-relaxed text-[15px]">
            {truncated && <div className="mb-3 px-3 py-2 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--accent-yellow)]">内容过长,仅显示前 1MB</div>}
            <MarkdownContent text={content} isComplete
              resolveSrc={(s) => resolveVaultImageSrc(s, openPath)}
              onWikiLink={onWikiLink} />
          </article>
        </div>
      </div>
    )
  }

  // LIST MODE
  const crumbs = cwd ? cwd.split('/') : []
  return (
    <div className="absolute inset-0 bg-[var(--bg-primary)] z-50 flex flex-col">
      <div className="flex items-center gap-2 p-2 border-b border-[var(--border)]">
        <span className="text-sm font-bold flex-1">📓 Obsidian</span>
        <button onClick={onClose} className="p-1.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]"><X size={18} /></button>
      </div>
      <div className="p-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 px-2 py-1 rounded bg-[var(--bg-tertiary)]">
          <Search size={14} className="text-[var(--text-secondary)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索笔记名…"
            className="flex-1 bg-transparent text-sm outline-none text-[var(--text-primary)]" />
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {query.trim() ? (
          <ul>{results.map(r => (
            <li key={r.path}><button onClick={() => openNote(r.path)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-[var(--bg-tertiary)]"><FileText size={14} />{r.name}<span className="text-xs text-[var(--text-secondary)] truncate">{r.path}</span></button></li>
          ))}{results.length === 0 && <li className="px-3 py-2 text-xs text-[var(--text-secondary)]">无匹配</li>}</ul>
        ) : (
          <>
            {recent.length > 0 && cwd === '' && (
              <div className="px-3 pt-2">
                <div className="text-xs text-[var(--text-secondary)] mb-1">最近打开</div>
                {recent.map(p => <button key={p} onClick={() => openNote(p)} className="flex items-center gap-2 w-full px-1 py-1 text-sm text-left hover:bg-[var(--bg-tertiary)] rounded"><FileText size={14} />{p.split('/').pop()}</button>)}
                <div className="h-px bg-[var(--border)] my-2" />
              </div>
            )}
            {crumbs.length > 0 && (
              <button onClick={() => setCwd(crumbs.slice(0, -1).join('/'))} className="flex items-center gap-1 px-3 py-2 text-sm text-[var(--text-secondary)]"><ChevronLeft size={14} />返回上级</button>
            )}
            <ul>{entries.map(e => (
              <li key={e.name}>
                <button onClick={() => e.type === 'dir' ? setCwd(cwd ? `${cwd}/${e.name}` : e.name) : openNote(cwd ? `${cwd}/${e.name}` : e.name)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-[var(--bg-tertiary)]">
                  {e.type === 'dir' ? <Folder size={14} className="text-[var(--accent-blue)]" /> : <FileText size={14} className="text-[var(--text-secondary)]" />}
                  {e.name}
                </button>
              </li>
            ))}</ul>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 侧栏入口(Sidebar.tsx)**

`Sidebar.tsx`:本地 state(~75 附近,仿 showAdmin)`const [showVault, setShowVault] = useState(false)` + `const [vaultEnabled, setVaultEnabled] = useState(false)`;挂载拉 meta:

```tsx
  useEffect(() => { getVaultMeta().then(m => setVaultEnabled(shouldShowVault(m))).catch(() => {}) }, [])
```

header 图标栏(Clock 定时任务附近)加(仅 `vaultEnabled` 时):

```tsx
  {vaultEnabled && (
    <button onClick={() => setShowVault(true)} title="Obsidian 笔记库"
      className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-blue)] rounded transition-colors">
      <BookOpen size={18} />
    </button>
  )}
```

底部条件渲染(仿 `{showAdmin && ...}`):`{showVault && <VaultReader onClose={() => setShowVault(false)} />}`。

import 加 `BookOpen`(lucide)、`getVaultMeta`、`shouldShowVault`、`VaultReader`。

- [ ] **Step 5: 跑测试 + tsc**

Run: `cd frontend && npx vitest run src/components/__tests__/VaultReader.test.tsx 2>&1 | tail -10 && npx tsc -b 2>&1 | tail -5`
Expected: 测试 PASS;tsc 无错。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/VaultReader.tsx frontend/src/components/Sidebar.tsx frontend/src/components/__tests__/VaultReader.test.tsx
git commit -m "feat(vault-ui): two-pane read-only VaultReader + meta-gated sidebar entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: feynote 死路修复 + e2e 验证 + 文档

**Files:**
- Modify: `/home/ubuntu/feynote/frontend/index.html`
- Modify: `README.md` / `README_ZH.md`

**Interfaces:** 无代码接口;收尾任务。

- [ ] **Step 1: feynote header 加 Obsidian 入口**

`/home/ubuntu/feynote/frontend/index.html` 的 `<header>`(~82,`<div id="status">` 后)加一个链接(feynote 现状无"我的笔记"按钮,footer 写"待接入"——补一个真实可达的入口):

```html
    <div style="margin-top:12px">
      <a href="https://zeromux.keithyu.cloud" target="_blank"
         style="display:inline-block;padding:8px 16px;border-radius:8px;background:#1f6feb;color:#fff;text-decoration:none;font-size:14px">
        📓 打开我的 Obsidian 笔记 →（已迁移至 ZeroMux）
      </a>
    </div>
```

(纯静态前端改动;feynote 是 ServeDir 托管,reload 即生效。不碰其后端。)

- [ ] **Step 2: 全量后端测试**

Run: `cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux && cargo test 2>&1 | tail -6`
Expected: 全 PASS。

- [ ] **Step 3: 全量前端 tsc + lint + vitest**

Run: `cd frontend && npx tsc -b 2>&1 | tail -3 && npm run lint 2>&1 | grep -oE "[0-9]+ problems \([0-9]+ errors[^)]*\)" | tail -1 && npx vitest run 2>&1 | grep -E "Test Files|Tests " | tail -3`
Expected: tsc 无错;lint error 数不超过基线(实现前先记基线;新增 0 error);vitest 全绿(KaTeX flaky 除外)。

- [ ] **Step 4: 前端构建(rust-embed 前置)**

Run: `cd frontend && npm run build 2>&1 | tail -4`
Expected: 成功 → `frontend/dist/`。

- [ ] **Step 5: 手动冒烟(后端起一个带 vault 的实例)**

Run:
```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
cargo build 2>&1 | tail -2
# 用一个不占 live 端口的实例 + legacy 密码 + vault
./target/debug/zeromux --port 8099 --password test --vault-dir /home/ubuntu/s3-workspace/keith-space/obsidian &
sleep 2
# 拿 token 后(或 legacy 直接 query token)冒烟 meta（预期 enabled:true,name:obsidian）
curl -s "http://localhost:8099/api/vault/meta?token=..." | head -c 200
kill %1
```
Expected:`{"enabled":true,"name":"obsidian"}`(token 取法见现有 legacy 鉴权;若不便,跳过此步,依赖单测 + 部署后真机验证)。

- [ ] **Step 6: README**

`README.md` Features 加(英文),`README_ZH.md` 对应中文:
```
- **Obsidian Vault Reader** — Admin-only, read-only browser for an Obsidian vault (`--vault-dir`): directory tree, filename search, wikilink (`[[...]]`) navigation, image rendering, two-pane mobile reading layout. Never writes.
```

- [ ] **Step 7: 提交**

```bash
git add README.md README_ZH.md
git commit -m "docs: document Obsidian vault reader"
cd /home/ubuntu/feynote && git add frontend/index.html && git commit -m "feat: link 我的笔记 to ZeroMux Obsidian reader (was dead placeholder)"
```

(注意:feynote 是独立 repo,在它自己的目录里单独 commit。)

---

## Self-Review

**1. Spec coverage**:
- vault 只读端点(meta/list/file/search/resolve/raw)→ Task 4/5 ✅
- 强制复用 helper(resolve_and_verify/list_dir_entries/descends/is_credential)→ Task 4/5 直接调用 ✅
- 抽 read_text_file_capped/validate_browse_root → Task 1 ✅
- admin-only → Task 4 `vault_base` 守卫 + meta ✅
- 图片白名单 image/* + inline,SVG 不内联 → Task 5 ✅
- `--vault-dir` 无默认值 + 启动校验 → Task 2 ✅
- 双链 basename 索引 → Task 3 + resolve 端点 T4 + onWikiLink T7 ✅
- 文件名搜索 → Task 4 vault_search + UI T8 ✅
- 最近打开(localStorage)→ Task 6 vault.ts + T8 ✅
- 手机两段式 + 长文阅读容器(max-w-[72ch]/leading-relaxed)→ Task 8 ✅
- MarkdownContent resolveSrc/onWikiLink 可选不影响聊天 → Task 7 ✅
- 入口命名避开"笔记"(Obsidian)→ Task 8 ✅
- 目录树过滤 .obsidian/.trash/dotfiles → Task 6 filterVaultEntries + Task 3 索引 skip ✅
- 超 1MB 读前 1MB + truncated → Task 1 + T4 + T8 提示 ✅
- feynote 死路 → Task 9 ✅
- 部署 --vault-dir → 部署阶段(计划外,执行收尾)

**2. Placeholder scan**:无 TBD;每个 code step 有完整代码。Task 7 的 url-transform 风险、Task 9 Step5 token 取法标了"实现时核实/可跳过",是诚实的运行时验证点,非占位。

**3. Type consistency**:`{enabled,name}`(meta)T4↔T6↔T8 一致;`getVaultFile` 返回 `{content,truncated}` T4↔T6↔T8 一致;`resolveSrc`/`onWikiLink` 签名 T7 定义、T8 调用一致;`DirListEntry`(前端)复用现有;`VaultIndex.by_basename` T3↔T4 一致;`vaultRawUrl` T6 定义、T6 `resolveVaultImageSrc` 调用一致。

> 已知 trade-off:双链一期按 basename 全局解析,同名冲突取第一个(spec 明示);全文搜索、嵌入/canvas/callout 二期不做;feynote 仅加链接不修后端。
