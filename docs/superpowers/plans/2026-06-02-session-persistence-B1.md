# Group B-1: 持久可恢复会话（基石层）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zeromux 会话（Claude/Kiro/Codex/tmux）在进程崩溃或服务器重启后能恢复对话上下文，不再静默蒸发。

**Architecture:** 解耦 `Session`（持久逻辑对话）与 `RunningProcess`（临时运行进程，作为 `Session` 的 `Option` 字段，单一事实源）。新增总是开启的 SQLite `SessionStore` 持久化元数据 + ResumeToken。启动懒装载（不预热）；用户访问时按 ResumeToken 重生进程。fan-out 仍独占进程（Drop 不变量保留）。

**Tech Stack:** Rust（rusqlite、tokio、`std::sync::Mutex`）、现有三 agent process + tmux PTY。

**Spec:** `docs/superpowers/specs/2026-06-02-session-persistence-B1-design.md`

**关键约束（来自 spec，实现期务必遵守）：**
- `sessions` 是 `std::sync::Mutex` —— **绝不可持 guard 跨 `.await`**（guard 非 Send + 阻塞执行器）。
- `worktree_path` 留在 `Session`（跨重生复用），不进 `RunningProcess`。
- fan-out 回引用 SessionManager 用 `Weak`（避免 Arc 环）。
- resume 失败一律降级为全新 session + `resume_failed` 事件，绝不卡死。
- **Task 0 spike 的结论是 Task 5/6 的事实依据**；若某后端 headless resume 不可行，该后端降级为「重建为全新 session」，不阻塞其他后端。

**Git 卫生：** 工作树有预存无关 WIP（main.rs/web.rs/session_manager.rs 已修改 + 未跟踪文件）。每个 commit 用**精确 per-file `git add`**，绝不用 `git add -A`/`git add .`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `/tmp/b1-spike/*` | Task 0 resume 可行性验证脚本（丢弃式，不进 git） | 临时 |
| `src/session_store.rs` | SQLite 持久化：sessions 表 CRUD + ResumeToken 序列化 | 新建 |
| `src/session_manager.rs` | Session/RunningProcess 解耦、ensure_running、fan-out 退出语义、四类 resume 接线 | 重组 |
| `src/acp/process.rs` | Claude `AcpProcess::spawn` 加 `resume` 参数 | 修改 |
| `src/acp/codex_process.rs` | `CodexProcess::spawn` 加 `resume_thread` 参数 | 修改 |
| `src/acp/kiro_process.rs` | 握手按 token 选 `session/load` vs `session/new` | 修改 |
| `src/main.rs` | 构造并注入 `SessionStore`，启动 `load_all` | 修改 |
| `frontend/src/components/AcpChatView.tsx` | 识别 `resume_failed` system subtype（渲染为现有 system 文本） | 修改 |

---

## Task 0: resume 可行性 spike（gates 所有后续 resume 任务）

**Files:** 丢弃式脚本，写在 `/tmp/b1-spike/`，**不提交**。

目的：在写任何生产代码前，用真实 CLI 确认 headless 模式下 resume 真能回灌对话上下文。结论写进本计划的「Spike 结论」节（Step 6）。

- [ ] **Step 1: Claude headless resume 验证**

创建 `/tmp/b1-spike/claude_spike.py`（用 `uv run --with '' python3` 运行，无需第三方库——直接子进程驱动）：

```python
import subprocess, json, time, sys
CLAUDE = "/home/ubuntu/.local/bin/claude"
ARGS = ["-p","--output-format","stream-json","--input-format","stream-json","--verbose","--dangerously-skip-permissions"]

def run_turn(extra_args, prompt, timeout=90):
    p = subprocess.Popen([CLAUDE]+extra_args+ARGS, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, bufsize=1)
    msg = {"type":"user","message":{"role":"user","content":[{"type":"text","text":prompt}]}}
    p.stdin.write(json.dumps(msg)+"\n"); p.stdin.flush()
    session_id=None; result_text=None; deadline=time.time()+timeout
    while time.time()<deadline:
        line=p.stdout.readline()
        if not line: break
        line=line.strip()
        if not line: continue
        try: ev=json.loads(line)
        except: continue
        if ev.get("session_id"): session_id=ev["session_id"]
        if ev.get("type")=="result": result_text=ev.get("result",""); break
    p.terminate()
    return session_id, result_text

sid,_ = run_turn([], "Remember the number 42. Just acknowledge.")
print("captured session_id:", sid)
assert sid, "no session_id captured"
sid2, ans = run_turn(["--resume", sid], "What number did I ask you to remember? Answer with just the number.")
print("resume answer:", repr(ans))
print("RESUME_WORKS:", "42" in (ans or ""))
```

Run: `cd /tmp/b1-spike && uv run --quiet --with '' python3 claude_spike.py`
Expected: 打印 `RESUME_WORKS: True`（若 False，记录在 Spike 结论，Claude 降级）。

- [ ] **Step 2: Kiro session/load 验证**

创建 `/tmp/b1-spike/kiro_spike.py`：

```python
import subprocess, json, time
KIRO="/home/ubuntu/.local/bin/kiro-cli"
def start():
    return subprocess.Popen([KIRO,"acp","--trust-all-tools"], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
def send(p,obj): p.stdin.write(json.dumps(obj)+"\n"); p.stdin.flush()
def read_until(p, pred, timeout=90):
    import time; d=time.time()+timeout
    while time.time()<d:
        line=p.stdout.readline()
        if not line: return None
        line=line.strip()
        if not line: continue
        try: m=json.loads(line)
        except: continue
        if pred(m): return m
    return None

# session 1: new + remember
p=start()
send(p,{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":True,"writeTextFile":True},"terminal":True},"clientInfo":{"name":"spike","version":"0.1"}}})
read_until(p, lambda m: m.get("id")==0 and "result" in m)
import os
cwd=os.getcwd()
send(p,{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":cwd,"mcpServers":[]}})
r=read_until(p, lambda m: m.get("id")==1 and "result" in m)
sid=r["result"]["sessionId"]; print("kiro sessionId:", sid)
send(p,{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":"Remember the number 42. Just acknowledge."}]}})
read_until(p, lambda m: m.get("id")==2 and ("result" in m or "error" in m))
p.terminate()

# session 2: load + ask
p2=start()
send(p2,{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":True,"writeTextFile":True},"terminal":True},"clientInfo":{"name":"spike","version":"0.1"}}})
read_until(p2, lambda m: m.get("id")==0 and "result" in m)
send(p2,{"jsonrpc":"2.0","id":1,"method":"session/load","params":{"sessionId":sid,"cwd":cwd,"mcpServers":[]}})
loadres=read_until(p2, lambda m: m.get("id")==1 and ("result" in m or "error" in m))
print("session/load response:", json.dumps(loadres)[:300])
send(p2,{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":"What number did I ask you to remember? Answer with just the number."}]}})
# collect agent_message_chunk text
import time; d=time.time()+90; txt=""
while time.time()<d:
    line=p2.stdout.readline()
    if not line: break
    line=line.strip()
    if not line: continue
    try: m=json.loads(line)
    except: continue
    if m.get("method")=="session/update":
        u=m.get("params",{}).get("update",{})
        if u.get("sessionUpdate")=="agent_message_chunk":
            txt += u.get("content",{}).get("text","")
    if m.get("id")==2 and ("result" in m or "error" in m): break
print("kiro resume answer:", repr(txt))
print("RESUME_WORKS:", "42" in txt)
p2.terminate()
```

