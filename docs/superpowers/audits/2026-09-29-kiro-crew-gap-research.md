# Kiro Crew 深挖 × ZeroMux Crew 接入差距调研（2026-09-29）

- 性质：只读调研，没有改代码，也没有调用任何写接口（Gateway 只做了 GET，token 通过 `crew_memory.rs` 同款 mint 流程现取现用，没有落盘）。
- 前置底稿：`docs/superpowers/audits/2026-09-29-kiro-stage-inventory.md`（ZeroMux 侧的五阶段盘点）。本文不重复那份，只补 **Crew 侧真实能力** 和 **接入差距**。
- 范围约束：个人项目，all-trust。治理、权限、沙箱、审计**全部不在范围内**。下文凡是 Crew 源码里的 grant、approval gate、redaction 细节，一律只作为背景，不当作需求。
- 版本：本机 Crew 为 `kirocrew-0.6.0`（`~/.kiro/crew-venv/lib/python3.12/site-packages/kirocrew-0.6.0.dist-info`，CHANGELOG `[0.6.0] - 2026-09-05`）。
- 路径约定：下文 `KC/` 指 `~/.kiro/crew-venv/lib/python3.12/site-packages/kiro_crew/`；`ZM/` 指 ZeroMux 仓库根目录。

---

## 结论先行

1. **Stage 3–5 的能力 Crew 基本齐全，而且都是一等公民，不是文章里的概念。** Crew Mode（话题并行分派）、`kirocrew-conductor`（decompose/dispatch/patrol/accept/sequence 五职责）、`kirocrew-pipeline-conductor`（队列式 pipeline）、dynamic workflows（`parallel` / `pipeline` DSL）、cron（含 `agent_sequence` 串行多 agent）、monitor loop（autonudge）、session ledger、共享记忆，全部有 HTTP 路由，而且本机已经装好（`~/.kiro/agents/kirocrew-conductor.json`、`kirocrew-pipeline-conductor.json`）。
2. **ZeroMux 目前只接入了 Crew 的「单 slot 聊天」这一层**：建 slot（请求体只有 `name`）→ `POST /api/chat` → 归一化 8 种 WS 帧，外加审批卡、上下文用量、记忆面板。Crew 的 Stage 3–5 能力**一个都没接**，也没有可视化。
3. **有一个结构性阻塞（P0）**：`normalize_frame` 把 `chat_message` 帧丢掉了（`ZM/src/acp/crew_process.rs:202-206`），而 Crew Mode 的回答（`crew_result` / `crew_ask` / `crew_meta`）恰恰只通过 `chat_message` 帧投递（`KC/crew_chat.py:1177-1183`）。所以就算把 slot 切进 crew mode，ZeroMux 也**看不到任何话题结果**。`subagent_*` 帧同样被丢弃。
4. **分工建议：编排交给 Crew，ZeroMux 做「手机驾驶舱 + 叫醒」。** 协调器、队列、调度语义、记忆存储都不要自建（Crew 已经各写了几千行：`crew_chat.py` 1941 行，`workflows/` 5676 行，`cron.py` 4849 行）。ZeroMux 自建的只有三块：① 把 Crew 的树状、队列状数据**只读地可视化**；② 用 Web Push 把 Crew 的"需要你"信号推到锁屏；③ triage 队列统一收纳 Crew 的待办。
5. **ZeroMux 自己的定时任务照旧保留**（有 cwd、有 E1 门，理由见既有 spec §11，这次调研没发现推翻的证据）。缺的是一个**只读**的 Crew cron 视图，加上 Crew cron 失败时的 push，不需要合并两套调度。
6. **优先级**：P0 = 放行 `chat_message` 帧 + 支持 crew/conductor 模式的建会话参数；P1 = Crew 子任务/subagent 面板 + conductor ledger 视图 + push 桥接；P2 = Crew cron 只读视图、workflow run 视图；P3 = pipeline 看板（依赖 GitHub label 队列，个人项目用得少）。
7. **Stage 4 不自建**：Crew 的 pipeline 模型是「conductor 读 label 队列 + worker 会话」，跟 ZeroMux 的会话模型正交。ZeroMux 能提供的价值只在观察和干预这一层。

---

## §1 Kiro Crew 能力清单（有证据）

### 1.1 文章里的五阶段模型

| 阶段 | 原文要点 | 来源 |
|---|---|---|
| 3 | "Memory made sessions start warm. A dashboard made multiple sessions easy to track. Cron and monitor loops started sessions without human help." | https://kiro.dev/blog/software-factory-1000-prs/ |
| 4 | "an assembly line of agent sessions for general work, where triage, implement, review, and merge each run as an independent stage with its own sessions and coordinate only through a message queue." | 同上 |
| 5 | "Every session still needs someone to define its goal, start it, watch for problems, judge its result, and decide what happens next." 五个职责：decompose, dispatch, patrol, accept, sequence；"The human keeps the goal." | 同上 |
| 规模 | "merged 1,000 pull requests in seven days" | 同上 |

`frontier-engineering` 和 `frontier-teams` 两页只讲原则（"architect, not typist"、"feed agents instead of babysitting"），**没有**实现细节（WebFetch 结果）。Crew 产品页 https://kiro.dev/crew/ 列出了 "Multi-session chat, memory explorer, cron manager, app store"。开源仓库：https://github.com/kirodotdev/KiroCrew（Apache-2.0）。

