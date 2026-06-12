# 定时运行：终态判定精化 + 副作用人工确认队列 + run-record/replay 设计

> **类型**:设计 spec(brainstorming 产出,待 writing-plans 转实现计划)
> **日期**:2026-06-12
> **来源灵感**:naozhi `docs/rfc/agentcore-cloud-sandbox.md` §6.1/§6.2/§7.4(三态判定 + 双跑封堵 + 确认队列)、§5/§5.1/§7.3(replay≠resume + run record)。**仅借鉴与"云"解耦的概念模式**,AgentCore 本体不引入(见 [[zeromux-naozhi-feature-inspiration]] §5 PM 判断)。
> **作用域**:`src/scheduled_tasks.rs` · `src/session_manager.rs` · `src/web.rs` · `frontend/src/components/ScheduledTasksPanel.tsx` · `frontend/src/lib/api.ts`
> **关联记忆**:[[zeromux-scheduled-tasks]] [[zeromux-session-persistence-b1]] [[zeromux-review-2026-06-07-workdir-spawn-gate]] [[zeromux-sched-dirpicker-review]]

---

## 0. TL;DR

zeromux 的无人值守(定时)agent 运行,对"任务到底跑完没、流断了是死了还是还在跑"基本是二元糊判,且**没有任何机制让"产生了外部副作用但结果未知"的任务获得人工关注**。本 spec 在**已有**的调度框架上补三件**严格增量**的事:

1. **(B) 终态精化**:把粗粒度的 `aborted` 按"为什么变未知"打上 `failure_kind`(`watchdog_timeout` / `orphaned_restart`),并允许每任务自定义 `max_runtime_min`(1–120,默认 30)。**不改 `state` 枚举、不做数据迁移。**
2. **(A) 副作用人工确认队列**(核心高价值):任务新增 `side_effects: bool`;当一个 `side_effects=true` 的运行落入"未知终态"时,进 dashboard 的"待确认"队列,人工裁决「已完成(不重放)」/「未完成→重放」。**对未知副作用永不自动重试、永不静默丢弃。**
3. **(C) run-record + replay**:trigger 时刻快照注入输入(prompt/work_dir/agent,存 SQLite),输出事件流落盘 `~/.zeromux/runs/<run_id>/events.ndjson`。replay = 用**快照**(非当前配置)重新发起一个 `replay_of` 链接的新运行。

### 关键再定性(驱动整份设计)

**zeromux 已经有 naozhi 费力才搭出来的那一半。** 现有 fanout 终态判定(`session_manager.rs:1762-1772`)已经:
- `AcpEvent::Result` → `succeeded`
- `AcpEvent::Error` / `AcpEvent::Exit` → `failed`(**有见证的死亡**,正是 naozhi 千辛万苦要的 bootstrap `exit` 帧——zeromux 作为 `AcpEvent::Exit` 白拿)
- **静默的干净 EOF 不会误判成功**:非终态事件落到 `_ => { active_run_id = Some(rid); }`(:1771),运行保持 `running`——zeromux 对 naozhi V8 实测踩的那个坑**本就保守**。

所以这不是"从零造状态机",而是**在已有保守行为之上,补"副作用驱动的人工确认工作流"**。这是 ROI 最高的真实缺口。