Run: `cd /tmp/b1-spike && uv run --quiet --with '' python3 kiro_spike.py`
Expected: `session/load` 返回 result（非 error）且 `RESUME_WORKS: True`。

- [ ] **Step 3: Codex cross-process threadId 验证**

Codex 经 MCP，跨进程 spike 较重。**判定**：检查 `codex mcp-server` 的 `codex-reply` 是否接受任意先前 threadId（不限本进程创建）。最小验证——用现有 zeromux Codex 会话拿到一个 threadId（从日志或 `set_resume_token` 预埋点），新进程发 `codex-reply`。**若 spike 成本过高**：标记 Codex 为「跨进程 resume 待运行时验证」，Task 6 实现时带降级，先按「能则用、不能则全新」编码。

Run（轻量探查）：`/home/ubuntu/.local/bin/codex --help 2>&1 | grep -iE "resume|reply|thread" | head`
记录输出。

- [ ] **Step 4: 清理 spike 脚本**

Run: `rm -rf /tmp/b1-spike`
（脚本是丢弃式的，不进 git。结论保留在本计划。）

- [ ] **Step 5: 把 Spike 结论写进本计划文档**

编辑本文件，在下方「## Spike 结论」节填入三后端的实测结果（WORKS / 降级），作为 Task 5/6/7 的事实依据。

- [ ] **Step 6: 提交计划文档更新（仅文档）**

```bash
git add docs/superpowers/plans/2026-06-02-session-persistence-B1.md
git commit -m "docs(plan): record B-1 resume feasibility spike results" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

## Spike 结论（2026-06-02 实测）

- **Claude**：✅ **RESUME_WORKS = True**。`claude -p --output-format stream-json --resume <session_id>` 在 fresh 进程中正确回灌上下文（记 42 → 杀进程 → 新进程 --resume → 答 42）。captured session_id 来自事件流的 `session_id` 字段。→ Task 6 按 `--resume` 实现。
- **Kiro**：✅ **RESUME_WORKS = True**，**但有进程独占锁约束**。`session/load {sessionId, cwd, mcpServers}` 在 fresh 进程中回灌上下文成功。**关键陷阱**：若旧进程未完全退出，`session/load` 报 `-32603 "Session is active in another process (PID …)"`。spike 用 SIGTERM 立即 load 会失败；改为 `kill + wait + sleep 5s` 后成功。
  - **→ Task 7 实现约束**：resume Kiro 前必须确保旧 RunningProcess 已 drop 且其子进程已退出。zeromux 的 Drop 模型（休眠 = `running=None` → channel 关闭 → fan-out 退出 → `KiroProcess` Drop → `child.start_kill()`）满足这点，但 `ensure_running` 重生 Kiro 时若刚 drop 过，需容忍 `session/load` 的瞬时锁冲突——**实现里 session/load 失败一律走 resume_failed 降级（全新 session），不重试不卡死**。Kiro 的 `~/.kiro/sessions/` 持久化会话历史，session/load 读它。
- **Codex**：⏳ **待运行时验证**。codex 二进制在 `/usr/bin/codex`（非 `~/.local/bin`）。`codex-reply` 跨进程行为未做独立 spike（MCP 驱动，spike 成本高）。→ Task 6 按「有 threadId 则 codex-reply、失败则 resume_failed 降级」编码，运行时验证。

**总结论**：三后端均按「能 resume 则 resume，任何失败一律 resume_failed 降级为全新 session」实现，绝不卡死。Kiro 尤其依赖降级安全网。

---

## Task 1: `ResumeToken` 类型 + 序列化（纯函数，独立可测）

**Files:**
- Modify: `src/session_manager.rs`（加 `ResumeToken` 枚举 + 序列化方法 + 内联测试）

不依赖 spike 结论，可立即做。

- [ ] **Step 1: 写失败测试**

在 `src/session_manager.rs` 末尾加内联测试模块（若已有 `#[cfg(test)]` 则并入）：

```rust
#[cfg(test)]
mod resume_token_tests {
    use super::ResumeToken;

    #[test]
    fn roundtrip_all_variants() {
        let cases = [
            (ResumeToken::Claude("sid-1".into()), ("claude", "sid-1")),
            (ResumeToken::Kiro("k-2".into()), ("kiro", "k-2")),
            (ResumeToken::Codex("t-3".into()), ("codex", "t-3")),
            (ResumeToken::Tmux("work".into()), ("tmux", "work")),
        ];
        for (token, (kind, val)) in cases {
            let (k, v) = token.to_kind_value();
            assert_eq!((k, v.as_str()), (kind, val));
            let back = ResumeToken::from_kind_value(kind, val).unwrap();
            assert_eq!(back, token);
        }
    }

    #[test]
    fn from_unknown_kind_is_none() {
        assert!(ResumeToken::from_kind_value("bogus", "x").is_none());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test resume_token`
Expected: 编译失败（`ResumeToken` 未定义）。

- [ ] **Step 3: 实现 `ResumeToken`**

在 `src/session_manager.rs` 的 `SessionType` 定义附近加：