### 1.2 源码与路由里的真实能力

| 能力 | 机制 | 证据 |
|---|---|---|
| **Crew Mode（话题并行）** | slot `mode="crew"` 时，用户消息进持久队列 → 由单飞决策 LLM 输出 `route/spawn/hold/steer/ask/meta` → 每个话题是一个 `keep=True` 的可续 subagent → 结果以 `<<<SUMMARY>>>` 回投 | `KC/crew_chat.py:1-16`（设计说明），`:86-107`（决策 prompt 和动作 schema），`:47-49`（队列状态机 `pending→claimed→accepted→running→done/failed`），`:1535`、`:1716`（`keep=True`），`:239-240`（`queue.json` / `topics.json`），`:1747-1756`（`_render_topics`） |
| Crew Mode 的入口 | `PATCH /api/chat/slots/{slot}/mode`，允许值 `"" / orchestrator / crew`；建 slot 时 `mode` 可取 `"" / orchestrator / crew / design-critique` | `KC/dashboard/chat_folders.py:1453,1456`；`KC/dashboard/chat_handlers.py:2271,2389-2391`；分派在 `chat_handlers.py:643-660` |
| Crew Mode 的投递 | 结果通过 `broadcast_ws("chat_message", {slot, role, content, cls, meta, kind})` 下发，`kind ∈ crew_result/crew_ask/crew_meta/crew_ack` | `KC/crew_chat.py:1132-1183`，`:55` |
| **Goal Conductor（Stage 5）** | 内置 agent `kirocrew-conductor`：拆解目标 → 每个 work item 一个顶层会话（`session_create` + `session_send`）→ 用 `monitor_start` 巡逻 → 用 `accept_eval.py` 判定（`pr_checks` / `file` / `human_approval`）→ 决定下一轮 | `KC/agent.py:5168-5215`（系统 prompt），`KC/builtin_skills/goal-conductor/SKILL.md`（415 行；"Your four jobs"、Round 0 plan gate、Dispatch、Patrol、Two-phase acceptance），已安装在 `~/.kiro/agents/kirocrew-conductor.json` |
| **Pipeline Conductor（Stage 4）** | `kirocrew-pipeline-conductor`：一个仓库一条 pipeline，从 `work_source`（GitHub label）取队列 → 每个 item 一个 worker 会话 → 每轮用 `fleet_probe.py` 批量探测 → 独立验证 green → 按干预阶梯处理 → 按 credit 预算管控 | `KC/agent.py:5561-5620`，`KC/builtin_skills/pipeline-conductor/SKILL.md`（903 行，§"The pipeline spec" `:29-48`、"Pickup and dispatch" `:228`、"The probe cycle" `:478`），`scripts/{claim_preflight,fleet_probe,credit_spend}.py` |
| Issue Radar 的 pipeline 看板 | 阶段模型 `selected→claimed→investigating→implementing→awaiting-ci→addressing-review→awaiting-merge…`；三层只读视图 L0 pipeline / L1 step / L2 item | `KC/apps/builtins/issue_radar/backend/crew_store.py:85-102`；`pipeline_fold.py:1-30`；路由 `pipeline_routes.py:341-343`（`/api/apps/issue-radar/pipeline/{overview,step,item/sessions}`） |
| Conductor↔worker 共享账本 | `work_ledger.py`：Phase 1 只做存储，**没有路由也没有 UI**，写权限按字段拆分 | `KC/work_ledger.py:1-25` |
| Session ledger | 单会话的持久工作记录（goal / phase / next / artifacts），conductor 的 item 状态就存在这里 | `KC/docs/session-ledger.md`（"The ledger has **no dashboard page**"）；路由 `GET /api/session-ledger`（`KC/dashboard/server.py:1396`） |
| **Monitor loop / autonudge** | 在同一个会话里定时唤醒自己，带 cycle 上限（默认 24）和 wall-clock 预算；PR 结构化 watch 只在状态变化时唤醒 | `KC/docs/monitor-loops.md`；路由 `/api/autonudge*`、`/api/monitors*`（`KC/dashboard/server.py:1500-1511`） |
| **Subagent fan-out** | `spawn_run` / `spawn_sub_agents` / `spawn_continue` / `spawn_steer`；并发自动定档（3–32）；WS 事件 `subagent_{spawn,tool,chunk,stalled,retrying,recovering,done,queued,status}` | `KC/docs/subagents.md`；路由 `KC/dashboard/server.py:1379-1392`；事件 `KC/slack/gateway.py:8651-8720`（`base={"id","slot"}`），`:7249-7263`（`subagent_status`，带 `agents` 列表）；订阅 `KC/dashboard/ws.py:909`（`subscribe_subagents`） |
| **Dynamic workflows** | agent 编写 Python 编排脚本，原语是 `parallel`（barrier）和 `pipeline`（各阶段之间没有 barrier）；可以从某一步 rerun（前缀走缓存）；有定义库和 revision 管理 | `KC/workflows/dsl.py:1-25,99,119`；`KC/docs/workflows.md`；路由 `KC/dashboard/server.py:1554-1570`（`/api/workflows/{author,run,run_intent,definitions*,runs*}`）；WS `workflow_result_injected`（`KC/dashboard/workflow_inject.py:216`） |
| Task runner | 从 spec 拆解成 plan 再执行，带 checkpoint、LLM reviewer、失败沉淀为 lesson | `KC/task_planner.py:236`（`decompose`）；`KC/taskrunner.py:960`；路由 `KC/dashboard/routes/taskrunner.py:20-36` |
| **Cron** | `cron` / `every` / `at`，按 job 设时区、skip_dates、超时、jitter；script/command cron（不调 LLM）；`persistent_session`；`agent_sequence` 串行多 agent；连续失败自动暂停；有运行历史 | `KC/docs/cron-and-scheduling.md:58,99-104,145-159`；`KC/cron.py:654`（`agent_sequence`），`:862-880`；`KC/slack/gateway.py:4737-4739`；路由 `KC/dashboard/server.py:1398-1416` |
| **共享记忆** | preferences/projects markdown + semantic KV + episodic 向量 + lessons（可限定 `repo_scope`）+ 知识图谱 | `KC/docs/memory-and-learning.md:13-35,71-78`；路由 `KC/dashboard/routes/memory.py:40-51`；实测 `GET /api/memory/stats`：semantic_active=76，episodic_active=62 |
| Crew Members | 每个 member 有常驻 DM 线程（`mode="member"`），可以向自己的 worker 会话派活并巡逻 | `KC/members.py:180-185`；`KC/CHANGELOG.md:83-86,108-110`；路由 `KC/dashboard/routes/agents.py:53-56` |
| 仪表板 slot 元数据 | `GET /api/chat/slots` 每个 slot 带 `mode, orchestrating, queue_depth, pending_approval, waiting_for_input, needs_input, subagents_running, todo, folder_id, origin, created_by…` | 实测字段列表（2026-09-29 只读 GET） |
| 通知 | `/api/notifications*`（实测 33 条） | `KC/dashboard/routes/system.py:27-32` |

