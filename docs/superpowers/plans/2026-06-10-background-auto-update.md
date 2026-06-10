# 后台自动更新(本机原地升级)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 zeromux binary 加一个后台 watcher,监视一个显式指定的 build 路径,内容变了、且无调度运行在跑(交互 turn 可被 max_wait 强制穿透)时,通过 detached `systemd-run` 原子替换自身并重启,带健康检查自动回滚。默认关闭。

**Architecture:** 新模块 `src/auto_update.rs` 持有一个 `tokio::spawn` 的 watcher 任务,只读 `SessionManager` 的 turn 摘要、读文件系统、派生 detached systemd 服务。不拥有任何会话进程,不破坏广播扇出不变量。核心逻辑切成纯函数(sha 计算、gate 决策、swap 脚本渲染、pending 状态机)便于单测;副作用(spawn、systemd-run)留在任务壳里。

**Tech Stack:** Rust / tokio / clap(已有)、`sha2`+`hex`(Cargo.toml 已依赖)、`std::process::Command`(冒烟 `--help`)、`tokio::process::Command`(systemd-run)。

**来源 spec:** [docs/superpowers/specs/2026-06-10-background-auto-update-design.md](../specs/2026-06-10-background-auto-update-design.md)

---

## 实现前必读:一处对 spec 的工程修正(run_id 信号来源)

spec 的 Idle gate 设想 `running_summary` 能读到「当前 Running turn 是否携带 `run_id`」。**但 `active_run_id` 是 fanout 任务内的局部变量(`session_manager.rs:1589` 的 `let mut`),`SessionManager` 层的只读访问器看不到它。** 强行把它提升到 `RunningProcess` 需要改动三个 fanout 的 7+ 处 `mark_turn` 调用点 —— 大改动、高回归风险,且本功能用不到那么精确。

**修正(本计划采用):用 `Session.source_task_id.is_some()` 作为「这是调度运行会话」的信号。** 调度运行会话经 `create_acp_session_tagged(..., Some(task_id))` 创建,`source_task_id` 是持久化的 `Session` 字段(`session_manager.rs:171`),manager 层可直接读。它是「run_id turn 正在跑」的**保守超集**:一个 source_task 会话即使此刻 Idle 也会被算作 `scheduled`,从而阻塞强制升级。这完全满足 E1 的安全目标(绝不强制砍调度运行),且零 turn-state 新管线。代价:一个调度会话在两次 run 之间的 Idle 间隙也会阻塞 max_wait 强制升级 —— 可接受(调度会话本就短命,且 30min 看门狗会兜底了断;真正全 Idle 时仍可正常升级)。

因此 `RunningSummary` 的字段语义精确化为:
- `scheduled`:`session_type ∈ {Claude,Kiro,Codex}` 且 `source_task_id.is_some()` 且 `running.is_some()` 的会话数(无论其 turn_state)。
- `interactive`:`session_type ∈ {Claude,Kiro,Codex}` 且 `source_task_id.is_none()` 且 `turn_state == Running` 的会话数。

> tmux 会话(`session_type == Tmux`)在两个计数里都跳过。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/auto_update.rs`(新) | watcher 任务 + 4 个纯函数(`sha256_file`、`gate_decision`、`render_swap_script`、pending 状态机内联在任务里但决策走 `gate_decision`)。约 180–220 行含测试。 |
| `src/session_manager.rs`(改) | 新增 `RunningSummary` struct + `running_summary(&self) -> RunningSummary` 只读访问器 + 单测。 |
| `src/main.rs`(改) | 新增 2 个 CLI flag;`mod auto_update;`;router 起来后条件 spawn watcher。 |

无前端改动。无 DB 改动。

---

## Task 1: `RunningSummary` + `running_summary` 访问器

**Files:**
- Modify: `src/session_manager.rs`(在 `TurnState` enum 附近加 struct;在只读访问器区如 `session_exists` 附近加方法;测试加到文件末尾的 `#[cfg(test)]` 区)
- Test: 同文件内联 `#[cfg(test)]`

- [ ] **Step 1: 写失败测试**

