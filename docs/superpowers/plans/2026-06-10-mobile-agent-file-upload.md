# 手机端 agent 会话文件上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 agent 聊天 composer 加 📎 附件入口,手机端可从相册选图或选任意文件(多选),上传到会话 work_dir 后把实际路径自动拼进这轮 prompt,让 Kiro/Claude/Codex 用 Read 工具读取。

**Architecture:** 复用现有 `POST /api/sessions/{id}/upload` 端点(路 A:文件落盘 + 路径注入,三后端统一,不碰 send_prompt)。后端加 body limit(否则 axum 默认 2MB 让手机照片 413)+ 原子去重 + 文件名 sanitize。前端在 `AcpChatView`(非共享 Composer)持有附件状态,📎 走 Composer 的 `rightSlot` 扩展点,chip 渲染在 Composer 上方。

**Tech Stack:** Rust / axum 0.8(`DefaultBodyLimit`)/ `std::fs::OpenOptions`;React / vitest / `FileReader`。

**来源 spec:** [docs/superpowers/specs/2026-06-10-mobile-agent-file-upload-design.md](../specs/2026-06-10-mobile-agent-file-upload-design.md)

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/web.rs`(改) | upload 路由加 `DefaultBodyLimit`(E1);纯函数 `next_candidate`(后缀生成)、`sanitize_filename`(E3);`dedupe_and_create`(原子,E2);`upload_session_file` 重写 + `UploadResp`;后端单测 |
| `frontend/src/lib/api.ts`(改) | `uploadSessionFile` 返回 `Promise<string>`(解析 `{path}`) |
| `frontend/src/lib/attachments.ts`(新) | 纯函数 `buildPromptWithAttachments(text, paths)`(E4 措辞);单测 |
| `frontend/src/components/AcpChatView.tsx`(改) | 附件状态 + 📎 按钮(经 Composer rightSlot)+ 待发 chip UI + 串行上传 + 发送时注入 + 清空 |

无 `session_manager.rs`、无 `send_prompt`、无三后端协议改动。无 DB 改动。**共享 `Composer.tsx` 不改**(用其现有 `rightSlot`)。

> **注入纯函数放前端**:`buildPromptWithAttachments` 在前端拼(AcpChatView 发送时调用),因为 prompt 文本在前端组装后经现有 sendPrompt → WS 通道走。后端不参与拼接。

---

## Task 1: 后端纯函数 `next_candidate` + `sanitize_filename`

**Files:**
- Modify: `src/web.rs`(在 `upload_session_file` 附近,约 :863 的 `// ── File upload` 区加函数;web.rs 当前无 `#[cfg(test)]`,本任务新建一个测试 mod 在文件末尾)

- [ ] **Step 1: 写失败测试**

在 `src/web.rs` **文件末尾**追加(web.rs 目前没有测试 mod):

```rust
#[cfg(test)]
mod upload_helpers_tests {
    use super::*;

    #[test]
    fn next_candidate_adds_suffix_before_ext() {
        assert_eq!(next_candidate("a.png", 1), "a-1.png");
        assert_eq!(next_candidate("a.png", 2), "a-2.png");
    }

    #[test]
    fn next_candidate_no_extension() {
        assert_eq!(next_candidate("log", 1), "log-1");
    }

    #[test]
    fn next_candidate_dotfile_treated_as_no_ext() {
        // 前导点不是扩展名分隔(.gitignore → .gitignore-1,不是 -1.gitignore)
        assert_eq!(next_candidate(".gitignore", 1), ".gitignore-1");
    }

    #[test]
    fn sanitize_strips_control_and_separators() {
        assert_eq!(sanitize_filename("a\nb.png"), "ab.png");
        assert_eq!(sanitize_filename("x/y\\z.txt"), "xyz.txt");
        assert_eq!(sanitize_filename("ok\u{7f}name"), "okname"); // DEL
    }

    #[test]
    fn sanitize_keeps_unicode_and_normal() {
        assert_eq!(sanitize_filename("截图.png"), "截图.png");
    }

    #[test]
    fn sanitize_empty_falls_back() {
        assert_eq!(sanitize_filename(""), "upload");
        assert_eq!(sanitize_filename("///"), "upload");
        assert_eq!(sanitize_filename("\n\n"), "upload");
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test upload_helpers_tests 2>&1 | tail -20`
Expected: 编译失败,`cannot find function next_candidate` / `sanitize_filename`。

