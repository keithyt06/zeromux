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

/// 稳定门(E5)的一步决策结果。纯数据,便于单测。
#[derive(Debug, Clone, PartialEq, Eq)]
enum StabilityStep {
    /// 本轮无可评估内容(文件从未成功哈希过),跳过。
    Skip,
    /// 内容刚变化,记下新 sha,等下一轮确认(anti half-write)。
    WaitStable(String),
    /// 内容已稳定,用此 sha 继续 self-compare + gate。
    Proceed(String),
}

/// 纯函数:稳定门的一步决策(评审 E5)。
///
/// **修复的 bug:** 旧循环在 `stat` 未变时直接 `continue` 跳过,但稳定门要求
/// "连续两轮相同 sha 才算写完"——而未变文件的 sha 恰恰相同却因 stat 短路永不
/// 被复算,第二轮确认永远不发生 → 稳定门死锁 → 全自动更新对任何真实新 build
/// 永不触发(build 落定后 stat 即静止)。修复:把"stat 未变"当作稳定信号本身,
/// 复用缓存 sha 直接进入 self-compare/gate;而"stat 变化"仍走一轮 settle。
///
/// - `stat_changed`:本轮 (mtime,size) 是否与上轮不同。
/// - `fresh_sha`:仅当 `stat_changed` 时调用方计算的新 sha;否则 `None`。
/// - `last_seen_sha`:上一轮记录的 sha。
fn stability_step(
    stat_changed: bool,
    fresh_sha: Option<String>,
    last_seen_sha: Option<&str>,
) -> StabilityStep {
    match (stat_changed, fresh_sha) {
        // 内容刚变:新 sha 与上轮不同 → 等一轮确认写完;相同(纯 touch)→ 直接继续。
        (true, Some(sha)) => {
            if last_seen_sha != Some(sha.as_str()) {
                StabilityStep::WaitStable(sha)
            } else {
                StabilityStep::Proceed(sha)
            }
        }
        // 哈希失败(调用方已 continue),防御性 Skip 保持全函数化。
        (true, None) => StabilityStep::Skip,
        // stat 未变 = 文件已稳定:复用缓存 sha 继续;还没哈希过则跳过。
        (false, _) => match last_seen_sha {
            Some(s) => StabilityStep::Proceed(s.to_string()),
            None => StabilityStep::Skip,
        },
    }
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
        // 已冒烟失败的 build sha:稳定文件现在每轮都会 Proceed(修复稳定门死锁的
        // 代价),故记住坏 build 的 sha,避免每 30s 重跑 --help 冒烟 + 重复日志。
        // 运维替换文件(sha 变)即解除。
        let mut smoke_failed_sha: Option<String> = None;
        // swap 经 launch_swap().await 内联等待,单任务循环天然无法在 swap 中途重入;
        // 若进程从失败 swap 存活,下一轮 tick 经 pending_since 从头重新评估。

        loop {
            tick.tick().await;

            // 1. stat:变化才重算 sha,未变则复用缓存(未变即"已写完稳定"信号)。
            let meta = match std::fs::metadata(&cfg.watch_path) {
                Ok(m) => m,
                Err(_) => { tracing::debug!("auto-update: watch_path stat failed, skip"); continue; }
            };
            let stat = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len());
            let stat_changed = last_stat != Some(stat);
            last_stat = Some(stat);

            // 2. 仅在 stat 变化时算 sha(未变时哈希浪费且无信息)。
            let fresh_sha = if stat_changed {
                match sha256_file(&cfg.watch_path) {
                    Ok(s) => Some(s),
                    Err(_) => { continue; }
                }
            } else {
                None
            };

            // 3. sha 稳定门(E5):见 stability_step 文档 —— 修复 stat 短路使稳定门
            //    永不完成的死锁。stat 未变的稳定文件复用缓存 sha 直接进入 gate。
            let sha = match stability_step(stat_changed, fresh_sha, last_seen_sha.as_deref()) {
                StabilityStep::Skip => continue,
                StabilityStep::WaitStable(s) => {
                    tracing::info!("auto-update: build sha changed, waiting for stable (anti half-write)");
                    last_seen_sha = Some(s);
                    continue;
                }
                StabilityStep::Proceed(s) => {
                    last_seen_sha = Some(s.clone());
                    s
                }
            };

            // 坏 build 已冒烟失败过:静默跳过,直到文件被换掉(sha 变)。避免稳定
            // 文件每轮 Proceed 造成的重复冒烟 + 日志刷屏。
            if smoke_failed_sha.as_deref() == Some(sha.as_str()) {
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
                        // 清 pending:坏 build 不会自己变好;运维替换文件(sha 变)才重新触发。
                        // 记住此 sha,避免稳定坏 build 每轮重跑冒烟。
                        pending_since = None;
                        smoke_failed_sha = Some(sha.clone());
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
    fn stability_new_build_confirms_after_settle_tick() {
        // Regression for the stat-skip/stability-gate deadlock: a real build lands
        // once (stat changes on tick 1, then stays stable). It must confirm on the
        // NEXT tick (stat unchanged) and Proceed — the old loop `continue`d on the
        // unchanged stat and never re-confirmed, so it never upgraded.
        //
        // Tick 1: stat changed, fresh sha differs from last(None) → wait one tick.
        let s1 = stability_step(true, Some("aaaa".into()), None);
        assert_eq!(s1, StabilityStep::WaitStable("aaaa".into()));
        // Tick 2: file now stable → stat unchanged, no fresh sha. Must reuse the
        // cached "aaaa" and Proceed (the bug made this Skip forever).
        let s2 = stability_step(false, None, Some("aaaa"));
        assert_eq!(s2, StabilityStep::Proceed("aaaa".into()));
    }

    #[test]
    fn stability_half_write_still_gets_one_settle() {
        // A file mid-write changes its stat every tick with a different sha → keeps
        // resetting the confirmation, never Proceeds until it settles (anti
        // half-write, E5 preserved).
        let a = stability_step(true, Some("v1".into()), None);
        assert_eq!(a, StabilityStep::WaitStable("v1".into()));
        // Next tick still writing: stat changed again, new sha ≠ last → wait again.
        let b = stability_step(true, Some("v2".into()), Some("v1"));
        assert_eq!(b, StabilityStep::WaitStable("v2".into()));
        // Now settled: stat unchanged → Proceed with v2.
        let c = stability_step(false, None, Some("v2"));
        assert_eq!(c, StabilityStep::Proceed("v2".into()));
    }

    #[test]
    fn stability_never_hashed_skips() {
        // First tick ever, stat unchanged (equal to the None baseline is impossible,
        // but defensively) with nothing hashed yet → Skip, don't Proceed on empty.
        assert_eq!(stability_step(false, None, None), StabilityStep::Skip);
    }

    #[test]
    fn stability_touch_same_content_proceeds_immediately() {
        // mtime bumped but bytes identical (e.g. `touch`): stat changed, fresh sha ==
        // last seen → no need for another settle tick, Proceed.
        let s = stability_step(true, Some("same".into()), Some("same"));
        assert_eq!(s, StabilityStep::Proceed("same".into()));
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