加到 `src/session_manager.rs` 末尾(紧跟现有最后一个 `#[cfg(test)] mod ... {}` 之后):

```rust
#[cfg(test)]
mod running_summary_tests {
    use super::*;
    use std::collections::HashMap;

    // 构造一个带 running 进程的会话,可指定类型/是否 source_task/turn_state。
    fn running_session(
        id: &str,
        stype: SessionType,
        source_task_id: Option<String>,
        turn: TurnState,
    ) -> Session {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel::<SessionInput>(64);
        Session {
            id: id.into(),
            name: "n".into(),
            session_type: stype,
            cols: 80,
            rows: 24,
            work_dir: "/tmp".into(),
            owner_id: "o".into(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Idle,
            resume_token: None,
            worktree_path: None,
            created_ms: 0,
            source_task_id,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
            running: Some(RunningProcess {
                event_tx,
                input_tx,
                pty_pid: None,
                turn_state: turn,
                turn_started_ms: None,
                turn_seq: 0,
            }),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        }
    }

    fn mgr_with(sessions: Vec<Session>) -> Arc<SessionManager> {
        let m = SessionManager::new(
            crate::events::EventStore::open(std::path::Path::new("/tmp")).unwrap().into(),
            crate::session_store::SessionStore::open(std::path::Path::new("/tmp")).unwrap().into(),
            "claude".into(), "kiro-cli".into(), "codex".into(), "off".into(), "bash".into(),
        );
        {
            let mut map = m.sessions.lock().unwrap();
            for s in sessions { map.insert(s.id.clone(), s); }
        }
        m
    }

    #[test]
    fn counts_scheduled_and_interactive_skipping_tmux() {
        let m = mgr_with(vec![
            // 调度运行会话(source_task),即使 Idle 也算 scheduled
            running_session("a", SessionType::Claude, Some("task1".into()), TurnState::Idle),
            // 交互 agent,Running → interactive
            running_session("b", SessionType::Codex, None, TurnState::Running),
            // 交互 agent,Idle → 不计
            running_session("c", SessionType::Claude, None, TurnState::Idle),
            // tmux Running → 跳过(无 turn 概念)
            running_session("d", SessionType::Tmux, None, TurnState::Running),
        ]);
        let s = m.running_summary();
        assert_eq!(s.scheduled, 1, "source_task session counts as scheduled regardless of turn");
        assert_eq!(s.interactive, 1, "only non-source running agent counts as interactive");
    }

    #[test]
    fn all_idle_when_no_running_agents() {
        let m = mgr_with(vec![
            running_session("c", SessionType::Claude, None, TurnState::Idle),
            running_session("d", SessionType::Tmux, None, TurnState::Running),
        ]);
        let s = m.running_summary();
        assert_eq!(s.scheduled, 0);
        assert_eq!(s.interactive, 0);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test running_summary_tests 2>&1 | tail -20`
Expected: 编译失败,`no method named running_summary` / `cannot find type RunningSummary`。

- [ ] **Step 3: 实现 struct + 访问器**

在 `src/session_manager.rs` 的 `pub enum TurnState { Idle, Running }`(约 :129)之后加:

```rust
/// 自动更新 idle-gate 用:区分交互 turn 与调度运行。见 auto_update.rs。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunningSummary {
    /// 交互 agent 会话(无 source_task)当前 turn 为 Running 的数量。
    pub interactive: usize,
    /// 调度运行会话(source_task_id 存在)且进程存活的数量(无论 turn 状态)。
    /// 这是「run_id turn 在跑」的保守超集:绝不强制升级穿透它(评审 E1)。
    pub scheduled: usize,
}
```

在只读访问器区(如 `pub fn session_exists`,约 :766)旁加:

