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

> **CTO 评审修正（D2 + 外部 codex 评审 T2）**：当前 scrollback 写入在**每个 WS 连接的事件循环里**（`ws_handler.rs:143`），多设备连同一会话会重复存储事件 → 重连回放双影。`UserPrompt` 走同一路径会被多写。**本次把 scrollback 写入从 per-连接移到 fan-out 任务内部写一次**，fan-out 是进程唯一所有者（核心不变量）。
> **关键（T2）**：写入必须**无条件**，与 `event_tx.send` 是否成功**解耦**——`broadcast::send` 在零订阅者时返回 `Err`，若把写档绑在 send 成功上，断开所有设备期间（手机锁屏后台跑 agent）的输出会丢。顺序：先 `push_scrollback(...)`，再 `let _ = event_tx.send(...)`（忽略零订阅者 Err）。`ws_handler.rs:143` 的 `push_scrollback` 删除。（`session_manager.rs:1248` 的 resume_failed 一次性写入是特例，保留。）
> **集中持久化点（codex 评审）**：为避免「每个 send site 都要判断事件是否 durable」（queued 是 ephemeral、user_prompt 要持久化、resume_failed 是特例），引入一个**单一 emit/persist helper**：`fn emit(event_tx, scrollback, evt)`，内部决定 durable 与否（ephemeral 集合：`System{queued}`），所有 fan-out 经它发事件。三个 fan-out 不再各自调 `event_tx.send` + `push_scrollback`。

#### turn_id —— 发收对齐的真正基础（外部 codex 评审 T1，最重要）

> **原设计缺陷**：spec 原假设「事件到达顺序 = 真相」。但**边流式边发**场景下不成立：用户在 assistant 仍在流式输出时发一条，入队即 emit 会把 `user_prompt` 插进上一个 assistant turn 的 ContentBlock 中间。重连回放得到 `[assistant块][assistant块][user_prompt][assistant块]` —— prompt 被插进上一个回答里。**这正是用户报告的「上下错位」症状**，raw 交织顺序无法表达「哪条 prompt 对应哪个回答」。

- **每个事件带 `turn_id`**（`UserPrompt` 和所有 assistant `ContentBlock`/`Result`）。后端已有 `turn_seq`（`mark_turn`）可复用为 turn 标识。
- 用户 prompt 携带它**所属/触发的 turn** 标识；assistant 输出携带**它属于哪个 turn**。
- **前端按 turn_id 分组渲染**，而非信任原始事件交织顺序。同一 turn 的 user prompt(s) + assistant 输出归为一组，跨 turn 按 turn_id 排序。
- 这样「边流边发」时，新 prompt 归入它自己的（下一个）turn 分组，不会插进上一个回答中间。

1. `AcpEvent` 新增变体 + 现有变体加 `turn_id`：
   ```rust
   /// 用户 prompt 回显。每条用户 prompt 入队即 emit 一个（collect 合并成一个
   /// turn 时仍 N 个事件，见 P1）。turn_id 标识它触发/归属的 turn，前端据此分组。
   UserPrompt {
       text: String,        // 进 scrollback 前按单条上限截断（T3，见下）
       turn_id: u64,        // = 该 prompt 归属的 turn_seq
       #[serde(skip_serializing_if = "Option::is_none")]
       client_id: Option<String>,  // 乐观气泡去重
   },
   // ContentBlock / Result 增加 turn_id: u64 字段
   ```
   序列化 `{"type":"user_prompt","text":...,"turn_id":N,"client_id":...}`。

2. fan-out 为**每一条用户 prompt** emit 一个 `UserPrompt`（P1）：
   - 三个 `SessionInput::Prompt` 处理点（`session_manager.rs` 1727 / 2004 / 2158 对应 Claude / Kiro / Codex）。**注意：collect 三处已是近重复，按 G2a 先抽象再改。**
   - emit 时机 = 入队那一刻；turn_id 取该 prompt 将归属的 turn_seq。collect 合并成一个 turn 时，N 条 UserPrompt 共享同一 turn_id（它们确实合并进了同一个 agent turn），但仍是 N 个事件 → 前端同组显示 N 个用户气泡 + 1 个回答，发送与重连一致。
   - `interrupt` / `passthrough`：每条送出时 emit，各自 turn_id。

