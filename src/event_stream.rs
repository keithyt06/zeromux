//! AWS EventStream binary framing (subset used by Transcribe Streaming).
//!
//! Frame layout (big-endian):
//!   12-byte prelude: total_length u32, headers_length u32, prelude_crc u32
//!   headers (headers_length bytes): repeated key/type/value
//!   payload (total_length - headers_length - 16 bytes)
//!   message_crc u32 (CRC32 of all bytes preceding it)

// Use Result<T, String> to match the project's existing error-handling style
// (db.rs, notes.rs, etc.). Errors here are simple message strings that get
// surfaced over the WS as `{"type":"error", "message": ...}`.

#[derive(Debug, PartialEq)]
pub enum DecodedFrame {
    /// `:message-type=event :event-type=TranscriptEvent` — payload is JSON
    TranscriptEvent { payload: Vec<u8> },
    /// `:message-type=exception` — payload is JSON; exception type in headers
    Exception {
        exception_type: String,
        payload: Vec<u8>,
    },
    /// Anything else — pass through for forward-compat
    Other {
        message_type: String,
        payload: Vec<u8>,
    },
}

/// Encode an `AudioEvent` frame. Headers:
///   :message-type = event
///   :event-type   = AudioEvent
///   :content-type = application/octet-stream
pub fn encode_audio_event(pcm: &[u8]) -> Vec<u8> {
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

    let total_len = 12 + headers.len() + pcm.len() + 4;
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

/// Decode one frame from `buf`. Returns `Err` on CRC mismatch or malformed structure.
pub fn decode_event_message(buf: &[u8]) -> Result<DecodedFrame, String> {
    if buf.len() < 16 {
        return Err(format!("frame too short: length={}", buf.len()));
    }
    let total_len = u32::from_be_bytes(buf[0..4].try_into().unwrap()) as usize;
    let headers_len = u32::from_be_bytes(buf[4..8].try_into().unwrap()) as usize;
    let prelude_crc = u32::from_be_bytes(buf[8..12].try_into().unwrap());

    if total_len != buf.len() {
        return Err(format!(
            "total_length {} != buffer length {}",
            total_len,
            buf.len()
        ));
    }
    if crc32fast::hash(&buf[0..8]) != prelude_crc {
        return Err("prelude CRC mismatch".to_string());
    }
    let message_crc_offset = total_len - 4;
    let message_crc =
        u32::from_be_bytes(buf[message_crc_offset..total_len].try_into().unwrap());
    if crc32fast::hash(&buf[0..message_crc_offset]) != message_crc {
        return Err("message CRC mismatch".to_string());
    }

    let headers_start = 12;
    let headers_end = headers_start + headers_len;
    if headers_end + 4 > total_len {
        return Err(format!("headers_length {} overruns frame", headers_len));
    }
    let mut i = headers_start;
    let mut message_type = String::new();
    let mut event_type = String::new();
    let mut exception_type = String::new();
    while i < headers_end {
        if i + 1 > headers_end {
            return Err("truncated header name length".to_string());
        }
        let name_len = buf[i] as usize;
        i += 1;
        if i + name_len > headers_end {
            return Err("truncated header name".to_string());
        }
        let name = std::str::from_utf8(&buf[i..i + name_len])
            .map_err(|_| "non-utf8 header name".to_string())?
            .to_string();
        i += name_len;
        if i + 1 > headers_end {
            return Err("truncated header type".to_string());
        }
        let value_type = buf[i];
        i += 1;
        if value_type != 7 {
            // Skip unknown-typed headers by reading their u16 length and stepping over.
            if i + 2 > headers_end {
                return Err(format!(
                    "truncated header value len for type {}",
                    value_type
                ));
            }
            let value_len =
                u16::from_be_bytes(buf[i..i + 2].try_into().unwrap()) as usize;
            i += 2 + value_len;
            if i > headers_end {
                return Err("truncated unknown-type header value".to_string());
            }
            continue;
        }
        if i + 2 > headers_end {
            return Err("truncated header value length".to_string());
        }
        let value_len = u16::from_be_bytes(buf[i..i + 2].try_into().unwrap()) as usize;
        i += 2;
        if i + value_len > headers_end {
            return Err("truncated header value".to_string());
        }
        let value = std::str::from_utf8(&buf[i..i + value_len])
            .map_err(|_| "non-utf8 header value".to_string())?
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
        ("exception", _) => Ok(DecodedFrame::Exception {
            exception_type,
            payload,
        }),
        (mt, _) => Ok(DecodedFrame::Other {
            message_type: mt.to_string(),
            payload,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_event_roundtrip_via_decoder() {
        let pcm: Vec<u8> = (0..32u8).collect();
        let frame = encode_audio_event(&pcm);

        let total = u32::from_be_bytes(frame[0..4].try_into().unwrap());
        assert_eq!(total as usize, frame.len(), "total_length matches frame size");

        let decoded = decode_event_message(&frame).unwrap();
        match decoded {
            DecodedFrame::Other {
                message_type,
                payload,
            } => {
                assert_eq!(message_type, "event");
                assert_eq!(payload, pcm);
            }
            other => panic!("expected Other(event), got {other:?}"),
        }
    }

    #[test]
    fn decode_rejects_bad_prelude_crc() {
        let mut frame = encode_audio_event(b"abc");
        frame[8] ^= 0xFF;
        let err = decode_event_message(&frame).unwrap_err();
        assert!(err.to_lowercase().contains("crc"), "{err}");
    }

    #[test]
    fn decode_rejects_short_buffer() {
        let err = decode_event_message(&[0u8; 5]).unwrap_err();
        let s = err.to_lowercase();
        assert!(s.contains("short") || s.contains("length"), "{err}");
    }
}
