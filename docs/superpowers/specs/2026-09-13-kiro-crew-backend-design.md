# Kiro Crew 接入设计 —— zeromux v2「有记忆的驾驶舱」

- **日期**：2026-09-13
- **状态**：**已审核通过**（CTO + 产品总监交叉评审，用户 2026-09-13 批准），待实现
- **范围**：新增 `SessionType::Crew`；**删除 Kiro 后端**；扩展 `AcpEvent`（审批 + 上下文用量）；新增记忆的第一方 UI
- **决策依据**：所有接口行为均在本机实测（Ubuntu 24.04 / KiroCrew 0.6.0 / kiro-cli 2.3.0）；所有代码论断均给出 `文件:行号`
- **本文档经过一次自我纠错**：初稿 §5.2 的安全分析事实错误，已在该节推翻并说明原因

## 0. 定位（评审确立）

> **zeromux 是你口袋里的 agent 驾驶舱 —— Crew 负责记住与思考，zeromux 负责让你在任何地方看见它、并在关键时刻按下那个按钮。**

分工：**Crew dashboard 是工作台**（桌面、配置、深度管理），**zeromux 是驾驶舱**（手机、监督、介入）。

三条不可替代的理由（均为实测，非偏好）：

1. **Crew 在公网上不存在。** 它绑 `localhost:5476` + unix socket，手机要用得开隧道。zeromux 有完整公网身份栈（`oauth.rs` 443 行 / `auth.rs` 599 行 / PWA / `zeromux.keithyu.cloud`）。
2. **Crew 没有 Web Push。** `grep -rli vapid` 在整个 `kiro_crew` 包内**零命中**。而 `push.rs`（935 行）有完整 VAPID 实现且已有 `confirm` 触发类型（`push.rs:353`，归入 `lvl_important`：`push.rs:380-381`）。**"agent 停下来等你"这件事只有 zeromux 能推到锁屏。**
3. **Crew 只有一个后端且没有终端。** `agent.provider` 硬定为 acp、只跑 kiro-cli。zeromux 有 PTY（`TerminalView.tsx` + `MobileKeyBar.tsx`）与 Claude/Codex。

这三条同时否决了「把 zeromux 改造成 Crew 的一个 App」—— 详见 §10。

---

## 1. 背景与决策

### 1.1 Crew 替代不了 zeromux 的编排层，但要替代 Kiro 后端

**这是两个不同的问题，初稿把它们混为一谈了。**

**问题一：Crew 能不能替代 zeromux？不能。** Gateway 拉起的子进程是
```
kiro-cli acp --agent kirocrew-lite
```
而 `~/.kiro/agents/kirocrew-lite.json` 是 `{"tools":[],"mcpServers":{},"prompt":""}` —— 一个空壳。Crew 的全部价值都在 Gateway 那个 Python 进程内，因此：

- 「把 zeromux 的 `--trust-all-tools` 改成 `--agent kirocrew` 白拿 Crew 能力」不存在；kiro-cli 2.3.0 更是**拒绝解析** `kirocrew.json`（`unknown field 'permissions'`）。
- 「真替换」= 把 zeromux 降级成 Crew 前端 = 丢掉 PTY / 多后端 / 多用户 / Web Push。

**问题二：zeromux 该不该保留 Kiro 后端？不该。** 这与问题一无关 —— Crew 会话在**底层就是** kiro-cli 会话，只是多了记忆、技能、审批。裸 Kiro 被**严格支配**：没有任何场景你会理性地选它。

实证依据：

| 证据 | 数据 |
|---|---|
| 线上 Kiro 会话 | **1 个**（`zeromux.db`：claude 3、kiro 1，且那 1 个 work_dir 是 `/home/ubuntu`，随手开的） |
| Kiro 驱动的定时任务 | **0 个**（唯一任务 `agent_type=claude` 且 `enabled=0`） |
| 代码自证 | `session_manager.rs:3175/3244/3248` 注释原文："**Kiro runs no scheduled tasks**"、"kiro 当前不跑调度，留此分支保持三 fanout 对称" |
| auto-titler | `auto_titler.rs:5-9`：Kiro **无法**安全降为无工具 → Kiro 会话**永远拿不到自动标题** |
| 前端早已预留退路 | `lib/quickTargets.ts:3` 注释原文："某个 agent 类型日后被移除时（**如 kiro**）" |

**删除代价**：约 1045 行（`kiro_process.rs` 677 + `spawn_kiro_fanout` 278 + 其余）+ 70 处引用 + 前端 5 文件；**持久化代价 1 行 DB 记录**（`from_str_lenient`（`session_manager.rs:70-77`）对未知值回落 Tmux，不会 panic；一条 `UPDATE` 即可清理）。

**两个必须说清的前提**：

1. **`kiro-cli` 二进制不能删** —— 它是 Crew 的运行时依赖（Gateway 靠它跑）。删的是 zeromux 的 Kiro **后端路径**，`--kiro-path` 参数保留无害。
2. **顺带消除一个并发风险**：当前 `ps` 显示 `kiro-cli acp --trust-all-tools`（zeromux 的）与 `kiro-cli acp --agent kirocrew-lite`（Crew 的）**同时在跑**，两者共享 `~/.kiro/sessions/`。删掉 Kiro 后端顺手消掉这个共享状态。

### 1.2 能力对比

| 能力 | zeromux | Kiro Crew | 归属 |
|---|---|---|---|
| Web 终端 (PTY/tmux) | ✅ | ❌ | **zeromux 独有** |
| **Web Push / PWA** | ✅ `push.rs` 935 行 | ❌ **零 vapid 命中** | **zeromux 独有** |
| 公网可达 / OAuth 多用户 | ✅ | ❌ 单用户 loopback | **zeromux 独有** |
| 多 agent 后端 | ✅ Claude / Codex | ❌ 仅 kiro-cli | zeromux 强 |
| **定时任务（带工作目录）** | ✅ `work_dir` 必填 | ❌ **cron 零 cwd 字段** | **zeromux 独有**（见 §11） |
| 跨会话记忆 / 自学习 / 技能进化 | ❌ | ✅ | **Crew 强** |
| IM 渠道（含微信） | ❌ | ✅ 10 个 | **Crew 独有** |
| Subagent 并行 | ❌ | ✅ | **Crew 强** |
| PreToolUse 审批闸 + OS 沙箱 | ⚠️ 仅路径守卫 | ✅ | **Crew 强** |
| 上下文用量统计 | ❌ | ✅ `context_usage` 事件 | **Crew 强**（白拿） |

### 1.3 已确认的产品决策（含两处评审推翻）

| 决策 | 选择 | 说明 |
|---|---|---|
| 架构 | WS 广播 + slot 过滤 + 复用 `AcpEvent` | 保持 fan-out 不变量 |
| Token 获取 | zeromux 自动读 secret 并 mint | 见 §5 的边界约束 |
| **审批模式** | ~~`mode:trust`~~ → **走 `Approval` 事件 + UI 批准** | **评审推翻，见 §4.4** —— `mode:trust` 不带 slot 会把整个 Gateway（含微信）永久设为 auto-approve |
| **Kiro 后端** | ~~保留~~ → **删除** | **评审推翻，见 §1.1** |
| **定时任务** | 保留 zeromux 的，不迁移 | Crew cron 零 cwd + 拆 E1 门，见 §11 |
| 微信范围 | 共享记忆，不共享对话 | 且**永远**不共享（`two-way = ❌`，见 §12） |
| Gateway 守护 | fail fast + systemd 声明依赖 | **不由 zeromux 拉起**，见 §13 |

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

### 4.4 `AcpEvent` 扩展两个变体（评审新增）

`AcpEvent` 是 `#[serde(tag="type")]`（`process.rs:26`），加变体对现有后端**零影响**（它们不发）。

| 新变体 | 来源 | 为什么必须加 |
|---|---|---|
| `Approval { id, tool, tool_input, tool_purpose, slot }` | Gateway 的 `approval` 帧（已在 fan-out 订阅的那条 WS 里） | 替代 `mode:trust`，见 §4.5。**字段名以附录 A.1.2 的实测为准**（是 `tool_purpose`/`tool_input`，不是 `purpose`/`input`），且三者在 Gateway 侧已 redact |
| `ContextUsage { used, total }` | `context_usage` 帧 | zeromux **自己没有**这个能力，纯白拿。初稿把它列为"丢弃"是信息损失。`total == 0` 或缺失时**丢弃该帧**（前端拿它做分母，否则渲染 `NaN%`） |