- [ ] **Step 3: 实现**

在 `src/web.rs` 的 `// ── File upload (base64) ──` 注释下方(`UploadReq` 之前)加:

```rust
/// 在扩展名前插入 `-N` 后缀。前导点(dotfile)不视为扩展名。
fn next_candidate(name: &str, n: usize) -> String {
    // rfind('.') 但忽略位置 0 的点(.gitignore 这类无扩展名)
    match name.rfind('.').filter(|&i| i > 0) {
        Some(i) => format!("{}-{}{}", &name[..i], n, &name[i..]),
        None => format!("{}-{}", name, n),
    }
}

/// 剥换行/控制字符(< 0x20 及 DEL 0x7f)与路径分隔符(/ \\)。
/// 空或全非法 → "upload"。Unicode 正常字符保留。
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|&c| c >= '\u{20}' && c != '\u{7f}' && c != '/' && c != '\\')
        .collect();
    if cleaned.is_empty() { "upload".to_string() } else { cleaned }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test upload_helpers_tests 2>&1 | tail -20`
Expected: `test result: ok. 6 passed`。

> 注意:`next_candidate`/`sanitize_filename` 此刻仅被测试用,`cargo build` 可能报 dead_code —— Task 2 接入后消失。本任务不加 `#[allow]`。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(upload): next_candidate + sanitize_filename pure fns (E2/E3)"
```

---

## Task 2: 后端 `dedupe_and_create`(原子,E2)

**Files:**
- Modify: `src/web.rs`(函数加在 `next_candidate` 旁;测试加进 `upload_helpers_tests`)

- [ ] **Step 1: 写失败测试**

在 `upload_helpers_tests` mod 内追加(确保 `use std::io::Write;` 在 mod 内或测试函数内可用):

```rust
    #[test]
    fn dedupe_creates_first_then_suffixes() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();

        let (mut f1, n1) = dedupe_and_create(d, "a.png").unwrap();
        assert_eq!(n1, "a.png");
        use std::io::Write;
        f1.write_all(b"one").unwrap();

        // 第二次同名 → a-1.png(原子,不覆盖 a.png)
        let (_f2, n2) = dedupe_and_create(d, "a.png").unwrap();
        assert_eq!(n2, "a-1.png");

        // 第三次 → a-2.png
        let (_f3, n3) = dedupe_and_create(d, "a.png").unwrap();
        assert_eq!(n3, "a-2.png");

        // a.png 内容未被覆盖
        assert_eq!(std::fs::read(d.join("a.png")).unwrap(), b"one");
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test upload_helpers_tests::dedupe 2>&1 | tail -20`
Expected: 编译失败,`cannot find function dedupe_and_create`。

- [ ] **Step 3: 实现**

在 `sanitize_filename` 旁加(需 `use std::fs::OpenOptions;` 与 `use std::path::Path;` —— web.rs 已用 `std::path`,`OpenOptions` 在函数内 `use` 即可):

```rust
/// 原子"不存在才建":用 create_new(true) 占位,AlreadyExists 则递增后缀重试。
/// 返回 (打开的写句柄, 实际文件名)。消除 check-then-write 的并发覆盖窗口(E2)。
fn dedupe_and_create(dir: &std::path::Path, name: &str) -> std::io::Result<(std::fs::File, String)> {
    use std::fs::OpenOptions;
    // 先试原名
    match OpenOptions::new().write(true).create_new(true).open(dir.join(name)) {
        Ok(f) => return Ok((f, name.to_string())),
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        Err(_) => {}
    }
    // 冲突 → 递增后缀
    for n in 1..10_000 {
        let candidate = next_candidate(name, n);
        match OpenOptions::new().write(true).create_new(true).open(dir.join(&candidate)) {
            Ok(f) => return Ok((f, candidate)),
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
            Err(_) => continue,
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "too many name collisions"))
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test upload_helpers_tests 2>&1 | tail -20`
Expected: `test result: ok. 7 passed`(6 + dedupe)。
若 `tempfile` 未在 dev-deps:`grep tempfile Cargo.toml` 确认(Task auto-update 的 running_summary 测试已用 `tempfile::tempdir()`,说明已有)。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(upload): dedupe_and_create atomic create_new (E2)"
```

---

## Task 3: 后端 `upload_session_file` 重写 + body limit + 20MB(E1)

**Files:**
- Modify: `src/web.rs`(`upload_session_file` :872、`UploadReq` 区、route 行 :32、顶部 use :1-7)

- [ ] **Step 1: 加 body limit 到 upload 路由 + 顶部 use**

`src/web.rs` 顶部 `use axum::{...}`(:1-7)的 `extract::{Query, State}` 改为含 `DefaultBodyLimit`:

```rust
    extract::{DefaultBodyLimit, Query, State},
```

route 行(:32)改为给 upload 单独挂 body limit(≈27MB = 20MB×1.34):

```rust
        .route("/api/sessions/{id}/upload", post(upload_session_file)
            .layer(DefaultBodyLimit::max(28_311_552)))
```

> 若 axum 0.8 下 `MethodRouter::layer` 链式不便编译,退路:把 `.layer(DefaultBodyLimit::max(28_311_552))` 挂在整个 `api` Router 组上(`let api = Router::new()....layer(DefaultBodyLimit::max(28_311_552))`)。实现期以编译通过为准,优先 per-route。

- [ ] **Step 2: 改 UploadResp + 重写 handler**

把 `upload_session_file`(:872-897 整个函数)连同响应结构改为:

```rust
#[derive(serde::Serialize)]
struct UploadResp {
    /// 实际写入的文件名(去重 + sanitize 后),前端注入 prompt 用。
    path: String,
}

async fn upload_session_file(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<UploadReq>,
) -> Result<Json<UploadResp>, (StatusCode, String)> {
    // 解出会话 work_dir 根(经路径遍历防护);req.path 仅取文件名部分。
    let safe_name = sanitize_filename(
        std::path::Path::new(&req.path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("upload"),
    );
    // resolve_session_path 用 safe_name 作相对路径,复用其 work_dir 限制 + 遍历防护。
    let (base, _joined) = resolve_session_path(&state, &id, &safe_name)?;

    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &req.data)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid base64: {}", e)))?;

    // 20MB limit for uploads (E1: body limit ≈27MB 覆盖 base64 膨胀)
    if bytes.len() > 20_971_520 {
        return Err((StatusCode::BAD_REQUEST, "File too large (max 20MB)".to_string()));
    }

    std::fs::create_dir_all(&base)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Cannot create dir: {}", e)))?;

    // 原子去重创建 + 写入(E2)
    let (mut file, actual_name) = dedupe_and_create(&base, &safe_name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Create failed: {}", e)))?;
    use std::io::Write;
    file.write_all(&bytes)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Write failed: {}", e)))?;

    Ok(Json(UploadResp { path: actual_name }))
}
```

> **行为变化说明**:旧版支持 `req.path` 带子目录(`resolve_session_path` 允许 `Normal` 多级)。新版用 `file_name()` 只取最后一段,**附件统一落 work_dir 根**(符合 spec 决策)。`MarkdownViewer` 现有上传也走此端点 —— 它传的 `path` 是 `file.name`(无目录),行为不变;若它依赖子目录上传(查 `MarkdownViewer` 调用:`uploadSessionFile(sessionId, file.name, base64)`,只传文件名),无影响。

- [ ] **Step 3: 编译 + 跑既有测试不回归**

Run: `cargo build 2>&1 | tail -15 && cargo test upload_helpers_tests 2>&1 | tail -5`
Expected: 编译通过(`next_candidate`/`sanitize_filename`/`dedupe_and_create` 的 dead_code 警告消失);7 passed。

- [ ] **Step 4: 手动验证 body limit + 去重(集成,可选但推荐)**

启动一个本地实例,用 curl 发一个 >2MB 但 <20MB 的 base64 body 到 upload 端点,确认**不**返回 413(证明 body limit 生效);同名发两次,第二次响应 `{"path":"...-1...."}`。
> 若无方便的本地会话,记入端到端手动清单(Task 6),此步标 skipped。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(upload): body limit 27MB + 20MB cap + atomic dedupe + sanitize + return path (E1/E2/E3)"
```

---

## Task 4: 前端 `uploadSessionFile` 返回实际 path

**Files:**
- Modify: `frontend/src/lib/api.ts`(`uploadSessionFile` :340)

- [ ] **Step 1: 改返回类型 + 解析响应**

把 `uploadSessionFile`(`frontend/src/lib/api.ts:340`)改为:

```typescript
export async function uploadSessionFile(id: string, path: string, data: string): Promise<string> {
  const res = await api(`/api/sessions/${id}/upload`, {
    method: 'POST',
    body: JSON.stringify({ path, data }),
  })
  if (!res.ok) throw new Error(await res.text())
  const body = await res.json() as { path: string }
  return body.path
}
```

- [ ] **Step 2: 确认 MarkdownViewer 调用不破**

`frontend/src/components/MarkdownViewer.tsx:233` 是 `await uploadSessionFile(sessionId, file.name, base64)`(忽略返回值)。返回类型从 `void` 变 `string` 向后兼容,无需改。
Run: `cd frontend && npx tsc -b 2>&1 | tail -15`
Expected: 无类型错误。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(upload): uploadSessionFile returns actual written path"
```

---

## Task 5: 前端纯函数 `buildPromptWithAttachments`(E4)

**Files:**
- Create: `frontend/src/lib/attachments.ts`
- Test: `frontend/src/lib/__tests__/attachments.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `frontend/src/lib/__tests__/attachments.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildPromptWithAttachments } from '../attachments'

