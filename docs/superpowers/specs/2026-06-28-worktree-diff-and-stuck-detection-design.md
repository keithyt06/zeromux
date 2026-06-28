# 工作树 diff 审查(只读) + 卡住/静默挂起检测 — 设计文档

日期:2026-06-28
状态:已批准设计,待写实现计划

## 背景与动机

调研同类产品(Webmux、octomux、amux、tmux-ide、Herdr、Claude Agent View)后,行业从"多开终端"收敛到"看板 + PR/CI 追踪 + agent 互相编排"。对 ZeroMux 当前画像(单人、手机重度、跑多个无人值守 agent)杠杆最高的两个缺口:

1. **工作树 diff 审查**:现有 Git Viewer 只能看**已提交**的 commit。手机上最缺的是"agent 跑完后快速看它改了哪些**未提交**文件",不必开 IDE。
2. **卡住/静默挂起浮出**:Herdr 的洞见是"agent 卡住时 Idle/Running 区分不出来"。ZeroMux 现状里"可能卡住"只是 `AcpChatView.tsx` 里一行纯前端文案,且口径错误(按 turn 总时长,而非静默时长),不进侧栏、无推送。

两个特性都**只做浮出/审查,不改 agent 行为**——尤其保留 ZeroMux 刻意的"无人值守自动批准"设计(Claude `--dangerously-skip-permissions`、Kiro 自动 `allow-once`、Codex 自动 accept elicitation)。

## 范围决策(已与用户确认)

- 工作树 diff:**只读**。不做丢弃(`git restore`)、提交(`git commit`)、暂存(`git add`)。
- UI 位置:**并进现有 GitViewer**,加「工作区改动 / 历史提交」tab,不开独立视图。
- 深链:**不改**。沿用现有 `turn_done` push 落到 Chat 视图;不让通知直奔 diff(纯问答轮会落到空 diff)。
- 卡住检测:走 **A 方案(静默挂起检测)**,不做真实权限门控(B)或混合(C)。保留 auto-approve。
- 卡住阈值:**180s** 静默无输出。
- 卡住推送:**要**(新增第 4 类 `stuck` push)。

## 非目标(防范围蔓延)

- 不做任何 git 写操作(丢弃/提交/暂存/分支)。
- 不改 push 深链落点。
- 不做自动干预(自动 ctrl-c / 自动重启)。
- 不改三后端的 auto-approve 行为,不引入真实权限门控。
- 不引入持久化的 `SessionMeta::Blocked` 状态——"卡住"是 `Running` 的衍生判断,非独立状态机。
- 未跟踪文件不做 `git diff --no-index` 全文 diff,只列文件名。

---

## 特性 1:工作树 diff 审查(只读)

### 后端

新增只读端点:`GET /api/sessions/{id}/git/worktree`

实现位置:`src/web.rs`,紧邻现有 `git_log` / `git_show`(约 1583–1762 行)。复用既有模式:
- 工作目录解析:PTY live-dir 优先(`/proc/{pid}/cwd`,见 `session_status` 468–473 行),回退到 `state.sessions.work_dir(&id)`,经 `resolve_base_dir` / `ensure_under_home` 守卫。
- git 执行:`std::process::Command::new("git").current_dir(dir)`,同现有 git 端点。
- owner 授权:经现有 auth 中间件 + `require_session_access` 自动继承。

在 work_dir 跑两条命令:

1. `git status --porcelain=v1 -z`(用 `-z` NUL 分隔,稳健处理含空格/特殊字符的路径;rename 形如 `R  old\0new`)
   解析为结构化文件列表,每项:
   ```
   { path: String, status: "M"|"A"|"D"|"R"|"??"|"C"|"U"|..., staged: bool, old_path: Option<String> }
   ```
   - `status` 取 porcelain 两字符码的归一(index 列 + worktree 列;`staged` = index 列非空格非 `?`)。
   - `??` = 未跟踪。
   - rename(`R`)填 `old_path`。
2. `git diff HEAD`(已跟踪文件的未提交全量 diff,含已暂存 + 未暂存)→ 原始 unified diff 文本字符串。
   - 未跟踪文件(`??`)不在 `git diff HEAD` 输出中,只通过文件列表呈现("新文件"),不强行 diff 内容。

