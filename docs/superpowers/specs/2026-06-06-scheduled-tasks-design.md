# 定时任务（Scheduled Tasks / 无人值守 Agent 运行）设计

日期：2026-06-06
状态：设计 + CEO + Codex(x2) + 工程评审已完成，待写实施计划

**分期**（工程评审定）：
- **v1 骨架**：§0 spike → 调度循环（含运行时看门狗）+ `agent_task_runs` 表 + run_id 贯穿的触发与精确终结 + 启动 reconcile + 前端 CRUD 面板 + 侧边栏角标。目标：能定时把 Claude review 跑起来、状态可靠。
- **v1.1 体验补齐**：verdict 提取展示 + 留存回收（带安全闸）。

## 目标

给 ZeroMux 增加一个**无人值守 agent 运行**子系统：用户预设一个 goal（prompt）+ 触发时间，到点后系统自动创建一个 Claude Code agent session、把 goal 喂进去跑完，并把一句话结论（verdict）作为事件推给用户。典型场景是「每日定时用 Claude Code review 某个仓库的改动」，本质是一个帮助提升效率的后台 scheduler。

**命名/抽象决策**：核心 primitive 是「触发器 + agent 运行」，不是「cron 任务」。cron 只是 v1 的触发方式。数据模型用 `trigger_type` / `agent_type` 留出扩展位（v1 只跑 `cron` + `claude` 分支），未来加 on-push 触发、Kiro/Codex agent 不需要迁移表。

同时顺手把侧边栏三个 agent 的图标换成官方品牌 logo（`BrandIcons.tsx`，已基本完成，纳入本次收尾）。

## 部署假设（载入前提）

ZeroMux 是**单二进制单进程**应用。本设计据此简化：调度器是进程内单一 tokio 后台任务，**不考虑多实例 / DB lease / 分布式选主**。若未来要多实例部署，调度需加 DB 租约抢占——明确列为本次范围外。

## 范围与决策（评审后定稿）

- **结果形态**：自动触发新建普通 Claude session（跑完留列表，可点进看完整对话）**＋** 抓取一句话 verdict 写成 event 推送（红点旁显示结论）。
- **触发定义**：UI 用**北京时间**（友好结构化输入）；后端把结构化输入拼成 cron 字符串存库，**调度严格按 `Asia/Shanghai` 时区评估 cron**。不做「转 UTC」——避免 8 小时偏移（见 §2 时区铁律）。
- **任务字段**：name / 触发时间 / work_dir / prompt / enabled。agent 固定 Claude；分支选择、多 agent 本次不做。
- **运行追踪**：新增 `agent_task_runs` 表显式记录每次运行（去重 + 重叠检测 + 崩溃 reconcile + 运行历史共用骨架）。
- **重叠触发**：上次运行的 session 进程仍存活 → **跳过**本次 + 写 skipped event（含 scheduled_for + 在跑 session id）。
- **留存**：每任务保留最近 N=20 个完整 session（可配，超过回收 session + worktree，**带安全闸**）；verdict event 永久保留。
- **崩溃可见性**：per-task 错误隔离（单任务 panic 不带倒循环）+ JoinHandle 监督（调度器死了自动重生）+ 心跳时间戳（前端发现心跳超 3min 显示「调度器异常」红警）。
- **错过补跑**：进程没运行时错过的触发**跳过**，不补跑；进程在但循环延迟时，对每个 due 点只补触发最近一个。
- **入口**：右上角时钟图标按钮（带红点 / 异常红警），点开 overlay 管理面板。不单独做纯品牌 logo。
- **调度实现**：自写「每分钟 tick」后台循环 + `cron`（解析）+ `chrono` / `chrono-tz`（时区评估）。不引入重量级调度 crate。

## 架构

### 0. 关键可行性前提（实施第一步必须先验证）

**Claude CLI 必须能无人值守运行。** 现有交互 session 能跑是因为有人盯着可以回 permission 提示。9 点无人值守的运行若卡在 login / 权限 `y/n` 提示会永久挂起，整个功能就失效。实施第一个任务就是 spike 验证：`claude -p --output-format stream-json --input-format stream-json` 在无 TTY、无人应答下能否对一个 review prompt 跑到完成（含工具调用的权限处理）。若不能，需找到非交互/信任模式参数，或本功能不成立——先验证再继续。

### 1. 数据模型（SQLite）

