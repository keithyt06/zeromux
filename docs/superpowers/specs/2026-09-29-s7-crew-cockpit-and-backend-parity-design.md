# S7(P2)Crew 驾驶舱 + 后端 parity —— 设计

日期:2026-09-29
状态:v2(已按 `audits/2026-09-29-spec-review-decisions.md` 修订,待实施)
基线:`main` @ `33c2236`
上游(优先级从高到低):
- `docs/superpowers/audits/2026-09-29-kiro-final-roadmap.md`(下称「路线图」)§3 S7。本文与路线图冲突时,以路线图为准,本文 §0.3 列出的「核实后修正」除外。
- 同目录 `kiro-crew-gap-research`(下称「调研」,G*/R* 编号沿用)、`kiro-cto-draft`(②③⑧)、`kiro-cto-final`、`kiro-pm-final`(§2 子会话折叠草图)、`kiro-cto-reviews-pm`(专项 2、专项 3)。
- 形态规范:`2026-09-26-frontend-triage-focus-redesign-design.md`(R22 / M12)、`2026-09-27-focus-session-experience-design.md`(ContextPanel V1/V3)。

路径约定:`ZM/` = 仓库根;`KC/` = `~/.kiro/crew-venv/lib/python3.12/site-packages/kiro_crew/`(Crew 0.6.0,只读)。本文所有 file:line 都已在 `33c2236` 和本机 Crew 源码上亲自 Read 核实。

---

## v2 修订

输入:`audits/2026-09-29-spec-review-decisions.md`(主会话裁决,优先级最高)、`spec-review-cto.md`、`spec-review-pm.md`。v2 新增或改动的 ZM 行号都在 `33c2236` 上重新 Read 过。

| # | 修订内容 | 来源 | 影响章节 |
|---|---|---|---|
| V1 | Crew 持久化字段统一为 S5 定义的三列 `crew_mode`(`""\|crew`)、`crew_agent`、`crew_origin`(`zeromux\|external`),且 `owns_slot = crew_origin != external`。S7 不再自己新增 `crew_origin` 列,也不用 `own` 这个取值 | 裁决·统一约定 1;CTO M2/M3 | §0.4、§2.2、§3.1、§3.2、§3.6 |
| V2 | posture 持久化由 S5 的 `persist_posture(sid)` 负责;S7 的 `last_crew_meta` 仍然只存内存,不参与持久化 | 裁决·统一约定 2 | §2.2 |
| V3 | 门槛 T 只保留一套口径(journalctl `zmx_usage`),S6 引用本节。计时起点改为 S6 T3 上线日(两个 chip 都可用);14 天内 ≥3 次,且落在 ≥2 个不同日期 | 裁决·统一约定 3;CTO M7、PM B3 | §0.1、§12 |
| V4 | §10 跨设备已读(含 `read_ms`、北极星 `wait_ms` 埋点)整节移到 S6,S7 只留一行指针;D11 一并移走 | 裁决·统一约定 4;PM B1/M5 | §0.1、§0.2、§0.4、§10、§11.2、§12 |
| V5 | §5 G9 Crew cron 只读分段移到 S6,与 S6 T4 同期;S7 只留一行指针;D7 一并移走 | 裁决·S6 修订 PM M1 | §0.1、§0.2、§0.3、§0.4、§1、§5、§12 |
| V6 | **B2 replay 修复**:快照记的是 `SessionType` 的 Display(`session_manager.rs:1460`、`:78` 输出 `"crew"`),replay 读回来后(`:1521`)会再走一次 `scheduled_session_type`。修复方法是让 `scheduled_session_type` 同时接受 `"crew"`(与 `"crew-conductor"` 同义,都映射到 Crew)。Crew 臂的 `crew_agent` 和 goal 前言按**分派后的 SessionType** 推导,不看原始字符串。测试改为断言「replay 仍走 Crew conductor」 | 裁决·S7 B2;CTO B2 | §6.2、§6.4、§7.2、§7.3 |
| V7 | `upsert_config` 的 ON CONFLICT SET 加 `agent_type`(现状见 `scheduled_tasks.rs:481`,SET 里没有这一列)。`query_configs` 的 SELECT 在 `:497`/`:501` **已经**包含 `agent_type`(下标 6),核实后不用改。另外核实到 `handleToggle`(`ScheduledTasksPanel.tsx:87-104`)不带 `agent_type`,所以请求字段改成 `Option<String>`,缺省时由 handler 保留原值 | 裁决·S7 M1;CTO M1 | §6.1、§6.2 |
| V8 | 分期重排:S7-a 只做 ② Codex,单独安排 reviewer;S7-a2 = F6 + ⑧ 实测 + 7 天未唤醒;Crew fan-out 移植并入 S7-f,和 G10 一起做 | 裁决·S7 PM M6 + CTO m7 | §0.4、§6、§7、§12、§13 K4 |
| V9 | 代理层删掉 `SlotsCache`。slot 列表和父子关系只读 S6 `crew_watch` 维护的快照(单一 owner 写) | 裁决·S7 CTO m5 | §0.4、§1.2、§1.3、§2.2、§3.2、§3.3 |
| V10 | `WORKTREE_LOCK` 从 `static` 改为 `SessionManager` 字段 `worktree_lock: Arc<tokio::sync::Mutex<()>>` | 裁决·S7 CTO m6 | §0.2 D10、§9.2 |
| V11 | 附录 A 的部分唯一索引加启动自检测试 | 裁决·S7 CTO m9 | 附录 A.1、A.5 |
| V12 | 成功指标抽查改为服务端 `zmx_usage` 日志,不再依赖前端 console | 裁决·S7 PM m6 | §2.2、§2.3、§11.2 |
| V13 | G10 的 run 行注明「已派发,目标进度见子任务」 | 裁决·S7 PM m8 | §7.2 |
| V14 | 新增 §9b「7 天未唤醒」,从 S6 §2.4 / D4 移入 | 裁决·S6 CTO m3 → S7 | §9b、§12 |
| V15 | 首屏累计预算写进本 spec:去掉跨设备已读(-0.5KB),加上 7 天未唤醒(+0.3KB),S7 首屏预算为 < 2.4KB br | 裁决·S6 PM m7 | §13 K5 |

---

## 0. 决策记录

### 0.1 启用门槛(所有 Crew 可视化项共用)

**门槛 T**(S5/S6/S7 **唯一**口径,S6 §9.1 引用本节):从 **S6 T3 上线日**起算(「并行话题」和「目标指挥」两个 chip 从这天起都能用),14 天内「并行话题」(`crew_mode=="crew"`)或「目标指挥」(`crew_agent=="kirocrew-conductor"`)会话**实际使用 ≥ 3 次**,并且这些使用**分布在 ≥ 2 个不同日期**。「一次」指一个这类会话至少发出过 1 条 prompt。

- **计数口径**:S5 G2 在 `create_crew_session` 成功处打一条 `tracing::info!(target: "zmx_usage", "crew_create mode={mode} agent={agent}")`,第一条 prompt 发出时打一条 `crew_first_prompt sid={sid}`。T 的判定命令是 `journalctl -u zeromux --since <S6 T3 上线日> | grep zmx_usage`,把 `crew_first_prompt` 按 sid 去重,再按日期分组计数。**这个埋点是 S5 的交付物**;如果 S5 漏了,S7 的第一个 task 先补上,14 天从「补上之日」和「S6 T3 上线日」中较晚的那天开始算。
- 不使用 DB 的 `lifetime_turns`:话题模式不调用 `record_run_metric`,这个值会恒为 0(CTO M7)。
- **没过 T**:下表里标「T」的项**全部不做**,本 spec 直接归档。不做「先做一半看看」。
- 适用范围:

| 项 | 需要过 T | 说明 |
|---|---|---|
| G4 子任务 tab / G5 目标卡 | 是 | 路线图 §2 原文 |
| G6 外部 slot 全量接入 | 是 | 路线图 §2 原文 |
| G8 巡检徽章 | 是 | 巡检只有 conductor 才会用 |
| G10 定时任务启动 conductor(含 Crew fan-out 移植) | 是 | 没人用 conductor,就没人定时启动它;Crew fan-out 的移植只服务 G10,所以一起受 T 约束(PM M6) |
| ③ 串联(附录 A) | 是,另加「G10 不够用」的证据 | 见附录 A.0 |
| ② 定时任务支持 Codex、⑧ Codex tokens、F6 逐会话隔离、7 天未唤醒 | **否** | 不是 Crew 可视化,按各自前置条件推进 |

G9(Crew cron 只读分段,不受 T 约束)和跨设备已读已经移到 S6(V4/V5)。

### 0.2 本文拍板的 taste 决定

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| D1 | G4 话题数据来源 | **`GET /api/spawn` 按 `parent` 过滤作主干,再用最近一条 `crew_meta` 正文宽松解析出 held/排队数作补充**。**不读** `~/.kiro/crew/crew/<store>/topics.json` | topics 没有 HTTP 路由(R5);目录名是 `readable[:80]-sha256[:8]`(`KC/crew_chat.py:125-152`),属于上游私有布局,直接读等于绑死一个 experimental 的内部格式(R6) |
| D2 | 刷新机制 | tab 可见且会话处于焦点时,**每 10s 轮询一次**;不新增 WS 事件,不把 `subagent_status` 帧放行进 `AcpEvent` | 既有 Crew spec §7「第二事件通道 不做」;树状数据不进线性 transcript |
| D3 | G5 目标卡放在哪 | 放在「子任务」tab 的**头部**;不做对话区 sticky 卡 | PM 终稿 §2:不挤占手机可视高度 |
| D4 | G6 入口 | **只在 ⌘K 里**:「接入 Crew 会话:〈标题〉」,与「接入 tmux」同构;子任务 tab 里的「打开」= 已接入就切过去,否则用该 slot 标题预填 ⌘K | R22:新建/接入只走 ⌘K |
| D5 | G6 接入外部 slot 之前的历史 | **不回放**。接入时 fan-out 发一条 `System{subtype:"attached"}`,前端显示「已接入外部 Crew 会话,更早的消息请到 Crew 仪表板查看」 | 回放要把 Gateway 的消息格式翻译成 `AcpEvent` 并写入 scrollback,等于第二套翻译器 |
| D6 | G8 在手机上 | 手机顶栏**不显示**;巡检信息放在子任务 tab 头部。桌面显示在 FocusHeader 的 `ctx N%` 旁边 | 手机顶栏宽度已经满了(S3 V14) |
| D7 | (v2 移除)G9 能否编辑 | 已随 G9 移到 S6 | V5 |
| D8 | G10 的 run 何时算结束 | conductor **第一轮 turn 结束**(完成派发,并已 `monitor_start`)就 finalize。goal 本身的完成状态由 G5 / G8 展示,不挂在定时 run 上 | goal-conductor 在派发后「end your turn」(`KC/builtin_skills/goal-conductor/SKILL.md:139-140`);如果把 run 挂到 goal 完成,会让 `active_run_count` 长时间 ≥ 1,卡住 auto-update 的 E1 门 |
| D9 | ⑧ Codex 的成本 | **只填 tokens,`cost_usd` 永远是 None**,UI 继续显示「—」 | 本机 Codex 走 litellm 别名(`~/.codex/config.toml`: `model_provider="litellm"`),本地价目表无法对上真实计费 |
| D10 | F6 串行化的粒度 | 一把 `tokio::sync::Mutex<()>`,作为 **`SessionManager` 的字段** `worktree_lock: Arc<tokio::sync::Mutex<()>>`(v2:不用 `static`,见 CTO m6)。`git worktree add/remove` 全部经过它,并放在 `spawn_blocking` 里执行 | 单用户;按仓库分锁的收益不值得多一张 map。放成字段后,测试可以各自构造 manager,不共享全局锁 |
| D11 | (v2 移除)跨设备已读的合并规则 | 已随 §10 移到 S6 | V4 |
| D12 | ③ 的 verdict 匹配 | 用 `regex` crate(已经以传递依赖形式在 `Cargo.lock:2307`,本次升为直接依赖),`RegexBuilder::size_limit(64KB)`,匹配 `verdict` 全文 | 线性时间引擎,没有 ReDoS;size_limit 挡住超大模式 |
| D13 | G6 能否接入 `mode=crew` 的 slot | **只有 S6 G3 上线后才能接**;在那之前 ⌘K 里这类行置灰,显示「需要 G3」 | 没有 G3 时,crew 模式的 ack 会被当成 turn,忙闲状态和推送都会错 |

