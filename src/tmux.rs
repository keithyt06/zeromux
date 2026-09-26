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
pub const TMUX_CONF_VERSION: u32 = 2;

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

    /// `ansi` adds `-e` so SGR color/attribute escapes are kept in the output.
    pub async fn capture(&self, name: &str, max_lines: u32, max_bytes: usize, ansi: bool) -> Result<Captured, TmuxError> {
        let start = format!("-{max_lines}");
        let target = format!("={name}:");
        let mut args = vec!["capture-pane", "-p"];
        if ansi { args.push("-e"); }
        args.extend(["-J", "-S", &start, "-E", "-", "-t", &target]);
        let text = self.run(&args).await?;
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
            "#{session_name}\t#{session_attached}\t#{pane_in_mode}\t#{history_size}\t#{alternate_on}\t#{mouse_any_flag}\t#{mouse_sgr_flag}\t#{pane_current_command}"]).await?;
        let f: Vec<&str> = s.trim_end_matches('\n').split('\t').collect();
        // On a server with zero sessions tmux 3.4 exits 0 with every format
        // field empty instead of erroring — an empty session_name means "gone".
        if f.first().is_none_or(|n| n.is_empty()) { return Err(TmuxError::NotFound); }
        if f.len() < 8 { return Err(TmuxError::Other(format!("bad info: {s}"))); }
        Ok(PaneInfo {
            attached: f[1].parse().unwrap_or(0),
            in_mode: f[2] == "1",
            history_size: f[3].parse().unwrap_or(0),
            alternate_on: f[4] == "1",
            mouse_any: f[5] == "1",
            mouse_sgr: f[6] == "1",
            current_command: f[7].to_string(),
        })
    }

    /// Drive scrolling from the server side. Two routes (see `scroll_route`):
    /// - CopyMode: tmux copy-mode; every op that would only make sense inside
    ///   copy-mode is gated on `in_mode`, so nothing is typed into the pane.
    /// - AppWheel: a fullscreen app (alt-screen + mouse reporting, e.g. Claude
    ///   Code) keeps tmux history empty, so copy-mode is useless; send SGR wheel
    ///   events as pane input instead — the only bytes this path ever sends.
    pub async fn scroll(&self, name: &str, op: ScrollOp) -> Result<(PaneInfo, ScrollRoute), TmuxError> {
        let t = format!("={name}:");
        let pre = self.info(name).await?;
        let in_mode = pre.in_mode;
        let route = scroll_route(in_mode, pre.alternate_on, pre.mouse_any, pre.mouse_sgr);
        if route == ScrollRoute::AppWheel {
            if let Some(seq) = wheel_seq(op) {
                self.run(&["send-keys", "-t", &t, "-l", &seq]).await?;
            }
            return Ok((self.info(name).await?, route));
        }
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
        Ok((self.info(name).await?, route))
    }

    /// Session-level `mouse` toggle: `on` sends drag/wheel to tmux (copy-mode,
    /// pane selection); `off` hands the mouse back to the browser for native
    /// text selection. Per-session, so it never affects other tmux sessions.
    /// `set-option -t` takes a target-pane (not target-session), so — like
    /// `capture`/`info`/`scroll` above — the target needs the trailing `:`;
    /// a bare `=name` gets "no such session" from real tmux.
    pub async fn set_mouse(&self, name: &str, on: bool) -> Result<(), TmuxError> {
        self.run(&["set-option", "-t", &format!("={name}:"), "mouse", if on { "on" } else { "off" }]).await.map(|_| ())
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
}

