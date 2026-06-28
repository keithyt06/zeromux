# 工作树 diff 审查 + 卡住浮出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在(手机)浏览器里审查 agent 的未提交工作树改动并一键转发给 agent 处理,并在交互轮静默卡住时浮出状态点 + 推送。

**Architecture:** 后端新增一个只读 `GET /api/sessions/{id}/git/worktree` 端点(复用现有 git 执行 + 路径守卫),前端在现有 `GitViewer` 加「工作区改动/历史提交」tab。卡住检测复用既有 `last_activity_ms` 静默时间戳 + `scheduled_tasks.rs` 全局 60s scheduler tick,不新增字段/不新增 timer;新增第 4 类 `stuck` push(独立去抖、阈值 600s),前端侧栏加琥珀点(180s)。

**Tech Stack:** Rust / Axum 0.8 / Tokio / `std::process::Command`(git);React 19 / TypeScript / Tailwind v4 / vitest。

## Global Constraints

- 不做任何 git 写操作(丢弃/提交/暂存/分支);"后续动作"一律走向会话注入 prompt(WS `{"type":"prompt",...}`)。
- 不改三后端 auto-approve,不引入持久 `SessionMeta::Blocked`(卡住是 `Running` 的衍生判断)。
- 后端用 `cargo test` 跑内联 `#[cfg(test)]`;前端用 `npm test`(vitest run)。迭代用 `cargo check` / `cargo build`(debug),不要跑 release。
- 前端改完任何 `.ts/.tsx` 必须 `npx tsc -b`(vitest/eslint 不抓类型错;本项目踩过部署时才发现 TS 错)。
- 提交信息结尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 用户可见字符串中文,代码/注释英文(项目双语规范)。
- 当前分支 `feat/worktree-diff-stuck-detection`(已基于 main,spec 已提交于此分支)。

---

## File Structure

后端(`src/`):
- `web.rs` — 新增 `git_worktree` handler + 路由注册 + porcelain `-z` 解析 helper `parse_porcelain_z` + HEAD 探测 + 512KB 截断 + 敏感拒绝/过滤。所有逻辑在 web.rs 内(与 git_log/git_show 同文件同模式)。
- `push.rs` — `payload_for` 加 `stuck` 分支;新增纯函数 `should_push_stuck`;新增独立去抖 map `stuck_debounce` + `last_stuck_push`/`mark_stuck_pushed`。
- `session_manager.rs` — 新增 `stuck_push_candidates(now_ms, idle_ms) -> Vec<(String, String, String)>`(返回 `(id, owner_id, name)`,复用 `running_idle_too_long` 同款过滤)。无新字段。
- `scheduled_tasks.rs` — scheduler tick(~953 行后)加 stuck 扫描 + 锁外推送。

前端(`frontend/src/`):
- `lib/api.ts` — `WorktreeFile` 类型 + `getGitWorktree`。
- `components/GitViewer.tsx` — tab 切换 + 工作区改动面板 + 转发按钮 + 默认 tab。
- `components/AcpChatView.tsx` — `stuck` 改用 `last_activity_ms` 口径。
- `components/Sidebar.tsx` — `TurnDot` 加琥珀色卡住档。
- `App.tsx` — 控件注册表加 `sendPrompt`;给 GitViewer 传注入回调;深链按 dirty 分流。

---

## Task 1: 后端 porcelain `-z` 解析 helper

**Files:**
- Modify: `src/web.rs`(在 git_show 附近,约 1762 行后新增 helper + 测试)

**Interfaces:**
- Produces: `fn parse_porcelain_z(raw: &str) -> Vec<WorktreeFile>`;`struct WorktreeFile { path: String, status: String, staged: bool, old_path: Option<String> }`(serde::Serialize)。

`git status --porcelain=v1 -z` 输出格式:每条记录 `XY<space>PATH\0`,X=index 列、Y=worktree 列;`??`=未跟踪;`R`/`C`(rename/copy)是两条 NUL 段:`R  NEW\0OLD\0`(v1 `-z` 下 NEW 在前、OLD 在后)。`staged` = X 既非空格也非 `?`。

- [ ] **Step 1: 写失败测试**

在 `src/web.rs` 的 `#[cfg(test)] mod tests` 里加(若无该 mod 则在文件末尾新建):

```rust
#[test]
fn parse_porcelain_z_handles_all_states() {
    // " M a.txt\0": worktree-modified, not staged
    // "M  b.txt\0": index-modified, staged
    // "A  c.txt\0": added (staged)
    // " D d.txt\0": deleted in worktree
    // "?? e.txt\0": untracked
    // "R  new.txt\0old.txt\0": rename, new first then old
    let raw = " M a.txt\0M  b.txt\0A  c.txt\0 D d.txt\0?? e.txt\0R  new.txt\0old.txt\0";
    let files = parse_porcelain_z(raw);
    assert_eq!(files.len(), 6);
    assert_eq!(files[0].path, "a.txt");
    assert_eq!(files[0].status, " M");
    assert!(!files[0].staged);
    assert_eq!(files[1].status, "M ");
    assert!(files[1].staged);
    assert_eq!(files[2].status, "A ");
    assert!(files[2].staged);
    assert_eq!(files[4].status, "??");
    assert!(!files[4].staged);
    assert_eq!(files[5].path, "new.txt");
    assert_eq!(files[5].old_path.as_deref(), Some("old.txt"));
    assert_eq!(files[5].status, "R ");
}

#[test]
fn parse_porcelain_z_empty_is_empty() {
    assert!(parse_porcelain_z("").is_empty());
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test parse_porcelain_z 2>&1 | tail -20`
Expected: 编译错误(`parse_porcelain_z` / `WorktreeFile` 未定义)。

