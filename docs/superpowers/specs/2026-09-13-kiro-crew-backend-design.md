# Kiro Crew 后端接入设计（第一阶段）

- **日期**：2026-09-13
- **状态**：待实现
- **范围**：新增 `SessionType::Crew` 作为第 5 种会话后端；**保留** 现有 `SessionType::Kiro` 不变
- **决策依据**：本文档所有接口行为均在本机（Ubuntu 24.04，KiroCrew 0.6.0，kiro-cli 2.3.0）实测确认，非文档推测

---

## 1. 背景与决策

### 1.1 为什么不是"替换 Kiro"

Kiro Crew **不是更好的 Kiro CLI，而是与 zeromux 同层的编排器**。实测证据：

Gateway 拉起的子进程是
```
kiro-cli acp --agent kirocrew-lite
```
而 `~/.kiro/agents/kirocrew-lite.json` 内容为 `{"tools": [], "mcpServers": {}, "prompt": ""}` —— 一个空壳 agent。

**结论**：Crew 的全部价值（记忆、lessons、技能进化、上下文装配、审批闸、cron、subagent）都在 Gateway 那个 Python 进程里，不在 agent config 里。因此：

- 「把 zeromux 的 `kiro-cli acp --trust-all-tools` 改成 `--agent kirocrew` 就白拿 Crew 能力」这条廉价路径**不存在**。
- 额外证据：kiro-cli 2.3.0 已**拒绝解析** `kirocrew.json`（`unknown field 'permissions'`），该路径当场不可行。
- 「真替换」等于把 zeromux 降级成 Crew 的前端，需重写 `session_manager.rs` 的核心抽象，并丢弃 PTY、多后端、多用户等 zeromux 独有资产 —— 负和。

### 1.2 能力对比（决定"并存"而非"替换"）

| 能力 | zeromux | Kiro Crew | 归属 |
|---|---|---|---|
| Web 终端 (PTY/tmux) | ✅ | ❌ | zeromux 独有 |
| 多 agent 后端 | ✅ Claude/Kiro/Codex | ❌ 仅 kiro-cli（`agent.provider` 硬定为 acp） | zeromux 强 |
| 多用户 / OAuth / per-owner 授权 | ✅ | ❌ 单用户 | zeromux 强 |
| PWA + Web Push + 移动布局 | ✅ | 需隧道 | zeromux 强 |
| 定时任务 | ✅ `scheduled_tasks.rs` | ✅ cron | 重叠，各自保留 |
| 跨会话记忆 / 自学习 / 技能进化 | ❌ | ✅ | **Crew 强** |
| IM 渠道（含微信） | ❌ | ✅ 10 个 | **Crew 独有** |
| Subagent 并行 | ❌ | ✅ | **Crew 强** |
| PreToolUse 审批闸 + OS 沙箱 | ⚠️ 仅路径守卫 | ✅ | **Crew 强** |

**决策**：新增第 5 种会话类型（正和），而非替换第 3 种（负和）。

### 1.3 已确认的产品决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 架构 | 方案 A：WS 广播 + slot 过滤 + 复用 `AcpEvent` | 保持 fan-out 不变量，前端零改动 |
| Token 获取 | zeromux 自动读 secret 并 mint | 个人项目，避免手动换 token |
| 审批模式 | `trust`（自动批准） | 与现有 Kiro `--trust-all-tools` 体验一致 |
| 微信范围 | 共享记忆，不共享对话 | 第一期范围，降低复杂度 |

---

## 2. 实测确认的接口契约

> 以下每一项都经过本机实测。`SEC` = `~/.kiro/crew/run/gateway-<port>.secret` 内容（32 字节，权限 0600）。

### 2.1 认证：两套并存，不可混用

| 通道 | 凭证 | 实测结果 |
|---|---|---|
| REST | `X-Internal-Secret: <SEC>` | ✅ 200 |
| REST | `?token=<jwt>`（`kirocrew token` 所出） | ❌ 403 —— 该 token 的 `sub` 为 `local-app`，被 app-scope 门拒绝 |
| **WebSocket** | `?token=<jwt>` | ✅ 101 Switching Protocols |
| **WebSocket** | `X-Internal-Secret` | ❌ 403 |

**根因**：`/api/chat*` 属于 `_MIXED_INTERNAL_API_PATHS`（`server.py`），接受 internal secret；而 WS 走 `token_auth_middleware`，只认 token。