#### ⚠️ 实现陷阱（必须先读，否则会浪费一整轮调试）

**前端对未知事件是静默丢弃，不是降级显示。** 两处实测确认：

- `BlockView` 的 `default: return null`（`AcpChatView.tsx:967-968`）→ 未知 `block_type` **渲染为空**。
- `handleEvent` 的 switch **没有 `default` 分支**（`AcpChatView.tsx:307-437`）→ 未知顶层 `type` 静默忽略。

**含义**：任何"先改后端、前端以后补"的增量策略都会表现为"**什么都没发生**" —— 这是最难 debug 的失败模式。**后端加变体与前端加 case 必须同一个 commit。**

### 4.5 审批：为什么必须推翻 `mode:trust`

初稿 §1.3 选 `mode:trust`，理由是"与现有 Kiro `--trust-all-tools` 一致"。**这个类比是错的。** 读 handler（`chat_handlers.py:9016-9040`）：

```python
if slot is not None:
    for _sharing in state._slots.values():
        if effective_session_key(_sharing) == _granted_key: _sharing._trust = True
    if mgr and linked_ch and linked_ch in mgr._channels:
        mgr._channels[linked_ch].trusted = True
        mgr._channels[linked_ch]._save()          # ← 持久化落盘
else:                                              # ← slot 为 None
    for s in state._slots.values(): s._trust = True
    if mgr:
        for ch in mgr._channels.values():
            ch.trusted = True; ch._save()          # ← 全部 IM 渠道永久 trusted
```

**不带 `slot` 的 mode 请求 = 把 Gateway 上所有 slot 和所有 IM 渠道（含微信）永久设为 auto-approve 并落盘。** 而 `--trust-all-tools` 只影响 zeromux 自己 spawn 的那一个进程。作用域差了几个数量级。

**决策：第一期不发 mode 请求，改为 `Approval` 事件 + UI 批准。** 三条理由：

1. **审批闸是 §1.2 自己列为"Crew 强"的能力** —— 花力气接入 Crew 然后一键关掉它最有价值的差异化，是自相矛盾。
2. **审批是 zeromux 相对 Crew 全部 10 个 IM 渠道的唯一结构性优势。** 实测 `kiro_crew/docs/channel-capabilities.md` 的矩阵：

   | | Slack | Discord | Telegram | Teams | Webex | WeCom | **Weixin** | iMessage | WhatsApp | Feishu |
   |---|---|---|---|---|---|---|---|---|---|---|
   | Tappable choices | 10 | 25 | 25 | 5 | 5 | 0 | **0** | 0 | 0 | 0 |
   | Approval waits | 120s | 300s | 300s | 300s | 300s | — | **—** | — | 300s | — |

   微信**根本不装 approval decider**。一个 44px 的「批准」按钮 + Web Push，是 10 个渠道全都做不到、只有 zeromux 能做到的事。
3. **不会卡死** —— 审批超时 7200s（`state.py:5799`）。

**若日后仍要发 mode，请求体必须带 `slot`，并写成不变量 I4 + 单测钉死。**


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

### 5.2 守卫现状：`.kiro` 已被覆盖，不要加 pin（本节为纠错）

> **本节推翻了本 spec 初稿的结论。** 初稿主张给 `SENSITIVE_DIR_NAMES` 加 `".kiro"`，
> 理由是"base_dir 覆盖为 `~/.kiro/crew` 后守卫看不见 dot 段"。**该分析是错的**，
> 由 CTO 评审指出，并经我把谓词抄出来单独编译验证。

**错在哪**：`read_hits_home_dotdir`（`web.rs:1509-1531`）`strip_prefix` 的锚点是 **`$HOME`**（`web.rs:1518`），**不是 base**。因此 base 设成什么都不影响它 —— `~/.kiro/...` 的首段永远是 `.kiro`。

**编译实测**（把该函数原样抄出、`HOME=/home/ubuntu` 运行）：

```
/home/ubuntu/.kiro                                  → true
/home/ubuntu/.kiro/crew                             → true
/home/ubuntu/.kiro/crew/.local_secret               → true
/home/ubuntu/.kiro/crew/run/gateway-5476.secret     → true
/home/ubuntu/.kiro/crew/memory.db                   → true
/home/ubuntu/.kiro/agents/kirocrew.json             → true
```

**全部 true。** 读、写、diff 三条路径都已被覆盖：

| 情形 | 实际状态 |
|---|---|
| 读 `~/.kiro/**`（任何 base） | ✅ 已拒 —— `read_hits_home_dotdir` 锚定 `$HOME` |
| 写 / 重命名 / 删除 `~/.kiro/**` | ✅ 已拒 —— 写守卫派生同一谓词集 |
| `git diff` 根设为 `~/.kiro` | ✅ 已拒 —— `git_diff_root_unsafe` 末支即 `read_hits_home_dotdir`（`web.rs:1648`） |
| `validate_browse_root("~/.kiro")` | ⚠️ 返回 `Ok`，但随后 `list_dir_entries`（`web.rs:1843`）首行即 `read_hits_home_dotdir` → **403，只是晚一跳** |

**与 `.zeromux` 那轮不是同型**：`.zeromux` 的缺口在 `path_hits_sensitive_dir`（锚定 **base**，剥前缀后确实看不见）；`read_hits_home_dotdir` 锚定 `$HOME`，天生免疫 base 覆盖。初稿把这两个谓词的锚点混为一谈。

**结论：不加 `.kiro`。** 收益为零，代价是初稿 5.2.1 自己承认的副作用（仓库内 `<repo>/.kiro/` 从 file-browser 与 diff 中消失）。**纯负收益。** 原 T9 / T11 / T12 / T13 四个测试作废 —— 其中 T9 根本写不出红，它已经是绿的，只是 403 来自另一个谓词。

#### 5.2.1 真正该补的缺口：`is_credential_path` 漏 `.secret`

**编译实测**（把 `is_credential_path`（`web.rs:1413`）原样抄出运行）：

```
gateway-5476.secret   → false      ← 缺口
.local_secret         → false      ← 缺口
memory.db             → false      ← 缺口（记忆全文）
vapid.json            → false      ← 缺口（zeromux 自己的推送私钥！）
token_signing.key     → true       （靠 .key 后缀恰好命中）
.env / id_rsa         → true       （既有覆盖）
```

**可达性**：在 `$HOME` 之下有 `read_hits_home_dotdir` 兜底，所以**今天不可达**。但这是**叶名 denylist 轴**，与 base 轴正交 —— 一旦这些文件出现在仓库内（`KIROCREW_HOME` 可覆盖 crew home 到任意目录，`config/loader.py:3-4`；或用户把 crew home 挪进工作区），`.secret` 就会被 `list_dir` 枚举、被 `get_file_raw` 读出、被 diff 逐字打印。

**动作**：`is_credential_path` 增加

```rust
|| n.ends_with(".secret") || n == ".local_secret"
```

**为什么这条值得做而 `.kiro` 那条不值得**：它是叶名判断，不触及 base / descent 语义，**不产生任何"仓库内目录消失"的副作用**；而且它顺带保护 zeromux 自己的 `vapid.json` 之外的任何 `*.secret`（`vapid.json` 因在 `~/.zeromux/` 内而已被 `SENSITIVE_DIR_NAMES` 覆盖，此处不重复）。

#### 5.2.2 `--crew-home` 启动校验

若 `crew_home` 落在 `vault_dir` 或任何 work_dir 之下，secret 就进入了 file-browser 的可读区（绕过 `$HOME` 兜底）。**动作**：启动时检测，命中则 fail fast。

#### 5.2.3 secret 的内存边界（比初稿更严）

初稿 5.1 的三条约束正确，补两条**结构性**约束：

- **secret 与 token 不得进 `AppState`** —— `AppState` 被 `web.rs`（6481 行）的所有 handler 共享，任何一处调试打印即泄漏。
- **不得进 `Session` 结构体** —— 它会被 `session_store` 持久化到 SQLite。

只在 `crew_process.rs` 的 fan-out 任务栈上存活。

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

## 7. 明确不做（含评审推翻的两项）