新建 `src/scheduled_tasks.rs`，仿 `events.rs` / `session_store.rs` 的 `Mutex<Connection>` 模式，使用现有 data_dir 下的 SQLite。

**表 1 `agent_runs_config`（任务定义）**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `owner_id` | TEXT | 创建者；服务端登录态盖章，不信前端 |
| `name` | TEXT | 任务名 |
| `trigger_type` | TEXT | v1 固定 `"cron"`；扩展位 |
| `trigger_spec` | TEXT | cron 表达式（后端从结构化时间拼出） |
| `tz` | TEXT | 固定 `"Asia/Shanghai"`；显式存（非假扩展位，调度真的按它评估） |
| `agent_type` | TEXT | v1 固定 `"claude"`；扩展位 |
| `work_dir` | TEXT | 目标仓库目录（复用现有 work_dir 边界校验） |
| `prompt` | TEXT | 喂给 agent 的 goal |
| `enabled` | INTEGER | 1/0 启用·暂停 |
| `retention_n` | INTEGER | 保留最近 N 个完整 session，默认 20 |
| `created_ms` | INTEGER | 创建时间 |

**表 2 `agent_task_runs`（每次运行的状态，Codex 建议）**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `task_id` | TEXT | 外键→config.id |
| `scheduled_for_ms` | INTEGER | **预定触发时刻**（去重的真正键，非实际运行时刻） |
| `state` | TEXT | `claimed` / `running` / `succeeded` / `failed` / `skipped` / `aborted` |
| `session_id` | TEXT NULL | 本次产生的 session |
| `verdict` | TEXT NULL | 抓到的一句话结论 |
| `failure_kind` | TEXT NULL | 失败分类（见 §2 失败分类） |
| `started_ms` / `ended_ms` | INTEGER NULL | 运行起止 |
| **UNIQUE** | | `(task_id, scheduled_for_ms)` —— 数据库级去重，杜绝重复触发 |

**对现有结构的改动**（两处，工程评审后）：
1. `Session`（`session_manager.rs`）/ `PersistedSession`（`session_store.rs`）加 `source_task_id: Option<String>`。空=手动，非空=定时产生。`session_store` 用 `ALTER TABLE ADD COLUMN` 平滑升级老库。session 列表 API 返回该字段供前端打角标。
2. `SessionInput::Prompt(String)` → `Prompt { text: String, run_id: Option<String> }`（见 §3）。触及四个 fan-out 的 Prompt 匹配点；手动路径传 `None`，行为不变。

**启动 reconcile**：进程启动恢复阶段（`main.rs` 现有 session restore 同处，**先于**调度循环 spawn）把上次遗留的 `claimed/running` run 标 `aborted`，状态立刻干净。运行时孤儿另由 §2 看门狗处理。

**FK / 留存兼容**：verdict 永久存在 `agent_task_runs.verdict`（不依赖 session 存活）；events 表的 `session_id` **不加 cascade FK**，删 session 不连带删 event/run 记录——「永久结论」才成立。UI 渲染 event 时容忍 `session_id` 指向已删除 session（点进去提示「会话已回收，结论见摘要」）。

### 2. 调度引擎

启动时在 `main.rs` 紧挨现有 session 恢复 spawn 处，spawn 调度循环，并**监督它的 JoinHandle**：若 task 退出（panic 或 return），记 critical event 并重生（带退避），保证调度器不会静默死亡。

```text
loop {
    sleep 到下一个整分钟边界;
    write heartbeat_ms = now;                   // 监督 + 前端健康判断
    let now = Utc::now();                         // 仅最外层取一次 now
    watchdog_reconcile(now);                      // 运行时看门狗，见下
    for task in store.load_enabled() {
        let result = catch_unwind(|| process_task(task, now));   // per-task 隔离
        if result.is_err() { write_event(scheduler_error, task); continue; }
    }
}

process_task(task, now):
    let sched = Cron::parse(&task.trigger_spec)?;        // 失败 → warn + event，跳过
    // 纯函数：在 Asia/Shanghai 枚举 due 点（处理循环延迟跨多个周期）
    let due = due_fire_points(&sched, last_seen, now, Shanghai);
    if let Some(fire) = due.last() {                       // 只补最近一个（不补跑历史）
        if should_skip_overlap(task.id) {                  // 纯判定：见「重叠真相源」
            write_event(overlap_skipped, task, fire, live_run_sid); return;
        }
        // 数据库级去重 + 抢占：INSERT OR IGNORE，先插入再产生副作用
        if claim_run(task.id, fire).is_inserted() {        // 插入 state=claimed
            trigger(task, run);                            // 见 §3
        }
    }
```