describe('buildPromptWithAttachments', () => {
  it('no attachments returns text unchanged', () => {
    expect(buildPromptWithAttachments('hello', [])).toBe('hello')
  })

  it('text + multiple attachments appends instruction block', () => {
    const out = buildPromptWithAttachments('看下这个报错', ['a.png', 'log.txt'])
    expect(out).toContain('看下这个报错')
    expect(out).toContain('请先用 Read 工具读取后再回应')
    expect(out).toContain('./a.png')
    expect(out).toContain('./log.txt')
    // 用户文字与附件块之间有空行
    expect(out).toMatch(/看下这个报错\n\n\[/)
  })

  it('empty text + single attachment: only attachment block, no leading blank', () => {
    const out = buildPromptWithAttachments('', ['shot.png'])
    expect(out.startsWith('[')).toBe(true)
    expect(out).toContain('./shot.png')
  })

  it('whitespace-only text treated as empty', () => {
    const out = buildPromptWithAttachments('   ', ['x.png'])
    expect(out.startsWith('[')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/attachments.test.ts 2>&1 | tail -15`
Expected: FAIL — `Failed to resolve import "../attachments"`。

- [ ] **Step 3: 实现**

新建 `frontend/src/lib/attachments.ts`:

```typescript
/** 把已上传附件的相对路径拼进 prompt。指令化措辞让 agent 真去 Read(spec E4)。 */
export function buildPromptWithAttachments(text: string, paths: string[]): string {
  if (paths.length === 0) return text
  const lines = paths.map(p => `./${p}`).join('\n')
  const block = `[用户上传了以下文件,请先用 Read 工具读取后再回应:\n${lines}]`
  const trimmed = text.trim()
  return trimmed ? `${trimmed}\n\n${block}` : block
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/attachments.test.ts 2>&1 | tail -15`
Expected: 4 passed。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/lib/attachments.ts frontend/src/lib/__tests__/attachments.test.ts
git commit -m "feat(upload): buildPromptWithAttachments pure fn (E4 instruction wording)"
```

---

## Task 6: 前端 composer 附件入口(AcpChatView)

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`(composer 区 :290-365,imports)

这是主要工作量。附件状态/UI/注入全在 `AcpChatView`(agent-chat-only),📎 按钮经 `Composer` 的 `rightSlot`,chip 渲染在 Composer 上方。**不改共享 `Composer.tsx`**。

- [ ] **Step 1: 加 imports + 附件状态**

`AcpChatView.tsx` 顶部 import 区加(已 import `Composer`、lucide 图标):

```typescript
import { Paperclip, X } from 'lucide-react'
import { uploadSessionFile } from '../lib/api'
import { buildPromptWithAttachments } from '../lib/attachments'
```

在组件内(`const [busy, setBusy] = useState(false)` 附近,:67)加:

```typescript
  const [pending, setPending] = useState<string[]>([])      // 已上传待发的实际路径
  const [uploading, setUploading] = useState(0)             // 上传中计数
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
```

(确认 `useRef`/`useState` 已 import;`useRef` 可能要加进 react import。)

- [ ] **Step 2: 加上传处理 + 发送注入**

在 `sendPrompt`(:292)附近加上传处理,并改 `sendPrompt` 注入附件:

```typescript
  // 串行上传(E5:手机内存),每个成功 push 实际路径到 pending。
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const list = Array.from(files)
    setUploading(u => u + list.length)
    for (const file of list) {
      try {
        const dataUrl: string = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(r.result as string)
          r.onerror = () => reject(r.error)
          r.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1] ?? ''
        const actual = await uploadSessionFile(sessionId, file.name, base64)
        setPending(p => [...p, actual])
      } catch (e: any) {
        alert(`上传失败 ${file.name}: ${e.message}`)
      } finally {
        setUploading(u => u - 1)
      }
    }
  }, [sessionId])

  const removePending = useCallback((path: string) => {
    setPending(p => p.filter(x => x !== path))
  }, [])
```

把现有 `sendPrompt`(:292)改成注入附件 + 清空 pending。真实现是:

```typescript
  const sendPrompt = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    pushMessage({ id: newId(), kind: 'user', text })
    wsRef.current.send(JSON.stringify({ type: 'prompt', text }))
    setInput('')
    setBusy(true)
    setTurnStartedMs(Date.now())
  }, [pushMessage])
```

改为(最小改动:算 `full`、WS 发 `full`、清 pending;依赖加 `pending`):

```typescript
  const sendPrompt = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const full = buildPromptWithAttachments(text, pending)
    pushMessage({ id: newId(), kind: 'user', text: full })
    wsRef.current.send(JSON.stringify({ type: 'prompt', text: full }))
    setInput('')
    setPending([])
    setBusy(true)
    setTurnStartedMs(Date.now())
  }, [pushMessage, pending])