### 1.3 本机实测使用状况（只读 GET，2026-09-29）

| 端点 | 结果 | 含义 |
|---|---|---|
| `/api/crons` | 2 个 job（两个都是考研英语推送，微信渠道，`agent_sequence=[]`） | cron 在用，都是无仓库上下文的推送类任务 |
| `/api/crons/history` | 18 条 run | 有历史可以展示 |
| `/api/spawn` | 4 个 agent，全部是 `kirocrew-research`、`completed` | subagent 用过（Research Lab），既有 spec §7 里"用户一次都没 spawn 过"的前提**已经过时** |
| `/api/workflows/runs`、`/definitions` | 都是 0 | workflow 从没用过 |
| `/api/autonudge`、`/api/monitors` | 都是 0 | monitor loop 从没用过 |
| `/api/chat/slots` | 3 个，`mode` 全为空，`orchestrating=false` | Crew Mode / conductor **从没用过** |
| `/api/members` | 1 个 | — |
| `/api/approvals` | `[]` | — |

结论：**Stage 3 里的记忆和 cron 在用；Stage 4–5 目前零使用。** 这一点直接影响 §3 的优先级排序（「假设」：用户想用 Stage 5，但目前还没有入口，所以使用量是 0，不代表没有需求）。

---

## §2 ZeroMux 现有 Crew 接入

| 项 | 实现 | 证据 |
|---|---|---|
| 会话类型 | `SessionType::Crew` | `ZM/src/session_manager.rs:78,89` |
| 建会话 | `create_crew_session` → `CrewProcess::spawn`：`POST /api/chat/slots` 请求体**只有 `{"name": key}`**，然后 `POST .../project` | `ZM/src/session_manager.rs:1710`；`ZM/src/acp/crew_process.rs:319-325,586-638` |
| 发 prompt | `POST /api/chat {slot, message}`，放在独立 worker 里（因为这个调用会阻塞整轮） | `ZM/src/acp/crew_process.rs:360-363,430-447` |
| 停止 / 删除 | `POST .../stop`；Drop 时 `DELETE /api/chat/slots/{key}` | `ZM/src/acp/crew_process.rs:330,340,665-683` |
| WS 归一化 | 只处理 `chat_chunk / tool_call / tool_result / chat_status / chat_done / chat_error / approval / context_usage`；**其余全部丢弃**（包括 `chat_message`、`subagent_*`、`chat_thinking`、`queue_pop`、`workflow_result_injected`） | `ZM/src/acp/crew_process.rs:58-206`（丢弃分支在 `:202-206`） |
| 审批 | `SessionInput::Approval` → `POST /api/approvals/{id}/{action}`；前端内联卡片；triage 有 `approval` 类 | `ZM/src/session_manager.rs:163,4152`；`ZM/src/acp/crew_process.rs:335,562-567`；`ZM/frontend/src/lib/triage.ts:5,31` |
| 上下文用量 | `AcpEvent::ContextUsage` → FocusHeader 显示 `ctx N%` | `ZM/src/acp/crew_process.rs:191-200`；`ZM/frontend/src/components/shell/FocusHeader.tsx:47` |
| 记忆 | 代理 `/api/crew/memory*`（preferences / projects / semantic / lessons）；MemoryPanel overlay + composer 里的就地入口 | `ZM/src/web.rs:74-77`；`ZM/src/crew_memory.rs:115-137,186-280`；`ZM/frontend/src/components/MemoryPanel.tsx`；`ZM/frontend/src/components/AcpChatView.tsx:211-254,317` |
| 认证 | 每次请求都现读 secret → `GET /api/token/local?ttl=20h` → 通过 Cookie `mc_token_<port>` 访问 | `ZM/src/crew_memory.rs:75-96`；`ZM/src/acp/crew_process.rs:272-300` |
| 定时任务 | `scheduled_session_type` 对所有值都返回 Claude；`web.rs` 建任务时硬编码 `agent_type: "claude"` | `ZM/src/session_manager.rs:2639-2644,1424-1446`；`ZM/src/web.rs:3441,3484`；遗留项说明见 commit `7ff2883` |
| 前端外观 | CrewIcon / TypeIcon / ⌘K 类型 / QuickTargets / SendToMenu / 终端 `kirocrew chat` 快捷键 | `ZM/frontend/src/components/BrandIcons.tsx:47`；`shell/TypeIcon.tsx:10`；`shell/CommandPalette.tsx:25`；`lib/terminalInput.ts:94` |
| 刻意不做（既有 spec） | subagent/workflow 面板第一期不做；Crew cron UI "坚决不做"；不合并定时任务 | `ZM/docs/superpowers/specs/2026-09-13-kiro-crew-backend-design.md:457-471,855,870` |