**时区铁律**：绝不「北京时间→UTC→存 cron」。cron 文本就是北京时间语义，调度用 `chrono-tz` 的 `Asia/Shanghai` 评估。中国无夏令时，无 DST 跳变，但代码仍走时区评估而非硬编码 ±8。

**去重键**：`agent_task_runs.scheduled_for_ms`（预定触发时刻）+ UNIQUE 约束，**不是** last_run_ms（实际运行时刻）。claim 用 `INSERT OR IGNORE`（CAS 语义），**先插入 state=claimed，再产生任何副作用**（建 session）；UNIQUE 防重复 claim，重复触发尝试天然无害。

**启动语义**：进程启动设 `last_seen = now`，过去的 due 点不在窗口内 → 不补跑。恰好启动在某 fire 分钟：该分钟 ≤ now 视为已过，跳过（明确不在启动瞬间触发，避免重启风暴）。

**重叠真相源**：`should_skip_overlap(task_id)` 查 `agent_task_runs` 是否存在该 task 的 `state IN (claimed, running)` 行——**不是查 session 是否在 HashMap**（跑完不自动删 → 永远 true → 任务只触发一次就废，这是个 bug）。run 终结（见 §3）把状态写成 succeeded/failed 后即不再算重叠。

**运行时看门狗**（Codex 指出的运行时孤儿，启动 reconcile 不够）：每次 tick 先 `watchdog_reconcile`：扫所有 `claimed/running` 行，若 (a) `now - started_ms > max_runtime`，或 (b) `session_id` 已不在 registry / 进程已死 → 标 `aborted` + 写 event。否则 fan-out 中途掉落（panic / 进程无清洁 Exit / DB 写失败 / prompt 发送后即死）会留下**永久 running 行，永久阻塞该 task**。这是 §1 启动 reconcile 的运行时镜像，两者都要有。

**重生安全**（JoinHandle 监督重生）：`last_seen` 不靠易失内存——重生后从「现在」重新建立窗口（等价启动语义，错过的不补），并立即跑一次 `watchdog_reconcile` 清理重生前留下的孤儿。重复触发由 `INSERT OR IGNORE` + UNIQUE 兜底，无害。

**时钟跳变**：UNIQUE(scheduled_for) 天然防 NTP 回拨导致的重复触发；大幅前跳只补最近一个 due 点，不雪崩。

**失败分类**（`failure_kind`）：`spawn_failed` / `prompt_send_failed` / `cli_exited` / `no_verdict` / `overlap_skipped` / `scheduler_error` / `timeout`。每类写对应 event。

**可测性（硬约束）**：调度核心一律**纯函数**，时间/状态作参数注入，内部不调 `Utc::now()`、不读全局：
- `due_fire_points(spec, last_seen, now, tz) -> Vec<Fire>`
- `should_skip_overlap(running_rows) -> bool`
- `extract_verdict(result_text) -> Option<String>`
- `is_safe_to_reclaim(path, process_alive, has_uncommitted) -> bool`
`Utc::now()` 只在最外层循环调一次。单测喂构造输入即可，无需起 runtime、无需真等一分钟。

### 3. 触发：建 session + 注入 goal + 精确终结 run

**核心不变量（Codex 指出，关键）**：一个 scheduled run 必须**恰好拥有一个 ACP turn**，并被**精确终结一次**。靠 `source_task_id`（只认 task 不认具体 run）+ `boundary→Idle`（UI idle 启发式，Error/Exit 也是 boundary）来归属 verdict / 成败是**不安全**的。正确做法是让 `run_id` 随 prompt 贯穿进 fan-out，fan-out 持 `active_run_id`，只终结那个 run，并按**事件类型**精确映射状态。

**`SessionInput::Prompt` 改造**：从 `Prompt(String)` 改为 `Prompt { text: String, run_id: Option<String> }`。手动 session 传 `run_id: None`（行为不变），定时传 `Some(run_id)`。run_id 随 prompt 原子贯穿，无额外通路、无竞态。改动触及四个 fan-out 的 `SessionInput::Prompt` 匹配点（claude 真正使用 run_id，kiro/codex/tmux 忽略它，v1 只 claude）。