| 项 | 判定 | 原因 |
|---|---|---|
| ~~审批 UI~~ | **改为要做** | **评审推翻**。它是 zeromux 相对 10 个 IM 渠道的唯一结构性优势，见 §4.5 |
| **废弃 / 合并 zeromux 定时任务** | **坚决不做** | Crew cron **零 `cwd` 字段** + 会拆掉 auto-update 的 E1 门，见 §11 |
| **zeromux 变成 Crew 的 App** | **技术上不可行** | PTY 无法穿过 HMAC 反代，见 §10 |
| **第二事件通道** | 不做 | 要配第二套 scrollback / replay / 重连，memory 里那十几轮 stale-response bug 会全部重演 |
| subagent / workflow / artifact 面板 | 第一期不做 | **理由不是"以后再说"**：它们是树状数据，塞进线性 transcript 必然错。要做就做独立面板走 REST，不污染 `AcpEvent`。且实测 `/api/spawn` = `{"agents":[]}`，用户一次都没 spawn 过 —— 给空数据建面板是浪费 |
| Crew cron / script-cron 的 UI | 坚决不做 | zeromux 已有 `ScheduledTasksPanel`（633 行）+ 确认队列 + replay + 看门狗；第二套定时语义是灾难级复杂度 |
| 技能（skill）的增删改 | 坚决不做 | 手机上编辑 skill 的 markdown 是伪需求 |
| IM 渠道配置 UI | 坚决不做 | 碰凭证，违反 workspace CLAUDE.md 的 no-secrets |
| worktree 隔离 | 不适用 | Crew 的 cwd 由 Gateway 管，`--worktree-isolation` 对 Crew 会话不生效 |
| 同一 slot 双入口（微信接续 zeromux 对话） | **永远不做** | 实测 `two-way = ❌`，微信回复**必开新 session**。做这个 UI 等于撒谎，见 §12 |
| zeromux 拉起 / 守护 Gateway | 坚决不做 | 已有 systemd；两个 `KillMode=control-group` 互拉 = cgroup 陷阱，见 §13 |
| **prompt presets** | **保留**（评审建议删，被数据推翻） | 见 §9.2 |

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

> 初稿的 T9 / T11 / T12 / T13 **已作废** —— 它们建立在 5.2 那个被推翻的分析上。
> 尤其 T9 根本写不出红：`validate_browse_root("~/.kiro")` 确实返回 `Ok`，
> 但 403 由随后的 `read_hits_home_dotdir` 给出，行为已正确。

| # | 测试 | 断言 |
|---|---|---|
| T9 | **`.secret` 叶名守卫（真实缺口，须先验红）** | `is_credential_path("gateway-5476.secret")` 与 `is_credential_path(".local_secret")` 均为 `true`（修改前为 `false`，即先红后绿） |
| T10 | `.kiro` 已覆盖的回归钉 | `read_hits_home_dotdir` 对 `~/.kiro`、`~/.kiro/crew/.local_secret`、`~/.kiro/crew/memory.db` 均返回 `true`。**此测试当场即绿** —— 它的作用是钉住"不需要加 pin"这个事实，防止日后有人重犯初稿的误读 |
| T11 | in-repo `.kiro` 不受影响 | `<repo>/.kiro/settings/cli.json` **仍可**被 file-browser 读取（证明我们没有引入 5.2 初稿那个副作用） |
| T12 | `--crew-home` 越界 fail fast | `crew_home` 位于 `vault_dir` 或 work_dir 之下时启动校验报错 |

### 8.3 前端测试（vitest）

| # | 测试 | 断言 |
|---|---|---|
| T13 | `SessionType` 含 `'crew'` | 类型与图标映射五处不漏：`api.ts:1`、`SessionTypeIcon`（`Sidebar.tsx:69-77`）、`RowIcon`（`QuickTargets.tsx:11-20`）、`agentType`（`AcpChatView.tsx:57`）、`AGENT_KEYS`（`MobileKeyBar.tsx:260-264`） |
| T14 | `AcpEvent` 新变体前端有 case | 断言 `Approval` 与 `ContextUsage` 在 `handleEvent` / `BlockView` 中均有对应分支 —— **防的是 §4.4 那个"静默丢弃"陷阱**（`BlockView` 的 `default: return null`） |
| T15 | 记忆写入的三个隐藏约束 | key 自动加 `pref.` 前缀；请求带 `X-Session-Key`；PUT 路径不带 key（见 §9.2 实测契约） |

### 8.4 手工验收（需 Gateway 运行）

**批次 1（Crew 会话跑通）：**
1. New Session 类型菜单是 **4 项**（Terminal / Claude Code / **Kiro Crew** / Codex，+ Obsidian），原 Kiro 位置已被 Crew 取代。
2. 选 Kiro Crew 能建会话，且 `GET /api/chat/slots/{key}` 的 `project` 等于所选 work_dir。
3. 发一个 prompt，流式文本正常渲染。
4. 让它跑一个 bash 命令，`tool_use` 块渲染 **一次**（非 3 次 —— I2）。
5. 轮次结束后活动看板有摘要（证明 `Result.text` 非空 —— I3）。
6. 开两个 Crew 会话同时发 prompt，**输出不串台**（I1 端到端）。
7. 忙时再发一条 prompt，两轮都完整出现且顺序正确（验证 §2.4 的"丢弃 SSE 响应体"决策）。
8. 停掉 Gateway：会话报错且不 hang，侧边栏出现降级标记；重启后重连恢复。
9. 删除会话后 `GET /api/chat/slots` 中对应 slot 消失（无泄漏）。

**批次 2（审批）：**
10. 手机锁屏收到「需要批准」推送 → 点击 → 落在该会话对话里，审批卡片可见 → 点「批准」后 agent 继续。
11. 拒绝路径同样生效，且不卡死后续轮次。

**批次 0 / 5（安全与清理）：**
12. file-browser 无法浏览 `~/.kiro`（**注意：这一条修改前就应通过** —— 见 §5.2，它由 `read_hits_home_dotdir` 保证，不是本次新增的保护）。
13. 仓库内 `<repo>/.kiro/settings/cli.json` **仍可**浏览（证明没有引入初稿那个副作用）。
14. 删 Kiro 后端后，历史 kiro 会话不 panic（回落 tmux 或经 SQL 迁移为 crew）。

### 8.5 验证门（成功判据）

- `cargo test` 全绿，`npm test` 全绿，`npm run lint` 无新增告警。
- `cargo build --release` + `npm run build` 成功（**注意**：`rust-embed` 读 `frontend/dist/`，前端必须先构建）。
- 8.4 的 **14 条**手工验收按批次全部通过。
- 现有测试**零回归**（改动前后对比 `cargo test` / `npm test` 计数）。
- **产品判据（批次 3）**：用户一周内成功写入 ≥3 条记忆。这是唯一能证明"接 Crew 有意义"的行为指标 —— 因为记忆现在是空的（§9.2）。

---

## 9. UI 与交互设计（评审新增）

### 9.1 菜单：不是 4→5，是原位换项

**先纠正一个题设**：New Session 的类型菜单**已经不是主入口**。`Sidebar.tsx:64` 的状态机第一屏是 `'quick'`，`Sidebar.tsx:502-520` 渲染 `QuickTargets`（注释："一击直达：点一行 = 用该行的 agent 直接创建，0 次列目录请求"）；只有 `onEmpty` 或用户主动点"其他目录…"才会落到 `pick-type`。实测 `zeromux.db` 的 `quick_targets` 有 6 行且今天仍在写 —— 快速入口是活的，日常 90% 走不到类型菜单。

**所以"4 变 5 会不会选择瘫痪"在日常路径上几乎无感。真正的成本在别处**：每加一个类型，`SessionTypeIcon`（`Sidebar.tsx:69-77`）、`AcpChatView` 的 `agentType`（`AcpChatView.tsx:57`）、`RowIcon`（`QuickTargets.tsx:11-20`）、`MobileKeyBar` 的 `AGENT_KEYS`（`MobileKeyBar.tsx:260-264`）都要永久多带一个分支。

**设计：Kiro 原位替换为 Crew，仍是 4 项。**

```
Select type
──────────────────────────────
[Terminal]   Terminal          bash / tmux shell
[Claude]     Claude Code       AI coding agent
[Crew]       Kiro Crew         有记忆的 AI agent      ← 原 Kiro 位置(Sidebar.tsx:581-590)
[Codex]      Codex             AI coding agent (MCP)
[BookOpen]   Obsidian 文档      笔记库（vaultEnabled 门控）
──────────────────────────────
```