**Token mint 路径**（唯一途径）：
```
GET /api/token/local?ttl=<duration>
Header: X-Local-Secret: <SEC>
→ {"token": "<jwt>", "expires_in": <secs>}
```
仅 loopback 可用，`hmac.compare_digest` 校验（`handlers/core.py: api_token_local`）。

### 2.2 REST 端点

| 操作 | 请求 | 实测响应 |
|---|---|---|
| 建 slot | `POST /api/chat/slots` `{"name":"<key>"}` | 200，返回完整 slot 对象 |
| 列 slot | `GET /api/chat/slots` | 200，数组 |
| 查 slot | `GET /api/chat/slots/{key}` | 200，含 `running`/`title`/`project` |
| 删 slot | `DELETE /api/chat/slots/{key}` | 200 |
| **设工作目录** | `POST /api/chat/slots/{key}/project` `{"project":"<abs>"}` | 200 `{"ok":true,"project":"..."}` |
| 发 prompt | `POST /api/chat` `{"slot":"<key>","message":"<text>"}` | 见 2.4 |
| **取消当前轮次** | `POST /api/chat/slots/{key}/stop` | 200 `{"ok":true}`，slot 随即 `running:false` |
| **清空排队** | `POST /api/chat/slots/{key}/interrupt` | 队列为空时 **400** `{"error":"queue empty, use /stop instead"}` |
| 审批模式 | `POST /api/chat/mode` `{"mode":"trust","slot":"<key>"}` | 200 `{"ok":true,"mode":"trust"}` |

### 2.3 `project` 字段就是 agent 的真实 cwd（关键，已实测）

代码路径：`chat_runner.py:4313` → `cwd=slot.project or None` → ACP `session/new` 的 `cwd`。

**实测验证**：设 `project=/home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux` 后，让 agent 执行 `pwd`，返回值与设定值**逐字相同**。

**意义**：zeromux 的 `work_dir` 语义与 Crew 的 `project` 完全对齐，`QuickTargets` / `GitViewer` / `FileBrowser` / 笔记按目录聚合 全部照常工作，无需特殊处理。

### 2.4 `POST /api/chat` 的双重语义（关键，已实测）

**空闲时**：返回 `Content-Type: text/event-stream`，**阻塞整轮**，响应体是该轮完整的 SSE 回放。

**忙时**：立即返回 `{"ok": true, "queued": true, "queue_id": "<hex>"}`，不阻塞。Gateway 自行排队并顺序执行。

**实测的关键异常**：并发发第二条 prompt 时，**第二轮的输出出现在第一条请求的 SSE 流里**，而第二条请求自己的响应体只有那行 queued JSON。

**由此得出的设计约束（load-bearing）**：

> **WS 是唯一事件源。`POST /api/chat` 的响应体必须整体丢弃（只读 HTTP 状态码判断投递成功）。**

理由：SSE 流的归属会在排队时错位，把它当事件源必然导致轮次串台。WS 帧带 `data.slot`，是唯一可靠的归属信号。

### 2.5 WebSocket 事件流

`GET /api/ws?token=<jwt>` → 101。**这是全局广播流，不是 per-session 流。**

实测一轮"执行 bash 命令"收到的帧类型分布：
```
{'slots': 5, 'dashboard': 2, 'activity_event': 6, 'mcp_report_update': 1,
 'chat_status': 1, 'slot_title': 4, 'heartbeat': 1, 'tool_call': 3,
 'tool_result': 2, 'chat_message_update': 1, 'chat_segment': 1,
 'chat_chunk': 5, 'context_usage': 1, 'chat_done': 1, 'refresh': 1}
```

实测 payload 样本：
```json
{"type":"chat_chunk","data":{"slot":"zmx-probe2","content":"TOOLTEST\nSun Sep ","seq":3}}
{"type":"tool_call","data":{"slot":"zmx-probe2","tool":"echo TOOLTEST && date -u",
  "kind":"execute","is_shell":true,"tool_call_id":"toolu_bdrk_01QWSR...",
  "purpose":"Run the exact command the user requested.","input_preview":"{...}"}}
{"type":"tool_call","data":{"slot":"zmx-probe2","tool":"echo TOOLTEST && date -u",
  "tool_call_id":"toolu_bdrk_01QWSR...","is_update":true,...}}
{"type":"chat_done","data":{"slot":"zmx-probe2"}}
```

