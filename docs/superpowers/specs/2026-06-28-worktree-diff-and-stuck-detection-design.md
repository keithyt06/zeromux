# 工作树 diff 审查(只读 + agent 转发) + 卡住/静默浮出 — 设计文档

日期:2026-06-28
状态:已批准设计,经 CTO + PM 双重对抗评审修订,待写实现计划

## 背景与动机

调研同类产品(Webmux、octomux、amux、tmux-ide、Herdr、Claude Agent View)后,行业从"多开终端"收敛到"看板 + PR/CI 追踪 + agent 互相编排"。对 ZeroMux 当前画像(单人、手机重度、跑多个无人值守 agent)杠杆最高的两个缺口:

1. **工作树 diff 审查**:现有 Git Viewer 只能看**已提交**的 commit。手机上最缺的是"agent 跑完后快速看它改了哪些**未提交**文件",不必开 IDE——然后**一键处理**(让 agent 提交/撤销),不必切回 Chat 手打。
2. **卡住/静默浮出**:Herdr 的洞见是"agent 卡住时 Idle/Running 区分不出来"。ZeroMux 现状里"可能卡住"只是 `AcpChatView.tsx` 里一行纯前端文案,且口径错误(按 turn 总时长,而非静默时长),不进侧栏、无推送。

两个特性都**不改 agent 行为**——尤其保留 ZeroMux 刻意的"无人值守自动批准"设计(Claude `--dangerously-skip-permissions`、Kiro 自动 `allow-once`、Codex 自动 accept elicitation)。

## 范围决策(已与用户确认 + 双评审修订)

- 工作树 diff:**只读 git**,不做任何 git 写(丢弃/提交/暂存/分支)。但**提供后续动作**:diff 视图底部「让 agent 提交」「让 agent 撤销」按钮,通过向会话注入预设 prompt 实现,不碰 git。
- UI 位置:**并进现有 GitViewer**,加「工作区改动 / 历史提交」tab。
- 深链:**按 dirty 分流**(评审修订,推翻原"不改")。`turn_done` 通知点进会话后,若该会话 `git_dirty > 0` → 自动落「工作区改动」diff;否则落 Chat。
- 卡住检测:**A 方案(静默浮出)**,保留 auto-approve,不做真实权限门控。
- 侧栏卡住阈值:**180s** 静默无输出(纯展示)。
- 卡住推送:**保留但解耦调高**(评审修订)。push 阈值独立于侧栏点,默认 **600s(10min)**,独立去抖键。理由见特性 2。

## 非目标(防范围蔓延)

- 不做任何 **git 写操作**(丢弃/提交/暂存/分支)。"后续动作"一律走 agent 转发(注入 prompt),不直接调 git。
- 不做自动干预(自动 ctrl-c / 自动重启)。
- 不改三后端 auto-approve,不做真实权限门控,不引入持久 `SessionMeta::Blocked`(卡住是 `Running` 的衍生判断)。
- 未跟踪文件不做 `git diff --no-index` 全文 diff,只列文件名。
- 不做跨会话 dirty 鸟瞰(多 agent "谁改了啥"概览)——记为 v2 候选(见末尾),本 spec 不含。

---

## 特性 1:工作树 diff 审查(只读 + agent 转发动作)

### 后端

新增只读端点:`GET /api/sessions/{id}/git/worktree`

实现位置:`src/web.rs`,紧邻现有 `git_log` / `git_show`(约 1583–1762 行)。复用既有模式:
- 工作目录解析:**复用 `session_status` 同款逻辑**——`pty_pid` live-dir 优先、回退 stored work_dir,经 `resolve_base_dir` / `ensure_under_home` 守卫。
  - **认知备注(防实现者困惑)**:agent 会话(claude/kiro/codex)的 `RunningProcess.pty_pid` 恒为 `None`(只有 tmux/PTY 有),故 agent 会话实际走 stored work_dir 分支——这是**正确来源**(agent 不会像 tmux 那样 `cd` 乱跑;worktree-isolation 模式下 stored work_dir 已是 `.zeromux-worktrees/<id>`)。不要为 agent 会话另加 pid 探测。
- git 执行:`std::process::Command::new("git").current_dir(dir)`,同现有 git 端点。
- owner 授权:经现有 auth 中间件 + `require_session_access` 自动继承。

**安全门(P1,实现前置)**:在跑 git 前,若解析出的 work_dir **本身等于 `$HOME` 或落在敏感目录**(沿用 `base_dir_at_or_in_sensitive`,2026-06-26 引入),直接返回 `{is_git:false}`(不泄漏)。理由:`git diff HEAD` 会吐出 work_dir 下所有未提交内容全文;若 `$HOME` 是 git 仓库(dotfiles 管理),会泄漏 `.aws/credentials`、`.ssh/config`、`.env` 的 diff——路径守卫管不到 diff 文本内容。这是本项目 file-browser 系列反复栽的同一类读取放大洞。

