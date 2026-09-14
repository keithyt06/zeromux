//! Crew 记忆的 zeromux 侧代理。
//!
//! 浏览器不能直连 Gateway（loopback-only + 全权 token 不能下发 + X-Session-Key
//! 是服务端知识），所以记忆面的每一次读写都经这里。**token 只在本模块的函数栈上
//! 存活**：不进 AppState、不进 Session、不进日志、不进响应体。
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    acp::crew_process::{mint_ws_token, read_gateway_secret},
    auth::CurrentUser,
    AppState,
};

/// 单个上游请求的超时。记忆端点都是本地 SQLite/文件读写，20s 已经很宽裕
/// （与 `crew_process::REST_TIMEOUT` 同量级）。
const UPSTREAM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Gateway 侧的 key 约束（实测）：`^[a-z][a-z0-9_.]*[a-z0-9]$` 且带命名空间前缀。
/// 在转发前挡掉，免得把一个注定 400 的请求送出去、还让用户以为写成功了。
///
/// 顺带也是 `DELETE /api/memory/semantic/{key}` 的路径注入闸门：通过校验的 key
/// 只含 `[a-z0-9_.]`，没有 `/`、没有 `%`，所以拼进上游路径不需要额外转义。
pub fn validate_semantic_key(key: &str) -> bool {
    const PREFIXES: [&str; 4] = ["pref.", "project.", "user.", "lesson."];
    if !PREFIXES.iter().any(|p| key.starts_with(p)) {
        return false;
    }
    let b = key.as_bytes();
    if b.len() < 2 {
        return false;
    }
    let first_ok = b[0].is_ascii_lowercase();
    let last_ok = b[b.len() - 1].is_ascii_lowercase() || b[b.len() - 1].is_ascii_digit();
    let mid_ok = b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'.');
    first_ok && last_ok && mid_ok
}

#[derive(Serialize, Default)]
pub struct CrewMemoryResponse {
    pub preferences: String,
    pub projects: String,
    pub semantic: Vec<serde_json::Value>,
    pub lessons: Vec<serde_json::Value>,
    /// Gateway 不可达时 false，其余字段为空。**200 而非 5xx** —— 前端据此显示
    /// 降级条而不是空状态；「读不到」与「真的空」含义完全不同。
    pub gateway_ok: bool,
}

impl CrewMemoryResponse {
    pub fn unreachable() -> Self {
        Self { gateway_ok: false, ..Default::default() }
    }
}

/// 上游 HTTP 客户端。Gateway 在 loopback，任何重定向都是异常；照
/// `crew_process.rs` / `push.rs` 的硬化惯例直接禁掉，免得带凭证的头被跟到别的
/// host 去。
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("build crew http client: {e}"))
}

/// 现读 secret → mint 一个 token。**每次请求都现读，绝不缓存**：Gateway 每次重启
/// 都轮换 `run/gateway-<port>.secret`（实测），一份长期持有的 secret 在 Gateway
/// 重启后就永久 403。这与 `crew_process.rs` 的既有模式一致。
async fn crew_token(state: &AppState, http: &reqwest::Client) -> Result<String, String> {
    let secret = read_gateway_secret(std::path::Path::new(&state.crew_home), state.crew_port)?;
    let base = format!("http://127.0.0.1:{}", state.crew_port);
    mint_ws_token(http, &base, &secret).await
}

/// Gateway 的 cookie 名是 `mc_token_<浏览器侧端口>`，实测由 Host 头的端口推导
/// （`token_auth.py:_cookie_port_from_host`），回落到监听端口。reqwest 对带显式
/// 端口的 URL 会发 `Host: 127.0.0.1:<port>`，所以这里跟 `crew_port` 同源。
///
/// **为什么用 Cookie 而不是 `?token=`**（实测，与 spec 附录 A.1 的写法不同）：
/// 中间件把 URL 里的 token 当**一次性登录链接**处理 —— 用过一次就把它的 nonce
/// 写进持久 denylist（`token_auth.py:2805` 的 `revoke`），同一个 token 的**第二个**
/// 请求即 403 `"session revoked"`。记忆面的 GET 要并发打四个上游端点，用 `?token=`
/// 会随机死掉后到的那几个。走 cookie 路径（`use_session_exp=True`）只查 denylist、
/// 不自我吊销，实测 15 轮 × 4 并发 0 失败（`?token=` 同样负载 2 次 403）。
/// 附带好处：token 不进 URL，所以任何回显请求 URL 的上游错误都不可能带出它。
fn cookie_header(state: &AppState, token: &str) -> String {
    format!("mc_token_{}={}", state.crew_port, token)
}

