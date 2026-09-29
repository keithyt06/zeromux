# S6（P1）预检 · Crew 话题语义与叫醒 · review · 派发 —— 设计

日期：2026-09-29
状态：v2（按 `audits/2026-09-29-spec-review-decisions.md` 裁决修订；CTO/PM review 全部采纳）
基线：`main` @ `33c2236`
上游（优先级从高到低）：
- `docs/superpowers/audits/2026-09-29-spec-review-decisions.md`（下称「裁决」）——v2 最高优先
- 同目录 `spec-review-cto.md`（下称 CTO-R）、`spec-review-pm.md`（下称 PM-R）
- `docs/superpowers/audits/2026-09-29-kiro-final-roadmap.md`（下称「路线图」）§3 S6
- 同目录 `kiro-cto-final`、`kiro-pm-final`、`kiro-pm-reviews-cto`（Q1/Q2）、`kiro-cto-reviews-pm`（专项 3）、`kiro-cto-draft`（④）、`kiro-crew-gap-research`（G3/G6/G7/G9、R2/R4，**§7 R1/R2 实测**）
- 前端总 spec `2026-09-26-frontend-triage-focus-redesign-design.md`（R22、M12 等编号）与 `2026-09-27-focus-session-experience-design.md`
- 兄弟 spec：S5 `2026-09-29-s5-feed-and-crew-probe-design.md`（本文只按裁决的统一约定引用，不改它）、S7 `2026-09-29-s7-crew-cockpit-and-backend-parity-design.md`（§5 G9、§10 跨设备已读已按裁决搬入本文 §13、§12）

本文所有 file:line 都由作者在 `33c2236` 上亲自 Read 核实（v2 新增引用同样逐条复核）；Crew 侧路径 `KC/` = `~/.kiro/crew-venv/lib/python3.12/site-packages/kiro_crew/`（kirocrew 0.6.0）。

---

## v2 修订

章节号沿用 v1（S7 与 review 文档按节号引用本文），新增内容放在 §12–§15。

| # | 修订内容 | 来源 | 影响章节 |
|---|---|---|---|
| V1 | Crew 持久化字段改为 S5 定义的三列 `crew_mode`（Gateway 原值 `""\|crew`）、`crew_agent`（原值）、`crew_origin`（`zeromux\|external`）。话题模式 = `crew_mode=="crew"`；三档展示（聊天 / 并行话题 / 目标指挥）由前端派生；`owns_slot = crew_origin != external`，不再从 `resume.is_none()` 推断 | 裁决·统一约定 1；CTO-R M2、M3 | §0.1、§3.2、§3.5、§3.6、§3.7、§9.2 |
| V2 | 态势持久化统一走 S5 定义的 `persist_posture(sid)`；S6 在 `settle_crew_answer` 的三个分支（含 crew_ask）以及「用户回答后清除 awaiting_input」处都调用它；F1 的列包含 `awaiting_input` | 裁决·统一约定 2；CTO-R M5；PM-R m5 | §0.1、§3.2、§3.5、§3.8 |
| V3 | 门槛 T 只保留 S7 §0.1 的 journalctl `zmx_usage` 口径；计时起点改为 S6 T3 上线日（两个 chip 都可用）；14 天内 ≥3 次且分布在 ≥2 个不同日期；G9 不受 T 约束 | 裁决·统一约定 3；CTO-R M7；PM-R B3 | §9.1 |
| V4 | 新增 T0「服务端已读 + 等人时长埋点」：`POST /api/sessions/{id}/read`（自 S7 §10 搬入并调整），写入时打 `zmx_usage wait_ms=…`；本期第一个上线 | 裁决·统一约定 4；PM-R B1、M5 | §1、新 §12、§14 |
| V5 | 新增「成功指标」一节 | 裁决·统一约定 4；PM-R B1 | 新 §14 |
| V6 | 话题模式的忙闲不再走 `mark_turn`（`apply_turn` 的 Idle 分支要求 seq 相等，`session_manager.rs:614`，会把 turn 永久卡在 Running），改为新增 `set_crew_busy(sid, bool)`：只写 `rp.turn_state`，不带 seq，不 bump `last_activity_ms`，不清 `approval_ids`；补单测 | 裁决·S6 B1；CTO-R B1 | §3.2、§3.4、§3.8 |
| V7 | topics 会话里前端的 `content_block` 与 `result` 都不改 busy，busy 只由 `crew_busy` 与 `replay_done` 驱动；补 hook 单测 | 裁决·S6 M4；CTO-R M4 | §3.6、§3.8 |
| V8 | 重连 / 重生时 GET slot 的 `messages`，用 `meta.mid` 补发断连期间的回答。**核实修正**：① Gateway 持久化行不带 `kind`（`KC/crew_chat.py:1150-1163`：kind 只在 WS 帧上，持久化标记是 `meta.crew_reply=true`），补发行只能按「回答」处理；② zeromux 的 scrollback 只在内存，重启后为空（`session_manager.rs:2339` `load_persisted` 置 `VecDeque::new()`），且 ContentBlock 不带 mid，「从 scrollback 重建 seen」在重启场景不可行——改为在 `sessions` 表持久化游标 `crew_last_mid`；同进程内的 Gateway 重连本来就保留 `NormState`（`crew_process.rs:457` 在重连循环外创建）；③ 会话只在 WS 连接时 `ensure_running`（`acp/ws_handler.rs:73`），重启后没人打开的话题会话收不到任何回答——由 crew_watch 首轮主动拉起 `crew_mode=crew` 的会话 | 裁决·S6 M6；CTO-R M6；v2 作者核实 | §3.2、新 §3.9、§3.8、§11 |
| V9 | D1 退出码反转：**0 = 唤醒，1 = 跳过，其他一律算预检故障** | 裁决·S6 B2；PM-R B2 | §0.2 D1、§2.3、§2.6、§2.8 |
| V10 | `upsert_config` 的 ON CONFLICT SET 加 `gate_cmd`、`gate_since_ms`（现状 SET 列表见 `scheduled_tasks.rs:481`），`query_configs` 的 SELECT（`:497`）与按下标取列（`:499-504`）同步 | 裁决·S6 M1；CTO-R M1 | §2.1、§2.2 |
| V11 | 外部 slot 推送正文写明「在 Crew/微信回答」；Crew cron 失败推送带深链 `?panel=scheduled&seg=crew`；推送 payload 增加可选 `url`；**G9 从 S7 挪到 S6，与 T4 同期** | 裁决·S6 PM M1；PM-R M1 | §0.2 D9/D11、§4.2、§4.3、新 §13 |
| V12 | 「采纳」改为 ✓ 后直接打开「提交…」（仅当 files>0）；404 静默；去掉「提交…」上的 `confirmDanger`（与 `GitViewer.tsx:382-388` 一致：只有撤销带确认） | 裁决·S6 PM M2；PM-R M2 | §0.2 D13、§5.2、§5.3 |
| V13 | TriageRow 第一行名称后加「目标」文字徽标（描述以「目标：」开头时显示，最多 8 字）；`same()` 已比较 `description`（`TriageRow.tsx:130`），徽标由它派生，因此天然纳入 `same()`，补单测锁定 | 裁决·S6 PM M3；PM-R M3 | §8.2、§8.3 |
| V14 | 待派发改为**服务端单表**（仿 `quick_targets.rs`），实现跨设备；删除 localStorage 方案与「不做跨设备」非目标 | 裁决·S6 PM M4（选 B） | §0.2 D15/D20、§0.3、§7 |
| V15 | gate 超时 `kill(-pgid)` 后 `child.wait().await` 回收 `sh`，避免僵尸 | 裁决·CTO m1 | §2.3、§2.8 |
| V16 | Wake 之前 `get_config` 复核任务仍存在且 enabled（`delete_config` 会删 run 行，`scheduled_tasks.rs:527-528`） | 裁决·CTO m2 | §2.3、§2.8 |
| V17 | 「7 天未唤醒」整节挪到 S7；S6 只保留 `gate_clean` 的 run 行展示；删去 `last_woken_ms` 列与 `mark_woken`（S7 自行加），保留 `gate_since_ms`（V10 要求写入，供 S7 使用） | 裁决·CTO m3 | §0.1、§0.2 D4、§2.2、§2.4、§2.6、§2.8 |
| V18 | G7b：`record_and_broadcast` 返回「本次是否新增了 approval id」，fan-out 据此推送；ask 与 approval 的去抖按 kind 分 key；G7b 标注为「范围新增」 | 裁决·CTO m4、PM m3 | §3.3、§4.2 |
| V19 | 父子快照只有 crew_watch 一个 owner 写入；**新增只读访问器 `CrewWatch::snapshot() -> Arc<SlotsSnapshot>`** 并定义字段（slots、`created_by`、`needs_input`、`pending_approval`、刷新时间等），供 S7 代理层只读复用 | 裁决·CTO m5；协调方补充要求（S7 v2 删除 SlotsCache） | §4.2、§9.2 |
| V20 | 补测试：`reconcile_orphans` 在 `gate_phase=1 && side_effects=0` 时的状态；Wake 后 `gate_phase` 已清 0 再崩溃按 orphaned 处理；`input_snapshot` 含预检输出且 replay 不跑 gate | 裁决·CTO m8 | §2.8 |
| V21 | 待派发 N>0 时默认展开；离开卡最多 3 行，其余收进「更多」；话题会话忙时第二行显示「话题运行中」；写入 S5–S7 首屏累计预算 | 裁决·PM m1、m2、m4、m7 | §1、§3.6、§4.3、§7.2 |
| V22 | 分期与 task 列表重排：T0 最先；T4 与 G9（T4b）同期；每期一个 plan | 本次修订 | §1、新 §15 |

---

## 0. 决策记录

### 0.1 S5 依赖（硬前置）

字段命名按裁决「跨 spec 统一约定」：S5 定义、S6 引用。

| S5 项 | S6 中谁依赖它 | 依赖内容 | S5 未交付时的后果 |
|---|---|---|---|
| F1 态势持久化 | G3、④、T0 | `persist_posture(sid)`：把 `last_outcome/_ms/last_snippet/awaiting_input` 写入 `sessions` 表，并在 `load_all` 回填。S5 定义函数，S6 在 §3.2 的 crew 路径上调用 | G3 的「完成·未读」「待回答」、④ 的推送结论、T0 的 `wait_ms` 基准在重启后全部消失 |
| F2 推送带结论 | G3、G7、④ | `payload_for` 增加 `body: Option<&str>` 参数（S5 引入） | G3/G7 推送正文无法带原文；本文假设该参数已存在 |
| F3 离开期间卡 | G7 | 首屏卡片组件及其数据位 | G7「外部 Crew 待回答」行无处显示 |
| G1 Crew Mode 结果可见 | G3 | `normalize_frame` 的 `chat_message` 分支（仅 `kind∈crew_*`，非边界 `ContentBlock{summary=kind}`） | G3 直接在 G1 分支上扩展 |
| G2 Crew 入口 | G3、折叠、T0 | `create_slot` 透传 `mode/agent`；`sessions` 表三列 `crew_mode`（`""\|crew`）、`crew_agent`（原值）、`crew_origin`（`zeromux\|external`）；`zmx_usage` 的 `crew_create` / `crew_first_prompt` 埋点 | G3 无法得知会话处于话题模式；门槛 T 无数据源 |
| R4 `owns_slot` | 折叠（及 S7 的 G6） | `owns_slot = crew_origin != external`（**不从 `resume.is_none()` 推断**：自建 slot 重启后同样走 `resume=Some(k)`，`crew_process.rs:596`）；`CrewProcess::drop` 只删自建 slot | 本期折叠只读外部 slot，不附着，所以只是软依赖 |
| spike R1/R2 | G3 | 已完成（调研 §7） | — |

S6 只**消费**这三列，不新增 Crew 模式列。话题模式的判定一律是 `crew_mode == "crew"`；「目标指挥」= `crew_mode == "" && crew_agent == "kirocrew-conductor"`，由前端派生展示用的三档。

**额外约束（本文新增，修订 S5）**：G2 的三个 chip 中，「并行话题」（`mode=crew`）**必须与 G3 同期上线**，S5 只交付「聊天 / 目标指挥」。理由见 §3.1：没有 G3 时，话题会话在 30 分钟后会被交互看门狗 `TimeoutKill`，导致 WS 关闭；会话一旦被删除，`Drop` 就会连同 slot 一起删掉（`crew_process.rs:663-685`）。「目标指挥」是 `agent=kirocrew-conductor` 的普通模式 slot，仍然有 `chat_done`，不受影响。**因此 T3 上线日就是门槛 T 的计时起点**（§9.1）。

