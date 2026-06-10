//! 后台自动更新(本机原地升级):监视一个 build 路径,内容变了且无调度运行在跑
//! (交互 turn 可被 max_wait 穿透)时,经 detached systemd-run 原子替换自身+重启+
//! 健康检查回滚。默认关闭(无 --watch-build 即不启用)。见
//! docs/superpowers/specs/2026-06-10-background-auto-update-design.md。

use std::io::Read;
use std::path::Path;
use crate::session_manager::RunningSummary;

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
}