三处改动：

1. `Sidebar.tsx:581-590` 整块替换。副标题写 **"有记忆的 AI agent"** —— 这是唯一能解释"它和 Claude 有何不同"的位置，别浪费成 "AI coding agent (Crew)"。
2. **不重排顺序**。弹层是 `absolute bottom-full`（`Sidebar.tsx:492`），理论上拇指最易达处在列表底部，但现有 4 项顺序已是肌肉记忆，为一个 10% 路径重排全表不值得。**少改一处是一处。**
3. `BrandIcons.tsx` 加 `CrewIcon`。**不要直接复用 `KiroIcon`**（`BrandIcons.tsx:324-339`，紫色幽灵 `#9046FF`）—— 历史 kiro 会话仍存在于会话列表（`Sidebar.tsx:412`），同图标无法区分。建议同色系 + 可区分形状（如幽灵加一圈"记忆环"）。

### 9.2 记忆的产品化 —— 本次更新的核心

#### 前提：记忆现在是空的（这改变了设计重心）

实测：

| 对象 | 实际值 |
|---|---|
| `memory/preferences.md` | **56 字节**（只有标题和一行注释） |
| `memory/projects.md` | **49 字节** |
| `GET /api/memory/semantic` | `{"entries": []}` |
| `GET /api/memory/episodic` | `{"entries": []}` |
| `GET /api/lessons` | `{"lessons": []}` |
| `memory.db` → `memory_events` | **1 行**，且是 `migration` 事件 |

**"用户怎么知道 agent 记住了什么"是第二个问题；第一个问题是它什么都没记住。** 任何只做"查看/纠正"的设计，用户打开看到空面板，会直接判定这个功能是假的。

**结论：记忆产品化的第一要务是写入，不是可见。** 因此下面 9.2.1（就地写入）的优先级**高于** 9.2.2（面板）。

#### 记忆 API 的完整实测契约

**认证：只认 `?token=`**（`X-Internal-Secret` 一律 403，见附录 A.1）。

| 操作 | 请求 | 实测 |
|---|---|---|
| 读偏好 | `GET /api/memory/preferences` | 200 `{"content":"# User Preferences\n..."}` |
| 写偏好 | `PUT /api/memory/preferences` | 整文件 `{"content":...}`（`routes/memory.py:20-21`） |
| 读语义记忆 | `GET /api/memory/semantic` | 200 `{"entries":[...]}` |
| **写语义记忆** | `PUT /api/memory/semantic`（**无 key 后缀**） | 需 `X-Session-Key: <真实 slot>`；key 需匹配 `^[a-z][a-z0-9_.]*[a-z0-9]$` **且带前缀 `pref.*` / `project.*` / `user.*` / `lesson.*`** |
| **删语义记忆** | `DELETE /api/memory/semantic/{key}` | 同样需 `X-Session-Key` |

实测成功样例：

```
PUT /api/memory/semantic   X-Session-Key: zmx-mem
{"key":"pref.pkg_manager","value":"pnpm","source":"user_explicit","confidence":1.0}
→ {"ok": true}

GET /api/memory/semantic →
{"entries":[{"key":"pref.pkg_manager","value_json":"\"pnpm\"","confidence":1.0,
  "source":"user_explicit","created_at":"...","updated_at":"...","is_deleted":0}]}
```

**三个隐藏约束**（每一个都会让第一次实现失败）：
1. `PUT` 路径**不带** key（带 key 是 405）。
2. 必须有 `X-Session-Key`，且值必须是**已存在的 slot**（否则 `unknown session`）。
3. key 必须带命名空间前缀，否则 `Key must match an allowed prefix`。

**`source` 字段可读** —— 这是 §12 微信可见性方案的基础。

#### 9.2.1 就地写入 —— composer 的记忆入口（P0，先做）

**为什么在 composer**：人只在**被冒犯的那一刻**想纠正记忆（agent 刚用了 npm 而你说过 pnpm）。那一刻拇指在输入框上。要求用户"打开设置去配置偏好"= 问卷 = 没人填。

`AcpChatView.tsx:792-810` 的 `rightSlot` 现有 2 个按钮（`ListPlus`:794 预设、`Paperclip`:805 附件）。加第 3 个 `Brain`，popover 与 `presetOpen` 同构（`AcpChatView.tsx:736-785`：`fixed inset-0 z-10` 捕获层 + `absolute bottom-full left-0 right-0 mb-2 mx-2` 弹层）。

```
┌ 记忆 ───────────────────────────────┐
│ ┌───────────────────────────────┐  │
│ │ 让它记住…                      │  │ ← PUT semantic (pref.* 前缀自动加)
│ └───────────────────────────────┘  │
│ 它记错了？(最近 5 条)                │
│  · pref.pkg_manager = pnpm    [✕]  │
│  · pref.test_before_commit    [✕]  │
│                        [ 全部 → ]   │ ← 跳 9.2.2 面板
└────────────────────────────────────┘
```

**动线：1 tap 开 → 最近 5 条直接可见（0 tap）→ 2 tap 点 ✕ → 3 tap 确认。3 tap，不离开对话，不加载新页。**

**宽度核算**（必须算）：现有 2 按钮各 `p-2`+`size 16` ≈ 32px，加发送键 40px = 104px；375px 屏下 textarea 约 246px。加 Brain → 136px，textarea 剩 **~214px**。可接受但接近极限 —— **这是 §9.3 讨论合并 `ListPlus` 的动机**。

#### 9.2.2 记忆面板 = 第 5 个 overlay view（P1）

**为什么用 overlay 而非新框架**：`App.tsx:21` 已有 `type OverlayView = 'none'|'files'|'git'|'events'`，`App.tsx:296-301` 的 `toggleOverlay` 是泛型的，`App.tsx:388-390` 是三个渲染点。加一个 `'memory'` 是**纯增量、零新导航概念**，并自动继承 `App.tsx:379-381` 的 CSS 可见性保留（对话状态不丢）。

**入口**：`SessionInfoBar.tsx:162-209` 已是 4 图标横排（FileText / GitBranch / Activity / BarChart3）。加第 5 个 `Brain`，用 `{onToggleMemory && ...}` 门控（照 `SessionInfoBar.tsx:196` 的现成 idiom），仅 `type === 'crew'` 时传入。

**手机宽度核算**：折叠条 `h-9`（`SessionInfoBar.tsx:130`），图标 `p-1`+`size 14` ≈ 22px，`gap-1` = 4px。5 图标 = 126px；加汉堡 22 + chevron 18 + StatusDot 8 + 内边距 24 ≈ 198px。375px 屏下 description 余 ~177px，`truncate` 生效。**6 个图标就会崩 —— 这是硬上限，所以审批不占图标位。**

**内容**（单列，结构照 `AgentDashboard.tsx:87-176`）：分区显示 偏好 / 项目上下文 / 教训 / 语义记忆，每条一行 + 常驻 `✕`，并显示 `信度 · 来源`。

**三条交互决策**：

1. **纠正的原语是"删一行"，不是"编辑"。** `preferences` 的 PUT body 是整文件 —— 手机上做 markdown 编辑器是灾难。方案：前端渲染成行，删除时本地重组 markdown 再整体 PUT。而 `semantic` 有真正的 `DELETE /{key}`，**因此引导用户把重要偏好写进 semantic 而非 preferences**（9.2.1 的"让它记住"就写 semantic），长期可纠正性更好。
2. **`✕` 常驻，绝不用 `group-hover`。** 依据 `QuickTargets.tsx:118-120` 的教训原文：Tailwind v4 把它编译进 `@media (hover:hover)`，手机上元素永久 `opacity:0` 但仍可点击（隐形按钮）。**注意 `SessionInfoBar.tsx:319` 的 `NoteItem` 和 `AgentDashboard.tsx:226` 都用了 `hovered` state —— 那两个按钮在手机上实际摸不到。新面板不要重复这个错。**
3. **二段确认，不用 `window.confirm`。** 点 `✕` → 该行下沉展开「确认移除」，照 `QuickTargets.tsx:134-165` 的行级操作单形状（注释："这一层本身即确认，故不再加 confirm 弹窗"）；`PromptManager.tsx:64` 也有同样先例（"no window.confirm — bad on mobile"）。

