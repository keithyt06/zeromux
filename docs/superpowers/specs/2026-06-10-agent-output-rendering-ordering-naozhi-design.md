# Agent 输出渲染 / 发收错位 / naozhi 选择性回复 — 设计文档

**日期**: 2026-06-10
**状态**: 已通过 brainstorm 评审，待 writing-plans
**涉及后端**: Claude Code / Codex / Kiro 三个 ACP 后端

## 背景与问题

用户报告三个并存的严重问题，分布在前端渲染层与后端事件层：

1. **偶发 markdown 渲染错误** — 三个 agent CLI 的流式输出，markdown 偶尔渲染不正确（代码当正文、表格列错位、整段当 code、mermaid 卡 pending）。
2. **参考 naozhi「不是所有内容都回复」** — 两侧都要：
   - 输入侧：连发多条消息时不要每条都触发一次回复（合并/排队）。
   - 输出侧：过滤 agent 输出里的噪音内容（thinking / 工具调用细节），只突出有价值的回复。
3. **发出内容与回复内容上下错位** — 用户发的 prompt 与 agent 回复在转录里垂直错位 / 顺序错乱。

三个问题的修复都落在同一层（`AcpChatView` 事件处理 + markdown 渲染 + 后端 fan-out emit），其中问题 3 的后端事件改造与问题 2 输入侧的 collect 合并 emit 是**同一处代码**，能合并实现。

## 根因分析（已在代码确认）

### 问题 3：发收错位

- `AcpEvent` 枚举（`src/acp/process.rs:27`）**没有任何「用户 prompt」变体** —— 后端 fan-out 从不把用户输入回显为事件。
- 因此 scrollback（`src/session_manager.rs` `push_scrollback`）只存 agent 事件（system / content_block / result / error / exit）。
- 前端用户气泡只在本地 state，`sendPrompt`（`AcpChatView.tsx:325-334`）乐观插入后，prompt 经 ws 直送后端，**永不回到前端**。
- 重连 / 刷新时前端 `setMessages([])`（`AcpChatView.tsx:112` 附近）清空，然后 `ws_handler.rs:87-103` 只回放 agent 事件 → 用户气泡消失、回复变孤儿、顺序错乱。
- **次因**：collect 把 N 条用户消息合并为 1 个 turn（`session_manager.rs` collect 分支），前端却已显示 N 个用户气泡 → N 对 1 错位。

### 问题 1：偶发 markdown 渲染