3. **T3 安全/保留**：`UserPrompt.text` 进 scrollback 前加**单条字节上限**（如 64KB），超出截断并标记 `[已截断 N 字节]`。防一条大粘贴冲爆 2MB scrollback。**不做** redaction（密钥扫描，太重、误报风险，记 P3 TODO）。仓库「不存密钥」铁律：scrollback 是内存环形缓冲、不落盘（除非 `--log-dir`），文档需提示用户调试日志慎开。

4. `client_id` 透传：`SessionInput::Prompt` 加可选 `client_id`（来自 ws `ClientMsg::Prompt`），emit 时带回。

### 前端（`AcpChatView.tsx`, ws ClientMsg）

5. `sendPrompt` 仍乐观插入用户气泡，气泡 `id` = `clientMsgId`；ws `prompt` 带 `client_id`。

6. 新增 `case 'user_prompt'`：本地已存在该 `client_id` 气泡 → 跳过去重；否则按 turn_id 分组插入。

7. **消息列表改为按 turn_id 分组的结构**，而非纯 append 数组。重连 `setMessages([])` 后按回放事件的 turn_id 重建分组 → 发/收对齐，多设备一致，边流边发不插中间。

### 验收

- **后端单测**：collect 合并 N 条 → 仍 emit N 条 `UserPrompt`，共享同一 turn_id（P1 + T1）。
- **后端单测（T2 CRITICAL 回归）**：无订阅者时 fan-out emit → scrollback 仍写入（不依赖 send 成功）。
- **后端单测（D2 CRITICAL 回归）**：两个 subscribe() 模拟双连接 → scrollback 仍 N 条（非 2N）。
- **后端单测（T3）**：超长 UserPrompt → scrollback 中被截断 + 标记。
- **前端单测（T1 CRITICAL）**：边流边发序列 `[ContentBlock(t1), ContentBlock(t1), UserPrompt(t2), ContentBlock(t1)]` → 按 turn 分组后 t1 的回答完整成组、t2 prompt 不插进 t1 中间。
- **前端单测**：回放 `[user_prompt(c1,t1), content_block(t1), result(t1), user_prompt(c2,t2), ...]` → 顺序 `user→assistant→user`；本地乐观气泡 c1 收到 user_prompt(c1) 不重复。
- **手测**：重连历史完整对齐；第二设备见对方 prompt；流式中发新消息不插进上一回答。

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

> **CTO 评审（D3）— 已知性能债（本次不做，记为 P2 TODO）**：sanitize 修的是**正确性**（半截 markdown 不再误判），但不修**成本**：`MarkdownContent` 仍在每个 delta 对整条累加文本重新解析一次（O(n²)：一段 500 行输出流式 200 个 delta = 200 次对增长串的全解析）。短消息不疼，手机端长输出会可见卡顿，`useDeferredValue` 只缓解不消除。**根治方案 = block-freezing**（已闭合的 markdown block 冻结不再重解析，只 sanitize + 重解析末尾进行中的那一块，即 streamdown/marked-streaming 的做法）。本次保留小 diff，block-freezing 显式记为 P2 TODO，不静默丢。

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

> **CTO 评审修正（D1）— 前提纠错**：spec 原写「collect 是 Claude-only，扩展到 Codex/Kiro」。**这是错的**。读代码确认三个 fan-out 都已有一模一样的 collect 逻辑：`spawn_acp_fanout`（Claude，1727-1822）、`spawn_kiro_fanout`（2004-2082）、`spawn_codex_fanout`（2158-2240），均含 pending 队列 + 500ms 防抖（`COLLECT_DEBOUNCE_MS`）+ 3000ms 硬上限（`COLLECT_MAX_MS`）+ `merge_pending` + `emit_queued`。collect 早已全后端覆盖。**真正净新增的只有 `QueueMode` 可切策略**。