**注意**：`chat_done` **不携带最终文本**（只有 `slot`）。

---

## 3. 架构设计

### 3.1 整体形状

```
zeromux (Rust, :8090)                        KiroCrew Gateway (Python, :5476)
┌────────────────────────────────┐          ┌──────────────────────────────┐
│ session_manager                │          │                              │
│  SessionType::Crew（新增）      │          │                              │
│                                │          │                              │
│  create_crew_session()         │──REST───▶│ POST /api/chat/slots         │
│    ├ 建 slot                   │ +secret  │ POST .../{key}/project       │
│    ├ 设 project = work_dir     │          │ POST /api/chat/mode {trust}  │
│    └ 设 mode = trust           │          │                              │
│         ↓                      │          │                              │
│  spawn_crew_fanout()           │          │                              │
│  ┌──────────────────────────┐  │          │                              │
│  │ 独占 1 条 WS 连接         │◀──WS─────  │ GET /api/ws?token=（广播）    │
│  │ 按 data.slot 过滤 (I1)    │  │          │                              │
│  │ tool_call_id 去重 (I2)    │  │          │                              │
│  │ 累积 chunk → Result (I3)  │  │          │                              │
│  │ 归一化 → AcpEvent         │  │          │                              │
│  │ broadcast::Sender ──────▶ │  │          │                              │
│  │ mpsc<SessionInput> ───────│─REST────▶  │ POST /api/chat（丢弃响应体）  │
│  └──────────────────────────┘  │ +secret  │ POST .../stop（取消轮次）     │
└────────────────────────────────┘          └──────────────────────────────┘
        ↑ 前端 /ws/acp/{id} 与 AcpEvent 完全不变
```

### 3.2 fan-out 不变量的保持

CLAUDE.md 规定：*"fan-out 任务是会话进程的唯一所有者"*。

**Crew 后端的适配**：fan-out 从"独占一个子进程"变为"**独占一条 WS 连接 + 一个 slot_key**"。

这与 Codex 的先例同构 —— Codex 已经不直接 spawn，而是通过 rmcp client 驱动 `codex mcp-server`。Crew 只是把"本地 stdio"换成"loopback WS"。

**Drop 语义**：
```
从 HashMap 移除 session
  → drop event_tx / input_tx
  → fan-out select! 收到 channel 关闭
  → 关闭 WS 连接
  → DELETE /api/chat/slots/{key}（清远端，防 slot 泄漏）
  → 任务结束
```
不新增手工 kill 管道，符合既有 Drop-based teardown 约定。

### 3.3 新增文件与改动点

| 文件 | 改动 | 规模估计 |
|---|---|---|
| `src/acp/crew_process.rs` | **新增**。WS 客户端 + 事件归一化 + token mint | ~400 行 |
| `src/acp/mod.rs` | 新增 `pub mod crew_process;` | 1 行 |
| `src/session_manager.rs` | `SessionType::Crew` 变体、`Display`、`from_str_lenient`、`create_crew_session`、`spawn_crew`、`spawn_crew_fanout` | ~200 行 |
| `src/main.rs` | 新增 `--crew-port`（默认 5476）、`--crew-home`（默认 `~/.kiro/crew`） | ~10 行 |
| `src/web.rs` | `SENSITIVE_DIR_NAMES` 补 `.kiro`（见 5.2）；session 创建分派新增 Crew 臂 | ~15 行 |
| `src/auto_titler.rs` | `TitlerBackend` 新增 Crew 或复用 Kiro | ~5 行 |
| `frontend/src/lib/api.ts` | `SessionType` 加 `'crew'` | 1 行 |
| `frontend/src/components/Sidebar.tsx` | New Session 菜单新增一项（4→5） | ~12 行 |
| `frontend/src/components/BrandIcons.tsx` | Crew 图标 | ~10 行 |

**依赖**：需要一个 WS 客户端。`Cargo.toml` 已有 `reqwest`；建议用 `tokio-tungstenite`（若尚未引入则新增该依赖）。

---

## 4. 事件归一化

### 4.1 映射表