```text
async fn trigger(task, run):
    // 1. 建 session（owner=task.owner_id，source_task_id=task.id）
    //    注：现有函数名是 create_acp_session（非 create_claude_session）
    let sid = create_acp_session(name=..., work_dir, owner_id, source_task_id=task.id)?;
    mark_run(run, state=running, session_id=sid);
    // 2. 直接注入（不 wait_until_ready：input 走容量 64 mpsc，
    //    fan-out 在 create 返回前已启动，prompt 进队列被缓冲，无竞态。
    //    CLI 是否丢早期 stdin 由 §0 spike 验证。）
    let goal = format!("{}\n\n完成后，最后单独输出一行：\n<<<VERDICT>>>一句话结论<<<END>>>", task.prompt);
    input_tx(sid).send(SessionInput::Prompt { text: goal, run_id: Some(run.id) }).await
        .or_else(|| mark_run(run, failed, prompt_send_failed))?;
```

**fan-out 侧的精确终结**：claude fan-out 消费 `Prompt { run_id: Some(rid), .. }` 时记 `active_run_id = rid`。该 turn 产生 boundary 事件时，**按事件类型**精确映射并 finalize 恰好一次：

| 事件 | run 终结 |
|---|---|
| `Result`（期望的那个 run 的） | `extract_verdict(Result.text)`：有 marker → `succeeded` + verdict；无 → `no_verdict`（仍算完成，只是无摘要） |
| `Error` | `failed`（failure_kind=cli_error） |
| 异常 `Exit` / IO EOF 先于 Result | `failed`（failure_kind=cli_exited） |
| `Result` 之后的 `Exit` | 忽略（已终结） |

终结后清 `active_run_id`，幂等（finalize-exactly-once，重复 boundary 不二次写）。

**verdict 提取**（`extract_verdict` 纯函数，输入是 `Result.text`，不是 scrollback）：`Result.text` 已是完整最终文本、结构化、**无 ANSI**（ACP 事件流不是 PTY 终端帧），无需 strip ANSI / 翻 scrollback。取**最后一个**合法 `<<<VERDICT>>>…<<<END>>>` 间内容（哨兵分隔符防 prompt 注入伪造、防多行、防回显）。

**注入安全**：goal 里用户文本可能试图覆盖 verdict 指令，哨兵 + 取最后一个有效 marker 缓解；verdict 仅展示用，不触发动作，影响面有限。

**worktree 隔离照旧**：定时建的 session 走 `resolve_work_dir` 拿隔离 worktree。

**超时策略**：每 run 设最大运行时长（可配，默认 30min），由 §2 运行时看门狗执行：超时标 `aborted` + 写 event + cancel session（防 hang 死的 run 永久阻塞该任务）。

### 4. 留存与回收（带安全闸）

任务每次成功运行后，回收该任务超过 N 的旧 session：

```text
按 ended_ms 排序，保留最近 N 个 run 的 session；超出的：
  for old_session:
    assert 进程已死（不删活的）
    let wt = canonicalize(worktree_path)
    assert wt 在 .zeromux-worktrees/ 根下      // 防 rm -rf 越界
    if git_has_uncommitted_changes(wt):          // 防删未合并 agent 改动
        跳过回收 + 写 event（「保留：有未提交改动」）
    else:
        remove_worktree(base, wt)                // 复用现有
        delete session 元数据
  // DB 删与 FS 删非原子：失败留 tombstone，下轮重试清理
verdict event 永不删（在 agent_task_runs.verdict，不依赖 session）
```

**排序基准**：按 `ended_ms`（完成时刻）排序保留。禁用 / 删除任务时：删任务连带回收其所有 run 的 session（同样过安全闸），但保留 verdict 历史。

