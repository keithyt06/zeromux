# 终端默认 tmux + 手机滚动/历史 + 流程重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终端会话默认跑在一个跨 zeromux 重启存活、可从 VSCode `tmux attach` 的 tmux server 里；手机上能顺畅回看历史；新建/关闭/接续流程重做。

**Architecture:** 独立 system unit `zeromux-tmux.service` 托管默认 socket 的 tmux server；zeromux 通过新模块 `src/tmux.rs`（TmuxCtl，全部带 `-N`、`=name` 精确匹配、3s 超时）驱动它。每个终端会话 = PTY 里跑 `tmux new-session -A -s zmx-<id8>`。滚动走服务端 `copy-mode` 命令，历史走 `capture-pane`，回放改为 `refresh-client` 重绘。

**Tech Stack:** Rust (tokio, axum, portable-pty, rusqlite)、tmux 3.4、React 19 + xterm.js 6 + vitest。

**Spec:** `docs/superpowers/specs/2026-09-26-tmux-default-terminal-design.md`

## Global Constraints

- tmux 会话名固定 `zmx-<uuid 前 8 位>`；所有 target 写成 `=<name>`（会话）或 `=<name>:`（pane），绝不前缀匹配。
- zeromux 发出的**每一条** tmux 命令都带 `-N`；`--tmux-socket <s>` 非空时再加 `-L <s>`。只有 `zeromux-tmux.service` 可以启动 server。
- tmux 命令一律 `tokio::process::Command` + argv 传参（不经 shell）+ 3s 超时；唯一例外是 PTY 里 attach 的那条（由 portable-pty spawn）。
- 冒烟/测试**绝不**触碰默认 socket 与线上 8090：Rust 测试用 `-L zmx-test-<pid>-<n>`，冒烟用 `--data-dir /tmp/zmx-smoke --tmux-socket zmx-smoke --port 18090`。
- `kill-session` 只出现在显式关闭路径（延迟 kill 定时器 / 启动 reconcile），绝不放进 Drop。
- Agent 会话（Claude/Codex/Crew）行为不变。
- 用户可见文案中文；代码/注释英文（与仓库一致）。
- 每个 Task 结束 commit，commit message 末尾加 `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`。
- 在 zeromux 终端里执行时：先 commit/push 再 `./deploy.sh`（deploy 期间本终端会掉线属预期）。

## Review Focus

1. **tmux server 未运行**（unit 挂了/未安装）→ 新建终端应明确报错「tmux 服务未运行」，而不是回退裸 shell 或挂死；已有会话重连显示告警条。→ T3 Step「server down 报错」测试。
2. **会话名含前缀冲突**（`zmx-ab` 与 `zmx-abc` 同时存在）→ kill/capture/has 只作用于精确那一个。→ T2 `exact_match_does_not_prefix` 测试。
3. **关闭后 5s 内服务重启** → 启动 reconcile 必须把到期/未到期的 pending_kill 都执行掉，不留孤儿 tmux。→ T5 `startup_reconcile_kills_pending` 测试。
4. **copy-mode 外发 Cancel / Bottom**（用户没在滚动）→ 不能往 shell 打任何字符。→ T2 `cancel_outside_copy_mode_is_noop` 测试。
5. **External 会话在 VSCode 被 kill 后浏览器重连** → 显示「已结束」覆盖层，不 spawn、不静默建新 shell。→ T4 `external_missing_marks_ended` 测试。

## File Structure

| 文件 | 职责 | Task |
|---|---|---|
| `deploy/zeromux-tmux.service` (新) | tmux server 的 systemd unit | T1 |
| `deploy.sh` | 幂等安装 unit | T1 |
| `src/tmux.rs` (新) | TmuxCtl：命令拼装、执行、解析；tmux.conf 生成 | T1,T2 |
| `src/main.rs` | `--tmux-socket` 参数、TmuxCtl 构造注入 | T1,T3 |
| `src/session_manager.rs` | 会话模型、spawn、re-attach 分流、延迟 kill、回放 | T3–T6 |
| `src/session_store.rs` | 新列 `tmux_origin`、`pending_kill_until`、`cols/rows` | T3,T5 |
| `src/ws_handler.rs` | `notice` / `scroll` / `scroll_watch` 消息、refresh-client | T4,T6,T7,T13 |
| `src/web.rs` | health/history/close-check/restore/adopt API，`host_tmux` | T1,T5,T8,T9 |
| `src/push.rs` | `term_ended` kind | T15 |
| `frontend/src/lib/api.ts` | 新 API 客户端 | T1,T5,T8,T9 |
| `frontend/src/lib/terminalScroll.ts` (新) | 手势→scroll op 纯函数 + 惯性 | T7 |
| `frontend/src/lib/ansi.ts` (新) | SGR→span 纯函数 | T12 |
| `frontend/src/lib/closeSession.ts` (新) | 关闭确认分级纯函数 | T5 |
| `frontend/src/components/TerminalView.tsx` | notice 处理、滚动、浮标、历史入口 | T4,T6,T7,T8,T11 |
| `frontend/src/components/HistoryView.tsx` (新) | 历史抽屉 | T8,T12,T15 |
| `frontend/src/components/TerminalNotices.tsx` (新) | 告警条/覆盖层/重连提示 | T1,T4,T8 |
| `frontend/src/components/Toast.tsx` (新) | 撤销 toast | T5 |
| `frontend/src/components/Sidebar.tsx` | 流程简化、host_tmux 分组、⋯ 菜单 | T9,T10 |
| `frontend/src/components/MobileKeyBar.tsx` | 📜 入口、第二页 | T8,T14 |
| `frontend/src/App.tsx` | 关闭流程、host_tmux 状态 | T5,T9 |
| `frontend/public/sw.js` | `term_ended` 无需特殊处理（验证） | T15 |
| `CLAUDE.md` | 记录 kill-session 例外、tmux unit、部署 | T5 |

---

### Task 1: tmux server unit + tmux.conf 生成 + `--tmux-socket` + health

**Files:**
- Create: `deploy/zeromux-tmux.service`
- Create: `src/tmux.rs`
- Modify: `src/main.rs`（`mod tmux;`、Args、AppState、启动时写 conf）
- Modify: `deploy.sh`（安装 unit）
- Modify: `src/web.rs`（`GET /api/tmux/health`）
- Modify: `frontend/src/lib/api.ts`、Create: `frontend/src/components/TerminalNotices.tsx`
- Test: `src/tmux.rs` 内 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `pub struct TmuxCtl { socket: Option<String> }`，`impl Clone`
  - `TmuxCtl::new(socket: Option<String>) -> Self`
  - `TmuxCtl::base_args(&self) -> Vec<String>` → `["-N"]` 或 `["-L", s, "-N"]`
  - `async fn run(&self, args: &[&str]) -> Result<String, TmuxError>`（stdout，3s 超时）
  - `pub enum TmuxError { ServerDown, NotFound, Timeout, Other(String) }`（`Display`）
  - `async fn health(&self) -> TmuxHealth`，`#[derive(Serialize)] pub struct TmuxHealth { pub server: bool, pub in_unit: bool }`
  - `pub const TMUX_CONF_VERSION: u32 = 1;` `pub fn tmux_conf_text() -> String`；`pub fn write_tmux_conf(data_dir: &Path) -> std::io::Result<PathBuf>`
  - `AppState.tmux: tmux::TmuxCtl`
  - 前端 `getTmuxHealth(): Promise<{server: boolean, in_unit: boolean}>`

- [ ] **Step 1: 写 unit 文件**

`deploy/zeromux-tmux.service`:
```ini
[Unit]
Description=ZeroMux tmux server (terminals survive zeromux restarts)
After=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
Environment=HOME=/home/ubuntu
Environment=LANG=C.UTF-8
WorkingDirectory=/home/ubuntu
# -D: stay in foreground so systemd owns the server process (and its cgroup).
ExecStart=/usr/bin/tmux -D -f /home/ubuntu/.zeromux/tmux.conf
Restart=always
RestartSec=2
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: 写失败测试（conf 文本 + base_args + 超时/ServerDown）**

在新文件 `src/tmux.rs` 末尾：
```rust
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// Isolated tmux server on a private socket. Killed on drop.
    pub(crate) struct TestServer { pub ctl: TmuxCtl, pub socket: String }
    impl TestServer {
        pub(crate) fn start() -> Option<Self> {
            if std::process::Command::new("tmux").arg("-V").output().is_err() { return None; }
            let socket = format!("zmx-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst));
            // Boot the server (tests are the only place allowed to start one without -N).
            let ok = std::process::Command::new("tmux")
                .args(["-L", &socket, "-f", "/dev/null", "new-session", "-d", "-s", "boot"])
                .status().map(|s| s.success()).unwrap_or(false);
            if !ok { return None; }
            let _ = std::process::Command::new("tmux")
                .args(["-L", &socket, "set", "-g", "exit-empty", "off"]).status();
            Some(Self { ctl: TmuxCtl::new(Some(socket.clone())), socket })
        }
    }
    impl Drop for TestServer {
        fn drop(&mut self) {
            let _ = std::process::Command::new("tmux").args(["-L", &self.socket, "kill-server"]).status();
        }
    }

    #[test]
    fn base_args_always_has_no_start_flag() {
        assert_eq!(TmuxCtl::new(None).base_args(), vec!["-N"]);
        assert_eq!(TmuxCtl::new(Some("s".into())).base_args(), vec!["-L", "s", "-N"]);
    }

    #[test]
    fn conf_sources_user_conf_first_and_pins_options() {
        let t = tmux_conf_text();
        let first = t.lines().find(|l| !l.starts_with('#')).unwrap();
        assert_eq!(first, "source-file -q ~/.tmux.conf");
        for opt in ["exit-empty off", "history-limit 50000", "mouse on", "window-size latest", "set-clipboard on"] {
            assert!(t.contains(opt), "missing {opt}");
        }
        assert!(t.contains(&format!("zeromux-tmux-conf v{}", TMUX_CONF_VERSION)));
    }

    #[test]
    fn write_conf_is_idempotent_and_upgrades_old_version() {
        let d = tempfile::tempdir().unwrap();
        let p = write_tmux_conf(d.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), tmux_conf_text());
        std::fs::write(&p, "# zeromux-tmux-conf v0\n").unwrap();
        write_tmux_conf(d.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), tmux_conf_text());
    }

    #[tokio::test]
    async fn run_without_server_is_server_down_not_autostart() {
        let ctl = TmuxCtl::new(Some(format!("zmx-test-none-{}", std::process::id())));
        match ctl.run(&["list-sessions"]).await {
            Err(TmuxError::ServerDown) => {}
            other => panic!("expected ServerDown, got {other:?}"),
        }
        let h = ctl.health().await;
        assert!(!h.server && !h.in_unit);
    }

    #[tokio::test]
    async fn health_up_but_not_in_unit_for_test_server() {
        let Some(srv) = TestServer::start() else { return };
        let h = srv.ctl.health().await;
        assert!(h.server);
        assert!(!h.in_unit);
    }
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cargo test --bin zeromux tmux::tests 2>&1 | tail -5`
Expected: 编译失败（`TmuxCtl` 未定义 / `mod tmux` 未声明）。

- [ ] **Step 4: 实现 `src/tmux.rs` 主体**

文件开头：
```rust
//! TmuxCtl — the ONLY place zeromux builds tmux command lines.
//!
//! Invariants (see docs/superpowers/specs/2026-09-26-tmux-default-terminal-design.md):
//! - every command carries `-N` so zeromux can never start a tmux server inside
//!   its own cgroup (it would die on `systemctl stop zeromux`); only
//!   zeromux-tmux.service starts the server.
//! - targets are always `=name` exact matches (tmux otherwise prefix-matches).
//! - argv only, never a shell; 3s timeout per command.

use std::path::{Path, PathBuf};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);
pub const TMUX_CONF_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq)]
pub enum TmuxError { ServerDown, NotFound, Timeout, Other(String) }

impl std::fmt::Display for TmuxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TmuxError::ServerDown => write!(f, "tmux 服务未运行（zeromux-tmux.service）"),
            TmuxError::NotFound => write!(f, "tmux 会话不存在"),
            TmuxError::Timeout => write!(f, "tmux 命令超时"),
            TmuxError::Other(s) => write!(f, "tmux: {s}"),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TmuxHealth { pub server: bool, pub in_unit: bool }

#[derive(Debug, Clone)]
pub struct TmuxCtl { socket: Option<String> }

impl TmuxCtl {
    pub fn new(socket: Option<String>) -> Self {
        Self { socket: socket.filter(|s| !s.is_empty()) }
    }

    pub fn base_args(&self) -> Vec<String> {
        match &self.socket {
            Some(s) => vec!["-L".into(), s.clone(), "-N".into()],
            None => vec!["-N".into()],
        }
    }

    pub async fn run(&self, args: &[&str]) -> Result<String, TmuxError> {
        let mut cmd = tokio::process::Command::new("tmux");
        cmd.args(self.base_args()).args(args).env_remove("TMUX").kill_on_drop(true);
        let out = tokio::time::timeout(TIMEOUT, cmd.output())
            .await
            .map_err(|_| TmuxError::Timeout)?
            .map_err(|e| TmuxError::Other(e.to_string()))?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        Err(classify_stderr(&String::from_utf8_lossy(&out.stderr)))
    }

    pub async fn health(&self) -> TmuxHealth {
        let pid = match self.run(&["display-message", "-p", "#{pid}"]).await {
            Ok(s) => s.trim().to_string(),
            Err(_) => return TmuxHealth { server: false, in_unit: false },
        };
        let cg = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap_or_default();
        TmuxHealth { server: true, in_unit: cg.contains("zeromux-tmux.service") }
    }
}

fn classify_stderr(err: &str) -> TmuxError {
    if err.contains("error connecting to") || err.contains("no server running") {
        TmuxError::ServerDown
    } else if err.contains("can't find session") || err.contains("can't find pane")
        || err.contains("can't find window") || err.contains("session not found") {
        TmuxError::NotFound
    } else {
        TmuxError::Other(err.trim().to_string())
    }
}

