# 定时任务（Scheduled Tasks）设计

日期：2026-06-06
状态：设计已确认，待写实施计划

## 目标

给 ZeroMux 增加一个**定时任务子系统**：用户预设一个 goal（prompt）+ 触发时间，到点后系统自动创建一个 Claude Code agent session 并把 goal 喂进去跑完。典型场景是「每日定时用 Claude Code review 某个仓库的改动」，本质是一个帮助提升效率的后台 scheduler。

同时顺手把侧边栏三个 agent 的图标换成官方品牌 logo（`BrandIcons.tsx`，已基本完成，纳入本次收尾）。

## 范围与决策（已确认）

- **结果形态**：A 起步——自动触发就是新建一个普通 Claude session，跑完留在 session 列表里，点进去看完整对话。事件摘要/通知（B）作为未来第二步，本次预留不做。
- **触发定义**：用户在 UI 用**北京时间**（友好形式）设置，后端自动转成 **cron 表达式**存储；调度按 `Asia/Shanghai` 时区评估 cron。
- **任务字段**：name / 触发时间 / work_dir / prompt / enabled（启用·暂停）。agent 固定 Claude Code；分支选择、多 agent 支持本次不做。
- **自动 session 管理**：B 方案——自动产生的 session 打来源标记（`source_task_id`），侧边栏图标带时钟角标区分；完整历史保留，不自动删除。本次只做角标，不做筛选 UI。
- **持久化与可靠性**：A + 跳过——任务定义存 SQLite，服务器重启后调度循环重新加载、继续按时触发；进程没运行时错过的触发**跳过**，不补跑。
- **入口**：右上角时钟图标按钮（带红点提醒），点开 overlay 管理面板。不单独做纯品牌 logo。
- **调度实现**：方案 2——自写「每分钟 tick」后台循环 + `cron`（解析）+ `chrono`/`chrono-tz`（时区评估）。不引入重量级调度 crate，契合极简二进制哲学。

## 架构

### 1. 数据模型（SQLite）

新建 `src/scheduled_tasks.rs`，仿 `events.rs`/`session_store.rs` 的 `Mutex<Connection>` 模式，使用现有 data_dir 下的 SQLite。新表 `scheduled_tasks`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid |
| `owner_id` | TEXT | 创建者；服务端从登录态盖章，不信任前端 |
| `name` | TEXT | 任务名 |
| `cron` | TEXT | cron 表达式（后端从结构化时间转出） |
| `tz` | TEXT | 固定 `"Asia/Shanghai"`，显式存便于将来扩展 |
| `work_dir` | TEXT | 目标仓库目录 |
| `prompt` | TEXT | 喂给 Claude 的 goal |
| `enabled` | INTEGER | 1/0 启用·暂停 |
| `last_run_ms` | INTEGER NULL | 上次触发时刻（去重 + UI 展示） |
| `last_session_id` | TEXT NULL | 上次触发产生的 session id（UI 可跳转） |
| `created_ms` | INTEGER | 创建时间 |

**对现有表的唯一改动**：给 `Session`（`session_manager.rs`）/ `PersistedSession`（`session_store.rs`）增加 `source_task_id: Option<String>` 字段。空=手动创建，非空=某定时任务产生。`session_store` 表用 `ALTER TABLE ADD COLUMN` 平滑升级老库。session 列表 API 返回该字段，前端据此打角标。

### 2. 调度引擎

启动时在 `main.rs` 紧挨现有 session 恢复 spawn 处，`tokio::spawn` 一个后台调度循环：

```text
loop {
    sleep 到下一个整分钟边界;          // 对齐分钟，避免漂移
    let now = Utc::now();
    for task in store.load_enabled() {        // 每 tick 重读 SQLite —— 增删改即时生效
        let schedule = Cron::parse(&task.cron)?;   // 解析失败 → warn 并跳过该任务
        let prev_fire = schedule.prev_fire_in_tz(now, Shanghai);   // 上一个应触发时刻
        if prev_fire ∈ (last_tick, now]
           && task.last_run_ms < prev_fire_ms {     // 本周期还没跑过
            let sid = trigger(task).await;          // 见 §3
            store.set_last_run(task.id, prev_fire_ms, sid);
        }
    }
}
```

要点：
- **每 tick 重读 SQLite**：面板里改时间/暂停/删除，下一分钟即生效，无需重新加载信令。
- **去重**：用「上一个应触发时刻的毫秒」与 `last_run_ms` 比较，同一触发点只跑一次，容忍 tick 抖动。
- **错过跳过**：进程没运行时窗口自然滑过；重启后首个 tick 的 `last_tick` 即「现在」，过去触发点不在窗口内 → 不补跑。
- **解析容错**：单个任务 cron 损坏只 warn 跳过，不影响主循环和其他任务。
- **时区**：8 小时偏移由 `chrono-tz` 在评估时处理，不在存储层硬编码 -8，从根上杜绝 off-by-one。

### 3. 触发：建 session + 注入 goal

`trigger(task)` 是调度器与现有广播扇出模型的桥，完全复用 `create_claude_session`：