**空状态是本设计最重要的一屏**（因为今天必然是空的）：居中一个输入框 + 「记住这条」按钮，占位文案给例子（"例：提交前必须先跑 npm test"），输入框用 `text-base`(16px) —— 依据 `Composer.tsx:225-226` 的教训：低于 16px 时 iOS Safari 聚焦会自动放大整页，把发送键挤出视口。

**额外入口**：记忆在 Crew 侧是**全局的**（一份 Gateway 一份记忆），而 overlay 是 per-session（`App.tsx:33` 按 session id 存 key）。若当前无 Crew 会话就没有入口 —— 在 `Sidebar.tsx:881-918` 的 settings popover 补一项（照 `:893-899` 推送通知那条的形状），复用同一组件。

**Token 生命周期约束**：记忆面板走 token（附录 A.1），而 token `exp ≈ 5 分钟`。**面板若轮询必须有 re-mint 逻辑** —— 这是初稿缺失的承重约束。

#### 9.2.3 可见性靠"回执"，不靠面板

用户不会主动去查记忆面板（一天 0 次）。所以"怎么知道 agent 记住了什么"的正解**不是造更好的面板，而是让记忆每次生效时留下痕迹**：

**写入回执** —— 记忆写入时在对话流留一行轻量提示。**现成组件已存在**：`AcpChatView.tsx:865-868` 的 `NoticeBubble` 的 `system` 分支正是 `text-[11px] text-[var(--text-muted)] italic`。写「已记住：包管理器用 pnpm」。

**生效回执**（P2，不进第一批）：实测存在 `GET /api/memory/context-preview`，可在 turn 开始时显示「本轮注入了 3 条记忆」。它把记忆从黑箱变成每轮可审计，但需额外请求，第一批不做。

### 9.3 审批 UI —— 白拿三条现成管道

这是性价比最高的一项，因为三条基础设施已存在且形状匹配：

1. **事件通路零新增**：crew fan-out **已经独占订阅 Gateway 的全局 WS**，approval 请求就在那条流里 → 走既有 `broadcast::Sender` → `/ws/acp/{id}` → `handleEvent`。**不新开连接、不新增轮询。**
2. **渲染位置**：审批天然属于某个 turn 的某个 tool_call，所以必须在对话内联。`BlockView`（`AcpChatView.tsx:887-969`）加 `case 'approval'`，视觉照 `tool_use` 分支（`:928-946`，左边框 `border-l-2`），底部两个 `min-h-[44px]` 按钮。上行照 `interrupt` 的形状（`AcpChatView.tsx:589-595`），后端 fan-out 代理 `POST /api/approvals/{id}/{action}`（实测 `GET /api/approvals` 返回 `[]`，只认 token）。
3. **通知**：`push.rs:353` 已有 `confirm` kind 且归 `lvl_important`（`push.rs:380-381`）；`sw.js:31` 用 `${session_id}:${kind}` 做 tag，`sw.js:45` postMessage `open_session`，`App.tsx:176-189` 接收后 `setActiveId` deep-link。**整条"锁屏通知→点击→落到那个会话"的链路已经通了。**

**完整体验**：手机锁屏收到「Crew 要执行 rm -rf /tmp/build，需要批准」→ 点开 → 直接落在该会话对话里，审批卡片就在眼前 → 拇指点「批准」。**全程 3 秒。**

**默认值**：在 `SessionInfoBar` 展开面板加一个 select，与 queue mode 完全同构（`SessionInfoBar.tsx:236-252`）。**per-session、默认沿用 Crew 自身的 interactive**（不发 mode 请求，见 §4.5）。

---

## 10. 否决：zeromux 变成 Crew 的 App（三个硬阻断）

评审读透 App Kit 后的结论 —— 这条路**技术上不可行**，不是取舍：

1. **原始 WebSocket 无法穿过反代。** `/apps/{name}/api/` 走 `session.request()`（`apps/routes.py:3737`），`upgrade` 在 `_PROXY_HOP_HEADERS`（`routes.py:3557`）里被删，且 `_PROXY_TIMEOUT = 30`（`routes.py:3520`）。**PTY 直接死。** App 唯一能碰的 WS 是宿主 `/api/ws`，而它是经 `permissions.events` 过滤 + payload 脱敏的事件总线（`event_bus.py:114`），不是字节管道。
2. **`.html` 被拒 + 无 splat 路由。** `_ALLOWED_EXTENSIONS`（`routes.py:2148`）不含 `.html` → 403；React Router 入口 `path:"/apps/:name"` 无 splat，`_APPS_SPA_EXCLUDED_RE`（`token_auth.py:657`）把其余路径送回 Crew 自己的 shell。SPA 必须重写成挂在宿主 React 上的 ESM 模块。
3. **多用户 OAuth 无法表达。** 反代**删掉 `cookie` 和 `authorization`**（`routes.py:3562-3567`，注释原文："app backends use X-KiroCrew-Proxy HMAC, not user cookies"），转发的 HMAC 签的是 `ts:method:target:sha256(body)` —— **app 域，无用户身份**。

**加上 §0 的第 2 条（Crew 无 Web Push，App 也拿不到自己的 SW/VAPID 域）：这条路要放弃 PTY、重写前端、放弃多用户、放弃推送。不是重构，是产品自杀。**

---

## 11. 否决：废弃 zeromux 定时任务（两条硬理由）

### 11.1 Crew cron 没有工作目录概念（架构级不可替代）

```
grep -c 'cwd' cron.py        → 0      （4849 行，零命中）
grep 'cwd' mcp_cron.py       → 0
CronJob 字段：folder_id / timezone / timeout_secs / script / command / env /
  session_key / channel / thread_ts …  无 cwd / project / work_dir
```

而 zeromux 的 `TaskConfig.work_dir`（`scheduled_tasks.rs:358`）是**必填**，`trigger_run(&run.id, nm, &task.work_dir, …)`（`scheduled_tasks.rs:1160`）把它传进 spawn。zeromux 的定时任务本质是「**在这个仓库**跑这个 prompt」，Crew cron 表达不了。

### 11.2 它是 auto-update 的 E1 安全门

`active_run_count()`（`scheduled_tasks.rs:600-605`：`SELECT COUNT(*) FROM agent_task_runs WHERE state IN ('claimed','running')`）是 `running_summary().scheduled` 的来源，而 auto-update 的 E1 不变量完全建立在它上面（`auto_update.rs:126` 的 `if summary.scheduled > 0`、`:313` 的 `scheduled_read_failed` fail-closed 分支）。

**废弃 `scheduled_tasks.rs` = 拆掉 auto-update 的安全门 = 重演 memory 里那一串 502 / E1 事故。** 这一条单独就否决了废弃方案。

### 11.3 正确做法：不迁移，只加一臂

让 `TaskConfig.agent_type` 支持 `"crew"` —— 定时任务用 Crew 会话执行，走同一个 `SessionInput::Prompt`，**照旧进 E1 门**。`agent_type` 已是自由字符串，只需 `trigger_run` 的 spawn 分派加一臂。**（S）**

**分工**：zeromux 调度 = 仓库内的定时 agent 任务（有 cwd、进 E1 门、有确认队列/replay）；Crew cron = 无仓库上下文的运维/观察任务（script-cron + irq 轮询 + IM 投递）。

**Crew 的 jitter（`cron.py:3801`）与 folders（`cron.py:648`）不抄** —— 单用户单任务无所谓（YAGNI）。

---

## 12. 微信：正确用法与"诚实版"可见性

### 12.1 实测限制（读代码，非抄文档）

| 限制 | 证据 |
|---|---|
| 不能流式 | `weixin/transport.py:67` = `streaming=False` |
| 仅私聊 | `weixin/transport.py:23` "DM-only" |
| 无可点按钮 | `channel-capabilities.md`：Tappable choices = **0** |
| 不问审批 | 同矩阵：Approval waits = **—**（不装 decider） |
| **回复开新会话** | 同矩阵：Dashboard link is two-way = **❌** |
| 不能回传文件 | 同矩阵 ❌（但能接收你发的文件 ✅） |
| **反而能渲染表格** | 同矩阵：Renders markdown tables natively = **✅**（比 Slack 强） |

### 12.2 定位：投递口 + 播报口，不是对话终端

