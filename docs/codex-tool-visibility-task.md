> **状态: 已实现 (2026-06-03)。** 后端 `codex_process.rs` 新增 `extract_codex_exec_begin/end`、`extract_codex_patch_begin/end` 四个提取函数 + `Notify::ToolUse/ToolResult` 变体,映射为 `AcpEvent::ContentBlock`(`tool_use`/`tool_result`);前端 `AcpChatView.tsx` 联合类型补 `'tool_result'` 并加 `BlockView` 渲染分支。沿用 try_send 非阻塞约束。已补 8 个单测。

## 背景

上游作者在 [`5d95442` (Add Codex agent support via ACP)](https://github.com/stevensu1977/zeromux/commit/5d9544239) 用 `codex exec --json` 子进程实现了 Codex，并通过 `translate_codex_event` 把 shell 命令执行渲染成 `tool_use` / `tool_result`，用户能看到 Codex 跑了哪条命令、输出和 exit code。

我们走的是 `codex mcp-server` + rmcp 路线（流式 + 多轮上下文更优），但 `on_custom_notification` 目前**只解析了 text / reasoning / error 三类 `codex/event`**，漏掉了命令执行和文件编辑事件 —— 在一个 coding agent 平台里，看不到 Codex 实际执行了什么，是真实的功能缺口。

本 issue 把这个"工具调用可见性"补齐。

## ⚠️ 不能照搬上游的字段名

上游解析的是 `codex exec --json` 的 schema（`item.started` / `item.completed` + `item.type == "command_execution"`，`command` 是**字符串**）。

**我们走的是 `mcp-server` 的 `codex/event` 通知，schema 完全不同。** 已对照 `openai/codex` v0.136 源码（`codex-rs/protocol/src/protocol.rs`，`EventMsg` 用 `#[serde(tag="type", rename_all="snake_case")]`）核实，且 `codex-rs/mcp-server/src/codex_tool_runner.rs:210` 确认 mcp-server 会把**每个 event 都作为 `codex/event` 通知转发**，所以这些事件我们收得到。

真实 `msg.type` 与字段如下：

### shell 命令执行（一并配对 begin/end）
- **`exec_command_begin`** — 字段：`call_id: String`、`command: Vec<String>`、`cwd`、`parsed_cmd`
- **`exec_command_end`** — 字段：`call_id: String`、`command: Vec<String>`、`stdout`、`stderr`、`aggregated_output`、`exit_code: i32`、`status`
- begin / end 是**两个独立通知**，靠 `call_id` 配对。

### 文件编辑（apply_patch）
我们用 `approval-policy:"never"`，所以走的是**自动应用**事件，不是 `apply_patch_approval_request`：
- **`patch_apply_begin`** — `call_id: String`、`auto_approved: bool`、`changes: HashMap<PathBuf, FileChange>`
- **`patch_apply_end`** — `call_id: String`、`stdout`、`stderr`、`success: bool`、`status`、`changes`

## 实现方案

**后端 `src/acp/codex_process.rs`：**
1. 新增 `Notify` 变体（如 `ToolUse { name, input }` / `ToolResult { name, text }`），或直接复用现有 `ContentBlock` 通路。
2. 在 `on_custom_notification` 增加提取函数：`extract_codex_exec_begin/end`、`extract_codex_patch_begin/end`，沿用现有 `extract_codex_event_*` 的写法（先判 `method == "codex/event"`，再取 `msg.type`）。
3. 事件循环里映射成 `AcpEvent::ContentBlock`：
   - `exec_command_begin` → `block_type:"tool_use"`，`name:Some("shell")`，`input:{"command": command.join(" ")}`，`streaming:Some(false)`
   - `exec_command_end` → `block_type:"tool_result"`，`name:Some("shell")`，`text:Some(format!("$ {cmd}\n{output}\n[exit: {code}]"))`
   - `patch_apply_begin` → `tool_use`，`name:Some("apply_patch")`，`input` 放 `changes` 的文件列表
   - `patch_apply_end` → `tool_result`，`name:Some("apply_patch")`，`text` 放 stdout/stderr + success
4. **沿用 try_send 非阻塞约束**（回调里绝不能 await，否则死锁 rmcp 传输读取任务）。
5. 给每个新提取函数补 `#[cfg(test)]` 单测，对齐现有测试风格。

**前端 `frontend/src/components/AcpChatView.tsx`（必须改，否则后端发了也不渲染）：**
6. `ContentBlock.type` 联合类型当前是 `'text' | 'thinking' | 'tool_use'`，**缺 `'tool_result'`** → `renderBlock` 的 switch 会落到 `default: return null`，静默吞掉。需要：
   - 联合类型加 `'tool_result'`
   - `renderBlock` 加 `case 'tool_result'` 分支（建议复用 tool_use 的样式，换个颜色/图标区分输入与结果）

## 验收标准
- 让 Codex 跑一条会执行 shell 的任务（如"列出当前目录文件"），聊天界面能看到命令气泡 + 输出 + exit code。
- 让 Codex 改一个文件，能看到 apply_patch 的工具气泡 + 涉及的文件。
- `cargo test` 新增的提取函数单测通过。
- 不破坏现有 text / reasoning / error 流式渲染。

## 范围外
- 不处理 `exec_command_output_delta`（命令输出的流式 base64 分块）—— 先用 end 事件的 aggregated_output 一次性出。如需实时滚动输出再单开 issue。