### 0.2 已拍板的 taste 问题

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| D1 | 预检退出码语义 | **v2 反转**：**exit 0 = 条件成立 → 唤醒 agent**；**exit 1 = 无事可做 → skipped**；**其他一律 = 预检故障 → failed + 推送**（含 2..=125、126/127、被信号杀、超时、无法 spawn） | 与 shell 惯用写法一致：`jq -e 'length>0'`、`grep -q`、`test` 都是「条件成立 = 0」；路线图里唯一的机器侧配方 `gh issue list … \| jq -e 'length>0'` 在有活干时 exit 0（PM-R B2）。只把 1 当「跳过」，其他非 0 当故障：写错命令（126/127）、`jq` 解析失败（exit 2/5）都会被报出，而不是被静默当成「有事」或「没事」。上线前改，零迁移成本 |
| D2 | 「立即运行」与「重放」要不要跑预检 | **都不跑** | 用户主动触发就是想跑；重放要求忠实复现，快照里已经包含当时的 gate 输出 |
| D3 | gate 输出要不要注入 prompt | **要**：stdout 尾部 4KB 作为「## 预检输出」段追加到 prompt 末尾，并随 `input_snapshot` 落盘 | 这就是 Kiro「最小上下文唤醒」的本意，成本只有一行拼接 |
| D4 | 「7 天未唤醒」 | **v2：挪到 S7**（CTO-R m3）。S6 只在 run 历史里显示 `gate_clean` 行（「预检未满足，未唤醒」）；`gate_since_ms` 仍按 §2.2 写入，供 S7 判定使用 | 需要两列 + confirmations 捎带 + 卡片提示，对 S6 是过度设计；run 行已经让用户能看到「预检一直没触发」 |
| D5 | crew_meta 的 outcome | **Completed**（有回答，进完成·未读，推 turn_done），**不清除**「待回答」标记 | crew_meta 有两种来源：话题列表（`KC/crew_chat.py:1625-1628`）和路由失败（`:1405-1411`，「nothing was started」）。二者在帧上无法区分，按英文文本做启发式判断很脆弱。路由失败时 Crew 会把队列项保留为 pending（`:1400-1404`），用户看到推送原文就知道需要改写后重发 |
| D6 | crew_ask 在分诊里如何表达 | 新增 Attention `ask`（「待回答」），**与 `approval` 同档**（PRIORITY=1），M12 的相对顺序不变 | 复用 `approval` 会显示「待审批」并出现批准/拒绝按钮，语义不对；另开一档又会改动 M12 |
| D7 | 话题会话（`crew_mode=crew`）要不要受交互看门狗、stuck、auto-update 门约束 | **都不受** | 话题在 Gateway 进程内作为 subagent 运行，不在 zeromux cgroup 内；在我们这边 kill 只会关掉 WS 并删除 slot。忙闲以 Gateway 为准，由 Crew 自己做 stall 检测（`subagent_stalled`） |
| D8 | G7 推送给谁 | legacy 模式推给 `legacy`；OAuth 模式推给所有 `role=admin` 的用户 | 外部 slot 在 zeromux 里没有 owner；单用户部署下 admin 就是本人 |
| D9 | G7 外部 slot 要不要进分诊行 | **本期不进**，只推送 + 离开卡一行；**v2：推送正文末尾写明「在 Crew/微信回答」**，点击打开首页并展开离开卡的 Crew 行 | 行点进去需要附着（G6，S7）；放一个点不开的行比不放更糟（`crew_process.rs:176-177`）。但推送必须说清楚去哪里回答，否则同样是「点了没用」（PM-R M1） |
| D10 | G7/Crew cron 轮询放在哪里 | **独立的 `crew_watch` 后台任务**，不放进调度 tick；它也是 Gateway slot 快照的**唯一 owner**，G9 与 S7 代理层只读它（§4.2 `snapshot()`） | 调度 tick 的教训：tick 内任何对外 `.await` 都可能冻死心跳、看门狗和任务触发（`scheduled_tasks.rs:1068-1080`、`:1148-1153`）。Gateway 是另一个进程，延迟不受我们控制。单 owner 避免两个 5s 缓存各自漂移（CTO-R m5） |
| D11 | Crew cron 失败在重启后的补推 | **不补推**：启动后第一轮只做静默播种 | 一天多次部署，补推会造成重复；失败记录可在 G9 只读分段查看（**v2：G9 已在本期 §13**） |
| D12 | F7 review 动作挂在哪些卡上 | **仅会话最后一个已完成且未出错的 turn** | 历史卡上放动作按钮会形成视觉噪音；review 的对象就是最新结果 |
| D13 | F7「采纳」做什么 | **v2：「采纳」= 卡片显示 ✓，并在 `files.length>0` 时直接打开「提交…」菜单**；human verdict `good` 仅 best-effort 写入，404 或找不到 run 时**静默**，不弹 toast | verdict 只在内存（§5.1），夜里 auto-update 后早上 review 必然 404，原方案会高频弹「未记录」（PM-R M2）。「采纳」的真实下一步是提交；手机上 review 一轮 = 2 击。已读不需另做（Focus 区就是 `activeId`，`useShellState.ts:94-105`） |
| D14 | F6 如何遵守 R22 | 批量派发**在 ⌘K 内完成**：待派发组多选 →「并行派发 N 项」→ 打开 ⌘K 新建模式的批量预览 → 在 ⌘K 内确认并串行创建 | R22 要求新建会话只有 ⌘K 一个实现 |
| D15 | 待派发存什么 | 存**解析后**的 `{type, dir(绝对路径), prompt}` 以及原始文本；派发时预填 `${type} ${dir} ${prompt}` | 模糊目录只在 ⌘K 当下可解析；存原文会在派发时解析到别的目录 |
| D16 | zeromux 会话要不要加 `parent_id` | **不加** | ⑥（自建协调器 / `ctl`）已撤回，S6 中没有任何 zeromux 原生的「父会话创建子会话」路径；F6 批量派发没有父会话。父子关系唯一的真实来源是 Crew 的 `created_by` |
| D17 | 折叠在 G6 之前的形态 | 只做「摘要态」：父行第二行显示 `↳ N 项:a 运行 · b 需要你`；只要有子项需要你，**父行**就进入「需要你」（attention `ask`），第二行写「来自 ↳〈子项标题〉」。逐子项单独成行，要等 S7 的 G6 | 子 slot 不附着就无法打开；父行是 conductor，在那里回答是 Kiro 的原生流程 |
| D18 | 「测试预检」要不要限流 | 不限流，前端在请求进行中禁用按钮 | all-trust，单用户 |
| D19 | gate 超时后的清理 | `process_group(0)` + 超时后 `kill(-pgid, SIGKILL)`，**随后 `child.wait().await` 回收 `sh`**，再加 `kill_on_drop(true)` 兜底 | `kill_on_drop` 只会杀 `sh`，管道里的孙进程（`gh`、`jq`）会残留在 zeromux cgroup 中；不 wait 会留僵尸（CTO-R m1）。`libc` 已经是依赖（`Cargo.toml:48`） |
| D20 | 待派发存哪里 | **v2：服务端单表 `backlog_items`**（与 `quick_targets` 同库、同风格：`Mutex<Connection>`、owner-scoped 读写、DELETE 用 query param）。localStorage 方案作废 | 用户手机与 Mac 用得差不多，J2 主路径就是「手机记、桌面派」；工作量 S（裁决 PM M4 选 B） |
| D21 | 服务端已读由谁写 | **只有 owner 写入生效**，`read_ms` 只增不减（`MAX`）；前端取 `max(local, server)` | 自 S7 D11 搬入：单调合并天然解决多设备、多 tab 竞态，不需要版本号；admin 看别人的会话不替 owner 标已读 |

### 0.3 明确非目标

治理、权限、审计、沙箱（gate 以 zeromux 用户身份执行，不做隔离）；human verdict 持久化（见 §5.1 现状）；「7 天未唤醒」（挪 S7）；Crew cron 的编辑、启停和立即运行（G9 完全只读）；话题 / subagent 树（G4）；附着外部 slot（G6）；定时任务支持 Codex/Crew（②）；F6 逐会话 worktree 隔离；新增顶层导航；在客户端做「等人时长」统计（一律服务端 `zmx_usage`）。

---

## 1. 范围与分期

| # | 项 | 后端 | 前端 | 规模 |
|---|---|---|---|---|
| T0 | 服务端已读 + 等人时长埋点（§12） | `session_store.rs`、`session_manager.rs`、`web.rs` | `lib/readState.ts`、`useShellState` | S |
| T1 | ④ shell 预检 | `scheduled_tasks.rs`、`web.rs`、`push.rs` | `ScheduledTasksPanel`（lazy） | M |
| T2 | F8 立即运行后打开会话 | 无 | `ScheduledTasksPanel`、`useShellState` | S |
| T3 | G3 话题模式 turn 语义 + 补发 | `crew_process.rs`、`session_manager.rs`、`session_store.rs`、`push.rs` | `useAcpSocket`、`triage.ts`、`TriageRow` | M |
| T4 | G7 + Crew cron 失败推送 + `snapshot()` | 新 `crew_watch.rs`、`push.rs`、`main.rs`、`web.rs` | 离开卡一行、`sw.js` 深链 | M |
| T4b | G9 Crew cron 只读分段（§13，不受 T 约束） | `crew_watch.rs`（只读访问器）、`web.rs` | `ScheduledTasksPanel` 内 lazy `CrewCronList` | S |
| T5 | F7 摘要卡 review 动作 | 无 | `TurnSummaryCard`、`TurnView`、`AcpChatView` | S |
| T6 | F7b 文件 chip 定位单文件 | 无 | `GitViewer`、`ContextPanel`、`AppShell` | S |
| T7 | F5 待派发（服务端单表） | 新 `backlog.rs`、`main.rs`、`web.rs` | `lib/api/backlog.ts`、`TriageList`、`CommandPalette` | S |
| T8 | F6 批量派发 + 目标徽标 | 无 | `CommandPalette`、`TriageRow` | S |
| T9 | （过门槛后）子会话折叠 | `crew_watch.rs`（快照派生）、`SessionInfo` | `triage.ts`、`TriageRow` | M |

顺序：**T0 最先**（它是 §14 的基线数据源，越早上线基线越长）→ T1 → T2 → T3（与 G2「并行话题」chip 一起发布，当天即门槛 T 的起点）→ T4 与 T4b 同期（共用 crew_watch 的数据源）→ T5 → T6 → T7 → T8；T9 只在 §9.1 的门槛满足后才进入计划。T1/T2/T5–T8 与 T3/T4 之间没有代码依赖，可以并行；T8 依赖 T7。分期见 §15。

**每个 task 都要跑** `cargo test`、`npm test`、`npm run build`（`frontend/package.json:8`：`check-size.mjs dist 337920`，即首屏 br ≤ 330KB）和 `npm run lint`。新增面板一律放进 `components/shell/lazyPanels.ts` 或面板内局部 `lazy()`；本期没有新顶层面板，`CrewCronList` 是 `ScheduledTasksPanel` 内的局部 lazy 子组件。

**首屏体积预算（S5–S7 累计，V21）**：基线 `33c2236` 首屏 314.0KB br（本机 `node scripts/check-size.mjs dist 337920` 实测），余量约 16KB；memory 里约 10KB 的说法以实测为准，但仍按保守口径分配：

| spec | 首屏增量上限（br） | 说明 |
|---|---|---|
| S5 | 以 S5 spec 为准（F3 离开卡为主） | 本文不替 S5 定数 |
| S6 | **≤ 3KB** | T0 ≤0.5KB、T3 ≤0.5KB、T4 ≤0.3KB、T5 ≤0.5KB、T7 ≤0.8KB、T8 目标徽标 ≤0.2KB；T1/T4b 在 lazy chunk 内不计 |
| S7 | 以 S7 §13 K5 为准（约 2.6KB） | — |

任何一期合并后如果首屏累计余量 < 5KB，下一期先做懒加载再加功能。

---

## 2. ④ shell 预检（T1）

### 2.1 现状（已核实）

- `TaskConfig` 没有 gate 字段（`scheduled_tasks.rs:380-399`）；迁移只能用幂等 `ALTER` 并吞掉 duplicate-column 错误（`:444-462`）。
- `upsert_config` 的 INSERT 列出全部 15 列，但 **ON CONFLICT 的 SET 只有 `name,trigger_spec,work_dir,prompt,enabled,retention_n,side_effects,max_runtime_min,idle_timeout_min`**（`:481`）——新增列如果不进 SET，update 永远写不进去（CTO-R M1）。`query_configs` 的 SELECT 是字符串拼接的固定列（`:497`），按下标取列（`:499-504`）。前端 `handleToggle` 通过 PUT 做全量 upsert，漏传字段就会被 NULL 掉，历史上已经出过一次（`ScheduledTasksPanel.tsx:98-100` 的 B1 注释）。
- 调度 tick：claim → `claim_won` → **在 tick 内直接 `.await m.trigger_run(...)`**（`:1190-1197`）。overlap 输家记为 `skipped/overlap`，只写 state、不推送（`:1199-1201`，与 PM Q2 相符）。
- tick 冻死的教训：`spawn_timeout_kill` 的注释（`:1068-1080`，review 2026-07-29 F-SCHED-TIMEOUT-BLOCK）和 stuck 推送的 fire-and-forget（`:1148-1155`）。
- `set_run_state` 只在 `state IN ('claimed','running')` 时生效（`:551`），并且 `failure_kind` 用 COALESCE，一旦写入就无法用 NULL 清掉（`:550`）。
- `get_config(id)` 存在（`:508-510`）；`delete_config` 会先删 `agent_task_runs` 再删 config（`:527-528`）。
- 启动时 `reconcile_orphans(None)`（`main.rs:571`）会把所有 claimed/running 行无条件改为 `aborted/orphaned_restart`（`:702-704`）；side_effects 任务的这类行会进入确认队列（`:807-821` 的过滤条件是 `failure_kind IN ('watchdog_timeout','orphaned_restart','idle_timeout')`）。
- `active_run_count` 统计 claimed/running 行，它是 auto-update E1 门的依据（`:620-635`）。
- `trigger_run` 在 spawn 前用 `work_dir_under_home` 重新校验目录（`session_manager.rs:1403-1418`，该函数是私有函数，定义在 `:492`），并在 prompt 后追加 VERDICT 标记（`:1465-1468`）。
- 前端：`runReason` 只为 aborted 细分原因（`ScheduledTasksPanel.tsx:56-63`），`skipped` 统一显示为「跳过」（`:42`）。
- 路由：`/api/scheduled-tasks*` 定义在 `web.rs:64-70`；建任务时 `agent_type` 硬编码为 `"claude"`（`web.rs:3441`、`:3484`），与预检无关，保持不动（S7 ② 负责）。

### 2.2 数据模型

新增两列 config、一列 run（写进 `:448-455` 的 `ALTER` 列表）：

```sql
ALTER TABLE agent_runs_config ADD COLUMN gate_cmd TEXT;           -- NULL = 无预检
ALTER TABLE agent_runs_config ADD COLUMN gate_since_ms INTEGER;   -- gate_cmd 最近一次变更的时间（S7「7 天未唤醒」使用）
ALTER TABLE agent_task_runs  ADD COLUMN gate_phase INTEGER NOT NULL DEFAULT 0;  -- 1 = 正在跑预检
```

v1 的 `last_woken_ms` 列与 `mark_woken` 随「7 天未唤醒」一并挪到 S7（V17）；S7 可由 run 表或自己的列判定，本期不预埋。

- `TaskConfig` 增加 `gate_cmd: Option<String>`、`gate_since_ms: Option<i64>`（均为 `#[serde(default)]`）。
- **`upsert_config`**（V10）：INSERT 列表与 VALUES 追加 `gate_cmd`（?16）、`gate_since_ms`（?17）；ON CONFLICT 的 SET 追加 `gate_cmd=?16, gate_since_ms=?17`。`gate_since_ms` 由 handler 计算：新建任务时，若 `gate_cmd` 非 NULL 取 now，否则 NULL；更新时先 `get_config` 取旧值，`gate_cmd` 变化（含 NULL↔非 NULL）才取 now，否则沿用旧值。
- **`query_configs`**（V10）：SELECT 末尾追加 `,gate_cmd,gate_since_ms`，取列追加 `gate_cmd: r.get(15)?, gate_since_ms: r.get(16)?`。
- `ScheduledTaskReq` 增加 `#[serde(default)] gate_cmd: Option<String>`；trim 后为空字符串视为 NULL；长度上限 4000 字符，超限返回 400。
- 新增方法：`set_gate_phase(run_id, bool)`。

**为什么要有 `gate_phase` 列**：预检期间 run 行处于 `claimed`，这样 overlap 守卫和 E1 门都能看到它。但如果此时进程重启，`reconcile_orphans(None)` 会把它改成 `orphaned_restart`，side_effects 任务就会进入确认队列，而实际上 agent 根本没有启动。不能借用 `failure_kind` 做标记，因为 COALESCE 语义导致之后无法清空（`:550`）。`reconcile_orphans` 的改动：在无条件 UPDATE 之前，先执行