| Gateway 帧 | → `AcpEvent` | 处理要点 |
|---|---|---|
| `chat_chunk {slot, content, seq}` | `ContentBlock{block_type:"text", streaming:Some(true), text}` | 前端已能合并连续 streaming 块；同时累积进 turn 文本缓冲（I3） |
| `tool_call {tool, kind, is_shell, tool_call_id, purpose, input_preview}` | `ContentBlock{block_type:"tool_use", name:tool, input, summary:purpose}` | 按 `tool_call_id` 去重（I2）；`purpose` → `summary`（比现有后端更丰富） |
| `tool_result` | 归入对应 `tool_use` 的补充块 | 同样按 `tool_call_id` 关联 |
| `chat_status {status}` | `System{subtype:"status"}` | "Thinking…" 等 |
| `chat_done {slot}` | `Result{text:<累积缓冲>, turn_id, session_id}` | **文本必须来自累积**（I3） |
| `chat_error` | `Error` | |
| `slots` / `dashboard` / `heartbeat` / `refresh` / `context_usage` / `mcp_report_update` / `slot_title` / `chat_segment` / `chat_message_update` / `activity_event` | **丢弃** | 全局帧或已被专用帧覆盖 |

`turn_id` 沿用现有约定：进程层填 0，fan-out 的 emit 在广播前用 `with_turn_id` 盖真实值（G3.2）。

### 4.2 三条 Crew 独有的不变量

这三条是现有三个后端都不存在的风险，**现有测试一条都覆盖不到**，必须新写测试。

**I1 · slot 过滤**
> fan-out 只处理 `data.slot == my_slot_key` 的帧。

- **漏了的后果**：会话 A 的输出出现在会话 B 里（跨会话串台）。
- **为何独有**：现有三后端每个都独占一个 stdio，天然隔离；Crew 的 WS 是全局广播。
- **测试**：构造含两个不同 `slot` 的帧序列，断言只有本 slot 的事件被 emit。

**I2 · tool_call 去重**
> 同一 `tool_call_id` 的多帧只渲染一次（`is_update:true` 为更新而非新调用）。

- **漏了的后果**：一次工具调用在 UI 里渲染 3 次（实测确实来了 3 帧）。
- **测试**：喂入实测的 3 帧同 id 序列，断言只产生 1 个 `tool_use` 块（或 1 个块 + 更新）。

**I3 · `Result.text` 累积**
> `chat_done` 不带文本，`Result.text` 必须由本轮 `chat_chunk` 累积而成。

- **漏了的后果**：`Result.text` 为空 → 活动看板摘要空白、`auto_titler` 无输入、`log_result_event` 记录不可用。这与既有教训同型（2026-07-17「Claude `is_error` result 空白发 Error」）。
- **约定依据**：`AcpEvent::Result` 的文档注释明确要求 *"`text` 始终携带完整最终文本"*。
- **测试**：喂入 `chunk("a") chunk("b") chat_done`，断言 `Result.text == "ab"`；并断言新一轮开始时缓冲已清零（防止跨轮累加）。

### 4.3 QueueMode 语义

Gateway 自己会排队（实测忙时返回 `queued:true`）。zeromux 的 `QueueMode` 三态处理：

| zeromux QueueMode | Crew 行为 |
|---|---|
| `Collect`（默认） | 直接 `POST /api/chat`，让 Gateway 排队。**不在 zeromux 侧合并** |
| `Interrupt` | 先 `POST .../stop`（取消当前轮次），再 `POST /api/chat`。**不是 `/interrupt`** —— 见 2.2 |
| `Passthrough` | 同 `Collect`（Gateway 已是顺序执行，无 passthrough 语义差别） |

**理由**：Gateway 已实现排队且带 `queue_id`，zeromux 侧再合并一层会产生两套队列语义冲突。第一期直接委托。

---

## 5. 安全边界

### 5.1 Secret 处理

```
fan-out 启动 / WS 重连
  → 读 <crew_home>/run/gateway-<port>.secret（0600），回落 <crew_home>/.local_secret
  → GET /api/token/local?ttl=20h  (X-Local-Secret: <secret>)
  → 得 token → 连 GET /api/ws?token=<token>
```

**硬性约束**（呼应 workspace CLAUDE.md 的 no-secrets 规矩）：

1. secret 与 token **只存在于内存**，绝不写入 zeromux 的 SQLite、日志、`AcpEvent` 事件流、scrollback。
2. 错误信息中**不得**包含 secret 或 token 内容（连长度也不必报）。
3. 每次 WS 重连都重新 mint（token 有 TTL，实测 `exp` ≈ 5 分钟、`session_exp` ≈ 20 小时）。