```rust
/// 跨进程恢复会话上下文的令牌，按后端区分。持久化为 (kind, value) 两列。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeToken {
    Claude(String), // --resume <session_id>
    Kiro(String),   // session/load <sessionId>
    Codex(String),  // codex-reply threadId
    Tmux(String),   // tmux attach -t <target>
}

impl ResumeToken {
    /// 拆成持久化用的 (kind, value)。
    pub fn to_kind_value(&self) -> (&'static str, String) {
        match self {
            ResumeToken::Claude(v) => ("claude", v.clone()),
            ResumeToken::Kiro(v) => ("kiro", v.clone()),
            ResumeToken::Codex(v) => ("codex", v.clone()),
            ResumeToken::Tmux(v) => ("tmux", v.clone()),
        }
    }

    /// 从持久化的 (kind, value) 还原。未知 kind 返回 None。
    pub fn from_kind_value(kind: &str, value: &str) -> Option<Self> {
        match kind {
            "claude" => Some(ResumeToken::Claude(value.to_string())),
            "kiro" => Some(ResumeToken::Kiro(value.to_string())),
            "codex" => Some(ResumeToken::Codex(value.to_string())),
            "tmux" => Some(ResumeToken::Tmux(value.to_string())),
            _ => None,
        }
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test resume_token`
Expected: 2 测试通过。

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(session): add ResumeToken enum with (kind,value) serialization" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `SessionStore` SQLite 持久化模块

**Files:**
- Create: `src/session_store.rs`
- Modify: `src/main.rs`（声明模块）

镜像 `src/events.rs` 的 `EventStore::open` 模式（`Mutex<Connection>`，总是开）。

- [ ] **Step 1: 声明模块**

在 `src/main.rs` 顶部模块声明区（与 `mod events;` 等并列）加：`mod session_store;`

- [ ] **Step 2: 写 SessionStore（含失败测试）**

创建 `src/session_store.rs`：

```rust
//! 会话元数据持久化（SQLite）。总是开启（不依赖 OAuth 模式），
//! 使 zeromux 重启后能懒装载、按 ResumeToken 重生会话进程。
//! 镜像 events.rs 的 EventStore::open 模式。

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use crate::session_manager::{ResumeToken, SessionType};

/// 从 SQLite 读回的一条会话元数据（不含运行态）。
#[derive(Debug, Clone, PartialEq)]
pub struct PersistedSession {
    pub id: String,
    pub name: String,
    pub session_type: SessionType,
    pub work_dir: String,
    pub owner_id: String,
    pub description: String,
    pub resume_token: Option<ResumeToken>,
    pub worktree_path: Option<String>,
    pub created_ms: i64,
}

pub struct SessionStore {
    conn: Mutex<Connection>,
}

impl SessionStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        let db_path = data_dir.join("zeromux.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open session db: {}", e))?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                work_dir TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                resume_kind TEXT,
                resume_value TEXT,
                worktree_path TEXT,
                created_ms INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("Failed to create sessions table: {}", e))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn upsert(&self, s: &PersistedSession) -> Result<(), String> {
        let (rk, rv) = match &s.resume_token {
            Some(t) => { let (k, v) = t.to_kind_value(); (Some(k.to_string()), Some(v)) }
            None => (None, None),
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET
               name=?2, type=?3, work_dir=?4, owner_id=?5, description=?6,
               resume_kind=?7, resume_value=?8, worktree_path=?9",
            params![s.id, s.name, s.session_type.to_string(), s.work_dir, s.owner_id,
                    s.description, rk, rv, s.worktree_path, s.created_ms],
        )
        .map_err(|e| format!("upsert failed: {}", e))?;
        Ok(())
    }

    pub fn update_resume_token(&self, id: &str, token: Option<&ResumeToken>) -> Result<(), String> {
        let (rk, rv) = match token {
            Some(t) => { let (k, v) = t.to_kind_value(); (Some(k.to_string()), Some(v)) }
            None => (None, None),
        };
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET resume_kind=?2, resume_value=?3 WHERE id=?1",
                     params![id, rk, rv])
            .map_err(|e| format!("update_resume_token failed: {}", e))?;
        Ok(())
    }

    pub fn update_name(&self, id: &str, name: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET name=?2 WHERE id=?1", params![id, name])
            .map_err(|e| format!("update_name failed: {}", e))?;
        Ok(())
    }

    pub fn update_description(&self, id: &str, description: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE sessions SET description=?2 WHERE id=?1", params![id, description])
            .map_err(|e| format!("update_description failed: {}", e))?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id=?1", params![id])
            .map_err(|e| format!("delete failed: {}", e))?;
        Ok(())
    }

    pub fn load_all(&self) -> Result<Vec<PersistedSession>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,name,type,work_dir,owner_id,description,resume_kind,resume_value,worktree_path,created_ms FROM sessions")
            .map_err(|e| format!("prepare failed: {}", e))?;
        let rows = stmt.query_map([], |row| {
            let type_str: String = row.get(2)?;
            let rk: Option<String> = row.get(6)?;
            let rv: Option<String> = row.get(7)?;
            let resume_token = match (rk, rv) {
                (Some(k), Some(v)) => ResumeToken::from_kind_value(&k, &v),
                _ => None,
            };
            Ok(PersistedSession {
                id: row.get(0)?,
                name: row.get(1)?,
                session_type: SessionType::from_str_lenient(&type_str),
                work_dir: row.get(3)?,
                owner_id: row.get(4)?,
                description: row.get(5)?,
                resume_token,
                worktree_path: row.get(8)?,
                created_ms: row.get(9)?,
            })
        }).map_err(|e| format!("query failed: {}", e))?;
        let mut out = Vec::new();
        for r in rows { out.push(r.map_err(|e| format!("row failed: {}", e))?); }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_manager::{ResumeToken, SessionType};

    fn tmp_store() -> (SessionStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        (store, dir)
    }

    fn sample(id: &str, token: Option<ResumeToken>) -> PersistedSession {
        PersistedSession {
            id: id.into(), name: "n".into(), session_type: SessionType::Claude,
            work_dir: "/w".into(), owner_id: "u".into(), description: "d".into(),
            resume_token: token, worktree_path: Some("/wt".into()), created_ms: 1000,
        }
    }

    #[test]
    fn upsert_then_load() {
        let (s, _d) = tmp_store();
        s.upsert(&sample("a", Some(ResumeToken::Claude("sid".into())))).unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], sample("a", Some(ResumeToken::Claude("sid".into()))));
    }

    #[test]
    fn upsert_is_idempotent_update() {
        let (s, _d) = tmp_store();
        s.upsert(&sample("a", None)).unwrap();
        let mut updated = sample("a", None); updated.name = "renamed".into();
        s.upsert(&updated).unwrap();
        let all = s.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "renamed");
    }

    #[test]
    fn update_resume_token_roundtrip() {
        let (s, _d) = tmp_store();
        s.upsert(&sample("a", None)).unwrap();
        s.update_resume_token("a", Some(&ResumeToken::Kiro("kid".into()))).unwrap();
        assert_eq!(s.load_all().unwrap()[0].resume_token, Some(ResumeToken::Kiro("kid".into())));
        s.update_resume_token("a", None).unwrap();
        assert_eq!(s.load_all().unwrap()[0].resume_token, None);
    }

    #[test]
    fn delete_removes_row() {
        let (s, _d) = tmp_store();
        s.upsert(&sample("a", None)).unwrap();
        s.delete("a").unwrap();
        assert!(s.load_all().unwrap().is_empty());
    }
}
```

