//! 后台自动更新(本机原地升级):监视一个 build 路径,内容变了且无调度运行在跑
//! (交互 turn 可被 max_wait 穿透)时,经 detached systemd-run 原子替换自身+重启+
//! 健康检查回滚。默认关闭(无 --watch-build 即不启用)。见
//! docs/superpowers/specs/2026-06-10-background-auto-update-design.md。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Weak;
use std::time::Instant;
use crate::session_manager::RunningSummary;
use crate::session_manager::SessionManager;

/// 自动更新配置。字段来自受信启动 flag(运维提供,非用户输入),
/// 故可安全插值进 swap 脚本(评审 E8 插值安全说明)。
#[derive(Debug, Clone)]
pub struct AutoUpdateConfig {
    pub watch_path: PathBuf,     // --watch-build
    pub installed_path: PathBuf, // /usr/local/bin/zeromux(或 /proc/self/exe 解析)
    pub service_name: String,    // "zeromux"
    pub health_url: String,      // http://127.0.0.1:<port>/
    pub max_wait_secs: u64,      // --auto-update-max-wait
    pub poll_secs: u64,          // 固定 POLL_SECS(非 flag,设计如此)
}

/// 轮询间隔(秒)。刻意非 flag:30s 延迟对升级场景无所谓,见 spec。
pub const POLL_SECS: u64 = 30;

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
        // swap 经 launch_swap().await 内联等待,单任务循环天然无法在 swap 中途重入;
        // 若进程从失败 swap 存活,下一轮 tick 经 pending_since 从头重新评估。

        loop {
            tick.tick().await;

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
                    // E6: stop 前先冒烟新 binary
                    let smoke = std::process::Command::new(&cfg.watch_path)
                        .arg("--help")
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                    if !matches!(smoke, Ok(st) if st.success()) {
                        tracing::warn!("auto-update: new build failed --help smoke, skipping swap (no service disruption)");
                        // 清 pending:坏 build 不会自己变好;运维替换文件(stat 变)才重新触发。
                        pending_since = None;
                        continue;
                    }
                    tracing::info!("auto-update: upgradeable, launching swap via systemd-run");
                    let script = render_swap_script(&cfg);
                    launch_swap(&script).await;
                    // 到这里通常本进程已被 systemctl stop;若 systemd-run 返回了(swap 失败
                    // 但服务被 rollback 拉起),下一轮 tick 从头重试。
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
}