### 0.3 核实后对 audit 的修正(以本节为准)

| # | audit 原说法 | 核实结果 | 影响 |
|---|---|---|---|
| D-R3 | 调研 R3:`/api/session-ledger` 的参数「按 slot key?」;调研 §5 说所有 Crew 代理照 `crew_memory.rs` 走 cookie | **没有任何查询参数**。ledger 的身份取自请求头 `X-Session-Key`,经 `_recognize_session` 认证(`KC/dashboard/handlers/session_ledger.py:42-74`、`KC/dashboard/handlers/cron.py:1751-1800`)。该路由属于 `_STRICT_INTERNAL_API_PATHS`(`KC/dashboard/server.py:423-427`):只接受 loopback + `X-Internal-Secret`,**没有 cookie 回落** | G5 必须按 `crew_process.rs::post_json_ok` 的方式带 secret,并以 `X-Session-Key: dashboard:<slot>` 读取;走 cookie 会得到 403 |
| D-G6 | 调研 G6 / R4:`resume=Some(key)` 已经能挂到已有 slot,补 `owns_slot` 就够了 | `CrewProcess::spawn` 在 resume 时**同样会** `set_slot_project(project=work_dir)`(`ZM/src/acp/crew_process.rs:618`)。接入外部 slot 会**覆盖它的 project**,例如 conductor worker 的 cwd | G6 除了 `owns_slot=false`,还必须跳过 `set_slot_project`;`work_dir` 取该 slot 投影里的 `project` 字段 |
| D-G5 | 调研 G5:conductor 的子会话需要间接拼出来 | slot 投影里有 `created_by` 字段(`KC/dashboard/slot_projection.py:285-292`),由 session-control 的 create 写入调用方的 slot key(`KC/dashboard/session_control.py:1151`) | conductor → worker 的父子关系可以直接得到 |
| D-G4 | 调研 G4:subagent 通过 `slot` 过滤 | `GET /api/spawn` 的条目只有 `parent`(`KC/dashboard/handlers/messaging.py:716-723`),它等于 `effective_session_key(slot)` = `dashboard:<slot>`(`KC/dashboard/chat_utils.py:696-712,566-578`;crew 话题的 spawn 见 `KC/crew_chat.py:1711-1719`) | 过滤条件是 `parent == "dashboard:"+slot_key` |
| D-G8 | 调研 G8:只查 `/api/autonudge/slot/{key}` | 这个接口**只返回旧式 loop**,结构化 monitor 会被过滤掉(`KC/dashboard/handlers/autonudge.py:269-277`);结构化 monitor 要查 `/api/monitors/slot/{key}`,并且要求 owner 身份(`:330-346`,`_require_monitor_owner` `:155-176`)。conductor 的 `monitor_start` 可能产生任意一种(`KC/mcp_tools/control.py:1056-1120`,`gate=infer_monitor(...)`) | G8 两个接口都要查,合并展示 |
| D-G10 | CTO 终稿:G10「由 G2 免费得到」 | `spawn_crew_fanout` 里 `finalize_run` 出现 **0 次**(`ZM/src/session_manager.rs:3897-4204` 实数),`scheduled_session_type` 对所有值都返回 Claude(`:2639-2644`) | G10 **依赖 Crew fan-out 的移植**,不是免费的。v2:这部分移植并入 S7-f,和 G10 同期(V8) |
| D-7ff | commit `7ff2883`:`web.rs:3065` 硬编码 `agent_type:"claude"` | 行号已经漂移,现在是 `ZM/src/web.rs:3441`(create)和 `:3484`(update);`ScheduledTaskReq`(`:3388-3403`)**根本没有** `agent_type` 字段 | ② 要改请求体,不只是改一行 |
| D-⑧ | CTO 初稿 ⑧:需要实测 codex mcp-server 是否推 `token_count` | 已有**间接证据**:本机 `source=mcp` 的 rollout 里有 `event_msg` / `token_count`,结构是 `payload.info.{total_token_usage,last_token_usage,model_context_window}`(例如 `~/.codex/sessions/2026/09/13/rollout-…-01a09af6….jsonl`,2 条,info 非空);codex 0.153.4 的二进制里也有这些字符串 | rollout 落盘不等于通知推送,**仍然要按 §8.1 实测**,但成功的概率很高 |
| D7 | 路线图:只有 G4/G5/G6 需要过门槛 | 任务要求「每个 Crew 可视化项」都要过门槛 | 主会话裁决:G8/G10 加 T(依赖 conductor 用量);**G9 不加 T**(cron 已在用,门槛与其用量无关;v2 起 G9 归 S6) |
| D-B2 | v1 §6.4:「`"crew"` → Claude(未知值回落)」 | 快照写的是 `scheduled_session_type(agent_type).to_string()`(`ZM/src/session_manager.rs:1460`),Crew 的 Display 输出是 `"crew"`(`:78`);`replay_run` 从快照读回这个值(`:1521`)后再调用 `trigger_run`(`:1522`)。按 v1 的写法,conductor run 一旦 replay 就会用 Claude 执行 | V6:`"crew"` 必须映射到 Crew |
| D-M1 | v1 §6.2 第 5 点:「update 缺省时保留原值」 | `upsert_config` 的 ON CONFLICT SET 列表(`ZM/src/scheduled_tasks.rs:481`)里没有 `agent_type`。所以现状下「保留原值」天然成立,但改成 codex 也永远写不进去。SELECT(`:497`)和按下标取列(`:501`,下标 6)已经包含 `agent_type` | V7:SET 加 `agent_type`,SELECT 不需要改 |

### 0.4 与 S5 / S6 的依赖

| S7 项 | 硬依赖(没有就不能开工) | 软依赖 |
|---|---|---|
| G4 / G5 | S5 G1(`crew_*` 帧可见)、S5 G2(`crew_mode` / `crew_agent` 已持久化)、S6 T4 的 `crew_watch` slot 快照(V9)、T | S6 G3(crew 模式的忙闲);G5 的「打开」依赖本期 G6 |
| G6 | S5 R4(`crew_origin` 列 + `owns_slot = crew_origin != external`,V1)、S6 `crew_watch` slot 快照、T | 接 crew 模式 slot 需要 S6 G3(D13) |
| G8 | S5 G2(才能识别 conductor 会话)、T | — |
| G10 | 本期 S7-f 的 Crew fan-out 移植(§6.5)、S7-a 的 `settle_scheduled_run` 抽取、S5 G2、T | S6 F8(`run_now` 返回 session_id) |
| ③ | S7-a、S7-f,G10 已上线并有证据说明不够用 | — |
| ② Codex / ⑧ / F6 | 无(F6 的前端开关挂在 S6 F6 批量派发上) | S6 F6 |
| 7 天未唤醒(§9b) | S6 T1 预检(`gate_cmd` / `gate_since_ms` 列与 `mark_woken` 写入点)、S5 F3 离开卡 | — |

G9 与跨设备已读已移到 S6(V4/V5),本表不再列出。

S4 衔接(路线图 §4):S7 的前端部分必须等 S4 上线稳定 2 天以上再动;S7 不改 TerminalView 和键栏。

### 0.5 非目标

- 治理、权限、沙箱、审计、配额。Crew 源码里的 grant、approval gate、SEL、redaction 只作为背景。
- G11 workflow run 视图、G12 pipeline 看板、G14 task runner、G15 Members。
- 任何**写** Crew 的操作:话题的 steer/stop/continue、ledger 写入、monitor 创建/停止、改 slot 的 mode 或 trust。(cron 的只读视图 G9 已归 S6。)
- 新的 WS 事件通道;把 `subagent_*` 帧放进 transcript。
- DAG、fan-in、条件分支 DSL(③ 只做单链)。
- Codex 的计费价目表(D9)。
- 回放外部 slot 在接入之前的历史(D5)。

---

## 1. 共享:Crew 只读代理层(G4/G5/G6/G8 共用)

### 1.1 现状

- 现有的代理只有记忆一处:`ZM/src/crew_memory.rs:75-80`(每次请求现读 secret,再 mint token)、`:92-94`(用 cookie `mc_token_<port>`)、`:98-114`(`get_json`)、`:115-137`(Gateway 不可达时返回 200 + `gateway_ok:false`)。路由挂在 authed `/api/*` 组(`ZM/src/web.rs:72-77`)。
- 带 secret 的 REST 请求只有 `crew_process.rs::post_json_ok`(`ZM/src/acp/crew_process.rs:305-317`)。
- Gateway 侧的认证分三类:
  - mixed 路径(cookie 或 secret 都行):`/api/spawn`、`/api/chat`、`/api/crons`(`KC/dashboard/server.py:711-736`);
  - strict 路径(只认 secret):`/api/session-ledger`(`:423-427`);
  - 其余路径只认 cookie。`/api/autonudge*`、`/api/monitors*` 都在这一类。

### 1.2 设计

新建模块 `ZM/src/crew_proxy.rs`(不塞进 `crew_memory.rs`,后者职责是记忆读写)。

```rust
/// 只读。所有函数失败都返回 Err(String)，且错误串不含 token/secret（照 crew_memory.rs:98 注释）。
async fn gw_get_cookie(state, path) -> Result<Value, String>      // mint token → Cookie（mixed + cookie-only 路径）
async fn gw_get_secret(state, path, session_key: Option<&str>) -> Result<Value, String>
    // X-Internal-Secret 现读；session_key=Some 时加 X-Session-Key（strict 路径）
// v2：不再有 SlotsCache。slot 列表读 S6 crew_watch 的快照（见下）。
```