```sql
UPDATE agent_task_runs SET state='failed', failure_kind='gate_interrupted', ended_ms=?1
 WHERE state IN ('claimed','running') AND gate_phase=1
```

并把这些行排除出 push 候选（候选 SELECT 加 `AND r.gate_phase=0`）。`gate_interrupted` 不在确认队列的 failure_kind 集合里，因此不会进入队列，也不推送（重启本身不是 gate 写错）。这条规则与 `side_effects` 无关：`side_effects=0` 的任务同样落 `failed/gate_interrupted`（§2.8 补测）。

### 2.3 执行路径（tick 不 await 阻塞）

tick 在 `claim_won == Ok(true)` 之后分流：

```text
if task.gate_cmd.is_some():
    s.set_gate_phase(&run.id, true)
    spawn_gated_run(m.clone(), s.clone(), run.id, task.clone(), nm)   // tokio::spawn，立即返回
    continue
else:
    (保持现状) m.trigger_run(...).await
```

非 gated 分支继续 inline `.await trigger_run`，这是既有行为，本期不改（外科手术式原则）；在「风险」中记为已知项。

`spawn_gated_run` 在独立任务中执行：

1. `dir = work_dir_under_home(&task.work_dir)`（改为 `pub(crate)`）。校验失败 → `failed/work_dir_rejected`，并推送 run_failed。
2. `outcome = run_gate(cmd, &dir, timeout).await`，这是一个**纯粹可复用的函数**，§2.5 的测试端点也调用它：
   ```text
   Command::new("sh").arg("-c").arg(cmd).current_dir(dir)
     .stdin(null).stdout(piped).stderr(piped)
     .process_group(0).kill_on_drop(true)
   tokio::time::timeout(timeout(默认 60s), 读 stdout/stderr（各最多 64KB，超出部分读出后丢弃）+ wait)
   超时 → libc::kill(-pgid, SIGKILL)；然后 child.wait().await 回收 sh（V15），返回 Timeout
   ```
   返回 `GateOutcome { verdict: Wake | Clean | Error(kind) | Timeout, exit_code, duration_ms, stdout_tail(4KB), stderr_tail(1KB) }`。
   **判定（D1 v2）**：exit 0 → `Wake`；exit 1 → `Clean`；其他 → `Error(kind)`，`kind ∈ spawn_failed | exit_code(n) | signal`（126/127 归 `exit_code`，文案单独提示「找不到命令 / 不可执行」）。
3. 按 verdict 分支，先 `set_gate_phase(false)`：
   - `Clean` → `set_run_state(skipped, failure_kind="gate_clean", ended_ms=now)`。**不推送，不进「需要你」**：skipped 行本来就不进确认队列，也没有 session。
   - `Error | Timeout` → `set_run_state(failed, failure_kind="gate_error"|"gate_timeout")` + `run_failed` 推送（正文用 F2 的 body 参数，内容为 `stderr_tail` 首行，截断到 120 字）。推送在本任务内 `.await`，外包 `timeout(10s)`。
   - `Wake` → **先复核**（V16）：`s.get_config(&task.id)` 返回 `None` 或 `enabled==false` → `set_run_state(skipped, failure_kind="gate_task_gone")`（行已被删时该调用是空操作，无害），不 spawn、不推送。复核通过后，`prompt = task.prompt + "\n\n## 预检输出\n```\n{stdout_tail}\n```"`（stdout 为空时不追加）；`m.trigger_run(&run_id, nm, &task.work_dir, ...)`。`trigger_run` 失败 → `failed/spawn_failed`（与 tick 现有分支一致）。
4. 无论走哪个分支，任务都必须到达终态。panic 由 tokio 捕获后该行仍停在 `claimed + gate_phase=1`，下一次启动时 reconcile 会处理；运行期间，看门狗 `reconcile_timeouts_per_task` 会在 idle 60 分钟后兜底 abort 它（`session_id` 为 NULL，不需要 kill）。Wake 之后 `gate_phase` 已是 0，此时崩溃按普通 `orphaned_restart` 处理（进确认队列的规则不变，这是正确的：agent 已经启动过）。

`failure_kind_zh`（`push.rs:332-341`）增加 `gate_error → "预检命令失败"`、`gate_timeout → "预检超时"`。

### 2.4 「7 天未唤醒」——v2 挪到 S7

本期不做（V17、D4）。S6 保证的数据前提：`gate_since_ms` 按 §2.2 维护；`gate_clean` run 行在 `prune_runs` 裁剪前可见（`scheduled_tasks.rs:931-951`）。S7 如何判定、在哪里提示，由 S7 自行定义。

### 2.5 测试预检 API

`POST /api/scheduled-tasks/gate-test`，请求体 `{work_dir, gate_cmd}`，返回 `{verdict: "wake"|"clean"|"error"|"timeout", exit_code, duration_ms, stdout_tail, stderr_tail}`。

- 先调用 `validate_work_dir_under_home`（`web.rs:864-877`），然后直接 `run_gate(...).await`。这是 HTTP handler，不在 tick 内，最长阻塞 60s 可以接受。
- 需要登录；不保存任何内容，不写 run 行。

### 2.6 前端

- `lib/api/scheduler.ts`：`ScheduledTask`、`ScheduledTaskReq` 增加 `gate_cmd`、`gate_since_ms`；新增 `testGate()`。
- `handleToggle`（`ScheduledTasksPanel.tsx:87-104`）必须带上 `gate_cmd: t.gate_cmd`，否则启停任务会清空预检（B1 同型问题）。
- `TaskForm` 在 prompt 下方增加一个可选的「预检命令（可选）」textarea（等宽字体、`text-ui-input` 16px，防止 iOS 聚焦缩放，见 I-15），说明文字（V9）：「条件成立（退出 0）→ 唤醒 agent，输出会附在 prompt 后；退出 1 → 跳过本次；其他退出码、找不到命令或 60 秒超时 → 预检故障并推送」。旁边放「测试预检」按钮，请求进行中禁用；结果以一行 StatusDot + 文案展示：「将唤醒（0.4s）· 输出 N 行 ▾」「将跳过（exit 1）」「预检故障：exit 127 · sh: gh: not found」。
- `runReason` 增加：`skipped + gate_clean → 「预检未满足，未唤醒」`（颜色 `--fg-subtle`）；`skipped + gate_task_gone → 「任务已删除或停用」`；`failed + gate_error → 「预检失败」`；`failed + gate_timeout → 「预检超时」`；`failed + gate_interrupted → 「预检中断（重启）」`。
- 任务列表行：设置了 gate 的任务名后显示小徽标 `预检`。（v1 的「上次唤醒 N 天前」随 V17 挪到 S7。）
- 手机：表单本来就在 `Sheet side="full"` 中；按钮保证 44px 触控区域；测试结果的输出在折叠区内，最多显示 20 行。
- 面板是 lazy（`lazyPanels.ts:12`），不计入首屏。

### 2.7 不变量

- **tick 内不 `.await` 预检**：gate 进程和其后的 `trigger_run` 都在 spawn 出来的任务里运行；tick 只做同步 DB 写入。
- E1：预检期间行保持 `claimed`，`active_run_count` 计数，auto-update 最多被延后 60s。
- fan-out 与 `SessionInput`：未改动；唤醒后仍走 `trigger_run` → `SessionInput::Prompt{run_id}`。
- 调度链路只有 Claude 一个后端（`scheduled_session_type`，`session_manager.rs:2639`），不受本项影响。

### 2.8 边界与测试

| 情形 | 期望 | 测试 |
|---|---|---|
| exit 0 | Wake；prompt 附预检输出 | `run_gate` 单测（`sh -c 'echo hi'`） |
| exit 1 | skipped/gate_clean，无推送，无 session | `run_gate` 单测（`sh -c 'exit 1'`）+ store 单测 |
| exit 2（如 `jq` 解析失败） | failed/gate_error + run_failed 推送 | 单测 `sh -c 'exit 2'` |
| `jq -e 'length>0'` 配方 | 非空数组 → Wake；空数组 → exit 1 → Clean | 单测 `sh -c 'echo "[1]" \| jq -e "length>0"'` 与 `'[]'`（CI 无 jq 时用 `test -s` 等价替身） |
| exit 0 且输出 5KB | Wake；prompt 只附最后 4KB；`input_snapshot` 含该段 | 单测，截断按 char 边界（沿用 `chars().take` 的教训） |
| exit 127（命令不存在） | failed/gate_error + run_failed 推送 | 单测 `sh -c 'nonexistent_zz'` |
| `sleep 999` | 超时后进程组被杀、`sh` 已被 wait 回收，无残留、无僵尸 | 单测注入短超时（`run_gate(cmd, dir, timeout)`），用 pid 探活确认孙进程已退出、`sh` 的 pid 不再处于 zombie（读 `/proc/<pid>/stat` 不存在） |
| `yes` 无限输出 | 每路读满 64KB 后丢弃，内存有界，按超时处理 | 单测 |
| 预检期间 tick 再次到点 | overlap 守卫看到 claimed 行，跳过 | 现有 `should_skip_overlap` 覆盖 |
| 预检期间重启，`side_effects=1` | 下次启动 → failed/gate_interrupted，不进确认队列 | `reconcile_orphans` 单测 |
| 预检期间重启，`side_effects=0`（V20） | 同样 failed/gate_interrupted（不是 aborted/orphaned_restart） | `reconcile_orphans` 单测 |
| Wake 后 `gate_phase` 已清 0，随后崩溃（V20） | 按 aborted/orphaned_restart 处理；`side_effects=1` 时进确认队列 | `reconcile_orphans` 单测 |
| 预检期间任务被删除或停用（V16） | Wake 分支不 spawn、不推送 | 单测：`run_gate` 期间 `delete_config` → `trigger_run` 未被调用 |
| replay 一个带预检的 run（V20） | 不跑 gate；复用 `input_snapshot` 中的「## 预检输出」段 | 对称单测：snapshot 含该段，replay 路径不调用 `run_gate` |
| 启停任务 | `gate_cmd` 不丢失 | 前端单测：`handleToggle` 的请求体包含 `gate_cmd` |
| 修改 gate_cmd | SET 生效；只有值变化才重置 `gate_since_ms`（V10） | store 单测：upsert 两次后 `get_config` 读回新值；handler 单测 |
| 空白 gate_cmd | 视为 NULL | handler 单测 |
| 测试端点 work_dir 越界 | 403 | handler 单测 |

---

## 3. G3 Crew 话题模式（`crew_mode=crew`）的 turn 语义（T3）

### 3.1 现状（已核实）

- 实测（调研 §7；原始帧 `/tmp/zmx-crew-probe/result.json` 由作者复核）：crew 模式下 `POST /api/chat` 约 10ms 返回 `{"ok":true,"crew":true}`；随后只有 `chat_message`（`crew_ack` → 3 次 `crew_ask` → `crew_meta`），**没有 `chat_chunk` 和 `chat_done`**。同一时段 `slots` 帧里本 slot 的状态为 `running:false, queue_depth:0, subagents_running:false, needs_input:false, waiting_for_input:true`。
- Crew 侧：crew 模式的消息是持久队列项，不是 turn（`KC/dashboard/chat_handlers.py:643-662`）；回答类 kind 为 `_ANSWER_KINDS = (crew_result, crew_meta, crew_ask)`（`KC/crew_chat.py:55`），通过 `broadcast_ws("chat_message", {slot, role, content, cls, meta, kind})` 下发（`:1175-1183`）；crew_result 的来源在 `:1916`、`:1940`（durable forward，至少一次投递，**可能重复**）；ask 在 `:1240-1244`、`:1545`、`:1625`、`:1737`；meta 在 `:1405-1411`（路由失败）、`:1628`（话题列表）。
- **持久化行不带 `kind`**（v2 核实）：`kind` 只在 WS 帧上；写入 slot 的是 `slot.append("assistant", content, cls, meta={"crew_reply": True})`（`KC/crew_chat.py:1150-1169`，注释明说 `cls` 在周期 flush 时会被丢，`meta` 才会保留）。每行都有 Gateway 铸造的 `meta.mid`（随机 id，`KC/dashboard/state.py:4317-4340`）和 `ts`（`:4306-4313`）。
- **`GET /api/chat/slots/{slot}`**：返回 `key,title,running,stopping,messages,queue,total,has_more,next_before,…`（`KC/dashboard/chat_handlers.py:2223-2244`），`messages` 经 `_prepare_messages` 输出 `role/content/meta`（`KC/dashboard/chat_utils.py:2912-2930`）；`?limit=` 默认 200、上限 500（`chat_handlers.py:1914-1923`）。它**不返回 `queue_depth` 和 `subagents_running`**。`subagents_running` 只出现在列表接口 `serialize_slots`（`KC/dashboard/state.py:7604`），而且是 **bool**。`queue_depth`、`running`、`orchestrating` 出现在 `slot_projection.py:236-238`，只进入列表和 `slots` WS 帧。
- zeromux 侧：`normalize_frame` 在 match 之前先按 `data.slot` 过滤（`crew_process.rs:55-56`），`slots` 帧的 `data` 是数组，因此会在这里被整帧丢弃；`chat_done` 是唯一的 Result 来源（`:147-160`）。`NormState` 在重连循环外创建（`:457`），同一进程内 Gateway 重连不会丢 `NormState`。
- **scrollback 只在内存**：`load_persisted` 回填会话时 `scrollback: VecDeque::new()`（`session_manager.rs:2339`）；会话只在有 WS 连上时才 `ensure_running`（`acp/ws_handler.rs:73`）。
- Crew fan-out：每个 Prompt 都会执行 `turn_seq += 1`、`mark_turn(Running)`、`turn_starts.start`（`session_manager.rs:4101-4106`），只在 Result/Error/Exit 边界上置 Idle，并执行 push、metric、posture（`:3939-4015`）。话题模式没有边界，所以 turn 会永远停在 Running，由此引出：
  - 前端 stuck：`running && now - last_activity > 180s`（`triage.ts:32`，`STUCK_SILENCE_MS=180_000`，`lib/stuck.ts:3`）；
  - 10 分钟 stuck 推送（`scheduled_tasks.rs:1138-1157`）；
  - 30 分钟交互看门狗 `TimeoutKill`（`:1132-1135`，`INTERACTIVE_IDLE_MS`，`:16`）→ `process.kill()`（`session_manager.rs:4146-4150`）→ `Cmd::Stop` → WS 关闭、Exit，会话进程结束；
  - `running_summary` 把它计入 interactive（`:1374-1378`），auto-update 被**永久阻塞**。
