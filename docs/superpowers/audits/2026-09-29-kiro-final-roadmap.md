# Kiro 五阶段 × ZeroMux 最终路线图（2026-09-29，汇总裁决）

参与方：CTO（初稿 → 审 PM → 终稿）、PM（初稿 → 审 CTO → 终稿）、zmx-ai-02ca59（Kiro Crew 源码与 Gateway 只读深挖）。
约束：个人项目、all-trust，**治理 / 权限 / 沙箱 / 审计不做**。本文只是调研结论，没有改代码。

材料索引（同目录）：`kiro-stage-inventory`（底稿）· `kiro-cto-draft` / `kiro-pm-draft` · `kiro-cto-reviews-pm` / `kiro-pm-reviews-cto` · `kiro-crew-gap-research` · `kiro-cto-final` / `kiro-pm-final`

## 0. 一句话定位

**Crew 是编排引擎，ZeroMux 是手机驾驶舱加叫醒器。**
- Stage 4–5 需要的 conductor、pipeline、workflow、cron、记忆，Crew 0.6 都已具备并已装在本机。ZeroMux 不自建协调器、DAG 或 backlog 表。
- ZeroMux 自建的只有一件事：让人**更快收到结果、更少被打扰、在手机上能干预**。
- 北极星指标：**等人时长**，即从 `last_outcome_ms` 到 `zmx_read.lastViewedMs` 的间隔。辅助指标：空转率。

## 1. 三方都认可的关键事实（已核实）

| 事实 | 证据 |
|---|---|
| 重启后「完成·未读」消失，原因是后端 `Posture` 只存在内存里（已读记录在 localStorage，并没有丢） | `session_manager.rs:3603-3607`、`triage.ts:22` |
| 定时 run 成功时根本不推送（门条件是 `active_run_id.is_none()`） | `session_manager.rs:2979` |
| 推送正文没有结论 | `push.rs:345` |
| Crew Mode 的结果被丢弃：`chat_message` 走进了兜底分支 | `crew_process.rs:202-206`；Crew 侧 `crew_chat.py:1177-1183` |
| 放行 `chat_message` 时**必须按 `kind∈crew_*` 白名单**，不能按 role 放行。普通模式下也会发 assistant 的 `chat_message`，按 role 放行会重复渲染 | `KC/state.py:2296-2348` |
| `create_slot` 只传 `name`，Gateway 实际支持 `mode` / `agent` | `crew_process.rs:320`、`chat_handlers.py:2271,2389` |
| Drop 会无条件删除 slot。一旦附着外部 slot，就会误删 conductor 的 worker | `crew_process.rs:665-683` |
| 文件写 API 是整文件覆盖，没有 append 模式 | `web.rs:2264` |
| `git worktree add` 同步调用，在 JuiceFS 上约 24s，会阻塞 tokio worker | `session_manager.rs:431-453` |
| 实测使用量：Crew cron 有 2 个 job、18 次 run（在用）；Crew Mode / conductor / workflow 都是 0 次 | 调研 §1.3 |

## 2. 裁决：CTO 与 PM 的剩余分歧

PM 终稿第 5 节列的分歧，大多数已经被 CTO 在「审 PM」一轮中主动让步（约定写入口接受方案 A，② 降到 P2，③ 降到 P1/P2，⑥ 撤回）。**真正还悬着的只有四条**，裁决如下：

| 分歧 | CTO | PM | 裁决 | 理由 |
|---|---|---|---|---|
| ④ shell 预检 | P1 | P0 | **S6 首项** | S5 已经有 9 个 S 级项；目前夜间任务少，省钱收益要等 Stage 4 起量才明显 |
| G2 Crew 入口 | P0 | P1 | **P0（和 G1 同期）** | PM 自己的「探针」逻辑就是 G1+G2 一起做：只修丢帧而没有入口，永远不会有用量 |
| ③ 串联 | P2 | P1 | **P2** | G2 完成后，「定时任务启动 conductor 会话」（G10）能覆盖多步流程，不必先自建链 |
| 本地待派发 | localStorage，P1 | P1 | **P1，localStorage 版** | 已经没有分歧，按 CTO 的最小形态做 |

另外采纳 PM 的**验证门槛**：G1 和 G2 上线两周内，conductor 或并行话题实际使用不少于 3 次，才投入 G4、G5、G6。

## 3. 最终路线图