- **slot 数据只有一个 owner(V9,CTO m5)**:S6 T4 的 `crew_watch` 每 30s 拉一次 `GET /api/chat/slots`,它是 slot 列表和 `children_by_parent`(S6 §9.2)**唯一的写者**。S7 代理层在 `crew_watch` 上新增一个只读访问器 `crew_watch::slots_snapshot() -> Option<SlotsSnapshot{at_ms, gateway_ok, slots: Vec<Value>}>`,返回一份克隆(快照放在 `RwLock`/`ArcSwap` 里,由 S6 实现决定;S7 只要求提供读接口)。S7 不再单独请求 `/api/chat/slots`,也不维护第二个 5s 缓存。
  - 快照最多比实时晚 30s。⌘K「接入」列表和子任务 tab 可以接受这个延迟。**只有一个例外**:接入(`POST /api/sessions` 带 `crew_attach`)时,`CrewProcess::spawn` 自己会做 `slot_alive` 校验(`ZM/src/acp/crew_process.rs:596-602`),以它为准。
  - `crew_watch` 还没跑完第一轮,或者 Gateway 不可达时,快照为 `None` 或 `gateway_ok:false`,代理层按下面的「降级」规则处理。
  - 快照里存的是 `crew_watch` 从 slot 投影里取出的原始 `Value`(字段见 §2.1)。S7 的 `project_slot` 从这份原始数据里宽松解析,不要求 `crew_watch` 预先整形出 S7 需要的字段。

- **宽松解析(R6)**:一律用 `serde_json::Value` 配合 `get().and_then(as_*)` 逐字段取值;缺字段就是 `None`;未知字段丢弃;数组元素解析失败就跳过这一条,不影响整体。所有面向前端的 DTO 字段都是 `Option`。
- **降级**:Gateway 不可达时,HTTP 仍然返回 200,body 为 `{gateway_ok:false}`。
- **不缓存 secret、token**(`crew_memory.rs:72-74` 的教训:Gateway 每次重启都会轮换 secret)。
- **超时**:沿用 `UPSTREAM_TIMEOUT`;并发请求用 `tokio::join!`,任何一个失败只让对应字段为空。
- **redirect**:`Policy::none()`(`crew_memory.rs:64-70`)。
- **authz**:所有 S7 的 Crew 代理端点都走 owner 校验。按会话查的,用 `is_owner(id)`;全局的(slot 列表),只对 admin 开放,与 `host_tmux` 的 admin 门同构(`ZM/src/web.rs:1017-1018`)。

### 1.3 不变量

- 代理层**不接触任何 fan-out**,也不持有进程;它和 `crew_memory` 一样,是纯 HTTP 转发加整形。
- 代理层**不写** slot 快照。快照只由 `crew_watch` 写(V9)。
- 前端所有异步加载都用 `useLatestRequest` / reqRef 防止旧响应覆盖新结果(memory 里 08-xx 系列的教训)。

### 1.4 测试

- `crew_proxy` 的纯函数(`project_slot`、`project_spawn`、`project_ledger`、`project_patrol`)喂 `KC` 真实结构的 JSON 夹具:字段缺失、类型错误、数组里混入非对象,都不能 panic,输出里对应字段为 None。
- 夹具在 spike 阶段从本机 Gateway 只读 GET 抓取,脱敏后放进 `ZM/src/crew_proxy/fixtures/`。
- 断言:所有错误串都不含 `token=`、`mc_token_`、secret 值(构造一个假 secret,检查错误串里没有它)。

---

## 2. G4 子任务 tab + G5 目标卡【T】

### 2.1 现状

- ContextPanel 只有三个 tab:agent 会话是 `['git','files','runs']`,tmux 是 `['git','files']`(`ZM/frontend/src/components/shell/ContextPanel.tsx:9,43`);`ContextTab` 类型在 `ZM/frontend/src/components/shell/useShellState.ts:14`。手机端整个面板本来就是 `Sheet side="bottom"`(`ContextPanel.tsx:72-78`)。懒加载注册表在 `ZM/frontend/src/components/shell/lazyPanels.ts:1-14`。
- Crew 侧的数据:
  - subagent 列表 `GET /api/spawn` → `{agents:[{id,task,done,parent,agent,started, result|error|outcome|stopped 或 turns|last_tool|elapsed, awaiting_approval?}]}`(`KC/dashboard/handlers/messaging.py:709-750`)。
  - 话题:存储结构是 `{topic_id,active_run_id,title,digest,status,last_activity,origin_msg_id,held}`(`KC/crew_chat.py:527-535`),**没有路由**。`crew_meta` 正文是渲染好的 markdown:`- **title** — status (+n queued): digest`(`KC/crew_chat.py:1747-1756`),在用户问「在忙什么」时由 `do=meta` 分支发出(`:1626-1628`)。
  - slot 投影:`key,title,agent,mode,project,running,queue_depth,pending_approval,waiting_for_input,needs_input,last_activity_ts,last_message,origin,created_by`(`KC/dashboard/slot_projection.py:205-292`),另有 `subagents_running`(`KC/dashboard/state.py:7604`)。
  - Session ledger:`GET /api/session-ledger` → `{state:{schema,goal,phase,next,tried,artifacts,events,created_at,last_progress_at,finished_at}, events:[最近 20 条]}`(`KC/dashboard/handlers/session_ledger.py:77-89`、`KC/session_ledger.py:85,232-244`)。身份由 `X-Session-Key` 决定,经 `ledger_key` 剥掉 `dashboard:` 前缀(`KC/session_ledger.py:111-126`)。
  - conductor 的 item 存在 `artifacts["item-<n>"]` 里,值是**JSON 字符串**,结构 `{accept:{kind,…}, session, round, status∈running|waiting|pass|fail, since?, fails?}`;终态条目可能被压缩成只剩 `{round,status}`(`KC/builtin_skills/goal-conductor/scripts/ledger_entry.py:80-115,175-205`;SKILL.md:121-128、264-275)。
  - 本机 `~/.kiro/crew/ledger/` 目前**不存在**,因为从没用过。

### 2.2 数据模型 / API

**后端:posture 新增一项(fan-out 内写,只存内存)**

- `Posture` 新增 `last_crew_meta: Option<String>`(截断到 4KB);`PostureDelta` 新增 `CrewMeta(String)`,由 `posture_delta_of` 在遇到 S5 G1 产生的 `ContentBlock{summary:"crew_meta"}` 时生成,再由现有的 `apply_posture_delta`(`ZM/src/session_manager.rs:3667-3673`)写入。
- **不持久化**:重启后为空,前端显示「发一句"在忙什么"可刷新话题」。posture 的持久化统一走 S5 定义的 `persist_posture(sid)`(裁决·统一约定 2),`last_crew_meta` **不加入**它写的列:这是一份可以随时再取的概览,不值得多一列。
- 仍然由 fan-out 在 emit 路径上写入,不另开写者,满足 fan-out 独占。

**后端:新端点 `GET /api/sessions/{id}/crew/tasks`(owner 校验;非 Crew 会话返回 404)**

```jsonc
{
  "gateway_ok": true,
  "slot": { "key": "zmx-1a2b3c4d", "mode": "crew", "agent": "kirocrew-conductor",
            "queue_depth": 2, "subagents_running": true, "needs_input": false },
  "subagents": [ { "id": "…", "title": "task 首行 ≤80 字", "state": "running|done|failed|stopped|awaiting",
                   "last": "last_tool 或 result 首行 ≤120 字", "elapsed_s": 312, "turns": 7 } ],
  "children":  [ { "slot": "chat-…", "title": "…", "running": true, "needs_input": false,
                   "attached_sid": "zmx 会话 id 或 null" } ],   // 投影中 created_by == 本 slot key
  "meta_text": "最近一条 crew_meta 正文（posture）或 null",
  "ledger": null | { "goal": "…", "phase": "…", "next": "…", "round": 2,
                     "items": [ { "key": "item-3", "status": "pass|fail|running|waiting|unknown",
                                  "round": 2, "accept_kind": "pr_checks|file|human_approval|…",
                                  "session": "…", "child_slot": "chat-…|null", "fails": 1 } ],
                     "events": [ { "ts": "…", "kind": "progress", "text": "≤200 字" } ] }
}
```

各字段怎么来:

- `subagents`:`/api/spawn`,过滤 `parent == "dashboard:" + slot_key`(D-G4)。`state` 的推导:`done && error` 为 failed,`done && stopped` 为 stopped,`done` 为 done,`awaiting_approval` 为 awaiting,其余为 running。
- `children`:从 `crew_watch::slots_snapshot()` 里取 `created_by == slot_key` 的 slot(D-G5,V9)。这与 S6 §9.2 的 `children_by_parent` 同源,同一份快照,不会出现两套父子关系。`attached_sid` 在 ZeroMux 会话表里按 `ResumeToken::Crew(key)` 反查。
- `slot`:同样取自快照里 `key == slot_key` 的那一项。快照缺失时 `slot:null`。
- `ledger`:**仅当** `session.crew_agent == "kirocrew-conductor"`(S5 G2 持久化的 `crew_agent` 列,V1)时才查。请求为 `gw_get_secret("/api/session-ledger", Some("dashboard:"+slot_key))`(D-R3)。
  - 对每个 `item-*` 值:先按 JSON 字符串解码,失败就 `status:"unknown"`,其余字段为空,**不丢这一行**。
  - `round` 取所有 item 的最大值。
  - `child_slot`:用 `ledger_key` 的同款规则(剥 `dashboard:` / `dashboard_` 前缀)把 `session` 折叠后,和 `children[].slot` 比对。
- 上游只剩 `/api/spawn` 和 ledger 两个请求(slot 与 children 读快照),用 `tokio::join!` 并发。任何一个失败,只让对应字段为 `null`,并在响应里带 `errors:["ledger"]`。
- **用量埋点(V12)**:handler 每次成功返回时打一条 `tracing::info!(target: "zmx_usage", "crew_tasks_open sid={sid} conductor={bool}")`。成功指标用 journalctl 抽查(§11.2),不依赖前端 console。

**meta_text 的前端解析(纯函数 `lib/crewMeta.ts`)**

- 正则 `^- \*\*(.+?)\*\* — (\S+)(?: \(\+(\d+) queued\))?: (.*)$`,逐行匹配;匹配失败的行忽略。
- 匹配到的 title 和 subagent 的 title 做前缀模糊对齐,补上「+N 排队」和 digest;对不上的 title 作为「只在 meta 里出现的话题」单独列出,并标注「来自上次概览」。

### 2.3 前端落点

- `ContextTab` 增加 `'tasks'`,标签「子任务」。**只有 `session.type==='crew'`** 时才出现在 tabs 里。
- 组件 `components/crew/CrewTasksPanel.tsx`,在 `lazyPanels.ts` 注册为 `CrewTasksPanel`;首屏体积不变,每个 task 都要跑 `npm run build` 里的 check-size(≤ 337920 B br)。
- 结构(桌面右栏 360px,手机沿用 ContextPanel 的底部 Sheet,不再嵌套 Sheet):