---

## §3 差距表

工作量：S ≤ 1 天，M 2–4 天，L ≥ 1 周（「假设」：按单人、沿用现有 fan-out 和面板模式估算）。

| # | 能力 | Crew 有没有（证据） | ZeroMux 现状 | 缺什么 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|
| G1 | **Crew Mode 回答可见** | 有，`chat_message` 帧，`kind=crew_*`（`KC/crew_chat.py:1177-1183`） | 丢弃（`ZM/src/acp/crew_process.rs:202-206`） | 后端：`normalize_frame` 加 `chat_message` 分支，`role=assistant` 且 `meta.crew_reply` 或 `kind∈crew_*` 时映射成 text ContentBlock（需要非边界事件，**不能**当 `Result`，否则 turn 状态会错乱）。要注意普通模式下 `chat_message` 是否和 `chat_chunk` 重复（「假设」：普通模式下 `_post` 不会走 `chat_message`，需要抓帧验证） | **P0** | S |
| G2 | **以 crew / conductor 模式建会话** | 有，`POST /api/chat/slots {mode, agent}`（`chat_handlers.py:2271,2291,2389`）；`PATCH .../mode` | 请求体只有 `name`（`crew_process.rs:320`） | 后端：`create_slot` 透传 `mode`（`""/crew/orchestrator`）和 `agent`（如 `kirocrew-conductor`、`kirocrew-pipeline-conductor`）。前端：⌘K / 新建菜单里加「Crew · 并行话题」「Crew · 目标指挥」两个子选项 | **P0** | S |
| G3 | Crew Mode 的 turn 语义 | Crew Mode 下 `POST /api/chat` 立即 ack（`chat_handlers.py:643-660`，"acks instantly"），结果异步到达 | fan-out 假设一次 prompt 对应一个 `chat_done` 边界 | 后端：crew-mode 会话里 `Result` 边界的定义要改（「假设」：ack 后可能没有常规 `chat_done`）；busy 状态改为「有话题在跑」，数据源是 `GET /api/chat/slots` 里的 `queue_depth` / `subagents_running` | **P0**（和 G1 一起做） | M |
| G4 | **话题 / 子任务树面板** | 有，`topics.json` / `queue.json`（`crew_chat.py:239-240`）；`subagent_*` WS 帧带 `slot`（`gateway.py:8651-8720`）；`GET /api/spawn`、`GET /api/sessions/{id}/agents` | 没有 | 后端：代理 `GET /api/spawn` + `/api/sessions/{id}/agents`（只读，照 `crew_memory.rs` 的做法）；可选：`normalize_frame` 把 `subagent_status` 转成一个新的**非 transcript** 事件，推给面板刷新。前端：ContextPanel 加一个「子任务」tab。注意 topics 目前**没有 HTTP 路由**（grep `add_get.*topic` 零命中），只能通过 `meta` 文本或 spawn 列表间接拼出来 | **P1** | M |
| G5 | **Conductor 目标 / 账本视图**（decompose / dispatch / patrol / accept / sequence 的可视化） | 有，conductor 把 item 存在 session ledger `artifacts.item-<n>`（goal-conductor SKILL "Dispatch a round" 第 3 步）；`GET /api/session-ledger` | 没有 | 后端：代理 `GET /api/session-ledger?…`（参数格式需要验证，见 §6）。前端：「目标」卡片，列出 round、每个 item 的状态 / 验收条件 / 子会话链接 / verdict。conductor 创建的 child 会话在 Crew 侧是一等 slot，ZeroMux 需要能「打开 Crew 的外部 slot」（只读或接管） | **P1** | M–L |
| G6 | **观察 Crew 侧的外部 slot** | 有，`GET /api/chat/slots` 能列出所有 slot（含 cron、微信、conductor 的 child） | 只认自己建的 `zmx-*` slot | 后端：`CrewProcess::spawn(resume=Some(key))` 已经支持挂到已有 slot（`crew_process.rs:596-601`）；缺一个「列出 Crew slot → 附着」的入口。前端：triage 里加「Crew 外部会话」分组，或者在 ⌘K 里搜 | **P1** | M |
| G7 | **「需要你」信号推送** | 有，slot 字段 `pending_approval / waiting_for_input / needs_input`；`ask_question` 卡片；`/api/notifications` | 只推 ZeroMux 自己会话的审批和 turn_done | 后端：轮询 `/api/chat/slots`（或订阅全局 `slots` 帧），把非 zmx slot 的 needs_input 转成 `PushService::send_to_user(confirm)`。这正好是既有 spec 说的「只有 zeromux 能叫醒手机」 | **P1** | M |
| G8 | Monitor loop（patrol）状态 | 有，`/api/autonudge/slot/{slot_key}`、`/api/monitors/slot/{slot_key}`（`server.py:1503,1508`） | 没有 | 前端：FocusHeader 显示 🎯 `cycle 3/24 · 下次 2m`，数据只读。创建和停止交给 agent 自己（它会 `monitor_start`） | P2 | S |
| G9 | **Crew cron 只读视图 + 失败推送** | 有，`/api/crons`、`/api/crons/history`、`/{id}/history/{run_id}`（`server.py:1398-1416`）；实测 2 个 job、18 条 run | 没有，既有 spec 标了「坚决不做 UI」 | 建议**修正**既有 spec：不做编辑，只做**只读列表 + 最近运行 + 失败 push**。放进 ScheduledTasksPanel 的第二个分段（「ZeroMux 任务 / Crew 任务」），明确标注"由 Crew 调度" | P2 | S–M |
| G10 | ZeroMux 定时任务跑 Crew | —（ZeroMux 自身能力） | 未放行（`session_manager.rs:2639`，三个前置条件见 `7ff2883`） | 按 `7ff2883` 的三个前置条件移植 finalize 链路。**但如果 G2 已完成，可以让定时任务直接创建 `agent=kirocrew-conductor` 的会话**，这就是「定时触发的 Stage 5」 | P2 | M |
| G11 | Workflow run 视图 | 有，`/api/workflows/runs*`、`/definitions*`（`server.py:1554-1570`） | 没有 | 前端：只读 run 列表 + 阶段 / agent 状态；rerun-from-step 可以留到后面。实测 0 次使用 → **有真实使用之后再做** | P3 | M |
| G12 | Pipeline 看板（Stage 4） | 有，pipeline-conductor + Issue Radar `pipeline/{overview,step,item/sessions}` | 没有 | 前端：L0/L1/L2 三层看板。依赖 Issue Radar app 启用 + GitHub label 队列 | P3 | L |
| G13 | 记忆 `context-preview` 生效回执 | 有，`GET /api/memory/context-preview` | 没有（既有 spec §9.2 标为 P2） | 前端：turn 开始时显示"本轮注入 N 条记忆" | P3 | S |
| G14 | Task runner | 有（`routes/taskrunner.py`） | 没有 | 和 conductor 功能重叠，**不做** | — | — |
| G15 | Crew Members DM | 有（`/api/members*`） | 没有 | 个人单 member，价值低，**不做** | — | — |