- [ ] **Step 3: 加 `SessionType::from_str_lenient` 辅助**

`load_all` 需要从字符串还原 `SessionType`。在 `src/session_manager.rs` 的 `impl SessionType` 区（或新建 impl）加：

```rust
impl SessionType {
    /// 从持久化字符串还原；未知值回落 Tmux（最保守，PTY 无 resume 副作用）。
    pub fn from_str_lenient(s: &str) -> Self {
        match s {
            "claude" => SessionType::Claude,
            "kiro" => SessionType::Kiro,
            "codex" => SessionType::Codex,
            _ => SessionType::Tmux,
        }
    }
}
```

- [ ] **Step 4: 确认 `tempfile` 是 dev-dependency**

Run: `grep -A20 '\[dev-dependencies\]' Cargo.toml | grep tempfile || echo MISSING`
若 MISSING：`cargo add --dev tempfile`

- [ ] **Step 5: 运行测试**

Run: `cargo test session_store`
Expected: 4 测试通过。

- [ ] **Step 6: Commit**

```bash
git add src/session_store.rs src/main.rs src/session_manager.rs Cargo.toml Cargo.lock
git commit -m "feat(session): add SessionStore SQLite persistence (always-open)" -m "Mirrors EventStore::open. CRUD + ResumeToken (kind,value) columns + load_all. Inline tests with tempfile." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 核心模型重组 —— `Session.running: Option<RunningProcess>`

**Files:**
- Modify: `src/session_manager.rs`（结构 + 所有访问器 + 四个 create 路径 + 四个 fan-out 签名）

> **这是 B-1 风险最高的任务（中高）。** 它把 `event_tx`/`input_tx`/`pty_pid` 从 `Session` 移进 `RunningProcess`，所有读这些字段的访问器（`subscribe`/`input_tx`/`pty_pid`）都要改为先取 `running`。**不引入任何 resume 行为**（那是 Task 4-7）——本任务纯结构搬移，行为等价，编译通过 + 现有测试通过即算成功。

- [ ] **Step 1: 定义 `RunningProcess`，重组 `Session`**

在 `src/session_manager.rs`：

新增结构（放在 `Session` 定义前）：
```rust
/// 一个会话的运行态：仅当进程存活时存在。fan-out 任务独占其中的进程句柄
/// （通过 channel）。Drop 此结构 → channel 关闭 → fan-out 退出 → 进程死。
struct RunningProcess {
    event_tx: broadcast::Sender<String>,
    input_tx: mpsc::Sender<SessionInput>,
    pty_pid: Option<u32>,
}
```

把 `Session` 改为（`event_tx`/`input_tx`/`pty_pid` 移入 running；新增 `resume_token`/`created_ms`/`spawning`；`worktree_path`/`scrollback` 留在 Session）：
```rust
pub struct Session {
    pub id: String,
    pub name: String,
    pub session_type: SessionType,
    pub cols: u16,
    pub rows: u16,
    pub work_dir: String,
    pub owner_id: String,
    pub description: String,
    pub status: SessionMeta,
    resume_token: Option<ResumeToken>,
    worktree_path: Option<PathBuf>,
    created_ms: i64,
    /// 并发重生互斥（仅锁内访问，见 Task 4）。
    spawning: bool,
    /// 运行态；None = 未运行（可按 resume_token 重生）。
    running: Option<RunningProcess>,
    scrollback: VecDeque<String>,
    scrollback_bytes: usize,
}
```

- [ ] **Step 2: 更新访问器读 `running`**

`subscribe`、`input_tx`、`pty_pid` 这三个访问器当前直接读 `s.event_tx`/`s.input_tx`/`s.pty_pid`。改为经 `running`：

```rust
pub fn subscribe(&self, id: &str) -> Option<broadcast::Receiver<String>> {
    self.sessions.lock().unwrap().get(id)
        .and_then(|s| s.running.as_ref())
        .map(|rp| rp.event_tx.subscribe())
}

pub fn input_tx(&self, id: &str) -> Option<mpsc::Sender<SessionInput>> {
    self.sessions.lock().unwrap().get(id)
        .and_then(|s| s.running.as_ref())
        .map(|rp| rp.input_tx.clone())
}