```
┌ 目标卡(仅 conductor)────────────────────────┐
│ 目标:把 flaky 测试清零                        │
│ 第 2 轮 · 3/5 通过 · 1 失败 · 阶段 patrol      │  ← StatusDot + 文字
│ 下一步:等 #123 CI                             │
│ 巡检 3/24 · 下次约 2m                          │  ← G8 数据(手机只在这里显示)
│ [2 个待回答 → 回到对话]                        │  ← pending_approval / needs_input
└──────────────────────────────────────────────┘
 items(conductor)   item-3 ● pass  pr_checks  [打开]
 话题 / 子任务       ● 运行  修复登录重定向  · 312s · 7 步
                    ● 完成  调研缓存失效  「结论首行…」
 子会话(slot)       ● 需要你  chat-…  [打开]
```

- 状态点统一用 `StatusDot`,tone 沿用 `toneOf` 的映射(`ZM/frontend/src/lib/triage.ts:40-48`);不用 emoji,图标用 lucide。
- 「打开」按钮:如果 `attached_sid` 非空,就调用 `shell.select(sid)`;否则打开 ⌘K,预填「接入 Crew 会话」查询词为该 slot 的 title(D4,R22)。
- 「回到对话」:关闭 Sheet(手机)或聚焦 composer(桌面)。卡片里不嵌回复框(路线图 §4)。
- 轮询:`usePolling(10_000)`,仅在 `showing && tab==='tasks'` 时运行(ContextPanel 已有 `showing` 语义,见 `ContextPanel.tsx:47`);加上 reqRef 防旧响应覆盖。注意 slot/children 来自 30s 一轮的 `crew_watch` 快照,10s 轮询真正带来新数据的只有 subagents 和 ledger。
- `gateway_ok:false` 时显示降级条「Crew Gateway 未运行」,保留上一次的数据,并标注为灰色。
- **M12**:子任务 tab 不影响 triage 排序。需要你的 child slot 进入「需要你」这件事由 S6 G7(推送)和本期 G6(接入后)负责,本 tab 不写 triage。

### 2.4 不变量

- 不新增 `AcpEvent` 变体;`crew_meta` 的 posture 写入在 emit 路径上由 fan-out 完成。
- 三后端 parity:子任务 tab 是 **Crew 专属**,Claude/Codex 没有对应物,不需要 parity(与 CTO 终稿「crew 模式明确为 Crew 专属分支」一致)。`Posture.last_crew_meta` 对 Claude/Codex 恒为 None。
- 宽松解析:ledger item 的值格式由上游 codec 决定(`ledger_entry.py`),ZeroMux **只解码,不校验**;未知 status 显示为 unknown。

### 2.5 边界情况

| 情况 | 行为 |
|---|---|
| conductor 还没写 ledger(`state` 全空) | 目标卡显示「conductor 尚未记录目标(第 0 轮等待你确认计划)」 |
| ledger 读取返回 400 `unknown_session`(slot 已被 Gateway 回收) | `ledger:null` + `errors:["ledger"]`,卡片显示「目标记录不可读」 |
| incognito / temporary slot(`restricted_session` 403) | 同上,不重试 |
| item 被上游 rotate 压缩成 `{round,status}` | 只显示 round/status,accept/session 显示「—」,没有「打开」按钮 |
| 32 个 item(`MAX_ENTRIES`) | 列表按 status 排序:running > waiting > fail > pass;终态默认折叠 |
| `/api/spawn` 里有其他 slot 的 agent | 被 parent 过滤掉 |
| slot 已被删除(`slot_alive` false) | 整个 tab 显示「Crew slot 已不存在」 |

### 2.6 测试

- Rust:`project_ledger` 覆盖以下夹具:正常 3 个 item、值不是字符串、值是 JSON 但不是对象、嵌套过深、只有 `{round,status}`、未知 status、`artifacts` 缺失。`child_slot` 的折叠规则测试 `dashboard:chat-1`、`dashboard_chat-1`、`chat-1` 三种写法。
- Rust:`posture_delta_of` 对 `ContentBlock{summary:"crew_meta"}` 产出 `CrewMeta`,对 `crew_result` 不产出;超过 4KB 截断在字符边界上(沿用 `chars().take` 的教训)。
- 前端 vitest:`lib/crewMeta.ts` 覆盖正常行、带 `(+2 queued)`、`just started`、全角标点、行首不是 `- ` 的行被忽略。`CrewTasksPanel` 的旧响应覆盖测试:先发的慢请求后到,不能覆盖后发的快请求。
- `App.characterization.test.tsx` 不改,必须保持绿;tmux/claude 会话的 tabs 不出现「子任务」。

---

## 3. G6 外部 slot 全量接入【T】

### 3.1 现状

- 「接入 tmux」的形态:列表 `GET /api/sessions` 返回 `host_tmux`,只对 admin 开放,5s 缓存(`ZM/src/web.rs:1009-1036`);⌘K 里显示「接入 tmux:〈名〉」(`ZM/frontend/src/components/shell/CommandPalette.tsx:188-199`),点击后 `shell.create('tmux', undefined, name)`;孤儿判定在 `ZM/frontend/src/lib/hostTmux.ts:1-12`。tmux 会话的 own/external 区分由 `TmuxOrigin` 表示(`ZM/src/session_manager.rs:108-115`),并持久化到 `tmux_origin` 列(`ZM/src/session_store.rs:63`)。
- `CrewProcess::spawn(resume=Some(k))` 的行为:先 `slot_alive` 校验(`crew_process.rs:596-602`),**然后无条件调用** `set_slot_project`(`:612-624`)。`Drop` 无条件执行 `delete_slot`(`:663-683`,S5 R4 会给它加 `owns_slot` 判断)。
- `CreateSessionReq` 只有 `name/type/work_dir/tmux_target/initial_prompt`(`ZM/src/web.rs:829-836`)。

### 3.2 数据模型 / API

- **持久化(v2:S5 已交付,S7 不新增列)**:`crew_origin` 列(`zeromux` / `external`)、`Session.crew_origin`,以及 resume 路径(`ensure_running` → `spawn_crew`,`ZM/src/session_manager.rs:1832-1866`)透传 origin,都由 **S5 R4** 交付(裁决·统一约定 1,CTO M2)。`owns_slot = crew_origin != external`,**不能**用 `resume.is_none()` 推断:自建的 slot 重启后也会走 `resume=Some(k)`(`ZM/src/acp/crew_process.rs:596`)。S7 G6 只是第一个写入 `external` 的调用方。
- **CrewProcess**:`spawn(cfg, work_dir, resume, attach_external: bool)`。当 `attach_external=true` 时:
  1. 要求 `resume` 为 `Some`;
  2. **跳过 `set_slot_project`**(D-G6);
  3. `owns_slot=false`。这个值由 S5 R4 从 `crew_origin` 派生;`attach_external` 只决定是否跳过 `set_slot_project`。重启后 resume 时,`attach_external` 也要从 `crew_origin==external` 推出。
- **列表**:`GET /api/crew/slots`(admin 才可用),数据来自 `crew_watch::slots_snapshot()`(V9),返回:

```jsonc
{ "gateway_ok": true,
  "slots": [ { "key": "chat-…", "title": "…", "mode": "", "agent": "kirocrew-conductor|…",
               "project": "/home/…", "origin": "user|cron|app|system", "created_by": "…",
               "running": false, "needs_input": false, "last_activity_ts": 0,
               "attachable": true, "reason": null | "needs_g3" | "restricted" | "zmx_orphan" } ] }
```

  - 要排除的:已经被 ZeroMux 会话绑定的 key(新增 `tracked_crew_slot_keys()`,与 `tracked_tmux_names` 同构,见 `ZM/src/session_manager.rs:2493-2498`)。
  - `zmx-*` 且没有被跟踪的,标 `zmx_orphan`(与 tmux 孤儿同构,可以接入)。
  - `mode=="crew"` 且 S6 G3 尚未上线的,`attachable:false`、`reason:"needs_g3"`(D13)。
  - `memory_mode != persistent` 的,标 `restricted`,但仍然可以接入(all-trust)。
- **接入**:`POST /api/sessions`,body 增加 `crew_attach: Option<String>`(slot key),只在 `type=crew` 时有意义,并且要求 admin。
  - `work_dir` 取该 slot 投影的 `project`;为空时回落到 `$HOME`;仍然要过 `work_dir_under_home` 校验(`ZM/src/session_manager.rs:492-504`),不通过就返回 400「该 Crew 会话的 project 不在 HOME 下」。
  - `name` 默认取 slot 的 title。
  - 接入成功后,fan-out 首先 emit `System{subtype:"attached"}`(D5)。
- **关闭**:external 会话执行 `DELETE /api/sessions/{id}` 时,只移除 ZeroMux 会话;Drop 因为 `owns_slot=false` 不会删 slot。关闭确认文案:「只断开接入,Crew 会话本身保留」。

### 3.3 前端落点

- ⌘K 在**打开时**请求一次 `/api/crew/slots`(不跟 3s 的会话轮询挂钩)。这个端点只读 `crew_watch` 快照,不打 Gateway,所以连续开关 ⌘K 也没有上游开销。只有 admin 才请求。
- 有查询词时,按 `title/key/project` 用 `rankBy` 匹配,最多列出 5 行:`[CrewIcon] 接入 Crew 会话:〈title〉 · 〈project 末两段〉`。不可接入的行置灰,副文字显示原因(例如「并行话题需要 G3」)。
- 选中后执行 `shell.create('crew', undefined, undefined, { crewAttach: key })`,沿用 `runCreate` 的错误处理和 toast。
- 手机:⌘K 本来就是全屏 Sheet,不需要新增入口。
- 这一块代码放在 CommandPalette 里。CommandPalette 是首屏组件(`AppShell.tsx:20`),新增代码必须保持很小(目标 < 1.5KB br),列表类型和 `matchCrewSlots` 放进 `lib/crewSlots.ts`。

### 3.4 不变量

- fan-out 独占:接入后的会话和自建会话走完全相同的 `spawn_crew_fanout`,唯一的区别是 CrewProcess 构造时的两个布尔值。
- 普通模式 Crew 与 Claude/Codex 之间的 parity 不变;「接入」是 Crew 和 tmux 的共同能力,Claude/Codex 没有对应物。
- 宽松解析:投影缺 `project` 时回落 `$HOME`;缺 `mode` 时视为 `""`。

### 3.5 边界情况