### 5.2 必须补的守卫 pin（已确认是真实缺口）

接入 Crew 后，`~/.kiro/crew/` 成为高价值凭证目录，其下存有：`.local_secret`、`run/gateway-*.secret`、`memory.db`（全部记忆）、`gateway.log`、以及 IM 渠道凭证（`.env` 中的 `SLACK_BOT_TOKEN` 等）。

**现状盘点（逐条读码确认，不是推测）**：

`src/web.rs:1468` 的 `SENSITIVE_DIR_NAMES` 当前为
```rust
".ssh", ".aws", ".gnupg", ".git", ".zeromux", ".zeromux-worktrees",
```
`.kiro` 不在其中。但**并非所有路径都因此敞开** —— 必须区分两种情形，否则会补错 pin：

| 情形 | 现状 | 是否缺口 |
|---|---|---|
| base_dir 在 `$HOME`，读 `~/.kiro/...` | `read_hits_home_dotdir`（`web.rs:1509`）拒绝任何首段为 dot 的 `~/.*` 路径 | ❌ **已覆盖** |
| **base_dir 直接设为 `~/.kiro` 或 `~/.kiro/crew`** | `validate_browse_root` → `base_dir_at_or_in_sensitive`（`web.rs:1585`）只比对 `SENSITIVE_DIR_NAMES` 那 6 个名字 → **放行**；此后 `read_hits_home_dotdir` 收到的路径首段已是 `crew`/`run` 而非 dot 段 → 也放行 | ✅ **真实缺口** |
| 写 / 重命名 / 删除 `~/.kiro` 下文件 | 写守卫同样以 `SENSITIVE_DIR_NAMES` 为基础 | ✅ **真实缺口** |
| `git diff` 仓库根设为 `~/.kiro` | `git_diff_root_unsafe` 系列同样基于该名单 | ✅ **真实缺口** |

**动作**：`SENSITIVE_DIR_NAMES` 增加 `".kiro"`。

**理由**：这与 2026-06-26 `.zeromux` 那轮是**同型漏洞** —— 当时的缺口也正是"base_dir 覆盖为数据目录后，descent guard 剥掉 base 前缀便看不见 `.zeromux` 这一段"（见 `web.rs:1361` 注释原文）。当时的修法就是并入 `SENSITIVE_DIR_NAMES`，此处照同一形状处理，避免守卫谱系分叉。

**测试**：对齐既有 `.zeromux` 测试的形状，断言
- `validate_browse_root("~/.kiro")` 与 `validate_browse_root("~/.kiro/crew")` 均 403（这是真正的缺口，必须先写红）；
- `~/.kiro/crew/.local_secret`、`~/.kiro/crew/memory.db` 的读、写、枚举三处均被拒。

#### 5.2.1 加 pin 的已知副作用（取舍，非疏漏）

`SENSITIVE_DIR_NAMES` 被**两类守卫共用**，语义不同：

- `base_dir_at_or_in_sensitive` —— 锚定 `$HOME`，管"base 能不能设在这儿"（这是我们要修的缺口）；
- `path_hits_sensitive_dir` / `worktree_path_excluded` —— 锚定 **base**，管"base 之下能不能下钻"。

因此加入 `.kiro` 会**连带**产生一个副作用：**任何仓库内的 `<repo>/.kiro/` 目录也会从 file-browser 和 diff 中被排除。**

**实测确认这不是假设**：本仓库当前就有 `./.kiro/settings/`（kiro-cli 的项目级配置目录），加 pin 后它将不可浏览、不出现在工作区改动里。

**为什么仍然接受**：
1. 这与 `.git` 的既有行为**完全同型** —— `.git` 也在名单里，仓库内的 `.git/` 同样被排除，从未有人认为那是 bug。
2. `<repo>/.kiro/` 装的是 agent 配置与 steering 文件，恰恰是**可能含敏感内容**的一类（`.kiro/settings/` 可存 MCP OAuth token）。排除它是收益而非损失。
3. 想编辑项目级 kiro 配置，用终端会话（PTY）即可 —— 与编辑 `.git/config` 的路径一致。