pub fn tmux_name_for(id: &str) -> String {
    format!("zmx-{}", &id[..8.min(id.len())])
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Captured {
    pub text: String, pub truncated: bool,
    /// Set by the history endpoint from `info()`; `capture` itself leaves it false.
    pub alternate: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HostTmux { pub name: String, pub windows: u32, pub attached: u32, pub created: i64, pub path: String }

#[derive(Debug, Clone, serde::Serialize)]
pub struct PaneInfo {
    pub attached: u32, pub in_mode: bool, pub history_size: u64,
    /// `#{alternate_on}` / `#{mouse_any_flag}`: fullscreen app with mouse reporting.
    pub alternate_on: bool, pub mouse_any: bool,
    /// `#{mouse_sgr_flag}`: app asked for SGR (1006) mouse encoding — the only one we emit.
    pub mouse_sgr: bool,
    pub current_command: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollRoute { CopyMode, AppWheel }

/// A fullscreen app that asked for mouse events scrolls its own view, and
/// never writes into tmux history — route to it unless we're already in copy-mode.
/// Requires SGR encoding: X10-mouse apps would misparse our SGR bytes → CopyMode.
pub fn scroll_route(in_mode: bool, alternate_on: bool, mouse_any: bool, mouse_sgr: bool) -> ScrollRoute {
    if !in_mode && alternate_on && mouse_any && mouse_sgr { ScrollRoute::AppWheel } else { ScrollRoute::CopyMode }
}

/// SGR wheel events for AppWheel: up = button 64, down = 65, at cell 1;1.
/// Top/Bottom = 200 events (the ScrollOp clamp); Cancel = nothing.
fn wheel_seq(op: ScrollOp) -> Option<String> {
    let (btn, n) = match op {
        ScrollOp::Up(n) => (64, n),
        ScrollOp::Down(n) => (65, n),
        ScrollOp::Top => (64, 200),
        ScrollOp::Bottom => (65, 200),
        ScrollOp::Cancel => return None,
    };
    Some(format!("\x1b[<{btn};1;1M").repeat(n as usize))
}

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
    if text.len() <= max_bytes { return Captured { text, truncated: false, alternate: false }; }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) { start += 1; }
    let start = text[start..].find('\n').map(|i| start + i + 1).unwrap_or(text.len());
    Captured { text: text[start..].to_string(), truncated: true, alternate: false }
}

fn classify_stderr(err: &str) -> TmuxError {
    if err.contains("error connecting to") || err.contains("no server running") {
        TmuxError::ServerDown
    } else if err.contains("can't find session") || err.contains("can't find pane")
        || err.contains("can't find window") || err.contains("session not found")
        || err.contains("no sessions")
        // Zero-session server (tmux 3.4): has/kill/capture/list-clients answer
        // "no current target", set-option answers "no such session".
        || err.contains("no current target") || err.contains("no such session") {
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
set-environment -g CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN 1
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
    impl TestServer {
        /// Leave the server running with ZERO sessions (exit-empty is off).
        pub(crate) fn kill_boot(&self) {
            let _ = std::process::Command::new("tmux")
                .args(["-L", &self.socket, "kill-session", "-t", "=boot"]).status();
        }
    }
    impl Drop for TestServer {
        fn drop(&mut self) {
            let _ = std::process::Command::new("tmux").args(["-L", &self.socket, "kill-server"]).status();
            // Best-effort: tmux doesn't remove the socket file itself on
            // kill-server in every version, so clean up the one we created
            // (same path convention tmux uses: $TMUX_TMPDIR or /tmp, then
            // tmux-<uid>/<socket>). Never a hard requirement — just avoids
            // littering /tmp with dead test sockets.
            let base = std::env::var("TMUX_TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
            let uid = unsafe { libc::getuid() };
            let _ = std::fs::remove_file(format!("{base}/tmux-{uid}/{}", self.socket));
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
        // The test server itself is a plain tmux -L process, not the
        // zeromux-tmux.service one — UNLESS this test happens to be running
        // from inside a shell hosted by that unit (e.g. `cargo test` invoked
        // from a zeromux terminal after the tmux-default rollout), in which
        // case the test process (and everything it spawns) inherits that
        // unit's cgroup too. So in_unit must track our own cgroup, not be
        // unconditionally false.
        let self_in_unit = std::fs::read_to_string("/proc/self/cgroup")
            .unwrap_or_default()
            .contains("zeromux-tmux.service");
        assert_eq!(h.in_unit, self_in_unit);
    }

    #[tokio::test]
    async fn empty_server_reports_not_found_not_other() {
        let Some(srv) = TestServer::start() else { return };
        srv.kill_boot();
        // exit-empty off keeps the empty server alive.
        assert!(srv.ctl.health().await.server, "empty server must stay up");
        assert_eq!(srv.ctl.has("zmx-nope").await, Ok(false));
        assert_eq!(srv.ctl.kill("zmx-nope").await, Ok(()));
        assert!(matches!(srv.ctl.info("zmx-nope").await, Err(TmuxError::NotFound)));
        assert!(matches!(srv.ctl.capture("zmx-nope", 10, 1000, false).await, Err(TmuxError::NotFound)));
        assert!(matches!(srv.ctl.set_mouse("zmx-nope", true).await, Err(TmuxError::NotFound)));
        assert_eq!(srv.ctl.refresh_client_for_pid(1).await, Err(TmuxError::NotFound));
        assert_eq!(srv.ctl.list().await.unwrap().len(), 0);
    }

    #[test]
    fn classify_zero_session_messages() {
        assert_eq!(classify_stderr("no current target\n"), TmuxError::NotFound);
        assert_eq!(classify_stderr("no such session: =x:\n"), TmuxError::NotFound);
    }

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
    fn scroll_route_matrix() {
        for in_mode in [false, true] {
            for alt in [false, true] {
                for mouse in [false, true] {
                    for sgr in [false, true] {
                        let want = if !in_mode && alt && mouse && sgr { ScrollRoute::AppWheel } else { ScrollRoute::CopyMode };
                        assert_eq!(scroll_route(in_mode, alt, mouse, sgr), want, "in_mode={in_mode} alt={alt} mouse={mouse} sgr={sgr}");
                    }
                }
            }
        }
    }

    #[test]
    fn wheel_seq_encodes_sgr() {
        assert_eq!(wheel_seq(ScrollOp::Up(2)).unwrap(), "\x1b[<64;1;1M\x1b[<64;1;1M");
        assert_eq!(wheel_seq(ScrollOp::Down(1)).unwrap(), "\x1b[<65;1;1M");
        assert_eq!(wheel_seq(ScrollOp::Top).unwrap().matches("\x1b[<64;1;1M").count(), 200);
        assert_eq!(wheel_seq(ScrollOp::Bottom).unwrap().matches("\x1b[<65;1;1M").count(), 200);
        assert!(wheel_seq(ScrollOp::Cancel).is_none());
    }

    #[test]
    fn conf_v2_disables_claude_alt_screen() {
        assert!(TMUX_CONF_VERSION >= 2);
        assert!(tmux_conf_text().contains("set-environment -g CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN 1"));
    }

    #[tokio::test]
    async fn scroll_in_fullscreen_mouse_app_sends_sgr_wheel() {
        let Some(srv) = TestServer::start() else { return };
        let dir = tempfile::tempdir().unwrap();   // removed on drop, even if an assert panics
        let log = dir.path().join("wheel.log");
        let cmd = format!("printf '\\033[?1049h\\033[?1000h\\033[?1006h'; exec cat -v > {}", log.display());
        srv.ctl.run(&["new-session", "-d", "-s", "zmx-w1", "-c", "/tmp", "sh", "-c", &cmd]).await.unwrap();
        let mut ready = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let i = srv.ctl.info("zmx-w1").await.unwrap();
            if i.alternate_on && i.mouse_any && i.mouse_sgr { ready = true; break; }
        }
        assert!(ready, "app never entered alt-screen + mouse mode");
        let (i, route) = srv.ctl.scroll("zmx-w1", ScrollOp::Up(3)).await.unwrap();
        assert_eq!(route, ScrollRoute::AppWheel);
        assert!(!i.in_mode, "must not enter copy-mode over a mouse-aware fullscreen app");
        // Cancel sends nothing in AppWheel mode.
        let (_, route) = srv.ctl.scroll("zmx-w1", ScrollOp::Cancel).await.unwrap();
        assert_eq!(route, ScrollRoute::AppWheel);
        // `cat -v` (line-buffered by the tty) only flushes on newline.
        srv.ctl.run(&["send-keys", "-t", "=zmx-w1:", "Enter"]).await.unwrap();
        let mut got = String::new();
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            got = std::fs::read_to_string(&log).unwrap_or_default();
            if got.contains('\n') { break; }
        }
        assert_eq!(got.matches("^[[<64;1;1M").count(), 3, "log: {got:?}");
        assert_eq!(got.trim_end(), "^[[<64;1;1M".repeat(3), "nothing else may reach the pane");
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
        let full = srv.ctl.capture("zmx-c1", 50_000, 5 * 1024 * 1024, false).await.unwrap();
        assert!(!full.truncated);
        assert!(full.text.lines().any(|l| l == "1"));
        assert!(full.text.lines().any(|l| l == "500"));
        let cut = srv.ctl.capture("zmx-c1", 50_000, 200, false).await.unwrap();
        assert!(cut.truncated);
        assert!(cut.text.len() <= 200);
        assert!(!cut.text.lines().any(|l| l == "1"), "head is dropped, tail kept");
    }

    #[tokio::test]
    async fn capture_ansi_keeps_sgr() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-a1").await;
        srv.ctl.run(&["send-keys", "-t", "=zmx-a1:", "printf '\\033[31mRED\\033[0m\\n'", "Enter"]).await.unwrap();
        // Poll (not a fixed sleep): under parallel `cargo test` the shell can be slow to start.
        let mut plain = String::new();
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            plain = srv.ctl.capture("zmx-a1", 100, 1 << 20, false).await.unwrap().text;
            if plain.lines().any(|l| l == "RED") { break; }
        }
        let color = srv.ctl.capture("zmx-a1", 100, 1 << 20, true).await.unwrap().text;
        assert!(!plain.contains('\x1b'));
        assert!(color.contains("\x1b[31m"));
    }

    #[tokio::test]
    async fn scroll_enters_and_leaves_copy_mode() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-s1").await;
        srv.ctl.run(&["send-keys", "-t", "=zmx-s1:", "seq 1 300", "Enter"]).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let (i, _) = srv.ctl.scroll("zmx-s1", ScrollOp::Up(5)).await.unwrap();
        assert!(i.in_mode);
        let (i, _) = srv.ctl.scroll("zmx-s1", ScrollOp::Top).await.unwrap();
        assert!(i.in_mode);
        let (i, _) = srv.ctl.scroll("zmx-s1", ScrollOp::Bottom).await.unwrap();
        assert!(!i.in_mode);
    }

    #[tokio::test]
    async fn cancel_outside_copy_mode_is_noop() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-q1").await;
        // Wait for the shell's startup banner (.bashrc/nvm) to fully land before
        // snapshotting. Under `cargo test`'s default parallelism, several
        // TestServer instances spawn real shells concurrently, and CPU
        // contention can push that beyond a short fixed sleep — poll instead of
        // a single wait to stay robust while keeping the ceiling well under the
        // test's own budget.
        let mut before = String::new();
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let snap = srv.ctl.capture("zmx-q1", 100, 1 << 20, false).await.unwrap().text;
            if !snap.trim().is_empty() && snap == before { break; }
            before = snap;
        }
        for op in [ScrollOp::Cancel, ScrollOp::Bottom, ScrollOp::Down(3)] {
            let (i, _) = srv.ctl.scroll("zmx-q1", op).await.unwrap();
            assert!(!i.in_mode);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let after = srv.ctl.capture("zmx-q1", 100, 1 << 20, false).await.unwrap().text;
        assert_eq!(before.trim_end(), after.trim_end(), "no keystrokes may reach the shell");
    }

    #[tokio::test]
    async fn refresh_unknown_pid_is_not_found() {
        let Some(srv) = TestServer::start() else { return };
        assert_eq!(srv.ctl.refresh_client_for_pid(1).await, Err(TmuxError::NotFound));
    }

    #[tokio::test]
    async fn set_mouse_is_per_session() {
        let Some(srv) = TestServer::start() else { return };
        mk(&srv, "zmx-m1").await;
        mk(&srv, "zmx-m2").await;
        srv.ctl.set_mouse("zmx-m1", false).await.unwrap();
        // show-options -t also takes a target-pane, like set-option (see set_mouse doc).
        let v1 = srv.ctl.run(&["show-options", "-v", "-t", "=zmx-m1:", "mouse"]).await.unwrap();
        let v2 = srv.ctl.run(&["show-options", "-v", "-t", "=zmx-m2:", "mouse"]).await.unwrap_or_default();
        assert_eq!(v1.trim(), "off");
        assert_ne!(v2.trim(), "off");
    }
}