| 情况 | 行为 |
|---|---|
| 接入之后 slot 被 Crew 侧删除 | 重连时 `slot_alive` 为 false,`spawn` 返回 Err。沿用现有的 resume_failed 回落逻辑(`ZM/src/session_manager.rs:1809-1830`),**但 external 会话不能回落成新建 slot**:把会话标记为 Ended,并提示「Crew 会话已不存在」 |
| 同一个 slot 被两个 ZeroMux 会话接入 | 列表已排除已跟踪的 key;接入时再做一次校验(加锁),命中则返回 409 |
| 接入 conductor 的 worker 后在 ZeroMux 里发 prompt | 允许(all-trust);worker 会同时收到 conductor 和人的输入,这是 Crew 自己的语义 |
| 外部 slot 正在跑一轮时接入 | WS 按 slot 过滤,从中途开始接收 chunk;这一轮的 `chat_done` 会产生一个没有 turn_start 的边界。`posture_settles` 的 `settled=false` 分支(`ZM/src/session_manager.rs:3663-3665`)已经保证不会 settle,需要补测试锁住 |
| 接入的 slot 属于 cron(`origin=cron`) | 允许;标题前缀显示「cron」 |

### 3.6 测试

- Rust:`CrewProcess::spawn(attach_external=true)` 不发 `/project`、不发 DELETE。用一个 mock Gateway(axum 测试服务器)记录收到的请求,断言请求序列只有 `GET /api/chat/slots/{k}`。
- Rust:`crew_origin` 的持久化往返,以及「重启 resume 后 `owns_slot` 仍为 false」,这两条测试**已前移到 S5 R4**(CTO M2)。S7 只补一条端到端测试:经 `crew_attach` 建出的会话写入的是 `external`,重启 resume 后既不发 `/project`,也不在 Drop 时 DELETE(这是回归重点:丢了这一位,关一个标签页就会删掉别人的 worker)。
- Rust:接入中途开始的 turn,其边界不 settle posture,不推送 turn_done。
- 前端:`matchCrewSlots` 的纯函数测试;置灰行不可选。

---

## 4. G8 巡检徽章【T】

### 4.1 现状

- FocusHeader 在桌面上显示 `ctx N%`(`ZM/frontend/src/components/shell/FocusHeader.tsx:47`)。
- Crew 侧:
  - `GET /api/autonudge/slot/{slot_key}` → `{enabled, loop: 旧式 loop|null}`,不做 owner 校验(`KC/dashboard/handlers/autonudge.py:269-277`)。
  - `GET /api/monitors/slot/{slot_key}` → `{enabled, monitor}`,要求 owner(`:330-346`)。ZeroMux 通过 `/api/token/local` mint 的 token,subject 是 `owner_id` 或 `local-app`(`KC/dashboard/handlers/core.py:2543-2553`),能通过 `is_owner_dashboard_request`(`KC/dashboard/handlers/source_providers.py:6584-6593`)。
  - loop 字段:`id,slot_key,message,idle_secs,max_cycles,cycle_count,active,last_fire_ts,created_ts,max_runtime_secs`(`KC/autonudge.py:492-518`);monitor 的公共字段见 `KC/monitoring/models.py:50-65,594-598`;`monitor_start` 默认 `max_cycles=24`(`KC/mcp_tools/_limits.py:14`)。

### 4.2 API

`GET /api/sessions/{id}/crew/patrol`(owner 校验;非 Crew 会话返回 404)→

```jsonc
{ "gateway_ok": true, "kind": "loop|monitor|none",
  "cycle": 3, "max_cycles": 24, "active": true,
  "next_in_s": 118,       // loop: last_fire_ts + idle_secs - now（下限 0，标"约"）；monitor: last_observed_at + cadence_secs - now
  "objective": "≤80 字，monitor.objective 或 loop.message 首行" }
```

两个上游用 `join!` 并发请求;monitor 存在时优先用 monitor,否则用 loop,都没有就是 `kind:"none"`。

### 4.3 前端

- 桌面:在 FocusHeader 的 `ctx` 后面加 `<PatrolBadge>`:lucide `Radar` 12px + `3/24 · 约 2m`,`text-ui-2xs`,悬停显示 objective。`kind:none` 时不渲染。
- 仅在 `session.type==='crew' && session.crew_agent` 非空时,每 30s 轮询一次;不在焦点时停止轮询。组件内联在首屏,体积目标 < 0.6KB br。
- 手机(D6):顶栏不显示;巡检信息只放在子任务 tab 的目标卡里(§2.3),两处共用同一个端点。
- 不提供编辑和停止操作。

### 4.4 边界情况 / 测试

- 如果 `max_cycles=0`(不限次),显示 `3/∞`。
- `active=false` 时显示灰色「巡检已停」。
- `last_fire_ts=0` 时,`next_in_s` 为 null,显示「待首次」。
- Rust:`project_patrol` 的夹具覆盖:两者都有(取 monitor)、只有 loop、都为 null、字段类型错误。
- 前端:`formatPatrol` 的纯函数测试。

---

## 5. (v2 移出)G9 Crew cron 只读分段

已移到 S6,与 S6 T4 同期(V5;裁决·S6 修订 PM M1),设计见 `2026-09-29-s6-gate-review-dispatch-design.md`。

---

## 6. ② 定时任务支持 Codex(S7-a;Crew 部分见 §6.5,属于 S7-f)

v2 范围调整(V8,PM M6 + CTO m7):路线图里 ② 只包括 Codex。**S7-a 只移植 Codex fan-out**,单独成一期、单独安排 reviewer。Crew fan-out 的移植只服务 G10,而 G10 受 T 约束,所以挪到 S7-f 与 G10 一起做(§6.5)。两者共用本节第 1 步抽出的 `settle_scheduled_run`,后补 Crew 的成本很低。

### 6.1 现状

- `scheduled_session_type` 对所有值都返回 Claude,注释写明了前置条件(`ZM/src/session_manager.rs:2610-2644`);`trigger_run` 用穷尽 match,Crew/Codex/Tmux 都落在共享臂(`:1429-1446`);input snapshot 记录的是实际派发类型的 Display(`:1455-1463`,关键一行是 `:1460`;Display 见 `:72-81`,Crew 输出 `"crew"`);goal 末尾拼 VERDICT 说明(`:1465-1468`)。
- `replay_run` 从快照读 `agent_type`,缺省回落 `"claude"`(`:1521`),然后原样传给 `trigger_run`(`:1522`),**会再经过一次 `scheduled_session_type`**。所以快照值必须是 `scheduled_session_type` 认识的字符串(B2)。
- Claude fan-out 的完整机制(要移植的对象):
  - 边界上 `active_run_id.take()` 后按事件类型 `finalize_run`,Error/Exit 时发 `run_failed` 推送,受 `intent_aborted` 抑制(`intent_aborted` 在 `:3004` 计算,finalize 块到 `:3052`);
  - turn_done 推送受 `active_run_id.is_none()` 门控(`:2979-2982`);
  - 在 active_run_id 窗口内把事件写入 `events.ndjson`(`:2933-2940`,`run_output_tail` 依赖它,见 `ZM/src/scheduled_tasks.rs:999-1010`);
  - `run_id` 臂会置位 `active_run_id`(`:3160-3166`);
  - Interrupt / Passthrough 抢占时调用 `finalize_active_run_if_scheduled`(`:3214,3230`,函数本体在 `:2597-2607`);
  - collect flush 时 `active_run_id=None`(`:3332`)。
- Codex fan-out(`:4205-`):`finalize_run` 出现 0 次;`run_id` 臂只是为了对称而保留的死代码(`:4344-`);turn_done 推送没有门控(`:4266-4276`)。Crew fan-out(`:3897-`)情况相同(`:3960-3972`、`:4038-4058`)。
- `create_codex_session` 没有 tagged 变体(`:1606-1660`);只有 `create_acp_session_tagged`(`:1261`)会设置 `source_task_id`。所有看门狗、`scheduled_owned` 都按 `source_task_id` 判断(`:250-264`、`:948-957`)。
- `web.rs`:`ScheduledTaskReq` 没有 `agent_type`(`ZM/src/web.rs:3388-3403`);create/update 硬编码 `"claude"`(`:3441`、`:3484`)。
- **store**:`upsert_config` 的 INSERT 列表里有 `agent_type`(`?7`),但 `ON CONFLICT(id) DO UPDATE SET` 列表里**没有**它(`ZM/src/scheduled_tasks.rs:481`),所以 update 永远改不了后端(CTO M1)。`query_configs` 的 SELECT(`:497`)和按下标取列(`:501`,`agent_type` 是下标 6)已经包含这一列,不需要改。
- 前端 `handleToggle`(`ZM/frontend/src/components/ScheduledTasksPanel.tsx:87-104`)是一次完整的 PUT,请求体里没有 `agent_type`;`ScheduledTask` 类型已经有 `agent_type: string`(`ZM/frontend/src/lib/api/scheduler.ts:16`)。
- 刻意锁定 Claude 的测试:`scheduled_agent_type_maps_to_session_type`(`ZM/src/session_manager.rs:6324-6340`)。
- Codex 本身适合无人值守:`sandbox:"danger-full-access"`、`approval-policy:"never"`(`ZM/src/acp/codex_process.rs:524-525`)。

### 6.2 设计(S7-a)

1. **抽出共用块**(不改 Claude 的行为):把 Claude 边界块里的「finalize + run_failed 推送」抽成 `fn settle_scheduled_run(mgr, sid, owner_id, active_run_id: &mut Option<String>, evt: &AcpEvent, intent_aborted: bool)`,Claude fan-out 改为调用它(逐行等价)。events.ndjson 的写入抽成 `tee_scheduled_event(&active_run_id, &evt)`。
2. **Codex fan-out 移植**(只动 Codex;Crew 在 §6.5):
   - 增加 `let mut active_run_id: Option<String> = None;`;
   - `run_id` 臂:`active_run_id = run_id.clone()`;
   - emit 之后调用 `tee_scheduled_event`;
   - 边界处:turn_done 推送加 `active_run_id.is_none()` 门;计算 `intent_aborted`,调用 `settle_scheduled_run`;
   - QueueMode::Interrupt 臂与 Passthrough 降级臂:调用 `finalize_active_run_if_scheduled(…, "interrupted")`;
   - collect flush:`active_run_id = None`;
   - 删除 Codex fan-out 里「Codex runs no scheduled tasks」这几处注释。Crew fan-out 的同类注释保留到 S7-f。
3. **tagged 构造**:`create_codex_session_tagged(…, source_task_id)`。原函数改为调用 tagged 版本并传 None。
4. **分派**:`scheduled_session_type` 增加 `"codex" → Codex`,其余(包括 `"crew"`、`"crew-conductor"`)在 S7-a 仍回落 Claude。`trigger_run` 把 Codex 从共享臂移出,调用 tagged 构造;Crew、Tmux 留在共享臂。更新 `scheduled_session_type` 的文档注释,写明 Codex 已满足前置条件。
5. **API**:`ScheduledTaskReq` 增加 `#[serde(default)] agent_type: Option<String>`,白名单在 S7-a 是 `claude | codex`(S7-f 加 `crew-conductor`),其余返回 400。
   - create:`None` → `"claude"`。
   - update:`None` → **保留 `existing.agent_type`**。这是必需的,因为 `handleToggle` 的 PUT 不带这个字段,缺省如果重置成 claude,启停一次任务就会把 Codex 任务改回 Claude。
   - **store(V7)**:`upsert_config` 的 SET 列表加 `agent_type=?7`,否则 update 时后端改不了。SELECT 不用改(见 §6.1)。