**后端（`session_manager.rs`）**

- **先抽象再加策略（D1，Beck「make the change easy then make the easy change」）**：三个 fan-out 是 ~165 行的近重复。直接在三处各加 `QueueMode` 状态机 = 把状态机复制三份（违反 DRY）。**先把三个 fan-out 的 collect/队列循环抽成一个共享 helper**（输入分支处理 + flush + emit_queued 已经是逐字相同的），再在这一处实现 `QueueMode`。
- `QueueMode` 枚举：`Collect`（默认，= 现有行为） / `Interrupt`（每条打断当前 turn） / `Passthrough`（每条独立转发）。
- `Passthrough` 对 ACP 后端（Kiro）自动回退 `Collect`（与 naozhi 一致；ACP 无独立并发 turn 语义）。
- 与 G3 合流：每条 prompt 入队即 emit `UserPrompt`（见 G3 P1 决定），与 QueueMode 无关。

**控制面（克制）**

- per-session 切换：ws `ClientMsg` 新增 `SetQueueMode { mode }`。
- 前端 `SessionInfoBar` 加一个小下拉（Collect / Interrupt / Passthrough）。
- **不做** naozhi 的 `/stop` `/urgent` slash 命令（YAGNI；zeromux 已有 interrupt-resend 行为）。

### 输出侧：默认精简，手动展开

**纯前端（`AcpChatView.tsx` + block 渲染）**

- 新增 per-session `density: 'concise' | 'full'`，**默认 `concise`**。
- 按「signal vs noise 分类规则」组织（护栏二，移动 triage 第一步），而非硬编码隐藏 thinking：
  - **signal（concise 下始终显示）**：`text` 正文、错误、turn 完成、（未来）权限请求。
  - **noise（concise 下折叠）**：`thinking` 块、`tool_use` 原始 `input`。`tool_use` 保留一行摘要（`name · summary`）作为「做了什么」的最小信号。
- **信任护栏（P2）**：默认 concise 是行为改变，必须让被折叠内容**可见且可逆**：
  - 每处折叠显示一个明确的占位（如 `+N 条思考/工具 · 点击展开`），而非静默消失——避免用户以为 agent 跳了步骤。
  - 每条 assistant 气泡可单独展开；顶部 per-session 开关切 `full`。
  - 首次进入会话时一次性提示「已为你精简显示，可切完整」（一次性，记 localStorage 标志）。
- **无损**：scrollback / blocks 数据完整保留，只是渲染层过滤，随时可展开。

### 验收

- 前端单测：同一组 blocks 在 `concise` 下断言 thinking / raw-input 不渲染、text + 摘要渲染；切 `full` 全显示。
- 后端单测：Codex / Kiro 的 collect 队列 N 条合并为 1 turn（复用现有 collect 测试模式）；`Passthrough` 在 Kiro 回退 `Collect`。

---

## 实现顺序与依赖（CTO 评审后修订）

> **CTO + codex 评审后的关键修订**：先做集中 emit/persist helper 抽象，再在其上加 UserPrompt/turn_id，避免在三个重复 fan-out 上反复改（codex 指出原 G3-先-G2 顺序是 churn）。

1. **G0 — 集中 emit/persist helper（D2 + T2 + codex）**：引入 `emit(event_tx, scrollback, evt)` 单一持久化点，无条件写 scrollback、与 send 解耦、内部判 ephemeral。三个 fan-out 改用它。删 `ws_handler.rs:143` 的 push_scrollback。**这一步同时修好多设备双写 + 无订阅者丢输出两个既有 bug。**
2. **G2a — 抽象三个 fan-out 的 collect/队列共享 helper（D1）**：与 G0 相邻做（都在动这三处）。无行为变化，现有 collect 测试应全绿。
3. **G3 — `turn_id` + `UserPrompt` 事件 + 前端按 turn 分组（T1 + P1 + T3）**：建立发收对齐。依赖 G0（持久化）+ G2a（单一改点）。前端消息结构改 turn 分组。
4. **G1 — 前端 sanitize + mermaid 缓存**：独立，纯前端，可与后端并行。
5. **G2b — 在共享 helper 加 `QueueMode` + 前端 density 精简**：依赖 G2a + G3。