```rust
/// 统计正在运行的 agent 会话,按是否为调度运行分类(tmux 跳过)。
/// auto_update 的 idle-gate 据此决定能否升级(评审 E1:scheduled>0 → 永不强制穿透)。
pub fn running_summary(&self) -> RunningSummary {
    let map = self.sessions.lock().unwrap();
    let mut interactive = 0;
    let mut scheduled = 0;
    for s in map.values() {
        if !matches!(s.session_type, SessionType::Claude | SessionType::Kiro | SessionType::Codex) {
            continue; // tmux 无 turn 概念,不阻塞升级
        }
        let Some(rp) = s.running.as_ref() else { continue };
        if s.source_task_id.is_some() {
            scheduled += 1; // 调度运行,无论 turn 状态都阻塞(保守超集)
        } else if rp.turn_state == TurnState::Running {
            interactive += 1;
        }
    }
    RunningSummary { interactive, scheduled }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test running_summary_tests 2>&1 | tail -20`
Expected: `test result: ok. 2 passed`。

> 若 `EventStore::open("/tmp")` / `SessionStore::open("/tmp")` 在测试里有副作用(建库文件),改用各自的内存/临时构造器(查 `events.rs`/`session_store.rs` 是否有 `::open` 之外的测试构造)。若没有,`/tmp` 可接受(CI 容器可写)。

- [ ] **Step 5: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(auto-update): running_summary accessor (interactive vs scheduled, tmux-skip)"
```

---

## Task 2: 纯函数 `sha256_file`

**Files:**
- Create: `src/auto_update.rs`
- Modify: `src/main.rs`(加 `mod auto_update;`)
- Test: `src/auto_update.rs` 内联

- [ ] **Step 1: 建文件 + 写失败测试**

新建 `src/auto_update.rs`,内容:

```rust
//! 后台自动更新(本机原地升级):监视一个 build 路径,内容变了且无调度运行在跑
//! (交互 turn 可被 max_wait 穿透)时,经 detached systemd-run 原子替换自身+重启+
//! 健康检查回滚。默认关闭(无 --watch-build 即不启用)。见
//! docs/superpowers/specs/2026-06-10-background-auto-update-design.md。

use std::io::Read;
use std::path::Path;