**适合从微信发起**（须同时满足：一句话说完、不需看过程、结果是一段文字）：
- 「把这条记进项目上下文：zeromux 部署只走 ./deploy.sh」—— **最佳用例**，写记忆天然一次性，且正好解决 §9.2 的"记忆是空的"
- 「昨天那轮 review 有 HIGH 结论吗，给结论就行」

**适合从微信接收**：cron / script-cron 播报、run 结束摘要、日报 —— **因为它原生渲染 markdown 表格**，表格型日报在微信里比 Slack 好看。

**必须回到 zeromux 的四类**：
1. 任何需要批准的操作 —— 0 可点按钮且不装 decider，从微信发起会**直接被拒、任务卡死**，且你看不出为什么。
2. 任何要看过程的 —— 不能流式，发出去就是几分钟静默然后一整段，中途无法判断跑偏。
3. 任何要看 diff / 文件 / git 的 —— 不能回传文件。
4. 任何多轮追问的 —— two-way ❌，你的回复**开新 session**，上下文丢失。**这是最容易踩的坑**，表现为"agent 突然失忆"。

**封号风险的产品结论**：不放在任何关键路径上；**zeromux 侧绝不做微信配置 UI**（也符合 no-secrets），且**绝不让任何 zeromux 功能依赖微信可用**。

### 12.3 不做「这个会话也能从微信继续」的 UI

那句话是**假的** —— 实测 `two-way = ❌`，微信回复必开新 session，第二期也不成立。做这个 UI 就是撒谎，用户信了会踩坑 4。

**诚实且免费的替代：在记忆面板显示 `source` 字段。** 实测 `semantic` 条目已含 `source`（见 §9.2 的实测样例），把它渲染成「信度 1.0 · 来自 微信」。这样"共享记忆"从一句空话变成**看得见的事实**：你在微信里教它的那条，出现在 zeromux 的记忆面板里，标着来自微信。**零后端改动，且它说真话。**

---

## 13. Gateway 守护：fail fast + systemd 声明依赖

初稿 §9 把"无自动拉起"列为遗留。**实测：这不是遗留，Gateway 已有 systemd 守护**：

```
kirocrew.service  loaded active running
Restart=on-failure   RestartSec=10   StartLimitBurst=3/300s   KillMode=control-group
```

**zeromux 绝不该管它**，三条理由：

1. **已有更好的守护者** —— systemd 的 `Restart=on-failure` 比任何自写 supervisor 可靠。
2. **`KillMode=control-group` + zeromux 拉起 = 重演 cgroup 自杀陷阱** —— 见 CLAUDE.md 里那段 502 事故记录。两个 `KillMode=control-group` 的服务互相拉起 = 事故工厂。
3. **正确做法是声明依赖，不是写代码**：`zeromux.service` 加 `After=kirocrew.service` + `Wants=kirocrew.service`（**不是 `Requires`** —— Crew 挂了，zeromux 的 PTY/Claude/Codex 会话应照常活）。**零 Rust 代码。**

初稿的 fail fast 决策**正确**，只需把 §9 的"Gateway 单点=遗留"改成"由 systemd 负责，zeromux 只做 health check + 明确报错 + 侧边栏降级标记"（避免用户在 Gateway 挂掉时反复点 New Session）。

---

## 14. 删除清单（不破不立，逐条附数据）

### 14.1 Kiro 后端 —— 删（菜单 + 后端路径）

见 §1.1。约 1045 行 + 70 处引用 + 前端 5 文件；DB 代价 1 行。**排在 Crew 跑通并通过手工验收之后再删**，避免同时改两处。

`quickTargets.ts:3` 的 `AGENTS` 数组去掉 `'kiro'` —— 该文件注释早已预言这一天。

### 14.2 Prompt Presets —— **保留**（评审建议删，被数据推翻）

产品总监建议删除，理由是"8 条与种子逐字相同、近 3 个月零改动、用户从未新增 → 用脚投票"。**我核实后推翻这个结论**：

- 8 条 body 与种子一致 ✓，用户确实没新增 ✓
- 但 `updated_at != created_at` 的有 **8/8 条**（created 全为 2026-06-16，updated 6 条为 06-25）→ **不是"零改动"**
- **决定性反证**：这 8 条是 2026-06-16 经**专门 PE/CE 调研 + CTO 评审锁定原则**后写的（4 行骨架 Task/Approach/Done-when），且当时的决策记录明确写着 **"不新增（owner 要 better 不是 more，加 chip 稀释）"**

**"只有 8 条、没有新增"是设计意图，不是废弃信号。** 保留。

**可考虑的最大动作**：把 composer 的 `ListPlus` 与 `Brain` 合并进同一个 popover（省一个按钮位，缓解 §9.2.1 的宽度压力），**功能保留**。此项列为可选。

### 14.3 Notes —— **删（已获用户确认 2026-09-13）**

**数据**：`notes.db` 的 `notes` = **1 行**（标题「帮我全选」，`2026-06-06T12:00:19Z`）。**3 个月 7 天，没有第二条。**

**功能重叠**：notes 的设计目标"按工作目录聚合、跨会话留住上下文"（README_ZH.md:19）**逐字就是** Crew `memory/projects.md` 的定义。

**删除范围**：`notes.rs`(342 行)、3 个 API、`SessionInfoBar.tsx:254-285`（notes 段）+ `:44-45,90-113`（state/handler）+ `:292-329`（`NoteItem`）+ `:331-342`（`formatNoteDate`）。

**三重收益**：
- `SessionInfoBar` 展开面板腾空，正好放 §9.3 的审批 select
- **删掉一整套 stale-guard** —— `SessionInfoBar.tsx:55-113` 那段 `reqRef` 是 2026-08-15 修的 MED 级 stale-response bug。**删功能比维护 bug 修复划算**
- 消灭一个隐形按钮（`NoteItem` 的删除键用 `hovered`，手机上摸不到）

**已获用户明确确认执行。** 唯一那条 note（`~/.zeromux/notes/073707de/20260606_120019_6e68.md`，标题「帮我全选」）随功能一并移除；`notes.db` 保留在磁盘上不主动删除（用户数据，删代码不删数据）。

### 14.4 zeromux 定时任务面板 —— 不删，入口降级 + 徽章合并

**反对删除**：`agent_task_runs` = **20 行真实运行**，跨 2026-07-28→08-16，含真实的 `succeeded` / `aborted(orphaned_restart)` / `confirm_status=confirmed_done` 历史；且 §11 已证明 Crew cron 替代不了它。

**支持降级**：唯一任务 `enabled=0`，最后运行 2026-08-16（近 1 个月未跑），却在 Sidebar 顶栏占一个常驻位（`Sidebar.tsx:354-371`）。

**动作**：
- 入口从顶栏常驻移入 settings popover（`Sidebar.tsx:881-918`）
- **腾出的顶栏位给「待你处理」合并徽章** —— 现在 `App.tsx:134-146` 每 30s 轮询 `listConfirmations` → `confirmCount` → `Sidebar.tsx:363-370` 红色徽章；而 §9.3 的待审批需要一个**完全同构**的东西。两者语义一致（agent 停下来等你），push 分类也一致（都归 `lvl_important`）。合并成一个「待你处理 N」，点开是统一列表（定时任务待确认 + Crew 待审批）。
- 复用 `ConfirmationQueue`（`ScheduledTasksPanel.tsx:199-236`）的卡片形状 —— 它已是"标题+时间+原因+output_tail+两个动作按钮"，**审批卡片就是同一形状换两个按钮**。

**这是本清单里唯一的真正简化：两条"等你处理"的管道合成一条。**

### 14.5 活动看板 —— 保留

`events.db` 的 `agent_events` = **130 行，今天仍在写**（最新 `2026-09-13T15:35Z`）。**数据证明的活功能。** 它也是未来 subagent 面板的宿主。

### 14.6 只报告不动

`--codex-reasoning`：README_ZH.md:92,99 自述"仅当模型/供应商支持并传递 `thinking` 才生效，否则为空操作"，而 gpt-5.5/5.4 上游 404。疑似长期空操作，但它是 CLI flag 非 UI，维护成本≈0。按 CLAUDE.md「注意到无关死代码要提，不要删」处理：**提出，不动。**

---

## 15. 交付顺序