## 测试覆盖（CTO 评审 — 必须随实现一起写）

```
后端 (Rust #[cfg(test)])
[+] emit/persist helper (G0, D2+T2)
  ├── [GAP] 单 fan-out emit N 事件 → scrollback 恰好 N 条(非 2N)
  ├── [GAP] [→集成] 两个 subscribe() 模拟双连接 → scrollback 仍 N 条(D2 回归,CRITICAL)
  ├── [GAP] 无订阅者 emit → scrollback 仍写入(T2 回归,CRITICAL)
  └── [GAP] System{queued} 不进 scrollback(ephemeral 仍被正确排除)
[+] UserPrompt + turn_id emit (G3)
  ├── [GAP] 每条 prompt 入队 → 一个 UserPrompt 事件(含 client_id + turn_id)
  ├── [GAP] collect 合并 N 条成 1 turn → 仍 N 个 UserPrompt,共享同一 turn_id(P1+T1 回归,CRITICAL)
  ├── [GAP] 超长 UserPrompt.text → scrollback 中截断+标记(T3)
  └── [GAP] UserPrompt 进 scrollback(非 ephemeral)
[+] QueueMode (G2b)
  ├── [GAP] Collect = 现有行为(复用现有 collect 测试)
  ├── [GAP] Interrupt 每条打断 turn
  ├── [GAP] Passthrough 每条独立发送
  └── [GAP] Passthrough 在 Kiro 回退 Collect
[+] collect 共享 helper (G2a)
  └── [★ 现有] merge_pending 测试已存在(2630);抽象后应不变

前端 (vitest)
[+] sanitize.ts (G1)
  ├── [GAP] 未闭合 ``` → 补栅栏,后续正文不被吞
  ├── [GAP] 半截表格行 → 降级纯文本
  ├── [GAP] 未配对 $ → 补/回退字面量
  └── [GAP] 完整 markdown → 原样返回(isComplete 不 sanitize)
[+] mermaid 缓存 (G1)
  ├── [GAP] key 用 fnv1a(code)
  └── [GAP] 渲染失败态不写缓存
[+] user_prompt + turn 分组 (G3)
  ├── [GAP] 边流边发 [ContentBlock(t1),ContentBlock(t1),UserPrompt(t2),ContentBlock(t1)] → t1 回答成组,t2 不插中间(T1 CRITICAL)
  ├── [GAP] 回放 [user_prompt(c1,t1),content_block(t1),result(t1),user_prompt(c2,t2)] → 顺序 user→assistant→user
  └── [GAP] 本地乐观气泡 c1 + 收到 user_prompt(c1) → 不重复插入(去重)
[+] density 精简 (G2b)
  ├── [GAP] concise: thinking/raw-input 不渲染,text+工具一行摘要渲染
  ├── [GAP] concise: 折叠处显示 "+N 条" 占位(非静默消失)
  └── [GAP] full: 全部显示