---

## §4 Stage 3–5 分工建议

原则：**Crew 是编排引擎，ZeroMux 是驾驶舱。** ZeroMux 的四个结构性优势是：手机 PWA、Web Push、多后端（Claude/Codex/tmux 和 Crew 并列）、triage UI。Crew 的强项是协调器、队列、调度和记忆的**语义与持久化**。两边都有的能力，一律由 Crew 负责语义，ZeroMux 只负责展示。

| 阶段 / 能力 | 建议 | 理由 |
|---|---|---|
| **S3 共享记忆** | **交给 Crew**，ZeroMux 继续代理并展示（已完成）。给 Claude/Codex 做"跨后端共享记忆"时，也**读 Crew 的记忆**（比如启动时把 `GET /api/memory/context-preview` 的结果注入 Claude 的系统提示），不另建存储 | 记忆存储、向量、consolidation 在 Crew 侧已经成熟（`memory-and-learning.md`）；自建会造成两份真相（「假设」：context-preview 可以按 project 过滤，未验证） |
| **S3 仪表板** | **ZeroMux 自建**（triage 已有），并把 Crew slot 并入 triage（G6/G7） | 这正是 ZeroMux 的核心 UI 资产；Crew 自己的 dashboard 不是移动优先的 |
| **S3 定时任务** | **两套并存，不合并**：ZeroMux 调度 = 仓库内、需要 cwd 和 E1 门的任务；Crew cron = 推送 / 运维 / script 类任务。ZeroMux 只给 Crew cron 做**只读 + 失败推送**（G9） | 既有 spec §11 的两条硬理由（Crew cron 零 cwd、E1 门）仍然成立；实测 Crew 的 2 个 cron 都是微信推送，本来就不需要 cwd |
| **S3 工作流** | **交给 Crew**（dynamic workflows），ZeroMux 不自建 DSL。有使用之后再做只读 run 视图（G11） | `parallel` / `pipeline` 加从某步 rerun 的缓存机制，自建成本高，而且目前 0 使用 |
| **S4 Agent pipeline** | **交给 Crew**（pipeline-conductor + label 队列）。ZeroMux **不做**阶段队列；只在有真实 pipeline 时做看板（G12，P3） | 文章里的 Stage 4 靠"GitHub label 当队列"（`pipeline-conductor/SKILL.md:29-48`），ZeroMux 的 `QueueMode` 是单会话输入合并，语义完全不同，硬拉进来会混淆 |
| **S5 Crew Mode / Conductor** | **交给 Crew**：协调、判定、排序全部由 `kirocrew-conductor` 完成。**ZeroMux 自建三件事**：① 入口（G2）② 可视化（G1/G3/G4/G5）③ 叫醒（G7）。这三件是 Stage 5 下"人保留目标"时唯一需要的人机接口 | 文章："The human keeps the goal." 人在 Stage 5 只剩两件事：看进度、回答问题，恰好是 ZeroMux 的强项（triage + push + 手机） |
| ZeroMux 自己的 Claude 多会话编排（peer 消息、SendToMenu） | **维持现状，不往 conductor 方向发展** | 如果要在 Claude 后端上再造 decompose/patrol/accept，就是重复 Crew（「假设」：用户的 Stage 5 需求能用 Crew conductor 满足；如果坚持要用 Claude Code 做 worker，可以看 Crew 0.6 的"Pick the harness"——Claude Code 可以作为 Crew 会话的 harness，`KC/CHANGELOG.md:31-35`） |