/// `GET <base><path>`，成功返回解析后的 JSON。**错误信息不含 token**（token 只在
/// Cookie 头里，不在 URL 里）。
async fn get_json(
    http: &reqwest::Client, base: &str, cookie: &str, path: &str,
) -> Result<serde_json::Value, String> {
    let resp = http
        .get(format!("{base}{path}"))
        .header("Cookie", cookie)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|_| format!("Gateway 请求失败：{path}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Gateway 拒绝 {path}（HTTP {}）", status.as_u16()));
    }
    resp.json().await.map_err(|_| format!("Gateway 响应不是 JSON：{path}"))
}

/// `GET /api/crew/memory` —— 一次取回记忆面板全部分区。
///
/// **Gateway 不可达时回 200 + `gateway_ok:false`，不是 5xx**：前端据此显示降级条
/// 而不是空状态。四个上游请求并发（一次 GET 顶四次往返 —— 手机上这很重要），
/// **任一失败只让该字段留空**，不牵连其余三个。
pub async fn get_crew_memory(
    State(state): State<Arc<AppState>>,
    _user: axum::Extension<CurrentUser>,
) -> Json<CrewMemoryResponse> {
    let Ok(http) = http_client() else { return Json(CrewMemoryResponse::unreachable()) };
    // mint 本身就是一次 loopback GET —— 它成功即证明 Gateway 活着，所以拿它当
    // gateway_ok 的判据，不需要额外探活请求。
    let Ok(token) = crew_token(&state, &http).await else {
        return Json(CrewMemoryResponse::unreachable());
    };
    let cookie = cookie_header(&state, &token);
    let base = format!("http://127.0.0.1:{}", state.crew_port);

    let (prefs, projects, semantic, lessons) = tokio::join!(
        get_json(&http, &base, &cookie, "/api/memory/preferences"),
        get_json(&http, &base, &cookie, "/api/memory/projects"),
        get_json(&http, &base, &cookie, "/api/memory/semantic"),
        get_json(&http, &base, &cookie, "/api/lessons"),
    );

    let content_of = |v: Result<serde_json::Value, String>| -> String {
        v.ok()
            .and_then(|j| j.get("content").and_then(|c| c.as_str()).map(|s| s.to_string()))
            .unwrap_or_default()
    };
    let array_of = |v: Result<serde_json::Value, String>, field: &str| -> Vec<serde_json::Value> {
        v.ok()
            .and_then(|j| j.get(field).and_then(|a| a.as_array()).cloned())
            .unwrap_or_default()
    };

    Json(CrewMemoryResponse {
        preferences: content_of(prefs),
        projects: content_of(projects),
        semantic: array_of(semantic, "entries"),
        lessons: array_of(lessons, "lessons"),
        gateway_ok: true,
    })
}

/// 写记忆必须带 `X-Session-Key: <已存在的 slot>`（实测：缺头 → `missing_session_key`，
/// 给不存在的 slot → `unknown session`）。找不到活 Crew 会话就 409 + 明确提示 ——
/// **绝不猜一个 slot 名**（会得到用户看不懂的 `unknown session`）。
fn owner_slot_key(state: &AppState, user: &CurrentUser) -> Result<String, (StatusCode, String)> {
    state.sessions.any_crew_slot_key(&user.id).ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            // 刚建的 Crew 会话在第一个 System{init} 被 fan-out 处理之前还没有
            // resume token（回填在 spawn_crew_fanout 的事件循环里），所以提示里
            // 必须写「并等它就绪」，否则用户会以为功能坏了。
            "需要先开一个 Kiro Crew 会话并等它就绪".to_string(),
        )
    })
}

#[derive(Deserialize)]
pub struct SemanticWrite {
    key: String,
    value: String,
    source: Option<String>,
    confidence: Option<f64>,
}

/// `PUT /api/crew/memory/semantic` —— 写一条语义记忆。
///
/// 上游路径**不带 key**（实测带 key 是 405），key 在 body 里。
pub async fn put_crew_semantic(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Json(body): Json<SemanticWrite>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if !validate_semantic_key(&body.key) {
        return Err((
            StatusCode::BAD_REQUEST,
            "key 必须带 pref. / project. / user. / lesson. 前缀，且只含小写字母、数字、下划线与点".to_string(),
        ));
    }
    let slot = owner_slot_key(&state, &user)?;
    let http = http_client().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let token = crew_token(&state, &http)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let payload = serde_json::json!({
        "key": body.key,
        "value": body.value,
        "source": body.source.unwrap_or_else(|| "user_explicit".to_string()),
        "confidence": body.confidence.unwrap_or(1.0),
    });
    let resp = http
        .put(format!("http://127.0.0.1:{}/api/memory/semantic", state.crew_port))
        .header("Cookie", cookie_header(&state, &token))
        .header("X-Session-Key", slot)
        .json(&payload)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Gateway 请求失败：写语义记忆".to_string()))?;
    let status = resp.status();
    drop(resp);
    if status.is_success() {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Err((StatusCode::BAD_GATEWAY, format!("Gateway 拒绝写入（HTTP {}）", status.as_u16())))
    }
}