- **`mark_turn` 不适合驱动话题忙闲**（CTO-R B1，v2 复核）：`apply_turn`（`session_manager.rs:595-622`）无条件刷新 `last_activity_ms`（`:597`）；Running 分支采纳新 seq（`:603`）并清空 `approval_ids`（`:606`）；Idle 分支只在 `rp.turn_seq == seq` 时生效（`:614`）。话题模式每个回答都 `turn_seq += 1`，busy=false 时的 seq 已经不等于 busy=true 时写入的 seq，Idle 被忽略，`turn_state` 永远停在 Running；重连时 `replay_done.running`（`acp/ws_handler.rs:121`，来源 `turn_is_running`，`session_manager.rs:787-795`）恒为 true。
- 前端 `useAcpSocket`：`content_block` 会 `setBusy(true)`（`hooks/useAcpSocket.ts:383`），`result` 会 `setBusy(false)`（`:402-405`），error/exit 同样清除（`:414-440`）。`case 'system'` 目前只识别 `queued` 与 `resume_failed`（`:316-332`）。

### 3.2 设计（已按「无 chat_done」定稿，工作量 M）

**模式来源**：S5 G2 持久化的 `crew_mode`（Gateway 原值 `""|crew`，V1）。`spawn_crew` / `ensure_running` 把 `topics = (crew_mode == "crew")` 传给 `CrewProcess::spawn(cfg, work_dir, resume, topics: bool)`，再写入 `NormState.topics`。只有 `topics` 走本节逻辑；`crew_mode == ""`（聊天、目标指挥）的行为完全不变。

**process 层（`normalize_frame` 仍为纯函数）**，在 `NormState.topics == true` 时：

1. 在 slot 过滤**之前**先处理 `type=="slots"`：在 `data` 数组中查找 `key==my_slot` 的元素，计算
   `busy = running || orchestrating || subagents_running || queue_depth > 0`，
   `needs_input = needs_input || pending_approval`（**不看 `waiting_for_input`**：实测它在助手每次回复后都为 true）。
   只有当 `(busy, needs_input)` 与 `NormState` 上次记录的值不同才输出 `AcpEvent::System{subtype:"crew_busy", count: Some(busy as u32)}`；needs_input 由 ask 路径负责，这里只用于 §3.4 的核对。字段缺失时按 false 处理（宽松解析，R6）。
2. `chat_message`：先经过 G1 的分支（`role=="assistant"` 且 `kind` 以 `crew_` 开头）。
   - `crew_ack` → `System{subtype:"crew_ack"}`，前端渲染为一行灰色提示，不形成气泡。
   - `crew_result | crew_meta | crew_ask` → `[ContentBlock{block_type:"text", text, summary:Some(kind)}, Result{text, session_id: my_slot, cost_usd:None, …}]`。**不进入 `turn_text`**（G1 约束）。
   - 同一 `meta.mid` 的帧只处理一次：`NormState.seen_mids`（有界 LRU 256），用来抵消 durable forward 的至少一次重复投递。缺 `mid` 时不去重。每处理一个带 mid 的回答，额外产出 `System{subtype:"crew_cursor", session_id: Some(mid)}`，fan-out 消费它推进持久游标（§3.9），不转发给前端。
   - `content` 为空时丢弃；`content` 不是字符串时丢弃；其他字段一律不依赖（crew_result 的完整格式尚未实测，只读 `content`、`kind`、`meta.mid`）。
3. 兜底轮询：话题模式下 `run_event_loop` 的 select 增加一个 30s interval 臂，`GET /api/chat/slots`（列表接口，`X-Internal-Secret` 每次现读），把结果包装成与 `slots` 帧同构的 JSON 后喂给 `normalize_frame`，走同一分支，从而保证单一路径。请求放在 detached task 里，通过 `mpsc` 把结果送回事件循环，**不在 select 臂里 await HTTP**（与 `prompt_worker` 同样的理由，`crew_process.rs:424-429`）。
4. 补发（V8）：每次 WS **连上**后（含首次 spawn 与重连），发起一次 §3.9 的 catch-up，同样放在 detached task 里、结果经 `mpsc` 回流。

**fan-out 层（`spawn_crew_fanout`，`session_manager.rs:3897`）**：新增局部变量 `topics: bool`、`last_prompt_ms: Option<i64>`。在 `topics` 为真时，事件臂在通用边界逻辑**之前**分流：

| 事件 | 动作 |
|---|---|
| `ContentBlock{summary: crew_*}` | `turn_seq += 1`（每个回答单独成组），然后 `emit` |
| 紧随其后的 `Result` | `emit`（同一 `turn_seq`，由 `posture_delta_of` 写入 snippet），然后调用新的 `settle_crew_answer(kind)`，**跳过**通用 boundary、FIFO、metric 与 `mark_turn` |
| `System{crew_busy}` | **`m.set_crew_busy(&sid, count>0)`**（V6，**不调用 `mark_turn`**）；`emit`（ephemeral） |
| `System{crew_cursor}` | `m.set_crew_cursor(&sid, mid)`（§3.9）；不 emit 给前端 |
| `System{crew_ack}` | `emit` |
| `Error`（Gateway 重连） | `emit` 作为提示，**不 settle**（本来就没有 turn） |
| `Exit` | `emit`，然后走现有收尾 |

**`set_crew_busy(sid, busy)`**（新增，V6）：锁内直接写 `rp.turn_state = if busy {Running} else {Idle}`，`busy` 为真时若 `turn_started_ms` 为空则置 now，为假时清空。**不带 seq、不改 `rp.turn_seq`、不改 `last_activity_ms`、不清 `approval_ids`、不增 `turns_completed`**。它只被话题分支调用；普通模式仍然只用 `mark_turn`。这样 `turn_is_running`、`running_summary` 与 `replay_done.running` 反映的都是 Gateway 的真实忙闲。

`settle_crew_answer(kind)`（每个分支末尾都调用 S5 的 **`persist_posture(sid)`**，V2）：
- `crew_result`：`settle_posture(Completed)`；清除 `awaiting_input`；`persist_posture`；`maybe_push_turn_done(dur = now - last_prompt_ms.unwrap_or(now), intent=None)`。沿用 `should_push_turn_done` 的「≥60s 才推」规则（`push.rs:301-310`），正文使用 F2 的 snippet。
- `crew_meta`：同 `crew_result`，但**不清除** `awaiting_input`（D5）。
- `crew_ask`：**不**调用 `settle_posture`，只设置 `awaiting_input = true` 和 `last_snippet = 问题`；**`persist_posture`**（修复 CTO-R M5：v1 的 ask 路径不落盘，重启后「待回答」丢失）；推送 `ask`（§3.3）。

输入臂在 `topics` 为真时：
- `Prompt`（无 `run_id`）：`turn_seq += 1`；`emit UserPrompt(turn_seq)`；`last_prompt_ms = now`；清除 `awaiting_input` 并 `persist_posture`；`send_prompt`。**绕过 collect 队列**（Crew 自己有持久队列），**不** `mark_turn(Running)`，**不** `turn_starts.start`。busy 只由 `crew_busy` 驱动。
- `Interrupt` / `Cancel`：映射为 `process.interrupt()`（`/stop`）。**不调用 `process.kill()`**：Cancel 在普通模式下会杀掉 WS，话题模式下没有这个必要。crew 模式下 `/stop` 的具体语义未实测，已列为实施时的第一个验证步骤；如果它不会停止话题，前端就隐藏中断按钮。
- `TimeoutKill`：由于 §3.4 的过滤，理论上不可达；万一出现，只 `tracing::warn`，**不 kill**。
- `SetQueueMode`：照常记录，对话题模式无效。

在话题分支（`session_manager.rs:3939` 边界逻辑之前）写一段注释，明确说明：话题模式是 Crew 专属分支，三后端 parity 只要求在普通模式下成立（CTO 终稿 §2）；它不走 `mark_turn` 的原因（B1）。

### 3.3 推送：`ask` 类型

- `payload_for("ask", name, sid, None)` + F2 body = 问题原文前 120 字；标题为 `❓ {name} 等你回答`。
- `kind_allowed_by_levels`：`ask` 归入 important（`push.rs:378-384` 的 `_` 臂已经覆盖，不需要改代码，只补单测锁定行为）。
- 去抖（V18）：新增 `ask_debounce: Mutex<HashMap<(user, session, kind), i64>>`，其中 `kind ∈ {"ask", "approval"}`，每个 key 5 分钟内最多一次，判定函数复用 `should_push_stuck`（`push.rs:315-320`）的形状。**ask 与 approval 分 key**：5 分钟内先推了 ask 不会压掉紧随其后的审批推送。`forget_session`（`push.rs:484-487`）同步清理新 map。实测场景是 2 秒内连来 3 次 ask，最终只推 1 次。
- SW：`sw.js:31` 的 tag 规则 `${session_id}:${kind}` 已经能按类型折叠通知，无需改动；前台抑制仍只针对 turn_done。

### 3.4 看门狗、stuck 与 E1 豁免（D7）

- `RunningProcess` 新增 `crew_topics: bool`，由 spawn 时写入。
- `running_idle_too_long`（`session_manager.rs:948-957`）、`stuck_push_candidates`（`:963-972`）、`running_summary` 的 interactive 计数（`:1374-1376`）都加过滤条件 `!rp.crew_topics`。话题会话 busy 时 `turn_state==Running`（`set_crew_busy`），没有这层过滤就会被看门狗 kill、阻塞 auto-update。
- `emit` 的 `bump_activity` 谓词（`:3740-3744`）增加：`System{crew_busy}` 不 bump，因为它不是 agent 的前进信号；而 `crew_*` 回答块会 bump。`System{crew_cursor}` 由 fan-out 消费，从不进入 `emit`。
- `is_ephemeral_event`（`:3678-3683`）增加 `crew_busy`：只广播，不写入 scrollback，避免重连时回放大量状态切换。重连时的忙闲状态由 `replay_done.running`（`acp/ws_handler.rs:121-138`，来源是 `turn_state`，由 `set_crew_busy` 维护）提供。

### 3.5 数据模型 / API

- `Posture` 增加 `awaiting_input: bool`；持久化由 S5 F1 的 `awaiting_input` 列 + `persist_posture` 负责（V2）。
- `SessionInfo` 增加 `awaiting_input: bool`，以及 S5 引入的 `crew_mode` / `crew_agent` / `crew_origin`（S6 只读，不另定义）。
- `sessions` 表新增一列 `crew_last_mid TEXT`（§3.9，幂等 ALTER，写法同 `session_store.rs:60-66`）。
- 不新增 HTTP 路由；`SessionInput` 不增加变体。

### 3.6 前端

- `useAcpSocket`（V7）：hook 需要知道会话是否为话题模式——`AcpChatView` 已拿到 `agentType`（`AcpChatView.tsx:58`），新增 prop `crewTopics?: boolean`（`AppShell.tsx:167` 由 `s.crew_mode === 'crew'` 传入），hook 选项同步增加 `crewTopics`。
  - `case 'system'` 增加 `crew_busy` → `setBusy(count > 0)`，并处理 turn 时钟（busy 变为 true 时开始计时，变为 false 时清零）；`crew_ack` → `pushNotice({kind:'system', text:'Crew 已接收'})`。
  - **`crewTopics` 为真时**，`content_block` 与 `result` **不调用 `setBusy`、不改 turn 时钟**（`:383-397`、`:402-405`），只 `appendEvent`；回答组照常完成并显示摘要卡。busy 只由 `crew_busy` 与 `replay_done.running` 驱动。error/exit 仍然清 busy（进程已不可用）。
- `triage.ts`：
  - `Attention` 增加 `'ask'`；`PRIORITY.ask = 1`（与 approval 同档，`triage.ts:15`）；`NEEDS_YOU` 加入 ask；`LABELS.ask='待回答'`；`toneOf(ask)='attention'`。
  - 判定顺序中，`approval` 判定（`triage.ts:31`）之后插入 `if (s.awaiting_input) return 'ask'`（当前会话同样适用，因为它需要用户动作）。
  - `stuck` 判定对 `s.crew_mode === 'crew'` 不生效。
- `TriageRow`：attention 为 ask 时，第二行显示问题（即 `last_snippet`）；**不**显示批准按钮；话题模式下显示中断按钮与否取决于 §3.2 的 `/stop` 验证结果。**话题会话 `turn_state==='running'` 时第二行显示「话题运行中」**（V21 / PM-R m4：话题会话没有 `current_step`，v1 下看起来像空闲；`TriageRow.tsx:39` 的 `second` 计算加一个分支）。
- `TurnView` / `TurnSummaryCard`：`summary=crew_ask` 的回答卡显示「待你回答」标签，并提供「回答」按钮，点击后聚焦 composer（复用 §5 的 `onReject` 预填机制，预填内容为空）。
- 手机：无布局变化；FAB ⏭ 通过 `nextNeedsYou` 自动覆盖 ask。

### 3.7 不变量

- fan-out 仍然独占 WS 连接和 slot；话题模式也不引入新的持有者；轮询和补发请求由 process 层的 detached task 发出，结果回到同一事件循环。
- 输入仍全部经过 `SessionInput`。
- Drop：会话删除时 `CrewProcess::drop` 只删 `owns_slot` 的 slot，`owns_slot = crew_origin != external`（S5 R4，V1）；话题模式下 slot 由我们创建，`crew_origin=zeromux`，行为不变。**不依赖 `resume` 是否为 Some**：重启后自建 slot 也是 resume 进来的。
- `mark_turn` / `apply_turn` 零改动；话题模式只经 `set_crew_busy`。

### 3.8 边界与测试

| 情形 | 期望 | 测试 |
|---|---|---|
| 实测帧序列 ack→ask×3→meta | 1 条 ack 提示；3 个 ask 组和 1 个 meta 组，全部 complete；`awaiting_input=true`；只推 1 次 ask；`last_outcome=Completed` | `normalize_frame` 单测，夹具取自 `result.json` 的 crew_frames + fan-out 集成单测 |
| busy→回答→idle（V6） | `turn_is_running == false`；`last_activity_ms` 只被回答块 bump、未被 busy 切换 bump；`approval_ids` 未被清空 | `set_crew_busy` 单测 + fan-out 单测（CTO-R B1 指定用例） |
| busy 期间连到 3 个回答（seq 推进 3 次）后 idle | 仍然 Idle（不依赖 seq） | fan-out 单测 |
| 普通模式收到 chat_message | 仍然丢弃（R1 实测普通模式为 0 条，G1 单测已覆盖） | 保留 |
| `topics=false` 的 slots 帧 | 丢弃（行为不变） | 单测 |
| slots 帧中没有本 slot，或字段缺失 | 无事件 | 单测 |
| 同一 mid 的 crew_result 投递两次 | 只渲染一次 | 单测 |
| 忙 40 分钟无输出 | 不被 TimeoutKill，不推 stuck，不阻塞 auto-update | `running_idle_too_long` / `stuck_push_candidates` / `running_summary` 单测：`crew_topics=true` 且 `turn_state=Running` |
| busy 切换 | 不写 scrollback，也不 bump `last_activity_ms` | `is_ephemeral_event` / bump 谓词单测 |
| 用户回答 ask | 清除 `awaiting_input` 并落盘 | fan-out 单测 |
| ask 后重启（V2） | 重启后 `awaiting_input=true`、`last_snippet=问题`，分诊仍是「待回答」 | `persist_posture` + `load_persisted` 往返单测 |
| topics 会话收到 content_block / result（V7） | busy 不变；只有 `crew_busy` 改变 busy | hook 单测：`crewTopics=true` 时 content_block 后 `busy` 仍为 false；`crew_busy{count:1}` 后为 true；随后 result 不置 false |
| 重连 | busy 取自 `replay_done.running` | 前端 hook 单测 |
| 回答 <60s 到达 | 不推送 turn_done（沿用现规则） | `should_push_turn_done` 已有单测 |
| 补发（§3.9） | 见 §3.9 表 | — |