pub fn pty_pid(&self, id: &str) -> Option<u32> {
    self.sessions.lock().unwrap().get(id)
        .and_then(|s| s.running.as_ref())
        .and_then(|rp| rp.pty_pid)
}
```
（若 `input_tx`/`subscribe` 的现有签名不同，保持签名，只改取值路径。其余访问器 `get_scrollback`/`push_scrollback`/`work_dir`/`session_type`/`update_session_status` 读的字段仍在 Session 上，不变。）

- [ ] **Step 3: 更新四个 create 路径构造 `running: Some(...)`**

每个 `create_*_session`（tmux 在 ~:283、claude/acp 在 ~:344、kiro ~:366、codex ~:427）的 `Session { ... }` 构造里，把 `event_tx`/`input_tx`/`pty_pid` 包进 `running: Some(RunningProcess { event_tx, input_tx, pty_pid })`，并加新字段。以 `create_acp_session` 为例，构造改为：

```rust
let now_ms = now_millis();
let session = Session {
    id: id.clone(),
    name,
    session_type: SessionType::Claude,
    cols, rows,
    work_dir: effective_dir.to_string_lossy().to_string(),
    owner_id: owner_id.to_string(),
    description: String::new(),
    status: SessionMeta::Running,
    resume_token: None,
    worktree_path,
    created_ms: now_ms,
    spawning: false,
    running: Some(RunningProcess { event_tx, input_tx, pty_pid: None }),
    scrollback: VecDeque::new(),
    scrollback_bytes: 0,
};
```
tmux 路径的 `running` 用 `pty_pid: pid`（它有真实 pid）。codex/kiro 用 `pty_pid: None`。

加一个时间辅助（文件内）：
```rust
fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
```

- [ ] **Step 4: 编译并跑现有测试（行为等价验证）**

Run: `cargo build 2>&1 | tail -20`
Expected: 编译通过。若报「private field」错误：访问器都在 `impl SessionManager` 内，`running`/字段为私有没问题；外部只通过方法访问。
Run: `cargo test 2>&1 | tail -15`
Expected: 现有测试 + Task 1/2 测试全绿（本任务行为等价，无新测试）。

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "refactor(session): decouple RunningProcess as Option field on Session" -m "Move event_tx/input_tx/pty_pid into RunningProcess; Session keeps metadata + worktree + scrollback + new resume_token/created_ms/spawning. Behavior-equivalent structural move; resume behavior added in later tasks. Single source of truth, Drop invariant preserved." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 持久化接线 + 启动懒装载 + fan-out 退出语义

**Files:**
- Modify: `src/session_manager.rs`（`new` 接 store、create 路径 upsert、删除 delete、`load_persisted`、fan-out 退出置 None）
- Modify: `src/main.rs`（构造 SessionStore，注入，启动 load）

> 仍不引入 resume spawn（Task 5-7）。本任务让元数据落库、重启时装回内存（running=None）、进程自退时保留元数据。

- [ ] **Step 1: `SessionManager` 持有 `Arc<SessionStore>` + `Weak<Self>` 自引用**

为支持 fan-out 回调，`SessionManager` 需能被 fan-out 以 `Weak` 持有。改造：

```rust
use std::sync::{Arc, Mutex, Weak};
use crate::session_store::{SessionStore, PersistedSession};

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    events: Arc<EventStore>,
    store: Arc<SessionStore>,
    self_weak: Mutex<Weak<SessionManager>>, // 启动时回填，供 fan-out upgrade()
}

impl SessionManager {
    pub fn new(events: Arc<EventStore>, store: Arc<SessionStore>) -> Arc<Self> {
        let mgr = Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            events,
            store,
            self_weak: Mutex::new(Weak::new()),
        });
        *mgr.self_weak.lock().unwrap() = Arc::downgrade(&mgr);
        mgr
    }

    fn weak(&self) -> Weak<SessionManager> {
        self.self_weak.lock().unwrap().clone()
    }
}
```
> 注意：`new` 现在返回 `Arc<Self>`。`AppState.sessions` 字段类型要从 `SessionManager` 改为 `Arc<SessionManager>`，并更新所有 `state.sessions.foo()` 调用点（方法签名不变，`Arc` 自动 deref）。

- [ ] **Step 2: 更新 main.rs 构造**

`src/main.rs` 构造区（~:206-221）：在 `event_store` 后加 SessionStore，并改 SessionManager 构造：
```rust
let session_store = Arc::new(
    session_store::SessionStore::open(std::path::Path::new(&data_dir_str))
        .expect("Failed to initialize session store"),
);
```
`AppState { sessions: session_manager::SessionManager::new(event_store.clone(), session_store.clone()), ... }`。
`AppState` 结构体里 `pub sessions: session_manager::SessionManager` 改为 `pub sessions: Arc<session_manager::SessionManager>`。

- [ ] **Step 3: create 路径写 SQLite（仅 agent + tmux 持久化）**

每个 `create_*_session` 在 `insert` 后加 upsert（tmux 的 resume_token 立即设为 `Tmux(target)`，agent 初始 None）。抽一个辅助：
```rust
fn persist_meta(&self, s: &Session) {
    let pj = PersistedSession {
        id: s.id.clone(), name: s.name.clone(), session_type: s.session_type,
        work_dir: s.work_dir.clone(), owner_id: s.owner_id.clone(),
        description: s.description.clone(), resume_token: s.resume_token.clone(),
        worktree_path: s.worktree_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        created_ms: s.created_ms,
    };
    if let Err(e) = self.store.upsert(&pj) {
        tracing::warn!("persist session {} failed: {}", s.id, e);
    }
}
```
每个 create 在 `insert` 之后调 `self.persist_meta(&session)` —— 但 `session` 已被 move 进 map。改为：insert 前先 `self.persist_meta(&session)`，再 insert。tmux 路径在构造 `session` 时设 `resume_token: tmux_target.map(|t| ResumeToken::Tmux(t.to_string()))`（无 target 的纯 shell 会话 resume_token=None，重启不存活——合理，shell 无持久语义）。

- [ ] **Step 4: `remove_session` 删 SQLite**

在现有 `remove_session`（~:533）的成功分支加 `let _ = self.store.delete(id);`（worktree 清理逻辑保留不动）。

- [ ] **Step 5: `set_resume_token` + 状态更新写库**

加方法（fan-out 回填 token 用）：
```rust
pub fn set_resume_token(&self, id: &str, token: ResumeToken) {
    let mut map = self.sessions.lock().unwrap();
    if let Some(s) = map.get_mut(id) {
        if s.resume_token.as_ref() == Some(&token) { return; }
        s.resume_token = Some(token.clone());
        drop(map); // 释放锁再写库（rusqlite 自带锁，避免嵌套持锁）
        let _ = self.store.update_resume_token(id, Some(&token));
    }
}
```
`update_session`（改名/描述，~:574）成功分支同步 `self.store.update_name/description`。

- [ ] **Step 6: `load_persisted` 启动装载**

加方法，把持久化的会话装回内存（`running = None`）：
```rust
pub fn load_persisted(&self) {
    let rows = match self.store.load_all() {
        Ok(r) => r, Err(e) => { tracing::warn!("load_all failed: {}", e); return; }
    };
    let mut map = self.sessions.lock().unwrap();
    for p in rows {
        if map.contains_key(&p.id) { continue; }
        map.insert(p.id.clone(), Session {
            id: p.id, name: p.name, session_type: p.session_type,
            cols: 80, rows: 24,
            work_dir: p.work_dir, owner_id: p.owner_id, description: p.description,
            status: SessionMeta::Idle,
            resume_token: p.resume_token,
            worktree_path: p.worktree_path.map(PathBuf::from),
            created_ms: p.created_ms,
            spawning: false,
            running: None,            // 未运行，按需重生
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        });
    }
}
```
在 `main.rs` AppState 构造后、`serve` 前调用一次：`state.sessions.load_persisted();`

- [ ] **Step 7: fan-out 退出置 None（四个 fanout）**

四个 `spawn_*_fanout`（含 tmux 内联 fan-out）当前结束时直接退出。改为：传入 `Weak<SessionManager>` + `sid`，循环结束后置 running=None。给每个 fanout 函数加参数 `mgr: Weak<SessionManager>`，循环 `break` 后：
```rust
if let Some(mgr) = mgr.upgrade() {
    if let Some(s) = mgr.sessions.lock().unwrap().get_mut(&sid) {
        s.running = None;
        s.status = SessionMeta::Idle;
    }
}
```
调用点（create 路径）传 `self.weak()`。tmux 的内联 `tokio::spawn` fan-out 同样处理。

- [ ] **Step 8: 编译 + 测试 + 手动冒烟**

Run: `cargo build 2>&1 | tail -20` → 编译通过。
Run: `cargo test 2>&1 | tail -15` → 全绿。
手动：构建 debug 跑一个临时实例（不同端口，避免动线上），创建一个 tmux session，确认 `~/.zeromux/zeromux.db` 的 sessions 表有行（`sqlite3 ~/.zeromux/zeromux.db 'select id,type,resume_kind from sessions'`）。

- [ ] **Step 9: Commit**

```bash
git add src/session_manager.rs src/main.rs
git commit -m "feat(session): persist metadata, lazy-load on startup, fan-out exit keeps session" -m "SessionManager holds Arc<SessionStore> + Weak<self>; create paths upsert; remove deletes; load_persisted restores sessions with running=None; fan-out exit sets running=None instead of dropping the session." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `ensure_running` 并发安全重生（无 resume，先全新）

