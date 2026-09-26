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
}

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

fn classify_stderr(err: &str) -> TmuxError {
    if err.contains("error connecting to") || err.contains("no server running") {
        TmuxError::ServerDown
    } else if err.contains("can't find session") || err.contains("can't find pane")
        || err.contains("can't find window") || err.contains("session not found")
        || err.contains("no sessions") {
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
        // Wait for the shell's startup banner (.bashrc/nvm) to fully land before
        // snapshotting. Under `cargo test`'s default parallelism, several
        // TestServer instances spawn real shells concurrently, and CPU
        // contention can push that beyond a short fixed sleep — poll instead of
        // a single wait to stay robust while keeping the ceiling well under the
        // test's own budget.
        let mut before = String::new();
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let snap = srv.ctl.capture("zmx-q1", 100, 1 << 20).await.unwrap().text;
            if !snap.trim().is_empty() && snap == before { break; }
            before = snap;
        }
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
}