/// 算文件的 SHA256 十六进制串。读不到 → Err(放弃本轮,不崩)。
fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn sha256_of_known_bytes() {
        let dir = std::env::temp_dir().join(format!("zmx-shatest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f");
        std::fs::File::create(&p).unwrap().write_all(b"abc").unwrap();
        // SHA256("abc") 已知值
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sha256_missing_file_is_err() {
        assert!(sha256_file(Path::new("/nonexistent/zmx/xyz")).is_err());
    }
}
```

在 `src/main.rs` 的 mod 列表里(`mod auth;` 与 `mod aws_sigv4;` 之间,字母序)加一行:

```rust
mod auto_update;
```

- [ ] **Step 2: 运行测试确认失败 → 通过**

Run: `cargo test --lib auto_update 2>&1 | tail -20`
Expected: 因为实现已随文件一起写好,这里应直接 PASS(`2 passed`)。若报 `unused` 警告(`Read`/函数未被外部用)属正常,后续 task 会用到。

> 这一步合并了「写测试」和「最小实现」——`sha256_file` 太小,拆开反而啰嗦。

- [ ] **Step 3: 提交**

```bash
git add src/auto_update.rs src/main.rs
git commit -m "feat(auto-update): sha256_file pure fn + module skeleton"
```

---

## Task 3: 纯函数 `gate_decision`(E1 核心)

**Files:**
- Modify: `src/auto_update.rs`
- Test: 同文件内联

- [ ] **Step 1: 写失败测试**

在 `src/auto_update.rs` 的 `#[cfg(test)] mod tests` 内加:

```rust
    #[test]
    fn gate_all_idle_upgrades() {
        let d = gate_decision(RunningSummary { interactive: 0, scheduled: 0 }, 0, 600);
        assert_eq!(d, GateDecision::Upgrade);
    }

    #[test]
    fn gate_scheduled_never_forced_even_past_max_wait() {
        // 调度运行在跑,即使等了远超 max_wait,也绝不强制(E1)
        let d = gate_decision(RunningSummary { interactive: 0, scheduled: 1 }, 99999, 600);
        assert_eq!(d, GateDecision::BlockedByScheduled);
    }

    #[test]
    fn gate_interactive_waits_then_forces() {
        // 交互 turn 在跑,未到 max_wait → 等
        assert_eq!(
            gate_decision(RunningSummary { interactive: 1, scheduled: 0 }, 100, 600),
            GateDecision::WaitInteractive
        );
        // 到了 max_wait → 强制
        assert_eq!(
            gate_decision(RunningSummary { interactive: 1, scheduled: 0 }, 600, 600),
            GateDecision::Upgrade
        );
    }

    #[test]
    fn gate_scheduled_takes_priority_over_interactive() {
        // 两者都在跑:scheduled 优先,永不强制
        let d = gate_decision(RunningSummary { interactive: 2, scheduled: 1 }, 99999, 600);
        assert_eq!(d, GateDecision::BlockedByScheduled);
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --lib auto_update::tests::gate 2>&1 | tail -20`
Expected: 编译失败,`cannot find ... GateDecision` / `gate_decision`。

- [ ] **Step 3: 实现**

在 `src/auto_update.rs`(`sha256_file` 之后,`#[cfg(test)]` 之前)加。注意需引入 `RunningSummary`:

```rust
use crate::session_manager::RunningSummary;

/// gate 决策结果。纯数据,便于单测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateDecision {
    /// 可升级(全 Idle,或仅交互 turn 且已到 max_wait)。
    Upgrade,
    /// 被调度运行阻塞,max_wait 不适用(E1:绝不强制砍调度运行)。
    BlockedByScheduled,
    /// 被交互 turn 阻塞,但未到 max_wait,继续等。
    WaitInteractive,
}

/// 纯函数:给定运行摘要、已等待秒数、max_wait 秒数,决定能否升级(评审 E1)。
fn gate_decision(summary: RunningSummary, waited_secs: u64, max_wait_secs: u64) -> GateDecision {
    if summary.scheduled > 0 {
        return GateDecision::BlockedByScheduled; // 永不强制穿透
    }
    if summary.interactive == 0 {
        return GateDecision::Upgrade; // 全 Idle
    }
    if waited_secs >= max_wait_secs {
        GateDecision::Upgrade // 交互 turn 等满了,可强制
    } else {
        GateDecision::WaitInteractive
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib auto_update 2>&1 | tail -20`
Expected: 全部 PASS(sha 2 + gate 4 = 6 passed)。

- [ ] **Step 5: 提交**

```bash
git add src/auto_update.rs
git commit -m "feat(auto-update): gate_decision pure fn — scheduled runs never force-preempted (E1)"
```

---

## Task 4: 纯函数 `render_swap_script`(E3 backup 轮转 + E8 内联)

**Files:**
- Modify: `src/auto_update.rs`
- Test: 同文件内联

- [ ] **Step 1: 写失败测试**

在 `#[cfg(test)] mod tests` 内加:

```rust
    #[test]
    fn swap_script_interpolates_and_has_rotation() {
        let cfg = AutoUpdateConfig {
            watch_path: "/home/ubuntu/rel/zeromux".into(),
            installed_path: "/usr/local/bin/zeromux".into(),
            service_name: "zeromux".into(),
            health_url: "http://127.0.0.1:8090/".into(),
            max_wait_secs: 600,
            poll_secs: 30,
        };
        let s = render_swap_script(&cfg);
        assert!(s.contains("SERVICE=\"zeromux\""));
        assert!(s.contains("INSTALLED=\"/usr/local/bin/zeromux\""));
        assert!(s.contains("HEALTH=\"http://127.0.0.1:8090/\""));
        assert!(s.contains("BUILT=\"/home/ubuntu/rel/zeromux\""));
        // E3: backup 轮转(保留最近 3 个)
        assert!(s.contains("tail -n +4"), "must keep only newest 3 backups");
        // rollback 路径存在
        assert!(s.contains("cp \"$backup\" \"$INSTALLED\""));
        // health-check 重试循环
        assert!(s.contains("seq 1 10"));
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test --lib auto_update::tests::swap 2>&1 | tail -20`
Expected: 编译失败,`cannot find ... AutoUpdateConfig` / `render_swap_script`。

- [ ] **Step 3: 实现 config + 渲染函数**

在 `src/auto_update.rs`(`use` 之后,函数区顶部)加:

```rust
use std::path::PathBuf;

/// 自动更新配置。字段来自受信启动 flag(运维提供,非用户输入),
/// 故可安全插值进 swap 脚本(评审 E8 插值安全说明)。
#[derive(Debug, Clone)]
pub struct AutoUpdateConfig {
    pub watch_path: PathBuf,     // --watch-build
    pub installed_path: PathBuf, // /usr/local/bin/zeromux(或 /proc/self/exe 解析)
    pub service_name: String,    // "zeromux"
    pub health_url: String,      // http://127.0.0.1:<port>/
    pub max_wait_secs: u64,      // --auto-update-max-wait
    pub poll_secs: u64,          // 固定 30
}
```

在 `gate_decision` 之后加(注意 `{` `}` 在 Rust raw-string 里无需转义,但脚本里的 shell `${...}` 要小心:用普通字符串拼接,把 shell 字面量原样写):

```rust
/// 渲染内嵌 swap 脚本(评审 E3 backup 轮转 + 复刻 deploy.sh do_swap)。
/// 经 `bash -c` 内联传入,不落临时文件(评审 E8)。
fn render_swap_script(cfg: &AutoUpdateConfig) -> String {
    format!(
        r#"set -euo pipefail
SERVICE="{service}"
INSTALLED="{installed}"
HEALTH="{health}"
BUILT="{built}"
backup="${{INSTALLED}}.bak-$(date +%Y%m%d-%H%M%S)"
cp "$INSTALLED" "$backup"
ls -1t "${{INSTALLED}}".bak-* 2>/dev/null | tail -n +4 | xargs -r rm -f
systemctl stop "$SERVICE"
cp "$BUILT" "$INSTALLED"
systemctl start "$SERVICE"
for _ in $(seq 1 10); do
  code="$(curl -s -o /dev/null -w '%{{http_code}}' "$HEALTH" || true)"
  [ "$code" = "200" ] && exit 0
  sleep 1
done
systemctl stop "$SERVICE"
cp "$backup" "$INSTALLED"
systemctl start "$SERVICE"
exit 1
"#,
        service = cfg.service_name,
        installed = cfg.installed_path.display(),
        health = cfg.health_url,
        built = cfg.watch_path.display(),
    )
}
```

> 注意 `format!` raw string 里:shell 的 `${INSTALLED}` 写成 `${{INSTALLED}}`,`%{http_code}` 写成 `%{{http_code}}`(转义花括号);`$backup`/`$SERVICE`/`$(...)` 无花括号,原样保留。

- [ ] **Step 4: 运行确认通过**

Run: `cargo test --lib auto_update 2>&1 | tail -20`
Expected: 全部 PASS(sha 2 + gate 4 + swap 1 = 7 passed)。

- [ ] **Step 5: 提交**

```bash
git add src/auto_update.rs
git commit -m "feat(auto-update): render_swap_script — backup rotation (E3), inlined for bash -c (E8)"
```

---

## Task 5: watcher 任务 `spawn_auto_updater`(副作用壳)

**Files:**
- Modify: `src/auto_update.rs`
- 无新单测(纯副作用编排;逻辑已在 Task 2–4 单测覆盖)。验证靠 `cargo build` + 后续手动端到端。

- [ ] **Step 1: 写 watcher 任务**

在 `src/auto_update.rs` 顶部补 `use`:

```rust
use std::sync::Weak;
use std::time::Instant;
use crate::session_manager::SessionManager;
```

在文件函数区(`render_swap_script` 之后)加:

```rust
/// 启动后台 watcher。仅当 --watch-build 提供时由 main 调用。
pub fn spawn_auto_updater(cfg: AutoUpdateConfig, mgr: Weak<SessionManager>) {
    tokio::spawn(async move {
        // 自身 baseline:读 /proc/self/exe 指向的真实文件(即使 installed 被替换,
        // 仍指向正在执行的 inode)。算一次即可。
        let self_sha = match sha256_file(std::path::Path::new("/proc/self/exe")) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("auto-update: cannot hash /proc/self/exe: {e}; disabling");
                return;
            }
        };
        tracing::info!(
            "auto-update enabled, watching {}, self-sha={}",
            cfg.watch_path.display(),
            &self_sha[..8.min(self_sha.len())]
        );

        let mut tick = tokio::time::interval(std::time::Duration::from_secs(cfg.poll_secs));
        // sha 稳定门(E5):上一轮算出的 watch sha;连续两轮相同才认稳定。
        let mut last_seen_sha: Option<String> = None;
        // 进入「待升级」的时刻(单调钟);None = 当前不在待升级。
        let mut pending_since: Option<Instant> = None;
        // 上一轮 stat 的 (mtime, size),用于跳过未变文件。
        let mut last_stat: Option<(std::time::SystemTime, u64)> = None;
        // 升级进行中标志(并发保护)。
        let mut upgrading = false;

        loop {
            tick.tick().await;
            if upgrading { continue; }

            // 1. stat:未变则跳过哈希
            let meta = match std::fs::metadata(&cfg.watch_path) {
                Ok(m) => m,
                Err(_) => { tracing::debug!("auto-update: watch_path stat failed, skip"); continue; }
            };
            let stat = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len());
            if last_stat == Some(stat) {
                continue; // 文件未变
            }
            last_stat = Some(stat);

            // 2. 算 sha
            let sha = match sha256_file(&cfg.watch_path) {
                Ok(s) => s,
                Err(_) => { continue; }
            };

            // 3. sha 稳定门(E5):连续两轮相同才算写完
            if last_seen_sha.as_deref() != Some(sha.as_str()) {
                tracing::info!("auto-update: build sha changed, waiting for stable (anti half-write)");
                last_seen_sha = Some(sha);
                continue;
            }

            // 4/5. 与 self 比
            if sha == self_sha {
                if pending_since.is_some() {
                    tracing::info!("auto-update: build sha == self, clearing pending");
                }
                pending_since = None;
                continue;
            }
            // 进入/保持 pending
            if pending_since.is_none() {
                pending_since = Some(Instant::now());
                tracing::info!("auto-update: new build sha={} (self={}), entering pending",
                    &sha[..8.min(sha.len())], &self_sha[..8.min(self_sha.len())]);
            }

            // 6. gate
            let Some(m) = mgr.upgrade() else {
                tracing::warn!("auto-update: SessionManager gone, disabling");
                return;
            };
            let summary = m.running_summary();
            let waited = pending_since.map(|t| t.elapsed().as_secs()).unwrap_or(0);
            match gate_decision(summary, waited, cfg.max_wait_secs) {
                GateDecision::BlockedByScheduled => {
                    tracing::info!("auto-update: pending blocked by scheduled run(s), max_wait NOT applied");
                    continue;
                }
                GateDecision::WaitInteractive => {
                    tracing::info!("auto-update: pending, interactive={} scheduled={}, waiting",
                        summary.interactive, summary.scheduled);
                    continue;
                }
                GateDecision::Upgrade => {
                    upgrading = true;
                    // E6: stop 前先冒烟新 binary
                    let smoke = std::process::Command::new(&cfg.watch_path)
                        .arg("--help")
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                    if !matches!(smoke, Ok(st) if st.success()) {
                        tracing::warn!("auto-update: new build failed --help smoke, skipping swap (no service disruption)");
                        upgrading = false;
                        // 不清 pending:下一轮若 sha 仍稳定且 != self 会重试;
                        // 但 last_seen_sha 已等于该坏 sha,故需强制下一轮再比一次。
                        // 简化:清 pending 让其重新走稳定门(冒烟失败的 build 通常不会"变好",
                        // 但若运维替换成好 build,stat 会变、重新触发)。
                        pending_since = None;
                        continue;
                    }
                    tracing::info!("auto-update: upgradeable, launching swap via systemd-run");
                    let script = render_swap_script(&cfg);
                    launch_swap(&script).await;
                    // 到这里通常本进程已被 systemctl stop;若 systemd-run 返回了(swap 失败
                    // 但服务被 rollback 拉起),解除标志,下一轮重试。
                    upgrading = false;
                }
            }
        }
    });
}

/// 经 detached systemd-run 跑 swap 脚本(cgroup 逃逸,评审 A/E8)。
async fn launch_swap(script: &str) {
    let unit = format!("zeromux-selfupdate-{}", std::process::id());
    let res = tokio::process::Command::new("sudo")
        .args(["systemd-run", "--wait", "--pipe", "--collect", "--quiet"])
        .arg(format!("--unit={unit}"))
        .args(["/bin/bash", "-c", script])
        .status()
        .await;
    match res {
        Ok(st) => tracing::info!("auto-update: swap systemd-run exited: {st}"),
        Err(e) => tracing::warn!("auto-update: swap systemd-run failed to launch: {e}"),
    }
}
```

> **E6 冒烟失败后的 pending 处理**:实现里选择「冒烟失败 → 清 pending」。理由:坏 build 不会自己变好;只有运维替换文件(stat 变化)才会重新触发整条链。这避免了「每 30s 重复冒烟同一个坏文件刷日志」。代价:若同一坏文件恰好 mtime 不变,需运维动一下。可接受。

- [ ] **Step 2: 编译确认无错**

Run: `cargo build 2>&1 | tail -20`
Expected: 编译通过(可能有 `spawn_auto_updater` / `AutoUpdateConfig` 未被调用的 `dead_code` 警告 —— Task 6 接线后消失)。

- [ ] **Step 3: 提交**

```bash
git add src/auto_update.rs
git commit -m "feat(auto-update): watcher task — sha-stability gate (E5), smoke (E6), detached systemd-run swap"
```

---

## Task 6: CLI flag + main 接线

**Files:**
- Modify: `src/main.rs`（`Args` struct 加 2 个 flag;serve 前条件 spawn)