### 3.9 断连补发（V8，CTO-R M6）

**问题**：auto-update 与部署会让 zeromux 重启，WS 断开几十秒；这段时间 Gateway 广播的 `chat_message` zeromux 收不到，既进不了 transcript，也不会推送。更糟的是，重启后会话只在有浏览器连上时才 `ensure_running`（`acp/ws_handler.rs:73`），用户不在时话题会话根本没人在听。

**游标**：`sessions.crew_last_mid TEXT`——最近一个**已处理**回答的 `meta.mid`。由 fan-out 收到 `System{crew_cursor}` 时经 `set_crew_cursor(sid, mid)` 写入内存并落盘（单列 UPDATE，与 `update_description` 同形，`session_store.rs:133-138`；不搭 `upsert` 全量写的车）。不从 scrollback 重建：scrollback 重启后为空，且 `ContentBlock` 不带 mid（`acp/process.rs:42-59`）。

**catch-up 流程**（process 层 detached task，结果经 `mpsc` 回流事件循环）：
1. `GET /api/chat/slots/{key}?limit=200`（`X-Internal-Secret` 现读）。
2. 在 `messages` 中取 `role=="assistant" && meta.crew_reply==true` 的行（持久化行没有 `kind`，只有这个标记，§3.1）。
3. 如果游标为空（首次开启该会话）：只把这些行的 mid 播种进 `seen_mids`，**不补发**（避免把整段历史当新回答刷一遍、狂推）。
4. 如果游标非空：定位游标所在行，其后的所有回答行按顺序合成 `chat_message` 帧（`kind="crew_result"`，`meta` 原样）喂给 `normalize_frame`，走 §3.2 的同一分支；`seen_mids` 去重保证与 WS 实时帧不重复。游标不在窗口内（窗口外被挤掉或 Gateway 轮转）→ 补发窗口内全部回答行，并发一条 `System{subtype:"crew_gap"}` 提示「断连期间可能有更早的回答，请在 Crew 中查看」。
5. **补发行一律按 `crew_result` 处理**：持久化行无法区分 result/meta/ask。代价是断连期间到达的 ask 不会进入「待回答」；缓解：同一轮的 slots 帧 / 30s 轮询仍会给出 `needs_input`，crew_watch 对 zmx 自有 slot 不推送，因此 §3.2 的 slots 分支在 `needs_input` 上升沿额外设置 `awaiting_input`（仅 topics 模式，只设不清）。
6. 补发产生的 turn_done 推送照常走去抖；一次 catch-up 补出 ≥3 条时只推 1 条「{name} 断连期间有 N 条新回答」。

**重启后主动拉起**：crew_watch 首轮（§4.2）对所有 `crew_mode=="crew" && running.is_none()` 的会话 `tokio::spawn(ensure_running(id))`，串行、每个 5s 超时；`slot_alive` 失败（slot 已不存在）只记 warn。这样用户不在时话题回答也能推送。

| 情形 | 期望 | 测试 |
|---|---|---|
| 游标为空的首次 catch-up | 只播种 seen，不补发、不推送 | `catch_up_plan(messages, cursor=None)` 纯函数单测 |
| 游标后有 2 条回答 | 按序补发 2 条；推 turn_done（受去抖约束） | 纯函数 + fan-out 单测 |
| 补发与实时帧同一 mid | 只渲染一次 | 单测 |
| 游标不在窗口内 | 补发窗口内全部 + `crew_gap` 提示 | 纯函数单测 |
| 同进程内 Gateway 重连 | `NormState` 仍在，catch-up 只补缺口 | 单测 |
| 重启后无人打开浏览器 | crew_watch 首轮拉起话题会话；Gateway 的新回答照常推送 | 集成测试（mock Gateway） |
| `messages` 缺 `meta` / 非回答行 | 跳过 | 夹具单测 |

---

## 4. G7 外部 slot 叫醒 + Crew cron 失败推送（T4）

### 4.1 现状（已核实）

- zeromux **目前不会为任何审批发推送**：全仓库 `payload_for(` 的调用只有 turn_done、run_failed、confirm、stuck、term_ended、test 这几类（`session_manager.rs:1099,2815,3027,3044`，`scheduled_tasks.rs:1040,1147`，`web.rs:6809`）。调研 §3 G7 中「只推 ZeroMux 自己会话的审批」一句与代码不符。
- slot 列表字段：`needs_input = bool(slot._question_pending)`；`waiting_for_input` = 不在运行且最后一条消息来自助手（`KC/dashboard/slot_projection.py:179-186`），**每次回复后都为 true，不能作为叫醒信号**；另有 `key`、`title`、`agent`、`mode`、`project`（`:206-223`）、`running`、`orchestrating`、`queue_depth`、`pending_approval`、`pending_approval_info`、`last_activity_ts`、`last_message`（`:236-251`）、`origin`、`created_by`（`:284-292`）；`subagents_running` 由 `serialize_slots` 追加（`KC/dashboard/state.py:7604`）。
- 本机现有 slot：一个微信 slot 和两个 `cron-*` slot（`~/.kiro/crew/open_slots.json`）。
- Crew cron：`GET /api/crons` 与 `GET /api/crons/history?job_id&limit&offset`（`KC/dashboard/server.py:1398-1401`；history handler `KC/dashboard/handlers/cron.py:1715-1739`），返回 `{runs:[{run_id, job_id, job_name, status, started_at, finished_at, summary, error, …}], total}`；status 取值包括 `success | failure | timeout | cancelled`（`KC/cron.py:3760,1668,1870`），本机 18 条记录全部是 `success`。`/api/crons` 是 mixed 路径，可以用 `X-Internal-Secret` 访问（`KC/dashboard/server.py:711-736`，`"/api/crons"` 前缀覆盖所有子路由）。
- 认证模式：`crew_process.rs` 的 REST 调用用 `X-Internal-Secret`，secret 每次现读（`:266-285`、`:305-317`）。
- 推送点击：`PushPayload` 只有 `kind/session_id/title/body`（`push.rs:324-330`）；SW 把 `session_id` 放进 `data`（`sw.js:33`），点击时对已有窗口 `postMessage({type:'open_session'})`，否则 `openWindow('/?session=…')`（`sw.js:38-50`）；前端只解析 `?session=`（`useSessionsPoll.ts:141`）。

### 4.2 设计：`src/crew_watch.rs`

- 在 `main.rs` 中，与 `spawn_scheduler`（`main.rs:572`）并列，调用 `crew_watch::spawn(state)`：一个独立的 `tokio::spawn` 循环，外层包 panic 自愈（照抄 `spawn_scheduler` 的 supervisor 结构，`scheduled_tasks.rs:1102-1238`）。`AppState`（`main.rs:214-226`）增加 `crew_watch: Arc<CrewWatch>`。
- 每 30s 执行一次，**整轮包在 `timeout(20s)` 里**；Gateway 不可达时指数退避，最长 5 分钟，日志只输出 debug 级别。
- 每轮读 secret（失败则跳过本轮），然后**并发**请求 `GET /api/chat/slots` 和 `GET /api/crons/history?limit=20`；每 5 轮（约 2.5 分钟）另请求一次 `GET /api/crons`（G9 的任务列表，§13）。
- 纯函数 `slot_attention_edges(prev: &HashMap<key, bool>, slots: &[SlotView], own: &HashSet<key>) -> (next, Vec<Edge>)`：
  - `attn = needs_input || pending_approval`；只有 false→true 的上升沿才产生 Edge；
  - `own`（zeromux 会话的 `ResumeToken::Crew(k)` 集合）中的 slot 由各自 fan-out 处理，这里跳过。
- 纯函数 `cron_failures(seen: &HashSet<run_id>, runs) -> (seen', Vec<Failure>)`：`status ∈ {failure, timeout}` 且 run_id 之前未见过；`seen` 容量上限 500。
- 第一轮只做**静默播种**（D11），之后每一轮都做 diff。第一轮同时执行 §3.9 的「重启后主动拉起话题会话」。
- 推送：
  - 外部 slot → `payload_for("ask", "Crew · {title}", "", None)` + body = `{pending_approval_info.tool 或 last_message 首行，截断到 100 字} · 在 Crew/微信回答`（V11：正文末尾必须写明去哪里回答）；`url = "/?panel=away&crew=1"`；去抖按 `(user, "crew:"+slot_key, "ask")`，5 分钟一次（复用 §3.3 的 `ask_debounce`）。
  - Crew cron → `payload_for("run_failed", "Crew 定时 · {job_name}", "", None)` + body（`error` 首行，截断到 120 字）；`url = "/?panel=scheduled&seg=crew&job={job_id}"`（V11 深链，落到 §13 的 G9 分段）；同一 job 30 分钟内最多一次。
  - 接收方按 D8 确定。`send_to_user` 在 crew_watch 任务内 `.await`，每次外包 `timeout(10s)`；crew_watch 不是调度 tick，阻塞它不会影响调度。
- **推送深链**（V11）：`PushPayload` 增加 `#[serde(skip_serializing_if = "Option::is_none")] url: Option<String>`（只由服务端常量拼出，`job_id` 先过 §13.2 的白名单）。SW：`notificationclick` 优先用 `data.url`，已有窗口时 `postMessage({type:'open_url', url})`，否则 `openWindow(url)`；无 `url` 时保持现状。前端 `useSessionsPoll` 的深链解析（`:141`）增加 `panel=scheduled&seg=crew[&job=]` → `openPanel('scheduled')` 并选中 Crew 分段；`panel=away&crew=1` → 展开离开卡的 Crew 行；解析后同样 `history.replaceState` 消费掉（A11）。
- **只读快照访问器**（V19，供 G7 离开卡、G9、T9 折叠与 S7 代理层共用；crew_watch 是**唯一写者**）：

  ```rust
  pub struct CrewWatch { snap: std::sync::RwLock<Arc<SlotsSnapshot>>, /* seen/prev 等内部状态 */ }

  impl CrewWatch {
      /// 只读。永远立即返回（克隆 Arc，不做 I/O、不 await）；Gateway 从未成功时返回 `SlotsSnapshot::default()`（gateway_ok=false）。
      pub fn snapshot(&self) -> Arc<SlotsSnapshot>;
  }

  #[derive(Clone, Default, serde::Serialize)]
  pub struct SlotsSnapshot {
      pub gateway_ok: bool,              // 最近一轮是否成功
      pub refreshed_ms: Option<i64>,     // 最近一次成功刷新的时间（epoch ms）；消费方据此判断新鲜度
      pub slots: Vec<SlotView>,          // /api/chat/slots 全量，宽松解析（R6）
      pub cron_jobs: Vec<CronJobView>,   // /api/crons，G9 用（§13.2 的字段集）
      pub cron_runs: Vec<CronRunView>,   // /api/crons/history?limit=20
      pub cron_refreshed_ms: Option<i64>,
  }

  #[derive(Clone, serde::Serialize)]
  pub struct SlotView {                  // 全部 Option / 缺省即 false，未知字段丢弃
      pub key: String,
      pub title: Option<String>,
      pub agent: Option<String>,
      pub mode: Option<String>,          // Gateway 原值 ""|crew
      pub project: Option<String>,
      pub origin: Option<String>,
      pub created_by: Option<String>,    // 空串归一为 None
      pub running: bool,
      pub orchestrating: bool,
      pub subagents_running: bool,
      pub queue_depth: u32,
      pub needs_input: bool,
      pub pending_approval: bool,
      pub pending_approval_tool: Option<String>,   // pending_approval_info.tool
      pub last_message_head: Option<String>,       // last_message 首行，≤120 字
      pub last_activity_ts: Option<f64>,
  }
  ```

  - 写入：每轮成功后整体替换 `Arc`（`RwLock` 只在替换时持写锁，持锁期间无 await）；失败轮只把 `gateway_ok` 置 false，**保留**上一轮的 slots/cron 数据与 `refreshed_ms`，让消费方自己按新鲜度降级。
  - 派生视图都是 `snapshot()` 之上的纯函数：`external_attention(&snap, &own) -> Vec<{key,title,snippet}>`（离开卡）、`children_by_parent(&snap)`（T9，§9.2）、`project_cron(&snap)`（G9，§13）。S7 的代理层只调用 `snapshot()` 与这些纯函数，**不再自建 SlotsCache**，也不另起轮询。
  - 快照里不含 secret、token、`secret_env*`、`script`、`command`（§13.2 的剔除规则在解析时就执行）。
- 离开卡数据：`GET /api/crew/attention`（admin，返回 `{items, gateway_ok, refreshed_ms}`，来自 `external_attention(snapshot())`）。前端只在打开离开卡时请求一次，不轮询。
- **自有 Crew 会话的审批推送（G7b，范围新增——路线图未列，价值成立、规模小，PM-R m3 同意保留）**：`record_and_broadcast`（`session_manager.rs:2051`）改为返回 `bool`：本次 `apply_posture_delta` 是否**真正新增**了一个 approval id（`apply_posture_delta` 在锁内执行，`:2069-2071`；它对已存在 id 不 push，`:3667-3672`，因此需要把「是否 push」作为返回值带出来，V18）。`emit` 把这个值返回给 fan-out；Crew fan-out 在收到 `true` 时 `tokio::spawn(maybe_push_ask(kind="approval", approval.tool_purpose || tool))`，去抖 key 为 `(user, session, "approval")`，与 ask **分 key**。其他后端的 fan-out 忽略返回值（本期只补 Crew；Claude/Codex 的审批推送不在 S6 范围）。

### 4.3 前端