pub fn tmux_conf_text() -> String {
    format!(
"# zeromux-tmux-conf v{TMUX_CONF_VERSION} — generated by zeromux; edits are overwritten on upgrade.
source-file -q ~/.tmux.conf
set -g exit-empty off
set -g history-limit 50000
set -g mouse on
set -sg escape-time 10
set -g default-terminal tmux-256color
set -as terminal-features ',xterm-256color:RGB'
set -g set-clipboard on
set -g focus-events on
set -g window-size latest
set -g status-left ''
set -g status-right ''
set -g status-style 'bg=default'
")
}

/// Write `<data_dir>/tmux.conf` if missing or from an older version.
pub fn write_tmux_conf(data_dir: &Path) -> std::io::Result<PathBuf> {
    let p = data_dir.join("tmux.conf");
    let want = tmux_conf_text();
    if std::fs::read_to_string(&p).ok().as_deref() != Some(want.as_str()) {
        std::fs::create_dir_all(data_dir)?;
        std::fs::write(&p, want)?;
    }
    Ok(p)
}
```

- [ ] **Step 5: 接入 main.rs**

`src/main.rs`：在 `mod session_store;` 之后加 `mod tmux;`。Args 里 `data_dir` 之后加：
```rust
    /// tmux socket name (`tmux -L <name>`). Empty = default socket, which is what
    /// lets you `tmux attach` from VSCode. Smoke tests MUST set this.
    #[arg(long, default_value = "")]
    tmux_socket: String,
```
AppState 加 `pub tmux: tmux::TmuxCtl,`；构造 AppState 处加 `tmux: tmux::TmuxCtl::new(Some(args.tmux_socket.clone())),`（放在 `args.shell` 被 move 之前或用 clone）。在 `data_dir_str` 计算后加：
```rust
    if let Err(e) = tmux::write_tmux_conf(std::path::Path::new(&data_dir_str)) {
        tracing::warn!("write tmux.conf failed: {}", e);
    }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cargo test --bin zeromux tmux::tests 2>&1 | tail -5`
Expected: `test result: ok. 5 passed`

- [ ] **Step 7: health API**

`src/web.rs` 路由表（`/api/tmux/sessions` 旁）加 `.route("/api/tmux/health", get(tmux_health))`，handler：
```rust
async fn tmux_health(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Result<Json<crate::tmux::TmuxHealth>, StatusCode> {
    if !user.is_admin() { return Err(StatusCode::FORBIDDEN); }
    Ok(Json(state.tmux.health().await))
}
```

- [ ] **Step 8: 前端 API + 告警条组件**

`frontend/src/lib/api.ts` 追加：
```ts
export interface TmuxHealth { server: boolean; in_unit: boolean }
export async function getTmuxHealth(): Promise<TmuxHealth | null> {
  const res = await api('/api/tmux/health')
  if (!res.ok) return null
  return res.json()
}
```
新建 `frontend/src/components/TerminalNotices.tsx`（后续 Task 继续往里加导出）：
```tsx
import type { TmuxHealth } from '../lib/api'

/** Warning bar shown above a tmux terminal when the tmux server is unhealthy. */
export function TmuxHealthBar({ health }: { health: TmuxHealth | null }) {
  if (!health || (health.server && health.in_unit)) return null
  const msg = !health.server
    ? 'tmux 服务未运行，终端无法持久化。修复：sudo systemctl restart zeromux-tmux'
    : 'tmux server 不在 zeromux-tmux.service 中，部署时可能被连带杀掉。修复：tmux kill-server 后 sudo systemctl restart zeromux-tmux'
  return (
    <div role="alert" className="px-3 py-1.5 text-xs bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)] border-b border-[var(--border)]">
      {msg}
    </div>
  )
}
```
`frontend/src/components/__tests__/TerminalNotices.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { TmuxHealthBar } from '../TerminalNotices'

describe('TmuxHealthBar', () => {
  it('healthy → nothing', () => {
    const { container } = render(<TmuxHealthBar health={{ server: true, in_unit: true }} />)
    expect(container.firstChild).toBeNull()
  })
  it('server down → restart hint', () => {
    render(<TmuxHealthBar health={{ server: false, in_unit: false }} />)
    expect(screen.getByRole('alert').textContent).toContain('systemctl restart zeromux-tmux')
  })
  it('wrong cgroup → kill-server hint', () => {
    render(<TmuxHealthBar health={{ server: true, in_unit: false }} />)
    expect(screen.getByRole('alert').textContent).toContain('kill-server')
  })
})
```
在 `TerminalView.tsx` 里：state `const [health, setHealth] = useState<TmuxHealth | null>(null)`，在已有 10s status 轮询的 `fetchStatus` 里并行 `getTmuxHealth().then(h => { if (!cancelled) setHealth(h) }).catch(() => {})`；JSX 最外层 `<div className="flex flex-col h-full">` 第一个子元素放 `<TmuxHealthBar health={health} />`。

Run: `cd frontend && npx vitest run src/components/__tests__/TerminalNotices.test.tsx`
Expected: 3 passed

- [ ] **Step 9: deploy.sh 幂等安装 unit**

在 `do_swap()` 定义**之前**加函数，并在 `[ -f "$BUILT" ] || ...` 之前调用 `ensure_tmux_unit`（以普通用户身份运行，只用 sudo 做安装；不 stop 已运行的 tmux）：
```bash
# ── tmux server unit (terminals survive zeromux restarts) ────────────────────
# Idempotent: install/refresh the unit file and make sure it is enabled+running.
# NEVER restart it here — that would kill every terminal.
ensure_tmux_unit() {
  local src=deploy/zeromux-tmux.service dst=/etc/systemd/system/zeromux-tmux.service
  if ! sudo cmp -s "$src" "$dst" 2>/dev/null; then
    echo ">> Installing $dst"
    sudo cp "$src" "$dst"
    sudo systemctl daemon-reload
  fi
  sudo systemctl enable zeromux-tmux.service >/dev/null 2>&1 || true
  if ! systemctl is-active --quiet zeromux-tmux.service; then
    # tmux.conf must exist before the server starts; zeromux writes it at boot,
    # but on first install zeromux may not have run the new binary yet.
    [ -f "$HOME/.zeromux/tmux.conf" ] || "$BUILT" --print-tmux-conf > "$HOME/.zeromux/tmux.conf"
    echo ">> Starting zeromux-tmux.service"
    sudo systemctl start zeromux-tmux.service
  fi
}
```
为此在 main.rs Args 加 `#[arg(long)] print_tmux_conf: bool,`，`Args::parse()` 之后立刻：
```rust
    if args.print_tmux_conf { print!("{}", tmux::tmux_conf_text()); return; }
```
（若 main 返回 `Result`，改为 `return Ok(())`。）并在 `/etc/systemd/system/zeromux.service` 的 drop-in 由 deploy.sh 追加依赖（幂等）：
```bash
  local dropin=/etc/systemd/system/zeromux.service.d/10-tmux.conf
  if [ ! -f "$dropin" ]; then
    sudo mkdir -p "$(dirname "$dropin")"
    printf '[Unit]\nWants=zeromux-tmux.service\nAfter=zeromux-tmux.service\n' | sudo tee "$dropin" >/dev/null
    sudo systemctl daemon-reload
  fi
```
（放进 `ensure_tmux_unit` 末尾。）

Run: `bash -n deploy.sh && echo syntax-ok`
Expected: `syntax-ok`

- [ ] **Step 10: 全量测试 + commit**

Run: `cargo test 2>&1 | grep "test result" ; cd frontend && npm test 2>&1 | tail -3`
Expected: 全部 ok。
```bash
git add deploy/zeromux-tmux.service deploy.sh src/tmux.rs src/main.rs src/web.rs frontend/src/lib/api.ts frontend/src/components/TerminalNotices.tsx frontend/src/components/__tests__/TerminalNotices.test.tsx frontend/src/components/TerminalView.tsx
git commit -m "feat(tmux): zeromux-tmux.service + TmuxCtl base + tmux.conf + health bar"
```

---

### Task 2: TmuxCtl 会话操作 + `list_tmux_sessions` 迁移

**Files:**
- Modify: `src/tmux.rs`
- Modify: `src/web.rs:731-778`（`list_tmux_sessions`）
- Test: `src/tmux.rs` tests

**Interfaces:**
- Consumes: T1 `TmuxCtl::run`, `TmuxError`, `tests::TestServer`
- Produces:
  - `pub fn attach_argv(&self, name: &str, dir: Option<&str>) -> Vec<String>` → `base_args + ["new-session","-A","-s",name] (+ ["-c",dir])`
  - `async fn has(&self, name: &str) -> Result<bool, TmuxError>`（ServerDown 仍返回 Err）
  - `async fn kill(&self, name: &str) -> Result<(), TmuxError>`（NotFound 视为 Ok）
  - `async fn capture(&self, name: &str, max_lines: u32, max_bytes: usize) -> Result<Captured, TmuxError>`，`#[derive(Serialize)] pub struct Captured { pub text: String, pub truncated: bool }`
  - `async fn list(&self) -> Result<Vec<HostTmux>, TmuxError>`，`#[derive(Serialize, Clone)] pub struct HostTmux { pub name: String, pub windows: u32, pub attached: u32, pub created: i64, pub path: String }`
  - `async fn info(&self, name: &str) -> Result<PaneInfo, TmuxError>`，`#[derive(Serialize, Clone, Debug)] pub struct PaneInfo { pub attached: u32, pub in_mode: bool, pub history_size: u64, pub current_command: String }`
  - `pub enum ScrollOp { Up(u32), Down(u32), Top, Bottom, Cancel }`，`impl ScrollOp { pub fn parse(op: &str, n: u32) -> Option<Self> }`（`"up"|"down"|"top"|"bottom"|"cancel"`，n 钳到 1..=200）
  - `async fn scroll(&self, name: &str, op: ScrollOp) -> Result<PaneInfo, TmuxError>`（返回操作后的 info）
  - `async fn refresh_client_for_pid(&self, pid: u32) -> Result<(), TmuxError>`
  - `pub fn tmux_name_for(id: &str) -> String` → `format!("zmx-{}", &id[..8.min(id.len())])`

- [ ] **Step 1: 写失败测试**

追加到 `src/tmux.rs` 的 `tests` 模块：
```rust
    async fn mk(srv: &TestServer, name: &str) {
        srv.ctl.run(&["new-session", "-d", "-s", name, "-c", "/tmp"]).await.unwrap();
    }

    #[test]
    fn name_and_attach_argv() {
        assert_eq!(tmux_name_for("3f2a9c1e-aaaa-bbbb"), "zmx-3f2a9c1e");
        let a = TmuxCtl::new(Some("s".into())).attach_argv("zmx-1", Some("/w"));
        assert_eq!(a, vec!["-L", "s", "-N", "new-session", "-A", "-s", "zmx-1", "-c", "/w"]);
        let b = TmuxCtl::new(None).attach_argv("zmx-1", None);
        assert_eq!(b, vec!["-N", "new-session", "-A", "-s", "zmx-1"]);
    }

    #[test]
    fn scroll_op_parse_clamps() {
        assert!(matches!(ScrollOp::parse("up", 0), Some(ScrollOp::Up(1))));
        assert!(matches!(ScrollOp::parse("down", 9999), Some(ScrollOp::Down(200))));
        assert!(matches!(ScrollOp::parse("top", 0), Some(ScrollOp::Top)));
        assert!(ScrollOp::parse("rm -rf", 1).is_none());
    }

    #[tokio::test]
    async fn exact_match_does_not_prefix() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-abc").await;
        assert!(!srv.ctl.has("zmx-ab").await.unwrap());
        assert!(srv.ctl.has("zmx-abc").await.unwrap());
        mk(&srv, "zmx-ab").await;
        srv.ctl.kill("zmx-ab").await.unwrap();
        assert!(srv.ctl.has("zmx-abc").await.unwrap(), "kill must not hit the longer name");
        srv.ctl.kill("zmx-ab").await.unwrap(); // already gone → Ok
    }

    #[tokio::test]
    async fn list_and_info() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-l1").await;
        let l = srv.ctl.list().await.unwrap();
        let e = l.iter().find(|h| h.name == "zmx-l1").unwrap();
        assert_eq!(e.windows, 1);
        assert_eq!(e.attached, 0);
        assert_eq!(e.path, "/tmp");
        let i = srv.ctl.info("zmx-l1").await.unwrap();
        assert!(!i.in_mode);
        assert!(!i.current_command.is_empty());
    }

    #[tokio::test]
    async fn capture_returns_history_and_truncates_head() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-c1").await;
        srv.ctl.run(&["send-keys", "-t", "=zmx-c1:", "seq 1 500", "Enter"]).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let full = srv.ctl.capture("zmx-c1", 50_000, 5 * 1024 * 1024).await.unwrap();
        assert!(!full.truncated);
        assert!(full.text.lines().any(|l| l == "1"));
        assert!(full.text.lines().any(|l| l == "500"));
        let cut = srv.ctl.capture("zmx-c1", 50_000, 200).await.unwrap();
        assert!(cut.truncated);
        assert!(cut.text.len() <= 200);
        assert!(!cut.text.lines().any(|l| l == "1"), "head is dropped, tail kept");
    }

    #[tokio::test]
    async fn scroll_enters_and_leaves_copy_mode() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-s1").await;
        srv.ctl.run(&["send-keys", "-t", "=zmx-s1:", "seq 1 300", "Enter"]).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let i = srv.ctl.scroll("zmx-s1", ScrollOp::Up(5)).await.unwrap();
        assert!(i.in_mode);
        let i = srv.ctl.scroll("zmx-s1", ScrollOp::Top).await.unwrap();
        assert!(i.in_mode);
        let i = srv.ctl.scroll("zmx-s1", ScrollOp::Bottom).await.unwrap();
        assert!(!i.in_mode);
    }

    #[tokio::test]
    async fn cancel_outside_copy_mode_is_noop() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-q1").await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let before = srv.ctl.capture("zmx-q1", 100, 1 << 20).await.unwrap().text;
        for op in [ScrollOp::Cancel, ScrollOp::Bottom, ScrollOp::Down(3)] {
            let i = srv.ctl.scroll("zmx-q1", op).await.unwrap();
            assert!(!i.in_mode);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let after = srv.ctl.capture("zmx-q1", 100, 1 << 20).await.unwrap().text;
        assert_eq!(before.trim_end(), after.trim_end(), "no keystrokes may reach the shell");
    }

    #[tokio::test]
    async fn refresh_unknown_pid_is_not_found() {
        let Some(srv) = TestServer::start() else { return };
        assert_eq!(srv.ctl.refresh_client_for_pid(1).await, Err(TmuxError::NotFound));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux tmux::tests 2>&1 | tail -5`
Expected: 编译失败（`has`/`ScrollOp` 等未定义）。

- [ ] **Step 3: 实现**

在 `impl TmuxCtl` 内追加：
```rust
    pub fn attach_argv(&self, name: &str, dir: Option<&str>) -> Vec<String> {
        let mut v = self.base_args();
        v.extend(["new-session", "-A", "-s", name].map(String::from));
        if let Some(d) = dir { v.push("-c".into()); v.push(d.into()); }
        v
    }

    pub async fn has(&self, name: &str) -> Result<bool, TmuxError> {
        match self.run(&["has-session", "-t", &format!("={name}")]).await {
            Ok(_) => Ok(true),
            Err(TmuxError::NotFound) => Ok(false),
            Err(e) => Err(e),
        }
    }

    pub async fn kill(&self, name: &str) -> Result<(), TmuxError> {
        match self.run(&["kill-session", "-t", &format!("={name}")]).await {
            Ok(_) | Err(TmuxError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub async fn capture(&self, name: &str, max_lines: u32, max_bytes: usize) -> Result<Captured, TmuxError> {
        let start = format!("-{max_lines}");
        let text = self.run(&["capture-pane", "-p", "-J", "-S", &start, "-E", "-", "-t", &format!("={name}:")]).await?;
        Ok(truncate_head(text, max_bytes))
    }

    pub async fn list(&self) -> Result<Vec<HostTmux>, TmuxError> {
        let out = match self.run(&["list-sessions", "-F",
            "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_path}"]).await {
            Ok(s) => s,
            Err(TmuxError::NotFound) => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        Ok(out.lines().filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.len() >= 5).then(|| HostTmux {
                name: f[0].into(),
                windows: f[1].parse().unwrap_or(0),
                attached: f[2].parse().unwrap_or(0),
                created: f[3].parse().unwrap_or(0),
                path: f[4].into(),
            })
        }).collect())
    }

    pub async fn info(&self, name: &str) -> Result<PaneInfo, TmuxError> {
        let s = self.run(&["display-message", "-p", "-t", &format!("={name}:"),
            "#{session_attached}\t#{pane_in_mode}\t#{history_size}\t#{pane_current_command}"]).await?;
        let f: Vec<&str> = s.trim_end_matches('\n').split('\t').collect();
        if f.len() < 4 { return Err(TmuxError::Other(format!("bad info: {s}"))); }
        Ok(PaneInfo {
            attached: f[0].parse().unwrap_or(0),
            in_mode: f[1] == "1",
            history_size: f[2].parse().unwrap_or(0),
            current_command: f[3].to_string(),
        })
    }

    /// Drive copy-mode from the server side. Never types into the pane: every
    /// op that would only make sense inside copy-mode is gated on `in_mode`.
    pub async fn scroll(&self, name: &str, op: ScrollOp) -> Result<PaneInfo, TmuxError> {
        let t = format!("={name}:");
        let in_mode = self.info(name).await?.in_mode;
        match op {
            ScrollOp::Up(n) => {
                let n = n.to_string();
                self.run(&["copy-mode", "-e", "-t", &t, ";", "send-keys", "-X", "-N", &n, "-t", &t, "scroll-up"]).await?;
            }
            ScrollOp::Top => {
                self.run(&["copy-mode", "-e", "-t", &t, ";", "send-keys", "-X", "-t", &t, "history-top"]).await?;
            }
            ScrollOp::Down(n) if in_mode => {
                let n = n.to_string();
                self.run(&["send-keys", "-X", "-N", &n, "-t", &t, "scroll-down"]).await?;
            }
            ScrollOp::Bottom | ScrollOp::Cancel if in_mode => {
                self.run(&["send-keys", "-X", "-t", &t, "cancel"]).await?;
            }
            _ => {}
        }
        self.info(name).await
    }

    pub async fn refresh_client_for_pid(&self, pid: u32) -> Result<(), TmuxError> {
        let out = self.run(&["list-clients", "-F", "#{client_pid}\t#{client_tty}"]).await?;
        let tty = out.lines()
            .filter_map(|l| l.split_once('\t'))
            .find(|(p, _)| p.parse::<u32>().ok() == Some(pid))
            .map(|(_, t)| t.to_string())
            .ok_or(TmuxError::NotFound)?;
        self.run(&["refresh-client", "-t", &tty]).await.map(|_| ())
    }
```
模块级追加：
```rust
pub fn tmux_name_for(id: &str) -> String {
    format!("zmx-{}", &id[..8.min(id.len())])
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Captured { pub text: String, pub truncated: bool }

#[derive(Debug, Clone, serde::Serialize)]
pub struct HostTmux { pub name: String, pub windows: u32, pub attached: u32, pub created: i64, pub path: String }

#[derive(Debug, Clone, serde::Serialize)]
pub struct PaneInfo { pub attached: u32, pub in_mode: bool, pub history_size: u64, pub current_command: String }

#[derive(Debug, Clone, Copy)]
pub enum ScrollOp { Up(u32), Down(u32), Top, Bottom, Cancel }

impl ScrollOp {
    pub fn parse(op: &str, n: u32) -> Option<Self> {
        let n = n.clamp(1, 200);
        Some(match op {
            "up" => ScrollOp::Up(n),
            "down" => ScrollOp::Down(n),
            "top" => ScrollOp::Top,
            "bottom" => ScrollOp::Bottom,
            "cancel" => ScrollOp::Cancel,
            _ => return None,
        })
    }
}

/// Keep the TAIL (most recent output) under `max_bytes`, cutting at a line boundary.
fn truncate_head(text: String, max_bytes: usize) -> Captured {
    if text.len() <= max_bytes { return Captured { text, truncated: false }; }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) { start += 1; }
    let start = text[start..].find('\n').map(|i| start + i + 1).unwrap_or(text.len());
    Captured { text: text[start..].to_string(), truncated: true }
}
```
注意：`list-sessions` 在 server 存在但 0 会话时返回 "no sessions"——`classify_stderr` 里把 `"no sessions"` 也归为 `NotFound`：在 `classify_stderr` 的 NotFound 分支条件加 `|| err.contains("no sessions")`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --bin zeromux tmux::tests 2>&1 | tail -5`
Expected: `ok. 13 passed`（若机器无 tmux，server 类测试提前 return 视为通过）。

- [ ] **Step 5: 迁移 `list_tmux_sessions`**

`src/web.rs` 的 `list_tmux_sessions` 保留 admin gate，把 `std::process::Command` 那段替换为：
```rust
    let sessions = state.tmux.list().await.unwrap_or_default();
    Ok(Json(serde_json::json!({ "sessions": sessions })))
```
签名加 `State(state): State<Arc<AppState>>,`（放在 `user` 之前）。响应字段多了 `path`，前端 `TmuxSession` 接口同步加 `path: string`。

Run: `cargo build 2>&1 | grep -E "^error" | head; cargo test 2>&1 | grep "test result"`
Expected: 无 error，全部 ok。

- [ ] **Step 6: Commit**
```bash
git add src/tmux.rs src/web.rs frontend/src/lib/api.ts
git commit -m "feat(tmux): TmuxCtl has/kill/capture/list/info/scroll/refresh + async tmux ls"
```

---

### Task 3: 终端默认 tmux 会话模型

**Files:**
- Modify: `src/pty_bridge.rs:28`（`env_remove("TMUX")`）
- Modify: `src/session_manager.rs`（`SessionManager::new` 加 `tmux` 参数；`Session`/`SessionInfo` 新字段；`spawn_tmux`；`create_pty_session` 改 async；`set_size`；`load_persisted`；`persist_meta`）
- Modify: `src/session_store.rs`（新列 `tmux_origin`、`cols`、`rows`；`update_size`）
- Modify: `src/main.rs`（传 `TmuxCtl`）、`src/web.rs:865-868`（`.await`）、`src/ws_handler.rs:166`（resize 回写）
- Modify: `frontend/src/lib/api.ts`（`SessionInfo` 新字段）
- Test: `src/session_manager.rs` tests、`src/session_store.rs` tests

**Interfaces:**
- Consumes: T2 `TmuxCtl::{attach_argv, run, has}`, `tmux_name_for`
- Produces:
  - `#[derive(Clone, Copy, Debug, PartialEq, Serialize)] #[serde(rename_all="lowercase")] pub enum TmuxOrigin { Own, External }`，`TmuxOrigin::as_str()`/`from_str_lenient()`（`"external"`→External，其它→Own）
  - `Session.tmux_origin: Option<TmuxOrigin>`（None = 非 tmux 或旧裸 shell）
  - `SessionInfo.tmux_name: Option<String>`、`SessionInfo.tmux_origin: Option<TmuxOrigin>`
  - `pub async fn create_pty_session(&self, name, _shell, work_dir, cols, rows, owner_id, tmux_target: Option<&str>) -> Result<String, String>`
  - `pub fn set_size(&self, id: &str, cols: u16, rows: u16)`
  - `pub fn tmux_binding(&self, id: &str) -> Option<(String, TmuxOrigin)>`
  - `SessionManager::tmux(&self) -> &TmuxCtl`
  - `PersistedSession.tmux_origin: Option<String>`, `.cols: u16`, `.rows: u16`；`SessionStore::update_size(id, cols, rows)`
  - 前端 `SessionInfo.tmux_name: string | null`、`tmux_origin: 'own' | 'external' | null`

- [ ] **Step 1: 写失败测试（store 列 + 新建即 tmux + server down 报错）**

`src/session_store.rs` tests 追加：
```rust
    #[test]
    fn persists_tmux_origin_and_size() {
        let d = tempfile::tempdir().unwrap();
        let st = SessionStore::open(d.path()).unwrap();
        let mut p = sample("a", Some(ResumeToken::Tmux("zmx-a".into())));
        p.tmux_origin = Some("external".into());
        p.cols = 132; p.rows = 40;
        st.upsert(&p).unwrap();
        st.update_size("a", 100, 30).unwrap();
        let r = st.load_all().unwrap().into_iter().find(|x| x.id == "a").unwrap();
        assert_eq!(r.tmux_origin.as_deref(), Some("external"));
        assert_eq!((r.cols, r.rows), (100, 30));
    }
```
并把 `sample()` 里的 `PersistedSession { .. }` 补上 `tmux_origin: None, cols: 80, rows: 24,`。

`src/session_manager.rs` 在 `#[cfg(test)]` 的 tmux 相关测试模块（新建 `mod tmux_session_tests`）：
```rust
#[cfg(test)]
mod tmux_session_tests {
    use super::*;
    use crate::tmux::tests::TestServer;

    fn mgr_with(ctl: crate::tmux::TmuxCtl) -> (Arc<SessionManager>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false, ctl);
        (m, dir)
    }

    #[tokio::test]
    async fn new_terminal_is_own_tmux_session() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        let (name, origin) = m.tmux_binding(&id).unwrap();
        assert_eq!(name, crate::tmux::tmux_name_for(&id));
        assert_eq!(origin, TmuxOrigin::Own);
        // PTY client attaches asynchronously; poll briefly.
        for _ in 0..30 {
            if srv.ctl.has(&name).await.unwrap() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(srv.ctl.has(&name).await.unwrap());
        let info = m.list_sessions(None).into_iter().find(|s| s.id == id).unwrap();
        assert_eq!(info.tmux_name.as_deref(), Some(name.as_str()));
    }

    #[tokio::test]
    async fn attach_target_is_external() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "vscode-dev"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("x".into(), "bash", "/tmp", 80, 24, "u", Some("vscode-dev")).await.unwrap();
        assert_eq!(m.tmux_binding(&id), Some(("vscode-dev".into(), TmuxOrigin::External)));
    }

    #[tokio::test]
    async fn server_down_errors_instead_of_bare_shell() {
        let ctl = crate::tmux::TmuxCtl::new(Some(format!("zmx-test-down-{}", std::process::id())));
        let (m, _d) = mgr_with(ctl);
        let err = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap_err();
        assert!(err.contains("tmux 服务未运行"), "{err}");
        assert!(m.list_sessions(None).is_empty());
    }

    #[test]
    fn set_size_updates_memory_and_store() {
        let (m, _d) = mgr_with(crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())));
        let mut s = test_session_for_size();
        s.id = "sz".into();
        m.persist_meta(&s);
        m.sessions.lock().unwrap().insert("sz".into(), s);
        m.set_size("sz", 101, 33);
        let s = m.sessions.lock().unwrap().get("sz").map(|s| (s.cols, s.rows));
        assert_eq!(s, Some((101, 33)));
        let row = m.store.load_all().unwrap().into_iter().find(|p| p.id == "sz").unwrap();
        assert_eq!((row.cols, row.rows), (101, 33));
    }

    fn test_session_for_size() -> Session {
        Session {
            id: "sid".into(), name: "n".into(), session_type: SessionType::Tmux,
            cols: 80, rows: 24, work_dir: "/tmp".into(), owner_id: "u".into(),
            description: String::new(), name_is_auto: true, status: SessionMeta::Idle,
            resume_token: Some(ResumeToken::Tmux("zmx-sid".into())), tmux_origin: Some(TmuxOrigin::Own),
            pending_kill_until: None,
            worktree_path: None, created_ms: 0, source_task_id: None, spawning: false,
            last_activity_ms: 0, turns_completed: 0, run_metrics: VecDeque::new(),
            lifetime_turns: 0, lifetime_duration_ms: 0, lifetime_cost_usd: 0.0,
            running: None, scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }
}
```
（`pending_kill_until` 字段在 T5 才用到，但本 Task 一并加进 `Session`，默认 `None`，避免 T5 再改 9 处构造。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux tmux_session_tests persists_tmux_origin 2>&1 | tail -5`
Expected: 编译失败。

- [ ] **Step 3: 实现 store 列**

`src/session_store.rs`：`PersistedSession` 加
```rust
    pub tmux_origin: Option<String>,
    pub cols: u16,
    pub rows: u16,
```
`open()` 迁移处追加：
```rust
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN tmux_origin TEXT", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN cols INTEGER NOT NULL DEFAULT 80", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN rows INTEGER NOT NULL DEFAULT 24", []);
```
`upsert` 的 INSERT 列表追加 `tmux_origin,cols,rows` 为 `?13,?14,?15`，`DO UPDATE SET` 追加 `tmux_origin=?13, cols=?14, rows=?15`，params 追加 `s.tmux_origin, s.cols as i64, s.rows as i64`。`load_all` 的 SELECT 追加 `,tmux_origin,cols,rows`，构造追加：
```rust
                tmux_origin: row.get(12)?,
                cols: row.get::<_, i64>(13)? as u16,
                rows: row.get::<_, i64>(14)? as u16,
```
新方法：
```rust
    pub fn update_size(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET cols=?2, rows=?3 WHERE id=?1",
                     params![id, cols as i64, rows as i64])
            .map_err(|e| format!("update_size failed: {}", e))?;
        Ok(())
    }
```

- [ ] **Step 4: 实现 session_manager 改动**

1. `src/pty_bridge.rs` 在 `cmd_builder.env("COLORTERM", "truecolor");` 后加：
```rust
        // A zeromux started from inside tmux would otherwise make every
        // `tmux attach/new-session` refuse with "sessions should be nested".
        cmd_builder.env_remove("TMUX");
```
2. `TmuxOrigin` 枚举放在 `ResumeToken` 定义之后：
```rust
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TmuxOrigin { Own, External }

impl TmuxOrigin {
    pub fn as_str(self) -> &'static str { match self { Self::Own => "own", Self::External => "external" } }
    pub fn from_str_lenient(s: &str) -> Self { if s == "external" { Self::External } else { Self::Own } }
}
```
3. `Session` 在 `resume_token` 之后加：
```rust
    /// Some for tmux-backed terminals (resume_token is Tmux(name)); None for
    /// legacy bare-shell PTYs and agent sessions.
    tmux_origin: Option<TmuxOrigin>,
    /// Set by DELETE on tmux sessions: hidden from lists, killed when due (T5).
    pending_kill_until: Option<i64>,
```
并在所有 9 处 `Session { ... }` 构造（`grep -n "scrollback_bytes: 0" src/session_manager.rs`）补 `tmux_origin: None, pending_kill_until: None,`（`load_persisted` 与 `create_pty_session` 见下）。
4. `SessionInfo` 加 `pub tmux_name: Option<String>, pub tmux_origin: Option<TmuxOrigin>,`；`session_info_of` 加：
```rust
        tmux_name: match (&s.resume_token, s.tmux_origin) {
            (Some(ResumeToken::Tmux(n)), Some(_)) => Some(n.clone()),
            _ => None,
        },
        tmux_origin: s.tmux_origin,
```
5. `SessionManager` 结构体加字段 `tmux: crate::tmux::TmuxCtl,`；`new()` 末尾参数加 `tmux: crate::tmux::TmuxCtl`，结构体初始化加 `tmux,`；加访问器 `pub fn tmux(&self) -> &crate::tmux::TmuxCtl { &self.tmux }`。更新 `src/main.rs:479` 调用（末尾加 `tmux::TmuxCtl::new(Some(args.tmux_socket.clone())),`）和 4 处测试调用（末尾加 `crate::tmux::TmuxCtl::new(Some("zmx-test-unused".into())),`）。
6. `spawn_tmux` 签名改为 `target: Option<&str>` → `tmux_name: Option<&str>`，命令构造改为：
```rust
        let argv: Vec<String>;
        let (cmd, args): (&str, Vec<&str>) = if let Some(name) = tmux_name {
            argv = self.tmux.attach_argv(name, cwd);
            ("tmux", argv.iter().map(String::as_str).collect())
        } else {
            (self.shell.as_str(), vec![])
        };
```
（`new-session -A` 对已存在会话等价于 attach，所以 Own 与 External 都走这一条；origin 只影响 T4 的缺失分流与 T5 的确认。）文档注释同步改为 "`tmux_name` Some → `tmux new-session -A -s <name>` (attach-or-create, via TmuxCtl); None → legacy bare shell"。
7. `create_pty_session` 改为 `pub async fn`，在 `let id = ...` 之后：
```rust
        let (tmux_name, origin) = match tmux_target {
            Some(t) => (t.to_string(), TmuxOrigin::External),
            None => (crate::tmux::tmux_name_for(&id), TmuxOrigin::Own),
        };
        // Refuse rather than fall back to a bare shell: a bare shell silently
        // loses the "survives deploy / attach from VSCode" promise.
        self.tmux.run(&["list-sessions"]).await.or_else(|e| match e {
            crate::tmux::TmuxError::NotFound => Ok(String::new()), // server up, 0 sessions
            e => Err(e.to_string()),
        })?;
        let running = self.spawn_tmux(&id, work_dir, cols, rows, Some(&tmux_name))?;
```
Session 构造：`resume_token: Some(ResumeToken::Tmux(tmux_name.clone())), tmux_origin: Some(origin), pending_kill_until: None,`。
8. `persist_meta` 的 `PersistedSession` 构造补：
```rust
            tmux_origin: s.tmux_origin.map(|o| o.as_str().to_string()),
            cols: s.cols,
            rows: s.rows,
```
9. `load_persisted`：`cols: p.cols, rows: p.rows,`（替换 80/24），并：
```rust
                    tmux_origin: match (&p.resume_token, p.tmux_origin.as_deref()) {
                        (Some(ResumeToken::Tmux(_)), Some(o)) => Some(TmuxOrigin::from_str_lenient(o)),
                        // Pre-migration rows: zeromux-made names are ours, anything else was attached.
                        (Some(ResumeToken::Tmux(n)), None) => Some(if n.starts_with("zmx-") { TmuxOrigin::Own } else { TmuxOrigin::External }),
                        _ => None,
                    },
                    pending_kill_until: None,
```
10. 新方法：
```rust
    pub fn set_size(&self, id: &str, cols: u16, rows: u16) {
        let changed = match self.sessions.lock().unwrap().get_mut(id) {
            Some(s) if (s.cols, s.rows) != (cols, rows) => { s.cols = cols; s.rows = rows; true }
            _ => false,
        };
        if changed { let _ = self.store.update_size(id, cols, rows); }
    }

    pub fn tmux_binding(&self, id: &str) -> Option<(String, TmuxOrigin)> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id)?;
        match (&s.resume_token, s.tmux_origin) {
            (Some(ResumeToken::Tmux(n)), Some(o)) => Some((n.clone(), o)),
            _ => None,
        }
    }