在 work_dir 跑命令:

1. `git status --porcelain=v1 -z`(`-z` NUL 分隔,稳健处理含空格/特殊字符路径;rename 形如 `R  old\0new`)
   解析为结构化文件列表,每项:
   ```
   { path: String, status: String, staged: bool, old_path: Option<String> }
   ```
   - `status` 取 porcelain 两字符码归一(index 列 + worktree 列);`staged` = index 列非空格非 `?`;`??` = 未跟踪;rename(`R`)填 `old_path`。
2. **HEAD 探测(P1)**:先 `git rev-parse --verify -q HEAD`。
   - **有 HEAD** → `git diff HEAD`(已跟踪文件未提交全量 diff,含已暂存+未暂存)。
   - **无 HEAD**(全新仓库刚 `git init` 未 commit)→ `diff` 字段返回空串,文件列表照常由 status 给出。**绝不让 `git diff HEAD` 在无 HEAD 时非零退出而误报 502。**
3. **diff 截断(P1)**:`git diff` 输出截断到 **512KB**,超出则截断并置 `truncated: true`。防 agent 改了大文件(node_modules、生成物)时几 MB diff 塞进 JSON 卡死手机端 `DiffView`。
4. **敏感文件过滤(P1)**:从 status 文件列表与 diff 文本中,剔除路径命中 `SENSITIVE_DIR_NAMES` 的条目(把 denylist 从"路径守卫"延伸到"diff 内容")。

返回 JSON:
```json
{ "is_git": true, "files": [ {...} ], "diff": "...", "truncated": false }
```

错误处理:非 git 仓库 → `{is_git:false, files:[], diff:"", truncated:false}` HTTP 200;work_dir 解析失败 → 404;git 命令(非"无 HEAD""非仓库")非零退出 → 502 + stderr(沿用 `git_show`)。

### 前端

`frontend/src/components/GitViewer.tsx`:顶部新增「工作区改动」/「历史提交」tab。
- 「历史提交」= 现有全部逻辑原样保留。
- 「工作区改动」:调 `getGitWorktree(sessionId)`;左侧文件列表(文件名 + 状态角标 M/A/D/??/R,复用现有 badge 配色:绿=A、红=D、黄=M、灰=??);右侧复用现有 `DiffView` 渲染 `diff` 文本;`truncated` 时顶部提示"diff 过大已截断";点左侧文件尽力滚动到对应段(成本高则先整体渲染,YAGNI)。
- **默认 tab**:进入时若 `git_dirty > 0`(来自现有 `getSessionStatus`)默认「工作区改动」,否则「历史提交」。

**agent 转发按钮(PM 评审新增,补只读闭环)**:「工作区改动」tab 底部两个按钮——「让 agent 提交」「让 agent 撤销改动」。点击 = 向当前会话**注入一条预设 prompt**(复用 `AcpChatView` 现有的向会话发 prompt 路径,即 WS `{"type":"prompt","text":...}`),例如:
- 提交:`把当前工作区的未提交改动提交,commit message 自行总结本次改动。`
- 撤销:`撤销(git restore)当前工作区的全部未提交改动,不要提交。`
按钮仅在 `is_git && files.length>0` 时显示;点击后给 toast 提示"已发送给 agent",并建议切到 Chat 看执行。**不碰 git,不破只读底座**,把"看完→处理"闭环从手机键盘解放出来。

**深链分流(PM 评审,推翻原"深链不改")**:`turn_done` 通知点击带 `?session=` 打开会话后(现有 SW 深链逻辑),前端在打开会话时查 `getSessionStatus`,若 `git_dirty > 0` → 自动切到 GitViewer 的「工作区改动」tab(看 agent 改了啥);否则维持 Chat(纯问答轮)。**纯前端落点判断,不改 push payload / SW**。

`frontend/src/lib/api.ts`:新增 `getGitWorktree(id)` + 类型 `WorktreeFile { path; status; staged; old_path? }` + 返回 `{ is_git; files; diff; truncated }`。

---

## 特性 2:卡住/静默浮出(A 方案)

### 核心口径修正

卡住 = `turn_state === Running` **且** 距**上次 agent 输出**静默超阈值。**不是** turn 总时长——持续刷输出的长 turn 不算卡住。修掉 `AcpChatView.tsx:331` 现有 `elapsed > 180`(基于 turn 总时长)的错误口径。

