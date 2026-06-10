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