**Files:**
- Modify: `src/session_manager.rs`（`ensure_running` + 抽取 spawn 辅助）
- Modify: `src/acp/ws_handler.rs` + `src/ws_handler.rs`（连入前调 ensure_running）

> 先实现「未运行 → spawn **全新** 进程」的 ensure_running（不带 token），把并发模型和触发点打通；Task 6/7 再让它带 resume_token。

- [ ] **Step 1: 实现 `ensure_running`（锁外 await + spawning 标志）**

```rust
/// 确保 session 有活进程；未运行则按 type 重生。并发安全（spawning 标志防双 spawn）。
pub async fn ensure_running(&self, id: &str) -> Result<(), String> {
    // 阶段 1：锁内决策
    let spawn_plan = {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or("session not found")?;
        if s.running.is_some() { return Ok(()); }
        if s.spawning {
            None // 别人在 spawn，下面锁外轮询等待
        } else {
            s.spawning = true;
            Some((s.session_type, s.resume_token.clone(),
                  s.work_dir.clone(),
                  s.worktree_path.clone()))
        }
    };
    // 别人在 spawn：轮询等待 running 出现（最多 ~30s）
    let Some((stype, token, work_dir, worktree)) = spawn_plan else {
        for _ in 0..300 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let map = self.sessions.lock().unwrap();
            match map.get(id) {
                Some(s) if s.running.is_some() => return Ok(()),
                Some(s) if s.spawning => continue,
                Some(_) => return Err("spawn aborted".into()),
                None => return Err("session removed".into()),
            }
        }
        return Err("timed out waiting for concurrent spawn".into());
    };
    // 阶段 2：锁外 await spawn（Task 6/7 会按 token 分流；本任务先全新）
    let result = self.spawn_running(id, stype, token, &work_dir, worktree).await;
    // 阶段 3：锁内装回 + 清 spawning
    let mut map = self.sessions.lock().unwrap();
    if let Some(s) = map.get_mut(id) {
        s.spawning = false;
        match result {
            Ok(rp) => { s.running = Some(rp); s.status = SessionMeta::Running; Ok(()) }
            Err(e) => Err(e),
        }
    } else { Err("session removed during spawn".into()) }
}
```

- [ ] **Step 2: 抽取四个共享 spawn 辅助（消除 create_* 与 ensure_running 的重复）**

这是本任务最大工作量。把每个 `create_*_session` 里「spawn process → 起 fan-out → 得到 (event_tx,input_tx,pty_pid)」抽成内部函数，每个返回 `RunningProcess`，内部完成 process spawn + fan-out 启动（fan-out 传 `self.weak()` + id，见 Task 4 Step 7）。签名（Task 6/7 会用到 resume 参数，本任务一律传 None）：

```rust
async fn spawn_claude(&self, id: &str, work_dir: &str, resume: Option<&str>) -> Result<RunningProcess, String>;
async fn spawn_kiro(&self, id: &str, work_dir: &str, resume: Option<&str>) -> Result<RunningProcess, String>;
async fn spawn_codex(&self, id: &str, work_dir: &str, resume: Option<String>) -> Result<RunningProcess, String>;
async fn spawn_tmux(&self, id: &str, work_dir: &str, target: Option<&str>) -> Result<RunningProcess, String>;
```

每个内部：调对应 `*Process::spawn`（Task 6/7 给它们加 resume 参数；本任务先按现有无-resume 签名调用，resume 参数暂时忽略并加 `// resume wired in Task 6/7` 注释）→ 建 channel → 起 fan-out → 返回 `RunningProcess { event_tx, input_tx, pty_pid }`。`create_*_session` 改为：`let rp = self.spawn_<kind>(&id, &work_dir, None).await?;` → 构造 Session（`running: Some(rp)` + 元数据）→ `persist_meta` → insert。

`spawn_running` 直接 match 分流到这四个（本任务忽略 token，一律传 None；Task 6/7 改传实际值）：
```rust
async fn spawn_running(
    &self, id: &str, stype: SessionType, token: Option<ResumeToken>,
    work_dir: &str, worktree: Option<PathBuf>,
) -> Result<RunningProcess, String> {
    let _ = (&token, &worktree); // token/worktree 在 Task 6/7 使用
    match stype {
        SessionType::Claude => self.spawn_claude(id, work_dir, None).await,
        SessionType::Kiro   => self.spawn_kiro(id, work_dir, None).await,
        SessionType::Codex  => self.spawn_codex(id, work_dir, None).await,
        SessionType::Tmux   => self.spawn_tmux(id, work_dir, None).await,
    }
}
```

- [ ] **Step 3: 触发点 —— WS 连入前 ensure_running**