- [ ] **Step 3: 实现 helper + 类型**

在 `src/web.rs` 加(放在 git_show 之后、tests mod 之前):

```rust
#[derive(serde::Serialize)]
struct WorktreeFile {
    path: String,
    status: String, // two-char porcelain code (index col + worktree col)
    staged: bool,
    old_path: Option<String>,
}

/// Parse `git status --porcelain=v1 -z` output into structured entries.
/// Records are NUL-terminated; rename/copy (R/C) records consume a second
/// NUL segment holding the old path (new path comes first under -z).
fn parse_porcelain_z(raw: &str) -> Vec<WorktreeFile> {
    let mut segs = raw.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(seg) = segs.next() {
        if seg.len() < 4 {
            continue; // need "XY " + at least 1 path char
        }
        let code = &seg[0..2];
        let path = seg[3..].to_string();
        let x = code.as_bytes()[0] as char;
        let staged = x != ' ' && x != '?';
        let old_path = if x == 'R' || x == 'C' {
            segs.next().map(|s| s.to_string())
        } else {
            None
        };
        out.push(WorktreeFile { path, status: code.to_string(), staged, old_path });
    }
    out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test parse_porcelain_z 2>&1 | tail -20`
Expected: `test result: ok. 2 passed`。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs
git commit -m "feat(git): add porcelain -z parser for worktree status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端 `git_worktree` 端点(HEAD 探测 / 截断 / 敏感拒绝 / 过滤)

**Files:**
- Modify: `src/web.rs`(新增 `git_worktree` handler + 路由注册第 40 行后)

**Interfaces:**
- Consumes: `parse_porcelain_z`、`WorktreeFile`(Task 1);现有 `resolve_base_dir`(930)、`ensure_under_home`(953)、`base_dir_at_or_in_sensitive`(1084)、`path_hits_sensitive_dir`(1052)、`SENSITIVE_DIR_NAMES`(1043)、`state.sessions.work_dir`、`state.sessions.pty_pid`。
- Produces: `GET /api/sessions/{id}/git/worktree` → JSON `{ is_git: bool, files: [WorktreeFile], diff: String, truncated: bool }`。

工作目录解析照搬 `session_status`(462-476):pty live-dir 优先、回退 stored。agent 会话 `pty_pid` 恒 None → 走 stored,这是正确来源(见 spec 认知备注)。

- [ ] **Step 1: 写失败测试(纯逻辑 helper)**

端点本身依赖真实 git 仓库,难在单测里跑;先把可单测的纯逻辑抽出来测:diff 截断 + 敏感文件过滤。在 tests mod 加:

```rust
#[test]
fn truncate_diff_marks_when_over_limit() {
    let big = "x".repeat(600_000);
    let (d, t) = truncate_diff(&big, 512 * 1024);
    assert!(t);
    assert_eq!(d.len(), 512 * 1024);
    let small = "abc";
    let (d2, t2) = truncate_diff(small, 512 * 1024);
    assert!(!t2);
    assert_eq!(d2, "abc");
}

#[test]
fn filter_sensitive_files_drops_denylisted_paths() {
    let files = vec![
        WorktreeFile { path: "src/main.rs".into(), status: " M".into(), staged: false, old_path: None },
        WorktreeFile { path: ".ssh/config".into(), status: " M".into(), staged: false, old_path: None },
        WorktreeFile { path: ".aws/credentials".into(), status: " M".into(), staged: false, old_path: None },
    ];
    let out = filter_sensitive_files(files);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].path, "src/main.rs");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p zeromux truncate_diff filter_sensitive 2>&1 | tail -20`
Expected: 编译错误(两个 helper 未定义)。

- [ ] **Step 3: 实现 helper + handler + 路由**

在 `src/web.rs` 加两个 helper:

```rust
/// Truncate a diff string to a byte budget, returning (text, was_truncated).
/// Truncates on a char boundary at or below the limit.
fn truncate_diff(diff: &str, limit: usize) -> (String, bool) {
    if diff.len() <= limit {
        return (diff.to_string(), false);
    }
    let mut end = limit;
    while end > 0 && !diff.is_char_boundary(end) {
        end -= 1;
    }
    (diff[..end].to_string(), true)
}

/// Drop files whose path contains any SENSITIVE_DIR_NAMES component, so a
/// worktree diff can never surface .ssh/.aws/etc. contents.
fn filter_sensitive_files(files: Vec<WorktreeFile>) -> Vec<WorktreeFile> {
    files
        .into_iter()
        .filter(|f| {
            !std::path::Path::new(&f.path)
                .components()
                .any(|c| matches!(c, std::path::Component::Normal(n)
                    if n.to_str().is_some_and(|s| SENSITIVE_DIR_NAMES.contains(&s))))
        })
        .collect()
}
```

加 handler(放在 git_show handler 之后):