### 后端(复用现有基础设施,零新字段 / 零新 timer)

**P0-1 修订(删重复字段)**:**不新增 `last_output_ms`**。复用已存在的 `SessionInfo.last_activity_ms`——`record_and_broadcast`(`session_manager.rs` ~1601-1622)每次广播事件即刷新它,源码注释明确称其为"true silence timestamp(turn 内更新,非仅边界)",且交互式 watchdog `running_idle_too_long`(~690-698)已用它判静默。turn 起点(`apply_turn`)也会 bump 一次,天然满足"刚进 Running 还没输出时不立即判卡住"。

**P0-2 修订(用真实存在的 tick)**:**不在 fan-out 内加 tick**(fan-out 的 `select!` 无周期心跳;那是 collect-flush deadline,误读)。复用 `scheduled_tasks.rs` 的**全局 60s scheduler tick**(`spawn_scheduler` ~928,已每 60s 调 `running_idle_too_long(now, INTERACTIVE_IDLE_MS)` 在锁内扫描所有 Running 且静默的交互式会话,且已用 `source_task_id.is_none()` 排除无人值守 run)。卡住检测做成该 tick 里的**第二个查询**:`running_idle_too_long(now, STUCK_*)`,锁内取候选 sid,锁外推送(照搬现有"锁内取列表→锁外 send"范式)。

**阈值/状态**:
- 侧栏琥珀点口径:`STUCK_SILENCE_MS: i64 = 180_000`(前后端共用)。
- **不**改 `SessionMeta` 语义,不设 `Blocked`——卡住是 `Running` 的派生判断,turn 结束(Idle)自动消失。
- stuck 与 watchdog-kill 不冲突:`INTERACTIVE_IDLE_MS`(30min,kill 兜底)远晚于 stuck 浮出/推送,stuck 只浮出不 kill。

### Push(评审修订:阈值解耦 + 大幅调高 + 独立去抖键)

PM 评审指出 180s 在 JuiceFS 生产环境必然误报(release build / npm ci / 长 thinking 常态静默 >180s),用于"主动打扰"会稀释通知信任。故:
- **侧栏琥珀点**用 180s(纯展示,误报无害——列表偶尔黄一下)。
- **stuck push 阈值独立且调高**:`STUCK_PUSH_MS: i64 = 600_000`(10min,可后续配置化)。它填的是"交互轮卡住→`turn_done` 永不到达→用户在手机上永远不知道"这个真洞(手机"发起后锁屏放下"画像),但 10min 静默才推,显著压低误报。
- `src/push.rs` 新增第 4 类 kind `stuck`:`payload_for("stuck",...)` → 标题 `⚠️ {name} 可能卡住`、正文 `已静默约 N 分钟无输出`、urgency `high`。
- **P1-5 修订(去抖键隔离)**:stuck 的去抖**不得复用 turn_done 的 `(user,session)→i64` map**(会互相覆盖致漏推)。新增独立去抖 map(或键含 kind:`(user,session,"stuck")`)。新增 `last_stuck_push`/`mark_stuck_pushed`。
- 触发(在 scheduler tick 内):会话 `Running` 且 `now - last_activity_ms > STUCK_PUSH_MS` 且 `source_task_id.is_none()`(交互式)且本轮未推过 stuck 且过去抖 → 推一次。turn 结束清本轮标志。

### 前端

`SessionInfo` 已含 `last_activity_ms`,无需改类型。
- 派生:`stuck = turn_state==='running' && (now - last_activity_ms) > 180000`(需每秒 tick 或现有轮询驱动 `now`)。
- **会话侧栏**:`stuck` 时把 Running 状态点渲染成**琥珀色**(新增一档,复用现有状态点渲染),不进会话即可在列表看到。
- `AcpChatView.tsx`:`stuck` 改用 `last_activity_ms` 静默口径,文案"已静默 Ns,可能卡住"。

---

## 数据流

- **diff 审查**:tab 切「工作区改动」→ `GET /git/worktree` → 后端 work_dir 跑 status+diff(带 HEAD 探测/截断/敏感过滤)→ JSON → `DiffView`。转发按钮 → WS `prompt` 注入当前会话。深链落点 → 前端查 `getSessionStatus` 的 dirty 决定 tab。纯拉取/复用现有 WS,无新持久状态。
- **卡住浮出**:`record_and_broadcast` 刷 `last_activity_ms` → `SessionInfo` 随 `/api/sessions` 轮询/WS 下发 → 前端派生 `stuck`(180s)。scheduler 60s tick 跨 `STUCK_PUSH_MS`(600s)→ 推一次 stuck(独立去抖)。

## 错误处理