`src/acp/ws_handler.rs` 的 `handle_acp_ws`：在 `subscribe` 之前加：
```rust
if let Err(e) = state.sessions.ensure_running(&session_id).await {
    tracing::error!("ensure_running failed for {}: {}", session_id, e);
    return;
}
```
`src/ws_handler.rs`（term/PTY）同理，在订阅前 ensure_running。

- [ ] **Step 4: 并发单测**

在 session_manager 测试模块加（用一个最小 spawn stub 或针对 spawning 标志的纯逻辑测试）：
```rust
#[tokio::test]
async fn concurrent_ensure_running_spawns_once() {
    // 构造一个带 running=None 的 session，两个并发 ensure_running，
    // 断言 spawn_* 只被调用一次。实现者可用 AtomicUsize 计数 stub 注入，
    // 或将 spawning 标志的「锁内决策」逻辑抽成纯函数 decide_spawn(&mut Session)->Plan 单测。
}
```
> 若真 spawn 进程难测，**改测纯决策函数** `decide_spawn(s: &mut Session) -> SpawnDecision`（Spawn{plan} | Wait | AlreadyRunning），断言：running.is_some→AlreadyRunning；spawning→Wait；否则→Spawn 且置 spawning=true。这是并发安全的核心逻辑，纯函数可测。优先这个。

- [ ] **Step 5: 编译 + 测试**

Run: `cargo build 2>&1 | tail -20` → 通过（spawn_running 已完整实现，无未完成桩）。
Run: `cargo test 2>&1 | tail -15` → 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/session_manager.rs src/acp/ws_handler.rs src/ws_handler.rs
git commit -m "feat(session): ensure_running with lock-free-await + spawning guard" -m "Concurrency-safe lazy respawn: lock-decide (spawning flag prevents double-spawn), await spawn outside lock, lock-reattach. Shared spawn_<kind> helpers extracted from create_*. WS handlers call ensure_running before subscribe. Resume token wired in next tasks." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Claude / Codex resume 接线

**Files:**
- Modify: `src/acp/process.rs`（`AcpProcess::spawn` 加 `resume`）
- Modify: `src/acp/codex_process.rs`（`CodexProcess::spawn` 加 `resume_thread`）
- Modify: `src/session_manager.rs`（`spawn_claude`/`spawn_codex` 传 token；fan-out 回填）

> **依据 Spike 结论**：若 Claude/Codex headless resume 验证为 False，对应分支保持 `None`（全新），并在本任务注释标注，跳过该后端的 resume 接线。

- [ ] **Step 1: Claude `AcpProcess::spawn` 加 resume 参数**

`src/acp/process.rs` `pub async fn spawn(claude_path, work_dir)` 改为 `spawn(claude_path, work_dir, resume: Option<&str>)`。在 args 构造里，若 `Some(sid)` 则在现有固定 args 后追加 `["--resume", sid]`：
```rust
let mut args: Vec<String> = vec!["-p".into(),"--output-format".into(),"stream-json".into(),
    "--input-format".into(),"stream-json".into(),"--verbose".into(),
    "--dangerously-skip-permissions".into()];
if let Some(sid) = resume { args.push("--resume".into()); args.push(sid.to_string()); }
```
更新 `.args(...)` 用这个 `args`。所有现有调用点（create_acp_session / 抽取的 spawn_claude）传 `None` 或实际 token。

- [ ] **Step 2: Codex `CodexProcess::spawn` 加 resume_thread**

`src/acp/codex_process.rs` `spawn(codex_path, work_dir, reasoning_effort)` 加参数 `resume_thread: Option<String>`。传入 `run_event_loop`，把初始 `let mut thread_id: Option<String> = None;` 改为 `= resume_thread;`。这样首个 prompt 若已有 thread_id 直接走 `codex-reply`（现有逻辑）。

- [ ] **Step 3: session_manager 的 spawn_claude/spawn_codex 传 token**

`spawn_claude(id, work_dir, resume: Option<&str>)` 把 resume 透传给 `AcpProcess::spawn`。`ensure_running` 的 Claude 分支从 token 取值：
```rust
SessionType::Claude => {
    let r = match &token { Some(ResumeToken::Claude(s)) => Some(s.as_str()), _ => None };
    self.spawn_claude(id, work_dir, r).await
}
SessionType::Codex => {
    let r = match &token { Some(ResumeToken::Codex(t)) => Some(t.clone()), _ => None };
    self.spawn_codex(id, work_dir, r).await
}
```

- [ ] **Step 4: fan-out 回填 token**

`spawn_acp_fanout`（Claude）：收到带 `session_id` 的 `AcpEvent::System`/`Result` 时，调 `mgr.upgrade()` 后 `set_resume_token(sid, ResumeToken::Claude(session_id))`。每会话回填一次（`set_resume_token` 已去重）。
`spawn_codex_fanout`：Codex thread_id 在 process 内部捕获——在 `AcpEvent::Result{session_id}`（Codex 用 session_id 字段承载 thread_id，见现有 parse_codex_tool_result）非空时 `set_resume_token(sid, ResumeToken::Codex(tid))`。

- [ ] **Step 5: 编译 + 测试 + 手动**

Run: `cargo build 2>&1 | tail -20` → 通过。
Run: `cargo test 2>&1 | tail -15` → 全绿。
手动（临时实例）：建 Claude 会话发「记住 42」→ 确认 db 里 resume_kind=claude、resume_value 非空。

- [ ] **Step 6: Commit**