- [ ] **Step 1: 加 CLI flag**

在 `src/main.rs` 的 `Args` struct 里(`external_url` 字段之后,约 :100)加:

```rust
    /// 监视的 build 产物路径;给定则启用后台自动更新(本机原地升级)。
    /// ⚠️ 监视裸 target/release/zeromux 时,任何 cargo build --release 都会让
    /// live server 在空闲时静默换上去(build=deploy footgun,见 spec)。
    #[arg(long)]
    watch_build: Option<String>,

    /// 自动更新:进入待升级后,等交互会话全空闲的硬上限(秒)。
    /// 调度运行不受此限(永不强制穿透,E1)。默认 600。
    #[arg(long, default_value = "600")]
    auto_update_max_wait: u64,
```

- [ ] **Step 2: serve 前条件 spawn watcher**

在 `src/main.rs` 里,`let app = web::build_router(state.clone());` **之前**(events-prune 的 `tokio::spawn` 块之后,约 :296)加:

```rust
    // 后台自动更新:仅当 --watch-build 提供时启用(默认关闭)。
    if let Some(watch) = args.watch_build.clone() {
        // 自身实际安装路径:优先 /proc/self/exe 解析,回退 /usr/local/bin/zeromux。
        let installed = std::fs::read_link("/proc/self/exe")
            .unwrap_or_else(|_| std::path::PathBuf::from("/usr/local/bin/zeromux"));
        let cfg = auto_update::AutoUpdateConfig {
            watch_path: std::path::PathBuf::from(watch),
            installed_path: installed,
            service_name: "zeromux".to_string(),
            health_url: format!("http://127.0.0.1:{}/", args.port),
            max_wait_secs: args.auto_update_max_wait,
            poll_secs: 30,
        };
        auto_update::spawn_auto_updater(cfg, Arc::downgrade(&state.sessions));
    }
```

