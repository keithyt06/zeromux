//! Hand-written SigV4 presigner for AWS Transcribe Streaming WebSocket.
//!
//! References:
//!   https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
//!   https://docs.aws.amazon.com/transcribe/latest/dg/websocket.html

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

/// Build a SigV4 presigned WebSocket URL for AWS Transcribe Streaming.
///
/// `now_iso8601`: timestamp in `YYYYMMDDTHHMMSSZ` form (UTC). Pass real time in production;
/// tests pass a fixed value.
pub fn presign_transcribe_url(
    creds: &AwsCredentials,
    region: &str,
    language: &str,
    sample_rate: u32,
    expires_seconds: u32,
    now_iso8601: &str,
) -> Result<String, String> {
    let service = "transcribe";
    let host = format!("transcribestreaming.{region}.amazonaws.com:8443");
    let path = "/stream-transcription-websocket";
    let date_stamp = now_iso8601
        .get(0..8)
        .ok_or_else(|| format!("invalid timestamp format: {now_iso8601}"))?;
    let credential_scope = format!("{date_stamp}/{region}/{service}/aws4_request");
    let credential_param = format!("{}/{credential_scope}", creds.access_key_id);

    let mut params: Vec<(String, String)> = vec![
        ("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into()),
        ("X-Amz-Credential".into(), credential_param),
        ("X-Amz-Date".into(), now_iso8601.into()),
        ("X-Amz-Expires".into(), expires_seconds.to_string()),
        ("X-Amz-SignedHeaders".into(), "host".into()),
        ("language-code".into(), language.into()),
        ("media-encoding".into(), "pcm".into()),
        ("sample-rate".into(), sample_rate.to_string()),
    ];
    if let Some(token) = creds.session_token.as_deref() {
        params.push(("X-Amz-Security-Token".into(), token.into()));
    }
    params.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let canonical_query = params
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_headers = format!("host:{host}\n");
    let signed_headers = "host";
    let payload_hash = "UNSIGNED-PAYLOAD";
    let canonical_request = format!(
        "GET\n{path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{now_iso8601}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac(
        format!("AWS4{}", creds.secret_access_key).as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    let k_signing = hmac(&k_service, b"aws4_request");

    let signature = hex::encode(hmac(&k_signing, string_to_sign.as_bytes()));

    Ok(format!(
        "wss://{host}{path}?{canonical_query}&X-Amz-Signature={signature}"
    ))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key size");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// AWS-style URI encoding: RFC3986 unreserved set is left untouched. Used for both query
/// keys and values. `encode_slash=true` encodes `/`; for path segments pass false.
fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || b == b'-'
            || b == b'_'
            || b == b'.'
            || b == b'~'
            || (b == b'/' && !encode_slash);
        if unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify the signing-key derivation matches AWS's documented test vector.
    /// https://docs.aws.amazon.com/IAM/latest/UserGuide/signature-v4-test-suite.html
    #[test]
    fn signing_key_derivation_matches_aws_test_vector() {
        let secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
        let date_stamp = "20150830";
        let region = "us-east-1";
        let service = "iam";

        let k_date = hmac(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
        let k_region = hmac(&k_date, region.as_bytes());
        let k_service = hmac(&k_region, service.as_bytes());
        let k_signing = hmac(&k_service, b"aws4_request");

        assert_eq!(
            hex::encode(&k_signing),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }

    #[test]
    fn presigned_transcribe_url_has_required_params() {
        let creds = AwsCredentials {
            access_key_id: "AKIDEXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
            session_token: None,
        };
        let url = presign_transcribe_url(&creds, "us-east-1", "zh-CN", 16000, 300, "20150830T123600Z").unwrap();

        assert!(
            url.starts_with("wss://transcribestreaming.us-east-1.amazonaws.com:8443/stream-transcription-websocket?"),
            "url: {url}"
        );
        assert!(url.contains("language-code=zh-CN"));
        assert!(url.contains("media-encoding=pcm"));
        assert!(url.contains("sample-rate=16000"));
        assert!(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(url.contains(
            "X-Amz-Credential=AKIDEXAMPLE%2F20150830%2Fus-east-1%2Ftranscribe%2Faws4_request"
        ));
        assert!(url.contains("X-Amz-Date=20150830T123600Z"));
        assert!(url.contains("X-Amz-Expires=300"));
        assert!(url.contains("X-Amz-SignedHeaders=host"));
        assert!(url.contains("X-Amz-Signature="));
    }

    #[test]
    fn session_token_is_included_when_present() {
        let creds = AwsCredentials {
            access_key_id: "AKIDEXAMPLE".to_string(),
            secret_access_key: "secret".to_string(),
            session_token: Some("FQoGZ/abc+def==".to_string()),
        };
        let url = presign_transcribe_url(&creds, "us-east-1", "zh-CN", 16000, 300, "20150830T123600Z").unwrap();

        assert!(
            url.contains("X-Amz-Security-Token=FQoGZ%2Fabc%2Bdef%3D%3D"),
            "url: {url}"
        );
    }
}