返回 JSON:
```json
{ "is_git": true, "files": [ {...} ], "diff": "..." }
```

错误处理:
- 非 git 仓库(`git status` 报 `not a git repository`)→ 返回 `{ "is_git": false, "files": [], "diff": "" }`,HTTP 200,不报错。
- work_dir 解析失败 → 404(沿用 `resolve_base_dir`)。
- git 命令非零退出(其他原因)→ 502 + stderr(沿用 `git_show` 模式)。

**安全**:纯读路径,不写文件,不触碰 `is_write_blocked` / `resolve_write_target`。但读路径仍受 `ensure_under_home` + 敏感目录守卫约束(work_dir 本身已是会话受限目录)。

### 前端

`frontend/src/components/GitViewer.tsx`:顶部新增两个 tab。

- 「历史提交」= 现有全部逻辑(commit 图、`getGitLog`/`getGitShow`、`DiffView`、`RefBadges`),原样保留。
- 「工作区改动」= 新逻辑:
  - 调 `getGitWorktree(sessionId)`。
  - 左侧文件列表:每项显示文件名 + 状态角标(M/A/D/??/R,复用现有 badge 配色思路:绿=A、红=D、黄=M、灰=??)+(可选)该文件增删行数(从 diff 文本按 `+++`/hunk 粗解析,或省略——实现时取简方案)。
  - 右侧:复用现有 `DiffView` 组件渲染 `diff` 文本。
  - 点左侧文件 → 滚动/高亮到对应 diff 段(尽力而为;若实现成本高则先只整体渲染,YAGNI)。
  - 刷新按钮(复用现有 refresh 模式)。
- **默认 tab 选择**:进入 GitViewer 时,若会话 `git_dirty > 0`(来自现有 `getSessionStatus`)默认「工作区改动」,否则默认「历史提交」。让"看 agent 刚改了啥"成为默认动作。

`frontend/src/lib/api.ts`:
- 新增 `getGitWorktree(id): Promise<{ is_git: boolean; files: WorktreeFile[]; diff: string }>`。
- 新增类型 `WorktreeFile { path: string; status: string; staged: boolean; old_path?: string }`。

---

## 特性 2:卡住/静默挂起检测(A 方案)

### 核心口径修正

卡住 = `turn_state === Running` **且** 距**上次 agent 输出**静默超过阈值(180s)。**不是** turn 总时长——一个跑了 5 分钟但持续刷输出的 turn 不算卡住。复用 `scheduled_tasks.rs` idle-watchdog 的"最后输出时间"心智,但作用于交互式会话。

### 后端

`src/session_manager.rs`:
- `RunningProcess` 结构(187–197 行)新增字段 `last_output_ms: Option<i64>`。
- 在三后端 fan-out 任务**每次广播 agent 输出事件**时刷新该字段为 `now_millis()`。fan-out 是所有事件必经之路(ACP / Kiro / Codex 各自的 fanout),改动集中、可枚举。
- `SessionInfo`(277–294 行)新增导出 `last_output_ms: Option<i64>`。
- **不**改 `SessionMeta` 语义,不设 `Blocked`——卡住是 `Running` 的派生判断,turn 结束(Idle)自动消失,无回退 bug。
- 阈值常量后端定义:`STUCK_SILENCE_MS: i64 = 180_000`(前后端共用口径;前端从此值派生,避免漂移)。

### Push

`src/push.rs` + fan-out 触发点:
- 新增第 4 类 trigger kind `stuck`:
  - `payload_for("stuck", name, sid, fk)` → 标题 `⚠️ {name} 可能卡住`,正文 `已静默 N 分钟无输出`。
  - urgency = `high`(同 run_failed/confirm)。
