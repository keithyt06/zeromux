# Group A: Response 渲染优雅化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zeromux agent 回复呈现"干练"——工具调用显示一行可读摘要 + per-tool 图标、thinking 流式合并并在结束后自动折叠、消除最终文本重复渲染。

**Architecture:** 后端新增一个纯函数模块 `src/acp/format.rs` 统一生成工具摘要，三后端归一化时填入 `ContentBlock.summary`；前端 `AcpChatView.tsx` 渲染摘要 + per-tool lucide 图标、合并/折叠 thinking、把原始 JSON input 收进默认折叠区。result 重复渲染靠现有前端门控 + 协议文档化，不改协议结构。不碰 fan-out / Drop / scrollback / `AcpEvent::Result` 结构。

**Tech Stack:** Rust（serde_json，内联 `#[cfg(test)]` 单测）、React 19 + TypeScript + lucide-react + Tailwind v4。

**Spec:** `docs/superpowers/specs/2026-06-02-response-rendering-polish-design.md`

**实现期发现的一处 spec 细化**（已在下方落实，记录备查）：
- `format_tool_use` 返回 `Option<String>`（"目标/细节"，无可提取信息时 `None`），而非 spec 字面写的"永不返回空 String"。原因：前端改为显示 `name · summary`（如 `Read · src/main.rs`）——因为 Read/Edit/Write 三者共用同一 `FileText` 图标，只显示路径会丢失读/写区分；保留 `name` 再补 `summary` 更清晰，`None` 是"无额外细节"的自然信号。这更好地服务 spec 意图（干练且不丢信息）。
- Kiro 的 `tool_call` 只带人类可读 `title`（无结构化 input），故 Kiro 保持用 `name`=title、`summary: None`；只有 Claude 真正填充 summary。Codex 无 tool_use ContentBlock。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/acp/format.rs` | 纯函数：`format_tool_use`、`shorten_path`、`truncate_chars` + 单测 | 新建 |
| `src/acp/mod.rs` | 注册 `format` 模块 | 修改 |
| `src/acp/process.rs` | `AcpEvent` enum：`ContentBlock` 加 `summary` 字段；Claude assistant 分支填充；补 doc 注释 | 修改 |
| `src/acp/codex_process.rs` | 两处 `ContentBlock` 构造加 `summary: None` | 修改 |
| `src/acp/kiro_process.rs` | 三处 `ContentBlock` 构造加 `summary`（tool_call 用 None） | 修改 |
| `frontend/src/components/AcpChatView.tsx` | 类型加 `summary`；thinking 合并；图标映射；摘要 + 折叠 input 渲染；结束折叠；result 门控注释 | 修改 |

---

## Task 1: 后端摘要纯函数模块 `format.rs`

**Files:**
- Create: `src/acp/format.rs`
- Modify: `src/acp/mod.rs`

- [ ] **Step 1: 注册模块**

在 `src/acp/mod.rs` 顶部加一行（与现有 `pub mod` 同风格）：

```rust
pub mod format;
```

改完后 `src/acp/mod.rs` 应为：

```rust
pub mod format;
pub mod kiro_process;
pub mod codex_process;
pub mod process;
pub mod ws_handler;
```

- [ ] **Step 2: 写 format.rs（含失败测试）**

创建 `src/acp/format.rs`，完整内容如下：

```rust
//! 工具调用摘要：把一次 tool_use 的 (name, input) 压成一行人类可读细节。
//!
//! 纯函数，无副作用，供三个 agent 后端在归一化 `AcpEvent::ContentBlock`
//! 时共用。只产出文字（不含 emoji/图标）——图标由前端 lucide 体系按工具名
//! 选择。返回 `None` 表示"无可提取的额外细节"，此时前端只显示工具名。

use serde_json::Value;

/// 按字符（而非字节）安全截断，超长补省略号。中文/emoji 不会被切坏。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