**反向建议**：既有 spec §7 里"subagent / workflow 面板第一期不做"的理由有两条：①"树状数据塞进线性 transcript 必然错"——这一条仍然成立，所以要做成**独立面板**；②"`/api/spawn` 为空"——这一条已经被实测推翻（4 条）。建议把 G4 从"不做"改成 P1。

---

## §5 前端补充建议（映射到现有 shell 组件）

| 视图 | 挂载位置 | 数据源（全部只读，经 ZeroMux 后端代理） | 说明 |
|---|---|---|---|
| **新建菜单：Crew 子类型** | `shell/CommandPalette.tsx:25-26`（`TYPE_CHOICES`）加二级选项；`lib/paletteParse.ts:6` 加关键词 `crew:goal` / `crew:topics` | —（G2） | 三档：「Crew 聊天」（现有）、「Crew 并行话题」（mode=crew）、「Crew 目标指挥」（agent=kirocrew-conductor）。移动端不新增顶栏图标（既有 spec §9 规定 5 个图标是硬上限） |
| **ContextPanel「子任务」tab** | `shell/ContextPanel.tsx:9,33`：Crew 会话的 tabs 改为 `['git','files','runs','tasks']` | `/api/spawn`、`/api/sessions/{id}/agents`、`subagent_status` 帧 | 树状：话题 / subagent → 状态点（沿用 `toneOf`）→ 最后一句 summary → 「打开」按钮（如果是可附着的 slot，就 attach 成 ZeroMux 会话）。组件放进 `lazyPanels.ts`，不计入首屏 br 预算（`scripts/check-size.mjs`，≤330KB） |
| **目标卡片（Conductor）** | `AcpChatView` 顶部可折叠的 sticky 卡片，或者 ContextPanel「子任务」tab 的头部 | `/api/session-ledger`（G5） | 结构：Goal → Round N → items 表（item / 验收条件 kind / 状态 pass·fail·pending / 子会话）。conductor 的 `ask_question` 卡片走现有审批 / 确认卡片的形状（`ScheduledTasksPanel` 的 ConfirmationQueue） |
| **Triage 并入 Crew 外部 slot** | `lib/triage.ts:26-36`：`triage()` 对 Crew 外部 slot 生效；`shell/TriageList.tsx` 加「Crew」分组，或直接混排 | `/api/chat/slots` 的 `needs_input / pending_approval / running / last_activity_ts`（G6/G7） | conductor 创建的 child、cron slot、微信 slot 都进入同一个"需要你"队列，这是 Stage 5 下最有价值的一块 UI |
| **Patrol 徽章** | `shell/FocusHeader.tsx:47` 旁边，和 `ctx N%` 同一行 | `/api/autonudge/slot/{key}`（G8） | `🎯 3/24 · 2m`，点击展开说明，不提供编辑 |
| **Crew cron 只读分段** | `ScheduledTasksPanel.tsx` 顶部加 SegmentedControl：「ZeroMux / Crew」 | `/api/crons`、`/api/crons/history`（G9） | 列表显示名称、表达式 + 时区、上次状态、下次触发；点开看最近 run 的 summary。不提供编辑、启停和立即运行（这些是写接口，属于 Crew 的职责，避免两套调度语义） |
| Workflow run 列表 | 同样放在「子任务」tab 下的二级分段 | `/api/workflows/runs*`（G11） | P3，有使用之后再做 |
| Pipeline 看板 | 独立 overlay（和 MemoryPanel 同级） | Issue Radar `pipeline/*`（G12） | P3 |

所有视图都遵循 ZeroMux 已有的两条教训：① 异步加载一律加 reqRef 防止 stale 结果覆盖（memory 索引里 08-xx 系列的多次修复）；② Gateway token 每次现 mint，**不缓存** secret（`crew_memory.rs:72-80`）。