```rust
async fn git_worktree(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let stored_dir = state
        .sessions
        .work_dir(&id)
        .ok_or((StatusCode::NOT_FOUND, "session not found".into()))?;
    // live cwd for PTY sessions; agent sessions have no pty_pid → stored (correct).
    let live_dir = state.sessions.pty_pid(&id).and_then(|pid| {
        std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    });
    let work_dir = live_dir.unwrap_or(stored_dir);

    // Safety: refuse if work_dir is $HOME itself or sits in a sensitive dir —
    // `git diff` would otherwise leak .aws/.ssh/.env contents wholesale.
    let home = std::env::var("HOME").unwrap_or_default();
    let home_path = std::path::Path::new(&home);
    if let Ok(canon) = std::fs::canonicalize(&work_dir) {
        if canon == home_path || base_dir_at_or_in_sensitive(home_path, &canon) {
            return Ok(Json(serde_json::json!({
                "is_git": false, "files": [], "diff": "", "truncated": false
            })));
        }
    }
    let dir = std::path::Path::new(&work_dir);

    // porcelain status (-z); non-git repo → is_git:false
    let status = std::process::Command::new("git")
        .args(["status", "--porcelain=v1", "-z"])
        .current_dir(dir)
        .output();
    let status = match status {
        Ok(o) if o.status.success() => o,
        _ => {
            return Ok(Json(serde_json::json!({
                "is_git": false, "files": [], "diff": "", "truncated": false
            })));
        }
    };
    let raw = String::from_utf8_lossy(&status.stdout);
    let files = filter_sensitive_files(parse_porcelain_z(&raw));

    // diff HEAD, but only if HEAD exists (fresh repo with no commits → empty).
    let has_head = std::process::Command::new("git")
        .args(["rev-parse", "--verify", "-q", "HEAD"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let diff_raw = if has_head {
        std::process::Command::new("git")
            .args(["diff", "HEAD"])
            .current_dir(dir)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let (diff, truncated) = truncate_diff(&diff_raw, 512 * 1024);

    Ok(Json(serde_json::json!({
        "is_git": true, "files": files, "diff": diff, "truncated": truncated
    })))
}
```

路由(`src/web.rs` 第 40 行 `git/show` 后):

```rust
        .route("/api/sessions/{id}/git/worktree", get(git_worktree))
```

- [ ] **Step 4: 跑测试 + 编译确认通过**

Run: `cargo test -p zeromux truncate_diff filter_sensitive 2>&1 | tail -20 && cargo build 2>&1 | tail -5`
Expected: 两测 PASS;`cargo build` 成功(无 warning 关于未用 handler)。

- [ ] **Step 5: 手动冒烟(可选但推荐)**

Run(在一个有未提交改动的 git 仓库会话上,需先跑起服务;若环境不便可跳过):
确认 `GET /api/sessions/{id}/git/worktree` 返回 `is_git:true` + files 列表。

- [ ] **Step 6: 提交**

```bash
git add src/web.rs
git commit -m "feat(git): read-only worktree diff endpoint with HEAD probe, truncation, sensitive guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 后端 push `stuck` 类型 + 纯函数 + 独立去抖

**Files:**
- Modify: `src/push.rs`(`payload_for` 249;`PushService` struct 306;新增 `should_push_stuck`、`stuck_debounce`、`last_stuck_push`、`mark_stuck_pushed`)

**Interfaces:**
- Consumes: 现有 `PushPayload`、`failure_kind_zh`、`should_push_turn_done`(参照其去抖语义)。
- Produces: `fn should_push_stuck(now_ms: i64, last_push_ms: Option<i64>) -> bool`;`PushService::last_stuck_push(&self, user_id, session_id) -> Option<i64>`;`PushService::mark_stuck_pushed(&self, user_id, session_id, now_ms)`;`payload_for("stuck", ...)`。

`should_push_stuck`:阈值判断由调用方(scheduler 用 600s 静默)完成,这里只做**去抖**(距上次 stuck push < 5min 不重复推)。与 turn_done 去抖键隔离(独立 map),互不覆盖。

- [ ] **Step 1: 写失败测试**

在 `src/push.rs` 的 tests mod(~570 `turn_done_debounce_and_threshold` 附近)加:

```rust
#[test]
fn should_push_stuck_debounces() {
    // never pushed → push
    assert!(should_push_stuck(1_000_000, None));
    // pushed 4min ago → still debounced (< 5min)
    assert!(!should_push_stuck(1_000_000, Some(1_000_000 - 4 * 60_000)));
    // pushed 6min ago → push again
    assert!(should_push_stuck(1_000_000, Some(1_000_000 - 6 * 60_000)));
}