/// 把绝对路径缩成 `父目录/文件名`，无父目录时只留文件名，
/// 无法解析时原样返回。
fn shorten_path(p: &str) -> String {
    let path = std::path::Path::new(p);
    let base = path.file_name().and_then(|s| s.to_str());
    let parent = path
        .parent()
        .and_then(|d| d.file_name())
        .and_then(|s| s.to_str());
    match (parent, base) {
        (Some(d), Some(b)) if !d.is_empty() => format!("{d}/{b}"),
        (_, Some(b)) => b.to_string(),
        _ => p.to_string(),
    }
}

/// 生成一行工具调用细节摘要。已知工具提取最有信息量的字段；
/// 未知工具（含 MCP）返回 `None`，前端回落显示工具名。
pub fn format_tool_use(name: &str, input: Option<&Value>) -> Option<String> {
    let field = |key: &str| -> Option<&str> {
        input
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
    };

    match name {
        "Read" | "Edit" | "Write" => field("file_path").map(shorten_path),
        "Bash" => field("description")
            .or_else(|| field("command"))
            .map(|s| truncate_chars(s, 80)),
        "Grep" => field("pattern").map(|p| {
            let mut s = truncate_chars(p, 80);
            if let Some(path) = field("path") {
                s.push_str(" in ");
                s.push_str(&shorten_path(path));
            }
            s
        }),
        "Glob" => field("pattern").map(|p| truncate_chars(p, 80)),
        "Agent" | "Task" => field("description").map(|d| truncate_chars(d, 60)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_shows_short_path() {
        let input = json!({ "file_path": "/home/user/proj/src/main.rs" });
        assert_eq!(
            format_tool_use("Read", Some(&input)),
            Some("src/main.rs".to_string())
        );
    }

    #[test]
    fn edit_and_write_use_same_path_rule() {
        let input = json!({ "file_path": "/a/b/c.txt" });
        assert_eq!(format_tool_use("Edit", Some(&input)), Some("b/c.txt".to_string()));
        assert_eq!(format_tool_use("Write", Some(&input)), Some("b/c.txt".to_string()));
    }

    #[test]
    fn bash_prefers_description_then_command() {
        let with_desc = json!({ "description": "run tests", "command": "cargo test" });
        assert_eq!(format_tool_use("Bash", Some(&with_desc)), Some("run tests".to_string()));
        let cmd_only = json!({ "command": "git status" });
        assert_eq!(format_tool_use("Bash", Some(&cmd_only)), Some("git status".to_string()));
    }

    #[test]
    fn grep_appends_path_when_present() {
        let input = json!({ "pattern": "TODO", "path": "/x/y/src" });
        assert_eq!(
            format_tool_use("Grep", Some(&input)),
            Some("TODO in y/src".to_string())
        );
        let no_path = json!({ "pattern": "TODO" });
        assert_eq!(format_tool_use("Grep", Some(&no_path)), Some("TODO".to_string()));
    }

    #[test]
    fn agent_and_task_truncate_description() {
        let long = "a".repeat(100);
        let input = json!({ "description": long });
        let out = format_tool_use("Agent", Some(&input)).unwrap();
        // 60 chars + 省略号
        assert_eq!(out.chars().count(), 61);
        assert!(out.ends_with('…'));
        assert_eq!(format_tool_use("Task", Some(&input)).unwrap().chars().count(), 61);
    }

    #[test]
    fn unknown_tool_returns_none() {
        let input = json!({ "anything": "value" });
        assert_eq!(format_tool_use("mcp__github__create_issue", Some(&input)), None);
    }

    #[test]
    fn missing_or_empty_fields_return_none() {
        assert_eq!(format_tool_use("Read", None), None);
        let empty = json!({ "file_path": "" });
        assert_eq!(format_tool_use("Read", Some(&empty)), None);
    }

    #[test]
    fn truncate_is_char_safe_for_multibyte() {
        let s = "中文".repeat(50); // 100 chars, multi-byte
        let out = truncate_chars(&s, 10);
        assert_eq!(out.chars().count(), 11); // 10 + 省略号
        assert!(out.ends_with('…'));
    }

    #[test]
    fn shorten_path_handles_bare_filename() {
        assert_eq!(shorten_path("main.rs"), "main.rs");
    }
}
```

- [ ] **Step 3: 运行测试，确认通过**

Run: `cargo test --lib acp::format`
Expected: PASS（9 个测试全绿）

- [ ] **Step 4: Commit**

```bash
git add src/acp/format.rs src/acp/mod.rs
git commit -m "feat(acp): add format::format_tool_use for one-line tool summaries

Pure function shared by all three agent backends. Read/Edit/Write→short
path, Bash→description|command, Grep→pattern[+path], Glob/Agent/Task→
truncated field. Unknown/MCP tools return None (frontend shows tool name).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `ContentBlock.summary` 字段 + 后端填充

**Files:**
- Modify: `src/acp/process.rs:27-37`（enum 定义）, `src/acp/process.rs:204-210`（Claude 填充）
- Modify: `src/acp/codex_process.rs:482-489`, `src/acp/codex_process.rs:498-505`
- Modify: `src/acp/kiro_process.rs:362-368`, `src/acp/kiro_process.rs:383-390`, `src/acp/kiro_process.rs:400-406`

- [ ] **Step 1: 给 `ContentBlock` 加 `summary` 字段**

在 `src/acp/process.rs` 的 `AcpEvent::ContentBlock` 变体里（现 `:27-37`），在 `streaming` 字段后加 `summary`：

```rust
    ContentBlock {
        block_type: StaticOrOwnedStr,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        streaming: Option<bool>,
        /// 仅 tool_use 类型填充：`format::format_tool_use` 生成的一行细节
        /// 摘要（如 `src/main.rs`、`git status`）。前端显示为 `name · summary`。
        /// text/thinking block 及无可提取细节的工具为 None。
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
```

- [ ] **Step 2: Claude 分支填充 summary**

在 `src/acp/process.rs` 的 assistant 翻译里（现 `:204-210` 的 `AcpEvent::ContentBlock {...}` 构造），改为：

```rust
                    let summary = if block_type == "tool_use" {
                        crate::acp::format::format_tool_use(
                            b.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            b.get("input"),
                        )
                    } else {
                        None
                    };
                    AcpEvent::ContentBlock {
                        block_type,
                        text,
                        name: b.get("name").and_then(|v| v.as_str()).map(String::from),
                        input: b.get("input").cloned(),
                        streaming: None,
                        summary,
                    }
```

- [ ] **Step 3: Codex 两处构造加 `summary: None`**

`src/acp/codex_process.rs` 的 text 块（现 `:482-489`）和 thinking 块（现 `:498-505`）都是文本，加 `summary: None`。text 块改为：

```rust
                                                .send(AcpEvent::ContentBlock {
                                                    block_type: std::borrow::Cow::Borrowed("text"),
                                                    text: Some(text),
                                                    name: None,
                                                    input: None,
                                                    streaming: Some(true),
                                                    summary: None,
                                                })
```

thinking 块同样在 `streaming: Some(true),` 后加 `summary: None,`。

- [ ] **Step 4: Kiro 三处构造加 `summary`**

`src/acp/kiro_process.rs` 的三个 `ContentBlock` 构造：
- `agent_message_chunk`（现 `:362-368`，text）：在 `streaming: Some(true),` 后加 `summary: None,`
- `agent_thought_chunk`（现 `:383-390`，thinking）：在 `streaming: Some(true),` 后加 `summary: None,`
- `tool_call`（现 `:400-406`，tool_use）：在 `streaming: None,` 后加 `summary: None,`

tool_call 块说明：Kiro 的 `title` 已是人类可读摘要并存入 `name`，且 Kiro 不提供结构化 input，故 `summary: None`，前端显示 title（来自 name）即可。最终 tool_call 块为：

```rust
            vec![AcpEvent::ContentBlock {
                block_type: std::borrow::Cow::Borrowed("tool_use"),
                text: None,
                name: Some(title),
                input: None,
                streaming: None,
                summary: None,
            }]
```

- [ ] **Step 5: 编译 + 跑全部测试**

Run: `cargo build && cargo test`
Expected: PASS（无遗漏构造站点报错；Task 1 的 format 测试仍绿）

- [ ] **Step 6: Commit**

```bash
git add src/acp/process.rs src/acp/codex_process.rs src/acp/kiro_process.rs
git commit -m "feat(acp): add ContentBlock.summary, populate from Claude tool_use

New optional field carries the one-line tool summary. Claude's assistant
translation fills it via format_tool_use; Codex (text/thinking only) and
Kiro (title already in name, no structured input) pass None.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 前端渲染摘要 + per-tool 图标 + 折叠原始 input

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx:3`（imports）, `:28-33`（ContentBlock 类型）, `:37-49`（ServerEvent 类型）, `:129-161`（content_block 事件）, `:368-386`（tool_use 渲染）

- [ ] **Step 1: 扩展 lucide imports**

`frontend/src/components/AcpChatView.tsx:3` 现为：

```tsx
import { Send, ChevronDown, Wrench, Brain, AlertCircle } from 'lucide-react'
```

改为（新增 FileText / Terminal / Search / Bot + 类型 LucideIcon）：

```tsx
import { Send, ChevronDown, Wrench, Brain, AlertCircle, FileText, Terminal, Search, Bot, type LucideIcon } from 'lucide-react'
```

- [ ] **Step 2: 类型加 `summary`**

`ContentBlock` 接口（现 `:28-33`）加 `summary`：

```tsx
interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use'
  text?: string
  name?: string
  input?: any
  summary?: string
}
```

`ServerEvent` 接口（现 `:37-49`）加 `summary`：

```tsx
interface ServerEvent {
  type: string
  subtype?: string
  session_id?: string
  block_type?: string
  text?: string
  name?: string
  input?: any
  cost_usd?: number
  message?: string
  code?: number
  streaming?: boolean
  summary?: string
}
```

- [ ] **Step 3: content_block 事件携带 summary 进 block**

在 `handleEvent` 的 `content_block` case 里，`blocks.push({...})`（现 `:146-151`）加 `summary`：

```tsx
          } else {
            blocks.push({
              type: (evt.block_type as ContentBlock['type']) || 'text',
              text: evt.text,
              name: evt.name,
              input: evt.input,
              summary: evt.summary,
            })
          }
```

- [ ] **Step 4: 加 per-tool 图标映射 + 渲染摘要 + 折叠 input**

在文件的渲染区（`BlockView` 函数之前，约 `:344` 处）加模块级图标映射表：

```tsx
// 工具名 → lucide 图标。未知/MCP 工具回落 Wrench。
const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText, Edit: FileText, Write: FileText,
  Bash: Terminal,
  Grep: Search, Glob: Search,
  Agent: Bot, Task: Bot,
}
const iconFor = (name?: string): LucideIcon =>
  (name && TOOL_ICONS[name]) || Wrench
```

把 `BlockView` 的 `tool_use` case（现 `:368-386`）整体替换为：

```tsx
    case 'tool_use': {
      const Icon = iconFor(block.name)
      const inputStr = block.input ? JSON.stringify(block.input, null, 2) : null
      const truncated = inputStr && inputStr.length > 2000
        ? inputStr.substring(0, 2000) + '\n...(truncated)'
        : inputStr
      const hasRawInput = !!truncated && truncated !== '{}' && truncated !== 'null'
      return (
        <div className="border-l-2 border-[var(--accent-yellow)] pl-2.5 py-1 text-xs">
          <div className="flex items-center gap-1 text-[var(--accent-yellow)] font-medium">
            <Icon size={12} />
            <span>{block.name || 'tool'}</span>
            {block.summary && (
              <span className="text-[var(--text-secondary)] font-normal truncate">· {block.summary}</span>
            )}
          </div>
          {hasRawInput && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] text-[var(--text-muted)] select-none">input</summary>
              <pre className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border)] overflow-x-auto">
                {truncated}
              </pre>
            </details>
          )}
        </div>
      )
    }
```

- [ ] **Step 5: 构建 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: PASS（无类型错误、无 lint 错误）

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(ui): tool_use shows per-tool icon + summary, raw input folded

Display 'name · summary' (e.g. Read · src/main.rs) with a per-tool lucide
icon (FileText/Terminal/Search/Bot, Wrench fallback). Raw JSON input moves
into a default-collapsed <details> so the default view stays crisp.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 前端 thinking 流式合并 + 结束自动折叠

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx:141-142`（合并条件）, `:354-366`（thinking 渲染）

- [ ] **Step 1: thinking 也走流式合并**

`handleEvent` content_block case 现在的合并条件（`:141-142`）只认 text：

```tsx
          if (evt.streaming && evt.block_type === 'text' && blocks.length > 0
              && blocks[blocks.length - 1].type === 'text') {
```

改为 text 和 thinking 都合并（连续同类型 streaming chunk 追加进末尾块）：

```tsx
          const mergeable = evt.block_type === 'text' || evt.block_type === 'thinking'
          if (evt.streaming && mergeable && blocks.length > 0
              && blocks[blocks.length - 1].type === evt.block_type) {
```

说明：把"末尾块类型 === text"改为"末尾块类型 === 当前 block_type"，使 thinking chunk 合并进上一个 thinking 块、text chunk 合并进上一个 text 块。Claude 的 thinking 不带 `streaming`，不触发合并（保持每块独立），符合预期。

- [ ] **Step 2: thinking 结束后自动折叠**

`BlockView` 的 thinking case（现 `:354-366`）的 `<details>` 改为按完成状态控制展开。把：

```tsx
        <details className="border-l-2 border-[var(--accent-purple-dim)] pl-2.5 text-xs text-[var(--accent-purple-text)]">
```

改为：

```tsx
        <details open={!isComplete} className="border-l-2 border-[var(--accent-purple-dim)] pl-2.5 text-xs text-[var(--accent-purple-text)]">
```

`isComplete` 已作为 `BlockView` 的 prop 传入（见 `:345` 签名 `{ block, isComplete }`）。turn 进行中展开看实时思考，turn 完成自动收起。

- [ ] **Step 3: 构建 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(ui): merge streaming thinking chunks, auto-fold on turn complete

Codex/Kiro emit reasoning token-by-token; merge consecutive streaming
thinking chunks into one block instead of spawning hundreds of <details>.
Expand while streaming (open={!isComplete}), collapse when the turn ends.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: result 重复渲染契约文档化 + enum 渲染语义注释

**Files:**
- Modify: `src/acp/process.rs:19-50`（AcpEvent enum doc 注释）
- Modify: `frontend/src/components/AcpChatView.tsx:163-192`（result case 注释更新）

- [ ] **Step 1: 给 AcpEvent 各变体补渲染语义 doc 注释**

在 `src/acp/process.rs` 的 `AcpEvent` enum（现 `:19-50`），为每个变体加 doc 注释。在 `pub enum AcpEvent {` 之后逐个变体补充（保留现有字段，仅加 `///` 注释）：

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpEvent {
    /// 会话/进程生命周期信号（init、session_id 等）。前端渲染为一行
    /// 灰色 system 文本，不进入助手消息气泡。
    System {
        subtype: StaticOrOwnedStr,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    /// 助手输出的一个内容块。`block_type` 决定渲染方式：
    /// - "text"：正文 markdown；`streaming:true` 的连续块前端合并为一段。
    /// - "thinking"：推理痕迹，渲染为可折叠区；流式块合并，turn 结束折叠。
    /// - "tool_use"：工具调用，显示 `name · summary` + 图标，原始 `input` 折叠。
    /// `summary` 仅 tool_use 填充（见 format::format_tool_use）。
    ContentBlock {
        block_type: StaticOrOwnedStr,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        streaming: Option<bool>,
        /// 仅 tool_use 类型填充：`format::format_tool_use` 生成的一行细节
        /// 摘要（如 `src/main.rs`、`git status`）。前端显示为 `name · summary`。
        /// text/thinking block 及无可提取细节的工具为 None。
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    /// turn 结束信号。`text` **始终携带完整最终文本**；但前端仅在本轮未通过
    /// 任何 `ContentBlock{block_type:"text"}` 流式呈现过正文时，才将其渲染为
    /// 最终文本块（见 AcpChatView result 门控）。这避免流式后重复渲染，同时
    /// 让 Codex 非流式（Bedrock thinking 一次性返回）的正文仍能显示。
    /// `text` 始终完整也保证 session_manager::log_result_event 的活动摘要可用。
    Result {
        text: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
    },
    /// 错误信息，渲染为红框气泡，并标记当前助手消息为完成。
    Error {
        message: String,
    },
    /// 进程退出，渲染为 system 文本并结束 busy 状态。
    Exit {
        code: i32,
    },
}
```

- [ ] **Step 2: 前端 result 门控注释升级为契约说明**

`AcpChatView.tsx` 的 result case（现 `:163-192`），把现有 `hasStreamedText` 一段的注释（`:170-182`）更新为引用协议契约。将注释块替换为：

```tsx
            // 协议契约（见后端 AcpEvent::Result doc）：result.text 始终是
            // 完整最终文本，但本轮若已通过流式 text ContentBlock 呈现过正文，
            // 就不能再注入 result.text（否则重复渲染）。判据：blocks 里是否已
            // 存在非空 text block。
            // - Codex/Kiro 流式：已有 text block → 不注入。
            // - Codex 非流式（Bedrock thinking 一次性返回）：无 text block → 注入。
            // - Claude：assistant text block 已渲染 → 不注入。
            const hasStreamedText = m.blocks.some(
              b => b.type === 'text' && (b.text || '').length > 0,
            )
```

逻辑（`:183-186`）保持不变。

- [ ] **Step 3: 编译 + 构建验证（纯注释/doc，无逻辑变更）**

Run: `cargo build && cd frontend && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/acp/process.rs frontend/src/components/AcpChatView.tsx
git commit -m "docs(acp): document AcpEvent render semantics + result-text contract

Make the implicit 'result.text is full final text; frontend renders it only
when no text was streamed' rule an explicit enum doc + frontend comment.
Single source of truth for render semantics; no logic change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 最终验证（全部任务完成后）

- [ ] **后端**：`cargo test` 全绿，`cargo build` 通过。
- [ ] **前端**：`cd frontend && npm run build && npm run lint` 通过。
- [ ] **手动**（需可运行的 Claude/Kiro CLI；构建后 `./start.sh --port 8080 --password test`）：
  - 新建 Claude 会话，发 "读一下 src/main.rs 前 20 行" → 工具行显示 `Read · main.rs` + 文件图标，点 "input" 可展开原始参数。
  - thinking 流式时展开、turn 结束自动折叠。
  - 最终回复只渲染一次（无重复）。
  - 新建 Kiro 会话触发工具 → tool_call 显示 title（无 summary 也正常）。

## Self-Review 记录

- **Spec 覆盖**：改动点 1（Task 1+2）、2（Task 3+4）、3（Task 5 文档化，已按 review 去掉 streamed 标志）、4（Task 5 enum doc + Task 3 折叠 input + 前端 default 兜底既有）全部有任务对应。
- **类型一致**：`format_tool_use(&str, Option<&Value>) -> Option<String>` 在 Task 1 定义、Task 2 调用一致；`summary` 字段在 Task 2（后端）/Task 3（前端类型与渲染）命名一致；`iconFor`/`TOOL_ICONS` 在 Task 3 定义即用。
- **无占位符**：所有代码步骤含完整代码与确切命令。
