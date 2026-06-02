//! 工具调用摘要：把一次 tool_use 的 (name, input) 压成一行人类可读细节。
//!
//! 纯函数，无副作用，供三个 agent 后端在归一化 `AcpEvent::ContentBlock`
//! 时共用。只产出文字（不含 emoji/图标）——图标由前端 lucide 体系按工具名
//! 选择。返回 `None` 表示"无可提取的额外细节"，此时前端只显示工具名。

use serde_json::Value;

/// 按字符（而非字节）安全截断，超长补省略号。中文/emoji 不会被切坏。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

/// 把绝对路径缩成 `父目录/文件名`，无父目录时只留文件名，
/// 无法解析时原样返回。
fn shorten_path(p: &str) -> String {
    let path = std::path::Path::new(p);
    let base = path.file_name().and_then(|s| s.to_str());
    let parent = path
        .parent()
        .and_then(|d| d.file_name())
        .and_then(|s| s.to_str());
    match (parent, base) {
        (Some(d), Some(b)) if !d.is_empty() => format!("{d}/{b}"),
        (_, Some(b)) => b.to_string(),
        _ => p.to_string(),
    }
}

/// 生成一行工具调用细节摘要。已知工具提取最有信息量的字段；
/// 未知工具（含 MCP）返回 `None`，前端回落显示工具名。
pub fn format_tool_use(name: &str, input: Option<&Value>) -> Option<String> {
    let field = |key: &str| -> Option<&str> {
        input
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
    };

    match name {
        "Read" | "Edit" | "Write" => field("file_path").map(shorten_path),
        "Bash" => field("description")
            .or_else(|| field("command"))
            .map(|s| truncate_chars(s, 80)),
        "Grep" => field("pattern").map(|p| {
            let mut s = truncate_chars(p, 80);
            if let Some(path) = field("path") {
                s.push_str(" in ");
                s.push_str(&shorten_path(path));
            }
            s
        }),
        "Glob" => field("pattern").map(|p| truncate_chars(p, 80)),
        "Agent" | "Task" => field("description").map(|d| truncate_chars(d, 60)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_shows_short_path() {
        let input = json!({ "file_path": "/home/user/proj/src/main.rs" });
        assert_eq!(
            format_tool_use("Read", Some(&input)),
            Some("src/main.rs".to_string())
        );
    }

    #[test]
    fn edit_and_write_use_same_path_rule() {
        let input = json!({ "file_path": "/a/b/c.txt" });
        assert_eq!(format_tool_use("Edit", Some(&input)), Some("b/c.txt".to_string()));
        assert_eq!(format_tool_use("Write", Some(&input)), Some("b/c.txt".to_string()));
    }

    #[test]
    fn bash_prefers_description_then_command() {
        let with_desc = json!({ "description": "run tests", "command": "cargo test" });
        assert_eq!(format_tool_use("Bash", Some(&with_desc)), Some("run tests".to_string()));
        let cmd_only = json!({ "command": "git status" });
        assert_eq!(format_tool_use("Bash", Some(&cmd_only)), Some("git status".to_string()));
    }

    #[test]
    fn grep_appends_path_when_present() {
        let input = json!({ "pattern": "TODO", "path": "/x/y/src" });
        assert_eq!(
            format_tool_use("Grep", Some(&input)),
            Some("TODO in y/src".to_string())
        );
        let no_path = json!({ "pattern": "TODO" });
        assert_eq!(format_tool_use("Grep", Some(&no_path)), Some("TODO".to_string()));
    }

    #[test]
    fn agent_and_task_truncate_description() {
        let long = "a".repeat(100);
        let input = json!({ "description": long });
        let out = format_tool_use("Agent", Some(&input)).unwrap();
        // 60 chars + 省略号
        assert_eq!(out.chars().count(), 61);
        assert!(out.ends_with('…'));
        assert_eq!(format_tool_use("Task", Some(&input)).unwrap().chars().count(), 61);
    }

    #[test]
    fn glob_truncates_pattern() {
        let input = json!({ "pattern": "**/*.rs" });
        assert_eq!(format_tool_use("Glob", Some(&input)), Some("**/*.rs".to_string()));
    }

    #[test]
    fn unknown_tool_returns_none() {
        let input = json!({ "anything": "value" });
        assert_eq!(format_tool_use("mcp__github__create_issue", Some(&input)), None);
    }

    #[test]
    fn missing_or_empty_fields_return_none() {
        assert_eq!(format_tool_use("Read", None), None);
        let empty = json!({ "file_path": "" });
        assert_eq!(format_tool_use("Read", Some(&empty)), None);
    }

    #[test]
    fn truncate_is_char_safe_for_multibyte() {
        let s = "中文".repeat(50); // 100 chars, multi-byte
        let out = truncate_chars(&s, 10);
        assert_eq!(out.chars().count(), 11); // 10 + 省略号
        assert!(out.ends_with('…'));
    }

    #[test]
    fn shorten_path_handles_bare_filename() {
        assert_eq!(shorten_path("main.rs"), "main.rs");
    }
}