> `state.sessions` 是 `Arc<SessionManager>`(见 `AppState`),`Arc::downgrade` 得到 `Weak<SessionManager>`,与 `spawn_auto_updater` 签名一致。`args.watch_build` 在上面 `args.external_url` 等已被 move 的字段之后使用 —— 确认 `args` 仍可用:`args.port` 在 `addr` 构造处仍被读(`:299`),故 `args` 未被整体 move,`args.watch_build.clone()` 安全。

- [ ] **Step 3: 编译 + 全量测试**

Run: `cargo build 2>&1 | tail -20 && cargo test 2>&1 | tail -25`
Expected: 编译通过,无 `dead_code` 警告(watcher 已被调用);所有测试 PASS(原有 + 本次新增 7+2)。

- [ ] **Step 4: 验证 flag 缺省关闭**

Run: `cargo run -- --help 2>&1 | grep -A1 watch-build`
Expected: 显示 `--watch-build <WATCH_BUILD>` 帮助行,默认无值。
再 Run: `cargo run -- --port 18080 --password x 2>&1 | head -5`(不带 --watch-build)
Expected: 启动日志里**无** `auto-update enabled`(功能关闭)。`Ctrl-C` 退出。

- [ ] **Step 5: 提交**

```bash
git add src/main.rs
git commit -m "feat(auto-update): --watch-build / --auto-update-max-wait flags + conditional spawn (default off)"
```