**不采取的替代方案**：只在 `base_dir_at_or_in_sensitive` 侧加 `.kiro`、而在下钻侧豁免。这会让守卫谱系分叉成"两份不同的名单"，正是既有代码注释反复警告的漂移根源（`web.rs:2643` 原文：*"deriving both ... from this one predicate keeps them from drifting"*）。第一期不引入这种分叉。

### 5.3 授权模型

Crew 会话与其他会话一视同仁：`owner_id` 隔离，仅所有者或管理员可连接、操作、读取。**Gateway 侧是单用户的**，所以 zeromux 的多用户隔离是唯一的授权边界 —— 这意味着：

> 任何用户的 Crew 会话都跑在同一个 Gateway 身份下，共享同一份记忆。

**第一期接受此限制**（单用户个人部署）。若将来开放多用户，必须重新评估（记忆会跨用户泄漏）。本限制在实现时应写入 `README` 的相应位置。

---

## 6. 生命周期与降级

| 场景 | 行为 |
|---|---|
| Gateway 未运行 | 创建 Crew 会话时 **fail fast**，返回明确错误（"Kiro Crew Gateway 未运行（127.0.0.1:5476）"）。不静默降级、不自动拉起 Gateway |
| Secret 不可读 | 同上，fail fast，错误信息说明路径但**不含内容** |
| Gateway 运行中挂掉 | fan-out 收到 WS close → emit `Error` → 指数退避重连（沿用现有 WS 退避约定，首次退避 3s，不 onopen 即清零 —— 见 2026-08-05 教训） |
| 重连成功 | `GET /api/chat/slots/{key}` 确认 slot 存活 → 继续；slot 已消失 → emit `Error`，会话标记需重建 |
| zeromux 重启 | slot_key 存入 `resume_token`（复用现有字段），惰性重生时确认 slot 存活即接回。**比现有三后端的 resume 更可靠**，因为会话状态在 Gateway 侧持久 |
| 删除会话 | Drop → 关 WS → `DELETE /api/chat/slots/{key}` |
| 空闲看门狗 | 沿用现有 `last_activity_ms` 机制。**注意**：`chat_status`（"Thinking…"）等非前进信号**不得**刷新 `last_activity_ms`（见 2026-08-05 教训：不前进的信号勿刷看门狗） |

---

## 7. 明确不做（YAGNI）

| 项 | 原因 |
|---|---|
| 审批 UI | 已决定用 `mode:trust`，与现有 Kiro `--trust-all-tools` 一致 |
| worktree 隔离 | Crew 的 cwd 由 Gateway 管，`--worktree-isolation` 对 Crew 会话不生效 |
| 合并两套定时任务 | zeromux 的 `scheduled_tasks.rs` 与 Crew cron 各管各的。zeromux 定时任务可驱动 Crew 会话（走同一个 `SessionInput::Prompt`），自然继承，不额外做 |
| 微信配置 UI | 微信在 Crew dashboard 配（`localhost:5476` → Settings → Channels）。zeromux 不碰 IM 凭证 |
| 同一 slot 双入口（微信接续 zeromux 对话） | 第二期。第一期为"共享记忆、不共享对话" |
| Crew 的 subagent / artifact / workflow 面板 | 第二期。第一期只做会话对话 |
| 镜像 Crew 的 slot 列表到 zeromux 侧边栏 | 第二期 |

### 7.1 微信在第一期的实际形态

```
微信 → Gateway 的某个 slot ──┐
                            ├── 共享同一份记忆 / lessons / 技能
zeromux Crew 会话 → 另一 slot ┘
```

**两边不是同一个对话，但共享记忆层。** 配好微信后 zeromux 侧**无需任何改动**即自动获得该能力 —— 因为两者指向同一个 Gateway。

**微信渠道的已知限制**（来自 Crew 官方文档 `weixin-integration.md`，需知情后再启用）：
- 走 iLink bot API，**非 Tencent 官方开发者产品**；文档明示可能违反微信 ToS，账号存在被限制或封禁风险。业务关键场景应改用 WeCom（企业微信，官方 WebSocket 通道）。
- **仅私聊**，不支持群聊（iLink bot 身份收不到群事件）。
- **不能流式**（iLink 无法编辑已发消息，整轮 buffer 后一次性发出）。
- **无审批按钮**；`interactive` 模式在该渠道为 deny-by-default。
- 默认 `dm_policy=allowlist` 且列表为空 —— 即**默认谁都不授权**，需手动加 user id。