- 离开卡（F3）增加一行：「Crew 外部 2 项待回答」，展开后逐条显示 `title · snippet`，**不可点击进入**（D9），附注「在 Crew/微信中回答；接入功能见后续版本」。
- **离开卡最多 3 行**（V21 / PM-R m2）：S5 F3 的行、本节 Crew 行等合计超过 3 行时，只显示按优先级排前 3 行，其余收进「更多 (N)」折叠；Crew 外部行的优先级低于本会话「需要你」类行。具体排序键由 S5 F3 定义，S6 只追加一行并遵守上限。
- 推送点击：见 §4.2 的深链；外部 slot 推送打开首页并展开 Crew 行，Crew cron 失败推送打开定时任务面板的 Crew 分段并展开该 job。

### 4.4 不变量

- 调度 tick 零改动；crew_watch 不持有任何会话进程，也不向任何 fan-out 发送输入（§3.9 的「主动拉起」走公开的 `ensure_running`，与 WS 连接时的路径相同）。
- crew_watch 是 Gateway slot / cron 快照的唯一写者；所有读方经 `snapshot()`。
- secret 不缓存，token 不入 URL（不走 WS，只做 REST）。

### 4.5 边界与测试

| 情形 | 期望 | 测试 |
|---|---|---|
| 微信 slot 刚回复（waiting_for_input=true） | 不推送 | `slot_attention_edges` 单测 |
| 外部 slot 的 needs_input 从 false 变 true | 推 1 次，正文以「在 Crew/微信回答」结尾；5 分钟内保持 true 或抖动都不再推 | 单测 |
| zmx 自有 slot 的 needs_input | 不由 crew_watch 推送 | 单测：own 集合 |
| 启动首轮 | 不推送 | 单测 |
| cron failure / timeout / cancelled | 前两者推送且带 `url`，cancelled 不推 | `cron_failures` 单测 |
| Gateway 挂掉 | 退避；`snapshot().gateway_ok=false` 且保留上一轮数据；`/api/crew/attention` 返回 `gateway_ok:false`；离开卡隐藏该行 | 单测退避函数 + handler 单测 |
| Gateway 挂起（接受连接不回应） | 20s 超时，下一轮继续 | 用本地挂起 TCP 做集成测试 |
| `snapshot()` 在刷新中被读 | 立即返回旧 Arc，不阻塞 | 单测：持有旧 Arc 期间替换，旧 Arc 内容不变 |
| 快照字段剔除 | 序列化结果不含 `secret`、`script`、`command` | 夹具单测 |
| G7b 同一 approval id 重复到达 | 只推 1 次；5 分钟内先推 ask 再来审批，两者都推 | `record_and_broadcast` 返回值单测 + 去抖分 key 单测 |
| 深链 `?panel=scheduled&seg=crew&job=x` | 打开面板、选中 Crew 分段、展开 x；URL 被消费 | 前端单测 |
| `url` 缺省 | SW 行为与现状一致 | SW 单测（或手测清单） |

---

## 5. F7 摘要卡 review 动作（T5）

### 5.1 现状（已核实）

- `TurnSummaryCard` 的 props 为 conclusionText/fullText/files/steps/cost/errored/expanded/onExpand/onOpenChanges（`components/turn/TurnSummaryCard.tsx:10`）；文件 chip 统一调用 `onOpenChanges`，无法定位到单个文件（`:32-35`）。
- `TurnView` 由 `AcpChatView` 渲染（`AcpChatView.tsx:361-362`）；composer 的输入状态是 `AcpChatView` 本地的 `input`（`:151`）。
- verdict 接口：`POST /api/sessions/{id}/runs/{run_id}/verdict`（`web.rs:59`、`:1335-1349`）→ `set_human_verdict` **只修改内存中的 `run_metrics`**（`session_manager.rs:896-910`）；run_metrics 的 ndjson 是只追加的审计日志，应用从不回读（`run_metrics.rs:200-204`）。因此**重启后 verdict 和 run 记录都会丢失**，该接口会返回 404。前端封装为 `postRunVerdict`（`lib/api/sessions.ts:191-202`）。
- `RunMetric.turn_seq` 与转录中的 `turnId` 取值同源：fan-out 用 `turn_seq` 给事件打戳（`session_manager.rs:3693-3710`）并构建 metric（`:4006`）。
- 提交 prompt：`commitPrompt(workDir)`（`lib/gitviewer.ts:6-7`）；`SendToMenu` 支持 `sameDirOnly` 和 `confirmDanger`（`SendToMenu.tsx:28-46`）。**GitViewer 的「让 agent 提交」不带确认，只有「撤销改动」带 `confirmDanger`**（`GitViewer.tsx:382-388`）。

### 5.2 设计

- 只在最后一个 complete 且 `!errored` 的组上显示动作行（D12），位置在 chip 行下方：`采纳 ✓ · 打回 ↩ · 提交…`（其中「提交…」仅在 `files.length > 0` 时出现）。
- **采纳**（V12，D13）：点击后立刻把动作行替换为「已采纳 ✓」（组件本地状态，按 turnId 记忆）；**若 `files.length > 0`，同时直接打开「提交…」的 `SendToMenu`**（锚点为采纳按钮），用户再点一次目标会话即完成提交——手机上 review 一轮 = 2 击。后台 best-effort：`getSessionRuns(sid, {limit: 10})` 按 `turn_seq === turnId` 找 run，再 `postRunVerdict(run_id, 'good')`；**找不到 run 或 404 一律静默**，不弹 toast，不向用户承诺 verdict 已记录。
- **打回**：执行 `postRunVerdict(...,'bad')`（best-effort，失败不打扰用户），并把 composer 预填为 `打回：`，光标定位到末尾并聚焦。实现方式：`AcpChatView` 向 `TurnView` 传入 `onReject(prefix)` → `setInput(prefix)` + `composerRef.focus()`。`onReject` 要用 `useCallback` 保持引用稳定，以维持 TurnView 的 memo（`TurnView.tsx:66`，I-9）。
- **提交…**：打开 `SendToMenu`，参数为 `text=commitPrompt(workDir)`、`sameDirOnly`，**不带 `confirmDanger`**（V12：与 GitViewer 的提交按钮一致；提交是可撤销的常规动作，只有撤销改动需要确认）。它需要 shell 的 `sendTo`，由 `AppShell` 经 `AcpChatView` 的新 prop `sendTo` 传入（与 ContextPanel 相同的对象，`AppShell.tsx:128-130`）。
- 手机：动作行使用 `flex-wrap`，每个按钮保证 ≥44px 高的触控区（`ctl`），不显示图标以外的装饰；卡片内不嵌入回复框（沿用既有决议「卡片内不嵌回复」），「打回」跳转到 composer。

### 5.3 边界与测试

- 最后一组出错 → 不显示动作；新 turn 开始后，旧卡片上的动作消失。
- 双击采纳 → 第二次点击无效（本地状态已是 ✓）。
- verdict 404 / run 不存在 → 无 toast，✓ 照常显示（V12）。
- `files.length === 0` 时采纳只显示 ✓，不弹菜单；`> 0` 时弹出 `SendToMenu` 且 `confirmDanger` 为 undefined。
- `App.characterization.test.tsx` 保持绿色，不改动。
- 新增单测：`TurnSummaryCard` 在 `actions` 存在或缺失两种情况下的渲染；采纳在有/无文件时的分支；TurnView 的 memo 在 `onReject` 引用稳定时不重渲染。

### 5.4 F7b 文件 chip 定位单文件（T6，独立 task）

- `openChanges(sid, file?)`（`AppShell.tsx:103`）→ `setContext(sid, {open:true, tab:'git', nonce, file})`；`ContextPanel` 把 `initialFile` 传给 `GitViewer`（`ContextPanel.tsx:57`）。
- `GitViewer` 的 worktree tab 在加载完成后，如果 `initialFile` 出现在 `wt.files` 中，就调用 `onSelect(initialFile)`（`GitViewer.tsx:354-358` 的选择路径）；否则停留在列表，并在顶部提示「该文件已无未提交改动」。
- chip 的 `path` 可能是相对路径，也可能是绝对路径（来自 `touchedFiles`，`lib/steps.ts:71`）；需要先转换成相对 `work_dir` 的路径再比较。
- 测试：路径归一化做纯函数单测；GitViewer 在 `initialFile` 存在或不存在两种情况下的行为。

---
## 6. F8 立即运行后打开会话（T2）

### 6.1 现状（已核实）

- **后端已经返回 `session_id`**：`run_scheduled_now` 成功时返回 `{session_id, run_id}`（`web.rs:3629`），前端类型也已声明（`lib/api/scheduler.ts:81-85`）。缺口只在前端：`handleRun` 只写一行 note（`ScheduledTasksPanel.tsx:106-115`）。
- 如果直接 `select(id)`，新会话要等下一次轮询（3s）才会出现在列表里；手机端在这段时间内会显示「该会话已不存在」（`AppShell.tsx:188-194`）。

### 6.2 设计

- `ScheduledTasksPanel` 新增 prop `onOpenSession(id)`，由 `AppShell.tsx:320` 传入 `async id => { setPanel(null); await shell.openSession(id) }`。
- `useShellState` 导出 `openSession = async (id) => { await reload(); select(id) }`，`reload` 已存在（`useShellState.ts:140`）。
- `handleRun` 成功后执行 `toast.push({ message: '「X」已启动', action: { label: '打开会话', onClick: () => onOpenSession(r.session_id!) } })`；skipped 和失败的 note 逻辑保持不变。
- 顺带处理：run 历史中已有 `session_id` 的行，也提供同一个「打开会话」按钮（成本极低，与 F8 的用户意图一致）。

### 6.3 测试

`handleRun` 在 mock 返回 session_id 时产生带 action 的 toast；缺少 session_id 时不带 action；`openSession` 先 reload 再 select（顺序断言）。

---

## 7. F5 待派发（T7，v2：服务端单表）

### 7.1 现状（已核实）

- 新建会话的唯一实现是 ⌘K 新建模式（R22）；`PaletteInit = {mode, text?}`（`AppShell.tsx:30`、`:87-93`）；`submitNew` 使用解析出的 `newType` / `resolvedDir` / `prompt`（`CommandPalette.tsx:223-230`）。
- 分诊列表底部已有「本机 tmux」`<details>` 折叠组，可以作为样式参照（`TriageList.tsx:83-101`）。
- **参照实现 `src/quick_targets.rs`**（v2 亲自 Read）：
  - 独立的 `QuickTargetStore { conn: Mutex<Connection> }`，`open(data_dir)` 打开**同一个** `~/.zeromux/zeromux.db`，`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`，失败返回 `Err(String)`（`quick_targets.rs:60-87`）；
  - 主键含 `user_id`，每个读写方法都以 `user_id` 为第一参数，`forget` 注释明写「owner-scope 与 read 对称（教训：2026-08-09 push 订阅跨用户劫持）」（`:216-227`）；
  - 纯函数（`decayed_score`、`rank`）与存储分离，单测用 `tempfile::tempdir()` 开临时库（`:230-236`）；
  - `main.rs:360-363` 以 `Arc::new(QuickTargetStore::open(..).expect(..))` 构造，挂在 `AppState.quick_targets`（`main.rs:221`）；legacy 模式下 `CurrentUser::legacy().id == "legacy"`，owner-scope 仍成立（`main.rs:358-359` 注释）；
  - 路由挂在 authed `/api/*` 组（`web.rs:79`）；DELETE 用 **query param 而不是 body**，因为 nginx 反代会丢 DELETE body（`web.rs:780-796` 注释）；
  - 前端：`lib/api/search.ts:16-23` 封装请求，`lib/quickTargetsBus.ts` 做进程内变更广播。
- 前端现有 30s / 3s 轮询：会话列表 3s（`useSessionsPoll.ts`），确认队列 30s（`:75-89`）。

### 7.2 设计

**后端 `src/backlog.rs`**（仿 `quick_targets.rs`，同库、始终开启、不依赖 OAuth）：

```sql
CREATE TABLE IF NOT EXISTS backlog_items (
    id          TEXT PRIMARY KEY,          -- uuid v4（Cargo.toml:14 已有 uuid）
    user_id     TEXT NOT NULL,
    type        TEXT NOT NULL,             -- 'claude'|'codex'|'crew'|'tmux'
    dir         TEXT NOT NULL,             -- 解析后的绝对路径（D15）
    prompt      TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL DEFAULT '',  -- 原始 ⌘K 输入，仅展示
    created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backlog_user ON backlog_items(user_id, created_ms DESC);
```

```rust
pub const MAX_ITEMS: usize = 50;          // 每用户上限；超出时删最旧的
pub struct BacklogStore { conn: Mutex<Connection> }
impl BacklogStore {
    pub fn open(data_dir: &Path) -> Result<Self, String>;
    pub fn list(&self, user_id: &str) -> Result<Vec<BacklogItem>, String>;          // ORDER BY created_ms DESC
    pub fn add(&self, user_id: &str, item: NewBacklogItem, now_ms: i64) -> Result<BacklogItem, String>;
        // 同一把锁内：INSERT，然后 DELETE 该 user 超出 MAX_ITEMS 的最旧行
    pub fn remove(&self, user_id: &str, id: &str) -> Result<bool, String>;          // WHERE id=? AND user_id=?
}
```

- 每个方法都 owner-scoped（`WHERE user_id=?`），读写对称；`remove` 对不存在或他人的 id 返回 `Ok(false)`，handler 一律 204（幂等，两设备同时删同一条不报错）。
- `AppState` 增加 `backlog: Arc<backlog::BacklogStore>`，在 `main.rs` 紧挨 `quick_targets_store` 构造（`:360` 之后）。
- 路由（authed `/api/*` 组，紧挨 `web.rs:79`）：
  - `GET /api/backlog` → `{items:[{id,type,dir,prompt,text,created_ms}]}`；
  - `POST /api/backlog`，body `{type, dir, prompt, text}` → 201 + item。校验：`type` 白名单；`dir` 过 `validate_work_dir_under_home`（`web.rs:864-877`，与建会话同一道门）；`prompt` 截断到 8000 字符（保留换行，因此不用会剥掉换行的 `sanitize_meta`，`web.rs:1247`），`text` 用 `sanitize_meta(…, 1000)`；
  - `DELETE /api/backlog?id=…` → 204（query param，理由同 `web.rs:780-783`）。
- 不做 frecency、不做衰减、不做 bump：待派发是显式清单，不是排行。

