# 定时任务（Scheduled Tasks / 无人值守 Agent 运行）设计

日期：2026-06-06
状态：设计 + CEO/CTO 评审 + Codex 外部声音已完成，待写实施计划

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

**对现有表的唯一改动**：给 `Session`（`session_manager.rs`）/ `PersistedSession`（`session_store.rs`）加 `source_task_id: Option<String>`。空=手动创建，非空=定时产生。`session_store` 用 `ALTER TABLE ADD COLUMN` 平滑升级老库。session 列表 API 返回该字段供前端打角标。

**FK / 留存兼容**：verdict 永久存在 `agent_task_runs.verdict`（不依赖 session 存活）；events 表的 `session_id` **不加 cascade FK**，删 session 不连带删 event/run 记录——「永久结论」才成立。UI 渲染 event 时容忍 `session_id` 指向已删除 session（点进去提示「会话已回收，结论见摘要」）。

### 2. 调度引擎

启动时在 `main.rs` 紧挨现有 session 恢复 spawn 处，spawn 调度循环，并**监督它的 JoinHandle**：若 task 退出（panic 或 return），记 critical event 并重生（带退避），保证调度器不会静默死亡。

```text
loop {
    sleep 到下一个整分钟边界;
    write heartbeat_ms = now;                   // 监督 + 前端健康判断
    let now = Utc::now();
    for task in store.load_enabled() {
        let result = catch_unwind(|| process_task(task, now));   // per-task 隔离
        if result.is_err() { write_event(scheduler_error, task); continue; }
    }
}

process_task(task, now):
    let sched = Cron::parse(&task.trigger_spec)?;        // 失败 → warn + event，跳过
    // 在 Asia/Shanghai 时区枚举所有 due 的 fire 点（处理循环延迟跨多个周期）
    let due = sched.due_fire_points_in_tz(last_seen, now, Shanghai);
    if let Some(fire) = due.last() {                       // 只补最近一个（不补跑历史）
        // 数据库级去重：UNIQUE(task_id, scheduled_for_ms) 抢占
        if claim_run(task.id, fire).is_ok() {             // 插入 state=claimed
            if task_has_live_session(task.id) {            // 重叠检测（进程存活，非仅列表存在）
                mark_skipped(run); write_event(skipped, task, fire, live_sid); return;
            }
            trigger(task, run);                            // 见 §3
        }
    }
```

**时区铁律**：绝不「北京时间→UTC→存 cron」。cron 文本就是北京时间语义，调度用 `chrono-tz` 的 `Asia/Shanghai` 评估。中国无夏令时，无 DST 跳变，但代码仍走时区评估而非硬编码 ±8。

**去重键**：`agent_task_runs.scheduled_for_ms`（预定触发时刻）+ UNIQUE 约束，**不是** last_run_ms（实际运行时刻）。崩溃在「建 session」与「写状态」之间也安全：claim 先插入（state=claimed），UNIQUE 防重复 claim；重启 reconcile 把孤儿 claimed/running 标 aborted。

**启动语义**：进程启动设 `last_seen = now`，过去的 due 点不在窗口内 → 不补跑。恰好启动在某 fire 分钟：该分钟 ≤ now 视为已过，跳过（明确不在启动瞬间触发，避免重启风暴）。

**时钟跳变**：UNIQUE(scheduled_for) 天然防 NTP 回拨导致的重复触发；大幅前跳只补最近一个 due 点，不雪崩。

**失败分类**（`failure_kind`）：`spawn_failed` / `prompt_send_failed` / `cli_exited` / `no_verdict` / `overlap_skipped` / `scheduler_error`。每类写对应 event。

**可测性**：调度核心逻辑（due 点枚举、去重判定）抽成纯函数，时间通过参数注入（**fake clock**），不直接调 `Utc::now()`，保证单测可注入时间。

### 3. 触发：建 session + 注入 goal + 抓 verdict

```text
async fn trigger(task, run):
    // 1. 建 Claude session（owner=task.owner_id，source_task_id=task.id）
    let sid = create_claude_session(name=..., work_dir, owner_id, source_task_id)?;
    mark_run(run, state=running, session_id=sid);
    // 2. 等 session 就绪再注入（不能 spawn 后立刻发 —— racey）
    wait_until_ready(sid).await?;          // 等首个 Running 信号 / ready
    // 3. 注入加固后的 prompt（哨兵分隔符约定）
    let goal = format!("{}\n\n完成后，最后单独输出一行：\n<<<VERDICT>>>一句话结论<<<END>>>", task.prompt);
    input_tx(sid).send(SessionInput::Prompt(goal)).await?;
    // 4. verdict 抓取见下
```

**就绪竞态**（Codex 指出）：spawn 后立刻发 `Prompt` 假设 CLI 已就绪，是 racey 的。改为等该 session 第一个 `TurnState::Running`（或后端可观测的 ready 信号）后再注入 goal。

**verdict 抓取**：挂在现有 `apply_turn`（session_manager.rs:359）的 `Running→Idle` 边界——但**不是无脑取第一个 turn 完成**，因为首次 Idle 可能是 CLI 启动 / 权限提示 / 工具等待。正确做法：只对**注入 goal 之后**的那个 turn 完成做抓取（用 run 的 session_id + 注入后的 turn_seq 关联，避免错挂）。抓取流程：

