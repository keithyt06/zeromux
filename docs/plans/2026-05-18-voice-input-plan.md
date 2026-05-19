# Voice Input (AWS Transcribe Streaming) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a push-to-talk microphone button next to the AcpChatView textarea that streams 16kHz PCM audio through a backend WebSocket proxy to AWS Transcribe Streaming, surfaces partial transcripts in a status preview, and appends finals to the textarea — never auto-sending.

**Architecture:** Browser captures audio via `getUserMedia` + AudioWorklet, downsamples to 16kHz Int16 PCM, sends through a same-origin `/ws/transcribe` WebSocket. Backend handler (`src/transcribe.rs`) opens a fresh AWS Transcribe Streaming WebSocket per browser connection using a hand-written SigV4 presigner (`src/aws_sigv4.rs`) and EventStream codec (`src/event_stream.rs`) — no `aws-sdk-*` deps to keep the binary small.

**Tech Stack:** Rust (axum 0.8, tokio, tokio-tungstenite 0.29, hmac, sha2, hex, crc32fast, reqwest), TypeScript (React 19, Web Audio API + AudioWorklet, vitest + @testing-library/react + happy-dom).

**Spec reference:** `docs/specs/2026-05-18-voice-input-design.md`

**Working directory:** Project root is `/home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux/`. All paths are relative to it unless prefixed with `frontend/`. Frontend commands run inside `frontend/`; backend commands run at the root.

---

## File Map

**New backend files:**
- `src/event_stream.rs` — AWS EventStream binary frame encoder/decoder (pure functions, no I/O)
- `src/aws_sigv4.rs` — SigV4 presigner for Transcribe Streaming + default credential chain loader (env / shared config / IMDSv2)
- `src/transcribe.rs` — `/ws/transcribe` axum handler that proxies between browser WS and AWS Transcribe Streaming WS

**Modified backend files:**
- `Cargo.toml` — add `tokio-tungstenite`, `hmac`, `crc32fast`
- `src/main.rs` — declare new modules
- `src/web.rs` — register `/ws/transcribe` route in the `ws` sub-router

**New frontend files:**
- `frontend/src/lib/pcmWorklet.ts` — AudioWorklet processor source as a string export
- `frontend/src/lib/transcribe.ts` — `useTranscribe()` hook (state machine, WS, audio capture)
- `frontend/src/components/MicButton.tsx` — push-to-talk button with pointer events
- `frontend/src/lib/transcribe.test.ts` — vitest tests for the hook
- `frontend/src/components/MicButton.test.tsx` — vitest tests for the button

**Modified frontend files:**
- `frontend/src/components/AcpChatView.tsx` — insert MicButton + partial preview row, wire `onFinal` to `setInput`

---

## Task 1: Add Cargo dependencies and verify version alignment

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Add dependencies to `Cargo.toml`**

In `[dependencies]` add (alphabetical position, just before `futures`):

```toml
crc32fast = "1"
hmac = "0.12"
tokio-tungstenite = { version = "0.29", features = ["rustls-tls-native-roots"] }
```

- [ ] **Step 2: Build to fetch deps**

Run: `cargo build`
Expected: clean build, deps resolved.

- [ ] **Step 3: Verify no dual `tungstenite` compile**

Run: `cargo tree -i tungstenite`
Expected: a single `tungstenite v0.29.x` entry with two parents (`tokio-tungstenite` and `axum`'s ws feature).

If two different `tungstenite` versions appear, **stop**: pin a `tokio-tungstenite` version that matches axum's transitive version (check Cargo.lock for the existing value).

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: add tokio-tungstenite, hmac, crc32fast for voice input"
```

---

## Task 2: EventStream codec — write failing tests first

**Files:**
- Create: `src/event_stream.rs`
- Modify: `src/main.rs` (declare module)

- [ ] **Step 1: Declare the module in `src/main.rs`**

Find the existing `mod` declarations (top of file, after `use` statements) and add:

```rust
mod event_stream;
```

- [ ] **Step 2: Create `src/event_stream.rs` with type stubs and failing tests**

```rust
//! AWS EventStream binary framing (subset used by Transcribe Streaming).
//!
//! Frame layout (big-endian):
//!   12-byte prelude: total_length u32, headers_length u32, prelude_crc u32
//!   headers (headers_length bytes): repeated key/type/value
//!   payload (total_length - headers_length - 16 bytes)
//!   message_crc u32 (CRC32 of all bytes preceding it)

use anyhow::{anyhow, bail, Result};

#[derive(Debug, PartialEq)]
pub enum DecodedFrame {
    /// `:message-type=event :event-type=TranscriptEvent` — payload is JSON
    TranscriptEvent { payload: Vec<u8> },
    /// `:message-type=exception` — payload is JSON; exception type in headers
    Exception { exception_type: String, payload: Vec<u8> },
    /// Anything else — pass through for forward-compat
    Other { message_type: String, payload: Vec<u8> },
}

/// Encode an `AudioEvent` frame. Headers:
///   :message-type = event
///   :event-type   = AudioEvent
///   :content-type = application/octet-stream
pub fn encode_audio_event(pcm: &[u8]) -> Vec<u8> {
    todo!()
}

/// Decode one frame from `buf`. Returns `Err` on CRC mismatch or malformed structure.
pub fn decode_event_message(buf: &[u8]) -> Result<DecodedFrame> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip: encode AudioEvent, then decode — should come back as Other (since we don't
    /// re-decode our own AudioEvent as a special variant; it's only sent, never received).
    #[test]
    fn audio_event_roundtrip_via_decoder() {
        let pcm: Vec<u8> = (0..32u8).collect();
        let frame = encode_audio_event(&pcm);

        // Frame must start with total_length matching frame.len()
        let total = u32::from_be_bytes(frame[0..4].try_into().unwrap());
        assert_eq!(total as usize, frame.len(), "total_length matches frame size");

        // Decode succeeds and payload bytes are preserved
        let decoded = decode_event_message(&frame).unwrap();
        match decoded {
            DecodedFrame::Other { message_type, payload } => {
                assert_eq!(message_type, "event");
                assert_eq!(payload, pcm);
            }
            other => panic!("expected Other(event), got {other:?}"),
        }
    }

    #[test]
    fn decode_rejects_bad_prelude_crc() {
        let mut frame = encode_audio_event(b"abc");
        // Corrupt the prelude CRC (bytes 8..12)
        frame[8] ^= 0xFF;
        let err = decode_event_message(&frame).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("crc"), "{err}");
    }

    #[test]
    fn decode_rejects_short_buffer() {
        let err = decode_event_message(&[0u8; 5]).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("short") || err.to_string().to_lowercase().contains("length"), "{err}");
    }
}
```

- [ ] **Step 3: Run the tests and confirm they fail to compile (todo!() panics)**

Run: `cargo test --lib event_stream`
Expected: tests compile but panic with `not yet implemented` (the `todo!()` macro).

- [ ] **Step 4: Implement `encode_audio_event`**

Replace the `todo!()` body of `encode_audio_event`:

```rust
pub fn encode_audio_event(pcm: &[u8]) -> Vec<u8> {
    // Headers: three string-typed entries. Type 7 = string.
    // Wire format per header:
    //   name_len u8 | name | value_type u8 | value_len u16 | value
    fn write_header(out: &mut Vec<u8>, name: &str, value: &str) {
        out.push(name.len() as u8);
        out.extend_from_slice(name.as_bytes());
        out.push(7); // string type
        out.extend_from_slice(&(value.len() as u16).to_be_bytes());
        out.extend_from_slice(value.as_bytes());
    }

    let mut headers = Vec::with_capacity(64);
    write_header(&mut headers, ":message-type", "event");
    write_header(&mut headers, ":event-type", "AudioEvent");
    write_header(&mut headers, ":content-type", "application/octet-stream");

    let total_len = 12 + headers.len() + pcm.len() + 4; // prelude + headers + payload + message_crc
    let headers_len = headers.len() as u32;

    let mut frame = Vec::with_capacity(total_len);
    frame.extend_from_slice(&(total_len as u32).to_be_bytes());
    frame.extend_from_slice(&headers_len.to_be_bytes());
    let prelude_crc = crc32fast::hash(&frame[0..8]);
    frame.extend_from_slice(&prelude_crc.to_be_bytes());
    frame.extend_from_slice(&headers);
    frame.extend_from_slice(pcm);
    let message_crc = crc32fast::hash(&frame);
    frame.extend_from_slice(&message_crc.to_be_bytes());
    frame
}
```

- [ ] **Step 5: Implement `decode_event_message`**

Replace the `todo!()` body of `decode_event_message`:

```rust
pub fn decode_event_message(buf: &[u8]) -> Result<DecodedFrame> {
    if buf.len() < 16 {
        bail!("frame too short: length={}", buf.len());
    }
    let total_len = u32::from_be_bytes(buf[0..4].try_into().unwrap()) as usize;
    let headers_len = u32::from_be_bytes(buf[4..8].try_into().unwrap()) as usize;
    let prelude_crc = u32::from_be_bytes(buf[8..12].try_into().unwrap());

    if total_len != buf.len() {
        bail!("total_length {} != buffer length {}", total_len, buf.len());
    }
    if crc32fast::hash(&buf[0..8]) != prelude_crc {
        bail!("prelude CRC mismatch");
    }
    let message_crc_offset = total_len - 4;
    let message_crc = u32::from_be_bytes(buf[message_crc_offset..total_len].try_into().unwrap());
    if crc32fast::hash(&buf[0..message_crc_offset]) != message_crc {
        bail!("message CRC mismatch");
    }

    // Parse headers
    let headers_start = 12;
    let headers_end = headers_start + headers_len;
    if headers_end + 4 > total_len {
        bail!("headers_length {} overruns frame", headers_len);
    }
    let mut i = headers_start;
    let mut message_type = String::new();
    let mut event_type = String::new();
    let mut exception_type = String::new();
    while i < headers_end {
        // name_len u8 | name | value_type u8 | value_len u16 | value
        if i + 1 > headers_end { bail!("truncated header name length"); }
        let name_len = buf[i] as usize;
        i += 1;
        if i + name_len > headers_end { bail!("truncated header name"); }
        let name = std::str::from_utf8(&buf[i..i + name_len])
            .map_err(|_| anyhow!("non-utf8 header name"))?
            .to_string();
        i += name_len;
        if i + 1 > headers_end { bail!("truncated header type"); }
        let value_type = buf[i];
        i += 1;
        if value_type != 7 {
            // We only consume string headers; skip unknown types by trying to read u16 len.
            // This is a deliberate simplification — Transcribe Streaming uses string-typed
            // headers exclusively for the cases we care about.
            if i + 2 > headers_end { bail!("truncated header value len for type {}", value_type); }
            let value_len = u16::from_be_bytes(buf[i..i + 2].try_into().unwrap()) as usize;
            i += 2 + value_len;
            if i > headers_end { bail!("truncated unknown-type header value"); }
            continue;
        }
        if i + 2 > headers_end { bail!("truncated header value length"); }
        let value_len = u16::from_be_bytes(buf[i..i + 2].try_into().unwrap()) as usize;
        i += 2;
        if i + value_len > headers_end { bail!("truncated header value"); }
        let value = std::str::from_utf8(&buf[i..i + value_len])
            .map_err(|_| anyhow!("non-utf8 header value"))?
            .to_string();
        i += value_len;
        match name.as_str() {
            ":message-type" => message_type = value,
            ":event-type" => event_type = value,
            ":exception-type" => exception_type = value,
            _ => {}
        }
    }

    let payload = buf[headers_end..message_crc_offset].to_vec();

    match (message_type.as_str(), event_type.as_str()) {
        ("event", "TranscriptEvent") => Ok(DecodedFrame::TranscriptEvent { payload }),
        ("exception", _) => Ok(DecodedFrame::Exception { exception_type, payload }),
        (mt, _) => Ok(DecodedFrame::Other { message_type: mt.to_string(), payload }),
    }
}
```

- [ ] **Step 6: Run the tests — should pass now**

Run: `cargo test --lib event_stream`
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/event_stream.rs src/main.rs
git commit -m "feat(transcribe): add EventStream binary frame codec"
```