6. **前端**:TaskForm(`ZM/frontend/src/components/ScheduledTasksPanel.tsx:386-`)加一个「后端」`<select>`:Claude / Codex(S7-f 再加「Crew 目标指挥」)。TaskRow 显示 TypeIcon。`handleToggle` 不改(靠服务端「缺省保留」)。

### 6.3 不变量

- fan-out 独占:`run_id` 仍然只经 `SessionInput::Prompt` 进入,finalize 在 fan-out 内部完成。
- **后端 parity 硬要求**:每个放行的 fan-out(S7-a 是 Claude、Codex;S7-f 加 Crew)各有一条「run 永不停在 running」单测,覆盖 Result / Error / Exit / Interrupt 抢占 / collect flush 五条路径,并断言 `active_run_count()` 归零(`ZM/src/scheduled_tasks.rs:630`)。否则 auto-update 会因 `BlockedByScheduled`「永不强制穿透」而永久阻塞(`ZM/src/auto_update.rs:127`)。
- `settle_scheduled_run` 抽取前后,Claude 现有的所有测试都必须零修改通过(用来证明重构等价)。
- **快照与分派的闭环(B2)**:对每一个会被 `scheduled_session_type` 映射到非 Claude 的 SessionType `T`,都必须满足 `scheduled_session_type(&T.to_string()) == T`。否则 replay 会静默换后端。这条写成一个遍历 `[Claude, Codex, Crew]` 的单测(S7-a 先跑 Claude、Codex,S7-f 把 Crew 加进去)。
- **S7-a 独立 reviewer**:专门做 Claude↔Codex 的 parity 矩阵审查(五条路径 × 两个后端),不和其他 task 合审。

### 6.4 边界情况 / 测试

- Codex 的 `Notify::Error` 在 mid-turn 已经改为非边界 ContentBlock(memory 07-27 F-CODEX-1、08-15 F2)。移植后的 finalize **只在真正的边界上**触发,需要补测「mid-turn error 不 finalize」。
- `scheduled_agent_type_maps_to_session_type`:S7-a 翻转 codex 的断言(`"codex" → Codex`),`"crew"` 仍断言 Claude,并加上 `"crew-conductor" → Claude`(都还没放行)。S7-f 的变化见 §6.5。
- replay:Codex run 的快照记 `"codex"`,replay 仍走 Codex。测试走完整路径:`trigger_run(agent_type="codex")` → 读回快照 → `replay_run` → 断言新会话的 `SessionType::Codex`。
- store:`upsert_config` 改后端的往返测试。先写 `claude`,再用同一个 id 以 `codex` upsert,`get_config` 读回来应该是 `codex`。这条测试在改 SET 之前应该是红的。
- handler:update 请求缺省 `agent_type` 时保留 `codex`;传入 `"kiro"` 返回 400。

### 6.5 Crew fan-out 移植(S7-f,与 G10 同期)【T】

- 与 §6.2 第 2 步逐项相同,对象换成 `spawn_crew_fanout`(`ZM/src/session_manager.rs:3897-`):`active_run_id`、`run_id` 臂(`:4038-4058`)、`tee_scheduled_event`、边界处 turn_done 门(`:3960-3972`)与 `settle_scheduled_run`、Interrupt 臂的 `finalize_active_run_if_scheduled`、collect flush 置 None。和 Claude/Codex 保持 byte-symmetric。
- tagged 构造:`create_crew_session_tagged(…, source_task_id, crew_agent)`。
- **分派与 B2 修复(V6)**:`scheduled_session_type` 增加 `"crew-conductor" | "crew" → Crew`。
  - `"crew-conductor"` 是任务表单和 API 使用的标签;
  - `"crew"` 是 Crew 的 Display,也就是快照里记下的值(`:1460`、`:78`)。它必须回到 Crew,否则 conductor run 的 replay 会被 Claude 执行(CTO B2)。
  - API 白名单只加 `crew-conductor`,不接受 `"crew"`。`"crew"` 只作为快照值在 replay 路径上出现。
  - 由于 replay 传给 `trigger_run` 的是 `"crew"` 而不是 `"crew-conductor"`,**`trigger_run` 的 Crew 臂和 goal 拼接都按分派后的 `SessionType::Crew` 推导**,不看原始字符串:Crew 臂固定 `crew_agent="kirocrew-conductor"`,`scheduled_goal(stype: SessionType, prompt)` 在 `stype==Crew` 时追加 conductor 授权前言(§7.2)。
  - 限制:这个方案成立的前提是「定时任务的 Crew 变体只有 conductor 一种」。将来如果要加第二种 Crew 定时变体,快照必须改为记录任务标签(不再记 Display),并同时给老快照写兼容映射。把这一条写进 `scheduled_session_type` 的文档注释。
- 测试:
  - `scheduled_agent_type_maps_to_session_type`:把 `"crew"` 的断言从 Claude 改为 Crew,并加上 `"crew-conductor" → Crew`;`"kiro"`、`""`、`"nonsense"` 仍回落 Claude。
  - §6.3 的闭环单测把 Crew 加进去。
  - **replay 仍走 Crew**:用 mock Gateway 执行 `trigger_run(agent_type="crew-conductor")`,断言快照 `agent_type=="crew"`;再对这份快照调用 `replay_run`,断言新会话是 `SessionType::Crew`,`crew_agent=="kirocrew-conductor"`,并且发出去的 goal 里包含 conductor 授权前言。
  - 五条路径 × Crew 的「run 永不停在 running」。

---

## 7. G10 定时任务启动 conductor 会话【T】

### 7.1 现状

见 §6.1;另有:

- goal-conductor 默认会先给出计划并**等用户确认**,除非目标消息本身已经授权执行(`KC/builtin_skills/goal-conductor/SKILL.md:72-93`);
- conductor 可以在 cron 触发的场景下派发(`:357-360`);
- 派发之后它自己 `monitor_start`,然后结束当前 turn(`:136-140`)。

### 7.2 设计

- 依赖 §6.5 的 Crew 移植(同一期 S7-f),以及 S5 G2 的 `create_slot(mode, agent)`。
- `trigger_run` 的 Crew 臂:`create_crew_session_tagged(name, canonical_dir, owner, Some(task_id), crew_agent="kirocrew-conductor", mode="")`。**用普通模式**,这样 `chat_done` 边界照常出现,不依赖 G3。这个臂由 `scheduled_session_type` 返回 `SessionType::Crew` 触发,入参可以是 `"crew-conductor"`(首次触发)或 `"crew"`(replay),两种情况行为相同(V6)。
- goal 拼接(按分派后的 `SessionType::Crew` 生效,而不是按原始字符串,这样 replay 也会带上;放在 VERDICT 说明之前):

```
{prompt}

（这是定时触发的无人值守运行：计划已获授权，直接执行第 1 轮派发，不要等待确认；派发并开启巡检后结束本轮。）
```

- run 语义(D8):第一轮 turn 的边界触发 finalize。有 VERDICT 时记为 succeeded + verdict;没有时记为 succeeded + `no_verdict`(与 Claude 一致)。后续巡检轮次都是 `run_id=None` 的普通 turn,按交互 turn 推送(conductor 自己的巡检唤醒会产生 turn_done,由现有 `should_push_turn_done` 的 60s 门和 30s 去抖控制,见 `ZM/src/push.rs:301-309`)。
- 会话保留:定时创建的 conductor 会话**不会被自动删除**(Crew 会话没有 worktree,`is_safe_to_reclaim` 不适用)。用户手动关闭时 `owns_slot=true`,会删除 slot;关闭确认文案要补一句「conductor 派出的子会话由 Crew 管理,不会一起删除」(实际行为需要在 spike 时验证,见 §13 风险 K3)。
- E1:conductor 进程在 Gateway 里,不在 zeromux 的 cgroup 内,auto-update 不会杀掉它。`active_run_count` 只在第一轮期间 ≥ 1,这一轮是有界的,受 `idle_timeout_min` 看门狗约束。
- 前端:TaskForm 的「后端」下拉加上「Crew 目标指挥」(S7-f 放出),API 白名单同步加 `crew-conductor`。run 行点击后打开会话,子任务 tab 显示目标卡(G5)。
- **run 行文案(V13,PM m8)**:`agent_type=crew-conductor` 的 succeeded run,在 `runReason` 后追加一行副文字「已派发,目标进度见子任务」。原因:run 在派发后就 finalize(D8),早上看到「成功」时,goal 可能还没完成。

### 7.3 边界情况 / 测试

| 情况 | 行为 |
|---|---|
| conductor 第一轮没有派发、仍然反问(没听从授权语句) | turn 结束后记为 succeeded + `no_verdict`;会话的 `needs_input` 由 S6 G7 推送 |
| 第一轮卡在审批上(R8) | 审批卡照常推送;超时由 `idle_timeout_min` 看门狗 kill,run 记为 aborted |
| Gateway 未运行 | `create_crew_session_tagged` 返回 Err,run 记为 `spawn_failed`(现有路径,见 `ZM/src/scheduled_tasks.rs:1194-1197`) |
| 同一个任务上一次的 conductor 会话还在巡检 | overlap guard 只看 run 状态(已 finalize),新的一次会建第二个 conductor。**这是预期行为**,在任务表单里提示「每次触发都会新建一个目标指挥会话」 |

测试:
- 用 mock Gateway 驱动 Crew fan-out,一个 `chat_done` 就 finalize 为 succeeded,`active_run_count` 归零;
- goal 拼接只对 `SessionType::Crew` 生效(纯函数 `scheduled_goal(stype, prompt)`),Claude/Codex 不带授权前言;
- **replay 仍走 Crew conductor**(B2,替换 v1 的「snapshot 的 agent_type 记为 crew」):快照 `agent_type` 为 `"crew"`,`replay_run` 之后新会话是 `SessionType::Crew`、`crew_agent=="kirocrew-conductor"`,并且 goal 带授权前言。详见 §6.5。

---

## 8. ⑧ Codex tokens / 上下文(先实测)

### 8.1 实测步骤(第一个 task,结果决定是否继续)

1. 在 `codex_process.rs` 加一个 `#[ignore]` 测试 `probe_codex_notifications`:用本机 `codex mcp-server` 起一个 `CodexProcess`,在 `$TMPDIR` 下以 `--data-dir` 隔离(memory:冒烟必须隔离数据目录),发一句「reply OK」,再发一句「list files」。测试期间,通过**测试专用的** `ClientHandler` 包装,记录**所有** `codex/event` 通知的 `msg.type` 及其到达顺序(相对 tools/call 响应的先后)。
2. 执行 `cargo test probe_codex_notifications -- --ignored --nocapture`,把 `msg.type=="token_count"` 的完整 JSON 脱敏后存为 `ZM/src/acp/fixtures/codex_token_count.json`。
3. 通过条件(全部满足才继续):
   - (a) 每轮至少出现一条 `token_count`;
   - (b) `info` 非空,并包含 `total_token_usage.{input_tokens,output_tokens}`;
   - (c) 在 tools/call 响应之前到达,或者至少不晚于它。