### S5「收结果」+「Crew 探针」（P0，基本都是 S）
| # | 项 | Stage | 落点 | 要点 |
|---|---|---|---|---|
| F1 | 态势持久化 | 3 | 后端 `session_store` | 增加 3 列 `last_outcome / _ms / last_snippet`，在 `settle_posture` 里单独写入，`load_all` 时回填。不要搭 `upsert` 的车 |
| F2 | 推送带结论 + 定时 `run_done` | 3 | `push.rs` / `finalize_run` 成功分支 / `sw.js` level | 正文取 `last_snippet` 的前 120 个字；定时 run 附上 verdict |
| F3 | 离开期间卡 | 3 | Triage「需要你」的上方（首屏组件，体积很小） | 显示「离开 7h：完成 5 · 出错 1 · 待确认 2 · $3.1」，点击跳到对应行；依赖 F1 |
| F4 | 记为约定（方案 A） | 调优 | 消息气泡的 ⋯ 菜单 + composer 的「＋」 | 通过 SendToMenu 让当前会话自己把约定追加进 CLAUDE.md / AGENTS.md，不需要后端改动。如果发现不能可靠落盘，再做 O_APPEND 端点 |
| spike | R1/R2 抓帧 | — | 一次性测试 slot | 抓到的帧直接作为 `normalize_frame` 的单测夹具；R2 的结果决定 G3 是 S 还是 M |
| G1 | Crew Mode 结果可见 | 5 | `normalize_frame` | 只放行 `kind∈crew_*`，映射为非边界的 `ContentBlock`，不进入 `turn_text` |
| G2 | Crew 入口 | 5 | ⌘K 新建 → 选 Crew 后出二级 chip「聊天 / 并行话题 / 目标指挥」 | `create_slot` 透传 mode 和 agent 并持久化，保证 resume 后语义不变 |
| R4 | `owns_slot` | — | `CrewProcess::drop` | 只删除自己创建的 slot；不改变现有行为，是 G6 的硬前置 |

### S6（P1）
- **④ shell 预检**：在 tick 中 spawn，超时 60s，并设置 `kill_on_drop`。退出码为 0 时记为 skipped：不进入「需要你」，也不推送。gate 本身执行失败时记为 failed 并推送。连续 7 天都 skipped 时在离开卡里提示。表单提供「测试预检」按钮。
- **G3**：crew 模式下，ack 不算一个 turn。忙闲状态由 fan-out 内部每 30s 轮询 slot 的 `queue_depth / subagents_running` 得到。每个 `crew_result` 触发一次 turn_done 推送。
- **G7 + Crew cron 失败推送**：后台 tick 轮询 `/api/chat/slots` 和 `/api/crons/history`，走 confirm 推送的去抖。推送正文带上问题原文。
- **F7 摘要卡 review**：采纳（复用 human verdict 接口，并标记已读）、打回（预填 composer）、提交（走 SendToMenu）。文件 chip 能定位到单个文件，这一项拆成独立 task。
- **F8**：「立即运行」的 toast 带「打开会话」按钮（先确认 `run_now` 是否返回 session_id）。
- **F5 待派发（localStorage）**：放在 Triage 底部的折叠组；⌘K 里增加「存入 backlog」；在某一行点「派发」时，预填 ⌘K 的新建输入。
- **F6 批量派发**：前端串行调用 `POST /api/sessions`，每次间隔约 200ms；目标写进 description。**不做逐会话的 worktree 隔离。**
- **（过门槛后）统一「子会话折叠」模型**：父行第二行显示「↳ 5 项：3 运行 · 1 需要你」。需要你的 slot 子项单独进入「需要你」组（M12 排序不变）。PM Q1 里的 `parent_id` 折叠就是这个模型的特例。

### S7（P2）
- **G4 子任务 tab + G5 目标卡**：ContextPanel 新增 tab，懒加载；目标卡放在 tab 头部，手机上用底部 Sheet 展示。topics 没有 HTTP 路由，先从 spawn 和 `crew_meta` 拼出来。
- **G6 外部 slot 全量接入**：通过 ⌘K「接入 Crew 会话」，与「本机 tmux」同构。
- **G8** 巡检徽章 · **G9** Crew cron 只读分段 · **G10** 定时任务启动 conductor（替代 ③ 串联）
- **③** 串联（在 G10 仍不够用时再做）· **⑧/F11** Codex tokens 与成本（先实测通知格式）· **②** 定时任务支持 Codex
- F6 逐会话隔离（先把 worktree 创建改成 `spawn_blocking`，并串行化）· 跨设备已读同步

### 不做
`.zeromux/context.md` 注入（CLAUDE.md / AGENTS.md 已由各后端原生读取）· 全局 activity feed 和看板（与 Triage + 离开卡重复）· 自建 coordinator、`zeromux ctl`、`/prompt` 端点（Crew conductor 已覆盖）· 内置 backlog 表和 issue 同步（机器侧用 GitHub label + pipeline-conductor）· DAG 和 workflow DSL · G11 / G12（没人用之前不做）· G14 / G15 · LLM 二次摘要 · 多用户 · 治理、权限、沙箱、审计。

## 4. 与在途工作的衔接
- S4（终端）进行期间，F 系列不改动 TerminalView 和键栏。F1、F2 是纯后端改动，可以和 S4 并行；F3、F4 以及 Crew 前端部分，等 S4 上线稳定 2 天以上再做。
- 延续已有决议：不新增顶层导航；新建只走 ⌘K（R22）；卡片内不嵌回复；M12 排序不改。所有新面板都放进 `lazyPanels`，每个 task 都跑 `check-size`（首屏 br ≤ 330KB）。
- 需要修订的旧文档：`docs/teamwork_enhanced_tasks.md` 删掉 context.md 一项，把已完成的项打勾；Crew backend spec §7（subagent 面板「不做」）以及「Crew cron UI 坚决不做」两处，改为按本文的 G4 / G9 处理；CLAUDE.md 里关于 Notes 的描述已经过时（后端已删除，commit 54be804）。