```
11. `src/web.rs:867` 调用加 `.await`。`src/ws_handler.rs` 的 `ClientMsg::Resize` 分支在 send 之前加 `state.sessions.set_size(&session_id, cols, rows);`。
12. 前端 `api.ts` 的 `SessionInfo` 加 `tmux_name: string | null` 与 `tmux_origin: 'own' | 'external' | null`；`grep -rn "last_activity_ms:" frontend/src --include=*.test.*` 找到的测试夹具补这两个字段为 `null`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cargo test 2>&1 | grep -E "test result|FAILED|panicked" ; cd frontend && npx tsc -b && npm test 2>&1 | tail -3`
Expected: 全部 ok，tsc 无错误。

- [ ] **Step 6: Commit**
```bash
git add src/ frontend/src
git commit -m "feat(tmux): new terminals are zmx-<id8> tmux sessions; origin+size persisted; clear TMUX env"
```

---

### Task 4: re-attach 分流、Ended 状态、WS `notice` 通道

**Files:**
- Modify: `src/session_manager.rs`（`SessionMeta::Ended`；`tmux_preflight`；Tmux 分支不再回退裸 shell；fan-out 结束检查；`revive`）
- Modify: `src/ws_handler.rs`（preflight + notice）
- Modify: `src/web.rs`（`POST /api/sessions/{id}/revive`）
- Modify: `frontend/src/lib/api.ts`、`frontend/src/components/TerminalNotices.tsx`、`frontend/src/components/TerminalView.tsx`
- Test: `src/session_manager.rs` `tmux_session_tests`；`frontend/src/components/__tests__/TerminalNotices.test.tsx`

**Interfaces:**
- Consumes: T3 `tmux_binding`, `TmuxCtl::has`
- Produces:
  - `SessionMeta::Ended`（Display `"ended"`）
  - `pub enum Preflight { Ready, Lost, Ended, ServerDown }`
  - `pub fn decide_tmux_resume(origin: TmuxOrigin, exists: bool) -> Preflight`（纯函数：exists→Ready；Own→Lost；External→Ended）
  - `pub async fn tmux_preflight(&self, id: &str) -> Preflight`（非 tmux 或已 running → Ready；status==Ended → Ended）
  - `pub fn revive(&self, id: &str) -> bool`（Ended→Idle，origin 改为 Own）
  - WS 服务端消息 `{"type":"notice","kind":"tmux_lost"|"tmux_ended"|"tmux_down"}`
  - 前端 `reviveSession(id): Promise<void>`；`TerminalNotices.tsx` 导出 `LostBanner({onClose})`、`EndedOverlay({name, onRevive, onClose})`

- [ ] **Step 1: 写失败测试**

`tmux_session_tests` 追加：
```rust
    #[test]
    fn decide_resume_matrix() {
        assert!(matches!(decide_tmux_resume(TmuxOrigin::Own, true), Preflight::Ready));
        assert!(matches!(decide_tmux_resume(TmuxOrigin::External, true), Preflight::Ready));
        assert!(matches!(decide_tmux_resume(TmuxOrigin::Own, false), Preflight::Lost));
        assert!(matches!(decide_tmux_resume(TmuxOrigin::External, false), Preflight::Ended));
    }

    fn idle_tmux(m: &SessionManager, id: &str, name: &str, origin: TmuxOrigin) {
        let mut s = test_session_for_size();
        s.id = id.into();
        s.resume_token = Some(ResumeToken::Tmux(name.into()));
        s.tmux_origin = Some(origin);
        m.sessions.lock().unwrap().insert(id.into(), s);
    }

    #[tokio::test]
    async fn external_missing_marks_ended() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        idle_tmux(&m, "e1", "gone-ext", TmuxOrigin::External);
        assert!(matches!(m.tmux_preflight("e1").await, Preflight::Ended));
        let st = m.list_sessions(None).into_iter().find(|s| s.id == "e1").unwrap().status;
        assert!(matches!(st, SessionMeta::Ended));
        // A second connect must not spawn anything either.
        assert!(matches!(m.tmux_preflight("e1").await, Preflight::Ended));
        assert!(m.revive("e1"));
        assert_eq!(m.tmux_binding("e1").unwrap().1, TmuxOrigin::Own);
        assert!(matches!(m.tmux_preflight("e1").await, Preflight::Lost), "revived → recreated as own");
    }

    #[tokio::test]
    async fn own_missing_is_lost_and_server_down_reported() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        idle_tmux(&m, "o1", "zmx-o1", TmuxOrigin::Own);
        assert!(matches!(m.tmux_preflight("o1").await, Preflight::Lost));
        let (m2, _d2) = mgr_with(crate::tmux::TmuxCtl::new(Some(format!("zmx-test-down2-{}", std::process::id()))));
        idle_tmux(&m2, "o2", "zmx-o2", TmuxOrigin::Own);
        assert!(matches!(m2.tmux_preflight("o2").await, Preflight::ServerDown));
    }

    #[tokio::test]
    async fn killing_tmux_ends_the_session() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        let (name, _) = m.tmux_binding(&id).unwrap();
        for _ in 0..30 { if srv.ctl.has(&name).await.unwrap() { break; } tokio::time::sleep(std::time::Duration::from_millis(100)).await; }
        srv.ctl.kill(&name).await.unwrap();      // e.g. killed from VSCode
        let mut ended = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Some(s) = m.list_sessions(None).into_iter().find(|s| s.id == id) {
                if matches!(s.status, SessionMeta::Ended) { ended = true; break; }
            }
        }
        assert!(ended, "fan-out exit + has=false must mark Ended");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux tmux_session_tests 2>&1 | tail -5`
Expected: 编译失败（`Preflight` 未定义）。

- [ ] **Step 3: 实现后端**

1. `SessionMeta` 加 `Ended,`，Display 加 `SessionMeta::Ended => write!(f, "ended"),`。`SessionMeta` 已 `#[serde(rename_all = "lowercase")]`，序列化即 `"ended"`。
2. 在 `session_manager.rs` 模块级：
```rust
pub enum Preflight { Ready, Lost, Ended, ServerDown }

pub fn decide_tmux_resume(origin: TmuxOrigin, exists: bool) -> Preflight {
    match (exists, origin) {
        (true, _) => Preflight::Ready,
        (false, TmuxOrigin::Own) => Preflight::Lost,
        (false, TmuxOrigin::External) => Preflight::Ended,
    }
}
```
3. `impl SessionManager`：
```rust
    /// Decide how a connecting terminal client should proceed BEFORE ensure_running
    /// spawns anything. Own+missing → Lost (ensure_running's `new-session -A`
    /// recreates it under the same name); External+missing → Ended (never spawn:
    /// someone else closed it).
    pub async fn tmux_preflight(&self, id: &str) -> Preflight {
        let (name, origin) = {
            let map = self.sessions.lock().unwrap();
            let Some(s) = map.get(id) else { return Preflight::Ready };
            if matches!(s.status, SessionMeta::Ended) { return Preflight::Ended; }
            if s.running.is_some() { return Preflight::Ready; }
            match (&s.resume_token, s.tmux_origin) {
                (Some(ResumeToken::Tmux(n)), Some(o)) => (n.clone(), o),
                _ => return Preflight::Ready,
            }
        };
        let decision = match self.tmux.has(&name).await {
            Ok(exists) => decide_tmux_resume(origin, exists),
            Err(_) => return Preflight::ServerDown,
        };
        if matches!(decision, Preflight::Ended) { self.mark_ended(id); }
        decision
    }

    fn mark_ended(&self, id: &str) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.status = SessionMeta::Ended;
            s.running = None;
        }
    }

    /// "新建同名会话": the tmux session is now zeromux's own.
    pub fn revive(&self, id: &str) -> bool {
        let snapshot = {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(id) else { return false };
            if !matches!(s.status, SessionMeta::Ended) { return false; }
            s.status = SessionMeta::Idle;
            s.tmux_origin = Some(TmuxOrigin::Own);
            persisted_of(s)
        };
        if let Err(e) = self.store.upsert(&snapshot) { tracing::warn!("persist revive {} failed: {}", id, e); }
        true
    }
```
同时把现有 `persist_meta` 拆成纯函数 + 薄包装（`revive` 需在锁内取快照、锁外写 SQLite）：
```rust
/// Build the persisted row for a session (pure; callable under the sessions lock).
fn persisted_of(s: &Session) -> PersistedSession {
    PersistedSession { /* ...move the existing field list from persist_meta here verbatim... */ }
}

    fn persist_meta(&self, s: &Session) {
        if let Err(e) = self.store.upsert(&persisted_of(s)) {
            tracing::warn!("persist session {} failed: {}", s.id, e);
        }
    }
```
（`persisted_of` 的字段列表就是当前 `persist_meta` 里 `let pj = PersistedSession { ... };` 的内容原样搬过去，外加 T3 新增的 `tmux_origin/cols/rows`。）
4. `ensure_running` 的 resume 回退（约 1703-1710 行 `fresh` 的 match）：Tmux 分支不再回退裸 shell：
```rust
                    // tmux: no bare-shell fallback — a bare shell silently loses
                    // persistence. Preflight already decided Lost/Ended/ServerDown.
                    SessionType::Tmux => Err(e.clone()),
```
（`Err(e) if attempted_resume` 分支需把 `e` 用于上面；若 `e` 被 move，先 `let e2 = e.clone();`。）
5. tmux fan-out 结束处（`spawn_tmux` 里 `mark_fanout_ended(&mgr_weak, &sid_for_exit);`）改为：
```rust
            mark_fanout_ended(&mgr_weak, &sid_for_exit);
            // The tmux client exited. If the tmux SESSION is gone too (killed from
            // VSCode, or its last shell exited), this terminal is over — mark Ended
            // so the next connect shows the overlay instead of recreating.
            if let Some(m) = mgr_weak.upgrade() {
                if let Some((name, _)) = m.tmux_binding(&sid_for_exit) {
                    if let Ok(false) = m.tmux.has(&name).await {
                        m.mark_ended(&sid_for_exit);
                    }
                }
            }
```

- [ ] **Step 4: ws_handler preflight + notice**

`handle_ws` 开头（`ensure_running` 之前）：
```rust
    let notice = |kind: &str| serde_json::json!({"type": "notice", "kind": kind}).to_string();
    let pre = state.sessions.tmux_preflight(&session_id).await;
    let mut socket = socket;
    match pre {
        crate::session_manager::Preflight::Ended | crate::session_manager::Preflight::ServerDown => {
            let kind = if matches!(pre, crate::session_manager::Preflight::Ended) { "tmux_ended" } else { "tmux_down" };
            let _ = socket.send(Message::Text(notice(kind).into())).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
        _ => {}
    }
```
在 `let (mut ws_sink, mut ws_stream) = socket.split();` 之后、回放之前：
```rust
    if matches!(pre, crate::session_manager::Preflight::Lost) {
        let _ = ws_sink.send(Message::Text(notice("tmux_lost").into())).await;
    }
```
（`use futures::SinkExt` 已存在；`WebSocket::send` 需 `SinkExt`。）

- [ ] **Step 5: revive API**

`src/web.rs` 路由加 `.route("/api/sessions/{id}/revive", post(revive_session))`：
```rust
async fn revive_session(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> StatusCode {
    if !user.is_admin() && !state.sessions.is_owner(&id, &user.id) { return StatusCode::FORBIDDEN; }
    if state.sessions.revive(&id) { StatusCode::OK } else { StatusCode::CONFLICT }
}
```

- [ ] **Step 6: 跑后端测试**

Run: `cargo test 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: 全部 ok。

- [ ] **Step 7: 前端 notice 组件（先写测试）**

`TerminalNotices.test.tsx` 追加：
```tsx
import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import { LostBanner, EndedOverlay } from '../TerminalNotices'