**前端**：
- `lib/api/backlog.ts`：`listBacklog / addBacklog / removeBacklog`；`lib/backlogBus.ts`（与 `quickTargetsBus.ts` 同形的 `notify/subscribe`），本 tab 内任一处增删后 notify，列表重新 GET。
- 跨设备刷新：分诊列表挂载时 GET 一次；此后随**确认队列的 30s 轮询**顺带 GET（`useSessionsPoll.ts:75-89` 的同一个 interval，失败静默），以及 `visibilitychange → visible` 时 GET 一次（手机记完切到桌面，桌面窗口获得焦点即刷新）。不新增独立 interval。
- ⌘K 新建模式：在「创建」旁边增加次按钮「存入待派发」（桌面快捷键 `⌥Enter`）；只有 `resolvedDir !== null` 时可用，存入的是解析后的值（D15），`addBacklog` 成功后关闭 ⌘K 并提示 toast「已存入待派发」；失败时保留 ⌘K 并 toast「无法保存：{原因}」。prompt 为空时也允许存入。
- 分诊列表：在「空闲」组之后、「本机 tmux」之前加入 `<details>`「待派发 (N)」，**N>0 时默认展开**（`open` 属性，V21 / PM-R m1；用户手动折叠后在本次页面生命周期内记住），N=0 时不渲染。每行显示 TypeIcon + prompt 首行 + 短目录名；点击行即「派发」，执行 `openPalette({mode:'new', text: `${type} ${dir} ${prompt}`, backlogId})`——展开态下派发 = 点行 → ⌘K 创建，共 2 击；⋯ 菜单只有「删除」一项。
- `PaletteInit` 增加 `backlogId?: string`；`submitNew` 成功后执行 `removeBacklog(backlogId)`（失败静默，下次刷新时该条仍在，用户可手动删），创建失败则保留。
- 手机：同一个折叠组，行高 ≥56px（与 TriageRow 一致）；不新增顶栏按钮。
- 体积：`api/backlog.ts` + 分组渲染约 0.8KB br，放在首屏（分诊列表需要它）。

### 7.3 边界与测试

| 情形 | 期望 | 测试 |
|---|---|---|
| 两个用户各自增删 | 互不可见、互不可删 | `BacklogStore` 单测（仿 `forget_is_owner_scoped_and_agent_specific`，`quick_targets.rs:361`） |
| 第 51 条 | 删最旧的一条，总数保持 50 | store 单测 |
| 删除不存在 / 他人的 id | 204，库内不变 | store + handler 单测 |
| `dir` 越出 $HOME 或不存在 | 400/403，不入库 | handler 单测 |
| 同一库重复 `open` | 幂等 | store 单测（两次 open 同一 tempdir） |
| 手机新增，桌面已开 | 桌面 ≤30s 或切回窗口时出现 | 前端单测：visibilitychange 触发 GET |
| 目录已被删除 | 派发时由 ⌘K 的创建错误路径显示原因（`CommandPalette.tsx:121-135`），条目保留 | 前端单测 |
| N>0 首次渲染 | `<details open>` | 前端单测 |
| GET 失败 | 保留上次列表，不清空 | 前端单测 |

---

## 8. F6 批量派发（T8）

### 8.1 现状（已核实）

- `POST /api/sessions` 支持 `initial_prompt`（`web.rs:829-836`、`:948-951`）；描述只能事后通过 `PATCH /api/sessions/{id}` 写入（`web.rs:31`，前端 `updateSession`，`lib/api/sessions.ts:123-131`）。
- `shell.create` 每创建一次都会 `setActiveId`（`useShellState.ts:157-169`），不适合在批量场景里循环调用。
- worktree 隔离是全局开关；开启时 `create_worktree` 以同步方式运行 `git worktree add`（`session_manager.rs:430-452`，调用点在 `resolve_work_dir` `:506-520`），会阻塞 tokio worker（专项 3）。
- TriageRow 第二行只在没有 snippet / step 时才回落到 `description`（`TriageRow.tsx:39`）；agent 一跑起来，「目标：X」就被挤掉（PM-R M3）。`same()` 已比较 `x.description === y.description`（`:130`）。`Badge` 只支持数字/圆点（`components/ui/Badge.tsx:1-5`），不适合文字徽标。

### 8.2 设计（D14：在 ⌘K 内完成）

- 待派发组的标题行增加「选择」开关；进入选择模式后行首出现勾选框，底部出现条「并行派发 N 项」（N ≤ 6，超过时按钮禁用并提示）。
- 点击后执行 `openPalette({mode:'new', batch: ids})`：⌘K 进入批量预览，列出每项的 type · 目录 · prompt 首行，另有一个可选输入框「目标标签」，提交后会写入每个会话的描述「目标：X」。
- 确认后，由 ⌘K 内的 `runBatch` 串行执行：`createSession(type, undefined, dir, undefined, prompt)` → 若有标签则 `updateSession(id, {description})` → `sleep(200ms)`。进度显示在预览行的 StatusDot 上（排队 / 创建中 / 完成 / 失败）。全部结束后调用一次 `reload()`，焦点不跳转；toast「已派发 4 项」附带动作「下一个」（`next()`）。
- 成功项经 `removeBacklog(id)` 从服务端待派发中移除（§7.2），失败项保留并显示原因；中途关闭 ⌘K 不会取消已经发出的请求，剩余项停止派发（循环检查 `aborted` ref）。
- **目标徽标**（V13，PM-R M3 的方案一）：TriageRow 第一行名称 `<span data-row-name>` 之后加一个文字徽标 `<span data-goal>`，内容为 `goalLabel(s.description)`——描述以「目标：」开头时取冒号后的文本、截到 8 个字符（按 char，超出加「…」），否则不渲染。样式用 `text-ui-2xs` + `--fg-subtle` 边框胶囊，`shrink-0`、`truncate`。不扩展 `Badge`（它是数字/圆点语义）。`goalLabel` 是纯函数，放 `lib/triage.ts`。徽标完全由 `description` 派生，而 `description` 已在 `same()` 中，**因此徽标天然纳入 `same()`**；不另加比较项，只补单测锁定「描述变 → 重渲染；描述不变 → 不重渲染」。
- **不做逐会话隔离**。如果服务端开启了 `--worktree-isolation`，每项创建约需 24s；由于是串行执行，最多占用 1 个 tokio worker。预览中给出提示「服务端开启了 worktree 隔离，每项约 24 秒」。前端当前无法获知该开关，本期不增加字段，只写入 README 说明。

### 8.3 边界与测试

混合 tmux 项时，`initial_prompt` 会被后端忽略（`should_send_initial_prompt`，`web.rs:844-858`），因此预览把 tmux 项标为「无 prompt」；并发防抖沿用 `creatingRef`（`CommandPalette.tsx:89-91`）。测试：`runBatch` 的纯逻辑（注入 fake API）覆盖顺序、间隔、失败保留和中止；`goalLabel` 纯函数（无前缀、空标签、>8 字、多字节字符）；TriageRow 在 agent 运行中（有 `current_step`）仍显示目标徽标；`same()` 对 description 变化返回 false。

---

## 9. 统一「子会话折叠」模型（T9，过门槛后启用）

### 9.1 门槛（唯一口径 = S7 §0.1 的门槛 T，V3）

**本文不再定义自己的门槛**，直接引用 S7 §0.1 的门槛 T，并按裁决统一约定 3 调整：

- **数据源**：journalctl 的 `zmx_usage` 埋点（S5 G2 交付 `crew_create mode={mode} agent={agent}` 与 `crew_first_prompt sid={sid}`；S5 漏了则 S7 第一个 task 补上）。**不再使用 DB 的 `lifetime_turns`**——话题模式不调用 `record_run_metric`（`session_manager.rs:839-847` 是 `lifetime_turns` 唯一累加点），会系统性少计（CTO-R M7、PM-R B3）。
- **计时起点**：两个 chip（并行话题、目标指挥）都可用之日，即 **S6 T3 上线日**（§0.1 额外约束）。
- **判定**：起点后 14 天内，`crew_first_prompt` 对应的「并行话题」或「目标指挥」会话 **≥3 次**，且这些 prompt **分布在 ≥2 个不同日期**（防一次尝鲜刷过门槛）。
- 判定命令：`journalctl -u zeromux --since <T3上线日> | grep zmx_usage`（本机已核实 INFO 级 tracing 进入 journald：`tracing_subscriber::fmt::init()`，`main.rs:242`，`journalctl -u zeromux` 近两天有 496 条 INFO）。
- **门槛未达到时不写任何 T9 代码**。G9（§13）不受 T 约束。

### 9.2 父子关系的数据来源

- **Crew conductor 的 child slot**：Gateway 在 session-control create 流程中写入 `slot._created_by = caller_key`（`KC/dashboard/session_control.py:1140-1151`），并投影为 slot 列表字段 `created_by`（`KC/dashboard/slot_projection.py:285-292`）。人自己的 tab、fork、restore 这个字段为空。parent = `ResumeToken::Crew(k)` 满足 `k == created_by` 的 zeromux Crew 会话。
- **话题（crew 模式的 topic / subagent）**：它们不是 slot，没有 HTTP 路由（R5）。列表字段 `subagents_running` 只是 bool。它们**不进入**本折叠模型，数量显示留给 G4（S7）。
- **zeromux 原生会话**：**不加 `parent_id`**（D16）。
- 实现（V19，单 owner）：`children_by_parent(&SlotsSnapshot) -> HashMap<slot_key, ChildSummary{total, running, needs_you, first_needs_you_title}>` 是 **`crew_watch.snapshot()` 之上的纯函数**，不另存一份快照、不另起轮询；其中 running = `running || subagents_running`，needs_you = `needs_input || pending_approval`。`SessionInfo` 增加 `children: Option<ChildSummary>`，由 `session_info_of`（`session_manager.rs:667`）按 resume token 查表填入——为避免在 sessions 锁内调用 crew_watch，`list_sessions`（`web.rs:997`）先取一次 `snapshot()` 算好 map 再传入。S7 的 G4/G5 代理层同样只读这份快照。G7 对这些 child slot 的推送 title 改为「{父名} ↳ {子标题}」。

### 9.3 Triage 呈现规则（D17）

- 父行的第二行在 `children.total > 0` 时优先显示 `↳ 5 项：3 运行 · 1 需要你`（数字为 0 的项省略）。
- `triage()`：当 `children.needs_you > 0` 时，父行 attention 取 `max(本身, 'ask')`（按 PRIORITY 取更靠前者），第二行改为「来自 ↳ 〈first_needs_you_title〉」。M12 相对顺序不变。
- 子项在 G6（S7）之前不单独成行。G6 上线后，被附着的 child 会话将按 PM Q1 规则单独进入「需要你」，行内注明「来自 〈父〉」，其余子项折叠在父行下。这一步的数据来源不变，届时增加 `SessionInfo.parent_session_id`（由 `created_by` 派生，不持久化）。
- 手机：与桌面相同；父行第二行 `truncate`。
- 不做：拓扑图、拖拽、`停止全部子会话`（PM Q1 的 ③ 需要附着之后才有意义，留给 S7）。

### 9.4 测试

`children_by_parent` 纯函数（空 `created_by`、多层、父会话不存在、快照 `gateway_ok=false`）；`triage()` 在 `children.needs_you` 存在时的判定；`TriageRow.same()` 比较函数纳入 `children` 签名（I-9），避免每 3s 轮询都重渲染。

---

## 10. 总体不变量对照

| 不变量 | T0 已读 | ④ | G3 | G7 / G9 | F5–F8 | 折叠 |
|---|---|---|---|---|---|---|
| fan-out 独占进程 | 不触及 | 不触及 fan-out；gate 子进程由独立任务持有 | 仍独占 WS 与 slot；轮询与补发由 process 层发起，结果回流到同一循环 | crew_watch 不持有会话；主动拉起走 `ensure_running` | F5 后端只是一张表 | 只读快照 |
| 输入只经 SessionInput | — | trigger_run → `Prompt{run_id}` | 不增加变体 | G7b 在 fan-out 内部 | 创建走 HTTP，发送走 `sessionControls` | — |
| Drop 清理 | 行删除即消失 | — | 不变；`owns_slot = crew_origin != external` | — | — | — |
| 调度 tick 不 await 阻塞 | — | gate 与 trigger_run 放在 spawn 中 | — | 独立任务 | — | — |
| 单一 owner | `read_ms` 只经一个写函数 | — | 忙闲只经 `set_crew_busy` | Gateway 快照只由 crew_watch 写 | 待派发只经 `BacklogStore` | 派生自快照 |
| R22 / 不加顶层导航 / M12 | — | — | ask 与 approval 同档 | G9 在已有面板内分段 | 新建只在 ⌘K；待派发放在分诊折叠组 | 父行复用 |
| br ≤ 330KB / lazyPanels | ≤0.5KB | 面板本来就是 lazy | ≤0.5KB | 离开卡一行 ≤0.3KB；G9 lazy | ≤1.5KB（含 T5） | ≤0.5KB（过 T 后另计） |

## 11. 风险

- crew 模式下 `/stop` 的语义未实测（§3.2）；crew_result 的完整字段未实测。已采用宽松解析，并以 `mid` 去重。
- Crew Mode 是 experimental 功能（R6）；`kind`、`slots`、`meta.crew_reply` 字段有可能改名。所有解析都是缺字段即降级（busy=false，丢弃该帧，补发跳过），不会 panic。
- **补发只能按 `crew_result` 处理**（§3.9）：持久化行无 `kind`，断连期间的 ask 只能靠 slots 帧的 `needs_input` 上升沿兜底；meta 会被当成 result（二者 outcome 相同，只差「不清 awaiting_input」，影响可接受）。
- **重启后主动拉起话题会话**会在启动时对 Gateway 发 N 次 `slot_alive`；串行 + 5s 超时，N 很小（单用户），可接受。
- 非 gated 任务在 tick 内仍 inline `.await trigger_run`（`scheduled_tasks.rs:1194`），这是已有问题，本期不修，已记录。
- F7 的 verdict 依赖内存中的 run_metrics，重启后失效；v2 已把它降为 best-effort 且静默，用户可见行为不依赖它。
- `zmx_usage` 埋点只进 journald，轮转可能丢早期数据。本机现状（2026-09-29 实测）：journal 占 583.9M，`zeromux` 单元最早一条是 2026-05-17，保留期远超 §14 所需的 28 天；每次评估时把判定命令输出另存到 `docs/superpowers/audits/` 作为留档。

---

## 12. 服务端已读 + 等人时长埋点（T0，自 S7 §10 搬入并调整）

裁决统一约定 4：原 S7 §10「跨设备已读」挪到 S6，并与北极星埋点合并为一个 task（PM-R B1、M5）。相对 S7 §10 的调整：① 增加 `wait_ms` 埋点；② 不再以「S5 F1 已上线」为硬前提写入，但**埋点**依赖 F1（否则重启后 `last_outcome_ms` 为空，算不出等待时长）；③ 本期第一个上线，以便积累 §14 的前后对比基线。

### 12.1 现状（已核实）

