use std::path::Path;
use base64::Engine;

#[derive(Clone)]
pub struct Vapid {
    pub pkcs8_pem: String,         // 私钥 PKCS8 PEM,喂 web-push from_pem
    pub public_key_b64url: String, // uncompressed point base64url,给前端 applicationServerKey
}

#[derive(serde::Serialize, serde::Deserialize)]
struct VapidFile {
    pkcs8_pem: String,
    public_key_b64url: String,
}

/// 读 ~/.zeromux/vapid.json;不存在则用 p256 生成 P-256 对、落盘(0600)。
pub fn load_or_generate_vapid(dir: &Path) -> Result<Vapid, String> {
    let path = dir.join("vapid.json");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(vf) = serde_json::from_slice::<VapidFile>(&bytes) {
            return Ok(Vapid {
                pkcs8_pem: vf.pkcs8_pem,
                public_key_b64url: vf.public_key_b64url,
            });
        }
    }
    // 生成
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePrivateKey;
    // p256 0.13 uses rand_core 0.6; access via elliptic_curve re-export to avoid version conflicts
    let mut rng = p256::elliptic_curve::rand_core::OsRng;
    let sk = SigningKey::random(&mut rng);
    let pkcs8_pem = sk
        .to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
        .map_err(|e| format!("pkcs8 pem: {e}"))?
        .to_string();
    // 公钥 uncompressed point (0x04 || X || Y) → base64url no-pad
    let vk = sk.verifying_key();
    let point = vk.to_encoded_point(false); // uncompressed
    let public_key_b64url =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(point.as_bytes());

    let vf = VapidFile {
        pkcs8_pem: pkcs8_pem.clone(),
        public_key_b64url: public_key_b64url.clone(),
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    let json = serde_json::to_vec_pretty(&vf).map_err(|e| format!("ser: {e}"))?;
    std::fs::write(&path, &json).map_err(|e| format!("write: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(Vapid {
        pkcs8_pem,
        public_key_b64url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn vapid_load_or_generate_idempotent() {
        let dir = std::env::temp_dir().join(format!("zmx-vapid-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let _ = fs::remove_file(dir.join("vapid.json"));
        let a = load_or_generate_vapid(&dir).unwrap();
        let b = load_or_generate_vapid(&dir).unwrap(); // 第二次应读回同一对
        assert_eq!(a.pkcs8_pem, b.pkcs8_pem);
        assert_eq!(a.public_key_b64url, b.public_key_b64url);
        assert!(a.pkcs8_pem.contains("BEGIN PRIVATE KEY")); // PKCS8
        assert!(!a.public_key_b64url.contains('+') && !a.public_key_b64url.contains('/')); // base64url 无 +/
        assert!(a.public_key_b64url.len() > 80); // uncompressed P-256 point = 65 bytes → ~87 b64url chars
        fs::remove_dir_all(&dir).ok();
    }
}