describe('LostBanner / EndedOverlay', () => {
  it('lost banner stays until closed', () => {
    const onClose = vi.fn()
    render(<LostBanner onClose={onClose} />)
    expect(screen.getByRole('status').textContent).toContain('之前的输出不可恢复')
    fireEvent.click(screen.getByLabelText('关闭提示'))
    expect(onClose).toHaveBeenCalled()
  })
  it('ended overlay offers revive + close', () => {
    const onRevive = vi.fn(), onClose = vi.fn()
    render(<EndedOverlay name="vscode-dev" onRevive={onRevive} onClose={onClose} />)
    expect(screen.getByText(/vscode-dev 已在其他终端结束/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('新建同名会话'))
    fireEvent.click(screen.getByText('关闭'))
    expect(onRevive).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
```
Run: `cd frontend && npx vitest run src/components/__tests__/TerminalNotices.test.tsx` → FAIL（未导出）。

`TerminalNotices.tsx` 追加：
```tsx
export function LostBanner({ onClose }: { onClose: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-b border-[var(--border)]">
      <span className="flex-1">tmux 会话已丢失（服务重启？），已在原目录新建，之前的输出不可恢复</span>
      <button aria-label="关闭提示" onClick={onClose} className="px-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">✕</button>
    </div>
  )
}

export function EndedOverlay({ name, onRevive, onClose }: { name: string; onRevive: () => void; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--bg-primary)]/90 text-sm text-[var(--text-primary)]">
      <div>{name} 已在其他终端结束</div>
      <div className="flex gap-2">
        <button onClick={onRevive} className="px-3 py-1.5 rounded bg-[var(--accent-blue)] text-white">新建同名会话</button>
        <button onClick={onClose} className="px-3 py-1.5 rounded border border-[var(--border)]">关闭</button>
      </div>
    </div>
  )
}
```
`api.ts` 追加：
```ts
export async function reviveSession(id: string): Promise<void> {
  const res = await api(`/api/sessions/${id}/revive`, { method: 'POST' })
  if (!res.ok) throw new Error(await res.text())
}
```

- [ ] **Step 8: TerminalView 接线**

Props 加 `tmuxName?: string | null` 与 `onClose?: () => void`（App 传 `tmuxName={s.tmux_name}` 与 `onClose={() => handleDelete(s.id)}`）。state：
```tsx
  const [lost, setLost] = useState(false)
  const [ended, setEnded] = useState(false)
  const endedRef = useRef(false)
```
`ws.onmessage` 的 `msg.type === 'output'` 分支之前加：
```tsx
          if (msg.type === 'notice') {
            if (msg.kind === 'tmux_lost') setLost(true)
            if (msg.kind === 'tmux_ended') { endedRef.current = true; setEnded(true) }
            if (msg.kind === 'tmux_down') setHealth({ server: false, in_unit: false })
            return
          }
```
`ws.onclose` 里的重连条件改为 `if (!disposed && !endedRef.current)`。增加 `const [wsEpoch, setWsEpoch] = useState(0)` 并把它加进 Connect WebSocket effect 的依赖（`[sessionId, wsEpoch]`），revive 后 `endedRef.current = false; setEnded(false); setWsEpoch(e => e + 1)`。JSX：外层容器加 `relative`；`<TmuxHealthBar>` 下方 `{lost && <LostBanner onClose={() => setLost(false)} />}`；`xterm-container` 同级 `{ended && <EndedOverlay name={tmuxName ?? ''} onRevive={async () => { await reviveSession(sessionId); endedRef.current = false; setEnded(false); setWsEpoch(e => e + 1) }} onClose={() => onClose?.()} />}`。前端 `SessionMetaStatus` 加 `'ended'`。

Run: `cd frontend && npx tsc -b && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 9: Commit**
```bash
git add src/ frontend/src
git commit -m "feat(tmux): preflight Lost/Ended/ServerDown via WS notice; no bare-shell fallback; revive"
```

---

### Task 5: X = 服务端延迟 kill + 撤销 + 分级确认

**Files:**
- Modify: `src/session_store.rs`（列 `pending_kill_until`；`set_pending_kill`）
- Modify: `src/session_manager.rs`（`mark_pending_kill`/`restore`/`finalize_pending_kill`/`reconcile_pending_kills`/`close_check`；`list_sessions` 过滤）
- Modify: `src/web.rs`（`delete_session` 分流；`/restore`；`/close-check`）、`src/main.rs`（启动 reconcile）
- Create: `frontend/src/lib/closeSession.ts`、`frontend/src/components/Toast.tsx`
- Modify: `frontend/src/lib/api.ts`、`frontend/src/App.tsx:299`（`handleDelete`）
- Modify: `CLAUDE.md`
- Test: `tmux_session_tests`、`frontend/src/lib/__tests__/closeSession.test.ts`、`frontend/src/components/__tests__/Toast.test.tsx`

**Interfaces:**
- Consumes: T3 `tmux_binding`, T2 `kill`/`info`
- Produces:
  - `pub const PENDING_KILL_MS: i64 = 5_000;`
  - `pub fn mark_pending_kill(&self, id: &str, now: i64) -> bool`（仅 tmux-backed；返回是否已标记）
  - `pub fn restore(&self, id: &str) -> bool`
  - `pub async fn finalize_pending_kill(&self, id: &str, now: i64) -> bool`（仍标记且到期才 kill+remove）
  - `pub async fn reconcile_pending_kills(&self)`（启动时全部执行）
  - `#[derive(Serialize)] pub struct CloseCheck { pub external: bool, pub other_clients: u32, pub busy_command: Option<String> }`；`pub async fn close_check(&self, id: &str) -> Option<CloseCheck>`
  - HTTP：`DELETE /api/sessions/{id}` → `{"pending_until": ms}`（tmux）或 200 空体（其它）；`POST /api/sessions/{id}/restore`；`GET /api/sessions/{id}/close-check`
  - 前端 `closeCheck(id)`, `restoreSession(id)`；`deleteSession(id): Promise<{ pending_until?: number }>`
  - `closeSession.ts`：`export function closeConfirmMessage(name: string, c: CloseCheck | null): string | null`
  - `Toast.tsx`：`export default function Toast({ message, actionLabel, onAction, durationMs, onDone })`

- [ ] **Step 1: 写后端失败测试**

`tmux_session_tests` 追加：
```rust
    #[tokio::test]
    async fn delayed_kill_then_restore_and_finalize() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        let (name, _) = m.tmux_binding(&id).unwrap();
        for _ in 0..30 { if srv.ctl.has(&name).await.unwrap() { break; } tokio::time::sleep(std::time::Duration::from_millis(100)).await; }

        assert!(m.mark_pending_kill(&id, 1_000));
        assert!(m.list_sessions(None).iter().all(|s| s.id != id), "hidden while pending");
        assert!(m.restore(&id));
        assert!(m.list_sessions(None).iter().any(|s| s.id == id), "restored");
        assert!(!m.finalize_pending_kill(&id, 1_000 + PENDING_KILL_MS).await, "restore cancels the kill");
        assert!(srv.ctl.has(&name).await.unwrap());

        assert!(m.mark_pending_kill(&id, 2_000));
        assert!(!m.finalize_pending_kill(&id, 2_000 + PENDING_KILL_MS - 1).await, "not due yet");
        assert!(m.finalize_pending_kill(&id, 2_000 + PENDING_KILL_MS).await);
        assert!(!srv.ctl.has(&name).await.unwrap(), "tmux session killed");
        assert!(m.tmux_binding(&id).is_none(), "zeromux session removed");
    }

    #[tokio::test]
    async fn external_sessions_are_killed_too() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "ext1"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("x".into(), "bash", "/tmp", 80, 24, "u", Some("ext1")).await.unwrap();
        assert!(m.mark_pending_kill(&id, 0));
        assert!(m.finalize_pending_kill(&id, PENDING_KILL_MS).await);
        assert!(!srv.ctl.has("ext1").await.unwrap());
    }

    #[tokio::test]
    async fn startup_reconcile_kills_pending() {
        let Some(srv) = TestServer::start() else { return };
        let dir = tempfile::tempdir().unwrap();
        let id = {
            let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
            let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
            let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
                5476, "/tmp/crew".into(), "bash".into(), false, srv.ctl.clone());
            let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
            assert!(m.mark_pending_kill(&id, now_millis()));   // not yet due
            id
        }; // "process exits" before the timer fires
        let name = crate::tmux::tmux_name_for(&id);
        srv.ctl.run(&["new-session", "-d", "-s", &name]).await.ok(); // ensure it exists even if PTY died
        let events = Arc::new(crate::events::EventStore::open(dir.path()).unwrap());
        let store = Arc::new(crate::session_store::SessionStore::open(dir.path()).unwrap());
        let m = SessionManager::new(events, store, "claude".into(), "codex".into(), "off".into(),
            5476, "/tmp/crew".into(), "bash".into(), false, srv.ctl.clone());
        m.load_persisted();
        m.reconcile_pending_kills().await;
        assert!(!srv.ctl.has(&name).await.unwrap());
        assert!(m.list_sessions(None).is_empty());
    }

    #[tokio::test]
    async fn close_check_reports_other_clients_and_origin() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "ext2"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("x".into(), "bash", "/tmp", 80, 24, "u", Some("ext2")).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let c = m.close_check(&id).await.unwrap();
        assert!(c.external);
        assert_eq!(c.other_clients, 0, "zeromux's own client is not 'other'");
        assert!(c.busy_command.is_none(), "idle shell is not busy");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux tmux_session_tests 2>&1 | tail -5`
Expected: 编译失败。

- [ ] **Step 3: 实现 store**

`PersistedSession` 加 `pub pending_kill_until: Option<i64>,`（`sample()` 与 `persisted_of` 补上；`persisted_of` 用 `s.pending_kill_until`）；迁移加 `let _ = conn.execute("ALTER TABLE sessions ADD COLUMN pending_kill_until INTEGER", []);`；upsert 追加 `?16`（INSERT 列与 `DO UPDATE SET pending_kill_until=?16`）；load_all SELECT 追加并 `pending_kill_until: row.get(15)?`；`load_persisted` 用 `pending_kill_until: p.pending_kill_until`。新方法：
```rust
    pub fn set_pending_kill(&self, id: &str, until: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET pending_kill_until=?2 WHERE id=?1", params![id, until])
            .map_err(|e| format!("set_pending_kill failed: {}", e))?;
        Ok(())
    }
```

- [ ] **Step 4: 实现 manager**

```rust
pub const PENDING_KILL_MS: i64 = 5_000;

#[derive(Debug, serde::Serialize)]
pub struct CloseCheck { pub external: bool, pub other_clients: u32, pub busy_command: Option<String> }

const SHELLS: &[&str] = &["bash", "zsh", "sh", "fish", "dash"];
```
`impl SessionManager`：
```rust
    pub fn mark_pending_kill(&self, id: &str, now: i64) -> bool {
        let until = now + PENDING_KILL_MS;
        {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(id) else { return false };
            if s.tmux_origin.is_none() { return false; }
            s.pending_kill_until = Some(until);
        }
        let _ = self.store.set_pending_kill(id, Some(until));
        true
    }

    pub fn restore(&self, id: &str) -> bool {
        {
            let mut map = self.sessions.lock().unwrap();
            let Some(s) = map.get_mut(id) else { return false };
            if s.pending_kill_until.take().is_none() { return false; }
        }
        let _ = self.store.set_pending_kill(id, None);
        true
    }

    /// Explicit close path — the ONE place (with reconcile) that runs
    /// `tmux kill-session`. Deliberately not in Drop: detach / fan-out exit must
    /// never kill the user's tmux session.
    pub async fn finalize_pending_kill(&self, id: &str, now: i64) -> bool {
        let name = {
            let map = self.sessions.lock().unwrap();
            match map.get(id) {
                Some(s) if s.pending_kill_until.is_some_and(|t| t <= now) => match &s.resume_token {
                    Some(ResumeToken::Tmux(n)) => n.clone(),
                    _ => return false,
                },
                _ => return false,
            }
        };
        // Remove FIRST so the fan-out's exit check (T4/T15) finds no binding and
        // doesn't report this deliberate close as "ended elsewhere" / push it.
        let removed = self.remove_session(id);
        if let Err(e) = self.tmux.kill(&name).await {
            tracing::warn!("kill tmux {} for {} failed: {}", name, id, e);
        }
        removed
    }

    pub async fn reconcile_pending_kills(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().values()
            .filter(|s| s.pending_kill_until.is_some()).map(|s| s.id.clone()).collect();
        for id in ids {
            // Force due: the undo window died with the previous process.
            if let Some(s) = self.sessions.lock().unwrap().get_mut(&id) { s.pending_kill_until = Some(0); }
            self.finalize_pending_kill(&id, now_millis()).await;
        }
    }

    pub async fn close_check(&self, id: &str) -> Option<CloseCheck> {
        let (name, origin, running) = {
            let map = self.sessions.lock().unwrap();
            let s = map.get(id)?;
            match (&s.resume_token, s.tmux_origin) {
                (Some(ResumeToken::Tmux(n)), Some(o)) => (n.clone(), o, s.running.is_some()),
                _ => return None,
            }
        };
        let info = self.tmux.info(&name).await.ok();
        Some(CloseCheck {
            external: origin == TmuxOrigin::External,
            other_clients: info.as_ref().map(|i| i.attached.saturating_sub(running as u32)).unwrap_or(0),
            busy_command: info.map(|i| i.current_command).filter(|c| !SHELLS.contains(&c.as_str())),
        })
    }
```
`list_sessions` 的 `filter` 闭包加 `s.pending_kill_until.is_none() &&`。

- [ ] **Step 5: HTTP**

`delete_session` 改为：
```rust
async fn delete_session(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !user.is_admin() && !state.sessions.is_owner(&id, &user.id) {
        return Err(StatusCode::FORBIDDEN);
    }
    let now = crate::session_manager::now_millis();
    if state.sessions.mark_pending_kill(&id, now) {
        let sessions = state.sessions.clone();
        let logger = state.logger.clone();
        let sid = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(crate::session_manager::PENDING_KILL_MS as u64)).await;
            if sessions.finalize_pending_kill(&sid, crate::session_manager::now_millis()).await {
                if let Some(l) = logger { l.remove_session(&sid); }
            }
        });
        return Ok(Json(serde_json::json!({ "pending_until": now + crate::session_manager::PENDING_KILL_MS })));
    }
    if state.sessions.remove_session(&id) {
        if let Some(ref logger) = state.logger { logger.remove_session(&id); }
        Ok(Json(serde_json::json!({})))
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
```
在 `session_manager.rs` 把 `fn now_millis()`（约 265 行）改为 `pub fn now_millis()`。`Logger` 已 derive `Clone`，`state.logger.clone()` 可直接 move 进任务。

路由：
```rust
        .route("/api/sessions/{id}/restore", post(restore_session))
        .route("/api/sessions/{id}/close-check", get(close_check))
```
```rust
async fn restore_session(State(state): State<Arc<AppState>>, user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>) -> StatusCode {
    if !user.is_admin() && !state.sessions.is_owner(&id, &user.id) { return StatusCode::FORBIDDEN; }
    if state.sessions.restore(&id) { StatusCode::OK } else { StatusCode::GONE }
}

async fn close_check(State(state): State<Arc<AppState>>, user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>)
    -> Result<Json<Option<crate::session_manager::CloseCheck>>, StatusCode> {
    if !user.is_admin() && !state.sessions.is_owner(&id, &user.id) { return Err(StatusCode::FORBIDDEN); }
    Ok(Json(state.sessions.close_check(&id).await))
}
```
`src/main.rs` 在 `state.sessions.load_persisted();` 之后加 `state.sessions.reconcile_pending_kills().await;`。

Run: `cargo test 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: 全部 ok。

- [ ] **Step 6: 前端纯函数 + Toast（先测试）**

`frontend/src/lib/__tests__/closeSession.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { closeConfirmMessage } from '../closeSession'

describe('closeConfirmMessage', () => {
  it('own, alone, idle → no confirm', () => {
    expect(closeConfirmMessage('api', { external: false, other_clients: 0, busy_command: null })).toBeNull()
  })
  it('non-tmux (null check) → no confirm', () => {
    expect(closeConfirmMessage('x', null)).toBeNull()
  })
  it('other clients → names the count', () => {
    expect(closeConfirmMessage('vscode-dev', { external: false, other_clients: 1, busy_command: null }))
      .toBe('vscode-dev 正在 1 个其他终端中使用，关闭将终止整个 tmux 会话。')
  })
  it('external → warns it was not created here', () => {
    expect(closeConfirmMessage('ext', { external: true, other_clients: 0, busy_command: null }))
      .toContain('不是在 zeromux 中创建的')
  })
  it('busy command → names it', () => {
    expect(closeConfirmMessage('a', { external: false, other_clients: 0, busy_command: 'vim' }))
      .toContain('vim')
  })
})
```
`frontend/src/components/__tests__/Toast.test.tsx`：
```tsx
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Toast from '../Toast'

describe('Toast', () => {
  it('action fires and auto-dismisses after duration', () => {
    vi.useFakeTimers()
    const onAction = vi.fn(), onDone = vi.fn()
    render(<Toast message="已关闭 api" actionLabel="撤销" onAction={onAction} durationMs={5000} onDone={onDone} />)
    fireEvent.click(screen.getByText('撤销'))
    expect(onAction).toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('times out', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    render(<Toast message="m" durationMs={5000} onDone={onDone} />)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDone).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
```
Run: `cd frontend && npx vitest run src/lib/__tests__/closeSession.test.ts src/components/__tests__/Toast.test.tsx` → FAIL。

`frontend/src/lib/closeSession.ts`：
```ts
import type { CloseCheck } from './api'

// Graded confirm (user chose "X kills everything"): only interrupt when closing
// would surprise — another terminal is watching, the session wasn't made here,
// or something is running. Everything else closes immediately with a 5s undo.
export function closeConfirmMessage(name: string, c: CloseCheck | null): string | null {
  if (!c) return null
  if (c.other_clients > 0) return `${name} 正在 ${c.other_clients} 个其他终端中使用，关闭将终止整个 tmux 会话。`
  if (c.external) return `${name} 不是在 zeromux 中创建的，关闭将终止整个 tmux 会话。`
  if (c.busy_command) return `${name} 中 ${c.busy_command} 仍在运行，关闭将终止它。`
  return null
}
```
`frontend/src/components/Toast.tsx`：
```tsx
import { useEffect, useRef } from 'react'

interface Props {
  message: string
  actionLabel?: string
  onAction?: () => void
  durationMs: number
  onDone: () => void
}

export default function Toast({ message, actionLabel, onAction, durationMs, onDone }: Props) {
  const doneRef = useRef(false)
  const finish = () => { if (!doneRef.current) { doneRef.current = true; onDone() } }
  useEffect(() => {
    const t = setTimeout(finish, durationMs)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs])
  return (
    <div role="status" className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-lg shadow-lg bg-[var(--bg-tertiary)] text-xs text-[var(--text-primary)] border border-[var(--border)]">
      <span>{message}</span>
      {actionLabel && (
        <button className="font-medium text-[var(--accent-blue)]" onClick={() => { onAction?.(); finish() }}>{actionLabel}</button>
      )}
    </div>
  )
}
```
`api.ts`：
```ts
export interface CloseCheck { external: boolean; other_clients: number; busy_command: string | null }
export async function closeCheck(id: string): Promise<CloseCheck | null> {
  const res = await api(`/api/sessions/${id}/close-check`)
  if (!res.ok) return null
  return res.json()
}
export async function restoreSession(id: string): Promise<boolean> {
  const res = await api(`/api/sessions/${id}/restore`, { method: 'POST' })
  return res.ok
}
```
并把 `deleteSession` 改为：
```ts
export async function deleteSession(id: string): Promise<{ pending_until?: number }> {
  const res = await api(`/api/sessions/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new ApiError(res.status, 'deleteSession failed')
  return res.json().catch(() => ({}))
}
```

- [ ] **Step 7: App.tsx handleDelete**

```tsx
  const [undoToast, setUndoToast] = useState<{ id: string; name: string } | null>(null)

  const handleDelete = useCallback(async (id: string) => {
    const s = sessions.find(x => x.id === id)
    if (s?.tmux_name) {
      const msg = closeConfirmMessage(s.name, await closeCheck(id))
      if (msg && !window.confirm(msg)) return
    }
    const r = await deleteSession(id)
    setSessions(prev => {
      const next = prev.filter(x => x.id !== id)
      if (activeId === id) setActiveId(next[0]?.id ?? docTabs[0]?.id ?? null)
      return next
    })
    if (r.pending_until && s) setUndoToast({ id, name: s.name })
  }, [activeId, docTabs, sessions])
```
JSX（`</main>` 前）：
```tsx
        {undoToast && (
          <Toast
            key={undoToast.id}
            message={`已关闭 ${undoToast.name}`}
            actionLabel="撤销"
            durationMs={5000}
            onAction={async () => { if (await restoreSession(undoToast.id)) { await loadSessions(); setActiveId(undoToast.id) } }}
            onDone={() => setUndoToast(null)}
          />
        )}
```
补 import：`closeCheck, restoreSession` 来自 `./lib/api`，`closeConfirmMessage` 来自 `./lib/closeSession`，`Toast` 来自 `./components/Toast`。

Run: `cd frontend && npx tsc -b && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 8: CLAUDE.md**

在 "Cleanup is by Drop" 那条 bullet 下面加：
```markdown
- **Exception — tmux terminals:** since 2026-09 terminals are `zmx-<id8>` sessions on a tmux server owned by `zeromux-tmux.service` (default socket, so `tmux attach -t =zmx-…` works from VSCode). Dropping the PTY only *detaches*. `tmux kill-session` runs ONLY on the explicit close path (`DELETE` → 5s undo → `finalize_pending_kill`, plus `reconcile_pending_kills` at startup) — never put it in Drop. All tmux commands go through `src/tmux.rs` (`-N`, `=name`, 3s timeout); smoke tests must pass `--tmux-socket`.
```
在 "Deploying" 段落末尾加：
```markdown
`./deploy.sh` also installs/enables `zeromux-tmux.service` (idempotent, never restarts it). Restarting that unit kills every terminal — only do it when `/api/tmux/health` says the server is down or in the wrong cgroup.
```

- [ ] **Step 9: Commit**
```bash
git add src/ frontend/src CLAUDE.md
git commit -m "feat(tmux): X closes with server-side 5s undo, graded confirm, startup reconcile"
```

---

### Task 6: 回放改 refresh-client + xterm scrollback 10000

**Files:**
- Modify: `src/session_manager.rs`（tmux fan-out 不写 scrollback：新 `broadcast_pty`）
- Modify: `src/ws_handler.rs`（订阅后 refresh）
- Modify: `frontend/src/components/TerminalView.tsx:147`（`scrollback: 10000`）
- Test: `tmux_session_tests`

**Interfaces:**
- Consumes: T2 `refresh_client_for_pid`，T3 `tmux_binding`
- Produces: `fn broadcast_pty(&self, id: &str, data: String)`；`pub fn pty_pid(&self, id: &str) -> Option<u32>`

- [ ] **Step 1: 写失败测试**

```rust
    #[tokio::test]
    async fn tmux_output_is_not_kept_in_scrollback() {
        let Some(srv) = TestServer::start() else { return };
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("t".into(), "bash", "/tmp", 80, 24, "u", None).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(800)).await; // tmux paints the screen
        let (hist, _rx) = m.subscribe_with_history(&id).unwrap();
        assert!(hist.is_empty(), "tmux redraws on refresh-client; replaying 2MB of redraw bytes is noise");
        assert!(m.pty_pid(&id).is_some());
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux tmux_output_is_not_kept 2>&1 | tail -5`
Expected: FAIL（hist 非空）或编译失败（`pty_pid` 未定义）。

- [ ] **Step 3: 实现**

`impl SessionManager`：
```rust
    /// tmux terminals: live broadcast only. The tmux server holds the real
    /// history; on (re)connect we `refresh-client` instead of replaying bytes.
    fn broadcast_pty(&self, id: &str, data: String) {
        let map = self.sessions.lock().unwrap();
        if let Some(s) = map.get(id) {
            if let Some(rp) = &s.running { let _ = rp.event_tx.send(data); }
        }
    }

    pub fn pty_pid(&self, id: &str) -> Option<u32> {
        self.sessions.lock().unwrap().get(id)?.running.as_ref()?.pty_pid
    }
```
`spawn_tmux` 里：在 spawn 前 `let is_tmux = tmux_name.is_some();`，fan-out 的 output 分支改为：
```rust
                                if let Some(m) = mgr_weak.upgrade() {
                                    if is_tmux { m.broadcast_pty(&sid, b64); }
                                    else { m.record_and_broadcast(&sid, b64, true); }
                                } else {
```
（`is_tmux` 需 move 进 task；`last_activity_ms` 对 tmux 不再更新——PTY 会话从不进入 TurnState::Running，看门狗不受影响；侧栏"最近活动"对 tmux 改为在 `broadcast_pty` 里顺带 `s.last_activity_ms = now_millis()`：把 `map` 改为 `let mut map` + `get_mut`。）

`ws_handler.rs` 在 `subscribe_with_history` 之后加：
```rust
    // tmux terminals have no byte replay; ask tmux to repaint this client's
    // screen now that we're subscribed.
    if state.sessions.tmux_binding(&session_id).is_some() {
        if let Some(pid) = state.sessions.pty_pid(&session_id) {
            let tmux = state.tmux.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let _ = tmux.refresh_client_for_pid(pid).await;
            });
        }
    }
```

- [ ] **Step 4: xterm scrollback**

`TerminalView.tsx` 的 `new Terminal({...})` 加 `scrollback: 10000,`（旧裸 shell 会话受益；tmux 会话 xterm 缓冲只有一屏，历史由 T7/T8 提供）。

同时 tmux 会话不再有字节回放，去掉它的 replay 窗口（spec §3.8）：`ws.onopen` 里把
```tsx
        replayingRef.current = true
```
改为
```tsx
        // Only bare-shell PTYs replay scrollback; tmux repaints via refresh-client.
        replayingRef.current = !tmuxRef.current
```
（`tmuxRef` 在 T7 定义；本 Task 先在组件顶部加 `const tmuxRef = useRef(tmuxName); useEffect(() => { tmuxRef.current = tmuxName }, [tmuxName])`，T7 复用它、不要重复声明。）

- [ ] **Step 5: 测试 + Commit**

Run: `cargo test 2>&1 | grep -E "test result|FAILED|panicked"; cd frontend && npm test 2>&1 | tail -3`
Expected: 全部 ok。
```bash
git add src/ frontend/src/components/TerminalView.tsx
git commit -m "feat(tmux): no byte replay for tmux terminals, refresh-client on connect; xterm scrollback 10k"
```

---

### Task 7: 手势 → copy-mode（WS scroll、惯性、浮标、⤒⤓）

**Files:**
- Create: `frontend/src/lib/terminalScroll.ts`、Test: `frontend/src/lib/__tests__/terminalScroll.test.ts`
- Modify: `src/ws_handler.rs`（`ClientMsg::Scroll`；服务端回 `scroll_state`）
- Modify: `frontend/src/components/TerminalView.tsx`（触摸分支、浮标、发送前 cancel）
- Test: `src/ws_handler.rs` 无需新测（`ScrollOp::parse` 已在 T2 覆盖）

**Interfaces:**
- Consumes: T2 `TmuxCtl::scroll`, `ScrollOp::parse`；T3 `tmux_binding`；T4 `tmuxName` prop
- Produces:
  - WS 客户端消息 `{"type":"scroll","op":"up"|"down"|"top"|"bottom"|"cancel","n":number}`
  - WS 服务端消息 `{"type":"scroll_state","in_mode":bool,"history_size":number}`
  - `terminalScroll.ts`：`export type ScrollMsg = { op: 'up'|'down'|'top'|'bottom'|'cancel'; n: number }`；`export function dragToScroll(lines: number): ScrollMsg | null`；`export function inertiaLines(velocityPxPerMs: number, rh: number): number[]`；`export class ScrollBatcher { constructor(send: (m: ScrollMsg) => void, intervalMs?: number); add(lines: number): void; flush(): void; dispose(): void }`

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/__tests__/terminalScroll.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { dragToScroll, inertiaLines, ScrollBatcher } from '../terminalScroll'

describe('dragToScroll', () => {
  // linesFromDrag convention: finger moves UP → positive → newer content (scroll down).
  it('negative lines (finger down) → up into history', () => {
    expect(dragToScroll(-3)).toEqual({ op: 'up', n: 3 })
  })
  it('positive lines → down', () => {
    expect(dragToScroll(4)).toEqual({ op: 'down', n: 4 })
  })
  it('zero → nothing', () => {
    expect(dragToScroll(0)).toBeNull()
  })
})

describe('inertiaLines', () => {
  it('slow flick → no inertia', () => {
    expect(inertiaLines(0.1, 20)).toEqual([])
  })
  it('fast flick decays and keeps direction', () => {
    const steps = inertiaLines(-2, 20)
    expect(steps.length).toBeGreaterThan(2)
    expect(steps.every(s => s < 0)).toBe(true)
    expect(Math.abs(steps[0])).toBeGreaterThanOrEqual(Math.abs(steps[steps.length - 1]))
  })
})

describe('ScrollBatcher', () => {
  it('coalesces same-direction lines per interval and splits on direction change', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const b = new ScrollBatcher(send, 50)
    b.add(-1); b.add(-2)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledWith({ op: 'up', n: 3 })
    b.add(-1); b.add(2)          // direction change flushes the pending up first
    expect(send).toHaveBeenLastCalledWith({ op: 'up', n: 1 })
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenLastCalledWith({ op: 'down', n: 2 })
    b.dispose()
    vi.useRealTimers()
  })
})
```
Run: `cd frontend && npx vitest run src/lib/__tests__/terminalScroll.test.ts` → FAIL。

- [ ] **Step 2: 实现 `terminalScroll.ts`**

```ts
// Touch drag → tmux copy-mode scroll ops (sent over the terminal WS; the server
// runs the tmux commands). Pure helpers + a tiny batcher so a fast drag becomes
// one message per interval instead of one per touchmove.

export type ScrollMsg = { op: 'up' | 'down' | 'top' | 'bottom' | 'cancel'; n: number }

/** `lines` uses linesFromDrag's sign: positive = newer content (down). */
export function dragToScroll(lines: number): ScrollMsg | null {
  if (lines === 0) return null
  return lines < 0 ? { op: 'up', n: -lines } : { op: 'down', n: lines }
}

const MIN_FLICK = 0.5    // px/ms below which there is no inertia
const DECAY = 0.85       // per step
const STEP_MS = 16

/** Signed line deltas for a decaying flick; empty for slow releases. */
export function inertiaLines(velocityPxPerMs: number, rh: number): number[] {
  if (Math.abs(velocityPxPerMs) < MIN_FLICK || rh <= 0) return []
  const out: number[] = []
  let v = velocityPxPerMs
  let carry = 0
  while (Math.abs(v) >= MIN_FLICK / 2 && out.length < 120) {
    carry += (v * STEP_MS) / rh
    const whole = carry < 0 ? Math.ceil(carry) : Math.floor(carry)
    if (whole !== 0) { out.push(whole); carry -= whole }
    v *= DECAY
  }
  return out
}

export class ScrollBatcher {
  private pending = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private send: (m: ScrollMsg) => void, private intervalMs = 50) {}

  add(lines: number) {
    if (lines === 0) return
    if (this.pending !== 0 && Math.sign(lines) !== Math.sign(this.pending)) this.flush()
    this.pending += lines
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const m = dragToScroll(this.pending)
    this.pending = 0
    if (m) this.send(m)
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = 0
  }
}
```
Run: `cd frontend && npx vitest run src/lib/__tests__/terminalScroll.test.ts`
Expected: 6 passed。

- [ ] **Step 3: 后端 WS 消息**

`ClientMsg` 加：
```rust
    #[serde(rename = "scroll")]
    Scroll { op: String, #[serde(default)] n: u32 },
```
select 循环的 Text 分支里 match 加：
```rust
                                ClientMsg::Scroll { op, n } => {
                                    if let (Some((name, _)), Some(op)) =
                                        (state.sessions.tmux_binding(&session_id), crate::tmux::ScrollOp::parse(&op, n))
                                    {
                                        if let Ok(info) = state.tmux.scroll(&name, op).await {
                                            let m = serde_json::json!({"type": "scroll_state", "in_mode": info.in_mode, "history_size": info.history_size});
                                            if ws_sink.send(Message::Text(m.to_string().into())).await.is_err() { break; }
                                        }
                                    }
                                }
```
（`handle_ws` 的 `state` 在此作用域内可用：它是参数 `state: Arc<AppState>`。）

Run: `cargo build 2>&1 | grep -E "^error" | head`
Expected: 无输出。

- [ ] **Step 4: TerminalView 接线**

1. state/ref：
```tsx
  const [scrolling, setScrolling] = useState(false)
  const scrollingRef = useRef(false)
  // (tmuxRef already declared in T6.)
  const sendScroll = useCallback((m: ScrollMsg) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'scroll', ...m }))
    if (m.op === 'up' || m.op === 'top') { scrollingRef.current = true; setScrolling(true) }
  }, [])
  // Leave copy-mode before any keystroke so input isn't swallowed by tmux.
  const exitScroll = useCallback(() => {
    if (!scrollingRef.current) return
    scrollingRef.current = false
    setScrolling(false)
    sendScroll({ op: 'cancel', n: 1 })
  }, [sendScroll])
```
2. `ws.onmessage` 加：
```tsx
          if (msg.type === 'scroll_state') {
            scrollingRef.current = !!msg.in_mode
            setScrolling(!!msg.in_mode)
            return
          }
```
3. 触摸处理（init effect 内）：创建 `const batcher = new ScrollBatcher(m => sendScrollRef.current(m))`（`sendScrollRef` 为指向 `sendScroll` 的 ref，避免 effect 依赖），记录 `let lastY = 0, lastT = 0, vel = 0`。`onTouchMove` 里在算出 `lines` 之后：
```tsx
      if (lines !== 0) {
        if (tmuxRef.current) batcher.add(lines)
        else term.scrollLines(lines)
        startY = t.clientY
      }
      const now = performance.now()
      if (lastT) vel = (lastY - t.clientY) / Math.max(1, now - lastT)
      lastY = t.clientY; lastT = now
```
`onTouchEnd`：
```tsx
    const onTouchEnd = () => {
      touchId = null
      if (tmuxRef.current) {
        batcher.flush()
        const rh = rowHeight(term.element?.clientHeight ?? 0, term.rows, FONT_SIZE)
        inertiaLines(vel, rh).forEach((l, i) => setTimeout(() => batcher.add(l), i * 16))
      }
      vel = 0; lastT = 0
    }
```
cleanup 里 `batcher.dispose()`。`onTouchStart` 里 `lastY = e.touches[0].clientY; lastT = performance.now(); vel = 0`。
4. `sendInput` 开头加 `exitScroll()`（`sendInput` 的 useCallback 依赖加 `exitScroll`）。`handleBarKey` 与 `sendComposer` 都经 `sendInput`，自动覆盖。
5. 浮标（`xterm-container` 同级，外层 div 已 `relative`）：
```tsx
      {tmuxName && scrolling && (
        <div className="absolute right-3 bottom-28 z-10 flex gap-1 text-xs">
          <button aria-label="scroll-top" onPointerDown={e => { e.preventDefault(); sendScroll({ op: 'top', n: 1 }) }}
            className="px-2 py-1.5 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border)] shadow">⤒顶</button>
          <button aria-label="scroll-bottom" onPointerDown={e => { e.preventDefault(); exitScroll() }}
            className="px-3 py-1.5 rounded-full bg-[var(--accent-blue)] text-white shadow">⏸ 已暂停跟随 · ⤓</button>
        </div>
      )}
```
（`bottom-28` 让出 KeyBar+Composer；桌面无 KeyBar 时同样可见，无害。）import `ScrollBatcher, inertiaLines, type ScrollMsg` from `../lib/terminalScroll`。

Run: `cd frontend && npx tsc -b && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 5: 冒烟（隔离）**

```bash
tmux -L zmx-smoke -f "$(mktemp)" new-session -d -s boot && tmux -L zmx-smoke set -g exit-empty off
cargo build && ./target/debug/zeromux --port 18090 --password smoke --data-dir /tmp/zmx-smoke --tmux-socket zmx-smoke --work-dir /tmp &
```
浏览器开 `http://<host>:18090`，新建终端 → `seq 1 3000` → 手机或 devtools 触摸模拟上滑：出现浮标，内容回到更早行；⤒ 到 `1`；⤓ 回到实时；输入字符正常。验完 `kill %1; tmux -L zmx-smoke kill-server; rm -rf /tmp/zmx-smoke`。

- [ ] **Step 6: Commit**
```bash
git add src/ws_handler.rs frontend/src
git commit -m "feat(term): touch drag drives tmux copy-mode with inertia, follow-paused pill, top/bottom"
```

---

### Task 8: 历史视图（最小版）+ 重连提示

**Files:**
- Modify: `src/web.rs`（`GET /api/sessions/{id}/history`）
- Create: `frontend/src/components/HistoryView.tsx`、Test: `frontend/src/components/__tests__/HistoryView.test.tsx`
- Modify: `frontend/src/lib/api.ts`、`frontend/src/components/MobileKeyBar.tsx`（`onHistory`）、`frontend/src/components/TerminalView.tsx`、`frontend/src/components/TerminalNotices.tsx`（`ReconnectHint`）
- Test: `frontend/src/components/__tests__/MobileKeyBar.test.tsx`

**Interfaces:**
- Consumes: T2 `capture`，T3 `tmux_binding`
- Produces:
  - HTTP `GET /api/sessions/{id}/history?ansi=0|1` → `{ text, truncated }`（ansi 在 T12 生效；本 Task 忽略）
  - 前端 `getHistory(id: string, ansi?: boolean): Promise<{ text: string; truncated: boolean }>`
  - `HistoryView({ sessionId, title, onClose })`；导出 `export function chunkLines(text: string, size: number): string[]`
  - `MobileKeyBar` 新可选 prop `onHistory?: () => void`（存在时最左渲染 `aria-label="history"` 的 📜 键）
  - `ReconnectHint({ onOpenHistory, onDone })`

- [ ] **Step 1: 后端 API**

```rust
#[derive(serde::Deserialize)]
struct HistoryQuery { #[serde(default)] ansi: u8 }

async fn session_history(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Query(_q): Query<HistoryQuery>,
) -> Result<Json<crate::tmux::Captured>, (StatusCode, String)> {
    if !user.is_admin() && !state.sessions.is_owner(&id, &user.id) {
        return Err((StatusCode::FORBIDDEN, "forbidden".into()));
    }
    // Target comes ONLY from the stored binding — never from the request.
    let (name, _) = state.sessions.tmux_binding(&id)
        .ok_or((StatusCode::BAD_REQUEST, "not a tmux terminal".into()))?;
    state.tmux.capture(&name, 50_000, 5 * 1024 * 1024).await
        .map(Json)
        .map_err(|e| (StatusCode::SERVICE_UNAVAILABLE, e.to_string()))
}
```
路由 `.route("/api/sessions/{id}/history", get(session_history))`。

Run: `cargo build 2>&1 | grep -E "^error" | head`
Expected: 无输出。

- [ ] **Step 2: 前端测试（先写）**

`HistoryView.test.tsx`：
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import HistoryView, { chunkLines } from '../HistoryView'
import * as api from '../../lib/api'

describe('chunkLines', () => {
  it('splits into fixed-size line blocks', () => {
    const text = Array.from({ length: 1201 }, (_, i) => `${i + 1}`).join('\n')
    const c = chunkLines(text, 500)
    expect(c.length).toBe(3)
    expect(c[0].split('\n').length).toBe(500)
    expect(c[2].split('\n')[0]).toBe('1001')
    expect(c[2].split('\n').length).toBe(201)
  })
})

describe('HistoryView', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  it('loads history, shows truncation note, copy-all and close', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'line-1\nline-2', truncated: true })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const onClose = vi.fn()
    render(<HistoryView sessionId="s" title="api" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/line-2/)).toBeInTheDocument())
    expect(screen.getByText(/仅显示最近/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('复制全部'))
    expect(writeText).toHaveBeenCalledWith('line-1\nline-2')
    fireEvent.click(screen.getByLabelText('关闭历史'))
    expect(onClose).toHaveBeenCalled()
  })
  it('shows error text when fetch fails', async () => {
    vi.spyOn(api, 'getHistory').mockRejectedValue(new Error('tmux 服务未运行'))
    render(<HistoryView sessionId="s" title="api" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/tmux 服务未运行/)).toBeInTheDocument())
  })
})
```

`MobileKeyBar.test.tsx` 追加：
```tsx
  it('history key only when onHistory given', () => {
    const { rerender } = render(<MobileKeyBar onKey={() => {}} />)
    expect(screen.queryByLabelText('history')).toBeNull()
    const onHistory = vi.fn()
    rerender(<MobileKeyBar onKey={() => {}} onHistory={onHistory} />)
    fireEvent.pointerDown(screen.getByLabelText('history'))
    expect(onHistory).toHaveBeenCalled()
  })
```
Run: `cd frontend && npx vitest run src/components/__tests__/HistoryView.test.tsx src/components/__tests__/MobileKeyBar.test.tsx` → FAIL。

- [ ] **Step 3: 实现**

`api.ts`：
```ts
export async function getHistory(id: string, ansi = false): Promise<{ text: string; truncated: boolean }> {
  const res = await api(`/api/sessions/${id}/history?ansi=${ansi ? 1 : 0}`)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
```
`HistoryView.tsx`：
```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getHistory } from '../lib/api'

const CHUNK = 500

export function chunkLines(text: string, size: number): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size).join('\n'))
  return out
}