4. 不通过:⑧ Codex 结项为「上游不推送」,UI 维持「—」,在本 spec 状态栏记一笔。**不做** rollout 文件回读(读 `~/.codex/sessions` 是跨进程读私有文件,与 D1 同理)。

已有证据(D-⑧):`source=mcp` 的 rollout 里有 `token_count`,但 `info` 可能为 null(`~/.codex/sessions/2026/06/16/…d0a7….jsonl` 中 1 条 info 为 null)。所以 (b) 必须按「可能为空」宽松处理。

### 8.2 设计(通过之后)

- `codex_process.rs`:新增 `extract_codex_token_count(&CustomNotification) -> Option<TokenCount{total_in,total_out,last_in,window}>`,挂在 `on_custom_notification` 的 else-if 链上(`ZM/src/acp/codex_process.rs:110-140`),照样用 `send_notify_nonblocking`(**不能 await**,rmcp 死锁约束)。
- 事件循环维护 `turn_start_total: Option<(u64,u64)>`:在 turn 开始时取当前 total 作为快照;发 `Result` 时填 `tokens_in = total_in - start_in`、`tokens_out = total_out - start_out`(饱和减法;快照缺失就填 None)。`cost_usd` 始终为 None(D9)。
- 附带实现上下文用量 parity:有 `window>0 && last_in` 时发 `AcpEvent::ContextUsage{used:last_in,total:window}`。FocusHeader 的 `ctx N%` 标题从「Crew 提供」改为「后端提供」。这让 Codex 与 Crew 在同一个指标上对齐。
- 前端:RunMetricsPanel 在 tokens 非空时显示 `12.3k→1.2k`,**对所有后端**都显示(Claude 已经有 tokens,见 `ZM/src/acp/process.rs:501-503`);成本列逻辑不变(`ZM/frontend/src/components/RunMetricsPanel.tsx:162-168`、`SessionLifetimeBadge.tsx:5-12`)。
- Crew:只有 `context_usage`,不做 per-turn tokens,维持现状。

### 8.3 不变量 / 测试

- 通知回调不做任何阻塞操作;`token_count` 丢失(try_send 背压)只会导致 tokens 为 None,不影响 turn 边界。
- 用夹具做单测:`info:null` 返回 None;字段缺失返回 None;两次 total 差值正确;total 回退(新 thread)时饱和为 0。

---

## 9. F6 逐会话隔离(worktree 改 spawn_blocking 并串行)

### 9.1 现状

- `create_worktree` 是同步的 `std::process::Command::output()`(`ZM/src/session_manager.rs:431-453`),由 `resolve_work_dir` 调用(`:506-527`)。后者在 async 的 `create_acp_session_tagged`(`:1271`)和 `create_codex_session`(`:1617`)里直接执行;Crew 固定传 false(`:1721`)。在 JuiceFS 上每次约 24s,会阻塞一个 tokio worker(CTO 审 PM 专项 3)。
- `remove_worktree` 同样是同步的(`:456-478`),在 `remove_session` 里调用(`:1994-2000`)。
- 隔离是全局开关 `self.worktree_isolation`(`:366`);请求体没有逐会话选项(`ZM/src/web.rs:829-836`)。

### 9.2 设计

1. `SessionManager` 增加字段 `worktree_lock: Arc<tokio::sync::Mutex<()>>`,在构造时 `Arc::new(Mutex::new(()))`(D10,V10)。**不用 `static`**:这样不依赖 `const_new` 的 feature/版本条件(CTO m6;本机 tokio 1.52.3 `features=["full"]` 下 `const_new` 可用,但字段方案与之无关),而且每个测试的 manager 各有一把锁,互不串扰。实施前用 `cargo check` 确认。
2. `async fn resolve_work_dir_async(lock: Arc<Mutex<()>>, work_dir, sid, isolation) -> (PathBuf, Option<PathBuf>)`:先 `let _g = lock.lock().await;`,再用 `tokio::task::spawn_blocking(move || resolve_work_dir(...))` 执行。同步版 `resolve_work_dir` 保留(纯函数测试 `:4568`、`:4599` 继续使用它)。
3. 两个 create 改为 `resolve_work_dir_async(...).await`;创建失败时的 `remove_worktree` 改为 `remove_worktree_async`(同一把锁 + spawn_blocking)。
4. `remove_session`(`ZM/src/session_manager.rs:1972`,worktree 清理在 `:1994-2000`)仍然是同步函数:改成把 `self.worktree_lock.clone()` 带进去,在 `Handle::try_current()` 上 `spawn` 一个 `remove_worktree_async`,不能在同步栈上 block。
5. **逐会话选项**:`CreateSessionReq` 增加 `isolation: Option<bool>`,`None` 时取全局值。`create_*` 增加参数 `isolation: bool`。Crew 仍然强制 false。
6. 前端:在 S6 F6 批量派发的对话框里加一个复选框「每个会话独立 worktree(较慢,约 25s/个)」,默认关闭。勾选后串行请求,不再用 200ms 间隔,而是等上一个返回。进度逐个显示。⌘K 单个新建**不加**这个选项(不增加首屏复杂度)。

### 9.3 不变量 / 测试

- 串行:并发发起 4 个 `resolve_work_dir_async(isolation=true)`,断言 `git worktree add` 的执行区间互不重叠(测试里注入一个计时的假 git 命令:在 PATH 前面放一个 shell 脚本,记录进入/退出时间戳)。
- 不阻塞:在一个 `current_thread` runtime 里,worktree 创建期间,另一个 `tokio::time::interval` 仍然按时 tick(假 git `sleep 2`)。
- 失败回落语义不变:worktree 创建失败时使用 base dir 并打 warn(`:519-522`)。
- 请求 `isolation:true` 但 work_dir 不是 git 仓库:静默使用 base dir(现有行为)。

---

## 9b. 7 天未唤醒(v2 从 S6 移入;S7-a2,不受 T 约束)

来源:S6 v1 §2.4 与 D4(`2026-09-29-s6-gate-review-dispatch-design.md`,本文只读引用);裁决·S6 修订 CTO m3 把它挪到 S7,S6 只保留 `gate_clean` 的 run 行展示。

### 9b.1 现状 / 依赖

- S6 T1 交付预检:`agent_runs_config.gate_cmd`、`gate_since_ms`(`gate_cmd` 最近一次变更的时间,由 handler 计算,并按裁决 M1 写进 `upsert_config` 的 SET)。预检判定 Wake 时进入 `trigger_run`。退出码按裁决 B2 反转:**exit 0 = 唤醒**,exit 1 = 跳过,其他 = 故障。
- 为什么按时间判定、不按 run 条数(S6 D4 原文的理由,沿用):run 行会被 `prune_runs` 按 `retention_n`(默认 20)裁剪(`ZM/src/scheduled_tasks.rs:931-951`),小时级任务 20 小时就裁完了,从 run 表数不出 7 天。
- `GET /api/scheduled-tasks/confirmations`(`ZM/src/web.rs:3653-3675`,handler `list_confirmations` 在 `:3658`)按 `user.id` 取确认队列,返回 `{runs, count}`。前端每 30s 轮询一次(`ZM/frontend/src/components/shell/useSessionsPoll.ts:75-88`),结果写入 `setConfirmRuns`。
- 展示位是 S5 F3 的离开卡,受 S6 PM m2「离开卡最多 3 行,其余收进更多」约束。

### 9b.2 数据模型

- `agent_runs_config` 增加 `last_woken_ms INTEGER`(预检最近一次判定 Wake 的时间),加进 `scheduled_tasks.rs:448-455` 的幂等 ALTER 列表。`TaskConfig` 增加 `#[serde(default)] last_woken_ms: Option<i64>`;`query_configs` 的 SELECT(`:497`)末尾追加这一列,按下标读取(`:501` 同步)。
- `upsert_config` **不写** `last_woken_ms`(INSERT 和 SET 里都不加),这样编辑任务不会清空它。唯一写入点是新方法 `mark_woken(task_id, now)`:`UPDATE agent_runs_config SET last_woken_ms=?2 WHERE id=?1`。
- 调用点:S6 `spawn_gated_run` 的 Wake 分支,在 `trigger_run` **之前**调用(与 S6 v1 §2.3 第 3 步的顺序相同)。只有预检的 Wake 算「唤醒」;「立即运行」和「重放」不跑预检(S6 D2),也不更新 `last_woken_ms`。这个提示要回答的问题是「预检是不是写坏了」,手动运行不能证明预检没问题。
- 如果 S6 实施时已经顺手带上了 `last_woken_ms` / `mark_woken`(S6 v1 §2.2 原本包含它们),S7-a2 直接复用,只做 §9b.3–9b.4。

### 9b.3 判定与 API

- 纯函数 `gate_silent_days(now_ms, last_woken_ms: Option<i64>, gate_since_ms: Option<i64>) -> Option<i64>`:
  - `base = max(last_woken_ms, gate_since_ms)`(None 视为不存在,两者都为 None 时返回 None,不显示);
  - `now - base ≥ 7d` 时返回 `Some(floor((now - base)/1d))`,否则返回 None。
  - 用 `gate_since_ms` 参与比较:刚改过预检命令的任务,要从改的那天起重新计 7 天。
- `list_confirmations` 的响应增加 `gate_silent: [{task_id, name, days}]`,筛选条件为 `owner_id == user.id && enabled && gate_cmd IS NOT NULL && gate_silent_days(...) is Some`,按 `days` 降序。复用现有的 30s 轮询,不新增请求。

### 9b.4 前端

- `listConfirmations()` 的返回类型加上 `gate_silent`(缺省为 `[]`);`useSessionsPoll` 顺带写入 `setGateSilent`。
- F3 离开卡每个任务显示一行「任务 X 已 N 天未唤醒,检查预检?」(`StatusDot` tone=muted),点击打开定时任务面板并进入该任务的编辑表单。多于 1 项时合并成一行「N 个预检任务 ≥7 天未唤醒」,展开后逐条列出。这样最多只占离开卡 1 行(PM m2 的 3 行上限)。
- 首屏体积:只多一个字段和一行文案,目标 < 0.3KB br(计入 §13 K5)。

### 9b.5 测试

| 情形 | 期望 | 测试 |
|---|---|---|
| `last_woken_ms=None`、`gate_since_ms`=8 天前 | 出现,days=8 | `gate_silent_days` 单测 |
| 昨天唤醒过 | 不出现 | 同上 |
| `gate_since_ms`=2 天前(刚改过命令)、`last_woken_ms`=30 天前 | 不出现 | 同上 |
| 两者都为 None | 不出现 | 同上 |
| 任务 disabled,或 `gate_cmd` 为 NULL | 不出现 | store 单测 |
| 编辑任务(upsert)之后 | `last_woken_ms` 不变 | store 往返单测 |
| 「立即运行」/ replay | `last_woken_ms` 不变 | 单测 |
| 别的用户的任务 | 不出现在我的 `gate_silent` 里 | handler 单测 |
| 离开卡有 3 个静默任务 | 只占 1 行,可展开 | 前端 vitest |