---

## 8. 测试计划

### 8.1 Rust 单元测试（`src/acp/crew_process.rs` 内联 `#[cfg(test)]`）

纯函数化归一化逻辑，喂入实测抓到的真实 JSON 帧：

| # | 测试 | 断言 |
|---|---|---|
| T1 | slot 过滤（I1） | 含两个不同 slot 的帧序列 → 仅本 slot 事件被 emit |
| T2 | slot 缺失字段 | 无 `data.slot` 的全局帧（`heartbeat`/`slots`/`dashboard`）→ 全部丢弃，不 panic |
| T3 | tool_call 去重（I2） | 实测的 3 帧同 `tool_call_id` → 1 个 tool_use 块 |
| T4 | Result 累积（I3） | `chunk("a") chunk("b") chat_done` → `Result.text == "ab"` |
| T5 | 跨轮缓冲清零（I3） | 第二轮 `chunk("c") chat_done` → `Result.text == "c"`，非 `"abc"` |
| T6 | chunk seq 乱序 | seq 非递增时不丢块（按到达序 append，seq 仅用于诊断） |
| T7 | `chat_error` → `Error` | 映射正确 |
| T8 | 非前进信号不刷看门狗 | `chat_status` 不产生 activity bump |

### 8.2 Rust 单元测试（`src/web.rs`）

| # | 测试 | 断言 |
|---|---|---|
| T9 | **base_dir 覆盖（真实缺口，须先验红）** | `validate_browse_root("~/.kiro")` 与 `validate_browse_root("~/.kiro/crew")` 均返回 403 |
| T10 | `.kiro` 读守卫 | `~/.kiro/crew/.local_secret`、`~/.kiro/crew/memory.db` 读被拒 |
| T11 | `.kiro` 写守卫 | 同上路径的写/重命名/删除被拒 |
| T12 | `.kiro` 目录枚举 | `/api/directories` 不列举 `~/.kiro` 内容 |
| T13 | in-repo `.kiro` 的副作用（**已知取舍，见 5.2.1**） | 断言 `<repo>/.kiro/**` 在 file-browser 与 diff 中被排除 —— 这是加 pin 的**预期代价**，测试固定该行为以免日后误判为 bug |

### 8.3 前端测试（vitest）

| # | 测试 | 断言 |
|---|---|---|
| T14 | `SessionType` 含 `'crew'` | 类型与图标映射不漏 |

### 8.4 手工验收（需 Gateway 运行）

1. New Session 菜单出现 5 项，选 Kiro Crew 能建会话。
2. 发一个 prompt，流式文本正常渲染。
3. 让它跑一个 bash 命令，`tool_use` 块渲染一次（**非 3 次**）。
4. 轮次结束后活动看板有摘要（证明 `Result.text` 非空）。
5. 开两个 Crew 会话同时发 prompt，**输出不串台**（I1 的端到端验证）。
6. 停掉 Gateway，会话报错且不 hang；重启 Gateway 后重连恢复。
7. 删除会话后 `GET /api/chat/slots` 中对应 slot 消失（无泄漏）。
8. file-browser 无法浏览到 `~/.kiro`。

### 8.5 验证门（成功判据）

- `cargo test` 全绿，`npm test` 全绿，`npm run lint` 无新增告警。
- `cargo build --release` + `npm run build` 成功。
- 8.4 的 8 条手工验收全部通过。
- 现有测试**零回归**（改动前后对比 `cargo test` / `npm test` 计数）。

---

## 9. 已知遗留与第二期候选

| 项 | 说明 |
|---|---|
| 记忆跨用户共享 | 多用户部署下所有人共享同一份 Crew 记忆（5.3）。开放多用户前必须处理 |
| Gateway 单点 | Gateway 挂 → 所有 Crew 会话不可用。已有降级路径（第 6 节），但无自动拉起 |
| 认证不对称 | REST 用 secret、WS 用 token，是 Crew 侧的既有设计，zeromux 只能适配 |
| ~~`interrupt` / `mode` 未实测~~ | **已实测并修正**：取消轮次用 `/stop`（`/interrupt` 只清队列）；`mode:trust` 确认可用。见 2.2 |
| 同 slot 双入口 | 第二期 |
| Crew subagent / workflow 面板 | 第二期 |