### 5. HTTP API（`web.rs`，authed `/api/*`）

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/scheduled-tasks` | 列出当前用户任务（owner 过滤，同 events authz） |
| `POST` | `/api/scheduled-tasks` | 新建 |
| `PUT` | `/api/scheduled-tasks/{id}` | 编辑（owner 校验） |
| `DELETE` | `/api/scheduled-tasks/{id}` | 删除（owner 校验，连带回收） |
| `POST` | `/api/scheduled-tasks/{id}/run` | 立即运行一次（走 trigger；重叠则跳过） |
| `GET` | `/api/scheduled-tasks/{id}/runs` | 运行历史（来自 agent_task_runs） |
| `GET` | `/api/scheduler/health` | 心跳时间戳（前端判健康） |

**北京时间↔cron 在后端做**：前端发结构化 `{kind:"daily",hour,minute}` / `{kind:"weekly",weekdays,hour,minute}` / `{kind:"cron",expr}`；后端拼 cron 存库，`GET` 时解析回结构化供渲染，无法识别的复杂 cron 标 `kind:"cron"` 显示原文。cron 库只在 Rust 侧；合法性一处校验。

**owner / 凭证**：每端点从登录态取 `CurrentUser` 仅操作自己的任务。后台建的 session 与手动 session 一样盖 owner（§3 已含）。agent 凭证：依赖 §0 的无人值守可行性验证。

### 6. 前端交互

新增 `ScheduledTasksPanel.tsx`；`api.ts` 加对应函数；入口加在 `App.tsx` 顶部工具栏右侧。不新增图标库（`Clock` 在 lucide 中已有）。

- **(a) 右上角入口**：`Clock` 按钮。**红点**=有「刚完成、产生的 session/verdict 尚未看过」的运行（复用 B-2 红点）。**异常红警**=`/api/scheduler/health` 心跳超 3min 未更新，显示「调度器异常」。
- **(b) 管理面板 overlay**（复用 AdminPanel 呈现方式）：顶部「+ 新建任务」；列表每行 `任务名 · 北京时间 · 目标仓库 · [启用/暂停] · 最近运行状态/verdict · [立即运行][编辑][删除][历史]`；新建/编辑表单含任务名、时间选择器（常用项下拉 + 时:分，高级展开 cron 输入框）、目录选择器（复用 `listDirectories`）、prompt 多行输入。运行历史子视图读 `/runs`。
- **(c) 侧边栏角标**：`source_task_id` 非空的 session 图标旁加小时钟角标，hover 显示来源任务名。**本次只做角标，不做筛选 UI。**

### 7. 品牌 logo 收尾

`BrandIcons.tsx`（Claude Code/Kiro/Codex 官方 SVG，避免引入 @lobehub/icons）与 `Sidebar.tsx` 图标替换已基本完成，本次一并提交。与定时任务逻辑独立。

## 依赖新增

- `cron`（cron 解析；实施时确认其字段数语义、是否支持「枚举 due 点」，否则自己按 `chrono` 枚举）
- `chrono` + `chrono-tz`（`Asia/Shanghai` 时区评估）

均轻量纯逻辑依赖，契合 `opt-level="z"`。

## 验收标准

**v1 骨架**：
1. **无人值守可行性**（前置 spike）：无 TTY、无人应答下，Claude 对 review prompt 跑到完成；且 spawn 后立即发的 prompt 不被 CLI 丢弃。
2. 「每天 HH:MM（北京时间）」任务到点自动建 session 并执行，时间无 8 小时偏差。
3. 「立即运行」即时产生 run；重叠（该 task 有 claimed/running 行）跳过 + overlap_skipped event；run 终结后下次不再跳。
4. **精确终结**：scheduled run 的 `Result` → succeeded、`Error` → failed、异常 `Exit`/EOF → failed、`Result` 后的 `Exit` → 忽略；finalize 恰好一次，归属正确 run（run_id 贯穿）。
5. 暂停后到点不触发；重启后继续触发；进程停期间错过的不补跑。
6. 启动后孤儿 `claimed/running` 被 reconcile 标 `aborted`；**运行时**孤儿（fan-out 掉落/超时）被看门狗标 `aborted`，不永久阻塞 task。
7. 重生：调度器 task 死亡被监督重生，重生不导致重复或漏触发（INSERT OR IGNORE 兜底 + 重生即 reconcile）。
8. 自动 session 带时钟角标，可点进看完整对话；worktree 隔离生效。
9. owner 隔离：只见/操作自己的任务。
10. 单任务 panic 不影响其他任务；心跳停更触发前端红警。
11. 同一分钟多任务触发受并发上限约束，不一次性 spawn 过多 agent。
12. fake-clock 单测覆盖：`due_fire_points` / `should_skip_overlap` / 去重 / 跨多周期延迟 / 启动语义。

**v1.1 体验**：
13. verdict 由 `extract_verdict(Result.text)` 提取并显示；无 marker → `no_verdict`（仍算完成，不报错）；嵌入伪造 marker → 取最后一个真实的。
14. 超 N 回收：`is_safe_to_reclaim`（进程死 + 路径在 worktree 根内 + 无未提交改动）才删；有未提交改动跳过并记 event；verdict 历史永久查得到。

## NOT in scope（明确不做）

- 多实例 / 分布式调度（DB lease）——单进程假设。
- 非 cron 触发（on-push / file-watch）——`trigger_type` 已留位。
- 多 agent（Kiro/Codex）——`agent_type` 已留位。
- 分支选择、侧边栏「只看定时 session」筛选。

## What already exists（复用）

- `create_acp_session` + `input_tx` 注入 + 广播扇出（§3；注意函数名是 create_acp_session）。
- claude fan-out 的 boundary 事件 + `AcpEvent::Result.text`（结构化最终文本，run 终结 + verdict 来源）。
- events 表 + owner 服务端盖章 + owner 过滤（verdict/skipped/error event）。
- B-2 红点机制（入口提醒）。
- `resolve_work_dir` / `remove_worktree`（worktree 隔离与回收）。
- work_dir 边界校验（来自 d8a6ee6 安全修复）。
- session 持久化与重启恢复 spawn（调度器 spawn 同构挂载点）。

## 评审记录（Reviewer Concerns 已解决）

CEO/CTO 评审扩展：trigger 抽象命名、verdict 摘要、重叠跳过、留存 N + worktree 回收、崩溃可见性（心跳）。
Codex(第一轮) 采纳：dedup 改用 scheduled_for、`agent_task_runs` 表 + UNIQUE 去重、verdict 哨兵分隔符 + fallback、JoinHandle 监督、worktree 安全闸、no-cascade FK、startup/clock-jump 语义、超时、失败分类、fake-clock、并发上限、无人值守前置验证、单进程假设。
工程评审修正（含 Codex 第二轮）：① verdict 改读 `Result.text` 结构化字段（非 scrollback strip ANSI，agent 流无 ANSI）；② 去掉 wait_until_ready（mpsc 已吸收竞态，改 spike 验证）；③ 重叠真相源改 `agent_task_runs.state IN(claimed,running)`（非 session 存在，否则只触发一次就废）；④ **run_id 贯穿** `SessionInput::Prompt{text,run_id}` + fan-out `active_run_id` + **事件类型精确终结**（Result→succeeded、Error/异常Exit→failed、finalize-exactly-once）——取代不安全的 source_task_id+boundary→succeeded；⑤ 启动 reconcile 放恢复阶段、先于调度 spawn；⑥ **运行时看门狗**（超时/进程死/session 消失→aborted）补启动 reconcile 的运行时镜像；⑦ INSERT OR IGNORE 先插入再副作用 + 重生即 reconcile；⑧ 纯函数 + 时间注入定为测试硬约束；⑨ 分 v1 骨架 / v1.1 体验两期。

## 未来扩展（本次不做）

- 非 cron 触发、多 agent、分支选择、session 筛选 UI、verdict 之外的富摘要、多实例调度。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | SELECTIVE EXPANSION：3 提案全部接受 |
| Codex Review | codex exec | Independent 2nd opinion | 2 | issues_found | 两轮 outside voice；correctness 缺口全部采纳或显式记录 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 6 findings（架构3+质量1+测试1+复杂度1），全部解决；0 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | 可选，UI 范围较轻 |

- **CODEX:** 第一轮抓 dedup 键/运行状态表/verdict 脆弱性/worktree 风险/监督不足；第二轮抓 run 终结归属（source_task_id 太粗、boundary≠succeeded）+ 运行时孤儿。全部采纳为 run_id 贯穿 + 事件精确终结 + 运行时看门狗。
- **ENG:** 修正 verdict 改读 Result.text、去 wait_until_ready、重叠真相源改 runs.state、reconcile 放启动、纯函数测试硬约束；拆 v1/v1.1。
- **CROSS-MODEL:** CEO×Codex 张力（verdict/worktree/状态表）+ Eng×Codex 张力（run 终结语义）均交用户裁决，全选「保留功能 + 按外部声音加固」。
- **UNRESOLVED:** 0
- **VERDICT:** CEO + ENG CLEARED — 架构锁定，可写实施计划。无人值守可行性（§0）为实施第一任务硬前置；按 v1 骨架 → v1.1 体验分期。