1. 从该 run 的输出流取文本（scrollback 持久化的是 ACP/JSON 事件，已含文本，不依赖前端连接——**无人值守也留存**）。
2. strip ANSI。
3. 取**最后一个**合法 `<<<VERDICT>>>…<<<END>>>` 之间的内容（哨兵分隔符防 prompt 注入伪造、防多行、防回显）。
4. 写 `succeeded` + verdict event。
5. 超时 / 无 marker / 模型拒答 → 写 fallback `no_verdict` event（「完成，无摘要」），仍标 succeeded（任务跑完了，只是没结论）。

**注入安全**：goal 里的用户文本可能试图覆盖 verdict 指令（prompt 注入），哨兵分隔符 + 取最后一个有效 marker 缓解；verdict 本身只是展示用摘要，不触发任何动作，影响面有限。

**worktree 隔离照旧**：定时建的 session 走 `resolve_work_dir` 拿隔离 worktree。

**超时策略**：每个 run 设最大运行时长（可配，默认如 30min），超时标 `aborted` + 写 event，并 cancel session（防一个 hang 死的 run 让该任务被重叠检测永久跳过）。

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

1. **无人值守可行性**（前置）：无 TTY、无人应答下，Claude 对 review prompt 跑到完成。
2. 「每天 HH:MM（北京时间）」任务到点自动建 session 并执行，时间无 8 小时偏差。
3. verdict 正确抓取并显示；模型不输出 marker 时写 `no_verdict` fallback event，不报错。
4. 「立即运行」即时产生 run；重叠（上次进程仍活）跳过 + skipped event。
5. 暂停后到点不触发；重启后继续触发；进程停期间错过的不补跑。
6. 重启后孤儿 `claimed/running` 被 reconcile 标 `aborted`，不重复也不卡死。
7. 自动 session 带时钟角标，可点进看完整对话；worktree 隔离生效。
8. 超 N 回收：进程已死 + 路径在 worktree 根内 + 无未提交改动才删；有未提交改动跳过并记 event；verdict 历史永久查得到。
9. owner 隔离：只见/操作自己的任务。
10. 单任务 panic 不影响其他任务；调度器 task 死亡被监督重生 + 心跳停更触发前端红警。
11. 同一分钟多任务触发受并发上限约束，不一次性 spawn 过多 agent。
12. fake-clock 单测覆盖：due 点枚举、去重、跨多周期延迟、启动语义。

## NOT in scope（明确不做）

- 多实例 / 分布式调度（DB lease）——单进程假设。
- 非 cron 触发（on-push / file-watch）——`trigger_type` 已留位。
- 多 agent（Kiro/Codex）——`agent_type` 已留位。
- 分支选择、侧边栏「只看定时 session」筛选。

## What already exists（复用）

- `create_claude_session` + `input_tx` 注入 + 广播扇出（§3）。
- `apply_turn` 的 Running→Idle 完成信号（verdict 抓取挂钩）。
- events 表 + owner 服务端盖章 + owner 过滤（verdict/skipped/error event）。
- B-2 红点机制（入口提醒）。
- `resolve_work_dir` / `remove_worktree`（worktree 隔离与回收）。
- work_dir 边界校验（来自 d8a6ee6 安全修复）。
- session 持久化与重启恢复 spawn（调度器 spawn 同构挂载点）。

## 评审记录（Reviewer Concerns 已解决）

CEO/CTO 评审扩展：trigger 抽象命名、verdict 摘要纳入 v1、重叠跳过、留存 N + worktree 回收、崩溃可见性（心跳）。
Codex 外部声音追加并已采纳：dedup 改用 scheduled_for、`agent_task_runs` 运行状态表 + UNIQUE 去重、就绪竞态（等 ready 再注入）、verdict 哨兵分隔符 + ANSI strip + fallback、turn 关联避免错挂、JoinHandle 监督（非仅心跳）、worktree 安全闸（canonicalize + 进程死 + 未提交检查）、no-cascade FK、startup/clock-jump 语义、超时策略、失败分类、fake-clock 测试、并发上限、无人值守可行性前置验证、单进程假设显式记录。

## 未来扩展（本次不做）

- 非 cron 触发、多 agent、分支选择、session 筛选 UI、verdict 之外的富摘要、多实例调度。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | SELECTIVE EXPANSION：3 提案全部接受（verdict 摘要、重叠跳过、留存+回收、崩溃可见性） |
| Codex Review | codex exec | Independent 2nd opinion | 1 | issues_found | 多项 correctness 缺口；全部采纳或显式记录 |
| Eng Review | `/plan-eng-review` | Architecture & tests | 0 | — | 待运行（CTO 视角已在本轮覆盖架构/错误/性能/可观测） |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | 可选，UI 范围较轻 |

- **CODEX:** 抓出 dedup 键错误、就绪竞态、verdict 抓取脆弱性、worktree 删除风险、心跳不足以重启死 task、缺运行状态表/超时/失败分类/fake-clock 测试。除「v1 砍 cron 改简单调度」「v1 砍 verdict」「v1 砍 worktree 回收」三条（用户选择保留并加固）外，全部采纳。
- **CROSS-MODEL:** CEO 与 Codex 在「verdict / worktree / 运行状态表」三处有张力，已逐条交用户裁决——用户均选「保留功能 + 按 Codex 加固」。
- **UNRESOLVED:** 0
- **VERDICT:** CEO CLEARED。建议实施前补一次 `/plan-eng-review` 锁架构，但本轮 CTO 视角已覆盖核心工程风险。无人值守可行性（§0）为实施第一任务的硬前置。