---

## Task 7: 端到端手动验证清单(部署后,在 live 或本地 systemd 环境)

> 无代码改动。本 task 是一份 checklist,实现完成、部署带 `--watch-build` 后人工跑一遍。记录结果。

- [ ] **冒烟门(E6):** 把一个 `echo hi; exit 1` 的假"binary"放到 watch_path → 观察日志 `failed --help smoke, skipping swap`,服务**无重启**。
- [ ] **sha 稳定门(E5):** `cp` 一个大文件到 watch_path,观察第一轮 `waiting for stable`,下一轮才 `entering pending`。
- [ ] **全 Idle 升级:** 无任何 agent 会话 → 放一个真新 build 到 watch_path → 等到 `launching swap` → 服务重启 → `curl 127.0.0.1:<port>/` 返回 200 → `/proc/self/exe` 新 sha 生效。
- [ ] **交互 turn 阻塞 + max_wait 强制:** 起一个 claude 会话发个长 prompt(Running)→ 放新 build → 观察 `pending, interactive=1, waiting` → 等满 `--auto-update-max-wait`(测试时设小,如 60)→ 观察强制 `launching swap`。
- [ ] **调度运行永不被穿透(E1):** 建一个会跑 >max_wait 的调度任务,触发它(source_task 会话存活)→ 放新 build → 观察持续 `blocked by scheduled run(s), max_wait NOT applied`,**即使**远超 max_wait 也不升级;调度运行结束(或 30min 看门狗了断)后才升级。
- [ ] **回滚(health 失败):** 放一个能过 `--help` 但起来后不监听端口的 binary → 观察 swap → health-check 10 次失败 → rollback → 服务跑回旧 binary,`curl` 200。
- [ ] **backup 轮转(E3):** 连续触发 4 次升级 → `ls /usr/local/bin/zeromux.bak-*` 只剩最近 3 个。