interface Props { sessionId: string; title: string; onClose: () => void }

// Full tmux history as native, scrollable, long-press-selectable text. Blocks of
// 500 lines with content-visibility keep 50k lines smooth on phones.
export default function HistoryView({ sessionId, title, onClose }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(document.activeElement as HTMLElement | null)?.blur?.()   // drop the soft keyboard
    getHistory(sessionId)
      .then(r => { if (!cancelled) { setText(r.text); setTruncated(r.truncated) } })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)) })
    return () => { cancelled = true }
  }, [sessionId])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && text !== null) el.scrollTop = el.scrollHeight
  }, [text])

  const toTop = () => { if (scrollRef.current) scrollRef.current.scrollTop = 0 }
  const toBottom = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight }
  const btn = 'px-2.5 py-1.5 rounded border border-[var(--border)] text-xs text-[var(--text-secondary)] active:bg-[var(--bg-hover)]'

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[var(--bg-primary)]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] text-xs">
        <span className="flex-1 truncate font-medium text-[var(--text-primary)]">历史 · {title}</span>
        <button aria-label="关闭历史" onClick={onClose} className="px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]">✕</button>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain select-text" style={{ touchAction: 'pan-y', WebkitUserSelect: 'text' }}>
        {truncated && <div className="px-3 py-1 text-[10px] text-[var(--text-muted)]">仅显示最近 5MB</div>}
        {error && <div className="px-3 py-2 text-xs text-[var(--accent-red)]">{error}</div>}
        {text === null && !error && <div className="px-3 py-2 text-xs text-[var(--text-muted)]">Loading...</div>}
        {text !== null && chunkLines(text, CHUNK).map((c, i) => (
          <pre key={i} className="px-3 m-0 text-[12px] leading-[1.35] font-mono whitespace-pre-wrap break-all text-[var(--text-primary)]"
            style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${CHUNK * 16}px` }}>{c}</pre>
        ))}
      </div>
      <div className="flex gap-2 px-3 py-2 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        <button className={btn} onClick={toTop}>⤒ 首行</button>
        <button className={btn} onClick={toBottom}>⤓ 底部</button>
        <button className={btn} onClick={() => text !== null && navigator.clipboard?.writeText(text)}>复制全部</button>
      </div>
    </div>
  )
}
```
`MobileKeyBar.tsx`：签名改 `({ onKey, onHistory }: { onKey: (key: BarKey) => void; onHistory?: () => void })`，在容器第一个子元素处：
```tsx
      {onHistory && (
        <button aria-label="history" onPointerDown={(e) => { e.preventDefault(); onHistory() }}
          style={{ touchAction: 'manipulation' }} className={`${btnCls} text-base`}>📜</button>
      )}
```
`TerminalNotices.tsx` 追加：
```tsx
import { useEffect } from 'react'

export function ReconnectHint({ onOpenHistory, onDone }: { onOpenHistory: () => void; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t) }, [onDone])
  return (
    <div role="status" className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full text-xs bg-[var(--bg-tertiary)]/90 text-[var(--text-secondary)] border border-[var(--border)]">
      已重连 · 历史保留在 tmux 中 <button className="text-[var(--accent-blue)]" onClick={onOpenHistory}>查看历史</button>
    </div>
  )
}
```
（`import { useEffect }` 放到文件顶部 import 区。）

TerminalView：
```tsx
  const [historyOpen, setHistoryOpen] = useState(false)
  const [reconnected, setReconnected] = useState(false)
  const openedOnceRef = useRef(false)
```
`ws.onopen` 末尾：`if (openedOnceRef.current && tmuxRef.current) setReconnected(true); openedOnceRef.current = true`。
JSX：`{isTouch && <MobileKeyBar onKey={handleBarKey} onHistory={tmuxName ? () => setHistoryOpen(true) : undefined} />}`；状态栏在 git 信息之后、仅 `!isTouch && tmuxName` 时加 `<button onClick={() => setHistoryOpen(true)} className="ml-auto text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">历史</button>`；
```tsx
      {reconnected && <ReconnectHint onOpenHistory={() => { setReconnected(false); setHistoryOpen(true) }} onDone={() => setReconnected(false)} />}
      {historyOpen && <HistoryView sessionId={sessionId} title={tmuxName ?? ''} onClose={() => setHistoryOpen(false)} />}
```
（`onDone` 用 `useCallback` 包一层避免 3s 定时器被每次渲染重置：`const hideReconnect = useCallback(() => setReconnected(false), [])`。）历史抽屉打开时隐藏 KeyBar 与 Composer：两处 `{isTouch && ...}` 改为 `{isTouch && !historyOpen && ...}`。

Run: `cd frontend && npx tsc -b && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 4: Commit**
```bash
git add src/web.rs frontend/src
git commit -m "feat(term): tmux history drawer (capture-pane) + 📜 key + reconnect hint"
```

- [ ] **Step 5: P1 里程碑部署与验收**

1. `git push`（在 zeromux 终端里执行时必须先 push，见 Global Constraints）。
2. `./deploy.sh --build`。首次会安装并启动 `zeromux-tmux.service`。
3. 验收：
   - S1：新建终端 → `tmux ls` 可见 `zmx-xxxx` → 再 `./deploy.sh` → 刷新浏览器回到同一 shell（`echo $$` 前后一致）。
   - S2：VSCode 终端 `tmux attach -t =zmx-xxxx` → 两端互相可见输入。
   - S3：手机 `seq 1 5000` → 上滑有浮标、⤒ 到首行；📜 打开 ≤2s、能长按复制。
   - S5：点 X → toast → 撤销恢复；再 X 等 5s → `tmux ls` 中消失。
   - S6：VSCode 里 `tmux kill-session -t =<外部会话>` → zeromux 显示「已在其他终端结束」。
   - `curl -s -u … /api/tmux/health` 或 UI 无告警条（`in_unit: true`）。
4. 验收不过则停在此处修复，不进入 T9。

---

### Task 9: 新建流程简化 + 「本机 tmux」分组 + 搜索纳入 + 孤儿收养

**Files:**
- Modify: `src/session_manager.rs`（`tracked_tmux_names`）
- Modify: `src/web.rs`（`list_sessions` 附带 `host_tmux`，5s TTL 缓存；create_session 对 `zmx-*` 目标标 Own）
- Modify: `src/main.rs`（AppState 加缓存字段）
- Modify: `frontend/src/lib/api.ts`（`listSessionsWithHost`）、`frontend/src/App.tsx`、`frontend/src/components/Sidebar.tsx`
- Create: `frontend/src/lib/hostTmux.ts`、Test: `frontend/src/lib/__tests__/hostTmux.test.ts`
- Test: `frontend/src/components/__tests__/Sidebar.newflow.test.tsx`

**Interfaces:**
- Consumes: T2 `TmuxCtl::list`, `HostTmux`；T3 `tmux_binding`/`create_pty_session`
- Produces:
  - `pub fn tracked_tmux_names(&self) -> std::collections::HashSet<String>`（含 pending_kill 的会话，避免关闭窗口里它重新冒出来）
  - `AppState.host_tmux_cache: tokio::sync::Mutex<Option<(std::time::Instant, Vec<crate::tmux::HostTmux>)>>`
  - `GET /api/sessions` → `{ sessions, host_tmux: HostTmux[] }`（非 admin 时 `host_tmux: []`）
  - 前端 `export interface HostTmux { name: string; windows: number; attached: number; created: number; path: string }`；`listSessionsWithHost(): Promise<{ sessions: SessionInfo[]; host_tmux: HostTmux[] }>`（`listSessions` 保持原签名，内部复用）
  - `hostTmux.ts`：`export function isOrphan(h: HostTmux): boolean`（`zmx-` 前缀）；`export function matchHostTmux(list: HostTmux[], q: string): HostTmux[]`
  - Sidebar 新 prop `hostTmux?: HostTmux[]`；`onCreate('tmux', undefined, name)` 继续作为 attach 入口

- [ ] **Step 1: 纯函数测试（先写）**

`frontend/src/lib/__tests__/hostTmux.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { isOrphan, matchHostTmux } from '../hostTmux'

const h = (name: string, path = '/home/ubuntu') => ({ name, windows: 1, attached: 0, created: 0, path })

describe('hostTmux', () => {
  it('zmx- prefix marks zeromux leftovers', () => {
    expect(isOrphan(h('zmx-3f2a9c1e'))).toBe(true)
    expect(isOrphan(h('vscode-dev'))).toBe(false)
  })
  it('matches by name or path, case-insensitive; empty query → none', () => {
    const list = [h('vscode-dev', '/home/ubuntu/api'), h('build', '/srv/Web')]
    expect(matchHostTmux(list, 'VSC').map(x => x.name)).toEqual(['vscode-dev'])
    expect(matchHostTmux(list, 'web').map(x => x.name)).toEqual(['build'])
    expect(matchHostTmux(list, '  ')).toEqual([])
  })
})
```
Run: `cd frontend && npx vitest run src/lib/__tests__/hostTmux.test.ts` → FAIL。

`frontend/src/lib/hostTmux.ts`：
```ts
import type { HostTmux } from './api'

/** A `zmx-*` tmux session with no zeromux session: left over (e.g. DB reset). */
export function isOrphan(h: HostTmux): boolean {
  return h.name.startsWith('zmx-')
}

export function matchHostTmux(list: HostTmux[], q: string): HostTmux[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  return list.filter(h => h.name.toLowerCase().includes(needle) || h.path.toLowerCase().includes(needle))
}
```
`api.ts`：
```ts
export interface HostTmux { name: string; windows: number; attached: number; created: number; path: string }

export async function listSessionsWithHost(): Promise<{ sessions: SessionInfo[]; host_tmux: HostTmux[] }> {
  const res = await api('/api/sessions')
  if (!res.ok) throw new ApiError(res.status, 'listSessions failed')
  const data = await res.json()
  return { sessions: data.sessions || [], host_tmux: data.host_tmux || [] }
}
```
并把 `listSessions` 改为 `return (await listSessionsWithHost()).sessions`。`TmuxSession` 接口保留（`listTmuxSessions` 在本 Task 后无人使用——删除 `listTmuxSessions` 与 `TmuxSession`，因为是本 Task 让它们变得无用）。

Run: `cd frontend && npx vitest run src/lib/__tests__/hostTmux.test.ts`
Expected: 2 passed。

- [ ] **Step 2: 后端**

`session_manager.rs`：
```rust
    pub fn tracked_tmux_names(&self) -> std::collections::HashSet<String> {
        self.sessions.lock().unwrap().values().filter_map(|s| match (&s.resume_token, s.tmux_origin) {
            (Some(ResumeToken::Tmux(n)), Some(_)) => Some(n.clone()),
            _ => None,
        }).collect()
    }
```
`main.rs` AppState 加 `pub host_tmux_cache: tokio::sync::Mutex<Option<(std::time::Instant, Vec<tmux::HostTmux>)>>,`，构造 `host_tmux_cache: tokio::sync::Mutex::new(None),`。
`web.rs` `list_sessions`：
```rust
async fn list_sessions(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Json<serde_json::Value> {
    let filter = if user.is_admin() { None } else { Some(user.id.as_str()) };
    let sessions = state.sessions.list_sessions(filter);
    // Host tmux sessions are shared OS state → admin only (same gate as attach).
    let host_tmux = if user.is_admin() { host_tmux_untracked(&state).await } else { vec![] };
    Json(serde_json::json!({ "sessions": sessions, "host_tmux": host_tmux }))
}

/// `tmux ls` minus sessions zeromux already tracks. Cached 5s: the sidebar polls
/// every 3s from every open tab.
async fn host_tmux_untracked(state: &AppState) -> Vec<crate::tmux::HostTmux> {
    let mut cache = state.host_tmux_cache.lock().await;
    let fresh = matches!(&*cache, Some((t, _)) if t.elapsed() < std::time::Duration::from_secs(5));
    if !fresh {
        let list = state.tmux.list().await.unwrap_or_default();
        *cache = Some((std::time::Instant::now(), list));
    }
    let tracked = state.sessions.tracked_tmux_names();
    cache.as_ref().map(|(_, l)| l.iter().filter(|h| !tracked.contains(&h.name)).cloned().collect()).unwrap_or_default()
}
```
`create_session` attach 分支：`create_pty_session` 已按 `tmux_target.is_some()` 标 External。收养孤儿需标 Own：在 `session_manager::create_pty_session` 里把 origin 计算改为
```rust
        let (tmux_name, origin) = match tmux_target {
            // Adopting a zeromux leftover: it's ours, recreate-on-loss semantics apply.
            Some(t) if t.starts_with("zmx-") => (t.to_string(), TmuxOrigin::Own),
            Some(t) => (t.to_string(), TmuxOrigin::External),
            None => (crate::tmux::tmux_name_for(&id), TmuxOrigin::Own),
        };
```
并在 `tmux_session_tests` 加：
```rust
    #[tokio::test]
    async fn adopting_zmx_orphan_is_own_and_tracked() {
        let Some(srv) = TestServer::start() else { return };
        srv.ctl.run(&["new-session", "-d", "-s", "zmx-deadbeef"]).await.unwrap();
        let (m, _d) = mgr_with(srv.ctl.clone());
        let id = m.create_pty_session("o".into(), "bash", "/tmp", 80, 24, "u", Some("zmx-deadbeef")).await.unwrap();
        assert_eq!(m.tmux_binding(&id).unwrap().1, TmuxOrigin::Own);
        assert!(m.tracked_tmux_names().contains("zmx-deadbeef"));
    }
```
Run: `cargo test 2>&1 | grep -E "test result|FAILED|panicked"`
Expected: 全部 ok。

- [ ] **Step 3: Sidebar 新流程测试（先写）**

`frontend/src/components/__tests__/Sidebar.newflow.test.tsx`（复用 `Sidebar.search.test.tsx` 的 setup 模式）：
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Sidebar from '../Sidebar'
import * as api from '../../lib/api'

function setup(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const onCreate = vi.fn()
  const props = {
    sessions: [], docTabs: [], activeId: null, onSelect: vi.fn(), onCreate, onOpenVault: vi.fn(),
    onDelete: vi.fn(), onRename: vi.fn(), hasUnread: () => false, onLogout: vi.fn(),
    theme: 'dark' as const, onToggleTheme: vi.fn(),
    user: { id: 'u', login: 'u', avatar: null, role: 'admin', status: 'active' } as api.UserInfo,
    open: true, onToggle: vi.fn(), mobile: false, hostTmux: [], ...over,
  }
  render(<Sidebar {...props} />)
  return { onCreate }
}

describe('Sidebar new terminal flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, 'getSchedulerHealth').mockResolvedValue({ heartbeat_ms: 1, healthy: true })
    vi.spyOn(api, 'getVaultMeta').mockResolvedValue({ enabled: false, name: '' })
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({ top: [] })
    vi.spyOn(api, 'listPrompts').mockResolvedValue([])
    vi.spyOn(api, 'listDirectories').mockResolvedValue({ current: '/home/u', parent: null, home: '/home/u', entries: [] })
  })

  it('Terminal goes straight to the directory picker (no New Shell / Attach step)', async () => {
    setup()
    fireEvent.click(screen.getByText('New session'))
    fireEvent.click(await screen.findByText('其他目录…'))
    fireEvent.click(screen.getByText('Terminal', { selector: 'div' }))
    expect(screen.queryByText('New Shell')).toBeNull()
    expect(screen.queryByText('Attach tmux')).toBeNull()
    await waitFor(() => expect(api.listDirectories).toHaveBeenCalled())
  })

  it('host tmux group lists untracked sessions and attaches on click', () => {
    const { onCreate } = setup({ hostTmux: [
      { name: 'vscode-dev', windows: 3, attached: 1, created: 0, path: '/w' },
      { name: 'zmx-deadbeef', windows: 1, attached: 0, created: 0, path: '/w' },
    ] })
    expect(screen.getByText('本机 tmux')).toBeInTheDocument()
    expect(screen.getByText('3 win · 🖥1')).toBeInTheDocument()
    expect(screen.getByText('zeromux 遗留')).toBeInTheDocument()
    fireEvent.click(screen.getByText('vscode-dev'))
    expect(onCreate).toHaveBeenCalledWith('tmux', undefined, 'vscode-dev')
  })

  it('no host group for non-admin or empty list', () => {
    setup({ hostTmux: [] })
    expect(screen.queryByText('本机 tmux')).toBeNull()
  })
})
```
（「其他目录…」是 quick 首屏进入类型列表的按钮，见 `Sidebar.tsx` 约 655 行。）

Run: `cd frontend && npx vitest run src/components/__tests__/Sidebar.newflow.test.tsx` → FAIL。

- [ ] **Step 4: Sidebar 实现**

1. `NewSessionStep` 去掉 `'pick-terminal-mode' | 'pick-tmux'`；删除 `tmuxSessions`/`tmuxLoading` state、`loadTmuxSessions`、`selectNewShell`、`selectAttachTmux`、`attachTmuxSession`，以及 JSX 里 `step === 'pick-terminal-mode'` 与 `step === 'pick-tmux'` 两整块；删除因此无用的 import（`MonitorUp`、`Link`、`listTmuxSessions`、`TmuxSession`——以 `npm run lint` 报告为准）。
2. `selectType`：
```tsx
  const selectType = (type: SessionType) => {
    setPendingType(type)
    if (type === 'tmux') {
      // Terminals are always tmux now: dir fixed by a quick card/search → create;
      // otherwise pick a dir. (Attaching existing tmux lives in the session list.)
      if (pendingDir) { onCreate('tmux', pendingDir); closeAfterCreate(); return }
      setStep('pick-dir')
      loadDirs()
    } else if (pendingDir && pendingSkipPrompt) {
```
（其余分支原样保留。）Terminal 按钮副标题改为 `持久 tmux 会话，可在 VSCode 接续`。pick-dir 的 Back 按钮原先 `setStep('pick-type')` 保持不变。
3. Props 加 `hostTmux?: HostTmux[]`，解构默认 `hostTmux = []`。在 sessions 列表 `docTabs.map` 之后插入分组：
```tsx
        {hostTmux.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">本机 tmux</div>
            {hostTmux.map(h => (
              <button
                key={h.name}
                onClick={() => onCreate('tmux', undefined, h.name)}
                title={`${h.path}\n点击接入`}
                className="flex items-center gap-2 w-[calc(100%-0.5rem)] px-3 py-1.5 mx-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                <span className="w-2 h-2 rounded-full border border-[var(--text-muted)] shrink-0" />
                <span className="truncate">{h.name}</span>
                {isOrphan(h) && <span className="text-[10px] text-[var(--accent-yellow)] shrink-0">zeromux 遗留</span>}
                <span className="ml-auto text-[10px] text-[var(--text-muted)] shrink-0">{h.windows} win{h.attached > 0 ? ` · 🖥${h.attached}` : ''}</span>
              </button>
            ))}
          </>
        )}
```
4. 搜索结果：在渲染 `SearchResults` 的位置上方（`step === 'quick'` 且有 query 时），加：
```tsx
                  {matchHostTmux(hostTmux, query).map(h => (
                    <button key={`tmux-${h.name}`} onClick={() => { onCreate('tmux', undefined, h.name); closeAfterCreate() }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                      <Terminal size={13} className="text-[var(--accent-green-text)] shrink-0" />
                      <span className="truncate">接入 tmux：{h.name}</span>
                      <span className="ml-auto text-[10px] text-[var(--text-muted)] truncate">{h.path}</span>
                    </button>
                  ))}
```
import `isOrphan, matchHostTmux` from `../lib/hostTmux`，`type HostTmux` from `../lib/api`。

- [ ] **Step 5: App 接线**

App.tsx：`const [hostTmux, setHostTmux] = useState<HostTmux[]>([])`；`loadSessions` 与 3s poll 中把 `listSessions()` 换成 `listSessionsWithHost()`，分别 `setSessions(r.sessions)`、`setHostTmux(r.host_tmux)`（`resolveActivePane` 用 `r.sessions`）；`<Sidebar hostTmux={hostTmux} ... />`。`handleCreate` 创建 attach 会话后立即 `setHostTmux(prev => prev.filter(h => h.name !== tmuxTarget))`，避免下一次 poll 前重复显示。

Run: `cd frontend && npx tsc -b && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: 通过（含 `Sidebar.search.test.tsx` 旧用例——若其中有断言 `pick-terminal-mode` 行为的用例，按新流程更新期望：Terminal → 直接目录/直接创建）。

- [ ] **Step 6: Commit**
```bash
git add src/ frontend/src
git commit -m "feat(sidebar): one-step tmux terminal; host tmux group + search; adopt zmx orphans"
```

---

### Task 10: 接续命令 chip、`⋯` 菜单、触屏常显、「VSCode 也在看」

**Files:**
- Create: `frontend/src/lib/attachCommand.ts`、Test: `frontend/src/lib/__tests__/attachCommand.test.ts`
- Create: `frontend/src/components/SessionRowMenu.tsx`、Test: `frontend/src/components/__tests__/SessionRowMenu.test.tsx`
- Modify: `src/session_manager.rs`（`SessionInfo.other_clients`，由 web 层填）、`src/web.rs`（list 时填）
- Modify: `frontend/src/components/Sidebar.tsx`（X → ⋯）、`frontend/src/components/TerminalView.tsx`（状态栏 chip）、`frontend/src/lib/api.ts`
- Test: 同上

**Interfaces:**
- Consumes: T3 `SessionInfo.tmux_name`；T9 host cache（`HostTmux.attached`）；T5 `onDelete` 流程；T8 `setHistoryOpen`
- Produces:
  - `SessionInfo.other_clients: u32`（tmux 会话：`attached - (running?1:0)`，来自 host 缓存全表；非 tmux 为 0）
  - `attachCommand.ts`：`export function attachCommand(name: string): string` → ``tmux attach -t '=<name>'``（名字含单引号时转义为 `'\''`）
  - `SessionRowMenu({ session, onRename, onClose, onHistory? })`：`⋯` 按钮 + 弹出菜单（复制接续命令 / 重命名 / 查看历史 / 关闭）
  - `copyText(text: string): Promise<boolean>`（放 `attachCommand.ts`，clipboard 失败回退 `document.execCommand('copy')`）

- [ ] **Step 1: 纯函数测试（先写）**

```ts
import { describe, it, expect } from 'vitest'
import { attachCommand } from '../attachCommand'

describe('attachCommand', () => {
  it('exact-match target, quoted', () => {
    expect(attachCommand('zmx-3f2a9c1e')).toBe("tmux attach -t '=zmx-3f2a9c1e'")
  })
  it('escapes single quotes', () => {
    expect(attachCommand("a'b")).toBe("tmux attach -t '=a'\\''b'")
  })
})
```
Run → FAIL。实现 `frontend/src/lib/attachCommand.ts`：
```ts
// `=` forces tmux exact match (plain -t prefix-matches: `zmx-ab` → `zmx-abc`).
export function attachCommand(name: string): string {
  return `tmux attach -t '=${name.replace(/'/g, `'\\''`)}'`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
```
Run: `cd frontend && npx vitest run src/lib/__tests__/attachCommand.test.ts` → 2 passed。

- [ ] **Step 2: 后端 other_clients**

`SessionInfo` 加 `pub other_clients: u32,`，`session_info_of` 填 `other_clients: 0,`。`web.rs` 的 `list_sessions` 在拿到 `sessions` 后（admin 与非 admin 都做——只暴露调用者自己可见会话的计数）：
```rust
    let mut sessions = state.sessions.list_sessions(filter);
    let all = host_tmux_all(&state).await;
    for s in sessions.iter_mut() {
        if let Some(name) = &s.tmux_name {
            if let Some(h) = all.iter().find(|h| &h.name == name) {
                s.other_clients = h.attached.saturating_sub(s.running as u32);
            }
        }
    }
```
把 T9 的缓存拆成 `host_tmux_all(state) -> Vec<HostTmux>`（返回缓存全表）+ `host_tmux_untracked(state)`（在 `host_tmux_all` 结果上过滤 tracked）。前端 `SessionInfo` 加 `other_clients: number`，测试夹具补 `other_clients: 0`。

Run: `cargo test 2>&1 | grep -E "test result|FAILED"`
Expected: ok。

- [ ] **Step 3: SessionRowMenu（先写测试）**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SessionRowMenu from '../SessionRowMenu'
import type { SessionInfo } from '../../lib/api'

const s = (over: Partial<SessionInfo> = {}) => ({
  id: 'i', name: 'api', type: 'tmux', cols: 80, rows: 24, work_dir: '/w', description: '', status: 'idle',
  running: true, turn_state: null, turn_started_ms: null, last_activity_ms: 0, turns_completed: 0,
  source_task_id: null, tmux_name: 'zmx-3f2a9c1e', tmux_origin: 'own', other_clients: 0, ...over,
}) as SessionInfo

describe('SessionRowMenu', () => {
  it('copies the attach command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<SessionRowMenu session={s()} onRename={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('会话菜单'))
    fireEvent.click(screen.getByText('复制接续命令'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("tmux attach -t '=zmx-3f2a9c1e'"))
  })
  it('agent sessions have no attach item; close always present', () => {
    const onClose = vi.fn()
    render(<SessionRowMenu session={s({ type: 'claude', tmux_name: null, tmux_origin: null })} onRename={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('会话菜单'))
    expect(screen.queryByText('复制接续命令')).toBeNull()
    fireEvent.click(screen.getByText('关闭'))
    expect(onClose).toHaveBeenCalled()
  })
})
```
Run → FAIL。实现 `SessionRowMenu.tsx`：
```tsx
import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { SessionInfo } from '../lib/api'
import { attachCommand, copyText } from '../lib/attachCommand'

interface Props { session: SessionInfo; onRename: () => void; onClose: () => void; onHistory?: () => void }

// Always-visible ⋯ (hover-only X was invisible on touch). No swipe-to-close: it
// fights the sidebar drawer and iOS back gestures.
export default function SessionRowMenu({ session, onRename, onClose, onHistory }: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', off)
    return () => document.removeEventListener('pointerdown', off)
  }, [open])
  const item = 'block w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-hover)]'
  return (
    <div ref={ref} className="relative shrink-0" onClick={e => e.stopPropagation()}>
      <button aria-label="会话菜单" onClick={() => setOpen(v => !v)}
        className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-30 min-w-[9rem] py-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg">
          {session.tmux_name && (
            <button className={item} onClick={async () => { setCopied(await copyText(attachCommand(session.tmux_name!))); setTimeout(() => setOpen(false), 600) }}>
              {copied ? '已复制' : '复制接续命令'}
            </button>
          )}
          <button className={item} onClick={() => { setOpen(false); onRename() }}>重命名</button>
          {session.tmux_name && onHistory && <button className={item} onClick={() => { setOpen(false); onHistory() }}>查看历史</button>}
          <button className={`${item} text-[var(--accent-red)]`} onClick={() => { setOpen(false); onClose() }}>关闭</button>
        </div>
      )}
    </div>
  )
}
```
Run: `cd frontend && npx vitest run src/components/__tests__/SessionRowMenu.test.tsx` → 2 passed。

- [ ] **Step 4: 接线**

1. Sidebar 会话行：把 `<button onClick={... onDelete(s.id) } ...><X size={12} /></button>` 替换为 `<SessionRowMenu session={s} onRename={() => setEditingId(s.id)} onClose={() => onDelete(s.id)} onHistory={onOpenHistory ? () => onOpenHistory(s.id) : undefined} />`。Props 加 `onOpenHistory?: (id: string) => void`。docTabs 行的 X 保持不变（文档标签不是会话）。会话名后加：`{s.other_clients > 0 && <span className="text-[10px] text-[var(--accent-blue)] shrink-0" title="其他终端也在查看">🖥+{s.other_clients}</span>}`。移除因此不再使用的 `X` import（若 docTabs 仍用则保留）。
2. App：`const [historyReq, setHistoryReq] = useState<{ id: string; nonce: number } | null>(null)`；Sidebar 传 `onOpenHistory={(id) => { setActiveId(id); setHistoryReq({ id, nonce: Date.now() }) }}`；TerminalView 传 `historyRequest={historyReq?.id === s.id ? historyReq.nonce : 0}`。TerminalView 加 prop `historyRequest?: number` 与 `useEffect(() => { if (historyRequest) setHistoryOpen(true) }, [historyRequest])`。
3. TerminalView 状态栏：`status` 片段之后加（tmux 会话）：
```tsx
        {tmuxName && (
          <button
            onClick={async () => { if (await copyText(attachCommand(tmuxName))) { setChipCopied(true); setTimeout(() => setChipCopied(false), 1500) } }}
            title={attachCommand(tmuxName)}
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded border border-[var(--border)] text-[11px] font-mono text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {chipCopied ? '已复制' : `⧉ ${tmuxName}`}
          </button>
        )}
```
state `const [chipCopied, setChipCopied] = useState(false)`；T8 的桌面「历史」按钮去掉 `ml-auto`（chip 已占）。

Run: `cd frontend && npx tsc -b && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 5: Commit**
```bash
git add src/ frontend/src
git commit -m "feat(ui): ⋯ session menu (copy attach cmd/rename/history/close), attach chip, other-clients badge"
```

---

### Task 11: 桌面体验：OSC52 剪贴板、Shift 提示、鼠标开关、Ctrl+F

**Files:**
- Modify: `frontend/package.json`（`@xterm/addon-clipboard@^0.2.0`、`@xterm/addon-search@^0.16.0`）
- Modify: `frontend/src/components/TerminalView.tsx`
- Modify: `src/tmux.rs`（`set_mouse`）、`src/ws_handler.rs`（`ClientMsg::Mouse`）
- Create: `frontend/src/lib/desktopHints.ts`、Test: `frontend/src/lib/__tests__/desktopHints.test.ts`
- Test: `src/tmux.rs` tests

**Interfaces:**
- Consumes: T2 `run`；T3 `tmux_binding`；T8 `setHistoryOpen`
- Produces:
  - `async fn set_mouse(&self, name: &str, on: bool) -> Result<(), TmuxError>`（`set-option -t =name mouse on|off`，会话级）
  - WS 客户端消息 `{"type":"mouse","on":bool}`
  - `desktopHints.ts`：`export function shouldShowShiftHint(storage: Pick<Storage,'getItem'|'setItem'>): boolean`（首次 true 并写 `zmx-shift-hint=1`）；`export const MOUSE_PREF_KEY = 'zmx-tmux-mouse'`；`export function mousePref(storage): boolean`（默认 true）

- [ ] **Step 1: 测试（先写）**

`src/tmux.rs` tests：
```rust
    #[tokio::test]
    async fn set_mouse_is_per_session() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-m1").await;
        mk(&srv, "zmx-m2").await;
        srv.ctl.set_mouse("zmx-m1", false).await.unwrap();
        let v1 = srv.ctl.run(&["show-options", "-v", "-t", "=zmx-m1", "mouse"]).await.unwrap();
        let v2 = srv.ctl.run(&["show-options", "-v", "-t", "=zmx-m2", "mouse"]).await.unwrap_or_default();
        assert_eq!(v1.trim(), "off");
        assert_ne!(v2.trim(), "off");
    }
```
`desktopHints.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { shouldShowShiftHint, mousePref, MOUSE_PREF_KEY } from '../desktopHints'

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

describe('desktopHints', () => {
  it('shift hint only once', () => {
    const s = mem()
    expect(shouldShowShiftHint(s)).toBe(true)
    expect(shouldShowShiftHint(s)).toBe(false)
  })
  it('mouse pref defaults on, respects "0"', () => {
    const s = mem()
    expect(mousePref(s)).toBe(true)
    s.setItem(MOUSE_PREF_KEY, '0')
    expect(mousePref(s)).toBe(false)
  })
})
```
Run: `cargo test --bin zeromux set_mouse 2>&1 | tail -3; cd frontend && npx vitest run src/lib/__tests__/desktopHints.test.ts` → 都 FAIL。

- [ ] **Step 2: 实现**

`src/tmux.rs`：
```rust
    pub async fn set_mouse(&self, name: &str, on: bool) -> Result<(), TmuxError> {
        self.run(&["set-option", "-t", &format!("={name}"), "mouse", if on { "on" } else { "off" }]).await.map(|_| ())
    }
```
`ws_handler.rs` `ClientMsg` 加 `#[serde(rename = "mouse")] Mouse { on: bool },`，处理：
```rust
                                ClientMsg::Mouse { on } => {
                                    if let Some((name, _)) = state.sessions.tmux_binding(&session_id) {
                                        let _ = state.tmux.set_mouse(&name, on).await;
                                    }
                                }
```
`frontend/src/lib/desktopHints.ts`：
```ts
type KV = Pick<Storage, 'getItem' | 'setItem'>
const SHIFT_KEY = 'zmx-shift-hint'
export const MOUSE_PREF_KEY = 'zmx-tmux-mouse'

/** tmux `mouse on` means plain drag goes to tmux; Shift+drag selects in the browser. */
export function shouldShowShiftHint(storage: KV): boolean {
  if (storage.getItem(SHIFT_KEY)) return false
  storage.setItem(SHIFT_KEY, '1')
  return true
}

export function mousePref(storage: KV): boolean {
  return storage.getItem(MOUSE_PREF_KEY) !== '0'
}
```
Run 两边测试 → 通过。

- [ ] **Step 3: 装 addon 并接线**

Run: `cd frontend && npm install @xterm/addon-clipboard@^0.2.0 @xterm/addon-search@^0.16.0`

TerminalView：
1. init effect 里 `term.open` 之后：
```tsx
    term.loadAddon(new ClipboardAddon())   // OSC52 from tmux copy-mode → system clipboard
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
```
`new Terminal({...})` 加 `macOptionClickForcesSelection: true,`。
2. Ctrl/Cmd+F：
```tsx
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (tmuxRef.current) setHistoryOpen(true)     // tmux: xterm only holds one screen
        else setSearchOpen(true)
        return false
      }
      return true
    })
```
非 tmux 会话的搜索框（`searchOpen` 时显示在终端右上角）：
```tsx
      {searchOpen && (
        <div className="absolute top-2 right-3 z-10 flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-xs">
          <input autoFocus value={searchQ} onChange={e => { setSearchQ(e.target.value); searchRef.current?.findNext(e.target.value) }}
            onKeyDown={e => { if (e.key === 'Enter') (e.shiftKey ? searchRef.current?.findPrevious(searchQ) : searchRef.current?.findNext(searchQ)); if (e.key === 'Escape') { setSearchOpen(false); termRef.current?.focus() } }}
            placeholder="搜索" className="w-40 bg-transparent outline-none text-[var(--text-primary)]" />
          <button onClick={() => { setSearchOpen(false); termRef.current?.focus() }}>✕</button>
        </div>
      )}
```
3. Shift 提示：在 container 上 `onMouseDown`（非触摸、tmux 会话、未按 Shift 时）：
```tsx
  const onMouseDownHint = (e: React.MouseEvent) => {
    if (isTouch || !tmuxName || e.shiftKey || e.button !== 0) return
    if (shouldShowShiftHint(localStorage)) { setShiftHint(true); setTimeout(() => setShiftHint(false), 4000) }
  }
```
`<div ref={containerRef} onMouseDown={onMouseDownHint} ...>`；提示：`{shiftHint && <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">按住 Shift 拖动可选择文字（{navigator.platform.includes('Mac') ? 'Mac 也可按 Option' : '或在历史中长按'}）</div>}`。
4. 鼠标开关：`ws.onopen` 末尾 `if (tmuxRef.current && !mousePref(localStorage)) ws.send(JSON.stringify({ type: 'mouse', on: false }))`；桌面状态栏在 chip 前加
```tsx
        {tmuxName && !isTouch && (
          <button onClick={() => { const on = !mouseOn; setMouseOn(on); localStorage.setItem(MOUSE_PREF_KEY, on ? '1' : '0'); wsRef.current?.send(JSON.stringify({ type: 'mouse', on })) }}
            title={mouseOn ? '鼠标交给 tmux（滚轮滚动、点选窗格）' : '鼠标交给浏览器（直接拖选文字）'}
            className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            {mouseOn ? '🖱 tmux' : '🖱 浏览器'}
          </button>
        )}
```
state `const [mouseOn, setMouseOn] = useState(() => mousePref(localStorage))`。
注意：手机手势（T7）走服务端 `copy-mode` 命令，不依赖 tmux `mouse`，关掉鼠标不影响手机滚动。

Run: `cd frontend && npx tsc -b && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -3; cd .. && cargo test 2>&1 | grep -E "test result|FAILED"`
Expected: 全部通过。

- [ ] **Step 4: Commit**
```bash
git add src/ frontend/package.json frontend/package-lock.json frontend/src
git commit -m "feat(term): OSC52 clipboard, Shift-select hint, tmux/browser mouse toggle, Ctrl+F"
```

---

### Task 12: 历史视图增强：搜索、ANSI 颜色、横屏分屏

**Files:**
- Create: `frontend/src/lib/ansi.ts`、Test: `frontend/src/lib/__tests__/ansi.test.ts`
- Create: `frontend/src/lib/ansi.worker.ts`
- Create: `frontend/src/lib/historySearch.ts`、Test: `frontend/src/lib/__tests__/historySearch.test.ts`
- Modify: `src/tmux.rs`（`capture` 加 `ansi: bool`）、`src/web.rs`（传 `q.ansi == 1`）
- Modify: `frontend/src/components/HistoryView.tsx`、`frontend/src/components/TerminalView.tsx`（横屏布局）
- Test: `frontend/src/components/__tests__/HistoryView.test.tsx`

**Interfaces:**
- Consumes: T8 `HistoryView`, `getHistory(id, ansi)`, `chunkLines`
- Produces:
  - `TmuxCtl::capture(&self, name, max_lines, max_bytes, ansi: bool)`（签名变更：T8 调用处传 `false`/`q.ansi == 1`）
  - `ansi.ts`：`export type Span = { text: string; fg?: string; bg?: string; bold?: boolean }`；`export function parseAnsiLine(line: string): Span[]`；`export function stripAnsi(s: string): string`
  - `historySearch.ts`：`export function findMatches(chunks: string[], q: string): { chunk: number; offset: number }[]`（大小写不敏感，最多 1000 个）
  - HistoryView 新 props：`split?: boolean`（横屏半屏）

- [ ] **Step 1: 纯函数测试（先写）**

`ansi.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { parseAnsiLine, stripAnsi } from '../ansi'

describe('parseAnsiLine', () => {
  it('plain text → one span', () => {
    expect(parseAnsiLine('hello')).toEqual([{ text: 'hello' }])
  })
  it('basic fg + reset', () => {
    expect(parseAnsiLine('\x1b[31mred\x1b[0m ok')).toEqual([{ text: 'red', fg: 'var(--ansi-1)' }, { text: ' ok' }])
  })
  it('bold + 256 + truecolor', () => {
    const s = parseAnsiLine('\x1b[1;38;5;196mA\x1b[38;2;1;2;3mB')
    expect(s[0]).toEqual({ text: 'A', fg: 'var(--ansi-256-196)', bold: true })
    expect(s[1]).toEqual({ text: 'B', fg: 'rgb(1,2,3)', bold: true })
  })
  it('drops non-SGR escapes', () => {
    expect(stripAnsi('\x1b[2Ka\x1b]0;title\x07b')).toBe('ab')
    expect(parseAnsiLine('\x1b[2Kx')).toEqual([{ text: 'x' }])
  })
})
```
`historySearch.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { findMatches } from '../historySearch'

describe('findMatches', () => {
  it('finds across chunks, case-insensitive', () => {
    expect(findMatches(['Error a\nok', 'x error'], 'ERROR')).toEqual([{ chunk: 0, offset: 0 }, { chunk: 1, offset: 2 }])
  })
  it('empty query → none', () => {
    expect(findMatches(['a'], '')).toEqual([])
  })
})
```
Run → FAIL。

- [ ] **Step 2: 实现纯函数**

`frontend/src/lib/ansi.ts`：
```ts
// Minimal SGR → span parser for the history view. Only colors + bold; every
// other escape (cursor moves, OSC titles, erase) is dropped. Palette entries map
// to CSS vars so both themes work; index.css defines --ansi-0..15.
export type Span = { text: string; fg?: string; bg?: string; bold?: boolean }

// eslint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-9;?]*)([@-~])/g

export function stripAnsi(s: string): string {
  return s.replace(OSC, '').replace(CSI, '')
}

function color(codes: number[], i: number): [string | undefined, number] {
  if (codes[i + 1] === 5) return [`var(--ansi-256-${codes[i + 2]})`, i + 2]
  if (codes[i + 1] === 2) return [`rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`, i + 4]
  return [undefined, i]
}

export function parseAnsiLine(line: string): Span[] {
  const src = line.replace(OSC, '')
  const out: Span[] = []
  let cur: Omit<Span, 'text'> = {}
  let last = 0
  const push = (text: string) => { if (text) out.push({ text, ...cur }) }
  for (const m of src.matchAll(CSI)) {
    push(src.slice(last, m.index))
    last = (m.index ?? 0) + m[0].length
    if (m[2] !== 'm') continue
    const codes = (m[1] || '0').split(';').map(n => Number(n) || 0)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) cur = {}
      else if (c === 1) cur = { ...cur, bold: true }
      else if (c === 22) { const { bold: _b, ...rest } = cur; cur = rest }
      else if (c >= 30 && c <= 37) cur = { ...cur, fg: `var(--ansi-${c - 30})` }
      else if (c >= 90 && c <= 97) cur = { ...cur, fg: `var(--ansi-${c - 82})` }
      else if (c === 39) { const { fg: _f, ...rest } = cur; cur = rest }
      else if (c >= 40 && c <= 47) cur = { ...cur, bg: `var(--ansi-${c - 40})` }
      else if (c === 49) { const { bg: _g, ...rest } = cur; cur = rest }
      else if (c === 38 || c === 48) {
        const [v, ni] = color(codes, i)
        if (v) cur = c === 38 ? { ...cur, fg: v } : { ...cur, bg: v }
        i = ni
      }
    }
  }
  push(src.slice(last))
  return out
}
```
`index.css` 追加 16 色变量（dark 取 TerminalView THEMES.dark 的 black..brightWhite；light 在 `[data-theme="light"]` 下取 THEMES.light——以 `index.css` 现有主题选择器为准），256 色的 16–255 用 `--ansi-256-N` 仅在出现时由 `HistoryView` 内联计算：在 `parseAnsiLine` 调用方把 `var(--ansi-256-N)` 替换为 `xterm256(N)`：
```ts
export function xterm256(n: number): string {
  if (n < 16) return `var(--ansi-${n})`
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})` }
  const i = n - 16, r = Math.floor(i / 36), g = Math.floor(i / 6) % 6, b = i % 6
  const lv = (x: number) => (x ? 55 + x * 40 : 0)
  return `rgb(${lv(r)},${lv(g)},${lv(b)})`
}
```
（把 `color()` 里 256 分支改为 `return [xterm256(codes[i + 2]), i + 2]`，测试期望同步改为 `fg: 'rgb(255,0,0)'`——196 = r5 g0 b0 → `rgb(255,0,0)`。）

`frontend/src/lib/historySearch.ts`：
```ts
export function findMatches(chunks: string[], q: string): { chunk: number; offset: number }[] {
  const needle = q.toLowerCase()
  if (!needle) return []
  const out: { chunk: number; offset: number }[] = []
  chunks.forEach((c, chunk) => {
    const hay = c.toLowerCase()
    for (let i = hay.indexOf(needle); i !== -1 && out.length < 1000; i = hay.indexOf(needle, i + needle.length)) {
      out.push({ chunk, offset: i })
    }
  })
  return out
}
```
`frontend/src/lib/ansi.worker.ts`：
```ts
import { parseAnsiLine } from './ansi'
self.onmessage = (e: MessageEvent<string[]>) => {
  // chunk text → per-line spans, off the main thread (50k lines on a phone).
  self.postMessage(e.data.map(chunk => chunk.split('\n').map(parseAnsiLine)))
}
```
Run: `cd frontend && npx vitest run src/lib/__tests__/ansi.test.ts src/lib/__tests__/historySearch.test.ts`
Expected: 通过。

- [ ] **Step 3: 后端 ansi**

`capture` 签名加 `ansi: bool`：args 在 `"-p"` 后按需插入 `"-e"`：
```rust
        let mut args = vec!["capture-pane", "-p"];
        if ansi { args.push("-e"); }
        args.extend(["-J", "-S", &start, "-E", "-", "-t", &target]);
        let text = self.run(&args).await?;