- `/git/worktree`:非 git → `{is_git:false}` 200;无 HEAD → diff 空串 + 文件列表照常;敏感/$HOME base → `{is_git:false}`;其他非零退出 → 502;work_dir 解析失败 → 404;diff >512KB → 截断 + `truncated:true`。
- 卡住:`last_activity_ms` 在 turn start 已 bump,180s/600s 内不误判;turn 结束派生归零、push 标志清;会话 Drop 自动清理。

## 测试(TDD)

**后端(Rust 内联 `#[cfg(test)]`)**:
- porcelain `-z` 解析:M/A/D/??/R(`R old\0new`)/C/已暂存 vs 未暂存(index 列判定)。
- **空仓库无 HEAD → 不报 502**(diff 空串,文件列表非空)。
- **超大 diff → 截断 + `truncated:true`**。
- **安全 parity**:work_dir=$HOME(或敏感目录)→ `is_git:false`;diff 输出/文件列表不含命中 `SENSITIVE_DIR_NAMES` 的文件(沿用本项目 denylist parity 测试惯例)。
- `should_push_stuck` **纯函数**(输入 now/last_activity/turn_state/source_task_id/last_stuck_push,输出 bool,与 tick 频率解耦):599s 不推 / 601s 推 / 同 turn 不重复 / 有 source_task_id 不推 / 去抖间隔内不重复。
- **去抖隔离**:mark_stuck 后 turn_done 去抖不受影响,反之亦然。

**前端(vitest)**:
- `stuck` 派生:running+静默>180s 真;Idle 假;running+静默<180s 假。
- worktree tab 文件角标渲染(M/A/D/?? 配色);`truncated` 提示。
- 默认 tab 选择:`git_dirty>0` 选「工作区改动」。
- 转发按钮仅 `is_git && files.length>0` 显示,点击发 WS prompt。
- 深链落点:dirty>0 切 worktree tab,dirty==0 留 Chat。

## 改动文件清单

后端:
- `src/web.rs` — 新增 `git_worktree` handler + 路由 + porcelain `-z` 解析 helper + HEAD 探测 + 截断 + 敏感过滤/拒绝。
- `src/session_manager.rs` — `STUCK_SILENCE_MS` 常量(供前端口径参照)。**无新字段**(复用 `last_activity_ms`)。
- `src/scheduled_tasks.rs` — scheduler tick 内加 stuck 扫描查询(复用 `running_idle_too_long` 同款,`STUCK_PUSH_MS`)+ 锁外推送。
- `src/push.rs` — `payload_for` 加 `stuck` 分支 + urgency + `should_push_stuck` 纯函数 + 独立去抖 map(`last_stuck_push`/`mark_stuck_pushed`)。

前端:
- `frontend/src/lib/api.ts` — `getGitWorktree` + `WorktreeFile` 类型。
- `frontend/src/components/GitViewer.tsx` — tab 切换 + 工作区改动面板 + 转发按钮 + 默认 tab。
- `frontend/src/components/AcpChatView.tsx` — `stuck` 改静默口径。
- 会话侧栏组件 + 深链落点(`App.tsx` 或会话列表/路由)— 琥珀色卡住点 + dirty 分流落点。

## v2 候选(本 spec 不做,记一笔)

- **多会话 dirty 鸟瞰**:会话列表每个 agent 显示 `+N −M` / "K files changed" 角标,早晨一眼看"昨晚哪个 agent 改了东西"。对多 agent 画像杠杆高,复用本 spec 的 diff 解析,但依赖特性 1 后端先落地。

## 双评审采纳记录

- CTO P0-1:删 `last_output_ms`,复用 `last_activity_ms`(已核实 record_and_broadcast 刷新 + SessionInfo 已导出)。
- CTO P0-2:弃"fan-out tick"虚构,复用 scheduled_tasks 全局 60s scheduler tick + `running_idle_too_long`。
- CTO P1:空仓库无 HEAD 不报 502;diff 512KB 截断;work_dir=$HOME/敏感目录 diff 泄漏 → 拒绝+文件过滤。
- CTO P1:stuck 去抖键与 turn_done 隔离。
- CTO P2:注明 agent 会话 pty_pid 恒 None 走 stored work_dir;stuck 与 30min watchdog-kill 不冲突。
- PM:补 agent 转发按钮(注入 prompt,零 git 写)补只读闭环。
- PM:深链按 dirty 分流(推翻原"深链不改"),兑现"通知点进来直接看 diff"。
- PM+CTO 合议:stuck push 不全砍但阈值与琥珀点解耦、调高到 600s、独立去抖——保留真洞覆盖,压低 JuiceFS 误报。