---

## §6 风险与未验证项

| # | 项 | 状态 |
|---|---|---|
| R1 | 普通模式下 `chat_message` 帧是否和 `chat_chunk` 重复（G1 放行时会不会重复渲染） | **已实测（2026-09-29，见 §7）：不重复。** 普通模式整轮只有 `chat_chunk`→`context_usage`→`chat_done`，**零个 `chat_message`**；`chat_message` 只在 crew mode 出现。G1 可以直接按 `kind∈crew_*` 放行 |
| R2 | Crew Mode 下 `POST /api/chat` 返回之后是否还会发常规的 `chat_done`，turn 边界具体怎么判定 | **已实测（见 §7）：没有 `chat_done`。** `POST /api/chat` 10ms 内返回 `{"ok":true,"crew":true}`，之后只有一串 `chat_message`（`crew_ack`→`crew_ask`/`crew_result`/`crew_meta`）。G3 工作量确定为 **M**：crew 会话不能用 `chat_done`/`Result` 当 turn 边界，busy 需改由 slot 状态驱动 |
| R3 | `GET /api/session-ledger` 的查询参数（按 slot key？） | 未验证：`_resolve_ledger_key`（`KC/dashboard/handlers/session_ledger.py:84`）从 request 解析 key，参数名没看 |
| R4 | conductor 的 child 会话能否被 ZeroMux 附着（`resume=Some(key)`），附着后 ZeroMux 的 Drop 会不会**误删**别人的 slot | **风险**：`CrewProcess::drop` 会无条件 `DELETE /api/chat/slots/{key}`（`crew_process.rs:665-683`）。附着外部 slot 之前**必须**加一个"只删自己创建的 slot"的标志，否则关一个标签页就会删掉 conductor 的 worker |
| R5 | topics 没有 HTTP 路由，话题树只能从 spawn 列表 + `meta` 文本拼出来 | 已确认：grep `add_get.*(crew|topic)` 零命中。话题的 title、status、held 队列拿不到结构化数据，只能读 `~/.kiro/crew/crew/<slot>/topics.json`（本机目前不存在，因为从没用过），或者等上游加路由 |
| R6 | Crew Mode 在 CHANGELOG 里标为 experimental，0.6 把 Crew 功能放到 Developer → Feature Previews 开关后面（`KC/CHANGELOG.md:805,112-115`） | **风险**：这是上游的不稳定 API，WS `kind` 字段、slot 字段可能改名。ZeroMux 适配层要保持**宽松解析 + 未知字段丢弃**（和现有 `normalize_frame` 的风格一致） |
| R7 | Feature Preview 开关只影响 UI 入口，还是也影响后端的 `mode=crew` | 未验证。`_CREATABLE_MODES` 里包含 crew（`chat_handlers.py:2271`），**假设**后端不受开关控制 |
| R8 | Conductor 执行 `accept_eval.py` / `ledger_entry.py` 每次都需要审批（SKILL "Known limits"） | 按范围约束这属于治理，不在范围内；但它会**实际产生**大量审批卡片。在 all-trust 下，可以在该 slot 上开 Trust（Crew 自己的开关）。ZeroMux 侧只需保证审批卡片能推送到手机（已有） |
| R9 | 工作量估算 | 全部是**假设**，没有做 spike |
| R10 | 既有 spec 里"Crew cron UI 坚决不做"和本文 G9 的冲突 | 本文只建议**只读**视图，不引入第二套调度语义，与 spec 的出发点（避免两套定时语义）一致。是否修订 spec 由用户决定 |

---

## 附：本次只读访问记录

- 本地文件：`~/.kiro/crew/{crons.json, cron-history/, autonudge.json, members/, apps/, open_slots.json, config.json（只看了 key 名）}`、`~/.kiro/agents/`、`KC/` 源码与 `KC/docs/*.md`、`KC/builtin_skills/{goal-conductor,pipeline-conductor}/SKILL.md`。
- Gateway GET：`/api/{crons, crons/history, workflows/runs, workflows/definitions, spawn, members, monitors, autonudge, taskrunner, chat/slots, memory/stats, approvals, chat/folders, sessions/usage, notifications}`，只输出了响应结构和计数，没有记录内容、secret 或 token。
- 没有做任何 POST/PUT/PATCH/DELETE；没有重启 Gateway；没有向任何 slot 发消息。


## §7 R1/R2 实测记录（2026-09-29）

经用户授权，在线上 Gateway（127.0.0.1:5476）建临时 slot `zmxprobeea36db` 抓 WS 帧，测完 `DELETE` → 200，再 `GET` → 404（已清理）。未碰现有 slot、cron、配置；未输出 secret/token。脚本与原始帧在 `/tmp/zmx-crew-probe/`（`probe.py`、`result.json`，临时目录）。

**普通模式（R1）**，prompt「Reply with exactly: NORMAL-OK」，只看含本 slot 的帧：

```
slots → activity_event(status 'Creating session…') → slots → activity_event(session) → mcp_report_update
→ activity_event(context) → chat_status → activity_event(status 'Thinking…') → slot_title → slots → heartbeat
→ chat_chunk 'NORMAL-OK' → context_usage → activity_event(stats 'Turn complete…') → slots → chat_done
```