```

**关键回归测试（IRON RULE）**：(1) 多设备 scrollback 不双写；(2) collect 合并后 UserPrompt 数 = 用户实际发送条数。两者都是「修一个错位时别引入另一个错位」的证明。

每组各自有可验收的单测，分别提交。

## 12 个月方向（命名原则，本次不实现）

经 PM/CEO 评审（2026-06-10），三个问题的共同根因被命名为：**对话转录缺少一个「服务端拥有、持久」的单一真相源**。当前前端持有用户气泡（React state）、后端持有 agent 事件（2MB `VecDeque` 环形缓冲），两者从不和解。

本次选 **方案 A**（三个独立手术刀式补丁），但带两条护栏，避免日后返工：

1. **护栏一 — 命名 12 个月方向**：理想终态是「服务端拥有完整有序的转录（持久化，非环形缓冲），客户端是纯投影」。这解锁历史/搜索/多设备恢复/导出/为已上线的 auto-titler 提供真实数据/naozhi 式 IM 桥。**本次不做**，但 `UserPrompt` 事件必须设计成「日后可无痛重定向到真实存储」——即事件 schema 自带顺序语义、不依赖前端 state。
2. **护栏二 — concise 模式是移动端 triage 第一步**：输出侧精简模式不是一次性开关，而是「在小屏 + 间歇性注意力下，突出需要我的内容（提问/完成/错误/权限请求），抑制工具调用噪音」这一移动 triage 能力的 MVP wedge。设计时按「分类规则」组织（哪些块属于 signal、哪些属于 noise），而非硬编码隐藏 thinking。

**已知残留缺口（方案 A 不消除，留给 CTO 评审压测）**：scrollback 是 2MB 环形缓冲，从头淘汰。G3 修好后短会话发收对齐正确，但重连一个 2 小时前的长会话，开头仍可能已被淘汰。durability 不在本次范围。

## 非目标（YAGNI）

- 不实现 naozhi 的 IM 网关（Feishu/Slack/Discord）、`/stop` `/urgent` slash 命令、群聊 @mention 门控。
- 不做后端层面丢弃噪音块（输出侧过滤纯前端、无损）。
- markdown sanitize 不追求覆盖全部语法，只收窄三类高频崩溃形态。
- 不引入全局事件序号 / 时间戳排序（scrollback 事件流顺序即真相）。
- **不做服务端对话持久化**（12 个月方向，见上；本次仅把 `UserPrompt` 设计成日后可重定向）。

## 延迟事项（TODOS — CTO 评审surfaced）

- **P2 — markdown block-freezing**（D3）：根治流式 O(n²) 重解析。冻结已闭合 block，只重解析末尾进行中块。手机端长输出卡顿的真正解法。本次 sanitize 只修正确性。
- **P2 — scrollback durability**：当前 2MB `VecDeque` 从头淘汰，长会话重连丢开头。属 12 个月「服务端持久化转录」方向的一部分。G3 修短会话对齐，不修 durability。
- **P3 — naozhi `/stop` `/urgent` 抢占动词、群聊 @mention 门控、IM 网关**：naozhi 有但 zeromux 本次不做（YAGNI，已有 interrupt-resend）。
- **P3 — UserPrompt redaction（密钥扫描）**：T3 只做大小上限，不做密钥脱敏（误报风险）。若日后开 `--log-dir` 落盘需重新评估。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | 3 proposals (premise reframe + P1 + P2), guardrails folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 4 issues (D1 collect-already-shipped, D2 scrollback double-write, D3 O(n²) perf, helper DRY) |
| Codex Review | codex outside voice | Independent 2nd opinion | 1 | issues_found | 3 design-changing (T1 turn_id, T2 no-subscriber persist, T3 prompt size/secrets) + 1 doc contradiction |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | concise-mode UX has trust guardrails (P2); full visual review optional |
| DX Review | `/plan-devex-review` | Developer experience | 0 | — | n/a |

- **CODEX:** caught a spec self-contradiction (N→1 vs N, fixed) and the single most important finding — emit-at-enqueue interleaves `user_prompt` into the prior streaming turn, so G3 needed `turn_id` grouping to actually fix 错位 rather than reshape it.
- **CROSS-MODEL:** PM+CTO (Claude) and codex agreed the 3 bugs share one transcript-ownership root. Codex went deeper on ordering semantics (turn_id) and the broadcast/persistence coupling that the Claude passes under-specified. All 3 codex tensions accepted by user.
- **UNRESOLVED:** 0. All decisions (D1-D4, P1-P2, T1-T3) resolved on recommended options.
- **VERDICT:** CEO + ENG CLEARED, codex incorporated — ready for writing-plans. Implementation order revised to G0(helper)→G2a(collect abstract)→G3(turn_id)→G1→G2b.
