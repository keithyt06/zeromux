# Group A：AI Response 渲染优雅化 — 设计文档

**日期**：2026-06-02
**范围**：zeromux agent 会话的回复呈现层（Claude / Kiro / Codex 三后端 + 前端 `AcpChatView`）
**不在本轮范围**：进程生命周期韧性（`--resume` 恢复、watchdog 超时、容量驱逐、中断重发）——单独开 Group B spec；TodoWrite checklist 渲染；AskUserQuestion 交互卡片。

灵感来源：[KevinZhao/naozhi](https://github.com/KevinZhao/naozhi) 的 response 分层设计。借鉴其"按内容渲染寿命分类"的哲学，但**不照搬** IM 场景特有的机制（单横幅 EditMessage、双可见性集合 + contract test）——这些解决的是 zeromux 不存在的问题。

---

## 目标

让 agent 回复呈现"干练"：工具调用一行可读摘要而非原始 JSON、thinking 流式合并并在结束后自动折叠、消除最终文本的重复渲染。四个改动点：

1. **工具调用单行摘要**（后端统一生成）
2. **thinking 折叠 + 流式合并**（前端）
3. **result 流式/非流式契约**（后端为主）
4. **渲染语义单一文档真相源**（enum doc 注释 + 前端 default 兜底）

## 设计原则（遵循仓库 CLAUDE.md 的 Karpathy 规则）

- **不碰核心不变量**：broadcast fan-out 模型、Drop-based 清理、`SessionInput` 路由一律不动。改动只落在两处——`AcpEvent` 的"翻译/归一化"环节，和前端"展示"环节。
- **YAGNI**：不引入 naozhi 的 EventEntry 中间层（`AcpEvent` 已是归一层，再叠一层是过度设计）；不引入双可见性集合 + contract test（`AcpEvent` 只有一个消费者，不存在前后端漂移风险）。
- **纯函数优先**：摘要生成是无副作用纯函数，独立模块、内联单测。

---

## 改动点 1：工具调用单行摘要

### 新模块 `src/acp/format.rs`

导出一个纯函数，供三个后端共用：

```rust
/// 把一次 tool_use 的 (name, input) 压成一行人类可读摘要。
/// 未知工具有兜底，永不返回空字符串。
pub fn format_tool_use(name: &str, input: Option<&serde_json::Value>) -> String
```

只产出**纯文字**，不带 emoji——图标交由前端现有 lucide 体系（`Wrench` 等）按 `name` 选择，与 zeromux UI 语言一致。

| 工具 | 读取字段 | 摘要输出 |
|---|---|---|
| Read / Edit / Write | `file_path` | `父目录/文件名`（`shorten_path`） |
| Bash | `description`，否则 `command` | 截断 80 字 |
| Grep | `pattern`（+ `path`） | `pattern in 父目录/文件名` |
| Glob | `pattern` | 截断 |
| Agent / Task | `description` | 截断 60 字 |
| 兜底（含 MCP 工具） | — | `name`，或 `name: <input 前 300 字>` |

辅助函数 `shorten_path(p: &str) -> String`：只保留 `父目录/文件名`，根目录或无父目录时只留文件名。

### `AcpEvent::ContentBlock` 新增字段

```rust
ContentBlock {
    block_type: StaticOrOwnedStr,
    text: Option<String>,
    name: Option<String>,
    input: Option<serde_json::Value>,
    streaming: Option<bool>,
    /// 仅 tool_use 类型填充：format_tool_use 生成的一行摘要。
    /// text/thinking block 为 None。
    summary: Option<String>,   // #[serde(skip_serializing_if = "Option::is_none")]
}
```

三个后端在生成 `tool_use` 类型 `ContentBlock` 时调用 `format_tool_use` 填 `summary`：
- **Claude** `process.rs`：`translate_event` 的 assistant tool_use 分支。
- **Kiro** `kiro_process.rs`：`parse_session_update` 的 `tool_call` 分支（目前只填 `name`，补 `summary`）。
- **Codex** `codex_process.rs`：Codex 经 MCP 不直接暴露 tool_use 事件流；当前无 tool_use ContentBlock，故此处不涉及（保持现状，未来若暴露再接入同一函数）。

### 测试

`format.rs` 内联 `#[cfg(test)]`：每个工具一个 case + 未知工具兜底 + 空 input + `shorten_path` 边界（根目录、无父目录、超长）。沿用仓库现有内联测试风格。

---

## 改动点 2：thinking 折叠 + 流式合并（前端）

后端无改动——三后端已发 `ContentBlock { block_type: "thinking", streaming }`。

`frontend/src/components/AcpChatView.tsx` 两处：

1. **流式合并**：`handleEvent` 的 `content_block` case 现仅对 `block_type === 'text'` 做"追加到末尾同类型 block"（约 `:141`）。扩展条件，让 `'thinking'` 也走同一合并路径——连续 streaming thinking chunk 追加进同一 thinking block，避免 Codex/Kiro 逐字 reasoning 炸出几百个 `<details>`。

2. **结束自动折叠**：`BlockView` 的 thinking case（约 `:354`）已是 `<details>`。改为 `<details open={!isComplete}>`——turn 进行中展开（看实时思考），turn 完成自动收起，主视图回归干练。

---

## 改动点 3：result 流式/非流式契约

**原则**：result 事件**始终携带完整 text**，但新增 `streamed: bool` 显式告知前端"正文是否已通过流式 ContentBlock 发过"。前端据此决定是否注入最终文本块，不再用启发式猜测。

### `AcpEvent::Result` 新增字段

```rust
Result {
    text: String,
    session_id: String,
    cost_usd: Option<f64>,
    /// true = 正文已通过流式 ContentBlock 逐块发出（前端应忽略 text，
    /// 只取 cost/收尾）；false = 正文仅在此 Result 中（非流式一次性返回，
    /// 前端需把 text 渲染为最终文本块）。
    streamed: bool,
}
```

### 各后端如何设置 `streamed`

- **Codex** `codex_process.rs`：event loop 加局部标志 `streamed_text: bool`。进入 `Cmd::Prompt` 时复位为 `false`；每次发 `Notify::ProgressText`（即 `agent_message_content_delta`）时置 `true`。构造 `Result` 时 `streamed: streamed_text`。
  - 流式模型 → `true`（delta 已发过文本）。
  - Bedrock thinking 一次性返回 → `false`（无 delta，正文只在 tool 结果里）。
  - **注意**：`Notify::Reasoning`（thinking）**不**置 `streamed_text`——reasoning 不是正文，置 true 会误判。
- **Kiro** `kiro_process.rs`：每个 `agent_message_chunk` 已发 streaming ContentBlock 并累积进 `pending_text`。turn 结束构造 `Result` 时 `streamed: !pending_text.is_empty()`。`pending_text` 仍照常填入 `Result.text`（供日志），但前端会因 `streamed=true` 忽略它。
- **Claude** `process.rs`：assistant text block 已渲染正文，`result` 事件的 text 与之重复。固定 `streamed: true`（assistant 文本已发）。

### 为什么"保留 text + 标志位"而非"置空 text"

- `log_result_event`（`session_manager.rs:648`）用 `Result.text` 生成 dashboard `task_done` 摘要。置空会让摘要变空；要既 log 完整文本又发空给前端，得在 fan-out 里 clone-and-mutate `AcpEvent`，破坏"翻译一次"的干净模型。
- 保留 text 后 `log_result_event` **零改动**，语义从前端"猜"变成后端"显式告知"。代价仅 scrollback 多存一份已流式文本（每 turn 几百字～数 KB，可接受）。

### 前端简化（`AcpChatView.tsx` result case，约 `:163`）

```
注入条件：finalText 非空 && !evt.streamed && blocks 里无 text block
```
保留"blocks 里无 text block"作纯防御兜底；主判据改为后端的 `streamed` 标志。更新注释说明契约。

### 测试

Codex 的 `streamed_text` 标志复位/置位时机加单测：流式 delta → `streamed=true`；只有 reasoning 无 delta → `streamed=false`；新 Prompt 复位。

---

## 改动点 4：渲染语义单一文档真相源

不引入新机制。做两件事：

1. 在 `src/acp/process.rs` 的 `AcpEvent` enum 上，为每个变体补 doc 注释，写清**前端渲染语义**（是否渲染气泡、text 字段何时有效、streaming/streamed 含义）。enum 定义成为唯一权威说明。
2. 前端 `BlockView` 保留 `default: return null`、`handleEvent` 保留对未知 `type` 的忽略——后端新增 block_type/event 时优雅降级，无需同步改动即不崩。

附带 UX 改进：工具摘要显示后，原始 JSON input **不删除**，收进默认折叠的 `<details>`（复用现有 `<pre>`，默认 collapsed）。默认视图干练，debug 时可展开看完整参数——比 naozhi 直接丢弃 input 更适合开发者场景。

---

## 数据流（改动后）

```
agent CLI/进程
  → *_process.rs 归一化为 AcpEvent
      · tool_use ContentBlock 经 format::format_tool_use 填 summary
      · Result 带 streamed 标志（text 始终完整）
  → fan-out task：log_result_event（用完整 text）→ 序列化 → broadcast
  → /ws/acp/{id} → 前端 AcpChatView
      · tool_use：显示 summary + lucide 图标，原始 input 折叠
      · thinking：流式合并进单块，isComplete 后自动折叠
      · result：streamed=true 忽略 text，false 注入最终文本块
```

## 影响面 / 风险

| 改动 | 文件 | 风险 |
|---|---|---|
| `format.rs` 新模块 + 纯函数 | 新增 `src/acp/format.rs`，`src/acp/mod.rs` 注册 | 低（纯函数 + 单测） |
| `ContentBlock.summary` 字段 | `process.rs` + 三后端填充 | 低（新增 optional 字段，序列化跳过 None） |
| thinking 合并/折叠 | `AcpChatView.tsx` | 低（纯前端） |
| `Result.streamed` 字段 + 各后端逻辑 | `process.rs` / `codex_process.rs` / `kiro_process.rs` + 前端 result case | **中**（Codex 标志时机；有单测兜底） |
| enum doc + 折叠 input | `process.rs` 注释 + `AcpChatView.tsx` | 低 |

不碰：`session_manager.rs` fan-out 结构、Drop 清理、`SessionInput` 路由、scrollback 机制、auth、worktree。

## 验证标准

- `cargo test` 通过（含新 `format.rs` 单测、Codex `streamed` 单测）。
- `cargo build` 通过；`cd frontend && npm run build && npm run lint` 通过。
- 手动：Claude/Kiro 会话发一条触发工具调用的 prompt，工具行显示一行摘要（非原始 JSON），原始 input 可展开；thinking 流式时展开、结束折叠；最终回复不重复渲染。
- Codex 非流式（若可复现 Bedrock thinking）：最终文本正常渲染一次。