结论：**`chat_message` 为 0 个**。放行 `chat_message` 不会在普通模式下重复渲染。

**Crew 模式（R2）**，`PATCH /api/chat/slots/{slot}/mode {"mode":"crew"}` → 200 `{"ok":true,"mode":"crew"}`；`POST /api/chat` → **10ms** 返回 200 `{"ok":true,"slot":…,"crew":true}`（立即 ack，符合 `chat_handlers.py:643-660`）。之后：

```
+0.0s  chat_message kind=crew_ack  role=assistant 'On it.'
+1.9s  slot_title / slots
+2.5s  chat_message kind=crew_ask  'Couldn't start that one — say the word and I'll retry.'   ×3（约 2s 一次）
+6.7s  chat_message kind=crew_meta 'I could not work out how to route this request after several attempts, …'
```

结论：
1. **没有 `chat_done`，也没有 `chat_chunk`**。crew 会话的全部可见输出都是 `chat_message`；turn 边界不能沿用 `chat_done`。
2. 本次决策 LLM 连续 3 次没能路由这条极简 prompt，最后以 `crew_meta` 收尾 —— 说明**失败/求助路径同样只走 `chat_message`**，G1 必须把 `crew_ask` / `crew_meta` 也显示出来（且 `crew_ask` 属于「需要你」，应进 triage / push，对应 G7）。
3. 路由失败本身不是 ZeroMux 的问题（假设：极简、无实际任务的 prompt 不适合 crew 路由）；若要验证 `crew_result` 的完整形态，需用一个真实小任务再测一次。

**对设计的影响**：
- G1：`normalize_frame` 新增 `chat_message` 分支，仅当 `kind` 以 `crew_` 开头时映射为**非边界** ContentBlock（text）；`crew_ack` 可降为灰色 System 提示。普通模式不受影响（R1）。
- G3：crew 会话的 busy / turn 结束改由 `GET /api/chat/slots/{slot}`（或 `slots` 帧）里的 `running` / 队列深度 / 运行中话题数驱动；`POST /api/chat` 的即时返回不能视为 turn 结束，也不能等 `chat_done`。工作量 **M**（已确定）。

### S5 SP 补测（2026-10-04）

经用户授权，建临时 slot `zmxprobe<6位>`（crew mode，真实小任务）与 `zmxprobe<6位>`（agent=kirocrew-conductor，普通模式），测完 DELETE → 200、GET → 404。secret/token 只在进程内存中，未输出、未落盘。脱敏帧存为 `src/acp/testdata/crew_frames_*.json`（slot 统一改写为 `zmxprobe`）。

- `CONDUCTOR_CHAT_DONE = yes`：复测时 slot B 的 agent 经列表接口回读为 `kirocrew-conductor`（发 prompt 前后各读一次，均为该值；mode 为 `""`），b_seq `activity_event(status) → activity_event(session) → mcp_report_update → activity_event(context) → chat_status → activity_event(status) → chat_chunk 'OK' → context_usage → activity_event(stats) → chat_done`（发 prompt 后约 4s 出 `chat_done`），两次运行一致；与 R1 普通模式同形，无 `chat_message`
- `CREATE_WITH_MODE = yes`：建 slot 时带 `mode:"crew"`（POST → 200），`GET /api/chat/slots` 列表回读该 slot `mode="crew"`（agent=`"default"`）。单 slot 的 `GET /api/chat/slots/{slot}` 不返回 mode/agent（键只有 `key/title/running/stopping/messages/queue/total/has_more/next_before`），须从列表回读
- `CREATE_WITH_AGENT = yes`：建 slot 时带 `agent:"kirocrew-conductor"`（POST → 200），列表回读 `agent="kirocrew-conductor"`、`mode=""`
- `crew_result` 字段：本次仍未出现（data 键 —；meta 键 —）。真实小任务「在当前目录创建 hello.txt 写入 hi，然后告诉我文件内容」同样以 `crew_ask`×3 → `crew_meta`（路由失败）收尾，`hello.txt` 未创建。夹具 `crew_frames_crew_result.json` 为**构造**（按 `crew_ask`/`crew_meta` 同形态：`content` + `meta.mid` + `meta.crew_reply`）；`crew_ack` / `crew_ask` / `crew_meta` / `normal_turn` 四个夹具为实测帧
- 附带发现：`context_usage` 实测字段为 `used_tokens` / `window_tokens` / `pct`，而 `normalize_frame` 读的是 `used` / `total|limit` → 当前 Crew 的 ctx% 恒不显示。不在 S5 范围，记入 deferred。

对 S5 的影响：`CONDUCTOR_CHAT_DONE = yes` → D1 前提成立，「目标指挥」chip 在 S5 开放（Task 10 取 `GOAL_ENABLED = true`）；`CREATE_WITH_MODE = yes` / `CREATE_WITH_AGENT = yes` → Task 7 的 `slot_create_body` 直接在建 slot 请求体里带 `mode` / `agent`，不需要事后 `PATCH …/mode`。crew 路由连续两次失败（R2 极简 prompt + 本次真实小任务）说明 Crew 决策路由本身在本机不稳，`crew_result` 形态仍需等真实使用中抓到后核对。