```bash
git add src/acp/process.rs src/acp/codex_process.rs src/session_manager.rs
git commit -m "feat(session): wire Claude --resume and Codex codex-reply resume" -m "spawn gains optional resume; ensure_running passes token by backend; fan-out backfills ResumeToken on first id-bearing event. Per Task 0 spike results." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Kiro `session/load` + tmux attach resume + resume_failed 降级

**Files:**
- Modify: `src/acp/kiro_process.rs`（握手按 token 选 load/new）
- Modify: `src/session_manager.rs`（spawn_kiro/spawn_tmux 传 token；resume_failed 降级）
- Modify: `frontend/src/components/AcpChatView.tsx`（识别 resume_failed）

- [ ] **Step 1: Kiro 握手支持 session/load**

`src/acp/kiro_process.rs` `KiroProcess::spawn(kiro_path, work_dir)` 加 `resume: Option<&str>`。握手第 2 步（现 `session/new`）改为：
```rust
let (method, want_session_id) = match resume {
    Some(_) => ("session/load", true),
    None => ("session/new", false),
};
let params = if let Some(sid) = resume {
    serde_json::json!({"sessionId": sid, "cwd": cwd, "mcpServers": []})
} else {
    serde_json::json!({"cwd": cwd, "mcpServers": []})
};
write_rpc(&mut stdin, 1, method, params).await?;
let resp = drain_until_response(&mut lines).await;
```
若 `session/load` 返回 error（drain_until_response Err）→ 返回特殊错误让上层降级（见 Step 3）。`session/new` 成功时 sessionId 用于回填；`session/load` 成功时复用传入的 sid。

- [ ] **Step 2: spawn_kiro/spawn_tmux 传 token**

`ensure_running`：
```rust
SessionType::Kiro => {
    let r = match &token { Some(ResumeToken::Kiro(s)) => Some(s.as_str()), _ => None };
    self.spawn_kiro(id, work_dir, r).await
}
SessionType::Tmux => {
    let target = match &token { Some(ResumeToken::Tmux(t)) => Some(t.as_str()), _ => None };
    self.spawn_tmux(id, work_dir, target).await
}
```
`spawn_tmux(id, work_dir, target: Option<&str>)`：有 target → PTY 跑 `tmux attach -t <target>`（现有 `:228` 路径）；无 → 普通 shell。

- [ ] **Step 3: resume_failed 降级**

在 `spawn_running` 包一层：若带 token 的 spawn 返回错误（Kiro session/load 失败、tmux attach 找不到 target、Claude --resume 报错），**回退为无 token 全新 spawn**，并通过该 session 的 event_tx 发一个降级事件。由于此时 running 尚未装回，降级事件在 spawn 成功后补发：
```rust
async fn spawn_running(&self, id, stype, token, work_dir, worktree) -> Result<RunningProcess,String> {
    let has_token = token.is_some();
    let first = self.spawn_by_type(id, stype, token, work_dir, worktree.clone()).await;
    match first {
        Ok(rp) => Ok(rp),
        Err(e) if has_token => {
            tracing::warn!("resume failed for {} ({}), falling back to fresh", id, e);
            let rp = self.spawn_by_type(id, stype, None, work_dir, worktree).await?;
            // 清掉失效 token（持久层）
            let _ = self.store.update_resume_token(id, None);
            // 补发 resume_failed（订阅者可能稍后连入；用 event_tx 广播）
            let _ = rp.event_tx.send(serde_json::json!({
                "type":"system","subtype":"resume_failed"
            }).to_string());
            Ok(rp)
        }
        Err(e) => Err(e),
    }
}
```
（`spawn_by_type` = Task 5 的 match-分流；`spawn_running` 包降级。注意：清 token 也要清内存里的 `s.resume_token`——在 ensure_running 装回阶段或这里 upgrade self 清。简化：降级后下次 fan-out 会重新回填新 session 的 token。）

- [ ] **Step 4: 前端识别 resume_failed**

`frontend/src/components/AcpChatView.tsx` 的 `handleEvent` `system` case（约 `:122`）已渲染 `subtype` 为 system 文本。确认 `resume_failed` 会被显示为人类可读文案。把 system case 改为对已知 subtype 映射友好文案：
```tsx
case 'system': {
  const labelMap: Record<string,string> = {
    init: 'session ready',
    resume_failed: '⚠ 上下文恢复失败，已重置为新会话',
  }
  const label = labelMap[evt.subtype || ''] || evt.subtype || 'system'
  const sid = evt.session_id ? ` ${evt.session_id.substring(0, 8)}...` : ''
  pushMessage({ id: newId(), kind: 'system', text: `${label}${sid}` })
  break
}
```

- [ ] **Step 5: 编译 + 前端构建 + 测试**

Run: `cargo build 2>&1 | tail -20` → 通过。
Run: `cargo test 2>&1 | tail -15` → 全绿。
Run: `cd frontend && npm run build 2>&1 | tail -5 && cd ..` → 通过。

- [ ] **Step 6: Commit**

```bash
git add src/acp/kiro_process.rs src/session_manager.rs frontend/src/components/AcpChatView.tsx
git commit -m "feat(session): Kiro session/load + tmux attach resume + resume_failed fallback" -m "Kiro handshake uses session/load when token present; tmux resumes via attach -t; spawn_running falls back to fresh session on resume failure and emits resume_failed (rendered as friendly system text). Completes B-1 four-backend resume." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 最终验证（全部任务完成后）

- [ ] **后端**：`cargo test` 全绿，`cargo build` 通过。
- [ ] **前端**：`cd frontend && npm run build` 通过。
- [ ] **手动四类 × 重启存活**（临时实例或线上谨慎操作）：
  - 各建一个会话，发「记住数字 42」（tmux 则 `export FOO=42`）。
  - `systemctl restart zeromux`（或重启临时实例）。
  - 重连同一 session id，发「我让你记的数字是多少」（tmux 则 `echo $FOO`）→ 确认上下文/会话恢复，或收到 `resume_failed` 降级提示。
- [ ] **红线验证**：纯 shell（无 tmux target）会话重启后 resume_token 为 None（不假装能恢复）。

## Self-Review 记录

- **Spec 覆盖**：任务 0（spike）→ 第 0 节；Task 1（ResumeToken）→ 第 1 节类型；Task 2（SessionStore）→ 第 2 节持久化；Task 3（解耦模型）→ 第 1 节；Task 4（持久接线+懒装载+fan-out 退出）→ 第 2/3 节；Task 5（ensure_running 并发）→ 第 3 节；Task 6（Claude/Codex resume）+ Task 7（Kiro/tmux + 降级）→ 第 4 节。红线（tmux 存活、worktree 留 Session、std Mutex 不跨 await、Weak 防环、失败降级）分散落实并在对应任务标注。
- **类型一致**：`ResumeToken`（4 变体）/`PersistedSession`/`RunningProcess`/`SessionStore` 方法名在 Task 1-4 定义、Task 5-7 调用一致；`spawn_<kind>`/`spawn_by_type`/`spawn_running`/`ensure_running` 命名贯穿一致。
- **无占位符**：Task 5 Step 2 给出 spawn_running 的完整 match 实现（无桩）；Spike 结论节是 Task 0 的产出物（设计如此），非代码占位。
- **风险标注**：Task 3、Task 5 标为中高风险（核心重组 + 并发）；spike 结论 gate 了 Task 6/7 的 resume 分支。