- 已读状态只存在 localStorage `zmx_read`（`frontend/src/lib/readState.ts:4-42`），由 `useShellState` 维护（`components/shell/useShellState.ts:78-105`）：`markViewed` 只在值变大时返回新对象（`readState.ts:36-38`），进入与离开焦点会话时各标一次（`useShellState.ts:99-105`）。triage 的 `newerThanView` 比较的是 `last_outcome_ms` 与 `lastViewedMs`（`lib/triage.ts:19-22`）。
- A3 约束：首轮 reconcile 之前不写 localStorage（`useShellState.ts:83-94`，commit `441eb61`）。
- `SessionInfo` 已有 `last_outcome`、`last_outcome_ms`（`session_manager.rs:408-409`），来自内存 `posture`（`:2127-2138`）；`sessions` 表的 ALTER 迁移是吞错式（`session_store.rs:60-66`），单列更新函数形如 `update_description`（`:133-138`）。
- 每次看都会覆盖 `lastViewedMs`，客户端拿不到历史间隔，所以「等人时长」只能在服务端写入时计算（PM-R B1）。
- tracing：`tracing_subscriber::fmt::init()`（`main.rs:242`），默认 INFO 进 journald（已实测）。

### 12.2 设计

- **DB**：`sessions` 表增加 `read_ms INTEGER`（幂等 ALTER，加在 `session_store.rs:66` 之后）。`SessionStore` 新增 `bump_read(id, ms) -> Result<(), String>`：`UPDATE sessions SET read_ms = MAX(COALESCE(read_ms,0), ?2) WHERE id=?1`（D21）。`PersistedSession` / `load_all` 读回该列；`Session` 与 `SessionInfo` 增加 `read_ms: Option<i64>`。
- **API**：`POST /api/sessions/{id}/read`，body `{ms}`，路由挂在 `web.rs:25-40` 的 sessions 组。
  - 只有 **owner** 写入才生效（`state.sessions.is_owner(&id, &user.id)`）；admin 查看别人的会话时不写，返回 204，避免替 owner 标已读。会话不存在 → 404。
  - `ms` 夹在 `[0, now+60s]` 之间。
  - 内存中的 Session 同步更新：新增 `SessionManager::mark_read(id, ms) -> Option<ReadOutcome>`，锁内执行 `old = s.read_ms; new = max(old, ms); s.read_ms = new`，并在**同一次加锁内**读出 `posture.last_outcome`、`posture.last_outcome_ms`、`source_task_id`，返回给 handler；锁外再调用 `SessionStore::bump_read`（不经过 `upsert` 全量写，与 F1 的做法一致）。
- **等人时长埋点**（北极星）：handler 拿到 `ReadOutcome { old_read_ms, new_read_ms, last_outcome, last_outcome_ms, sched }` 后，若 `last_outcome_ms` 非空、`last_outcome_ms > old_read_ms.unwrap_or(0)`、且 `new_read_ms >= last_outcome_ms`（本次读确实「看到了」这次结果），打一条：

  ```rust
  tracing::info!(target: "zmx_usage",
      "read_wait sid={sid} wait_ms={} kind={outcome} sched={}",
      new_read_ms - last_outcome_ms, sched);
  ```

  - `kind` 取 `completed|errored|timeout|cancelled`（`last_outcome` 的小写串）；`sched = source_task_id.is_some()`。
  - 同一次结果只记一次：第二次读时 `old_read_ms >= last_outcome_ms`，条件不成立。
  - 口径与 S7 门槛 T 的 `zmx_usage` 相同（同一 target、同一 journalctl 命令），不另建存储。
- **前端**：
  - 合并：`reconcileLastViewed` 之后再执行 `mergeServerRead(prev, sessions)` → 对每个 sid 取 `max(prev[sid] ?? 0, s.read_ms ?? 0)`，没有变化时返回原对象。首次运行（`firstRun`）时，如果服务端有 `read_ms`，就用它，不再用 now 作基线。
  - 上报：`markViewed` 真正改变了值之后，按 sid 去抖 2s 发一次 `POST .../read`，失败静默（下次 markViewed 时再发）。页面 `visibilitychange→hidden` 时立即 flush。
  - localStorage 继续作为离线缓存和首轮轮询之前的数据源。
- **首屏体积**：只增加一个合并纯函数和一个去抖上报函数，目标 ≤0.5KB br。

### 12.3 边界与测试

| 情况 | 行为 | 测试 |
|---|---|---|
| 手机读过，电脑还开着 | 电脑下一次 3s 轮询拿到 `read_ms`，「完成·未读」消失 | 前端单测：`mergeServerRead` |
| 电脑时钟快了 5 分钟 | 服务端把 `ms` 夹到 now+60s 以内；残余误差最多让一条结果提前 60s 显示为已读，可接受 | Rust 单测：上限夹紧 |
| 两个 tab 同时上报 | `MAX` 保证单调 | Rust 单测：先写 100 再写 50，结果为 100 |
| 非 owner（admin）上报 | 204，`read_ms` 不变，不打埋点 | handler 单测 |
| 结果完成后首次被读 | 打 1 条 `read_wait`，`wait_ms = read - outcome` | `mark_read` 返回值 + 判定纯函数单测 |
| 同一结果第二次被读 | 不打 | 纯函数单测 |
| 读的时间早于结果（旧页面迟到上报） | `new_read_ms < last_outcome_ms`，不打 | 纯函数单测 |
| 重启后（F1 已上线） | `read_ms` 与 `last_outcome_ms` 都从 DB 回填，埋点照常 | 往返单测 |
| 会话删除 | 行删除，`read_ms` 随之消失；前端 GC 沿用现有逻辑 | — |
| A3 回归 | 首轮 reconcile 之前不写 localStorage，合并逻辑不破坏这一点 | 前端单测 |
| `App.characterization.test.tsx` | 保持绿 | — |

---

## 13. G9 Crew cron 只读分段（T4b，自 S7 §5 搬入并调整，不受 T 约束）

裁决 PM M1：G9 从 S7 挪到 S6，与 T4 同期——它规模 S、不受 T 约束，并与 T4 的 Crew cron 失败推送共用同一数据源；失败推送的深链（§4.2）正是落在这里。相对 S7 §5 的调整：① 数据不再经 S7 的代理层 `gw_get_cookie` 现拉，而是读 **crew_watch 快照**（§4.2 `snapshot()`）；② 单个 job 的 run 历史仍需按需请求，放在 crew_watch 模块内作为只读函数；③ 增加 `?job=` 深链展开。

### 13.1 现状（已核实）

- `ScheduledTasksPanel` 已经懒加载（`frontend/src/components/shell/lazyPanels.ts:12`），列表视图在 `frontend/src/components/ScheduledTasksPanel.tsx:153-190`。`SegmentedControl` primitive 已存在（`components/ui/SegmentedControl.tsx:2`）。
- Crew 侧：
  - `GET /api/crons` → `{jobs:[{id,name,message,enabled,schedule,cron_expr,every_secs,last_status,agent,agent_sequence,channel,timezone,last_run_ts,next_run_ts,is_running,running_since,last_result,last_error,skip_dates,script,command,secret_env(仅 owner)…}], server_tz}`（`KC/dashboard/handlers/cron.py:2187-2290`）。
  - `GET /api/crons/history?job_id=&limit=20&offset=` → `{runs:[{run_id,job_id,job_name,status,started_at,finished_at,duration_ms,summary,error,trigger}], total}`（`:1715-1739`；本机 `~/.kiro/crew/cron-history/_index.jsonl` 的键与此一致）。
  - 两者都是 mixed 路径（`KC/dashboard/server.py:711-736`），`X-Internal-Secret` 可访问，与 crew_watch 现有请求同一认证方式。

### 13.2 API

- `GET /api/crew/crons`（admin，与 `host_tmux` 的 admin 门同构，`web.rs:1017-1018`）→ `{gateway_ok, refreshed_ms, server_tz, jobs:[{id,name,enabled,schedule,timezone,agent,channel,last_status,last_run_ts,next_run_ts,is_running,last_error(≤200 字),prompt_head(message 首行 ≤80 字)}]}`，数据来自 `crew_watch.snapshot().cron_jobs`，不发 Gateway 请求。**不透传** `secret_env*`、`script`、`command`、`last_result` 全文——这些字段在 crew_watch 解析 `CronJobView` 时就丢弃，不进入快照。
- `GET /api/crew/crons/{job_id}/runs?limit=20`（admin）→ `{gateway_ok, runs:[{run_id,status,started_at,finished_at,duration_ms,summary(≤300 字),error(≤300 字),trigger}]}`。由 `crew_watch::fetch_job_runs(job_id)` 现拉（secret 现读、`timeout(10s)`、`redirect::Policy::none()`），不写快照（快照只有 crew_watch 主循环写）。`job_id` 只允许 `[A-Za-z0-9_-]{1,64}`，否则返回 400（防止拼接路径）；深链里的 `job` 同样过这条白名单。
- Gateway 不可达时两个端点都返回 200 + `gateway_ok:false`（照 `crew_memory.rs:115-137` 的降级约定）。

### 13.3 前端

- ScheduledTasksPanel 列表视图顶部加 `<SegmentedControl>`：「ZeroMux 任务 / Crew 任务」。默认是 ZeroMux；选择只在本次页面生命周期内记住；深链 `seg=crew` 直接选中 Crew（§4.2）。
- Crew 分段是一个独立的 lazy 子组件 `CrewCronList`（在面板内部用 `lazy(() => import('./crew/CrewCronList'))`），切到这个分段时才加载。
- 行内容：StatusDot（last_status 为 error/failure 时 danger，is_running 时 running，disabled 时 muted）· 名称 · `schedule · timezone` · 「上次 3h 前 / 下次 21:00」。点击行展开最近 20 次 run，每次 run 显示 summary 或 error 的首行；深链 `job=x` 时自动展开 x 并滚动到可见。
- 顶部固定一行提示：「由 Crew 调度 · 在 Crew 仪表板中编辑」。不提供任何按钮（S7 D7：完全只读）。`refreshed_ms` 超过 2 分钟时提示行追加「数据更新于 N 分钟前」。
- 手机：面板本身就是 Sheet，SegmentedControl 使用两档宽度。

### 13.4 边界与测试

- `next_run_ts` 为 null（已禁用或一次性任务已执行）时显示「—」。`agent_sequence` 非空时，把 agent 显示为「序列 N 个」。
- Rust：`CronJobView` 解析夹具测试（字段缺失、类型错误、数组混入非对象都不 panic）；断言序列化后的字段名里不含 `secret`、`script`、`command`。`job_id` 校验：`../x`、空串、65 字符都返回 400。非 admin → 403。
- 前端：分段切换时，旧分段的请求返回后不能覆盖新分段（reqRef / `useLatestRequest`）；深链选中与展开；`gateway_ok:false` 时显示「Crew 未连接」而不是空列表。
- 首屏不含 `CrewCronList` 字符串（grep 首屏 chunk）。

---

## 14. 成功指标

所有指标都走服务端 `zmx_usage` 日志或现有 DB，**不依赖前端 console 或人工抽查手机**（PM-R m6 的同一原则）。基线窗口 = T1 上线前 14 天（T0 最先上线，就是为了让基线窗口有数据）；对比窗口 = T5 上线后 14 天。

| # | 指标 | 数据源 / 命令 | 目标 |
|---|---|---|---|
| M1 | **等人时长（北极星）**：结果产生到用户读到的间隔，p50 / p90，按 `sched` 分开看 | `journalctl -u zeromux --since … \| grep 'zmx_usage.*read_wait' \| sed 's/.*wait_ms=\([0-9]*\).*/\1/'` 排序取分位 | 对比窗口 p50 比基线下降 ≥30%；p90 不上升 |
| M2 | 预检 skipped 率：设了 gate 的任务中 `gate_clean` 占比 | `zeromux.db`：`SELECT failure_kind, count(*) FROM agent_task_runs r JOIN agent_runs_config c ON c.id=r.task_id WHERE c.gate_cmd IS NOT NULL AND r.scheduled_for_ms > ? GROUP BY 1`（受 `prune_runs` 保留 20 条限制，评估时对每个任务取当期全部留存行） | 有 gate 的任务 skipped 率 ≥50%（说明预检真的在省唤醒）；`gate_error + gate_timeout` ≤5% |
| M3 | F5 入库→派发中位时长 | T7 在 `add` / `remove(派发成功)` 两处各打一条 `zmx_usage backlog_add id=…`、`backlog_dispatch id=… age_ms=…` | 中位数 ≤ 24h；派发 / 入库 ≥ 60%（其余是手动删除或过期） |
| M4 | 话题会话健康：`crew_topics` 会话被 TimeoutKill、stuck 推送的次数 | journalctl 里 TimeoutKill / stuck 推送日志按 sid 过滤 | 0 |
| M5 | 断连补发有效：重启后补发条数与 `crew_gap` 次数 | T3 在 catch-up 结束时打 `zmx_usage crew_catchup sid=… n=… gap={bool}` | `gap=true` 占 catch-up 次数 ≤5% |
| M6 | 跨设备已读：手机读过的会话，电脑端不再显示「完成·未读」的延迟 | 手测清单（2 台设备，10 次） | 10/10 次 ≤3s |

- M1 是本期是否成功的主判据；M2–M5 是分项健康度。M1 未达标时，先按 `sched=true/false` 拆开定位是定时任务还是交互会话没有改善，再决定下一期重点。
- 评估结果写进 `docs/superpowers/audits/<日期>-s6-metrics.md`，附原始命令输出。

---

## 15. 分期（每期一个 plan）

| 期 | 内容 | 前提 | 退出标准 |
|---|---|---|---|
| S6-a | T0（§12） | S5 F1 已上线（埋点需要持久化的 `last_outcome_ms`；已读同步本身不需要） | `read_wait` 日志在生产出现；M6 手测通过 |
| S6-b | T1（§2）+ T2（§6） | 无 | §2.8 全绿；`jq -e` 配方在生产任务上跑通一次 |
| S6-c | T3（§3，含 §3.9 补发） | S5 G1、G2（三列 + `zmx_usage` 埋点）、R4、F1 | 与 G2「并行话题」chip 同日上线；**当天记为门槛 T 起点**；§3.8 / §3.9 全绿 |
| S6-d | T4（§4，含 `snapshot()` 与深链）+ T4b（§13 G9） | S6-c（T4 复用 ask 推送与去抖）；S5 F3（离开卡） | 两者同期上线；S7 代理层可以开始只读 `snapshot()` |
| S6-e | T5（§5）+ T6（§5.4） | 无 | 手机 review 一轮 2 击 |
| S6-f | T7（§7）+ T8（§8） | 无 | 手机新增 → 桌面 ≤30s 可见；批量派发 4 项成功 |
| S6-g | T9（§9） | §9.1 门槛 T 已过 | — |
| 评估 | §14 | S6-e 上线满 14 天 | 写 metrics 审计文档 |

S6-b / S6-e / S6-f 与 S6-c / S6-d 之间没有代码依赖，可并行；S6-a 必须最先合并。每期合并后都跑首屏体积检查，并更新 §1 的累计预算表。