```

> **关键细节**:`pushMessage` 用 `full`(让聊天记录显示带附件块的实际发送内容,与 scrollback 回放一致),WS 也发 `full`。`text` 为空但 `pending` 非空时仍可发(`buildPromptWithAttachments` 返回纯附件块,非空)—— 但注意 **Composer 的 send 按钮在 `value` 为空时是 disabled 的**(`Composer.tsx`:`disabled={!value.trim()}`),所以"纯附件无文字"目前点不了发送按钮。**解决:无需改共享 Composer** —— 当有 pending 附件时,在 AcpChatView 的 rightSlot 区提供一个独立的"发送"路径,或允许 Enter 发送。最简做法:Composer 的 `onSend` 仍要求有文字;**纯附件场景下,用户至少打一个字符**(可接受的小约束),或在 chip 区加一个独立发送按钮。实现期二选一:① 接受"纯附件需补一字";② chip 区加 `<button onClick={() => sendPrompt('')}>发送</button>` 仅在 `pending.length>0 && !value.trim()` 时显示。**推荐 ②**(spec 要求附件可单独发)。

- [ ] **Step 3: 加 chip UI + 隐藏 input + rightSlot 按钮**

在渲染 Composer 的地方(:359 `<Composer .../>`)上方加 chip 行 + 隐藏 input,并给 Composer 传 `rightSlot`:

```tsx
      {/* 待发附件 chips + 上传中提示 */}
      {(pending.length > 0 || uploading > 0) && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
          {pending.map(p => (
            <span key={p} className="inline-flex items-center gap-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]">
              {p}
              <button onClick={() => removePending(p)} aria-label={`remove ${p}`} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                <X size={12} />
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="text-xs text-[var(--text-muted)] px-1 py-1">上传中 {uploading} 个…</span>
          )}
        </div>
      )}
      {/* 隐藏 file input:相册图片 + 任意文件,均多选 */}
      <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = '' }} />
      <input ref={fileInputRef} type="file" accept="*/*" multiple className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = '' }} />