/// `DELETE /api/crew/memory/semantic/{key}` —— 这一侧路径**要**带 key，
/// 且同样需要 `X-Session-Key`。
pub async fn delete_crew_semantic(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if !validate_semantic_key(&key) {
        return Err((StatusCode::BAD_REQUEST, "非法的记忆 key".to_string()));
    }
    let slot = owner_slot_key(&state, &user)?;
    let http = http_client().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let token = crew_token(&state, &http)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    let resp = http
        .delete(format!("http://127.0.0.1:{}/api/memory/semantic/{}", state.crew_port, key))
        .header("Cookie", cookie_header(&state, &token))
        .header("X-Session-Key", slot)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Gateway 请求失败：删语义记忆".to_string()))?;
    let status = resp.status();
    drop(resp);
    if status.is_success() {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Err((StatusCode::BAD_GATEWAY, format!("Gateway 拒绝删除（HTTP {}）", status.as_u16())))
    }
}

#[derive(Deserialize)]
pub struct DocWrite {
    content: String,
}

/// `PUT /api/crew/memory/{preferences|projects}` —— 整文件覆盖写（Gateway 只支持
/// 整文件）。`doc` 白名单化：这两个名字直接拼进上游路径，不能收任意串。
pub async fn put_crew_memory_doc(
    State(state): State<Arc<AppState>>,
    _user: axum::Extension<CurrentUser>,
    Path(doc): Path<String>,
    Json(body): Json<DocWrite>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if doc != "preferences" && doc != "projects" {
        return Err((StatusCode::BAD_REQUEST, "只支持 preferences / projects".to_string()));
    }
    let http = http_client().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let token = crew_token(&state, &http)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))?;
    // 文档写入实测**不需要** X-Session-Key（只有 semantic 那两条需要）。
    let resp = http
        .put(format!("http://127.0.0.1:{}/api/memory/{}", state.crew_port, doc))
        .header("Cookie", cookie_header(&state, &token))
        .json(&serde_json::json!({ "content": body.content }))
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Gateway 请求失败：写记忆文档".to_string()))?;
    let status = resp.status();
    drop(resp);
    if status.is_success() {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Err((StatusCode::BAD_GATEWAY, format!("Gateway 拒绝写入（HTTP {}）", status.as_u16())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_key_requires_namespace_prefix() {
        // 实测约束:key 必须匹配 ^[a-z][a-z0-9_.]*[a-z0-9]$ 且带前缀
        // pref.|project.|user.|lesson.,否则 Gateway 回
        // "Key must match an allowed prefix"。后端在转发前挡掉,免得把一个
        // 注定 400 的请求送出去,还让用户以为写成功了。
        assert!(validate_semantic_key("pref.pkg_manager"));
        assert!(validate_semantic_key("project.repo"));
        assert!(validate_semantic_key("user.name"));
        assert!(validate_semantic_key("lesson.no_force_push"));
        // 无前缀
        assert!(!validate_semantic_key("pkg_manager"));
        // 前缀对但正则不合（大写 / 连字符 / 末位下划线）
        assert!(!validate_semantic_key("pref.PkgManager"));
        assert!(!validate_semantic_key("pref.pkg-manager"));
        assert!(!validate_semantic_key("pref.pkg_"));
        // 空 / 只有前缀
        assert!(!validate_semantic_key(""));
        assert!(!validate_semantic_key("pref."));
    }

    #[test]
    fn gateway_unreachable_degrades_to_empty_not_error() {
        // Gateway 挂掉时 GET /api/crew/memory 必须回 200 + gateway_ok:false,
        // 不是 5xx。前端据此显示黄色降级条,而不是「它还什么都没记住」——
        // 「读不到」与「真的空」是两种完全不同的含义,混淆了用户会以为记忆被清空。
        let m = CrewMemoryResponse::unreachable();
        assert!(!m.gateway_ok);
        assert!(m.preferences.is_empty());
        assert!(m.semantic.is_empty());
        assert!(m.lessons.is_empty());
    }
}