- 触发逻辑:在 fan-out 内已有的周期性 tick(keepalive/心跳)或新增轻量定时检查中,对每个会话判断:
  - `turn_state == Running` 且 `now - last_output_ms > STUCK_SILENCE_MS`
  - 且本轮(`turn_seq`)还没推过 stuck(每轮一次性,turn 结束清标志)
  - 且 `active_run_id.is_none()`(无人值守 run 走 `scheduled_tasks.rs` 的 idle_timeout/confirm 路径,这里不重复推)
  - → `should_push_stuck(...)` 通过后推一次,复用 `should_push_turn_done` 同款去抖(每会话至少间隔 N 秒)。
- 去抖/已推标志的存储:复用 `PushService` 的 per-(user, session) 时间戳机制(同 `last_turn_push`/`mark_turn_pushed`),新增 `last_stuck_push`/`mark_stuck_pushed` 或等价物。

### 前端

`frontend/src/lib/api.ts`:`SessionInfo` 加 `last_output_ms: number | null`。

派生:`stuck = turn_state === 'running' && last_output_ms != null && (now - last_output_ms) > 180000`。

- **会话侧栏**:`stuck` 时把现有 Running 状态点渲染成**琥珀色**(新增一档,复用现有状态点/红点渲染),让用户**不进会话**就能在列表看到"这个卡了"。需要一个每秒 tick(或现有轮询)驱动 `now` 刷新。
- `AcpChatView.tsx:331`:把现有 `stuck = elapsed > 180`(基于 turn 总时长,口径错误)改为基于 `last_output_ms` 的静默口径。文案沿用"已静默 Ns,可能卡住"。

---

## 数据流

- **diff 审查**:tab 切到「工作区改动」→ `GET /git/worktree` → 后端在 work_dir(PTY live-dir 优先)跑 `git status --porcelain=v1 -z` + `git diff HEAD` → JSON → `DiffView` 渲染。纯拉取,无 WS,无持久状态。
- **卡住检测**:fan-out 每次广播输出 → 刷新 `last_output_ms` → 经 `SessionInfo` 随 `/api/sessions` 轮询与 WS 下发 → 前端派生 `stuck`。后端周期 tick 跨阈值 → 推一次 `stuck`。

## 错误处理

- `/git/worktree`:非 git → `{is_git:false}` 200;git 非零退出 → 502 + stderr;work_dir 解析失败 → 404。
- 卡住:`last_output_ms` 为 None(刚启动未输出)→ 不判卡住;turn 结束 → 派生自动归零、push 标志清除;会话死亡 → 随 Drop 清理,无悬挂。

## 测试(TDD)

**后端(Rust 内联 `#[cfg(test)]`)**:
- porcelain `-z` 解析:M / A / D / ?? / R(`R old\0new`)/ C / 已暂存 vs 未暂存(index 列判定)各态。
- 非 git 仓库 → `is_git:false`。
- `should_push_stuck` 阈值边界:179s 不推 / 181s 推 / 同 turn 不重复推 / 有 `active_run_id` 不推 / 去抖间隔内不重复推。

**前端(vitest)**:
- `stuck` 派生:running + 静默 > 180s 为真;Idle 为假;`last_output_ms` 为 null 为假;running + 静默 < 180s 为假。
- worktree tab 文件列表角标渲染(M/A/D/?? 配色)。
- 默认 tab 选择:`git_dirty > 0` 选「工作区改动」,否则「历史提交」。

## 改动文件清单

后端:
- `src/web.rs` — 新增 `git_worktree` handler + 路由 + porcelain 解析 helper。
- `src/session_manager.rs` — `RunningProcess.last_output_ms` 字段 + fan-out 刷新点(×3 后端)+ `SessionInfo` 导出 + `STUCK_SILENCE_MS` + 周期 tick 卡住判断与触发。
- `src/push.rs` — `payload_for` 加 `stuck` 分支 + urgency + `should_push_stuck` + per-session 去抖时间戳。

前端:
- `frontend/src/lib/api.ts` — `getGitWorktree` + `WorktreeFile` 类型 + `SessionInfo.last_output_ms`。
- `frontend/src/components/GitViewer.tsx` — tab 切换 + 工作区改动面板。
- `frontend/src/components/AcpChatView.tsx` — `stuck` 改用静默口径。
- 会话侧栏组件(`App.tsx` 或会话列表组件)— 琥珀色卡住状态点。