```
（`let target = format!("={name}:");` 放在前面。）更新 T2 测试调用与 T8 `session_history`：`state.tmux.capture(&name, 50_000, 5 * 1024 * 1024, q.ansi == 1)`（`_q` 改名 `q`）。追加测试：
```rust
    #[tokio::test]
    async fn capture_ansi_keeps_sgr() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-a1").await;
        srv.ctl.run(&["send-keys", "-t", "=zmx-a1:", "printf '\\033[31mRED\\033[0m\\n'", "Enter"]).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let plain = srv.ctl.capture("zmx-a1", 100, 1 << 20, false).await.unwrap().text;
        let color = srv.ctl.capture("zmx-a1", 100, 1 << 20, true).await.unwrap().text;
        assert!(!plain.contains('\x1b'));
        assert!(color.contains("\x1b[31m"));
    }
```
Run: `cargo test --bin zeromux tmux::tests 2>&1 | tail -3`
Expected: ok。

- [ ] **Step 4: HistoryView 增强（先补测试）**

`HistoryView.test.tsx` 追加：
```tsx
  it('search box highlights and steps through matches', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'foo\nbar foo\nbaz', truncated: false })
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/baz/)).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('搜索历史'), { target: { value: 'foo' } })
    expect(screen.getByText('1/2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('下一个'))
    expect(screen.getByText('2/2')).toBeInTheDocument()
  })
  it('color toggle refetches with ansi=1', async () => {
    const spy = vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'x', truncated: false })
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} />)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s', false))
    fireEvent.click(screen.getByText('颜色'))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s', true))
  })