### 明确不做(v1 范围外)
- **keepalive 心跳(原 #D)**:让"静默但活着" vs "卡死"可区分需要改三个 ACP 后端,较重;且现有行为已保守,不紧急。**延后**。
- **AgentCore / 任何云端执行**:本体缓议(见调研 doc)。
- **自动重试**:zeromux 目前**没有**自动重试,本 spec 也**不引入**——它正是"未知副作用"的人工门控替代方案。
- **content-hash 去重快照**:v1 快照极小(一个 prompt 串 + 路径),内容寻址属过早优化。flagged 留待快照变大时复用 markdown hash-cache 模式([[zeromux-rendering-ordering-naozhi-shipped]])。

---

## 1. 背景:现状与缺口

### 1.1 现有调度运行生命周期(已核实)

- run 状态机(`scheduled_tasks.rs:211` 注释):`claimed | running | succeeded | failed | skipped | aborted`。
- `failure_kind` 是**自由文本列**(`scheduled_tasks.rs:214`),已有值:`spawn_failed`、`work_dir_rejected`、`prompt_send_failed`、`cli_error`、`cli_exited`、`no_verdict`。
- 终态写入点:
  - `session_manager.rs:1762-1772` —— fanout 在终态事件 finalize:`Result→succeeded` / `Error→failed(cli_error)` / `Exit→failed(cli_exited)`;非终态保持 `running`。
  - `trigger_run`(`session_manager.rs:843+`)—— 起步失败:`spawn_failed`/`work_dir_rejected`/`prompt_send_failed`。
  - `reconcile_orphans`(`scheduled_tasks.rs:319-323`)—— `Some(cutoff)`= 运行超 30min 的 watchdog;`None`= 启动时清理在途孤儿。两条路径都 `UPDATE ... SET state='aborted'`,**不写 `failure_kind`**。
- watchdog 在 `scheduled_tasks.rs:363`,每 60s tick,`cutoff = now - 30min` 是**全局硬编码**。
- 任务配置 `TaskConfig`(`scheduled_tasks.rs:191`):`id/owner_id/name/trigger_type/trigger_spec/tz/agent_type/work_dir/prompt/enabled/retention_n/created_ms`。已有 `retention_n`(默认 20)。
- HTTP 面(`web.rs:44-47`):`GET/POST /api/scheduled-tasks`、`PUT/DELETE /{id}`、`POST /{id}/run`、`GET /{id}/runs`。
- run 记录**不存输入快照、不存输出**——只有 `verdict` + `failure_kind` 两个文本字段。
- 持久化先例:B-1 的 `persist_meta`(`session_manager.rs:562`)→ `store.upsert`,是"文件/SQLite 为索引"的既有模式;notes 是"文件为事实源、SQLite 为查询索引"。

### 1.2 三个缺口

1. **未知终态无人管**:一个提 PR 的任务被 30min watchdog 切成 `aborted`,但 PR 可能已经提了(断流≠死)。今天它静静躺在历史里,零关注。← **最高价值缺口**。
2. **终态粒度粗**:`aborted` 不区分"卡死被切" vs "其实在干活被误杀";30min 一刀切,只读任务被误杀、长任务(跑测试+提 PR)被不公正切断。
3. **不可复现**:无法用**完全相同的输入**干净重跑一个失败任务;也没留输出去 debug "它为什么 abort"。

---

## 2. 设计总览

四个新建 nullable 列 + 两个新 `failure_kind` 值 + 三个新端点 + 一个 dashboard 面板区。**全部严格增量**:无现有列改类型/语义,旧行以 NULL 读出即当前行为,广播扇出不变量与 Drop 清理不变。

```
配置层 (agent_runs_config)         运行层 (agent_task_runs)
+ side_effects   BOOL  DEFAULT 0   + input_snapshot TEXT   (JSON, trigger 时刻冻结)
+ max_runtime_min INT  (NULL=30)   + confirm_status  TEXT   (NULL|confirmed_done|replayed)
                                   + replay_of       TEXT   (原 run_id, nullable)

failure_kind 新增值: watchdog_timeout | orphaned_restart
磁盘: ~/.zeromux/runs/<run_id>/events.ndjson   (输出流, append, best-effort)
```

---

## 3. (B) 终态状态机精化

### 3.1 终态分类法

保留 `state` 列取值不变(**无迁移**),把"我们关心的区分"放进 `failure_kind`:

| `state` | `failure_kind` | 语义 | 写入点 | replay UI |
|---|---|---|---|---|
| `succeeded` | —(或 `no_verdict`) | `AcpEvent::Result`,非 error | `session_manager.rs:1766`(不变) | 始终允许 |
| `failed` | `cli_error` / `cli_exited` | **有见证的死亡**——agent/CLI 自报 Error/Exit | `session_manager.rs:1769-1770`(不变) | 允许(= failed-clean) |
| `failed` | `spawn_failed` / `work_dir_rejected` / `prompt_send_failed` | 从未起步——连启动都没成功 | `trigger_run`(不变) | 允许(从无副作用) |
| `aborted` | **`watchdog_timeout`**(新) | 运行超时被 watchdog 放弃,无终态事件到达 → **未知** | `reconcile_orphans(Some(cutoff))` | **若 `side_effects` 则门控** |
| `aborted` | **`orphaned_restart`**(新) | zeromux 重启时在途 → **未知** | 启动 `reconcile_orphans(None)` | **若 `side_effects` 则门控** |

naozhi 三态映射:
- **success** = `succeeded`
- **failed-clean** = `failed`(任何 kind——都有见证或从未起步,副作用没"静默落地")
- **failed-transport** = `aborted` + 未知 kind(`watchdog_timeout` / `orphaned_restart`)

> **设计取舍**:把 failed-transport 折进 `aborted`+kind 而非新建 `state` 值。理由:① `failure_kind` 本就是自由文本、本就是 UI 用来解释失败的字段,加两个字符串值零风险;② `aborted` 语义本就是"我们放弃了";③ 避免任何 `state` 列迁移。代价:UI 需读 `failure_kind` 才能区分,已在 §5 数据流覆盖。

### 3.2 `reconcile_orphans` 的唯一实质改动

今天它 blanket `UPDATE ... SET state='aborted'` 且不写 kind。改为按调用路径打 kind:
- `Some(cutoff)`(watchdog)→ `failure_kind='watchdog_timeout'`
- `None`(启动清理)→ `failure_kind='orphaned_restart'`

### 3.3 每任务 `max_runtime_min`

- `agent_runs_config` 新增 nullable `max_runtime_min INT`;HTTP create/update 时钳到 **1–1440(24h)**;NULL → 沿用 30min。
  - **为何不抄 naozhi 的 ≤60min**:naozhi 那个上限是 AgentCore **云端流式连接** 60min 平台天花板(其 RFC §4.3),zeromux 跑**本机进程**无此约束。1440 只是个防手滑的合理上界(防 `99999` 这类 typo 让卡死任务永不回收),不人为掐死合法长任务(跑全测试套件 + 提 PR 可能 >2h)。
- watchdog(`scheduled_tasks.rs:363`)今天算一个全局 `cutoff`;改为按每任务的 `max_runtime_min` 判超时(NULL 落 30)。
- **SQL 形态已锁(Eng review Issue 2)——单条集合式 UPDATE,JOIN config,不要 per-task 循环**。今天 `reconcile_orphans` 是一条全表 UPDATE;天真的 per-task 做法会变成每 60s tick 对每个 enabled 任务发一条 UPDATE(latent N+1)。改为一条:
  ```sql
  UPDATE agent_task_runs SET state='aborted', failure_kind='watchdog_timeout', ended_ms=?now
  WHERE state IN ('claimed','running')
    AND started_ms < ?now - (COALESCE(
          (SELECT max_runtime_min FROM agent_runs_config WHERE id=agent_task_runs.task_id),
          30) * 60000)
  ```
  一条查询、无循环、无 N+1。启动清理路径(`orphaned_restart`)仍是无 cutoff 的全表 UPDATE(所有 `claimed/running` → `aborted`+`orphaned_restart`),与本条正交。

---

## 4. (A) `side_effects` 标志 + 人工确认队列(核心)

### 4.1 任务新增 `side_effects: bool`

`agent_runs_config` 新列,默认 `false`。用户在任务编辑器为"会动外部世界"的任务勾选(提 PR、push、写 worktree 外文件、发消息)。默认关 → 既有任务与只读任务零影响。

### 4.2 队列是派生视图,不是新表

一个运行"待确认"当且仅当:
```sql
state = 'aborted'
AND failure_kind IN ('watchdog_timeout','orphaned_restart')   -- 未知
AND task.side_effects = TRUE
AND confirm_status IS NULL
```
仅给 `agent_task_runs` 加 **一个 nullable 列 `confirm_status`**(`NULL` | `confirmed_done` | `replayed`)。队列 = 上述谓词的 `SELECT`(JOIN 任务的 `side_effects`)。处理即写 `confirm_status`,移出队列。**无独立队列表需同步。**

### 4.3 数据流

```
watchdog/启动 标记 run aborted+未知kind
        │
        ▼
GET /api/scheduled-tasks/confirmations   ← dashboard 轮询(复用现有 cron 心跳 tick)
   返回匹配谓词的 runs,每条带:
   { run_id, task_name, ended_ms, failure_kind, verdict?, partial_event_count }
        │
   人工核查(用部分输出判断 PR/commit 是否真落地)
        │
        ├─ POST .../confirmations/{run_id}/done    → confirm_status='confirmed_done'(不重放)
        └─ POST .../confirmations/{run_id}/replay  → confirm_status='replayed' 后触发 replay(§5)
```

### 4.4 UI 落点(naozhi §7.4:非独立页面)

`ScheduledTasksPanel.tsx` 内一个可折叠"待确认"区 + **attention 徽标**显示计数。每张卡片:任务名、变未知的时刻、原因(`watchdog_timeout`="超过 N 分钟上限" / `orphaned_restart`="服务器运行中重启")、捕获的 `verdict`(若有)、部分输出预览(从该 run 的 `events.ndjson` 取尾部若干事件)。两个按钮:**「确认已完成」**(不重放)/ **「确认未完成 → 重放」**。

### 4.4-bis 通知触达(CEO review Finding 1)

**问题**:本功能的全部价值是在用户**没盯着**时浮出未知失败,但若只有 dashboard 面板内的徽标,用户得主动打开面板才看得到——手机优先的产品里这是弱保证。

**v1 取触达最强、零新基建的那层**:
- 待确认计数**同时浮到主会话列表**(用户每次打开 zeromux 必经的界面),不止藏在 scheduled-tasks 面板里。`/api/scheduled-tasks/confirmations` 已返回该计数,前端在 `App.tsx`(拥有会话列表)消费即可,无新端点。
- **明确写入"延后"段(§后续工作)的依赖**:真正的"无人值守 → 推到手机"需未来的 PWA + web-push 通道(见 [[zeromux-mobile-terminal-composer]] PM 建议)。本 spec **不**引入推送基建(那是独立 feature 独立 spec),但**点名这个 gap**,不假装徽标已解决无人值守通知。
- 诚实定性:**本功能是保险,不是日用驱动**。队列仅在 `side_effects=true` 且命中 `watchdog_timeout`/`orphaned_restart` 时才填充——在个人/少用户场景属罕见但严重(静默重复提 PR、夜跑任务无下文)。便宜的保险值得做,但别过度打磨。

### 4.5 关键安全性质

`failed_transport` 上**无任何自动动作**。运行就在队列里无限等待,直到人工处理。这是整份 spec 的论点——未知的副作用结果**绝不**被静默重试或静默丢弃。(非副作用的未知运行只是作为 `aborted` 躺在历史里,永不进队列、不需要人。)

### 4.6 授权

队列与两个动作都 owner-scoped,完全照 `list_scheduled_runs`/`update_scheduled` 现有模式(`cfg.owner_id != user.id → 403`)。复用既定模式,无新授权面。

---

## 5. (C) run-record 快照 + replay

### 5.1 两个新持久化物

**① 输入快照——SQLite 列 `input_snapshot TEXT`**(决策 C:小/结构化 → SQL)。在 `claim_run`(或 `trigger_run` 起步)写入,捕获将注入的东西:
```json
{
  "prompt": "<trigger 时刻的 task.prompt>",
  "work_dir": "<解析后的 work_dir>",
  "agent_type": "claude|kiro|codex",
  "max_runtime_min": 30,
  "secrets": []
}
```
要点:此运行之后被编辑的任务(新 prompt、移动 work_dir)**不改变**对**此运行**的 replay 行为——可复现性冻结在 trigger 时刻。**secrets 红线**:即便 v1 不注入 secrets,该字段也只存**引用名,绝不存原值**——现在就立下不变量,防日后有人往里写 token。

**② 输出流——`~/.zeromux/runs/<run_id>/events.ndjson`**(决策 C:大/append → 磁盘,镜像 B-1"文件为事实源")。fanout 本就为 scrollback 序列化每个 `AcpEvent`;对携带 `run_id` 的运行,把同一份序列化事件 tee 到 append writer。`failed_transport` 时,cutoff 前流出的已落盘——正是队列卡片用来帮人判断"PR 到底提没提"的依据。

> **tee 作用域(Eng review Issue 1)**:调度会话是**长生命周期**,而 `run_id` 是**单 turn** 的(`session_manager.rs:1762` 在终态事件 `active_run_id.take()` 清空)。tee **必须严格绑定 `active_run_id == Some` 的窗口**:prompt 注入(`active_run_id` 置位)开始,finalize 边界(`active_run_id.take()`)停止。events.ndjson 只含该 run 那一个 turn 的事件。**绝不**按"整个 session 生命周期"tee——否则一个被手工复用的调度会话会把无关事件追加进该 run 的记录,污染可复现性。

### 5.2 replay 机制(决策 A)

```
POST /api/scheduled-tasks/runs/{run_id}/replay
  1. 载入 run.input_snapshot
  2. overlap 守卫:该任务若有在途 claimed/running 运行 → 409 "已有运行在途"
  3. claim_run(new_run_id, replay_of=<run_id>)        ← 新列 replay_of TEXT, nullable
  4. trigger_run(new_run_id, ...快照字段...)           ← 注入快照,非当前配置
  5. (若经队列触发) 原 run.confirm_status = 'replayed'
```
- **复用加固过的路径**:`claim_run` + `should_skip_overlap` + `trigger_run` 都已存在,且 `trigger_run` 已做 `work_dir_under_home` 的 TOCTOU 重校验([[zeromux-review-2026-06-07-workdir-spawn-gate]])。replay 不加新 spawn 逻辑。
- **历史不可变**:replay 是**新行**,经 `replay_of` 链接;原 `aborted` 行除 `confirm_status` 外永不被改。历史里两条并列可见。
- **两个入口,同一核心**:run-history 的「重放」按钮(`succeeded`/`failed`/非副作用 `aborted`——始终允许)与队列的「确认未完成→重放」(副作用未知的门控路径)。都调同一端点;**门控落在 UI + 服务端检查**:若该 run 是"副作用 + 未知"且 `confirm_status IS NULL`,**普通 replay 端点拒绝(409)——必须走队列的 confirm-then-replay**。决策 C 的"在要紧处硬停"由服务端而非按钮强制。

### 5.3 保留与清理

任务已有 `retention_n`(默认 20)。剪枝一个运行时**一并删除其 `~/.zeromux/runs/<run_id>/` 目录**。**仍在确认队列中的运行(`confirm_status IS NULL` + 副作用未知)豁免剪枝**——绝不静默丢弃等待人工裁决的东西。

---

## 6. 错误处理、边界与不变量

### 6.1 失败与竞态

- **快照写失败**(SQLite busy):log 后照常运行。无快照的运行降级(replay 禁用,tooltip "无输入快照——无法重放"),非致命。**绝不**因簿记阻塞真实 agent 运行。
- **`events.ndjson` 写失败**(磁盘满/权限):log 一次,该运行后续 append 丢弃,运行继续。输出捕获 best-effort,与 2MB scrollback 本就容忍丢失一致。队列卡片降级为"部分输出不可用"。
- **replay overlap 竞态**:两人/两标签页点同一卡片。`claim_run` 本就是原子卡点(`INSERT ... ON CONFLICT` 认领);第二次 claim 失败 → 409。`confirm_status` 转移用 `WHERE confirm_status IS NULL` 守卫,只第一次写生效。无双重 replay。
- **watchdog abort 之后运行才 finalize**(真正的"断流≠死":agent 活着、第 31 分钟才完成、watchdog 第 30 分钟已切行):迟到的 `Result`/`Exit` 到达一个已 `aborted` 的运行。令 `finalize_run` **拒绝覆盖终态**(`UPDATE ... WHERE state IN ('claimed','running')`)。行保持 `aborted`+未知——正确,因为此时 worktree/进程可能处于不确定态。这正是 naozhi §6.2 教训:流变安静不证明已死,人仍需确认。*(今天 `set_run_state` 用 `COALESCE` 会覆盖;此处加终态守卫。)*
- **zeromux 重启遇在途运行**:启动 `reconcile_orphans(None)` 打 `orphaned_restart` → 副作用的进队列(naozhi §6.5 orphan reconcile,zeromux 已半做——已 abort,只补 kind)。
  - **假设(Eng review Issue 3,需写明)**:`orphaned_restart` = "进程已死、状态未知" 这个语义,**依赖 zeromux 重启会带走所有 agent 子进程**(子进程随父进程 Drop / systemd cgroup `KillMode=control-group` 终止,见 [[zeromux-deploy]] cgroup self-kill 分析)。本机模型下成立——重启即子进程全灭。**若该假设被破坏**(如某个 detached 进程存活),`finalize_run` 的终态守卫(`WHERE state IN ('claimed','running')`)是兜底:迟到的 finalize 无法覆盖已 `aborted` 的行,不会双写。即:假设让我们能保守判 `orphaned_restart`,守卫保证即使判错也安全。

### 6.2 必须保持的不变量

- **广播扇出不变**:finalizer 与新 events-tee 都在**现有 fanout 任务内**跑,fanout 仍是进程唯一所有者,无新代码碰进程(CLAUDE.md 核心不变量)。
- **Drop 清理不变**:run 目录由 retention 剪枝,不挂在 session Drop 上。删 session 不会孤立 run record(它们以 `run_id` 为键、归任务所有)。
- **仅增量 schema**:4 个新 nullable 列(config 的 `max_runtime_min`/`side_effects`;runs 的 `input_snapshot`/`confirm_status`/`replay_of`)+ 2 个新 `failure_kind` 字符串值。无现有列改类型/语义;旧行读 NULL = 当前行为。

### 6.3 安全

- 每个新端点 owner-scoped(`cfg.owner_id != user.id → 403`)。
- replay 经 `trigger_run` 现有 `work_dir_under_home` TOCTOU 门——快照即使存的路径被篡改也逃不出 HOME。
- `input_snapshot` 按构造排除 secret 原值(引用名不变量)。
- 快照 prompt 在 dashboard 渲染为**文本,绝不执行/插值**——队列卡片转义显示。

---

## 7. 组件边界

| 单元 | 改动 | 为何内聚 |
|---|---|---|
| `scheduled_tasks.rs` | 5 新列;`reconcile_orphans` 打 kind;per-task cutoff;队列 `SELECT`;`confirm_status`/`replay_of` 写;`set_run_state` 终态守卫 | 所有 run/task 持久化本就在此 |
| `session_manager.rs` | 为 `run_id` 运行 tee `AcpEvent`→`events.ndjson`;trigger 时写 `input_snapshot`;`finalize_run` 终态守卫;`replay_run()` helper | fanout 本就拥有输出;replay 复用 `trigger_run` |
| `web.rs` | 3 端点:`GET /confirmations`、`POST /confirmations/{id}/{done\|replay}`、`POST /runs/{id}/replay`;create/update 加 `max_runtime_min`/`side_effects` | 镜像现有 scheduled-task handler + auth |
| `ScheduledTasksPanel.tsx` + `api.ts` | 任务编辑器字段(`side_effects`/`max_runtime_min`);"待确认"区 + attention 徽标;run-history 重放按钮 + `replay_of` 链 | 既有面板;CSS-visibility 约定 |
| `App.tsx`(Finding 1) | 主会话列表消费 `/confirmations` 计数,把待确认数浮到必经界面 | 拥有会话列表;复用现有端点,无新端点 |

---

## 8. 测试策略

### 8.1 Rust(`#[cfg(test)]`,仓库约定)

1. `reconcile_orphans(Some)` → `aborted`+`watchdog_timeout`;`reconcile_orphans(None)` → `aborted`+`orphaned_restart`。
2. per-task `max_runtime_min`:60min 限的任务 35min 不被 abort;NULL 仍走 30min 默认;写入钳 1–1440(`0`/负→1,`99999`→1440)。
3. **终态守卫(最重要)**:对已 `aborted` 运行 `finalize_run("succeeded")` 是 **no-op**(迟到完成竞态)。
4. 队列谓词:副作用未知 + `confirm_status IS NULL` 出现;非副作用未知**不**出现;`confirmed_done` 移出。
5. replay:新行带 `replay_of`,原行除 `confirm_status` 外不变;有在途运行时 overlap 守卫 → 不 replay;**服务端拒绝对"副作用未知 + `confirm_status IS NULL`"运行的普通 replay**(门控)。
6. `input_snapshot` 往返;replay 注入快照非当前配置(两次间编辑任务 prompt → replay 用旧 prompt)。
7. retention 剪枝删 run 目录;**队列待处理运行豁免剪枝**。
8. **events.ndjson tee(Eng review Issue 4——新 I/O 必须测)**:run prompt 注入后事件追加到 `runs/<id>/events.ndjson`;终态边界后 tee **停止**(后续事件不再追加,验证 §5.1 tee 作用域绑定 `active_run_id`);写失败(目录不可写)时**运行不中断、降级为部分输出**(验证 §6.1 best-effort)。

### 8.2 前端(vitest)

- 队列仅渲染合格运行;attention 徽标计数;重放按钮按终态的禁用态 + tooltip;`replay_of` 链渲染。
- 待确认计数浮到主会话列表(Finding 1):计数 >0 时会话列表显示标识,=0 时不显示。

### 8.3 手动冒烟(文档化,不自动化)

真实 `side_effects:true` + 低 `max_runtime_min` 任务 → 让 watchdog abort → 确认进队列 → replay → 验证生成 `replay_of` 链接的新运行。

### 8.4 TDD 纪律

每个实现任务先写失败测试(尤其 #3、#5 安全关键项),遵循仓库 test-first 规范。

---

## 9. 决策清单(已锁)

1. **范围**:A+B+C(副作用队列 + 终态精化 + run-record/replay);keepalive(D)延后。
2. **终态**:`failed_transport` ≡ `aborted`+未知 kind(无迁移);per-task `max_runtime_min`(**1–1440,默认 30**;CEO review Finding 2 — 不抄 naozhi 云端 60min 上限)。
3. **replay 门控**:副作用范围化——只读自由重放;副作用未知经队列硬停(服务端强制)。
4. **存储**:输入快照入 SQLite,输出 `events.ndjson` 落盘。
5. **replay 模型**:新 `replay_of` 链接行,注入快照,复用 `claim_run`+overlap+TOCTOU 门;历史不可变。
6. **队列**:派生视图(一个 `confirm_status` 列,无新表);永不自动动作;待处理运行豁免剪枝。
7. **通知触达**(CEO review Finding 1):v1 = dashboard 徽标 + 计数浮到主会话列表;真正的无人值守推送依赖未来 PWA+web-push(见 §10 后续工作)。

**Eng review 加固(4 项,已并入正文)**:① events.ndjson tee 严格绑定 `active_run_id` 窗口(§5.1);② watchdog 用单条集合式 UPDATE+JOIN config,杜绝 per-task N+1(§3.3);③ `orphaned_restart` 的"进程已死"假设写明 + 终态守卫兜底(§6.1);④ 补 events-tee 的写入/停止/降级测试(§8.1 #8)。

---

## 10. 后续工作(明确延后,不在 v1)

- **PWA + web-push 推送通道**:本功能"无人值守失败浮出"的价值要真正兑现,需把待确认事件推到手机锁屏。这是独立 feature 独立 spec(见 [[zeromux-mobile-terminal-composer]] PM 已建议)。v1 只点名依赖,不实现。
- **keepalive 心跳(原 #D)**:让"静默但活着" vs "卡死"可区分,需改三个 ACP 后端;现有保守行为下不紧急。做了之后可把默认 watchdog 从 30min 收紧。
- **content-hash 去重快照**:v1 快照极小不值得;快照变大时复用 markdown hash-cache 模式([[zeromux-rendering-ordering-naozhi-shipped]])。
- **AgentCore / 云端 placement 轴**:本体缓议,走多租户 SaaS 那天再说。