记录到 spec 或 memory:哪些通过、哪些有偏差。

---

## Self-Review(对照 spec)

- **spec「检测循环」**:Task 5 watcher 实现 stat→sha→稳定门→self 比→pending。✅
- **spec「Idle gate E1」**:Task 1 `running_summary` + Task 3 `gate_decision`,scheduled 永不强制。✅(用 `source_task_id` 替 fanout-local `active_run_id`,已在「实现前必读」记录修正理由)
- **spec「swap 方案 A + E8 内联 + E3 轮转 + E6 冒烟」**:Task 4 `render_swap_script` + Task 5 `launch_swap`/冒烟。✅
- **spec「CLI flag 默认关闭」**:Task 6 + Task 6 Step 4 验证。✅
- **spec「可观测性」**:watcher 各决策点 `tracing::info!`,日志串与 spec 的可观测性清单一致。✅
- **spec「前端无改动 / 无 DB 改动」**:计划无前端、无 session_store/db 改动。✅
- **Placeholder 扫描**:无 TBD/TODO;每个改码步骤含完整代码。✅
- **类型一致性**:`RunningSummary{interactive,scheduled}`、`AutoUpdateConfig{watch_path,installed_path,service_name,health_url,max_wait_secs,poll_secs}`、`GateDecision{Upgrade,BlockedByScheduled,WaitInteractive}` 在 Task 1/3/4/5/6 间引用一致。✅
- **唯一 spec 偏差**:`active_run_id`(fanout-local)→ `source_task_id`(Session 持久字段),保守超集,已显式记录。