| 批次 | 内容 | 验收判据 |
|---|---|---|
| **0（先做，负工作量）** | 删掉 §5.2 初稿的 `.kiro` pin 计划；`is_credential_path` 加 `.secret`（先验红）；`--crew-home` 越界校验；systemd `After=/Wants=` | T9 先红后绿；T10/T11 绿 |
| **1** | `crew_process.rs` + `SessionType::Crew` + fan-out（I1/I2/I3 + T1-T8）；菜单 Kiro→Crew 原位替换 | 手工验收 8 条全过（见 §8.4） |
| **2** | `AcpEvent::Approval` + `ContextUsage` + 前端 2 个 case（**同一 commit**）；审批内联卡片 + 「待你处理」合并徽章 | 手机锁屏收到审批推送 → 3 tap 内完成批准 |
| **3** | composer 的 `Brain` 就地记忆入口（9.2.1）+ 写入回执 | **用户一周内成功写入 ≥3 条记忆** |
| **4** | 记忆面板 overlay（9.2.2）+ `source` 来源标注（12.3） | 打开面板能看到第 3 批写入的记忆，且标出来源 |
| **5** | 删 Kiro 后端（含 DB 清理）；**删 notes**（已确认）；定时任务入口降级 | `cargo test` / `npm test` 零回归 |
| **6** | 观察是否真的用 subagent / TaskRunner；**没发生就不做** | — |

**批次 3 先于批次 4**：因为记忆现在是空的，先造面板会看到空面板。**先解决写入，再解决查看。**

---

## 16. 已知遗留

| 项 | 说明 |
|---|---|
| **记忆跨用户共享** | 多用户部署下所有人共享同一份 Crew 记忆。更强的结论：**任何能在 zeromux 里跑 shell 的人 = Crew 的 owner**（因为 zeromux 持有 Gateway 的 internal secret）。而 Crew 自己把 `.local_secret` 列入敏感路径（`security/paths.py:496`）并从 agent 环境剥离 `KIROCREW_INTERNAL_SECRET` —— 它的威胁模型明确假设 agent 不该拿到这个 secret。**必须写进 README。** 开放多用户前必须重新评估 |
| Gateway 单点 | 由 systemd 负责（§13）；zeromux 只 health check + 降级标记 |
| 认证不对称 | Crew 侧既有设计，zeromux 只能适配（附录 A.1） |
| token TTL ≈ 5 分钟 | 记忆面板若轮询需 re-mint 逻辑（§9.2.2） |
| 同 slot 双入口 | **永不做**（§12.3） |
| Crew subagent / workflow 面板 | 待真实使用后再评估（§7） |

## 附录 A：第二轮实测发现（2026-09-13，交叉评审期间）

> 本附录记录在 CTO / 产品总监交叉评审期间新做的实测。**这些事实会重塑第一阶段范围**，
> 正文中与之冲突的表述以本附录为准。

### A.1 认证：token 覆盖全部端点，secret 只覆盖 `/api/chat*` 那批（**已订正**）

> **本节订正了我自己先前写错的结论。** 初版附录写"两套凭证覆盖的端点集合完全不相交、
> zeromux 必须双持"——**那是用一个已过期的 token 测出来的假象**。用 fresh token 重测后
> 结论完全不同。

**权威矩阵**（每次都用刚 mint 的 20h token 重测）：

| 端点 | `X-Internal-Secret` | `?token=` |
|---|---|---|
| `/api/chat/slots`、`/api/spawn`、`/api/crons`、`/api/taskrunner`、`/api/workflows/runs`、`/api/artifacts`、`/api/lessons` | 200 | **200** |
| `/api/memory/*`、`/api/approvals`、`/api/status`、`/api/sessions`、`/api/models`、`/api/monitors`、`/api/notifications` | 403 | **200** |

**结论：token 是超集，15/15 端点全通。** secret 只在 `_MIXED_INTERNAL_API_PATHS`（`server.py:716-760`）那批上额外可用。

**实现含义（比初版简单得多）**：
- **只需持有 token 一种凭证**，不需要按端点分流。
- secret 的唯一用途是**换取 token**（`GET /api/token/local`，头 `X-Local-Secret`）。
- 例外：**WebSocket 只认 `?token=`**（secret 在 WS 上 403）—— 这一条初版是对的。

### A.1.0 `?token=` 是**一次性登录链接** —— REST 复用必须走 Cookie（**二次订正**）

> **本节再次订正 A.1。** A.1 说"token 是超集、15/15 端点全通"——**那是一次调用一个 token 测出来的**，
> 掩盖了一个会造成间歇性故障的行为。由执行 Task 8 的 subagent 发现，我实测复现。

**Gateway 把 URL 携带的 token 当一次性登录链接**：首次使用就把它的 `nonce` 写进**持久化**的
revoked denylist（`token_auth.py:2805-2810`，`await asyncio.to_thread(_get_revoked_store().revoke, ...)`）。
Cookie 路径不走这个分支（它以 `use_session_exp=True` 校验，只读 denylist、不自我吊销）。

**实测（15 轮 × 4 并发，模拟 `GET /api/crew/memory` 的四发）**：

| 传输方式 | 失败数 |
|---|---|
| `?token=<jwt>` | **1 / 60**（403，随机落在后到的那个请求上） |
| `Cookie: mc_token_5476=<jwt>` | **0 / 60** |

串行复用 4 次不会触发（我测过 4/4 全 200）—— **只有并发或高频复用才暴露**，这正是它容易被漏掉的原因。

**含义**：
1. **任何用一个 token 发多个请求的地方都必须走 Cookie**，不能用 `?token=`。`GET /api/crew/memory` 并发四发，属于必须。
2. Cookie 方式还有个附带好处：token 不进 URL，所以任何回显请求 URL 的上游错误都不会泄漏它。
3. **WS 仍然只能用 `?token=`**（浏览器无法在 WS upgrade 上设头）—— 但 WS 每次连接都新 mint 一个 token，一次性语义正好相容，不受影响。

**顺带订正两处**：
- A.1 表里 `/api/lessons` 标"token 200"**不可靠** —— 它在 `_MIXED_INTERNAL_API_PATHS` 里，token 路径正是暴露自我吊销的那条。用 Cookie 或 secret。
- 文档写入（`preferences` / `projects`）**不需要** `X-Session-Key`，只有两个 `semantic` 操作需要。所以没有 Crew 会话的用户仍能编辑 markdown 文档（Task 9/10 的 409 门不该拦文档写入）。

### A.1.1 `?ttl=` 收的是 duration 字符串，不是秒数（**关键**）

实测：

```
?ttl=300  → expires_in = 72000   ← 静默回落到上限 20h，不报错
?ttl=5m   → expires_in = 300
?ttl=20h  → expires_in = 72000
```

`MAX_SESSION_TTL_SECS = 20*3600`（`token_auth.py:693`）。

**这消掉了初版的一条"承重约束"**：初版说 token `exp ≈ 5 分钟`、"记忆面板若轮询必须有 re-mint 逻辑"。真相是**用 `?ttl=20h` mint 一次就够 20 小时**，面板不需要 re-mint。我先前观察到的 5 分钟 exp，是因为没带 `ttl` 参数时的默认行为与我误读了 `exp` / `session_exp` 两个字段。

**但 fan-out 的每次重连仍应重新 mint** —— 那是廉价操作（一次 loopback GET），且能自然覆盖"token 在长连接期间被 revoke"的情形。

### A.1.2 approval 帧的确切字段（**订正 §4.4 的字段名**）

实测 `interaction_coordinator.py:40-48` 的 payload 构造：

```python
state._pending_approvals[approval_id] = {
    "id": approval_id,
    "source": source,                                   # "dashboard" 等来源标识
    "tool": _redact(tool, ...),
    "tool_input": _redact(tool_input, ...),
    "tool_purpose": _redact(tool_purpose, ...),
    "slot": slot,
    "ts": time.time(),
}
state.broadcast_ws("approval", ...)                     # WS 帧 type = "approval"
```

**三处订正 §4.4 的初版描述**：

1. 字段名是 **`tool_purpose`** / **`tool_input`**，不是 `purpose` / `input`。
2. `tool` / `tool_input` / `tool_purpose` **在 Gateway 侧已过 redact**（凭证与 exfil URL 已被抹掉）—— zeromux 不需要再做一遍，但也不能假设它们是原始值。
3. `data.slot` **存在** —— I1 的 slot 过滤对 approval 帧同样适用。