```text
async fn trigger(state, task) -> Result<String> {
    let session_id = sessions.create_claude_session(
        name = format!("{} · {}", task.name, 北京时间 HH:MM),
        work_dir = task.work_dir,
        owner_id = task.owner_id,
        source_task_id = Some(task.id),       // §1 的标记
        ...
    ).await?;
    let input_tx = sessions.get_input_tx(session_id)?;
    input_tx.send(SessionInput::Prompt(task.prompt)).await?;   // 不经过 WebSocket
    Ok(session_id)
}
```

要点：
- **不走 WebSocket**：goal 通过 session 的 `input_tx` 发 `SessionInput::Prompt`——正是扇出模型设计意图，任何持 `input_tx` 的代码都是平等输入源。输出照常进 broadcast + scrollback，事后点进去看完整对话。
- **`create_claude_session` 增加 `source_task_id` 参数**：现有前端手动建的调用点传 `None`（该函数签名的唯一改动）。
- **worktree 隔离照旧**：git 仓库内自动建的 session 也走 `resolve_work_dir` 拿隔离 worktree，review 不污染工作区。
- **失败容错**：建 session 或发 prompt 失败 → warn + 写一条 system 事件（复用 events），不影响调度循环。
- **「立即运行一次」**走同一 `trigger()`，但不更新 `last_run_ms`，便于随时验证 prompt。

### 4. HTTP API（`web.rs`，authed `/api/*`）

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/scheduled-tasks` | 列出当前用户的任务（owner 过滤，同 events 的 per-user authz） |
| `POST` | `/api/scheduled-tasks` | 新建 |
| `PUT` | `/api/scheduled-tasks/{id}` | 编辑（owner 校验） |
| `DELETE` | `/api/scheduled-tasks/{id}` | 删除（owner 校验） |
| `POST` | `/api/scheduled-tasks/{id}/run` | 立即运行一次（走 `trigger`，不更新 `last_run_ms`） |

**北京时间↔cron 转换在后端做**，前端传结构化时间：
- 前端发 `{ kind: "daily", hour, minute }` / `{ kind: "weekly", weekdays:[..], hour, minute }` / `{ kind: "cron", expr }`。
- 后端拼装成标准 cron 字符串存库（仅结构→文本，不含 -8 小时，偏移由调度时时区评估处理）。
- `GET` 时后端把 cron 解析回结构化字段供前端渲染；无法识别的复杂 cron 标记为 `kind:"cron"` 显示原始表达式。
- 理由：cron 库只在 Rust 侧，前端无需引入 cron 库；合法性只在一处校验。

**owner 校验**：每端点从登录态取 `CurrentUser`，仅能操作自己的任务（legacy 模式为单一 admin）。与 events per-user authz 一致。

### 5. 前端交互

新增 `ScheduledTasksPanel.tsx`；`api.ts` 加 5 个函数；入口加在 `App.tsx` 顶部工具栏。不新增图标库（`Clock` 在 lucide 中已有）。

- **(a) 右上角入口**：顶部工具栏右侧（用户头像/登出一侧）放 `Clock` 按钮。**红点**：当用户有「刚触发、产生的 session 尚未点开看过」的自动 session 时显示；复用 B-2 active-management 红点机制。点开面板或看过对应 session 后消失。
- **(b) 管理面板 overlay**（复用 AdminPanel 呈现方式）：顶部「+ 新建任务」；任务列表每行 `任务名 · 北京时间 · 目标仓库 · [启用/暂停] · 最近运行状态 · [立即运行][编辑][删除]`；新建/编辑表单含任务名、时间选择器（常用项下拉 + 时:分，高级展开 cron 输入框）、目录选择器（复用 `listDirectories`）、prompt 多行输入。
- **(c) 侧边栏角标**：`source_task_id` 非空的 session，图标旁加小时钟角标，hover 显示来源任务名。**本次只做角标，不做筛选 UI。**

### 6. 品牌 logo 收尾

`BrandIcons.tsx`（Claude Code/Kiro/Codex 官方 SVG，避免引入 @lobehub/icons）与 `Sidebar.tsx` 的图标替换已基本完成，本次一并提交收尾。与定时任务功能独立，不混入其逻辑。

## 依赖新增

- `cron`（cron 表达式解析）
- `chrono` + `chrono-tz`（按 `Asia/Shanghai` 时区评估触发时刻）

均为轻量纯逻辑依赖，契合 `opt-level="z"` 极简二进制。

## 验收标准

1. 新建一个「每天 HH:MM（北京时间）」任务，到点自动出现一个 Claude session 并开始执行 prompt；时间无 8 小时偏差。
2. 「立即运行一次」即时产生 session 且不影响下次定时去重。
3. 暂停任务后到点不触发；重新启用后恢复。
4. 服务器重启后，已存任务继续按时触发；重启期间错过的触发不补跑。
5. 自动产生的 session 在侧边栏带时钟角标，可点进去看完整对话；worktree 隔离生效。
6. 任务定义按 owner 隔离，用户只能看到/操作自己的任务。
7. 单个任务 cron 损坏不影响其他任务与调度循环。
8. 触发后右上角时钟出现红点，查看后消失。

## 未来扩展（本次不做）

- 事件摘要/通知（B）：跑完写一条 event 摘要。
- 多 agent（Kiro/Codex）、分支选择。
- 侧边栏「只看定时任务 session」筛选。
- 自动 session 保留策略（只留最近 N 次）。