- `MarkdownContent.tsx:60-66` 在流式过程中**每来一个 delta 就把累加文本整体重解析一次**（`AcpChatView.tsx:194-197` 字符串拼接 → `MarkdownContent` 直接喂 `deferredText`）。
- 流到一半时，code fence ` ``` `、表格 `|`、数学 `$` 都还没闭合，react-markdown（remark-gfm / remark-math）会误判未闭合内容。
- 「偶发」的本质：网络越慢、delta 越多，撞上未闭合状态被渲染的概率越高。
- Mermaid 额外问题（`MermaidBlock.tsx:13,18-37`）：`mermaidCache` 用**原始（可能半截）代码字符串**当 key，且 `useEffect` 有竞态会把过期 / 错误 SVG 写进缓存。

### 问题 2：naozhi 选择性回复

- naozhi（github.com/KevinZhao/naozhi，Go 网关）的机制是 `session.queue.mode` 三态策略：
  - `collect`（默认）：busy 时排队，settle 延迟后合并为一条后续 prompt。
  - `interrupt`：每条新消息打断当前 turn。
  - `passthrough`：每条独立转发（需 stream-json 后端，ACP 自动回退 collect）。
  - 群聊 @mention 门控 + slash 命令路由。
- zeromux 目前**只对 Claude** 实现了 collect（见 `2026-06-09-message-queue-collect-and-auto-titler-design.md`）。naozhi 的增量是：三态可切策略 + 扩到全后端。

## 设计决策（用户已拍板）

- **问题 3 气泡策略**：乐观插入 + `user_prompt` 事件回填去重（兼顾发送手感与一致性）。
- **问题 2 输出侧默认态**：默认**精简**模式（隐藏 thinking / 工具细节），手动展开。
- **问题 2 输入侧**：collect 抽象为 per-session 可切策略，扩到 Codex/Kiro。
- **三者都严重，一起做**，按依赖排序 G3 → G1 → G2。

---

## G3 — 修复发收错位

### 后端（`src/acp/process.rs`, `src/session_manager.rs`）

1. `AcpEvent` 新增变体：
   ```rust
   /// 用户 prompt 回显。fan-out 在实际把 prompt 送入 CLI 的那一刻 emit，
   /// 用于持久化到 scrollback，保证重连回放时用户气泡与回复对齐。
   /// collect 合并后只在 flush 那条 emit 一次（修掉 N→1 错位）。
   UserPrompt {
       text: String,
       /// 发起客户端的乐观气泡 id；同一客户端收到后据此去重，
       /// 其他设备 / 重连回放时为 None 或不匹配 → 正常 push 气泡。
       #[serde(skip_serializing_if = "Option::is_none")]
       client_id: Option<String>,
   },
   ```
   序列化为 `{"type":"user_prompt", "text":..., "client_id":...}`。

2. fan-out 在**实际把 prompt 送入 CLI 的那一刻** emit `UserPrompt`：
   - 三个 agent 后端的 `SessionInput::Prompt` 处理点（`session_manager.rs` 约 1727 / 2004 / 2171，对应 Claude / Codex / Kiro fan-out）。
   - collect 模式下：**只在 flush（合并送出）那条 emit 一次**，合并文本即 emit 的 text。这自动修掉 N→1 错位。
   - `interrupt` / `passthrough`：每条送出时 emit。

3. 该事件走正常 `event_tx` → 自动进 scrollback。**与 queued 事件相反**（queued 是 ephemeral 被 `ws_handler.rs:124-144` 排除持久化），`user_prompt` **要持久化**，无需特判。

4. `client_id` 透传：`SessionInput::Prompt` 需携带可选 `client_id`（来自 ws `ClientMsg::Prompt`），fan-out emit 时原样带回。

### 前端（`AcpChatView.tsx`, ws ClientMsg）

5. `sendPrompt` 仍乐观插入用户气泡，气泡 `id` 即 `clientMsgId`；ws `prompt` 消息带上 `client_id: clientMsgId`。

6. 新增 `case 'user_prompt'`：
   - 若本地 `messages` 已存在该 `client_id` 的用户气泡 → 跳过（去重，本机乐观插入已显示）。
   - 否则（别的设备发的 / 重连回放）→ push 一条用户气泡，顺序由事件流决定。

7. 重连 `setMessages([])` 后只信任回放事件流 → 用户气泡随 `user_prompt` 事件按正确顺序回填 → 发/收对齐，多设备一致。

### 验收

- **后端单测**：collect 合并 N 条 → 只 emit 1 条 `UserPrompt`（合并文本）。
- **前端单测**：给定回放事件序列 `[user_prompt(c1), content_block, result, user_prompt(c2), ...]`，断言消息数组顺序为 `user→assistant→user→...`；带本地乐观气泡 `c1` 时收到 `user_prompt(c1)` 不重复插入。
- **手测**：重连后历史完整、用户气泡与回复上下对齐；第二设备能看到对方发的 prompt。

---

## G1 — 修复偶发 markdown 渲染错误

**纯前端，集中在 `frontend/src/components/markdown/`。**

### ① 流式期栅栏补全（核心）

新增纯函数 `sanitizeStreamingMarkdown(text: string): string`（新文件 `markdown/sanitize.ts`），**仅当 `!isComplete` 时调用**。收窄到三类高频崩溃形态：

- **未闭合 code fence**：统计 ` ``` ` 数量为奇数 → 末尾补一个 ` ``` `。
- **半截表格行**：最后一行是未完成的 `|...`（无换行收尾、且其上方无合法分隔行）→ 该行降级为纯文本（转义首个 `|` 或整行包裹，避免被当 table 解析）。
- **未闭合数学 `$` / `$$`**：`$$` 数量为奇数或行内 `$` 未配对 → 末尾补一个收尾，或回退为字面量。

`isComplete` 后用**原始 `text`**（不 sanitize），保证最终渲染 100% 准确。

`MarkdownContent.tsx` 改动：`const rendered = isComplete ? deferredText : sanitizeStreamingMarkdown(deferredText)`，喂给 `<ReactMarkdown>`。

### ② 重组件只在完成态渲染

`CodeBlock.tsx` 已有 `.mermaid-pending` 机制（`isComplete === false` 时渲染灰色 `<pre>`）。确认 mermaid 块在 `!isComplete` 时**始终** pending、不进 `MermaidBlock`，避免对半截 mermaid 源码触发渲染。

### ③ Mermaid 缓存修竞态（`MermaidBlock.tsx`）

- 缓存 key 从原始 `code` 字符串改为 `fnv1a(code)`（复用 `hash.ts`）。
- **只在渲染成功且组件未取消时写缓存**；失败 / 错误态不写（避免半截 / 错误 SVG 污染后续相同前缀）。
- 确认现有 `useEffect` cancel guard 保证 stale code 不写缓存。

### 验收

- `sanitize.test.ts`：喂半截 markdown（未闭合 fence / table / math）断言输出可被 react-markdown 安全解析、不把后续正文吞进 code 块；完整 markdown 原样返回。
- mermaid 缓存测试：断言失败态不写缓存、key 用 hash、相同源码命中缓存。

### 范围约束

sanitize 是**启发式**，只覆盖三类高频形态，不追求覆盖全部 markdown 语法（CLAUDE.md「simplicity first」）。极端情况由「完成态用原始文本」兜底——最终渲染始终准确，只优化流式期观感。

---

## G2 — naozhi 参考（输入侧策略 + 输出侧精简）

### 输入侧：collect 抽象为 per-session 可切策略

**后端（`session_manager.rs`）**

- 现有 Claude collect 逻辑抽象为 `QueueMode` 枚举：`Collect`（默认） / `Interrupt` / `Passthrough`。
- 扩展到 Codex / Kiro 的 `SessionInput::Prompt` 分支，复用已验证的 collect 核心（pending 队列 + settle 防抖 + 硬上限）。
- `Passthrough` 对 ACP 后端（Kiro）自动回退 `Collect`（与 naozhi 一致）。
- 与 G3 合流：collect flush 那条就是 `UserPrompt` emit 点。

**控制面（克制）**

- per-session 切换：ws `ClientMsg` 新增 `SetQueueMode { mode }`。
- 前端 `SessionInfoBar` 加一个小下拉（Collect / Interrupt / Passthrough）。
- **不做** naozhi 的 `/stop` `/urgent` slash 命令（YAGNI；zeromux 已有 interrupt-resend 行为）。

### 输出侧：默认精简，手动展开

**纯前端（`AcpChatView.tsx` + block 渲染）**

- 新增 per-session `density: 'concise' | 'full'`，**默认 `concise`**。
- `concise` 模式：只渲染 `text` 正文 + `tool_use` 的一行摘要（`name · summary`）；`thinking` 块和 `tool_use` 原始 `input` 折叠隐藏。
- 顶部 / 每条 assistant 气泡可切 `full` 展开全部。
- **无损**：scrollback / blocks 数据完整保留，只是渲染层过滤，随时可展开。

### 验收

- 前端单测：同一组 blocks 在 `concise` 下断言 thinking / raw-input 不渲染、text + 摘要渲染；切 `full` 全显示。
- 后端单测：Codex / Kiro 的 collect 队列 N 条合并为 1 turn（复用现有 collect 测试模式）；`Passthrough` 在 Kiro 回退 `Collect`。

---

## 实现顺序与依赖

1. **G3**（后端 `UserPrompt` 事件 + 前端去重回填）—— 先做，建立单一真相源。
2. **G1**（前端 sanitize + mermaid 缓存）—— 独立，纯前端。
3. **G2**（输入侧 QueueMode 抽象复用 G3 emit 点 + 输出侧 density）—— 最后，依赖 G3 的 emit 点。

每组各自有可验收的单测，分别提交。

## 非目标（YAGNI）

- 不实现 naozhi 的 IM 网关（Feishu/Slack/Discord）、`/stop` `/urgent` slash 命令、群聊 @mention 门控。
- 不做后端层面丢弃噪音块（输出侧过滤纯前端、无损）。
- markdown sanitize 不追求覆盖全部语法，只收窄三类高频崩溃形态。
- 不引入全局事件序号 / 时间戳排序（scrollback 事件流顺序即真相）。