```
Run → FAIL。

实现要点（`HistoryView.tsx`）：
1. state `ansi`（默认 false）、`q`、`idx`、`spans: Span[][][] | null`。`useEffect([sessionId, ansi])` 调 `getHistory(sessionId, ansi)`。
2. `const chunks = useMemo(() => text === null ? [] : chunkLines(ansi ? text : text, CHUNK), [text, ansi])`；搜索在 `stripAnsi` 后的 chunk 上跑：`const plainChunks = useMemo(() => ansi ? chunks.map(stripAnsi) : chunks, [chunks, ansi])`，`const matches = useMemo(() => findMatches(plainChunks, q), [plainChunks, q])`。
3. ansi 模式：`useEffect` 里 `const w = new Worker(new URL('../lib/ansi.worker.ts', import.meta.url), { type: 'module' }); w.onmessage = e => setSpans(e.data); w.postMessage(chunks); return () => w.terminate()`；jsdom 无 Worker 时（`typeof Worker === 'undefined'`）同步 `setSpans(chunks.map(c => c.split('\n').map(parseAnsiLine)))`。渲染：spans 存在时每块 `<pre>` 内按行输出 `<span style={{ color: sp.fg ? (sp.fg.startsWith('var(--ansi-256-') ? xterm256(Number(sp.fg.slice(15, -1))) : sp.fg) : undefined, background: sp.bg, fontWeight: sp.bold ? 600 : undefined }}>{sp.text}</span>` 加换行。
4. 搜索高亮：非 ansi 模式下，当前匹配所在块渲染为 `text.slice(0, off)` + `<mark data-current>` + 剩余；其余块纯文本（全部高亮在 50k 行下太重，只高亮当前一处）。`idx` 变化时 `document.querySelector('[data-current]')?.scrollIntoView({ block: 'center' })`。ansi 模式下搜索仅计数 + 滚动到块（`scrollRef` 内第 `chunk` 个 `<pre>` 的 `scrollIntoView`）。
5. 顶栏加 `<input placeholder="搜索历史" .../>`、`<span>{matches.length ? `${idx + 1}/${matches.length}` : q ? '0/0' : ''}</span>`、`<button aria-label="上一个">▲</button>`、`<button aria-label="下一个">▼</button>`（循环），底栏加 `<button onClick={() => setAnsi(a => !a)}>{ansi ? '纯文本' : '颜色'}</button>`。
6. `split` prop：为 true 时根元素 class 从 `absolute inset-0` 改为 `absolute inset-y-0 right-0 w-1/2 border-l border-[var(--border)]`。

TerminalView：
```tsx
  const [landscape, setLandscape] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(orientation: landscape) and (max-height: 500px)').matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia('(orientation: landscape) and (max-height: 500px)')
    const on = () => setLandscape(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
```
`<HistoryView ... split={isTouch && landscape} />`；split 时 `xterm-container` 加 `className` 条件 `w-1/2`，并在 `historyOpen`/`landscape` 变化后 `setTimeout(handleResize, 50)`（让 tmux 按半宽重排）。split 时不隐藏 KeyBar/Composer（左侧终端仍可用）：把 T8 的 `!historyOpen` 条件改为 `!(historyOpen && !(isTouch && landscape))`。

Run: `cd frontend && npx tsc -b && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 5: Commit**
```bash
git add src/ frontend/src
git commit -m "feat(history): search with prev/next, ANSI colors via worker, landscape split"
```

---

### Task 13: 「↓ N 行新输出」

**Files:**
- Create: `src/scroll_watch.rs`（纯函数 + 测试），Modify: `src/main.rs`（`mod scroll_watch;`）
- Modify: `src/ws_handler.rs`（`scroll_watch` 消息 + 1s 轮询）
- Modify: `frontend/src/components/TerminalView.tsx`（浮标文案）
- Test: `src/scroll_watch.rs`

**Interfaces:**
- Consumes: T2 `info`；T7 `scroll_state`、浮标
- Produces:
  - `pub fn new_lines(baseline: u64, now: u64) -> u64`（history 被 history-limit 截断后 now < baseline → 0）
  - WS 客户端 `{"type":"scroll_watch","on":bool}`；服务端 `scroll_state` 增加字段 `new_lines`

- [ ] **Step 1: 测试（先写）**

`src/scroll_watch.rs`：
```rust
//! "↓ N new lines" while the user reads tmux copy-mode: copy-mode freezes the
//! pane, so the browser can't see new output — the server diffs history_size.

pub fn new_lines(baseline: u64, now: u64) -> u64 {
    now.saturating_sub(baseline)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counts_growth_and_never_underflows() {
        assert_eq!(new_lines(100, 112), 12);
        assert_eq!(new_lines(100, 100), 0);
        assert_eq!(new_lines(50_000, 49_990), 0, "history-limit trimming must not underflow");
    }
}
```
`main.rs` 加 `mod scroll_watch;`。

Run: `cargo test --bin zeromux scroll_watch 2>&1 | tail -3`
Expected: 1 passed（纯函数与测试同文件，实现即上面一行）。

- [ ] **Step 2: ws_handler 轮询**

`ClientMsg` 加 `#[serde(rename = "scroll_watch")] ScrollWatch { on: bool },`。`handle_ws` 循环前：
```rust
    let mut watch = tokio::time::interval(std::time::Duration::from_secs(1));
    watch.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut watch_baseline: Option<u64> = None;
```
select 分支：
```rust
            _ = watch.tick(), if watch_baseline.is_some() => {
                if let (Some(base), Some((name, _))) = (watch_baseline, state.sessions.tmux_binding(&session_id)) {
                    if let Ok(i) = state.tmux.info(&name).await {
                        let m = serde_json::json!({"type": "scroll_state", "in_mode": i.in_mode,
                            "history_size": i.history_size,
                            "new_lines": crate::scroll_watch::new_lines(base, i.history_size)});
                        if !i.in_mode { watch_baseline = None; }   // left copy-mode (maybe from VSCode)
                        if ws_sink.send(Message::Text(m.to_string().into())).await.is_err() { break; }
                    }
                }
            }
```
消息处理：
```rust
                                ClientMsg::ScrollWatch { on } => {
                                    watch_baseline = None;
                                    if on {
                                        if let Some((name, _)) = state.sessions.tmux_binding(&session_id) {
                                            watch_baseline = state.tmux.info(&name).await.ok().map(|i| i.history_size);
                                        }
                                    }
                                }
```

Run: `cargo build 2>&1 | grep -E "^error" | head`
Expected: 无输出。

- [ ] **Step 3: 前端**

TerminalView：`const [newLines, setNewLines] = useState(0)`；`scrolling` 由 false→true 时发 `{type:'scroll_watch', on:true}`，true→false 时发 `on:false` 并 `setNewLines(0)`：
```tsx
  useEffect(() => {
    const ws = wsRef.current
    if (!tmuxName || ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'scroll_watch', on: scrolling }))
    if (!scrolling) setNewLines(0)
  }, [scrolling, tmuxName])
```
`scroll_state` 处理加 `if (typeof msg.new_lines === 'number') setNewLines(msg.new_lines)`。浮标文案：`{newLines > 0 ? `↓ ${newLines} 行新输出` : '⏸ 已暂停跟随 · ⤓'}`。

Run: `cd frontend && npx tsc -b && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 4: Commit**
```bash
git add src/ frontend/src
git commit -m "feat(term): '↓ N 行新输出' while reading tmux copy-mode"
```

---

### Task 14: KeyBar 第二页

**Files:**
- Modify: `frontend/src/lib/terminalInput.ts`（`ControlKey` 扩展）
- Modify: `frontend/src/components/MobileKeyBar.tsx`
- Modify: `frontend/src/components/TerminalView.tsx`（`handleBarKey`）
- Test: `frontend/src/lib/__tests__/terminalInput.test.ts`、`frontend/src/components/__tests__/MobileKeyBar.test.tsx`

**Interfaces:**
- Consumes: 现有 `arrowSequence`、`controlSequence`、`BarKey`
- Produces:
  - `ControlKey = 'ctrl-c' | 'esc' | 'tab' | 'ctrl-d' | 'ctrl-z' | 'pgup' | 'pgdn'`
  - `BarKey` 增加 `'left' | 'right' | 'esc' | 'tab' | 'ctrl-d' | 'ctrl-z' | 'pgup' | 'pgdn'`
  - MobileKeyBar 翻页按钮 `aria-label="more-keys"`

- [ ] **Step 1: 测试（先写）**

`terminalInput.test.ts` 追加：
```ts
describe('controlSequence (page 2)', () => {
  it('maps extra control keys', () => {
    expect(controlSequence('esc')).toBe('\x1b')
    expect(controlSequence('tab')).toBe('\t')
    expect(controlSequence('ctrl-d')).toBe('\x04')
    expect(controlSequence('ctrl-z')).toBe('\x1a')
    expect(controlSequence('pgup')).toBe('\x1b[5~')
    expect(controlSequence('pgdn')).toBe('\x1b[6~')
  })
})
```
`MobileKeyBar.test.tsx`：把原「不渲染已删键」用例改为只断言第一页不显示 `esc/left/right`（`y`/`n` 保持不存在），并追加：
```tsx
  it('more-keys flips to page 2 and back', () => {
    const onKey = vi.fn()
    render(<MobileKeyBar onKey={onKey} />)
    fireEvent.pointerDown(screen.getByLabelText('more-keys'))
    for (const k of ['esc', 'tab', 'left', 'right', 'ctrl-d', 'ctrl-z', 'pgup', 'pgdn']) {
      expect(screen.getByLabelText(k)).toBeInTheDocument()
    }
    expect(screen.queryByLabelText('claude')).toBeNull()
    fireEvent.pointerDown(screen.getByLabelText('esc'))
    expect(onKey).toHaveBeenCalledWith('esc')
    fireEvent.pointerDown(screen.getByLabelText('more-keys'))
    expect(screen.getByLabelText('claude')).toBeInTheDocument()
  })
```
Run → FAIL。

- [ ] **Step 2: 实现**

`terminalInput.ts`：
```ts
export type ControlKey = 'ctrl-c' | 'esc' | 'tab' | 'ctrl-d' | 'ctrl-z' | 'pgup' | 'pgdn'

const CONTROL: Record<ControlKey, string> = {
  'ctrl-c': '\x03',
  esc: '\x1b',
  tab: '\t',
  'ctrl-d': '\x04',
  'ctrl-z': '\x1a',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
}
```
`MobileKeyBar.tsx`：`BarKey` 改为 `'up' | 'down' | 'left' | 'right' | 'enter' | ControlKey | AgentKey`（import `ControlKey`）。加 page 2 定义：
```tsx
const PAGE2: { key: BarKey; label: string }[] = [
  { key: 'esc', label: 'Esc' }, { key: 'tab', label: 'Tab' },
  { key: 'left', label: '←' }, { key: 'right', label: '→' },
  { key: 'ctrl-d', label: '^D' }, { key: 'ctrl-z', label: '^Z' },
  { key: 'pgup', label: 'PgUp' }, { key: 'pgdn', label: 'PgDn' },
]
```
组件内 `const [page, setPage] = useState(0)`；page 0 渲染原有键，page 1 渲染 `PAGE2`（文字键样式）；两页末尾都有：
```tsx
      <button aria-label="more-keys" onPointerDown={(e) => { e.preventDefault(); setPage(p => 1 - p) }}
        style={{ touchAction: 'manipulation' }} className={`${btnCls} text-xs`}>{page === 0 ? '⋯' : '↩︎'}</button>
```
`onHistory` 的 📜 两页都显示在最左。
TerminalView `handleBarKey`：
```tsx
    if (key === 'claude' || key === 'codex' || key === 'crew') {
      sendInput(launchSequence(key))
    } else if (key === 'up' || key === 'down' || key === 'left' || key === 'right' || key === 'enter') {
      sendInput(arrowSequence(key, term.modes.applicationCursorKeysMode))
    } else {
      sendInput(controlSequence(key))
    }
```

Run: `cd frontend && npx tsc -b && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 3: Commit**
```bash
git add frontend/src
git commit -m "feat(keybar): second page — Esc/Tab/←→/^D/^Z/PgUp/PgDn"
```

---

### Task 15: 「发给 agent」+ 终端结束推送 `term_ended`

**Files:**
- Modify: `src/push.rs`（`payload_for`、`kind_allowed_by_levels`）
- Modify: `src/session_manager.rs`（T4 的 fan-out 结束检查里发推送）
- Create: `frontend/src/lib/historyToAgent.ts`、Test: `frontend/src/lib/__tests__/historyToAgent.test.ts`
- Modify: `frontend/src/components/HistoryView.tsx`、`frontend/src/components/TerminalView.tsx`、`frontend/src/App.tsx`
- Test: `src/push.rs` tests

**Interfaces:**
- Consumes: T4 fan-out 结束 `has=false` 分支；T8/T12 `HistoryView`；App `handleCreate(type, workDir, tmuxTarget, initialPrompt)`
- Produces:
  - push kind `"term_ended"`：title `⏹ {name} 已结束`，body `终端会话已退出`，级别 routine
  - `historyToAgent.ts`：`export const AGENT_MAX_BYTES = 32 * 1024`；`export function historyPrompt(opts: { name: string; workDir: string; text: string }): string`（取尾部 ≤32KB、按行对齐，前缀说明 + ```` ``` ```` 围栏）
  - `HistoryView` 新 prop `onSendToAgent?: (selectionOrTail: string) => void`
  - `TerminalView` 新 prop `onAskAgent?: (prompt: string) => void`；App 实现为 `handleCreate('claude', s.work_dir, undefined, prompt)`

- [ ] **Step 1: 后端测试（先写）**

`src/push.rs` tests 模块追加：
```rust
    #[test]
    fn term_ended_payload_and_level() {
        let p = payload_for("term_ended", "api", "sid", None);
        assert_eq!(p.title, "⏹ api 已结束");
        assert_eq!(p.body, "终端会话已退出");
        assert!(kind_allowed_by_levels("term_ended", false, true));
        assert!(!kind_allowed_by_levels("term_ended", true, false));
    }
```
Run: `cargo test --bin zeromux term_ended 2>&1 | tail -3` → FAIL。

- [ ] **Step 2: 实现后端**

`payload_for` 加臂：
```rust
        "term_ended" => (format!("⏹ {name} 已结束"), "终端会话已退出".to_string()),
```
`kind_allowed_by_levels` 改为 `"turn_done" | "term_ended" => lvl_routine,`。
T4 的 fan-out 结束检查改为：
```rust
                    if let Ok(false) = m.tmux.has(&name).await {
                        m.mark_ended(&sid_for_exit);
                        // Not a deliberate close (that path removes the session
                        // before killing, so tmux_binding above was None).
                        if let (Some(p), Some(owner)) = (m.push_handle(), m.owner_of(&sid_for_exit)) {
                            let title = m.session_name(&sid_for_exit).unwrap_or_default();
                            p.send_to_user(&owner, &crate::push::payload_for("term_ended", &title, &sid_for_exit, None)).await;
                        }
                    }
```
新增：
```rust
    pub fn owner_of(&self, id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(id).map(|s| s.owner_id.clone())
    }
```
`sw.js`：`term_ended` 走默认分支（tag `${session_id}:term_ended`），无需改动——用 `grep -n "turn_done" frontend/public/sw.js` 确认没有白名单式过滤。

Run: `cargo test 2>&1 | grep -E "test result|FAILED"`
Expected: ok。

- [ ] **Step 3: 前端纯函数（先写测试）**

```ts
import { describe, it, expect } from 'vitest'
import { historyPrompt, AGENT_MAX_BYTES } from '../historyToAgent'

describe('historyPrompt', () => {
  it('wraps output with context', () => {
    const p = historyPrompt({ name: 'api', workDir: '/w', text: 'error: boom' })
    expect(p).toContain('终端「api」（/w）')
    expect(p).toContain('```\nerror: boom\n```')
  })
  it('keeps only the tail under the byte cap, line-aligned', () => {
    const text = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n')
    const p = historyPrompt({ name: 'a', workDir: '/w', text })
    const body = p.split('```\n')[1].split('\n```')[0]
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(AGENT_MAX_BYTES)
    expect(body.endsWith('line 19999')).toBe(true)
    expect(body.startsWith('line ')).toBe(true)
    expect(p).toContain('（已截取最后')
  })
})
```
Run → FAIL。实现 `frontend/src/lib/historyToAgent.ts`：
```ts
export const AGENT_MAX_BYTES = 32 * 1024

export function historyPrompt({ name, workDir, text }: { name: string; workDir: string; text: string }): string {
  const enc = new TextEncoder()
  let body = text.replace(/\s+$/, '')
  let truncated = false
  if (enc.encode(body).length > AGENT_MAX_BYTES) {
    truncated = true
    const lines = body.split('\n')
    const kept: string[] = []
    let size = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const n = enc.encode(lines[i]).length + 1
      if (size + n > AGENT_MAX_BYTES) break
      kept.unshift(lines[i]); size += n
    }
    body = kept.join('\n')
  }
  const note = truncated ? `（已截取最后 ${body.split('\n').length} 行）` : ''
  return `下面是终端「${name}」（${workDir}）的输出${note}，请帮我分析：\n\n\`\`\`\n${body}\n\`\`\`\n`
}
```
Run → 通过。

- [ ] **Step 4: 接线**

HistoryView 底栏加：
```tsx
        {onSendToAgent && (
          <button className={btn} onClick={() => {
            const sel = window.getSelection()?.toString() ?? ''
            const payload = sel.trim() ? sel : (text ?? '').split('\n').slice(-200).join('\n')
            if (window.confirm('内容可能包含密钥或令牌，确认发给 agent？')) onSendToAgent(payload)
          }}>发给 agent</button>
        )}