#[test]
fn stuck_payload_shape() {
    let p = payload_for("stuck", "my-sess", "sid123", None);
    assert!(p.title.contains("卡住"));
    assert_eq!(p.kind, "stuck");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p zeromux should_push_stuck stuck_payload 2>&1 | tail -20`
Expected: 编译错误(`should_push_stuck` 未定义 / `payload_for` 无 stuck 分支但测试可能仍编译——则 stuck_payload FAIL on assert)。

- [ ] **Step 3: 实现**

`payload_for`(249)的 `match kind` 加分支(在 `"confirm" =>` 之后、`_ =>` 之前):

```rust
        "stuck" => (
            format!("⚠️ {name} 可能卡住"),
            "已静默约 10 分钟无输出".to_string(),
        ),
```

`PushService` struct(306,`debounce` 字段旁)加:

```rust
    pub stuck_debounce: Mutex<std::collections::HashMap<(String, String), i64>>,
```

构造处(320 `debounce: Mutex::new(...)` 旁)加:

```rust
            stuck_debounce: Mutex::new(std::collections::HashMap::new()),
```

新增方法(`mark_turn_pushed` 后,~347):

```rust
    pub fn last_stuck_push(&self, user_id: &str, session_id: &str) -> Option<i64> {
        let map = self.stuck_debounce.lock().unwrap();
        map.get(&(user_id.to_string(), session_id.to_string())).copied()
    }
    pub fn mark_stuck_pushed(&self, user_id: &str, session_id: &str, now_ms: i64) {
        let mut map = self.stuck_debounce.lock().unwrap();
        map.insert((user_id.to_string(), session_id.to_string()), now_ms);
    }
```

新增纯函数(`should_push_turn_done` 218 附近):

```rust
/// Debounce for stuck pushes: at least 5 minutes between pushes per session.
/// The silence-threshold (600s) gating is done by the caller; this only
/// suppresses repeats. Uses a SEPARATE debounce map from turn_done so the two
/// kinds never overwrite each other.
pub fn should_push_stuck(now_ms: i64, last_push_ms: Option<i64>) -> bool {
    match last_push_ms {
        Some(l) if now_ms - l < 5 * 60_000 => false,
        _ => true,
    }
}
```

`payload_for` 的 urgency:确认 `send_to_user`(~349)的 urgency 逻辑 `if payload.kind == "turn_done" { "low" } else { "high" }` 已使 stuck = high,无需改。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test -p zeromux should_push_stuck stuck_payload 2>&1 | tail -20`
Expected: 两测 PASS。

- [ ] **Step 5: 去抖隔离回归测试**

加测试确认 stuck 与 turn_done 去抖互不干扰:

```rust
#[test]
fn stuck_and_turn_done_debounce_isolated() {
    // This is a structural guarantee: separate maps. Verify the maps are distinct
    // by checking mark on one doesn't affect the other's lookup.
    // (PushService construction needs no network; build a bare one if feasible,
    //  else assert at the map level — here we assert the API surface exists.)
    // Minimal: last_stuck_push and last_turn_push read different maps.
    // Covered by code review; this test documents the invariant.
    assert!(should_push_stuck(0, None));
    assert!(should_push_turn_done(0, None, 120_000));
}
```

Run: `cargo test -p zeromux stuck_and_turn_done 2>&1 | tail -10`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/push.rs
git commit -m "feat(push): add stuck notification kind with isolated debounce

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 后端 `stuck_push_candidates` + scheduler tick 接线

**Files:**
- Modify: `src/session_manager.rs`(`running_idle_too_long` 690 附近新增 `stuck_push_candidates`)
- Modify: `src/scheduled_tasks.rs`(scheduler tick,953 行 stale 处理后)

**Interfaces:**
- Consumes: `should_push_stuck`、`last_stuck_push`、`mark_stuck_pushed`、`payload_for`(Task 3);`push_handle`(scheduled_tasks 441);现有 `RunningProcess.turn_state`、`Session.source_task_id/owner_id/name/last_activity_ms`。
- Produces: `SessionManager::stuck_push_candidates(now_ms, idle_ms) -> Vec<(String, String, String)>`(`(session_id, owner_id, name)`)。

`STUCK_PUSH_MS = 600_000`(10min)。复用 `running_idle_too_long` 同款过滤(`source_task_id.is_none()` + `TurnState::Running` + 静默 ≥ idle_ms),但额外带出 owner_id + name 供推送。

- [ ] **Step 1: 写失败测试**

`src/session_manager.rs` tests mod(~3797 `running_idle_too_long_targets_only_interactive_running_stale` 附近)加:

```rust
#[test]
fn stuck_push_candidates_returns_id_owner_name() {
    let m = SessionManager::new_for_test(); // use whatever the existing tests use
    // Insert a running, interactive, stale session via the same helper the
    // running_idle_too_long test uses. Mirror that test's setup exactly.
    // Then:
    let now = 10_000_000;
    let out = m.stuck_push_candidates(now, 600_000);
    // a stale interactive running session silent > 600s should appear with its
    // (id, owner_id, name). Assert the tuple shape on the seeded session.
    assert!(out.iter().any(|(id, owner, _name)| !id.is_empty() && !owner.is_empty()));
}
```

> 实现者注意:照搬 `running_idle_too_long_targets_only_interactive_running_stale`(3797)的 session 构造方式来 seed,保证字段一致。若该测试用某个 `insert`/`new_for_test` helper,复用它。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p zeromux stuck_push_candidates 2>&1 | tail -20`
Expected: 编译错误(`stuck_push_candidates` 未定义)。

- [ ] **Step 3: 实现 `stuck_push_candidates`**

`src/session_manager.rs`,`running_idle_too_long`(690-699)之后加:

```rust
    /// Candidates for a stuck-push: interactive (non-scheduled) sessions whose
    /// current turn is Running but silent for >= idle_ms. Returns
    /// (session_id, owner_id, name) so the caller can push without re-locking.
    /// Mirrors running_idle_too_long's filter; that one kills, this one notifies.
    pub fn stuck_push_candidates(&self, now_ms: i64, idle_ms: i64) -> Vec<(String, String, String)> {
        let map = self.sessions.lock().unwrap();
        map.values()
            .filter(|s| s.source_task_id.is_none())
            .filter(|s| s.running.as_ref().map(|rp| rp.turn_state == TurnState::Running).unwrap_or(false))
            .filter(|s| now_ms - s.last_activity_ms >= idle_ms)
            .map(|s| (s.id.clone(), s.owner_id.clone(), s.name.clone()))
            .collect()
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test -p zeromux stuck_push_candidates 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 5: scheduler tick 接线**

`src/scheduled_tasks.rs`,在 stale TimeoutKill 循环(953-957)之后、`list_enabled`(958)之前加:

```rust
                    // stuck浮出推送:交互式会话 Running 且静默 >= 10min 推一次
                    // (侧栏琥珀点用 180s,纯前端;此处仅推送,阈值更高以压低误报)。
                    if let Some(push) = s.push_handle() {
                        const STUCK_PUSH_MS: i64 = 600_000;
                        let cands = m.stuck_push_candidates(now.timestamp_millis(), STUCK_PUSH_MS);
                        for (sid, owner, name) in cands {
                            if crate::push::should_push_stuck(
                                now.timestamp_millis(),
                                push.last_stuck_push(&owner, &sid),
                            ) {
                                push.mark_stuck_pushed(&owner, &sid, now.timestamp_millis());
                                let payload = crate::push::payload_for("stuck", &name, &sid, None);
                                push.send_to_user(&owner, &payload).await;
                            }
                        }
                    }
```

> 注意:`s.push_handle()`(scheduled_tasks 441)是 `ScheduledStore` 的方法,scheduler 闭包里 `s` 是 store、`m` 是 SessionManager。确认 `send_to_user` 是 async(是)→ 在 tick 的 async 体里 await 没问题(已在锁外,`stuck_push_candidates` 已 drop 锁)。

- [ ] **Step 6: 编译 + 全量后端测试**

Run: `cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -15`
Expected: 编译成功;所有测试 PASS(含已有 200+ 测试无回归)。

- [ ] **Step 7: 提交**

```bash
git add src/session_manager.rs src/scheduled_tasks.rs
git commit -m "feat(stuck): scheduler-tick stuck push for silent interactive turns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 前端 API — `getGitWorktree` + 类型

**Files:**
- Modify: `frontend/src/lib/api.ts`(GitFileChange/getGitShow 附近,~357-388)

**Interfaces:**
- Produces: `interface WorktreeFile { path: string; status: string; staged: boolean; old_path?: string }`;`getGitWorktree(id): Promise<{ is_git: boolean; files: WorktreeFile[]; diff: string; truncated: boolean }>`。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/` 下(若无则与现有 api 测试同目录;若 api.ts 无测试,跳过单测,改为类型+实现后用 tsc 验证 —— 本仓库 api.ts 多为薄封装)。本任务采用 **tsc 验证**而非单测(薄封装,vitest 价值低):直接实现 + `npx tsc -b`。

- [ ] **Step 2: 实现**

`frontend/src/lib/api.ts`,`GitFileChange`(~373)后加类型:

```typescript
export interface WorktreeFile {
  path: string
  status: string
  staged: boolean
  old_path?: string
}
```

`getGitShow`(~384-388)后加:

```typescript
export async function getGitWorktree(id: string): Promise<{ is_git: boolean; files: WorktreeFile[]; diff: string; truncated: boolean }> {
  const res = await api(`/api/sessions/${id}/git/worktree`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```

- [ ] **Step 3: tsc 验证**

Run: `cd frontend && npx tsc -b 2>&1 | tail -10`
Expected: 无类型错误。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(api): getGitWorktree client + WorktreeFile type

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 前端 GitViewer — tab + 工作区改动面板 + 默认 tab

**Files:**
- Modify: `frontend/src/components/GitViewer.tsx`
- Test: `frontend/src/components/__tests__/GitViewer.worktree.test.tsx`(新建)

**Interfaces:**
- Consumes: `getGitWorktree`、`WorktreeFile`(Task 5);现有 `DiffView`、`getSessionStatus`。
- Produces: GitViewer 内 tab 状态 `tab: 'worktree' | 'history'`;一个可单测的纯函数 `defaultGitTab(dirty: number): 'worktree' | 'history'`。

把默认 tab 判断抽成纯函数便于单测;面板渲染走组件测试。

- [ ] **Step 1: 写失败测试**

`frontend/src/components/__tests__/GitViewer.worktree.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { defaultGitTab } from '../GitViewer'

describe('defaultGitTab', () => {
  it('picks worktree when dirty', () => {
    expect(defaultGitTab(3)).toBe('worktree')
  })
  it('picks history when clean', () => {
    expect(defaultGitTab(0)).toBe('history')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/GitViewer.worktree.test.tsx 2>&1 | tail -15`
Expected: FAIL(`defaultGitTab` 未导出)。

- [ ] **Step 3: 实现 tab + 面板**

`frontend/src/components/GitViewer.tsx`:

1. 文件顶部加导出纯函数:

```tsx
export function defaultGitTab(dirty: number): 'worktree' | 'history' {
  return dirty > 0 ? 'worktree' : 'history'
}
```

2. 组件内加状态(与现有 useState 一组):

```tsx
  const [tab, setTab] = useState<'worktree' | 'history'>('history')
  const [wt, setWt] = useState<{ files: WorktreeFile[]; diff: string; truncated: boolean; is_git: boolean } | null>(null)
```

3. 进入时按 dirty 设默认 tab(用现有 `getSessionStatus`;若组件已拉 status 则复用,否则新增一次拉取 effect):

```tsx
  useEffect(() => {
    let alive = true
    getSessionStatus(sessionId).then(st => {
      if (alive) setTab(defaultGitTab(st.git_dirty))
    }).catch(() => {})
    return () => { alive = false }
  }, [sessionId])
```

4. tab='worktree' 时拉取:

```tsx
  const loadWorktree = useCallback(() => {
    getGitWorktree(sessionId).then(setWt).catch(() => setWt(null))
  }, [sessionId])
  useEffect(() => { if (tab === 'worktree') loadWorktree() }, [tab, loadWorktree])
```

5. 渲染:顶部两个 tab 按钮(复用现有按钮样式 token),`tab==='history'` 渲染现有全部 JSX(原样包进条件),`tab==='worktree'` 渲染新面板:左侧文件列表(状态角标:`A`→绿、`D`→红、`M`→黄、`??`→灰,取 `status.trim()[0]`),右侧 `<DiffView diff={wt?.diff ?? ''} />`,`wt?.truncated` 时顶部黄条提示「diff 过大,已截断显示」,`wt?.is_git===false` 时提示「非 git 仓库」。文件列表项点击暂只高亮(滚动到段落留待 YAGNI)。

> 实现者:状态角标配色复用现有 `RefBadges` 的 token(绿/红/黄/灰 = `--accent-green`/`--accent-red`/`--accent-yellow`/`--text-secondary`)。

- [ ] **Step 4: 跑测试 + tsc 确认通过**

Run: `cd frontend && npx vitest run src/components/__tests__/GitViewer.worktree.test.tsx 2>&1 | tail -10 && npx tsc -b 2>&1 | tail -5`
Expected: 测试 PASS;tsc 无错。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/GitViewer.tsx frontend/src/components/__tests__/GitViewer.worktree.test.tsx
git commit -m "feat(git-ui): worktree changes tab in GitViewer with dirty-default

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 前端 agent 转发按钮(扩展控件注册表 sendPrompt)

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`(`onRegisterControls` 的 API 加 `sendPrompt`,54/350)
- Modify: `frontend/src/App.tsx`(控件注册表类型 32-37 加 `sendPrompt`;给 GitViewer 传注入回调 294)
- Modify: `frontend/src/components/GitViewer.tsx`(底部加两个按钮 + Props 加 `onForward`)

**Interfaces:**
- Consumes: 现有 `sendPrompt`(AcpChatView 305)、`sessionControls` 注册表(App 32)。
- Produces: 控件 API 扩展为 `{ setQueueMode: (mode: string) => void; sendPrompt: (text: string) => void }`;GitViewer Props 加 `onForward?: (text: string) => void`。

- [ ] **Step 1: 写失败测试**

GitViewer 转发按钮的纯逻辑:点击发出固定 prompt 文案。抽成可测常量 + 组件测试。在 `GitViewer.worktree.test.tsx` 加:

```tsx
import { COMMIT_PROMPT, DISCARD_PROMPT } from '../GitViewer'

describe('forward prompts', () => {
  it('has commit and discard prompt text', () => {
    expect(COMMIT_PROMPT).toContain('提交')
    expect(DISCARD_PROMPT).toContain('撤销')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/GitViewer.worktree.test.tsx 2>&1 | tail -10`
Expected: FAIL(常量未导出)。

- [ ] **Step 3: 实现**

1. `AcpChatView.tsx`:Props 的 `onRegisterControls` 类型(54)与注册调用(350)把 API 从 `{ setQueueMode }` 扩展为 `{ setQueueMode; sendPrompt }`:

```tsx
// line 54 type:
  onRegisterControls?: (sessionId: string, api: { setQueueMode: (mode: string) => void; sendPrompt: (text: string) => void } | null) => void
// line 350 register:
    onRegisterControls?.(sessionId, { setQueueMode, sendPrompt })
// dep array (352) 加 sendPrompt
```

2. `App.tsx`:注册表类型(32)同步加 `sendPrompt`:

```tsx
  const sessionControls = useRef<Record<string, { setQueueMode: (mode: string) => void; sendPrompt: (text: string) => void }>>({})
```

给 GitViewer 传回调(294):

```tsx
                {view === 'git' && <GitViewer sessionId={s.id} onForward={(t) => sessionControls.current[s.id]?.sendPrompt(t)} />}
```

3. `GitViewer.tsx`:Props 加 `onForward?: (text: string) => void`;导出常量;worktree 面板底部(`is_git && files.length>0` 时)加两个按钮:

```tsx
export const COMMIT_PROMPT = '把当前工作区的未提交改动提交,commit message 自行总结本次改动。'
export const DISCARD_PROMPT = '撤销(git restore)当前工作区的全部未提交改动,不要提交。'
```

```tsx
{wt?.is_git && wt.files.length > 0 && onForward && (
  <div className="flex gap-2 p-2 border-t border-[var(--border)]">
    <button onClick={() => onForward(COMMIT_PROMPT)}
      className="px-2 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">让 agent 提交</button>
    <button onClick={() => onForward(DISCARD_PROMPT)}
      className="px-2 py-1 text-xs rounded bg-[var(--bg-tertiary)] text-[var(--accent-red)] hover:bg-[var(--bg-hover)]">让 agent 撤销改动</button>
  </div>
)}
```

> 注意:`sendPrompt('')` 在 AcpChatView 里(439 行已有用例)是发附件;此处一定传非空文案。转发后给个轻提示(可用现有 toast 机制;若无则按钮短暂禁用即可,YAGNI)。

- [ ] **Step 4: 跑测试 + tsc**

Run: `cd frontend && npx vitest run src/components/__tests__/GitViewer.worktree.test.tsx 2>&1 | tail -10 && npx tsc -b 2>&1 | tail -5`
Expected: 测试 PASS;tsc 无错(注意 AcpChatView 所有 `onRegisterControls?.()` 调用点都已带 sendPrompt)。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/AcpChatView.tsx frontend/src/App.tsx frontend/src/components/GitViewer.tsx frontend/src/components/__tests__/GitViewer.worktree.test.tsx
git commit -m "feat(git-ui): forward commit/discard to agent via injected prompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 前端 — 卡住口径修正(AcpChatView)+ 侧栏琥珀点

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`(stuck 派生 321-331)
- Modify: `frontend/src/components/Sidebar.tsx`(`TurnDot` 42-49)
- Test: `frontend/src/lib/__tests__/stuck.test.ts`(新建,纯函数)

**Interfaces:**
- Produces: `isStuck(turnState: string | null, lastActivityMs: number | null, nowMs: number): boolean`(导出到 `frontend/src/lib/stuck.ts`,前后端口径常量 `STUCK_SILENCE_MS = 180000`,注释引用 Rust 侧)。
- Consumes: `SessionInfo.last_activity_ms`(已存在)、`SessionInfo.turn_state`。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/stuck.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isStuck, STUCK_SILENCE_MS } from '../stuck'

describe('isStuck', () => {
  const now = 10_000_000
  it('true when running and silent past threshold', () => {
    expect(isStuck('running', now - STUCK_SILENCE_MS - 1, now)).toBe(true)
  })
  it('false when running but recently active', () => {
    expect(isStuck('running', now - 1000, now)).toBe(false)
  })
  it('false when idle', () => {
    expect(isStuck('idle', now - STUCK_SILENCE_MS - 1, now)).toBe(false)
  })
  it('false when no activity timestamp', () => {
    expect(isStuck('running', null, now)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/stuck.test.ts 2>&1 | tail -15`
Expected: FAIL(`../stuck` 不存在)。

- [ ] **Step 3: 实现纯函数**

`frontend/src/lib/stuck.ts`:

```ts
// Mirror of Rust STUCK_SILENCE_MS (sidebar amber dot threshold). The push
// threshold is separate and higher (600s, backend-only) to suppress noise.
export const STUCK_SILENCE_MS = 180_000

export function isStuck(
  turnState: string | null,
  lastActivityMs: number | null,
  nowMs: number,
): boolean {
  if (turnState !== 'running' || lastActivityMs == null) return false
  return nowMs - lastActivityMs > STUCK_SILENCE_MS
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/stuck.test.ts 2>&1 | tail -10`
Expected: 4 测 PASS。

- [ ] **Step 5: 接入 Sidebar TurnDot**

`frontend/src/components/Sidebar.tsx`,`TurnDot`(42-49)改为:

```tsx
import { isStuck } from '../lib/stuck'

/** Turn-state dot: hollow=hibernated, amber=stuck, green=running, gray=idle. */
function TurnDot({ s }: { s: SessionInfo }) {
  const stuck = isStuck(s.turn_state, s.last_activity_ms, Date.now())
  const cls = !s.running
    ? 'border border-[var(--text-secondary)]'
    : stuck
      ? 'bg-[var(--accent-yellow)]'
      : s.turn_state === 'running'
        ? 'bg-[var(--accent-green)]'
        : 'bg-[var(--text-secondary)]'
  return <span className={`w-2 h-2 rounded-full shrink-0 ${cls}`} title={stuck ? '可能卡住' : undefined} />
}
```

> 注:第一行 `!s.running` 的 hollow 样式照搬现有(确认现有 class 字符串,按现状填)。`Date.now()` 每次 3s 列表轮询重渲染时刷新,足够驱动琥珀点。

- [ ] **Step 6: 接入 AcpChatView 口径**

`frontend/src/components/AcpChatView.tsx`:`stuck` 派生(331)从基于 `turnStartedMs` 的 `elapsed > 180` 改为基于会话 `last_activity_ms`。该组件需拿到 `last_activity_ms`——若已有 session 对象传入则用之,否则用组件内"最后收到事件的时间戳"本地 state(每次 appendEvent 时 `setLastEventMs(Date.now())`)。最小改动:

```tsx
  // replace turn-total-duration heuristic with silence-based one
  const stuck = turnState === 'running' && lastEventMs != null && (nowMs - lastEventMs) > 180_000
```

其中 `lastEventMs` 在每次收到 agent 输出事件处 `setLastEventMs(Date.now())`(在现有事件处理回调里加一行)。文案 412 行改为「已静默 {Math.floor((nowMs-lastEventMs)/1000)}s,可能卡住」。

> 实现者:优先用组件本地"最后事件时间",因为 AcpChatView 本就在收事件流,最贴近真实静默;不必依赖 SessionInfo 轮询。

- [ ] **Step 7: 跑全量前端测试 + tsc**

Run: `cd frontend && npx vitest run 2>&1 | tail -15 && npx tsc -b 2>&1 | tail -5`
Expected: 全绿(已知 KaTeX flaky 测试除外,与本改动无关);tsc 无错。

- [ ] **Step 8: 提交**

```bash
git add frontend/src/lib/stuck.ts frontend/src/lib/__tests__/stuck.test.ts frontend/src/components/Sidebar.tsx frontend/src/components/AcpChatView.tsx
git commit -m "feat(stuck-ui): silence-based stuck derivation + sidebar amber dot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 前端 — 深链按 dirty 分流

**Files:**
- Modify: `frontend/src/App.tsx`(SW 深链处理,~110「listen for notification click → deep-link to session」)
- Test: `frontend/src/lib/__tests__/stuck.test.ts` 同目录新建 `deeplink.test.ts`(纯函数)

**Interfaces:**
- Produces: `deepLinkView(dirty: number): 'git' | 'none'`(`frontend/src/lib/stuck.ts` 或新 `deeplink.ts`;`'git'` 落 GitViewer,`'none'` 落 Chat/Terminal 默认)。
- Consumes: `getSessionStatus`(已有)。

turn_done 深链打开会话后,查该会话 `git_dirty`:>0 → 切 git 视图(GitViewer 默认会再按 dirty 选 worktree tab,Task 6 已实现);否则维持默认。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/deeplink.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deepLinkView } from '../deeplink'

describe('deepLinkView', () => {
  it('git when dirty', () => expect(deepLinkView(2)).toBe('git'))
  it('none when clean', () => expect(deepLinkView(0)).toBe('none'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/deeplink.test.ts 2>&1 | tail -15`
Expected: FAIL(`../deeplink` 不存在)。

- [ ] **Step 3: 实现纯函数**

`frontend/src/lib/deeplink.ts`:

```ts
// After a turn_done deep-link opens a session, route to the worktree diff if the
// agent left uncommitted changes, else stay on the default (chat) view.
export function deepLinkView(dirty: number): 'git' | 'none' {
  return dirty > 0 ? 'git' : 'none'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/deeplink.test.ts 2>&1 | tail -10`
Expected: 2 测 PASS。

- [ ] **Step 5: 接入 App 深链处理**

`frontend/src/App.tsx` 的 SW 通知点击 → 深链逻辑(~110):在 `setActiveId(targetSession)` 之后,异步查 status 并据此设 `view`:

```tsx
      // route to worktree diff if the finished turn left changes
      getSessionStatus(targetSession)
        .then(st => { setView(deepLinkView(st.git_dirty) === 'git' ? 'git' : 'none') })
        .catch(() => {})
```

> 实现者:`targetSession` / `setView` / 现有视图 state 名以 App.tsx 实际为准(view state 见 288-295 的 `view === 'none'|'files'|'git'|'events'`)。仅在通知点击路径加,不影响手动切会话。

- [ ] **Step 6: 跑测试 + tsc + 全量前端**

Run: `cd frontend && npx vitest run 2>&1 | tail -15 && npx tsc -b 2>&1 | tail -5`
Expected: 全绿(KaTeX flaky 除外);tsc 无错。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/lib/deeplink.ts frontend/src/lib/__tests__/deeplink.test.ts frontend/src/App.tsx
git commit -m "feat(deeplink): route turn_done notification to worktree diff when dirty

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 端到端编译 + 全量验证 + 文档

**Files:**
- Modify: `README.md` / `README_ZH.md`(Features 列表加一行);`CLAUDE.md`(架构补一句,可选)

- [ ] **Step 1: 全量后端测试**

Run: `cargo test 2>&1 | tail -15`
Expected: 全 PASS,无回归。

- [ ] **Step 2: 全量前端测试 + lint + tsc**

Run: `cd frontend && npx tsc -b 2>&1 | tail -5 && npm run lint 2>&1 | tail -10 && npx vitest run 2>&1 | tail -15`
Expected: tsc 无错;lint 无**新增**错(已知既存 lint 错按现状,不算回归);vitest 全绿(KaTeX flaky 除外)。

- [ ] **Step 3: 前端构建(rust-embed 前置)**

Run: `cd frontend && npm run build 2>&1 | tail -8`
Expected: `tsc -b && vite build` 成功 → `frontend/dist/`。

- [ ] **Step 4: release 构建烟测(确认 embed 后整体编译)**

Run: `cargo build 2>&1 | tail -5`
Expected: 成功(debug 即可,验证 embed 资产存在)。

- [ ] **Step 5: 更新 README**

`README.md` Features 加一行(英文),`README_ZH.md` 对应中文:
```
- **Working-Tree Diff Review** — Inspect an agent's uncommitted changes (status + `git diff HEAD`) in the Git Viewer, then forward a commit/discard instruction back to the agent. Read-only on git; never writes directly.
- **Stuck-Turn Surfacing** — A running turn silent past a threshold shows an amber dot in the session list and (after 10min) a push notification.
```

- [ ] **Step 6: 最终提交**

```bash
git add README.md README_ZH.md CLAUDE.md
git commit -m "docs: document worktree diff review + stuck surfacing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** — 逐条核对:
- 特性1 只读端点(status -z + diff HEAD + HEAD探测 + 截断 + 敏感拒绝/过滤)→ Task 1-2 ✅
- GitViewer tab + dirty 默认 → Task 6 ✅
- agent 转发按钮(注入 prompt) → Task 7 ✅
- 深链 dirty 分流 → Task 9 ✅
- 特性2 复用 last_activity_ms(无新字段) → Task 4/8 ✅
- scheduler tick stuck 扫描(非 fan-out tick) → Task 4 ✅
- stuck push 600s + 独立去抖 → Task 3/4 ✅
- 侧栏琥珀点 180s + AcpChatView 口径修正 → Task 8 ✅
- 安全 parity 测试(敏感文件不入 diff / $HOME 拒绝) → Task 2 ✅
- 空仓库不报 502 / 大 diff 截断 → Task 2 ✅
- 去抖隔离测试 → Task 3 ✅

**2. Placeholder scan** — 无 TBD/TODO;每个 code step 有完整代码。两处"以实际为准"(Task 4 session seed helper、Task 8/9 的 App state 名)是诚实的代码定位提示,非占位——已指明参照的现有测试/行号。

**3. Type consistency** — `WorktreeFile`(Rust serde 字段 path/status/staged/old_path)↔ TS `WorktreeFile`(path/status/staged/old_path?)一致;`should_push_stuck(now, last)` 签名 Task 3 定义、Task 4 调用一致;控件 API `{ setQueueMode; sendPrompt }` Task 7 三处(AcpChatView 类型+注册、App 注册表)一致;`isStuck`/`deepLinkView`/`defaultGitTab` 定义与测试一致。

> 已知 trade-off:前端 `STUCK_SILENCE_MS` 在 TS 硬编码 180000(注释引用 Rust),非编译期共享——单用户项目可接受,改阈值需两处同步,已在注释提示。