`POST /api/approvals/{id}/{action}` 接受 **三个** action：`approve` / `reject` / `reject_once`（`sessions.py:1603-1610`）。成功回 `{"ok":true}`，找不到或已过期回 **404**。第一期只用前两个，但后端代理**不要把第三个写死掉**。

### A.1.3 approval payload **不带只读标记** —— 因此第一期砍掉 `auto_read` 档

起草期设计过一个「只读工具自动批准」档（`auto_read`），需要一个"这个工具是只读的"信号。**实测该信号不存在**：payload 的 `source` 是 `"dashboard"` 这类**来源**标识（`interaction_coordinator.py:77`），不是工具只读性；`tool_call.kind == "execute"` 只出现在 `tool_call` 帧上，approval 帧本身不携带。

**决定：第一期只做「每次询问」一档。** 连带后果：

- 审批 select 变成只有一个可选值的**死控件** → **不做那个 select**。`SessionInfoBar` 因 notes 删除腾出的空间暂时空着（或留给日后真有第二档时）。
- `AcpEvent::Approval` 不需要只读性字段。
- 前端 `approvalMode` prop 与 `approvalModeRef` 不需要存在。

**若日后要加 `auto_read`**：正确做法是在 fan-out 侧把同 `tool_call_id` 的 `tool_call.kind` 缓存起来，等 approval 帧到达时查表 —— 而不是猜一个 payload 里没有的字段。这条写在这里，免得日后重新发明。

### A.2 Crew **没有** Web Push（zeromux 不可替代性的最硬证据）

`grep -rli vapid` 在整个 `kiro_crew` 包内**零命中**，无 `pywebpush` / `web-push` 依赖。Crew 的 `/api/notifications*` 只是 dashboard 内的通知列表（`ack`/`unack`/`ack-all`）加 IM 渠道投递。

zeromux 有完整的 PWA + VAPID Web Push（`push.rs` 935 行，三类触发 + SW 前台抑制）。

**结论**：**"agent 干完活主动叫醒手机"这件事只有 zeromux 能做。** 这既是"为什么不直接用 `localhost:5476`"的答案，也直接否决了"把 zeromux 改造成 Crew 的一个 App"的路线 —— App 跑在 Crew dashboard 里，没有自己的 Service Worker 作用域和 VAPID 身份，会丢掉这个唯一的移动端优势。

### A.3 subagent 需要一个"能显示审批的已连接 surface"

实测 `POST /api/spawn` 后，subagent 以 `outcome: failed` 结束，错误原文：

> `spawn rejected: no surface could show the approval prompt, so nobody could answer it (no dashboard client is connected). The spawn was refused now rather than held until the reaper's deadline.`

**但这不是死局，而且解法比预想的干净得多。** `admission.py:791-799` 自己列出了四条放开途径：

1. spawn 时带 **`approval_mode="auto"`**（逐次调用参数）
2. 父会话在 dashboard 里开 Trust
3. `config.json` 设 `hooks.auto_approve_subagent_spawn = true`
4. `hooks.auto_approve_sources` 加入 `"subagent"`

**实测第 1 条端到端通过**：

```
POST /api/spawn  {"task":"Reply with exactly SUBOK2 and nothing else.","approval_mode":"auto"}
→ {"id":"3acc86b8","status":"spawned"}
轮询 GET /api/spawn →
  {"id":"3acc86b8","done":true,"outcome":"completed","result":"SUBOK2","error":""}
```

**含义（这一条修正了本节的初始判断）**：subagent 只需在 API 调用里多带一个字段即可工作 —— **不需要审批 UI，也不需要改 Crew 的全局配置**。因此：

- subagent 可以在第一期就获得第一方支持，边际成本仅为一个 JSON 字段；
- 审批 UI 彻底降级为"想要更强安全性时的可选项"，不再是任何能力的前置条件。

### A.4 Crew cron 的能力与体量远超 zeromux 版

| | zeromux | Crew |
|---|---|---|
| 实现 | `scheduled_tasks.rs` 1736 行 | `cron.py` **4849 行** |
| 触发 | cron 表达式 | `every`（最小 60s）/ `at` / cron 表达式 |
| 特性 | run_id 贯穿、看门狗、终态精化、幂等 finalize | timezone、`agent_id`、**script cron**（不花 model call）、跨进程文件锁、连续失败 5 次自动暂停（`_AUTO_PAUSE_THRESHOLD`）、per-wake 超时预算 |

关键机制：cron 运行在自己的 slot `cron:{job.id}`（`cron.py:743,805-812`），并可 `set_origin` 指向发起会话（`cron.py:3003`）。

**含义**：Crew cron 能驱动 zeromux 中可见的 Crew 会话 —— "让位给 Crew cron"的迁移路径在技术上成立。

### A.5 存量数据现实：删除 Kiro 的迁移代价≈0，定时任务实际闲置

实测生产库：

```
~/.zeromux/zeromux.db  sessions  →  claude: 3, kiro: 1   （无 codex / tmux 存量）
~/.zeromux/scheduled.db agent_runs_config → 共 1 行:
    'zeromux Code Review', cron '0 0 6 * * *', agent_type=claude, enabled=0（已禁用）
  agent_task_runs → 历史 20 次
```

两个结论：

1. **删除 Kiro 后端的存量代价近乎为零** —— 只有 1 个 kiro 会话，且 `from_str_lenient`（`session_manager.rs:71-77`）对未知类型回落 Tmux（注释原文："最保守，PTY 无 resume 副作用"），即便不写迁移也不会崩。要干净则一条 `UPDATE sessions SET type='crew' WHERE type='kiro'` 即可。
2. **zeromux 的定时任务链在真实使用中是闲置资产** —— 唯一任务已禁用。这不代表它没价值（作者在其上修了十几轮 bug、积累了大量不变量），但意味着"改用 Crew cron"的**用户侧迁移成本为零：没有活跃任务需要搬迁**。

### A.6 记忆可读可写，且是纯 markdown（手机端 UI 成本极低）

实测（**只认 token**，见 A.1）：

- `GET /api/memory/preferences` → 200 `{"content":"# User Preferences\n..."}`
- `PUT /api/memory/preferences` → 同路径支持写（`routes/memory.py:20-21`）
- `GET /api/memory/projects` → 200 `{"content":"# Active Projects\n..."}`
- `GET /api/memory/stats` → 200 semantic / episodic / embedded 计数
- 另有 23 个 `/api/memory/*` 端点（episodic / semantic / graph / promote / consolidate / context-preview / settings / observability …）

**含义**：`preferences` 与 `projects` 是**纯 markdown 文本** —— 手机上一个 textarea 加保存按钮，就能完成"查看 agent 记住了什么 / 纠正一条错误记忆"。这是记忆可见化的技术基础，成本极低、收益极高。

### A.7 渠道状态一个端点全给（微信可见性成本≈0）

`GET /api/status?token=` 的 `channels` 字段一次返回全部 10 个渠道，每个含 `{connected, error}`：

```
slack, wecom, telegram, discord, webex, teams, weixin, imessage, whatsapp, feishu
```

当前全部 `connected: false`（未配置）。同一端点还给 `uptime` / `sessions` / `update_available`，可一并用于 Gateway 健康指示（对应第 6 节的降级 UI）。

### A.8 TaskRunner 可用，且支持内联 spec

`GET /api/taskrunner` → `{"running":false,"available":true,"default_workspace_dir":"..."}`。

`POST /api/taskrunner` 接受 `{"spec":"path/to/file.md"}` 或 **`{"spec":"__inline__:# Task content..."}`**（`handlers/taskrunner.py:131-151`）—— 内联 spec 会被写入工作目录的临时文件。

**含义**：zeromux 可以把一段 markdown 直接交给 TaskRunner，无需先落盘。

### A.9 WS 无 per-slot 订阅 —— I1 过滤不变量必需且不可绕过

`websocket_hub.py` 只有 `_ws_log_subscribers` / `_ws_subagent_subscribers` 两类订阅集合，**没有按 slot 订阅的机制**；事件作用域门（`ws_event_scope.py`）是按 app / owner 而非按 slot 过滤。

**含义**：客户端侧按 `data.slot` 过滤（正文 4.2 的 I1）**是唯一手段**，无法通过服务端订阅规避。I1 因此从"实现细节"升格为"协议层必需不变量"。