---

## Task 3: SigV4 presigner — write failing tests first

**Files:**
- Create: `src/aws_sigv4.rs`
- Modify: `src/main.rs` (declare module)

- [ ] **Step 1: Declare the module in `src/main.rs`**

Add another line below `mod event_stream;`:

```rust
mod aws_sigv4;
```

- [ ] **Step 2: Create `src/aws_sigv4.rs` with stubs and a failing AWS test-vector test**

The AWS Sigv4 docs ship official test vectors. We use one for a presigned GET to `service=service`, which is the simplest, then prove our generic helper produces the same canonical request and signature. After that we add the Transcribe-specific URL builder.

```rust
//! Hand-written SigV4 presigner for AWS Transcribe Streaming WebSocket.
//!
//! References:
//!   https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
//!   https://docs.aws.amazon.com/transcribe/latest/dg/websocket.html

use anyhow::{anyhow, Result};
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
    language: &str,        // e.g. "zh-CN"
    sample_rate: u32,      // 16000
    expires_seconds: u32,  // 300
    now_iso8601: &str,
) -> Result<String> {
    todo!()
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

        // Expected from AWS docs: c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9
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

        assert!(url.starts_with("wss://transcribestreaming.us-east-1.amazonaws.com:8443/stream-transcription-websocket?"), "url: {url}");
        assert!(url.contains("language-code=zh-CN"));
        assert!(url.contains("media-encoding=pcm"));
        assert!(url.contains("sample-rate=16000"));
        assert!(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(url.contains("X-Amz-Credential=AKIDEXAMPLE%2F20150830%2Fus-east-1%2Ftranscribe%2Faws4_request"));
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

        // Session token must be URL-encoded as a query parameter named X-Amz-Security-Token
        assert!(url.contains("X-Amz-Security-Token=FQoGZ%2Fabc%2Bdef%3D%3D"), "url: {url}");
    }
}
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `cargo test --lib aws_sigv4`
Expected: `signing_key_derivation_matches_aws_test_vector` passes (uses helpers only). The two `presign_transcribe_url` tests panic with `not yet implemented`.

- [ ] **Step 4: Implement `presign_transcribe_url`**

Replace the `todo!()` body:

```rust
pub fn presign_transcribe_url(
    creds: &AwsCredentials,
    region: &str,
    language: &str,
    sample_rate: u32,
    expires_seconds: u32,
    now_iso8601: &str,
) -> Result<String> {
    let service = "transcribe";
    let host = format!("transcribestreaming.{region}.amazonaws.com:8443");
    let path = "/stream-transcription-websocket";
    let date_stamp = now_iso8601
        .get(0..8)
        .ok_or_else(|| anyhow!("invalid timestamp format: {now_iso8601}"))?;
    let credential_scope = format!("{date_stamp}/{region}/{service}/aws4_request");
    let credential_param = format!("{}/{credential_scope}", creds.access_key_id);

    // Build query parameters in CANONICAL order (sorted by key, value-sorted on ties).
    // We start with all parameters except X-Amz-Signature (which depends on the canonical
    // request). Each value must be URI-encoded per RFC3986 (NOT form-urlencoded).
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

    // canonical request:
    //   method\npath\nquery\nheaders\n\nsigned_headers\npayload_hash
    let canonical_headers = format!("host:{host}\n");
    let signed_headers = "host";
    let payload_hash = "UNSIGNED-PAYLOAD"; // SigV4 streaming convention
    let canonical_request = format!(
        "GET\n{path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    // string-to-sign:
    //   AWS4-HMAC-SHA256\ntimestamp\ncredential_scope\nhash(canonical_request)
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{now_iso8601}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    // 4-step derived signing key
    let k_date = hmac(format!("AWS4{}", creds.secret_access_key).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    let k_signing = hmac(&k_service, b"aws4_request");

    let signature = hex::encode(hmac(&k_signing, string_to_sign.as_bytes()));

    Ok(format!("wss://{host}{path}?{canonical_query}&X-Amz-Signature={signature}"))
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
```

- [ ] **Step 5: Run tests — confirm all three pass**

Run: `cargo test --lib aws_sigv4`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/aws_sigv4.rs src/main.rs
git commit -m "feat(transcribe): add SigV4 presigner for Transcribe Streaming"
```

---

## Task 4: Default credential chain loader

**Files:**
- Modify: `src/aws_sigv4.rs`

The chain order: env vars → shared config (`~/.aws/credentials [default]`) → IMDSv2. Region resolution: `AWS_REGION`/`AWS_DEFAULT_REGION` env → `~/.aws/config` → IMDS metadata.

- [ ] **Step 1: Add a failing test for the env path**

Append to the `#[cfg(test)] mod tests` block in `src/aws_sigv4.rs`:

```rust
#[test]
fn loads_credentials_from_env_vars() {
    // Use unique names to avoid leaking into other tests
    std::env::set_var("AWS_ACCESS_KEY_ID", "AKIDFROMENV");
    std::env::set_var("AWS_SECRET_ACCESS_KEY", "SECRETFROMENV");
    std::env::set_var("AWS_SESSION_TOKEN", "TOKENFROMENV");
    std::env::set_var("AWS_REGION", "ap-northeast-1");

    let (creds, region) = load_credentials_blocking_for_test().unwrap();

    assert_eq!(creds.access_key_id, "AKIDFROMENV");
    assert_eq!(creds.secret_access_key, "SECRETFROMENV");
    assert_eq!(creds.session_token.as_deref(), Some("TOKENFROMENV"));
    assert_eq!(region, "ap-northeast-1");

    std::env::remove_var("AWS_ACCESS_KEY_ID");
    std::env::remove_var("AWS_SECRET_ACCESS_KEY");
    std::env::remove_var("AWS_SESSION_TOKEN");
    std::env::remove_var("AWS_REGION");
}
```

Note: this test mutates process env, so it must be the only test running env mutation. Vitest/tokio tests are serial within a single binary by default for the `--test-threads=1` model, but cargo runs in parallel. We address this by feature-gating `load_credentials_blocking_for_test` behind `#[cfg(test)]` and only mutating envs that don't conflict with other tests.

- [ ] **Step 2: Run test to confirm it fails to compile**

Run: `cargo test --lib aws_sigv4`
Expected: compile error: `cannot find function 'load_credentials_blocking_for_test'`.

- [ ] **Step 3: Implement env-based loader**

Append to `src/aws_sigv4.rs` (above the test block):

```rust
/// Load AWS credentials and region using the default chain:
///   1. Environment variables
///   2. Shared config (`~/.aws/credentials [default]` + `~/.aws/config`)
///   3. IMDSv2 (EC2 instance metadata)
pub async fn load_default_credentials() -> Result<(AwsCredentials, String)> {
    // 1. Env
    if let Some(creds) = load_from_env() {
        let region = resolve_region_from_env_or_config().await?;
        return Ok((creds, region));
    }
    // 2. Shared config
    if let Some(creds) = load_from_shared_config().await {
        let region = resolve_region_from_env_or_config().await?;
        return Ok((creds, region));
    }
    // 3. IMDSv2
    if let Some((creds, imds_region)) = load_from_imdsv2().await {
        let region = match resolve_region_from_env_or_config().await {
            Ok(r) => r,
            Err(_) => imds_region,
        };
        return Ok((creds, region));
    }
    Err(anyhow!("AWS credentials not configured (env, ~/.aws/credentials, IMDS all empty)"))
}

fn load_from_env() -> Option<AwsCredentials> {
    let access = std::env::var("AWS_ACCESS_KEY_ID").ok()?;
    let secret = std::env::var("AWS_SECRET_ACCESS_KEY").ok()?;
    let token = std::env::var("AWS_SESSION_TOKEN").ok();
    Some(AwsCredentials {
        access_key_id: access,
        secret_access_key: secret,
        session_token: token,
    })
}

async fn resolve_region_from_env_or_config() -> Result<String> {
    if let Ok(r) = std::env::var("AWS_REGION") {
        if !r.is_empty() { return Ok(r); }
    }
    if let Ok(r) = std::env::var("AWS_DEFAULT_REGION") {
        if !r.is_empty() { return Ok(r); }
    }
    if let Some(r) = read_shared_config_region().await {
        return Ok(r);
    }
    Err(anyhow!("AWS region not configured (set AWS_REGION env or [default] region in ~/.aws/config)"))
}

async fn read_shared_config_region() -> Option<String> {
    let path = home_dir()?.join(".aws").join("config");
    let text = tokio::fs::read_to_string(path).await.ok()?;
    parse_ini_default_section(&text).get("region").cloned()
}

async fn load_from_shared_config() -> Option<AwsCredentials> {
    let path = home_dir()?.join(".aws").join("credentials");
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let kv = parse_ini_default_section(&text);
    let access = kv.get("aws_access_key_id")?.clone();
    let secret = kv.get("aws_secret_access_key")?.clone();
    let token = kv.get("aws_session_token").cloned();
    Some(AwsCredentials {
        access_key_id: access,
        secret_access_key: secret,
        session_token: token,
    })
}

fn parse_ini_default_section(text: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let mut in_default = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') { continue; }
        if line.starts_with('[') {
            in_default = line == "[default]";
            continue;
        }
        if !in_default { continue; }
        if let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    out
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

async fn load_from_imdsv2() -> Option<(AwsCredentials, String)> {
    // IMDSv2: PUT /latest/api/token then GET role + creds
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1000))
        .build()
        .ok()?;
    let token = client
        .put("http://169.254.169.254/latest/api/token")
        .header("X-aws-ec2-metadata-token-ttl-seconds", "60")
        .send().await.ok()?
        .text().await.ok()?;

    let role = client
        .get("http://169.254.169.254/latest/meta-data/iam/security-credentials/")
        .header("X-aws-ec2-metadata-token", &token)
        .send().await.ok()?
        .text().await.ok()?;
    if role.trim().is_empty() { return None; }

    let creds_url = format!(
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/{}",
        role.trim()
    );
    let body: serde_json::Value = client
        .get(&creds_url)
        .header("X-aws-ec2-metadata-token", &token)
        .send().await.ok()?
        .json().await.ok()?;

    let access = body.get("AccessKeyId")?.as_str()?.to_string();
    let secret = body.get("SecretAccessKey")?.as_str()?.to_string();
    let session = body.get("Token")?.as_str()?.to_string();

    let region: String = client
        .get("http://169.254.169.254/latest/meta-data/placement/region")
        .header("X-aws-ec2-metadata-token", &token)
        .send().await.ok()?
        .text().await.ok()?
        .trim()
        .to_string();

    Some((
        AwsCredentials { access_key_id: access, secret_access_key: secret, session_token: Some(session) },
        region,
    ))
}

#[cfg(test)]
fn load_credentials_blocking_for_test() -> Result<(AwsCredentials, String)> {
    // Sync wrapper that runs only env + shared-config paths so we can test deterministically.
    // We avoid IMDS in tests (would block on the 1s timeout).
    if let Some(creds) = load_from_env() {
        let region = std::env::var("AWS_REGION")
            .or_else(|_| std::env::var("AWS_DEFAULT_REGION"))
            .map_err(|_| anyhow!("region not set in env"))?;
        return Ok((creds, region));
    }
    Err(anyhow!("no creds in env"))
}
```

- [ ] **Step 4: Run tests — confirm all 4 pass**

Run: `cargo test --lib aws_sigv4 -- --test-threads=1`
Expected: 4 tests pass. Single-threaded mode prevents env-var races.

- [ ] **Step 5: Commit**

```bash
git add src/aws_sigv4.rs
git commit -m "feat(transcribe): default credential chain (env/shared-config/IMDSv2)"
```

---

## Task 5: Define the wire protocol types in `transcribe.rs`

**Files:**
- Create: `src/transcribe.rs`
- Modify: `src/main.rs` (declare module)

This task lays down types and the empty axum handler signature, plus a unit test on payload deserialization. No real WS plumbing yet.

- [ ] **Step 1: Declare the module**

In `src/main.rs`, below the existing `mod aws_sigv4;`:

```rust
mod transcribe;
```

- [ ] **Step 2: Create `src/transcribe.rs` with types and a failing parse test**

```rust
//! WebSocket handler that proxies browser audio to AWS Transcribe Streaming.
//!
//! See `docs/specs/2026-05-18-voice-input-design.md`.

use crate::AppState;
use axum::extract::{ws::WebSocketUpgrade, Query, State};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Inbound JSON frame from browser
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ClientFrame {
    #[serde(rename = "start")]
    Start { language: String },
    #[serde(rename = "stop")]
    Stop,
}

/// Outbound JSON frame to browser
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ServerFrame {
    #[serde(rename = "partial")]
    Partial { text: String },
    #[serde(rename = "final")]
    Final { text: String },
    #[serde(rename = "error")]
    Error { message: String },
}

/// Subset of the AWS Transcribe Streaming `TranscriptEvent` JSON payload.
#[derive(Debug, Deserialize)]
pub struct TranscriptEvent {
    #[serde(rename = "Transcript")]
    pub transcript: TranscriptBody,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptBody {
    #[serde(rename = "Results")]
    pub results: Vec<TranscriptResult>,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptResult {
    #[serde(rename = "IsPartial")]
    pub is_partial: bool,
    #[serde(rename = "Alternatives")]
    pub alternatives: Vec<TranscriptAlternative>,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptAlternative {
    #[serde(rename = "Transcript")]
    pub transcript: String,
}

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

pub async fn transcribe_ws(
    _ws: WebSocketUpgrade,
    Query(_query): Query<WsQuery>,
    State(_state): State<Arc<AppState>>,
) -> Response {
    // Implemented in a later task. Empty handler to allow route registration today.
    axum::http::Response::builder()
        .status(501)
        .body(axum::body::Body::from("not implemented yet"))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_aws_partial_transcript_payload() {
        let json = br#"{
            "Transcript": {
                "Results": [{
                    "IsPartial": true,
                    "Alternatives": [{"Transcript": "你好世"}]
                }]
            }
        }"#;
        let evt: TranscriptEvent = serde_json::from_slice(json).unwrap();
        assert_eq!(evt.transcript.results.len(), 1);
        assert!(evt.transcript.results[0].is_partial);
        assert_eq!(evt.transcript.results[0].alternatives[0].transcript, "你好世");
    }

    #[test]
    fn parses_aws_final_transcript_payload() {
        let json = br#"{
            "Transcript": {
                "Results": [{
                    "IsPartial": false,
                    "Alternatives": [{"Transcript": "你好世界。"}]
                }]
            }
        }"#;
        let evt: TranscriptEvent = serde_json::from_slice(json).unwrap();
        assert!(!evt.transcript.results[0].is_partial);
    }

    #[test]
    fn empty_results_is_valid() {
        // AWS sends events with empty Results[] when no speech yet
        let json = br#"{"Transcript": {"Results": []}}"#;
        let evt: TranscriptEvent = serde_json::from_slice(json).unwrap();
        assert!(evt.transcript.results.is_empty());
    }

    #[test]
    fn client_frame_start_parses() {
        let json = br#"{"type":"start","language":"zh-CN"}"#;
        let f: ClientFrame = serde_json::from_slice(json).unwrap();
        match f {
            ClientFrame::Start { language } => assert_eq!(language, "zh-CN"),
            _ => panic!("wrong variant"),
        }
    }
}
```

- [ ] **Step 3: Run tests — should pass**

Run: `cargo test --lib transcribe`
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/transcribe.rs src/main.rs
git commit -m "feat(transcribe): add wire protocol types + handler stub"
```

---

## Task 6: Register the `/ws/transcribe` route

**Files:**
- Modify: `src/web.rs`

- [ ] **Step 1: Find the existing `ws` sub-router**

In `src/web.rs`, find the block that starts:

```rust
let ws = Router::new()
    .route(
        "/ws/term/{session_id}",
        get(crate::ws_handler::ws_terminal),
    )
    .route(
        "/ws/acp/{session_id}",
        get(crate::acp::ws_handler::ws_acp),
    );
```

- [ ] **Step 2: Add the new route**

Replace the block with:

```rust
let ws = Router::new()
    .route(
        "/ws/term/{session_id}",
        get(crate::ws_handler::ws_terminal),
    )
    .route(
        "/ws/acp/{session_id}",
        get(crate::acp::ws_handler::ws_acp),
    )
    .route(
        "/ws/transcribe",
        get(crate::transcribe::transcribe_ws),
    );
```

- [ ] **Step 3: Build to verify route compiles**

Run: `cargo build`
Expected: clean build.

- [ ] **Step 4: Smoke-test with curl**

Start the server in a background terminal: `cargo run --release -- --port 8989 --password test`. Then:

```bash
# Without token: should 401
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "http://127.0.0.1:8989/ws/transcribe"
# Expected: 501 (handler stub) — auth check not implemented yet, so 501 means routing works
```

Stop the server (Ctrl-C) before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/web.rs
git commit -m "feat(transcribe): register /ws/transcribe route"
```

---

## Task 7: Implement auth + WS upgrade in `transcribe_ws`

**Files:**
- Modify: `src/transcribe.rs`

This task wires up auth (so 401 is returned when no token) and accepts the WS upgrade. We do NOT yet connect to AWS — instead, the handler echoes whatever JSON the client sends, plus emits a fake `partial` after `start` and a fake `final` after `stop`. This lets us hand-test the full browser ↔ backend protocol independently of AWS.

- [ ] **Step 1: Replace the handler body**

In `src/transcribe.rs`, replace the entire `pub async fn transcribe_ws` with:

```rust
pub async fn transcribe_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let authed = query
        .token
        .as_deref()
        .and_then(|t| crate::auth::verify_ws_token(&state, t))
        .is_some();
    if !authed {
        return axum::http::Response::builder()
            .status(401)
            .body(axum::body::Body::from("unauthorized"))
            .unwrap();
    }
    ws.on_upgrade(handle_socket_stub)
}
```

- [ ] **Step 2: Add the stub `handle_socket_stub` function**

Below the handler, add:

```rust
async fn handle_socket_stub(mut socket: axum::extract::ws::WebSocket) {
    use axum::extract::ws::Message;
    let mut audio_bytes_received: usize = 0;

    while let Some(msg) = socket.recv().await {
        let Ok(msg) = msg else { break };
        match msg {
            Message::Text(text) => {
                let frame: Result<ClientFrame, _> = serde_json::from_str(&text);
                match frame {
                    Ok(ClientFrame::Start { language }) => {
                        tracing::info!("transcribe stub: start language={language}");
                        let _ = send_server_frame(
                            &mut socket,
                            &ServerFrame::Partial { text: format!("[stub partial for {language}]") },
                        ).await;
                    }
                    Ok(ClientFrame::Stop) => {
                        let _ = send_server_frame(
                            &mut socket,
                            &ServerFrame::Final {
                                text: format!("[stub final, audio_bytes={audio_bytes_received}]"),
                            },
                        ).await;
                        let _ = socket.close().await;
                        return;
                    }
                    Err(e) => {
                        let _ = send_server_frame(
                            &mut socket,
                            &ServerFrame::Error { message: format!("invalid JSON frame: {e}") },
                        ).await;
                    }
                }
            }
            Message::Binary(b) => {
                audio_bytes_received += b.len();
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

async fn send_server_frame(
    socket: &mut axum::extract::ws::WebSocket,
    frame: &ServerFrame,
) -> Result<(), axum::Error> {
    let json = serde_json::to_string(frame).expect("ServerFrame is always serializable");
    socket.send(axum::extract::ws::Message::Text(json.into())).await
}
```

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: clean build.

- [ ] **Step 4: Run all backend tests to make sure nothing broke**

Run: `cargo test --lib -- --test-threads=1`
Expected: all event_stream + aws_sigv4 + transcribe tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/transcribe.rs
git commit -m "feat(transcribe): WS upgrade + auth + stub handler echoing fake partial/final"
```

---

## Task 8: Implement the real AWS proxy in `transcribe.rs`

**Files:**
- Modify: `src/transcribe.rs`

This is the largest task. It replaces the stub with a real proxy: load credentials → presign URL → connect to AWS WS → bidirectional pump.

- [ ] **Step 1: Add the AWS connection helper**

At the top of `src/transcribe.rs` add imports:

```rust
use crate::aws_sigv4;
use crate::event_stream;
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::protocol::Message as TtMessage;
```

(Keep existing imports above. The full top-of-file `use` block should now have these added.)

- [ ] **Step 2: Replace the stub handler with the real one**

In `src/transcribe.rs`, replace the existing `transcribe_ws` body's call to `ws.on_upgrade(handle_socket_stub)` with:

```rust
    ws.on_upgrade(handle_socket)
```

Then **delete** `handle_socket_stub` and replace it with a new `handle_socket`:

```rust
async fn handle_socket(mut browser_ws: axum::extract::ws::WebSocket) {
    use axum::extract::ws::Message as BrowserMsg;

    // Wait for the first frame: must be `{"type":"start","language":...}`
    let language = match browser_ws.recv().await {
        Some(Ok(BrowserMsg::Text(t))) => match serde_json::from_str::<ClientFrame>(&t) {
            Ok(ClientFrame::Start { language }) => language,
            Ok(_) => {
                let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: "first frame must be start".into() }).await;
                return;
            }
            Err(e) => {
                let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: format!("invalid start frame: {e}") }).await;
                return;
            }
        },
        _ => return,
    };

    // Load credentials + region
    let (creds, region) = match aws_sigv4::load_default_credentials().await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("AWS creds load failed: {e}");
            let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: e.to_string() }).await;
            return;
        }
    };

    let now_iso8601 = format_now_iso8601();
    let url = match aws_sigv4::presign_transcribe_url(&creds, &region, &language, 16000, 300, &now_iso8601) {
        Ok(u) => u,
        Err(e) => {
            tracing::error!("presign failed: {e}");
            let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: e.to_string() }).await;
            return;
        }
    };

    let (aws_ws_stream, _) = match tokio_tungstenite::connect_async(&url).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("AWS connect failed: {e}");
            let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: format!("AWS connection failed: {e}") }).await;
            return;
        }
    };
    let (mut aws_sink, mut aws_stream) = aws_ws_stream.split();

    // Bidirectional pump using tokio::select!.
    // Browser → AWS:  binary PCM → encode_audio_event → AWS WS binary frame
    // AWS → Browser:  AWS binary frame → decode → JSON ServerFrame → browser WS text
    loop {
        tokio::select! {
            browser = browser_ws.recv() => {
                match browser {
                    Some(Ok(BrowserMsg::Binary(pcm))) => {
                        let frame = event_stream::encode_audio_event(&pcm);
                        if let Err(e) = aws_sink.send(TtMessage::Binary(frame.into())).await {
                            tracing::error!("AWS send failed: {e}");
                            let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: format!("AWS send failed: {e}") }).await;
                            break;
                        }
                    }
                    Some(Ok(BrowserMsg::Text(t))) => {
                        if matches!(serde_json::from_str::<ClientFrame>(&t), Ok(ClientFrame::Stop)) {
                            // Send empty AudioEvent to flush, then close AWS side
                            let _ = aws_sink.send(TtMessage::Binary(event_stream::encode_audio_event(&[]).into())).await;
                            let _ = aws_sink.close().await;
                            // Drain any final AWS messages after close in the AWS arm below.
                        }
                    }
                    Some(Ok(BrowserMsg::Close(_))) | None => {
                        let _ = aws_sink.close().await;
                        break;
                    }
                    Some(Err(e)) => {
                        tracing::error!("browser ws error: {e}");
                        break;
                    }
                    _ => {}
                }
            }
            aws = aws_stream.next() => {
                match aws {
                    Some(Ok(TtMessage::Binary(b))) => {
                        match event_stream::decode_event_message(&b) {
                            Ok(event_stream::DecodedFrame::TranscriptEvent { payload }) => {
                                if let Ok(evt) = serde_json::from_slice::<TranscriptEvent>(&payload) {
                                    for r in evt.transcript.results {
                                        if let Some(alt) = r.alternatives.first() {
                                            let frame = if r.is_partial {
                                                ServerFrame::Partial { text: alt.transcript.clone() }
                                            } else {
                                                ServerFrame::Final { text: alt.transcript.clone() }
                                            };
                                            if send_server_frame(&mut browser_ws, &frame).await.is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(event_stream::DecodedFrame::Exception { exception_type, payload }) => {
                                let msg = std::str::from_utf8(&payload).unwrap_or("unknown");
                                tracing::error!("AWS exception {}: {}", exception_type, msg);
                                let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: format!("AWS {}: {}", exception_type, msg) }).await;
                                break;
                            }
                            Ok(event_stream::DecodedFrame::Other { .. }) => { /* ignore unknown */ }
                            Err(e) => {
                                tracing::error!("AWS frame decode failed: {e}");
                            }
                        }
                    }
                    Some(Ok(TtMessage::Close(_))) | None => break,
                    Some(Err(e)) => {
                        tracing::error!("AWS ws error: {e}");
                        let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: format!("AWS connection lost: {e}") }).await;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = browser_ws.close().await;
}

fn format_now_iso8601() -> String {
    // YYYYMMDDTHHMMSSZ. We use chrono via the `time` crate if available; std doesn't format dates.
    // Workaround: format using std + a tiny helper. Avoid pulling chrono just for this.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch");
    let total_secs = now.as_secs();
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(total_secs);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

/// Convert UNIX epoch seconds to (y, mo, d, h, mi, s) UTC. Civil-from-days algorithm
/// from Howard Hinnant's date library: https://howardhinnant.github.io/date_algorithms.html
fn epoch_to_ymdhms(t: u64) -> (u32, u32, u32, u32, u32, u32) {
    let s = (t % 86_400) as u32;
    let h = s / 3600;
    let mi = (s % 3600) / 60;
    let se = s % 60;
    let days = (t / 86_400) as i64;
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (y + if mo <= 2 { 1 } else { 0 }) as u32;
    (y, mo, d, h, mi, se)
}

#[cfg(test)]
mod time_tests {
    use super::epoch_to_ymdhms;
    #[test]
    fn known_epochs() {
        // 2015-08-30T12:36:00Z = 1440938160
        assert_eq!(epoch_to_ymdhms(1_440_938_160), (2015, 8, 30, 12, 36, 0));
        // 2026-05-18T00:00:00Z = 1768912000? compute by hand:
        //   We just verify by round-tripping a sane modern date.
        let (y, mo, d, _, _, _) = epoch_to_ymdhms(1_747_872_000);
        assert!(y >= 2025 && y <= 2027, "year {y}");
        assert!((1..=12).contains(&mo));
        assert!((1..=31).contains(&d));
    }
}
```

- [ ] **Step 3: Make sure `send_server_frame` is still defined**

Verify the helper from Task 7 step 2 is still in the file (we didn't delete it). If you accidentally removed it during the replacement, re-add:

```rust
async fn send_server_frame(
    socket: &mut axum::extract::ws::WebSocket,
    frame: &ServerFrame,
) -> Result<(), axum::Error> {
    let json = serde_json::to_string(frame).expect("ServerFrame is always serializable");
    socket.send(axum::extract::ws::Message::Text(json.into())).await
}
```

- [ ] **Step 4: Build and run all tests**

```bash
cargo build
cargo test --lib -- --test-threads=1
```

Expected: clean build, all tests pass (including the new `time_tests::known_epochs`).

- [ ] **Step 5: Manual smoke test against AWS (requires real credentials)**

Set up env, then start the server:

```bash
export AWS_REGION=us-east-1   # or your nearest region
# ensure AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY are set, or ~/.aws/credentials exists
# IAM permissions needed: transcribe:StartStreamTranscription
cargo run --release -- --port 8989 --password test
```

In another terminal, test the protocol with [websocat](https://github.com/vi/websocat) (install: `cargo install websocat` if needed):

```bash
# Get a JWT token (legacy mode):
TOKEN=$(curl -sX POST http://127.0.0.1:8989/auth/login -H 'content-type: application/json' -d '{"password":"test"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# Open WS, send start, send some PCM (silence), receive frames
( echo '{"type":"start","language":"zh-CN"}'; sleep 1; echo -n '' ) | \
  websocat "ws://127.0.0.1:8989/ws/transcribe?token=$TOKEN" --text
```

Expected: at minimum a clean handshake; if the test runs short on audio, AWS may close without ever sending a transcript — that's fine. Real verification happens in Task 12 with the browser.

Stop the server.

- [ ] **Step 6: Commit**

```bash
git add src/transcribe.rs
git commit -m "feat(transcribe): real AWS Transcribe Streaming proxy via tokio-tungstenite"
```

---

## Task 9: Frontend — `pcmWorklet.ts` (worklet source as a string)

**Files:**
- Create: `frontend/src/lib/pcmWorklet.ts`

The worklet code lives inside an AudioWorkletGlobalScope, so we export it as a TS string and use a Blob URL at runtime.

- [ ] **Step 1: Create `frontend/src/lib/pcmWorklet.ts`**

```ts
/**
 * Source for the AudioWorkletProcessor that downsamples to 16kHz Int16 PCM.
 * Loaded at runtime via:
 *   const url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' }))
 *   await audioContext.audioWorklet.addModule(url)
 *
 * Posts ArrayBuffer chunks (Int16, little-endian) to the main thread, ~100ms each.
 */
export const PCM_WORKLET_SOURCE = `
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this._targetRate = 16000
    this._buffer = []          // accumulated Float32 samples at sourceRate
    this._chunkSamples = 1600  // ~100ms at 16kHz
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true

    const sourceRate = sampleRate  // global from AudioWorkletGlobalScope
    const ratio = sourceRate / this._targetRate

    // Linear-interpolation downsample
    const targetLen = Math.floor(ch.length / ratio)
    const out = new Float32Array(targetLen)
    for (let i = 0; i < targetLen; i++) {
      const srcIdx = i * ratio
      const lo = Math.floor(srcIdx)
      const hi = Math.min(lo + 1, ch.length - 1)
      const frac = srcIdx - lo
      out[i] = ch[lo] * (1 - frac) + ch[hi] * frac
    }

    // Append to buffer; emit in ~100ms chunks
    for (let i = 0; i < out.length; i++) this._buffer.push(out[i])
    while (this._buffer.length >= this._chunkSamples) {
      const slice = this._buffer.splice(0, this._chunkSamples)
      const pcm = new Int16Array(slice.length)
      for (let i = 0; i < slice.length; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]))
        pcm[i] = (s * 0x7fff) | 0
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }
    return true
  }
}
registerProcessor('pcm-worklet', PcmWorklet)
`
```

- [ ] **Step 2: Quick syntax sanity test**

Add a minimal test to verify the string is non-empty and parses as JS. Create `frontend/src/lib/pcmWorklet.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PCM_WORKLET_SOURCE } from './pcmWorklet'

describe('PCM_WORKLET_SOURCE', () => {
  it('is a non-empty string', () => {
    expect(typeof PCM_WORKLET_SOURCE).toBe('string')
    expect(PCM_WORKLET_SOURCE.length).toBeGreaterThan(100)
  })

  it('registers a processor named pcm-worklet', () => {
    expect(PCM_WORKLET_SOURCE).toContain("registerProcessor('pcm-worklet'")
  })

  it('defines a class extending AudioWorkletProcessor', () => {
    expect(PCM_WORKLET_SOURCE).toContain('extends AudioWorkletProcessor')
  })
})
```

- [ ] **Step 3: Run the test**

```bash
cd frontend && npm test
```

Expected: 3 new passes added, no existing tests broken.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/pcmWorklet.ts frontend/src/lib/pcmWorklet.test.ts
git commit -m "feat(frontend): pcm AudioWorklet source string"
```

---

## Task 10: Frontend — `useTranscribe()` hook

**Files:**
- Create: `frontend/src/lib/transcribe.ts`
- Create: `frontend/src/lib/transcribe.test.ts`

This task tests the WS message dispatching and start/stop state machine *without* real audio — we mock `WebSocket` and never call `start()` to avoid `getUserMedia`.

- [ ] **Step 1: Create `frontend/src/lib/transcribe.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { wsUrl } from './api'
import { PCM_WORKLET_SOURCE } from './pcmWorklet'

export interface UseTranscribeOptions {
  language?: string
  onFinal: (text: string) => void
}

export interface UseTranscribeReturn {
  isRecording: boolean
  partial: string
  error: string | null
  supported: boolean
  start: () => Promise<void>
  stop: () => void
}

const SUPPORTED =
  typeof window !== 'undefined' &&
  'AudioContext' in window &&
  // @ts-expect-error legacy webkit prefix not relevant
  typeof (window.AudioContext.prototype as AudioContext).audioWorklet === 'object' &&
  !!navigator.mediaDevices?.getUserMedia

export function useTranscribe(opts: UseTranscribeOptions): UseTranscribeReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Mutable refs so cleanup can find them
  const wsRef = useRef<WebSocket | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const onFinalRef = useRef(opts.onFinal)
  onFinalRef.current = opts.onFinal

  const cleanup = useCallback(() => {
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify({ type: 'stop' })) } catch {}
    }
    wsRef.current?.close()
    wsRef.current = null
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
    setIsRecording(false)
    setPartial('')
  }, [])

  useEffect(() => () => cleanup(), [cleanup])

  const start = useCallback(async () => {
    if (!SUPPORTED) return
    if (isRecording) return
    setError(null)        // clear previous error on new attempt
    setPartial('')

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 } as MediaTrackConstraints,
      })
    } catch (e) {
      setError('需要麦克风权限')
      return
    }
    streamRef.current = stream

    let ctx: AudioContext
    try {
      // Try 16kHz first; some Safari versions reject custom rates and we accept whatever the OS gives us.
      ctx = new AudioContext({ sampleRate: 16000 })
    } catch {
      ctx = new AudioContext()
    }
    ctxRef.current = ctx

    const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' })
    const blobUrl = URL.createObjectURL(blob)
    blobUrlRef.current = blobUrl
    try {
      await ctx.audioWorklet.addModule(blobUrl)
    } catch (e) {
      setError('AudioWorklet 加载失败')
      cleanup()
      return
    }

    const ws = new WebSocket(wsUrl('/ws/transcribe'))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'start',
        language: opts.language ?? 'zh-CN',
      }))
      setIsRecording(true)

      // Hook up audio graph after WS open so we never buffer audio without a destination
      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'pcm-worklet')
      workletNodeRef.current = node
      node.port.onmessage = (ev) => {
        const buf = ev.data as ArrayBuffer
        if (ws.readyState === WebSocket.OPEN) ws.send(buf)
      }
      source.connect(node)
      // Don't connect node → destination (would echo to speakers). Keep node graph alive
      // by connecting to a muted GainNode instead.
      const sink = ctx.createGain()
      sink.gain.value = 0
      node.connect(sink).connect(ctx.destination)
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string)
        if (msg.type === 'partial' && typeof msg.text === 'string') {
          setPartial(msg.text)
        } else if (msg.type === 'final' && typeof msg.text === 'string') {
          setPartial('')
          onFinalRef.current(msg.text)
        } else if (msg.type === 'error' && typeof msg.message === 'string') {
          setError(msg.message)
          setPartial('')
          cleanup()
        }
      } catch {
        // ignore non-JSON server frames (shouldn't happen)
      }
    }

    ws.onerror = () => {
      setError('连接失败')
      cleanup()
    }
    ws.onclose = (ev) => {
      // 1006 = abnormal close; if not user-initiated stop, surface a message
      if (isRecordingRefValue() && ev.code !== 1000) {
        setError('连接已断开')
      }
      cleanup()
    }
  }, [cleanup, isRecording, opts.language])

  const stop = useCallback(() => {
    cleanup()
  }, [cleanup])

  // Avoid stale-closure read inside ws.onclose
  const isRecordingRef = useRef(isRecording)
  isRecordingRef.current = isRecording
  function isRecordingRefValue() { return isRecordingRef.current }

  return {
    isRecording,
    partial,
    error,
    supported: SUPPORTED,
    start,
    stop,
  }
}
```

- [ ] **Step 2: Create `frontend/src/lib/transcribe.test.ts`**

This tests the WS dispatch path with a fake socket; we never actually call `start()` (which would need `getUserMedia`).

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTranscribe } from './transcribe'

// Capture the most recently constructed WebSocket so tests can drive it
let mostRecentWs: FakeWs | null = null

class FakeWs {
  readyState = 0  // CONNECTING
  binaryType = 'blob'
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
  sentMessages: unknown[] = []
  static OPEN = 1
  static CONNECTING = 0
  constructor(public url: string) {
    mostRecentWs = this
  }
  send(d: unknown) { this.sentMessages.push(d) }
  close() { this.readyState = 3 }
}

describe('useTranscribe', () => {
  beforeEach(() => {
    mostRecentWs = null
    // @ts-expect-error patch WebSocket
    globalThis.WebSocket = FakeWs
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports unsupported when AudioWorklet missing', () => {
    // happy-dom doesn't have AudioContext at all → SUPPORTED is false
    const onFinal = vi.fn()
    const { result } = renderHook(() => useTranscribe({ onFinal }))
    expect(result.current.supported).toBe(false)
  })

  it('start() is a no-op when unsupported', async () => {
    const onFinal = vi.fn()
    const { result } = renderHook(() => useTranscribe({ onFinal }))
    await act(async () => { await result.current.start() })
    expect(result.current.isRecording).toBe(false)
    expect(mostRecentWs).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd frontend && npm test
```

Expected: both new tests pass. (Deeper WS-dispatch tests would require a much larger fake of `AudioContext` + `getUserMedia` + the worklet pipeline; we cover those paths via manual checklist in Task 12.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/transcribe.ts frontend/src/lib/transcribe.test.ts
git commit -m "feat(frontend): useTranscribe hook"
```

---

## Task 11: Frontend — `MicButton` component

**Files:**
- Create: `frontend/src/components/MicButton.tsx`
- Create: `frontend/src/components/MicButton.test.tsx`

- [ ] **Step 1: Create `frontend/src/components/MicButton.tsx`**

```tsx
import { Mic, MicOff } from 'lucide-react'
import type { PointerEvent } from 'react'

interface MicButtonProps {
  isRecording: boolean
  supported: boolean
  onPressStart: () => void
  onPressEnd: () => void
}

export function MicButton({ isRecording, supported, onPressStart, onPressEnd }: MicButtonProps) {
  const disabled = !supported

  const handleDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    onPressStart()
  }
  const handleUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (isRecording) onPressEnd()
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onPointerLeave={handleUp}
      title={
        disabled
          ? '浏览器不支持 AudioWorklet，无法使用语音输入'
          : isRecording ? '松开停止' : '按住说话'
      }
      aria-label={isRecording ? 'Recording' : 'Voice input'}
      aria-pressed={isRecording}
      className={
        'self-end p-2 rounded-lg transition-colors select-none ' +
        (disabled
          ? 'bg-[var(--btn-disabled-bg)] text-[var(--btn-disabled-text)] cursor-not-allowed'
          : isRecording
            ? 'bg-[var(--accent-red)] text-white animate-pulse'
            : 'bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)]')
      }
      style={{ touchAction: 'manipulation', WebkitTouchCallout: 'none' }}
    >
      {disabled ? <MicOff size={16} /> : <Mic size={16} />}
    </button>
  )
}
```

- [ ] **Step 2: Create `frontend/src/components/MicButton.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MicButton } from './MicButton'

describe('MicButton', () => {
  it('disables and shows tooltip when unsupported', () => {
    render(
      <MicButton
        isRecording={false}
        supported={false}
        onPressStart={vi.fn()}
        onPressEnd={vi.fn()}
      />,
    )
    const btn = screen.getByRole('button')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringContaining('不支持'))
  })

  it('calls onPressStart on pointerdown when supported', () => {
    const onPressStart = vi.fn()
    render(
      <MicButton
        isRecording={false}
        supported={true}
        onPressStart={onPressStart}
        onPressEnd={vi.fn()}
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button'), { pointerId: 1 })
    expect(onPressStart).toHaveBeenCalledTimes(1)
  })

  it('calls onPressEnd on pointerup when recording', () => {
    const onPressEnd = vi.fn()
    render(
      <MicButton
        isRecording={true}
        supported={true}
        onPressStart={vi.fn()}
        onPressEnd={onPressEnd}
      />,
    )
    fireEvent.pointerUp(screen.getByRole('button'), { pointerId: 1 })
    expect(onPressEnd).toHaveBeenCalledTimes(1)
  })

  it('does not call onPressEnd on pointerup when not recording', () => {
    const onPressEnd = vi.fn()
    render(
      <MicButton
        isRecording={false}
        supported={true}
        onPressStart={vi.fn()}
        onPressEnd={onPressEnd}
      />,
    )
    fireEvent.pointerUp(screen.getByRole('button'), { pointerId: 1 })
    expect(onPressEnd).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd frontend && npm test
```

Expected: 4 new tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/MicButton.tsx frontend/src/components/MicButton.test.tsx
git commit -m "feat(frontend): MicButton with pointer-events + supported gate"
```

---

## Task 12: Frontend — integrate into AcpChatView

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`

- [ ] **Step 1: Add imports**

In `frontend/src/components/AcpChatView.tsx`, find the existing import block at the top. Add two imports:

```tsx
import { MicButton } from './MicButton'
import { useTranscribe } from '../lib/transcribe'
```

- [ ] **Step 2: Extract textarea autoresize as a function**

Find the `<textarea>` block (around line 230) with the `onInput` handler that adjusts height. Above the `return (...)` of the component, add:

```tsx
const autoResize = (t: HTMLTextAreaElement) => {
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 120) + 'px'
}
```

Then change the textarea's `onInput` to:

```tsx
onInput={e => autoResize(e.target as HTMLTextAreaElement)}
```

(Drop the inline body — it's now in `autoResize`.)

- [ ] **Step 3: Wire up the hook**

Just below the existing `useState`/`useRef` declarations near the top of the component body (after `inputRef` is declared), add:

```tsx
const transcribe = useTranscribe({
  language: 'zh-CN',
  onFinal: (text) => {
    setInput(prev => prev + text)
    // Defer autoResize until React commits the new value
    requestAnimationFrame(() => {
      if (inputRef.current) autoResize(inputRef.current)
    })
  },
})
```

- [ ] **Step 4: Replace the input row**

Find the input bar `<div className="flex gap-2 px-4 py-3 border-t ...">` (around line 229). Replace the entire div (including its children — textarea + Send button) with:

```tsx
<div className="flex flex-col px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
  {(transcribe.partial || transcribe.error) && (
    <div className="px-2 pb-1 text-xs italic text-[var(--text-muted)]">
      {transcribe.error
        ? <span className="text-[var(--accent-red)]">⚠ {transcribe.error}</span>
        : transcribe.partial}
    </div>
  )}
  <div className="flex gap-2">
    <textarea
      ref={inputRef}
      value={input}
      onChange={e => setInput(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={`Send a message to ${agentType === 'kiro' ? 'Kiro' : 'Claude'}...`}
      rows={1}
      className="flex-1 px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent-blue)] resize-none min-h-[40px] max-h-[120px]"
      style={{ height: 'auto', overflow: 'hidden' }}
      onInput={e => autoResize(e.target as HTMLTextAreaElement)}
    />
    <MicButton
      isRecording={transcribe.isRecording}
      supported={transcribe.supported}
      onPressStart={transcribe.start}
      onPressEnd={transcribe.stop}
    />
    <button
      onClick={sendPrompt}
      disabled={busy || !input.trim()}
      className="self-end p-2 bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white rounded-lg transition-colors"
      title="Send"
    >
      <Send size={16} />
    </button>
  </div>
</div>
```

- [ ] **Step 5: Build the frontend**

```bash
cd frontend && npm run build
```

Expected: clean build, no TS errors.

- [ ] **Step 6: Run frontend tests**

```bash
cd frontend && npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(frontend): wire MicButton + transcript preview into AcpChatView"
```

---

## Task 13: Manual verification — full stack

**Files:** none modified.

This task runs the §8.3 manual checklist from the spec. Each item has a clear pass/fail and matches the spec line-for-line. If any item fails, file a bug and (depending on severity) fix in a follow-up commit before merging.

- [ ] **Step 1: Build everything fresh**

```bash
cd frontend && npm run build && cd ..
cargo build --release
```

- [ ] **Step 2: Set up AWS credentials and start the server**

```bash
export AWS_REGION=us-east-1   # or your nearest region with Transcribe Streaming
# Either: export AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY,
# or: have ~/.aws/credentials with [default],
# or: run on EC2 with an instance role granting transcribe:StartStreamTranscription
./target/release/zeromux --port 8989 --password test
```

Open https://localhost:8989 (or http if local) and log in with password `test`. Open the browser DevTools network tab.

- [ ] **Step 3: Walk the spec checklist**

For each item, mark it ✅ or ❌ inline below. Re-run failures after fixes.

- [ ] 1.  Press-and-hold Mic, say "你好世界" → final appears in textarea as "你好世界"
- [ ] 2.  Press-and-hold Mic, say a long Chinese sentence → status row shows partial scrolling, final lands in textarea on release
- [ ] 3.  Pre-fill textarea with "前面打的字"; press-and-hold, say "接着说的" → result appended to existing text, prefix preserved
- [ ] 4.  Press-and-hold Mic briefly (under 0.5s) → returns to idle, no error shown
- [ ] 5.  In a new private window, deny microphone permission, then press Mic → status row shows "需要麦克风权限"
- [ ] 6.  Sign out (or wait for token expiry), then press Mic → status row shows ws connection error or "未登录, 请刷新页面"
- [ ] 7.  Disconnect Wi-Fi, press Mic → status row shows error
- [ ] 8.  In a fresh DevTools session, set `AWS_SECRET_ACCESS_KEY` to a wrong value and restart server, press Mic → status row shows backend error message
- [ ] 9.  In Chrome DevTools, override `AudioContext.prototype.audioWorklet` to undefined (or use a Safari < 14.1) → MicButton is disabled with tooltip
- [ ] 10. Press-and-hold Mic and simultaneously type into textarea → both work, no conflict
- [ ] 11. Press-and-hold Mic, then press Enter → existing textarea text is sent, recording continues
- [ ] 12. While recording, switch to Notes tab, then back → recording state preserved (state lives in AcpChatView, not unmounted)
- [ ] 13. Restart server with `--log-dir /tmp/zeromux-logs`, repeat checklist items 1-2, then `grep -r '你好' /tmp/zeromux-logs` → no transcript text in logs
- [ ] 14. Compare binary size: `ls -lh target/release/zeromux` vs the pre-task baseline (record before Task 1) → growth ≤ 1 MB

- [ ] **Step 4: If any item fails, file a follow-up before merge**

If a fix is small enough to land in this PR, do it in a new commit. Otherwise capture in a TODO and proceed.

- [ ] **Step 5: Commit checklist results to spec (optional but encouraged)**

Open `docs/specs/2026-05-18-voice-input-design.md`, append a "Manual verification" section near the top with the date and which items passed/failed. Commit:

```bash
git add docs/specs/2026-05-18-voice-input-design.md
git commit -m "docs(spec): record manual verification results for voice input"
```

---

## Task 14: Update READMEs

**Files:**
- Modify: `README.md`
- Modify: `README_ZH.md`

- [ ] **Step 1: Add a "Voice input" section to `README_ZH.md`**

Find the "功能特性" bullet list and add a new bullet:

```markdown
- **语音输入** — AcpChatView 输入框旁的麦克风按钮，按住说话调用 AWS Transcribe Streaming 实时转写中文，松开停止；结果填进输入框，需手动点 Send 才发送
```

Find the "配置参数" section. Below the "GitHub OAuth 配置" subsection, add a new subsection:

```markdown
### AWS 凭证（可选，启用语音输入需要）

语音输入功能调用 AWS Transcribe Streaming，沿用 AWS SDK 默认 credential chain：

1. 环境变量：`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION`
2. 共享配置：`~/.aws/credentials [default]` + `~/.aws/config [default]`
3. EC2 IAM Instance Role（推荐部署模式）

需要的 IAM 权限：`transcribe:StartStreamTranscription`。

未配置 AWS 凭证不影响其他功能，仅麦克风按钮在使用时显示 "AWS credentials not configured" 错误。
```

- [ ] **Step 2: Mirror the same changes in `README.md`**

Add to the "Features" bullet list:

```markdown
- **Voice input** — Push-to-talk microphone next to the chat input streams audio to AWS Transcribe Streaming for real-time Chinese transcription; results populate the textarea, never auto-send
```

Add a new section after "GitHub OAuth Config":

```markdown
### AWS Credentials (optional, required for voice input)

The voice input feature calls AWS Transcribe Streaming using the default AWS credential chain:

1. Env vars: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION`
2. Shared config: `~/.aws/credentials [default]` + `~/.aws/config [default]`
3. EC2 IAM instance role (recommended deployment)

Required IAM permission: `transcribe:StartStreamTranscription`.

Voice input is the only feature that uses AWS — without credentials, the rest of ZeroMux works normally; pressing the mic button surfaces an "AWS credentials not configured" error.
```

- [ ] **Step 3: Commit**

```bash
git add README.md README_ZH.md
git commit -m "docs: document voice input feature and AWS credential setup"
```

---

## Self-Review (writing-plans gate)

**1. Spec coverage check**

| Spec section | Implementing task(s) |
|---|---|
| §3 Architecture diagram | Tasks 5–8 (back end), 9–12 (front end) |
| §4.1 transcribe.rs handler | Task 7 (auth + stub), Task 8 (real AWS) |
| §4.2 aws_sigv4.rs (presigner + chain) | Tasks 3 (presigner) + 4 (chain) |
| §4.3 event_stream.rs codec | Task 2 |
| §4.4 route registration | Task 6 |
| §4.5 Cargo deps + version pin | Task 1 |
| §5.1 file layout | Tasks 9 (pcmWorklet), 10 (hook), 11 (button), 12 (integrate) |
| §5.2 pcmWorklet (16k Int16 PCM) | Task 9 |
| §5.3 useTranscribe hook | Task 10 |
| §5.4 MicButton (pointer events, disabled when unsupported) | Task 11 |
| §5.5 AcpChatView integration (preview row + autoresize hoist) | Task 12 |
| §5.6 textarea-not-disabled-during-recording, end-append | Task 12 (no disabled prop set, onFinal appends to end) |
| §6.1 error matrix | Task 8 (backend error frames), Task 10 (browser error display) |
| §6.2 no auto-reconnect | Task 10 (cleanup on close, no retry loop) |
| §6.3 privacy (no logging audio/transcript) | Task 8 (`tracing::error!` only logs error type), Task 13 step 13 verifies |
| §7 protocol | Task 5 (types), Task 8 (server), Task 10 (client) |
| §8.1 backend tests | Tasks 2, 3, 4, 5 (per-module unit tests) |
| §8.2 frontend tests | Tasks 9, 10, 11 |
| §8.3 manual checklist | Task 13 |
| §9 binary size + bundle | Task 13 step 14 |
| §10 risks (version pin) | Task 1 step 3 |
| §12 implementation breakdown | Tasks 2–14 (one breakdown step ≈ one task) |

All spec sections covered. ✅

**2. Placeholder scan**

Searched plan for: TBD, TODO, "implement later", "fill in details", "appropriate error handling", "similar to Task". Found: no problematic placeholders. The phrase "Implemented in a later task" appears once (Task 5 step 2 stub) and is replaced concretely in Task 7. ✅

**3. Type / signature consistency**

- `AwsCredentials` struct fields (Task 3) match usage in Task 4 and Task 8 ✅
- `presign_transcribe_url` signature (Task 3) matches the call in Task 8 ✅
- `ClientFrame` / `ServerFrame` enums (Task 5) match decoding in Task 10's hook ✅
- `MicButton` props (Task 11) match `useTranscribe` return shape (Task 10) and AcpChatView wiring (Task 12) ✅
- `encode_audio_event` / `decode_event_message` / `DecodedFrame` (Task 2) match usage in Task 8 ✅
- `wsUrl` (existing, `lib/api.ts:351`) used in Task 10 ✅

All consistent.

---

**Plan complete and saved to `docs/plans/2026-05-18-voice-input-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