```

给 `<Composer>` 加 `rightSlot`(在其现有 props 旁):

```tsx
        <Composer
          /* …现有 props… */
          onSend={sendPrompt}
          rightSlot={
            <div className="flex items-end gap-1">
              <button onClick={() => imageInputRef.current?.click()} aria-label="attach image"
                className="self-end p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors" title="图片">
                <Paperclip size={16} />
              </button>
              <button onClick={() => fileInputRef.current?.click()} aria-label="attach file"
                className="self-end p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors" title="文件">
                <FileText size={16} />
              </button>
            </div>
          }
        />
```

> `FileText` 已在 AcpChatView 的 lucide import 里(:3 确认有)。`Paperclip`/`X` 在 Step 1 已加。两个按钮:📎 图片(accept=image/*)、📄 文件(accept=*/*)。

- [ ] **Step 4: 类型检查 + lint + 既有前端测试**

Run: `cd frontend && npx tsc -b 2>&1 | tail -15`
Expected: 无类型错误(注意 `useRef`/`useState`/`useCallback` 都已 import)。
Run: `cd frontend && npm run lint 2>&1 | tail -15`
Expected: 无**新增** error(repo 有 ~28 个 pre-existing lint error,见 collect/titler 记录 —— 只要不新增即可;若 lint 卡住核对 baseline)。
Run: `cd frontend && npx vitest run 2>&1 | tail -10`
Expected: 既有测试 + attachments 测试全过。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(upload): composer attachment entry — image/file pickers, chips, serial upload, path injection"
```