```
TerminalView：`<HistoryView ... onSendToAgent={onAskAgent ? (t) => { setHistoryOpen(false); onAskAgent(historyPrompt({ name: tmuxName ?? '', workDir: status?.work_dir ?? '', text: t })) } : undefined} />`。App：`<TerminalView ... onAskAgent={(prompt) => handleCreate('claude', s.work_dir, undefined, prompt)} />`。
HistoryView 测试追加：
```tsx
  it('send to agent asks for confirmation and sends the tail', async () => {
    vi.spyOn(api, 'getHistory').mockResolvedValue({ text: 'a\nb', truncated: false })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onSend = vi.fn()
    render(<HistoryView sessionId="s" title="t" onClose={() => {}} onSendToAgent={onSend} />)
    await waitFor(() => expect(screen.getByText(/b/)).toBeInTheDocument())
    fireEvent.click(screen.getByText('发给 agent'))
    expect(onSend).toHaveBeenCalledWith('a\nb')
  })
```

Run: `cd frontend && npx tsc -b && npm run lint 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: 通过。

- [ ] **Step 5: Commit**
```bash
git add src/ frontend/src
git commit -m "feat: send terminal history to a Claude session; term_ended push"
```

---

### 收尾：全量验证与部署

- [ ] `cargo test 2>&1 | grep -E "test result|FAILED"` 全部 ok；`cd frontend && npm run lint && npm test && npm run build` 通过。
- [ ] 隔离冒烟（Global Constraints 的命令）走一遍：新建终端（≤2 次点击）、⋯ 复制接续命令并在另一个 shell `tmux -L zmx-smoke attach -t '=zmx-…'`、历史搜索/颜色、KeyBar 第二页、Ctrl+F、X 撤销。
- [ ] `git push` → `./deploy.sh --build` → 重跑 T8 Step 5 的 S1–S6 + S4（点击数）。
- [ ] 更新记忆：新增一条 project memory（交付日期、关键坑），并在 MEMORY.md 加索引行。
