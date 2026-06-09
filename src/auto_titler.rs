//! 自动会话标题:首条实质 prompt 后,用一个沙箱化、无工具的临时 LLM 进程
//! 读对话出 <=16 字中文标题写回 session.name。一生只命名一次(见 set_auto_title)。
//! 安全(C1/E10):临时进程在系统临时空目录运行 + 不授予工具 + 不 skip-permissions。
//!
//! 后端覆盖:仅 Claude 实现真正的无工具 spawn(`--allowedTools ""` + 不
//! skip-permissions)。Kiro/Codex 的现有 spawn 会授予/自动放行工具(Kiro 的
//! 共享事件循环 auto-approve 权限请求;Codex 的 per-call 配置写死
//! sandbox=danger-full-access / approval=never),无法在不大改其事件循环的
//! 前提下安全降为无工具,故按设计的失败模式直接返回 None —— 会话保留默认名。

use std::sync::Weak;
use std::time::Duration;

use crate::acp::process::{AcpEvent, AcpProcess};
use crate::session_manager::{sanitize_title, SessionManager, TitlerBackend};

const TITLER_TIMEOUT_SECS: u64 = 15;

fn titler_prompt(first_prompt: &str, result_text: &str) -> String {
    let up: String = first_prompt.chars().take(1000).collect();
    let asst: String = result_text.chars().take(1000).collect();
    format!(
        "You are a titling assistant. Read the conversation below and output ONLY a concise title.
Rules:
- Language: Chinese.
- Max 16 Chinese characters.
- No quotes, no punctuation, no explanation, no markdown.
- Do NOT use any tools or take any action.
- Output the title text and nothing else.
---
User: {up}
Assistant: {asst}"
    )
}

/// 在后台尝试为 sid 生成并写回标题。失败/超时/空 → 静默放弃,保留原名。
pub fn spawn_titler(
    sid: String,
    backend: TitlerBackend,
    cli_path: String,
    first_prompt: String,
    result_text: String,
    mgr: Weak<SessionManager>,
) {
    tokio::spawn(async move {
        let sandbox = match tempfile::Builder::new().prefix("zeromux-titler-").tempdir() {
            Ok(d) => d,
            Err(e) => {
                tracing::debug!("titler tempdir failed: {}", e);
                return;
            }
        };
        let sandbox_path = sandbox.path().to_string_lossy().to_string();
        let prompt = titler_prompt(&first_prompt, &result_text);

        let title = run_titler(backend, &cli_path, &sandbox_path, &prompt).await;

        let Some(raw) = title else { return };
        let Some(clean) = sanitize_title(&raw) else { return };
        if let Some(m) = mgr.upgrade() {
            if m.session_name_is_auto(&sid) {
                m.set_auto_title(&sid, &clean);
            }
        }
        // sandbox drop → temp dir removed
    });
}

/// 拉起对应后端的无工具临时进程,发 prompt,在超时内等 `Result` 文本,结束后 kill。
/// 仅 Claude 完整支持;Kiro/Codex 暂降为 None(见模块头注释)。
async fn run_titler(
    backend: TitlerBackend,
    cli_path: &str,
    sandbox_path: &str,
    prompt: &str,
) -> Option<String> {
    match backend {
        TitlerBackend::Claude => {
            let mut proc = match AcpProcess::spawn_titler(cli_path, sandbox_path).await {
                Ok(p) => p,
                Err(e) => {
                    tracing::debug!("titler claude spawn failed: {}", e);
                    return None;
                }
            };
            if proc.send_prompt(prompt).await.is_err() {
                proc.kill().await;
                return None;
            }
            let text = tokio::time::timeout(
                Duration::from_secs(TITLER_TIMEOUT_SECS),
                async {
                    loop {
                        match proc.event_rx.recv().await {
                            Some(AcpEvent::Result { text, .. }) => return Some(text),
                            Some(AcpEvent::Error { .. }) | Some(AcpEvent::Exit { .. }) | None => {
                                return None
                            }
                            Some(_) => continue,
                        }
                    }
                },
            )
            .await
            .ok()
            .flatten();
            proc.kill().await;
            text
        }
        // 无法安全保证无工具 → 按设计放弃,保留默认会话名。
        TitlerBackend::Kiro | TitlerBackend::Codex => None,
    }
}

#[cfg(test)]
mod tests {
    use super::titler_prompt;

    #[test]
    fn titler_prompt_embeds_conversation_and_rules() {
        let p = titler_prompt("帮我修复登录 bug", "我修改了 auth.rs 的 token 校验");
        assert!(p.contains("帮我修复登录 bug"));
        assert!(p.contains("我修改了 auth.rs 的 token 校验"));
        assert!(p.contains("Max 16 Chinese characters"));
        assert!(p.contains("Do NOT use any tools"));
    }

    #[test]
    fn titler_prompt_truncates_long_inputs_to_1000_chars() {
        let long = "字".repeat(5000);
        let p = titler_prompt(&long, &long);
        // 两段各截断到 1000 字符;模板其余为 ASCII。
        assert_eq!(long.chars().filter(|c| *c == '字').count(), 5000);
        assert_eq!(p.matches('字').count(), 2000);
    }
}