---

## 10. (v2 移出)跨设备已读同步

已移到 S6,并与北极星埋点 `zmx_usage wait_ms=…` 合并(V4;裁决·统一约定 4,PM B1/M5),设计见 `2026-09-29-s6-gate-review-dispatch-design.md`。

---

## 11. 测试与验收

### 11.1 每个 task 的通用门

- `cargo test`、`npm test`、`npm run lint`、`npm run build`(内含 check-size,限额 337920 B br)全部通过。
- 新的前端面板必须出现在 `lazyPanels.ts` 或局部 `lazy()` 里。用 grep 检查首屏 chunk 里不含 `CrewTasksPanel` 字符串(`CrewCronList` 已随 G9 归 S6)。
- 所有 Crew 代理端点都用 mock Gateway 做测试,不打真实 Gateway;真实 Gateway 只在 spike 时做只读 GET 抓夹具。
- 冒烟一律用 `--data-dir` 隔离(memory 教训:曾经写坏线上 prompts.db)。

### 11.2 成功指标

| 项 | 指标 |
|---|---|
| G4/G5 | T 过线后 2 周内,子任务 tab 打开次数 ≥ conductor 会话数。抽查方式(V12,PM m6):`journalctl -u zeromux --since <上线日> \| grep 'zmx_usage.*crew_tasks_open'` 按 sid 去重计数,再与 `crew_create agent=kirocrew-conductor` 的条数对比。手机上也能通过 SSH 执行,不依赖浏览器 console |
| G6 | 接入 → 关闭 → Crew 侧 slot 仍然存在,10/10 次 |
| ② | 生产上 Codex 定时任务连续 7 天,`active_run_count` 在每次 run 结束后都归零,auto-update 没有被 `BlockedByScheduled` 卡超过 1 个 run 时长 |
| G10 | T 过线后,conductor 定时 run 连续 7 天每次都在第一轮后 finalize,`active_run_count` 归零;replay 一次 conductor run,新会话是 Crew(B2 回归) |
| F6 | 4 个隔离会话批量派发期间,另一个终端的 WS 输入延迟 < 200ms(手测) |
| 7 天未唤醒 | 人为把某个预检任务的 `gate_since_ms` 调到 8 天前(隔离 `--data-dir` 冒烟),离开卡在 ≤30s 内出现该行;调回后消失 |

跨设备已读的指标随 §10 移到 S6。

---

## 12. 分期(每期一个 plan)

| 期 | 内容 | 前提 |
|---|---|---|
| S7-a | **只做** ② Codex(§6.1–6.4):`settle_scheduled_run` 抽取 + Codex fan-out 移植 + `create_codex_session_tagged` + `scheduled_session_type` 的 codex 臂 + API/store(`upsert_config` SET 加 `agent_type`)+ 前端「后端」下拉。**单独成一期,单独安排 reviewer 做 Claude↔Codex parity 矩阵审查** | 无 |
| S7-a2 | F6(§9)+ ⑧ 实测(§8.1)+ 7 天未唤醒(§9b) | 7 天未唤醒需要 S6 T1(预检)与 S5 F3(离开卡);F6 的前端开关需要 S6 F6;其余无前提。与 S7-a 互不依赖,可以并行 |
| S7-b | ⑧ 实现(若 §8.1 通过) | S7-a2 的 §8.1 通过 |
| S7-c | T 判定(§0.1)。未过 → 归档 §2–§4、§6.5、§7,本期结束 | S6 T3 上线满 14 天 |
| S7-d | 共享代理层(§1)+ G8(§4) | T 已过;S6 T4 `crew_watch` 快照已上线 |
| S7-e | G4/G5(§2)+ G6(§3) | T 已过;S5 R4(`crew_origin`);S6 `crew_watch` 快照;G6 接 crew 模式 slot 还需 S6 G3 |
| S7-f | Crew fan-out 移植(§6.5,含 B2 replay 修复)+ G10(§7) | S7-a(复用 `settle_scheduled_run`)、S5 G2、T 已过 |

G9 与跨设备已读已移到 S6,不再占 S7 的期次。
| 附录 A | ③ 串联 | G10 上线满 14 天,并出现 A.0 描述的「不够用」证据 |

## 13. 风险

| # | 风险 | 缓解 |
|---|---|---|
| K1 | Crew 0.6 的 Crew Mode / session-control 属于 experimental(R6),字段可能改名 | 宽松解析 + 夹具测试。上游改名时前端显示「—」,不会崩溃 |
| K2 | 用 `X-Session-Key: dashboard:<slot>` 读 ledger,相当于 ZeroMux「扮演」该 slot 的身份 | all-trust 下可以接受;只读,不调用 `/record`。如果上游收紧成 kernel-attested(`KC/dashboard/token_auth.py:2303-2312` 目前只校验 AF_UNIX 连接),G5 的 ledger 部分会降级为 null,其余照常 |
| K3 | 删除 conductor slot 时,Crew 是否会连带清理它创建的 worker,未验证 | S7-e 的 spike 在一次性测试 slot 上验证;根据结果定关闭确认文案 |
| K4 | ② 的移植涉及多个 fan-out,这是历史上出错最多的一类 | 拆成两期:S7-a 只动 Codex,并单独安排 reviewer;Crew 在 S7-f 复用已经验证过的 `settle_scheduled_run`。先证明抽取后 Claude 行为等价;每个后端五条路径的单测;§6.3 的「快照↔分派闭环」单测防止 B2 这类 replay 换后端的问题 |
| K5 | CommandPalette、FocusHeader、useSessionsPoll/useShellState 都在首屏,br 余量很小(memory:约 10KB;check-size 限额 337920 B) | **S7 首屏累计预算 < 2.4KB br**:CommandPalette「接入」< 1.5KB + FocusHeader 巡检徽章 < 0.6KB + 7 天未唤醒 < 0.3KB(v1 的跨设备已读 0.5KB 已随 §10 移到 S6)。S5–S7 的累计预算以路线图层面的那一行为准,本 spec 只对自己这 2.4KB 负责。超出时 G8 徽章改为懒加载 |

---

## 附录 A:③ 串联(可选;仅在 G10 不够用时启用)

### A.0 启用条件

G10 上线满 14 天,并且至少出现 2 次下面这种情况:用户需要「ZeroMux 任务 X 成功后,**在仓库 cwd 里**用另一个后端/提示接着跑」,而 conductor 无法覆盖。例如上游是 Codex 审查,下游是 Claude 修复,需要 E1 门和 cwd,这是 Crew cron 做不到的。没有证据就不做。

### A.1 数据模型

- `agent_runs_config` 增加:`after_task_id TEXT`、`after_when TEXT`(取值 `succeeded` | `always` | `verdict:<regex>`)。`trigger_type` 新增 `"after"`;`trigger_spec` 为空串。
- `agent_task_runs` 增加 `upstream_run_id TEXT`,并建 `CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_upstream ON agent_task_runs(task_id, upstream_run_id) WHERE upstream_run_id IS NOT NULL`(部分唯一索引:同一个上游 run 对同一个下游任务只能被消费一次)。
- 迁移沿用 `ZM/src/scheduled_tasks.rs:447-461` 的 ALTER 列表(duplicate-column 吞错,幂等)。`CREATE UNIQUE INDEX IF NOT EXISTS` 本身也幂等,但它**不走**吞错路径:创建失败(例如 SQLite 太旧、不支持部分索引)时启动直接报错,不静默。
- **启动自检(V11,CTO m9)**:建完索引后执行一次 `SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_runs_upstream'`,查不到就返回 Err。这样「索引静默缺失、唯一约束失效、同一上游被重复消费」只会表现为启动失败,不会表现为数据重复。(`rusqlite` 用 `bundled` feature,见 `ZM/Cargo.toml:26`,SQLite 版本随 crate 固定,所以实际触发的概率很低。)

### A.2 触发(在 tick 中,不在 fan-out 中)

在 scheduler tick 的 `for task in tasks` 循环里(`ZM/src/scheduled_tasks.rs:1165-1206`),给 `trigger_type=="after"` 的任务走单独一个分支:

1. 查询上游任务**最新一条终态** run:`state IN ('succeeded','failed')`,并且 `ended_ms > 下游任务 created_ms`(不追溯历史)。
2. 判断 `after_when`:
   - `succeeded`:要求 `state=='succeeded'`;
   - `always`:任意终态;
   - `verdict:<re>`:要求 `state=='succeeded'` 且 `verdict` 非空,并且被 regex 匹配(D12;正则在任务**保存时**编译校验,非法返回 400;tick 里编译失败则记 warn 并跳过)。
3. `should_skip_overlap`,然后 `claim_run`,run 的 `upstream_run_id` 设为上游 run id,`scheduled_for_ms = 上游 ended_ms`。插入时撞上唯一约束,说明已经消费过,静默跳过。
4. 之后走完全相同的 `claim_won`、`trigger_run` 路径,因此 overlap、TOCTOU、work_dir 复核、看门狗全部复用。
5. prompt 模板变量:`{{upstream.verdict}}` 替换为上游 verdict;`{{upstream.output_tail}}` 替换为 `run_output_tail(upstream_run_id, 40)`(`:999`),截断到 4KB。替换是纯文本替换,不做转义(all-trust)。

### A.3 约束

- 单链:`after_task_id` 不能指向自己;保存时沿着链向上最多走 8 跳检测环,发现环就返回 400。不支持 fan-in(一个任务只有一个上游)和多条件。
- 上游被删除:下游保持 enabled,但永远不会触发;任务行显示「上游已删除」。
- fan-out 零改动:串联只存在于 tick 和 store 中。

### A.4 前端

- TaskForm 的「触发」选择器新增「在任务 X 之后」:上游下拉选择 + 条件(成功 / 总是 / verdict 匹配),选中 verdict 匹配时出现正则输入框,并提供「用上次 verdict 试匹配」的本地预览。
- RunHistory 的行上显示「↑ 来自 〈上游任务〉 #run」链接。链状缩进视图(CTO 初稿 ⑨)不做。

### A.5 测试

- 同一个上游 run 在连续两个 tick 中只产生一个下游 run(唯一约束);并发调用两次 claim,只有一个成功。
- 启动自检:对同一个 DB 文件连续 `open` 两次都成功(迁移幂等);打开后 `sqlite_master` 里存在 `ux_runs_upstream`;写两行相同的 `(task_id, upstream_run_id)`,第二行报唯一约束错误;`upstream_run_id IS NULL` 的行可以重复(验证是部分索引)。
- 各条件的真值表;verdict 为 None 时,`verdict:` 条件为 false。
- 环检测:A→B→A 返回 400;8 跳以内的链可以保存。
- 模板替换:变量缺失时替换为空串;output_tail 超过 4KB 时截断在字符边界上。
- 下游 run 失败,不会重新消费同一个上游 run。
