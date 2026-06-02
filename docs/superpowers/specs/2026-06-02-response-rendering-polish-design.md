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
3. **result 重复渲染契约**（协议文档化 + 现有前端门控）
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

只产出**纯文字**，不带 emoji——图标交由前端 lucide 体系按 `name` 选择（见改动点 2），与 zeromux UI 语言一致。

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

## 改动点 2：thinking 折叠 + 流式合并 + 工具图标（前端）

后端无改动——三后端已发 `ContentBlock { block_type: "thinking", streaming }`。

`frontend/src/components/AcpChatView.tsx` 三处：

1. **thinking 流式合并**：`handleEvent` 的 `content_block` case 现仅对 `block_type === 'text'` 做"追加到末尾同类型 block"（约 `:141`）。扩展条件，让 `'thinking'` 也走同一合并路径——连续 streaming thinking chunk 追加进同一 thinking block，避免 Codex/Kiro 逐字 reasoning 炸出几百个 `<details>`。
   - **说明**：Claude 的 thinking 是整块 assistant block（不带 `streaming` 标记），每条 message 一个 thinking block，本就不触发合并；此改动只对 Codex/Kiro 的逐字 reasoning 生效。

2. **结束自动折叠**：`BlockView` 的 thinking case（约 `:354`）已是 `<details>`。改为 `<details open={!isComplete}>`——turn 进行中展开（看实时思考），turn 完成自动收起，主视图回归干练。

3. **工具图标 per-tool 映射**：`BlockView` 的 tool_use case 现固定用 `Wrench`（`:377`）。加一张 `name → lucide 图标` 的小映射表，未知工具回落 `Wrench`：

   | 工具 | lucide 图标 |
   |---|---|
   | Read / Edit / Write | `FileText` |
   | Bash | `Terminal` |
   | Grep / Glob | `Search` |
   | Agent / Task | `Bot` |
   | 其余（含 MCP） | `Wrench`（兜底） |

   映射表定义为模块级常量（`Record<string, LucideIcon>`），渲染时 `iconFor(block.name)`。配合改动点 1 的文字摘要，达到 naozhi emoji 区分的效果但保持 lucide 体系一致。

---

## 改动点 3：result 重复渲染契约（协议文档化）

**背景（review 修订）**：早先方案打算给 `AcpEvent::Result` 加 `streamed: bool` 标志告知前端"正文是否已流式发过"。Review 发现这是过度设计：

- 前端现有的 `hasStreamedText` 门控（`AcpChatView.tsx:176-187`，是之前修重复渲染 bug 留下的）**已经正确覆盖所有情况**，判据是"blocks 里是否已有非空 text block"——流式文本已到则不注入、Codex Bedrock 无 delta 则注入、Claude 仅 result 有文本则注入，全部正确。
- `streamed` 标志语义等价于 `hasStreamedText`，却引入两个新问题：① **Claude 无法准确设标志**——`translate_event` 逐行无状态，无法跨行知道"本轮发过 text block 没"；固定 `streamed: true` 会在"正文只在 result"的边缘情况下让前端漏渲染、丢答案。② 平添协议字段 + 跨后端状态追踪，违反仓库"simplicity first"。
- 逐一比对所有边缘（流式截断、result 重格式化、Bedrock 一次性返回），`streamed` 标志相比现有门控**无任何一处更优**。

**结论**：不加标志，不改协议结构。改为：

1. **现有门控保留为唯一权威判据**。`AcpEvent::Result` 结构不变（`text` 始终是完整最终文本）。`log_result_event`（`session_manager.rs:648`）**零改动**，dashboard `task_done` 摘要照常工作。
2. **协议文档化**：在 `AcpEvent::Result` 的 doc 注释里写清契约——"`text` 始终携带完整最终文本；前端仅在本轮未通过 ContentBlock 流式呈现过正文时，才将其渲染为最终文本块（见 `AcpChatView` result 门控）"。把这条隐式约定升级为成文契约（呼应改动点 4）。
3. **前端注释更新**：`AcpChatView.tsx` result case 的门控逻辑不变，仅更新注释，明确它是依据上述协议契约的权威判据，而非"启发式猜测"。

本改动点因此**不碰任何后端逻辑**，归入改动点 4 的"渲染语义文档化"，无独立代码改动与新增测试。

---

## 改动点 4：渲染语义单一文档真相源

不引入新机制。做两件事：

1. 在 `src/acp/process.rs` 的 `AcpEvent` enum 上，为每个变体补 doc 注释，写清**前端渲染语义**（是否渲染气泡、`text` 字段何时有效、`streaming` 含义、`Result.text` 的重复渲染契约见改动点 3）。enum 定义成为唯一权威说明。
2. 前端 `BlockView` 保留 `default: return null`、`handleEvent` 保留对未知 `type` 的忽略——后端新增 block_type/event 时优雅降级，无需同步改动即不崩。

附带 UX 改进：工具摘要显示后，原始 JSON input **不删除**，收进默认折叠的 `<details>`（复用现有 `<pre>`，默认 collapsed）。默认视图干练，debug 时可展开看完整参数——比 naozhi 直接丢弃 input 更适合开发者场景。

---

## 数据流（改动后）

```
agent CLI/进程
  → *_process.rs 归一化为 AcpEvent
      · tool_use ContentBlock 经 format::format_tool_use 填 summary
      · Result.text 始终完整（结构不变）
  → fan-out task：log_result_event（用完整 text，零改动）→ 序列化 → broadcast
  → /ws/acp/{id} → 前端 AcpChatView
      · tool_use：显示 summary + per-tool lucide 图标，原始 input 折叠
      · thinking：流式合并进单块，isComplete 后自动折叠
      · result：现有 hasStreamedText 门控——blocks 无 text block 时才注入 text
```

## 影响面 / 风险

| 改动 | 文件 | 风险 |
|---|---|---|
| `format.rs` 新模块 + 纯函数 | 新增 `src/acp/format.rs`，`src/acp/mod.rs` 注册 | 低（纯函数 + 单测） |
| `ContentBlock.summary` 字段 | `process.rs` + Claude/Kiro 填充（Codex 无 tool_use ContentBlock） | 低（新增 optional 字段，序列化跳过 None） |
| thinking 合并/折叠 + 工具图标映射 | `AcpChatView.tsx` | 低（纯前端） |
| result 契约文档化（无逻辑改动） | `process.rs` enum 注释 + `AcpChatView.tsx` 注释 | 低（仅注释，逻辑不变） |
| enum doc + 折叠 input | `process.rs` 注释 + `AcpChatView.tsx` | 低 |

不碰：`session_manager.rs` fan-out 结构与 `log_result_event`、Drop 清理、`SessionInput` 路由、scrollback 机制、auth、worktree、`AcpEvent::Result` 结构。

## 验证标准

- `cargo test` 通过（含新 `format.rs` 单测）。
- `cargo build` 通过；`cd frontend && npm run build && npm run lint` 通过。
- 手动：Claude/Kiro 会话发一条触发工具调用的 prompt，工具行显示一行摘要（非原始 JSON）+ per-tool 图标，原始 input 可展开；thinking 流式时展开、结束折叠；最终回复不重复渲染。
- Codex 非流式（若可复现 Bedrock thinking）：最终文本经现有 `hasStreamedText` 门控正常渲染一次。