---

## Task 7: 端到端手动验证 + 构建(部署后人工)

> 无新代码。前端 build(rust-embed 需要)+ 手动真机验证清单。

- [ ] **Step 1: 前端构建 + 后端 release 构建**

```bash
cd frontend && npm run build && cd ..
cargo build --release 2>&1 | tail -5
```
Expected: `frontend/dist/` 更新;release 二进制构建成功。

- [ ] **Step 2: 手动真机 checklist**(部署带新 binary 后,手机浏览器跑)

- [ ] composer 出现 📎(图片)+ 📄(文件)两个按钮
- [ ] 点 📎 → 从相册多选 2 张截图 → 上方出现 2 个 chip + "上传中" → 完成后 2 chip 留存
- [ ] 打字 + 发送 → agent 收到带 `./xxx.png` 路径的 prompt → **claude/kiro/codex 各验证一次:agent 真的调用 Read 打开文件**(E4;若某后端只口头确认不读,记下,实现期或后续微调措辞)
- [ ] 点 📄 → 选一个 PDF/文档 → 同样能上传 + 注入
- [ ] 发送前点 chip 的 ✕ → 该文件不进 prompt
- [ ] 选一个 >20MB 文件 → 提示"File too large (max 20MB)",不阻塞其他文件/文字
- [ ] **选一个真实 ~5MB 手机截图 → 上传成功**(E1 body limit 验证:旧默认 2MB 会 413)
- [ ] 纯附件无文字 → 也能发(prompt 只含附件块)

记录结果到 spec 或 memory。

---

## Self-Review(对照 spec)

- **spec Feature 1(后端 body limit + 原子去重)**:Task 1(纯函数)+ Task 2(dedupe)+ Task 3(handler + body limit + 20MB)。✅
- **spec Feature 2(composer 入口)**:Task 6(📎/📄 按钮、多选、串行上传、chip、移除、注入、清空)。✅
- **spec Feature 3(注入格式 E4 + sanitize E3)**:Task 5(`buildPromptWithAttachments` 指令化措辞)+ Task 1(`sanitize_filename`)+ Task 3(handler 调用 sanitize)。✅
- **spec E1 body limit**:Task 3 Step 1。✅
- **spec E2 原子去重**:Task 2 `dedupe_and_create`(create_new)。✅
- **spec E3 sanitize**:Task 1 + Task 3 接入。✅
- **spec E4 措辞 + 三后端验证**:Task 5 措辞 + Task 7 手动验证。✅
- **spec「uploadSessionFile 返回 path」**:Task 4。✅
- **spec「串行上传 E5」**:Task 6 Step 2 `for...of await`。✅
- **spec「不改 Composer/session_manager/send_prompt」**:计划仅改 web.rs + 3 个前端文件,Composer 用 rightSlot。✅
- **Placeholder 扫描**:每个改码步骤含完整代码;Task 6 Step 2 对 `sendPrompt` 原发送逻辑标注"读现有实现做最小改动"(因该处实现细节需以真实代码为准,但已给出确切改法:文本换 `full`、发送后 `setPending([])`)。无 TBD。
- **类型一致性**:`UploadResp{path}`(Rust)↔ `uploadSessionFile(): Promise<string>`(TS)↔ `pending: string[]` ↔ `buildPromptWithAttachments(text, paths)` 引用一致;`next_candidate`/`sanitize_filename`/`dedupe_and_create` 跨 Task 1/2/3 签名一致。✅
