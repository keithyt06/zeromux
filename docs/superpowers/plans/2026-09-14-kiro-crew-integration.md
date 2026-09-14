# Kiro Crew 接入（zeromux v2「有记忆的驾驶舱」）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zeromux 新增一种「有记忆」的会话后端（Kiro Crew），并把 Crew 最有价值的两件事——**跨会话记忆**与**工具审批**——做成 zeromux 的第一方界面，使手机成为可用的 agent 驾驶舱；同时删掉被 Crew 严格支配的 Kiro 后端与 3 个月零使用的 notes 功能。

**Architecture:** 新增 `SessionType::Crew`。它**不 spawn 进程**，而是由 fan-out 任务独占一条到 Kiro Crew Gateway（`127.0.0.1:5476`）的 WebSocket，并把 Gateway 的全局广播帧按 `data.slot` 过滤、归一化成既有的 `AcpEvent`——这是 Codex 走 rmcp client 的自然延伸，`session_manager.rs` 的「fan-out 是进程唯一所有者」不变量以「fan-out 是这条 WS + 这个 slot 的唯一所有者」的形式保持。`AcpEvent` 扩两个变体（`Approval` / `ContextUsage`）：前者让审批可在对话内联批准（Crew 全部 10 个 IM 渠道都做不到的事），后者是白拿的新能力。记忆通过 zeromux 后端代理暴露给前端（Gateway 的记忆端点只认短 TTL token，前端不能直连）。

**Tech Stack:** Rust / Axum 0.8 / tokio-tungstenite 0.29（已在 Cargo.lock，提为直接依赖）/ reqwest 0.12 / React 19 / Vite / Tailwind v4 / vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-09-13-kiro-crew-backend-design.md`

## Global Constraints

- **测试基线（零回归判据）**：改动前 `cargo test` = **382 passed**；前端 `npm test` = **45 files / 262 passed**（实测，`npx vitest run` 约 300s）。每个批次结束都要对比，只许增不许减。
- **构建顺序**：前端必须先 `npm run build` 才能 `cargo build`（`rust-embed` 编译期读 `frontend/dist/`）。迭代期用 `cargo check` / `cargo test`，**不要用 `--release`**（release 是 `opt-level="z"` + lto，很慢）。
- **语言规范**：用户可见字符串与文档用中文；代码与注释用英文（本 repo 双语惯例）。
- **Gateway 端口默认 5476**，可用 `--crew-port` 覆盖；crew home 默认 `~/.kiro/crew`，可用 `--crew-home` 覆盖。
- **认证：token 是超集，只需持有 token 一种凭证**（订正后的实测，见 spec 附录 A.1）。用 `X-Local-Secret: <secret>` 打 `GET /api/token/local?ttl=20h` 换 token，之后 15/15 端点全通。secret 的唯一用途就是换 token。**唯一例外：WebSocket 只认 `?token=`**（secret 在 WS 上 403）。
- **`?ttl=` 收 duration 字符串不是秒数**：`ttl=300` 会**静默回落**到上限 20h，`ttl=5m` 才得 300 秒。一律写 `?ttl=20h`。因此**记忆面板不需要 re-mint 逻辑**；但 fan-out 每次 WS 重连仍应重新 mint（廉价，且覆盖 token 被 revoke 的情形）。
- **approval 帧字段名是 `tool_purpose` / `tool_input`**（不是 `purpose`/`input`），且这三者在 Gateway 侧**已 redact**。帧含 `data.slot`，故 I1 过滤适用。`POST /api/approvals/{id}/{action}` 接受 `approve`/`reject`/`reject_once`，404 = 已过期。
- **第一期不做 `auto_read` 审批档、不做审批 select**：approval payload **不带只读标记**（`source` 是来源标识，`tool_call.kind` 只在 `tool_call` 帧上）。只做「每次询问」一档 → select 会是单值死控件，故连 select 一起砍。
- **secret 与 token 的内存边界**：只在 `crew_process.rs` 的 fan-out 任务栈上存活。**绝不进** `AppState`（被 `web.rs` 6481 行的所有 handler 共享，一处调试打印即泄漏）、**绝不进** `Session`（会被 `session_store` 持久化到 SQLite）、绝不进日志、绝不进 `AcpEvent` 事件流、绝不进错误信息（连长度也不必报）。
- **WS 是唯一事件源**：`POST /api/chat` 的响应体**必须整体丢弃**，只读 HTTP 状态码。理由（实测）：空闲时它是阻塞整轮的 SSE，忙时返回 `{"queued":true}`，且**第二轮的输出会串进第一条请求的 SSE 流里**——把它当事件源必然导致轮次串台。
- **取消轮次用 `/stop`，不是 `/interrupt`**（实测：`/interrupt` 清的是排队，队列空时返回 400 `"queue empty, use /stop instead"`）。
- **绝不发不带 `slot` 的 `POST /api/chat/mode`**：实测 `chat_handlers.py:9016-9040`，不带 slot 会把 Gateway 上所有 slot **和所有 IM 渠道（含微信）永久设为 auto-approve 并落盘**。第一期**根本不发 mode 请求**，审批走 UI。
- **`POST /api/chat` 绝不能在 `select!` 臂里 `await`**（起草期发现的真 bug）：它空闲时**阻塞整轮**，在 select 臂里 await 会让 WS 读取整轮停摆 —— 帧全堆在 tungstenite 缓冲里，流式文本一个字都不出来，直到轮次结束才一次性涌出。**这与 `codex_process.rs:74-77` 那条「通知回调必须 `try_send`，await 会锁死 rmcp 的 transport reader」是同一类错误。** 修法：Prompt 交给串行 `prompt_worker` 任务；**Cancel 走 detached spawn**（它绝不能排在一个正在阻塞的 Prompt POST 之后 —— 那个 POST 恰好要到轮次结束才返回，而 `/stop` 的全部意义就是提前结束那一轮）。
- **`Drop` 里不能在 spawn 的 future 内做同步 fs 读**（起草期发现的真 bug）：生产文件系统是 JuiceFS/S3，`read_gateway_secret` 会阻塞一个 tokio worker。必须在 `Drop` 的**同步栈上**读完 secret 再 move 进 future —— 这同时满足「secret 不进 `self`」。代价是运行时关停时有一个有界的 slot 泄漏窗口，写进注释即可。
- **错误信息绝不格式化 `tungstenite::Error`**：它会回显请求 URL，而 URL 带 token。连接失败只报 `"Kiro Crew Gateway WS 连接失败（127.0.0.1:<port>）"`。
- **前端对未知事件是静默丢弃**：`BlockView` 的 `default: return null`（`AcpChatView.tsx:967-968`），`handleEvent` 的 switch **无 `default` 分支**（`AcpChatView.tsx:307-437`）。因此**后端加 `AcpEvent` 变体与前端加 case 必须在同一个 commit**，否则表现为「什么都没发生」——最难 debug 的失败模式。
- **不加 `.kiro` 到 `SENSITIVE_DIR_NAMES`**：spec §5.2 已用编译实测推翻该主张（`read_hits_home_dotdir` 锚定 `$HOME` 而非 base，`~/.kiro/**` 全部已被拦）。加 pin 收益为零、代价是仓库内 `.kiro/` 从 file-browser 消失 = 纯负收益。
- **禁止 hover-only 控件**：Tailwind v4 把 `group-hover:*` 编译进 `@media (hover:hover)`，手机上元素永久 `opacity:0` 但仍可点击 = 隐形按钮（`QuickTargets.tsx:118-120` 的既有教训）。一律改「整行主目标 + 行级操作单」。
- **禁止 `window.confirm`**：手机体验差（`PromptManager.tsx:64` 既有注释）。二段确认用行内下沉展开（`QuickTargets.tsx:134-165` 形状）。
- **输入框用 `text-base`(16px)**：低于 16px 时 iOS Safari 聚焦会自动放大整页，把发送键挤出视口（`Composer.tsx:225-226` 既有教训）。触控目标 ≥44px。
- **`SessionInfoBar` 图标上限是 5 个**：已核算（5×22 + 4×4 = 126px，加汉堡 22 + chevron 18 + StatusDot 8 + 内边距 24 ≈ 198px，375px 屏下 description 余 ~177px）。**第 6 个会崩版**——所以审批不占图标位，内联在对话里。
- **前端 stale-response 防护**：任何「fetch + 乐观 mutation」组件都必须带单调 `reqRef`（fetch 顶部 bump、每个乐观 setState 前 bump、`await` 后守卫）。这是 repo 里反复出现的一类 bug。
- **owner-scope 强制**：新增的每个 zeromux 端点都必须校验 `owner_id`，read 与 write 对称。
- **`kiro-cli` 二进制不能删**：它是 Crew 的运行时依赖（Gateway 靠它跑）。删的是 zeromux 的 Kiro **后端路径**；`--kiro-path` 参数保留无害。
- **不碰 `quick_targets` 的 `kind='note'`**：那是 **Obsidian vault 笔记**（实测 DB 里有一行 `projects/long-term/管综数学/几何/几何.md`，3 次 hits、今天仍在用），与要删的 session notes 完全无关。`quick_targets.rs` 不依赖 `NotesStore`（已核实）。
- **不删 `notes.db`**：删代码不删用户数据。

---

## 批次 0：安全修复与参数（先做，负工作量）
### Task 1: `is_credential_path` 补 `.secret` / `.local_secret`（先验红）

Crew 的 internal secret 与 token 签名密钥落在 `<crew_home>/run/gateway-<port>.secret` 与 `<crew_home>/.local_secret`。这两个叶名当前**不在** `is_credential_path` 的 denylist 里（编译实测：均返回 `false`）。在 `$HOME` 之下有 `read_hits_home_dotdir` 兜底，所以今天不可达；但这是**叶名轴**，与 base 轴正交——一旦 crew home 被 `KIROCREW_HOME` 指到仓库内（`config/loader.py:3-4` 明确支持），`.secret` 就会被 `list_dir` 枚举、被 `get_file_raw` 读出、被 diff 逐字打印。

**Files:**
- Modify: `src/web.rs:1413-1452`（`is_credential_path` 函数体，在末尾 `|| n == ".dockercfg"` 之后追加）
- Modify: `src/web.rs:4169`（`credential_leaf_covers_keystore_and_password_files` 测试之后新增一个测试）

**Interfaces:**
- Consumes: 无（纯函数改动）
- Produces: `is_credential_path(name: &str) -> bool` 对 `*.secret` 与 `.local_secret` 返回 `true`。所有读路径（`git_show` diff、`git_worktree` diff、`list_dir`、`get_file_raw`）都派生自这一个谓词，故一处改动全部生效。

- [ ] **Step 1: 写失败测试**

在 `src/web.rs` 的 `credential_leaf_covers_keystore_and_password_files` 测试（约 `L4169` 结束）之后插入：

```rust
    #[test]
    fn credential_leaf_covers_gateway_secrets() {
        // Kiro Crew 的 IPC 凭证叶名（本次接入新增的一类）。`$HOME` 之下另有
        // read_hits_home_dotdir 兜底，但那是 BASE 轴；这里补的是 LEAF 轴——
        // KIROCREW_HOME 可把 crew home 指到仓库内（config/loader.py:3-4），
        // 那时只有叶名 denylist 能挡住它被 list_dir 枚举 / diff 逐字打印。
        for n in [
            "gateway-5476.secret", ".local_secret",
            "GATEWAY-8080.SECRET",   // case-insensitive
            "app.secret",            // 任何 *.secret，不只 Crew 的
        ] {
            assert!(is_credential_path(n), "{n} must be flagged as a credential leaf");
        }
        // 反向：普通源文件不受影响（`.secret` 是后缀匹配，不是子串匹配）
        assert!(!is_credential_path("secretsanta.ts"));
        assert!(!is_credential_path("secrets.md"));
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test credential_leaf_covers_gateway_secrets 2>&1 | tail -20`

Expected: FAIL —— `gateway-5476.secret must be flagged as a credential leaf`（`assert!` panic）。

**若它直接通过就停下来报告**：说明谓词已覆盖，本任务无需改动，直接跳到 Task 2。

- [ ] **Step 3: 最小实现**

在 `src/web.rs` 的 `is_credential_path` 函数体末尾（`|| n == ".dockercfg"` 那一行之后、闭合 `}` 之前）追加：

```rust
        // Gateway IPC secrets (Kiro Crew 接入, 2026-09-13). `<crew_home>/run/
        // gateway-<port>.secret` and `<crew_home>/.local_secret` authenticate to
        // Crew's internal API — holding one is equivalent to being the Crew owner.
        // The `~/.*` home form is separately refused by read_hits_home_dotdir, so
        // this LEAF entry is what covers a crew home relocated INTO a repo via
        // KIROCREW_HOME. Suffix match (not substring) so `secrets.md` /
        // `secretsanta.ts` stay browsable.
        || n.ends_with(".secret") || n == ".local_secret"
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test credential_leaf 2>&1 | tail -10`

Expected: PASS，两个 `credential_leaf_*` 测试都绿。

- [ ] **Step 5: 确认无回归**

Run: `cargo test 2>&1 | tail -3`

Expected: `383 passed`（基线 382 + 本任务新增 1）。**若有任何 failed 就停下报告** —— 最可能的原因是某个既有测试用了 `*.secret` 名字的夹具文件并断言它可读。

- [ ] **Step 6: Commit**

```bash
git add src/web.rs
git commit -m "$(cat <<'EOF'
fix(security): is_credential_path 补 *.secret / .local_secret

Kiro Crew 的 IPC 凭证叶名(<crew_home>/run/gateway-<port>.secret 与
.local_secret)不在 denylist 里(编译实测 false)。$HOME 之下有
read_hits_home_dotdir 兜底,但那是 BASE 轴;本条补的是 LEAF 轴 ——
KIROCREW_HOME 可把 crew home 指到仓库内,那时只有叶名 denylist 能挡。

后缀匹配而非子串匹配,secrets.md / secretsanta.ts 不受影响。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `--crew-port` / `--crew-home` 参数 + 越界 fail fast

若 `crew_home` 落在 `vault_dir` 或 work_dir 之下，secret 就进入了 file-browser 的可读区（绕过 `$HOME` 兜底）。启动时检测并拒绝。

**Files:**
- Modify: `src/main.rs:44-57`（`Args` 结构体，在 `codex_path` 之后加两个字段）
- Modify: `src/main.rs:134-136`（`AppState` 的 path 字段区，加两个字段）
- Modify: `src/main.rs:405-408`（`AppState` 构造，填两个字段）
- Modify: `src/main.rs`（`vault_dir` 解析之后、`AppState` 构造之前，插入校验；`vault_dir` 在 `L370-388`）

**Interfaces:**
- Consumes: 无
- Produces: `AppState.crew_port: u16`（默认 5476）、`AppState.crew_home: String`（默认 `<HOME>/.kiro/crew`）。Task 4 的 `create_crew_session` 会读这两个字段。

- [ ] **Step 1: 写失败测试**

在 `src/main.rs` 文件末尾追加（若已有 `#[cfg(test)] mod tests` 则并入）：

```rust
#[cfg(test)]
mod crew_arg_tests {
    use super::crew_home_is_exposed;
    use std::path::Path;

    #[test]
    fn crew_home_inside_work_dir_is_rejected() {
        // secret 落在 work_dir 之下 => file-browser 可读区（绕过 $HOME dotdir 兜底）
        assert!(crew_home_is_exposed(
            Path::new("/home/u/repo/.kiro/crew"),
            Path::new("/home/u/repo"),
            None,
        ));
    }

    #[test]
    fn crew_home_inside_vault_dir_is_rejected() {
        assert!(crew_home_is_exposed(
            Path::new("/home/u/vault/.kiro/crew"),
            Path::new("/home/u"),
            Some(Path::new("/home/u/vault")),
        ));
    }

    #[test]
    fn default_crew_home_under_home_is_accepted() {
        // ~/.kiro/crew 与 work_dir=$HOME：首段是 `.kiro` dotdir，read_hits_home_dotdir
        // 已拦住，不算暴露。
        assert!(!crew_home_is_exposed(
            Path::new("/home/u/.kiro/crew"),
            Path::new("/home/u"),
            None,
        ));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test crew_arg_tests 2>&1 | tail -10`

Expected: 编译失败 —— `cannot find function 'crew_home_is_exposed' in this scope`。

- [ ] **Step 3: 实现参数与校验函数**

3a. `src/main.rs:56`（`codex_path` 字段之后）插入：

```rust
    /// Kiro Crew Gateway port (dashboard port; loopback only).
    #[arg(long, default_value = "5476")]
    crew_port: u16,

    /// Kiro Crew data home. Holds the IPC secret this process reads to mint
    /// WebSocket tokens. Defaults to `$HOME/.kiro/crew`.
    #[arg(long)]
    crew_home: Option<String>,
```

3b. `src/main.rs:136`（`pub codex_path: String,` 之后）插入：

```rust
    pub crew_port: u16,
    pub crew_home: String,
```

3c. 在 `src/main.rs` 的 `read_hits_home_dotdir` 无关处（建议紧贴 `Args` 定义之后）加纯函数：

```rust
/// True when `crew_home` sits somewhere the file browser can read, which would
/// expose Crew's IPC secret. `$HOME/.kiro/...` is NOT exposed: its first segment
/// below $HOME is a dot-entry, which `web::read_hits_home_dotdir` already refuses
/// (verified by compiling that predicate standalone — see spec §5.2). What IS
/// exposed is a crew home relocated under a browsable base: `<work_dir>/.kiro`
/// with work_dir deeper than $HOME, or anywhere under the vault.
fn crew_home_is_exposed(
    crew_home: &std::path::Path,
    work_dir: &std::path::Path,
    vault_dir: Option<&std::path::Path>,
) -> bool {
    if let Some(v) = vault_dir {
        if crew_home.starts_with(v) {
            return true;
        }
    }
    // Under $HOME with a dot first segment => already guarded, not exposed.
    if let Ok(home) = std::env::var("HOME") {
        if let Ok(rel) = crew_home.strip_prefix(&home) {
            if matches!(rel.components().next(),
                Some(std::path::Component::Normal(s))
                    if s.to_str().is_some_and(|n| n.starts_with('.')))
            {
                return false;
            }
        }
    }
    crew_home.starts_with(work_dir)
}
```

3d. 在 `vault_dir` 解析完成之后（`src/main.rs:388` 之后）插入 fail-fast：

```rust
    let crew_home = args.crew_home.clone().unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
        format!("{}/.kiro/crew", home)
    });
    {
        let ch = std::path::Path::new(&crew_home);
        let wd = std::path::Path::new(&args.work_dir);
        let vd = vault_dir.as_ref().map(std::path::Path::new);
        if crew_home_is_exposed(ch, wd, vd) {
            eprintln!(
                "FATAL: --crew-home ({}) sits inside --work-dir or --vault-dir; \
                 Kiro Crew's IPC secret would be readable through the file browser. \
                 Move the crew home outside the browsable tree.",
                crew_home
            );
            std::process::exit(1);
        }
    }
```

3e. `src/main.rs:408`（`codex_reasoning: args.codex_reasoning,` 附近）加入构造：

```rust
        crew_port: args.crew_port,
        crew_home: crew_home.clone(),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test crew_arg_tests 2>&1 | tail -8`

Expected: 3 passed。

- [ ] **Step 5: 确认无回归 + 手工验证 fail fast**

Run: `cargo test 2>&1 | tail -3` → Expected `386 passed`（383 + 3）。

Run: `cargo run -- --port 18099 --password t --work-dir /home/ubuntu --crew-home /home/ubuntu/.kiro/crew 2>&1 | head -5`

Expected: 正常启动（不报 FATAL），Ctrl-C 结束。

Run: `cargo run -- --port 18099 --password t --work-dir /home/ubuntu/s3-workspace --crew-home /home/ubuntu/s3-workspace/.kiro/crew 2>&1 | head -3`

Expected: `FATAL: --crew-home ... sits inside --work-dir ...`，退出码 1。

- [ ] **Step 6: Commit**

```bash
git add src/main.rs
git commit -m "$(cat <<'EOF'
feat(crew): --crew-port / --crew-home 参数 + 越界 fail fast

crew_home 落在 vault_dir 或 work_dir 之下时,Crew 的 IPC secret 会进入
file-browser 可读区(绕过 $HOME dotdir 兜底)。启动时检测并 exit(1)。

~/.kiro/crew 不算暴露:首段是 dot-entry,read_hits_home_dotdir 已拦
(该谓词单独编译实测,见 spec §5.2)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: systemd 声明对 Gateway 的软依赖（零 Rust 代码）

Gateway 已有自己的 systemd 守护（实测 `kirocrew.service`：`Restart=on-failure` / `RestartSec=10` / `StartLimitBurst=3/300s` / `KillMode=control-group`）。zeromux **不该**去拉起它——两个 `KillMode=control-group` 的服务互相拉起会重演 CLAUDE.md 记录的 cgroup 自杀陷阱。正确做法是声明依赖。

**Files:**
- Modify: `/etc/systemd/system/zeromux.service`（`[Unit]` 段，当前只有 `After=network-online.target` / `Wants=network-online.target`）

**Interfaces:**
- Consumes: 无
- Produces: 无（运维配置）

- [ ] **Step 1: 备份现有 unit**

```bash
sudo cp /etc/systemd/system/zeromux.service /etc/systemd/system/zeromux.service.bak-$(date +%Y%m%d)
```

- [ ] **Step 2: 加两行**

在 `[Unit]` 段的 `Wants=network-online.target` 之后插入：

```ini
# Kiro Crew Gateway hosts the Crew session backend. `Wants` (not `Requires`):
# if the gateway is down, zeromux's PTY / Claude / Codex sessions must keep
# working — only Crew sessions degrade. zeromux never starts or stops it:
# both units are KillMode=control-group, and having them start each other
# reproduces the cgroup self-kill trap documented in CLAUDE.md.
After=kirocrew.service
Wants=kirocrew.service
```

用 `sudo tee` 或 `sudoedit` 写入（不要用 `systemctl edit --full`，它会改变文件路径语义）。

- [ ] **Step 3: 校验语法并生效**

```bash
sudo systemd-analyze verify /etc/systemd/system/zeromux.service
sudo systemctl daemon-reload
systemctl show zeromux.service -p After -p Wants | tr ' ' '\n' | grep -i kirocrew
```

Expected: 最后一条输出含 `kirocrew.service`（在 After 与 Wants 各一次）。`systemd-analyze verify` 无输出即无错。

- [ ] **Step 4: 确认服务仍健康**

```bash
systemctl is-active zeromux kirocrew
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/
```

Expected: 两个 `active`；HTTP 码非 000（200 或 302/401 皆可，说明在监听）。

**注意**：本步**不要** `systemctl restart zeromux` —— 参数没变，重启无必要，且 CLAUDE.md 明确禁止从 zeromux 终端里动它自己的 unit。`daemon-reload` 足够让依赖关系在下次启动生效。

- [ ] **Step 5: 记录到 README（依赖关系是部署事实，要可发现）**

在 `README_ZH.md` 的部署/配置章节追加一小节：

```markdown
### Kiro Crew 依赖

Crew 会话需要 Kiro Crew Gateway 在本机运行（默认 `127.0.0.1:5476`）。它由自己的
systemd unit（`kirocrew.service`）守护，**zeromux 不负责拉起它**：两个 unit 都是
`KillMode=control-group`，互相拉起会触发 cgroup 自杀陷阱（见 `CLAUDE.md` 的部署章节）。

`zeromux.service` 只声明软依赖（`After=` + `Wants=`，**不是** `Requires=`）——Gateway
挂掉时 PTY / Claude / Codex 会话照常工作，只有 Crew 会话降级。

**安全边界**：zeromux 读 `<crew_home>/run/gateway-<port>.secret` 来换取 WebSocket
token，因此**任何能在 zeromux 里跑 shell 的人等价于 Crew 的 owner**。Crew 自己的威胁
模型假设 agent 拿不到这个 secret（它把 `.local_secret` 列入敏感路径并从 agent 环境剥离
`KIROCREW_INTERNAL_SECRET`）。当前是单用户部署，可接受；**开放多用户前必须重新评估**。
```

- [ ] **Step 6: Commit**

```bash
git add README_ZH.md
git commit -m "$(cat <<'EOF'
docs: 记录 Kiro Crew 的 systemd 软依赖与安全边界

zeromux.service 加 After=/Wants=kirocrew.service(非 Requires:Gateway 挂掉时
PTY/Claude/Codex 会话应照常活)。zeromux 绝不拉起它 —— 两个 unit 都是
KillMode=control-group,互相拉起会触发 CLAUDE.md 记录的 cgroup 自杀陷阱。

同时记录:持有 Gateway secret 意味着「能在 zeromux 跑 shell 的人 = Crew owner」,
开放多用户前必须重新评估。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 批次 1：Crew 会话后端跑通

### Task 4: `crew_process.rs` —— Gateway 客户端 + 事件归一化

本任务是整个计划的核心。**归一化必须是纯函数** `(&serde_json::Value, &str, &mut NormState) -> Vec<AcpEvent>` —— 无 I/O、无时钟、无 channel。只有这样 T1-T8 才能直接喂实测抓到的真实 JSON 帧，不需要 Gateway 在跑。

下面每一段代码都在一个临时 crate（含仓库真实的 `AcpEvent` 与 `format.rs`）里 `cargo test` 跑过 —— **21 passed; 0 failed**（11 个 crew 测试 + 10 个 format 回归），生产代码段 0 个 `unwrap()`。

**Files:**
- Create: `src/acp/crew_process.rs`
- Modify: `src/acp/mod.rs`（5 行文件，加一行 `pub mod crew_process;`）
- Modify: `Cargo.toml`（依赖区加一行，见 Step 1）
- Modify: `src/acp/process.rs`（`Exit` 变体之后加两个新变体，见 Step 8）

**Interfaces:**
- Consumes: `AppState.crew_port` / `AppState.crew_home`（Task 2 产出）
- Produces:
  - `CrewConfig { http_base: String, ws_base: String, crew_home: PathBuf, port: u16 }` + `CrewConfig::new(crew_home: PathBuf, port: u16) -> Self`
  - `CrewProcess` —— 形状与 `CodexProcess`（`codex_process.rs:375-378`）逐字对齐：私有 `cmd_tx` + `pub event_rx`，所以 Task 5 的 `spawn_crew_fanout` 能照抄 `spawn_codex_fanout`
  - `CrewProcess::spawn(cfg: CrewConfig, work_dir: &str, resume: Option<&str>) -> Result<Self, Box<dyn Error + Send + Sync>>`
  - `CrewProcess::slot_key(&self) -> &str`（供 `ResumeToken::Crew` 回填）
  - `CrewProcess::send_prompt(&mut self, text: &str)` / `interrupt(&mut self)`（→ `/stop`）/ `kill(&mut self)`
  - `pub fn normalize_frame(&Value, my_slot: &str, &mut NormState) -> Vec<AcpEvent>`（纯函数，Task 4 的测试直接调它）
  - `pub struct NormState` + `NormState::new()`
  - `pub fn crew_event_is_forward_progress(&AcpEvent) -> bool`（Task 6 的 bump 谓词要用）
  - `AcpEvent::Approval { id, tool, purpose, slot }` + `AcpEvent::ContextUsage { used, total }`

- [ ] **Step 1: 加依赖（不改 Cargo.lock）**

`tokio-tungstenite 0.29.0` 已在 `Cargo.lock`（axum 的 `ws` feature 拉进来的间接依赖）。提为直接依赖，在 `Cargo.toml` 的 `url = "2"` 之后加：

```toml
# WS client for the Kiro Crew Gateway event stream. Already in Cargo.lock as
# axum's transitive dep. `connect` = ["stream","tokio/net","handshake"]; NO TLS
# feature on purpose — the gateway is loopback `ws://` only, and `wss://` would
# be a misconfiguration we want to fail loudly (tls.rs:157-165 raises
# TlsFeatureNotEnabled).
tokio-tungstenite = { version = "0.29", default-features = false, features = ["connect"] }
```

Run: `cargo check 2>&1 | tail -3 && git diff Cargo.lock`

Expected: 编译通过；`Cargo.lock` 恰好**多一行** `+ "tokio-tungstenite",`（在 `zeromux` 包自己的 `dependencies` 列表里），**无新增/删除 `[[package]]` 块、无删除行**。

> **本条 Expected 已订正**（原写"lock 零变化"，是计划的文档错误）：把一个传递依赖提为**直接**依赖时，Cargo **必然**要在 `zeromux` 的依赖列表里记录这条边，与 feature 拼写无关。真正要验的是**解析结果没变**。
>
> 判据（实测确认）：`tokio-tungstenite 0.29.0` 条目的 `checksum` 未变，其依赖列表仍是 `futures-util / log / tokio / tungstenite` —— **无 native-tls / rustls / openssl / webpki**，证明没有误开 TLS feature。用这条命令核对：
>
> ```bash
> git diff Cargo.lock | grep -iE "^\+.*(tls|openssl|webpki)" || echo "无 TLS 相关新增 ✓"
> ```
>
> 若出现 TLS 相关新增包，或出现任何 `[[package]]` 块的增删，那才是 feature 写错了，回退重试。

- [ ] **Step 2: 写 8 个失败测试（先写测试，此时被测函数还不存在）**

创建 `src/acp/crew_process.rs`，只放 `use` 与测试模块（实现留空）。测试代码见本任务末尾的**附录 T**（8 个 spec 要求的 + 3 个附加，共 11 个）。

- [ ] **Step 3: 运行测试确认失败**

Run: `cargo test crew_process 2>&1 | tail -10`

Expected: 编译失败 —— `cannot find function 'normalize_frame'` / `cannot find type 'NormState'`。

- [ ] **Step 4: 加 `AcpEvent` 两个变体（附录 D）+ 实现纯函数部分（附录 N）**

> **本 Step 已订正顺序**（原计划把附录 D 排在 Step 8，是真错误）：附录 N 的
> `normalize_frame` 在 `"approval"` / `"context_usage"` 两臂里**构造** `AcpEvent::Approval{..}`
> 与 `AcpEvent::ContextUsage{..}`，附录 T 的 `T-extra-2` 又 `match` 它们 —— 所以
> **附录 D 是附录 N 的硬编译前提**，D 缺席时 Step 5 的「11 passed」不可能达成
> （验红输出里会出现 `no variant named 'Approval' found for enum AcpEvent`）。
> 我验证代码的那个临时 crate 两者都有，所以没暴露这个顺序依赖。

先按**附录 D** 在 `src/acp/process.rs` 的 `Exit` 变体（`:92-94`）之后插入两个新变体，再按**附录 N** 实现纯函数。

**并且从附录 I 里提前取三样东西到本 Step**（否则 Step 5 的 11 passed 达不到）：

1. 三个重连常量 `RECONNECT_INITIAL` / `RECONNECT_MAX` / `STABLE_AFTER`
2. `struct Backoff` + `impl Backoff`
3. `pub fn read_gateway_secret`

> **为什么**（本条是订正）：附录 T 的 11 个测试里只有 **9 个**是归一化测试
> （T1-T8 + `context_usage_and_approval`）。另 2 个 —— `backoff_only_resets_after_a_connection_proves_stable`
> 与 `secret_falls_back_and_errors_never_echo_content` —— 测的是上面这三样，
> 而它们**被归到了附录 I**。
>
> 关键：这**不是** I/O 依赖问题。`Backoff` 是纯算术（无 `async`/`await`/IO），
> `read_gateway_secret` 只做同步 `std::fs::read_to_string` —— 两者都**不需要
> Gateway 在跑**，这正是它们能进这套「不用跑 Gateway」测试集的原因。它们只是
> 在附录划分上归错了位置。
>
> 提前取这三样后，Step 5 的「11 passed」字面成立；Step 6 插入附录 I 的其余部分，
> 最终文件布局仍按附录 I 的顺序（header/uses → N → I → tests）。

三条不变量的落点：

| 不变量 | 落点 | 漏了的后果 |
|---|---|---|
| **I1** slot 过滤 | `normalize_frame` 顶部两行，在 `match kind` **之前** | 会话 A 的输出进会话 B。**更隐蔽的一条**：别的 slot 的 `chat_done` 会把我的 `turn_text` 抽走 → 我的 `Result.text` 变空。T1 显式断言了这条 |
| **I2** `tool_call_id` 去重 | `seen_tool_calls.insert()` 的**返回值** | 实测一次调用来 3 帧 → UI 渲染 3 次 |
| **I3** 累积 + 清零 | `push_str` / `mem::take` | `Result.text` 空 → 活动看板摘要空白、`auto_titler` 无输入（`auto_titler.rs:107` 只认 `Result{text}`）、`log_result_event` 不可用。跨轮不清零 → 第二轮摘要带上一轮的话 |

- [ ] **Step 5: 运行测试确认通过**

Run: `cargo test crew_process 2>&1 | tail -8`

Expected: 11 passed。

- [ ] **Step 6: 实现 I/O 部分（secret 读取 / token mint / REST / WS 事件循环）**

代码见附录 I —— **除 Step 4 已提前取走的三样**（三个重连常量 + `Backoff` + `read_gateway_secret`）。**三个必须遵守的点**（都是 Global Constraints 里那两条真 bug 的落地）：

1. `POST /api/chat` 走串行 `prompt_worker`，**不在 `select!` 臂里 await**。
2. `Cmd::Cancel` 走 **detached spawn**，不排在 prompt 后面。
3. `Drop` 在**同步栈上**读 secret 再 move 进 future。

- [ ] **Step 7: 编译 + 全量测试**

Run: `cargo test 2>&1 | tail -3`

Expected: `397 passed`（Task 2 结束的 386 + 本任务 11）。

- [ ] **Step 8: 确认两个新变体对全仓库零破损**

变体本身已在 Step 4 插入（见那里的顺序订正）。本 Step 是**确认**：它们对全仓库 12 处 `match` 零破损。

**加变体的安全性已实测**：我把这两个变体临时插进 `process.rs` 跑了 `cargo check` → `Finished dev profile`，**零错误**。原因：`AcpEvent` 只 `derive(Debug, Clone, Serialize)`（`process.rs:25`，**无 `Deserialize`**），且全仓库 12 处对它的 `match` 全部带 `_ =>` 兜底或用 `matches!`/`if let`（核对了 `session_manager.rs:2175/2185/2193/2417/2468/2486/2951/3188/3199/3469/3480`、`auto_titler.rs:107-110`、`run_metrics.rs:39`）。

Run: `cargo check 2>&1 | tail -3`

Expected: `Finished`，无 `non-exhaustive patterns` 报错。

- [ ] **Step 9: Commit**

```bash
git add Cargo.toml src/acp/crew_process.rs src/acp/mod.rs src/acp/process.rs
git commit -m "$(cat <<'EOF'
feat(crew): crew_process.rs —— Gateway 客户端 + 事件归一化

归一化是纯函数 (Value, my_slot, &mut NormState) -> Vec<AcpEvent>,所以 11 个
单测直接喂实测抓到的真实 JSON 帧,不需要 Gateway 在跑。

三条 Crew 独有的不变量(现有三后端天然免疫,零测试覆盖):
- I1 按 data.slot 过滤 —— WS 是全局广播且无 per-slot 订阅
- I2 按 tool_call_id 去重 —— 实测一次调用来 3 帧
- I3 Result.text 由 chat_chunk 累积 —— chat_done 不带最终文本

两个实现陷阱(起草期发现,不在 spec 里):
- POST /api/chat 不能在 select! 臂里 await(空闲时阻塞整轮 → WS 读取停摆,
  与 codex 那条「回调必须 try_send」同类)→ Prompt 走串行 worker、
  Cancel 走 detached spawn
- Drop 里不能在 spawn 的 future 内做同步 fs 读(JuiceFS 会阻塞 worker)
  → 在 Drop 同步栈上读完再 move 进 future

AcpEvent 加 Approval + ContextUsage 两变体(实测 cargo check 零错误:
只 derive Serialize 且 12 处 match 全有兜底)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `spawn_crew` + `create_crew_session` + `spawn_crew_fanout`

fan-out 从「独占一个子进程」变为「**独占一条 WS 连接 + 一个 slot_key**」。这与 Codex 走 rmcp client 的先例同构，CLAUDE.md 的「fan-out 是进程唯一所有者」不变量以此形式保持。

**Files:**
- Modify: `src/session_manager.rs:313-335`（`SessionManager` 结构体加 `crew_port: u16` + `crew_home: String`，紧跟 `codex_reasoning`）
- Modify: `src/session_manager.rs:605-632`（`SessionManager::new` 参数列表加同两项）
- Modify: `src/main.rs:463`（`SessionManager::new` 调用点传 `args.crew_port` / `crew_home.clone()`）
- Modify: `src/session_manager.rs`（4 个测试 helper 的 `new` 调用点：`:3946` / `:4111` / `:4600` / `:5331`）
- Modify: `src/web.rs:663`（会话创建分派加 Crew 臂 —— **从 Task 6 提前到这里**，见下方说明）
- Modify: `src/session_manager.rs:47-52`（`SessionType` 加 `Crew`）
- Modify: `src/session_manager.rs:58-67`（`Display`）
- Modify: `src/session_manager.rs:71-78`（`from_str_lenient`）
- Modify: `src/session_manager.rs:83-110`（`ResumeToken` 加 `Crew(String)` + 两处映射）
- Modify: `src/session_manager.rs:1183`（`matches!` 加 `SessionType::Crew`）
- Modify: `src/session_manager.rs:1451` 附近（新增 `spawn_crew`，照 `spawn_codex`）
- Modify: `src/session_manager.rs:1552` 之后（新增 `create_crew_session`，照 `create_codex_session:1499-1552`）
- Modify: `src/session_manager.rs:1599/1611/1651`（`ensure_running` 的三处 resume 分派加 Crew 臂）
- Modify: `src/session_manager.rs:2183` 附近（新增 `crew_slot_key`）
- Modify: `src/session_manager.rs:3393` 之后（新增 `spawn_crew_fanout`，照 `spawn_kiro_fanout:3114-3391`）

**Interfaces:**
- Consumes: Task 4 的 `CrewProcess` / `CrewConfig`；Task 2 的 `AppState.crew_port` / `crew_home`
- Produces:
  - `SessionType::Crew`（`Display` → `"crew"`，`from_str_lenient("crew")`）
  - `ResumeToken::Crew(String)`（存 slot_key；`to_kind_value` → `("crew", slot_key)`）
  - `SessionManager::create_crew_session(name, work_dir, cols, rows, owner_id) -> Result<String, String>`
  - `fn crew_slot_key(evt: &AcpEvent) -> Option<String>`

> **本任务的范围已订正三处**（由执行时的 subagent 发现，我逐条核实后确认）：
>
> **① `SessionManager` 需要 crew 字段，Task 2 只加到了 `AppState`。** 计划里 `spawn_crew`
> 读 `self.crew_home` / `self.crew_port`，但 `SessionManager`（`:313-335`）只有
> `claude_path`/`kiro_path`/`codex_path`/`codex_reasoning`。**不能改成传参**：`spawn_crew`
> 由 `ensure_running` 调用（`:1634`/`:1663` 的形态是 `spawn_codex(id, &work_dir, &owner_id, r)`），
> 那里只有 session id + 存储的元数据 —— 结构体注释本身就说明路径在构造时捕获正是为此。
> 所以按 `codex_reasoning` 的形状加两个字段 + 改构造器 + 更新 5 个调用点。
> **secret 不跨这个边界**：`crew_home` 是路径、`crew_port` 是整数，secret 仍只在
> `crew_process.rs` 的 fan-out 栈上读 —— Global Constraint 仍成立。
>
> **② `web.rs:663` 的 Crew 臂从 Task 6 提前到本任务。** 加 `SessionType::Crew` 变体会让
> 三处 `match` 变非穷尽（实测 `E0004`）：`session_manager.rs:1614` / `:1660`（本任务范围内）
> 与 **`web.rs:663`**（原属 Task 6）。不提前的话 Task 5 无法独立编译。Task 6 Step 4 的
> 那 6 行因此变成 no-op（保留其余部分）。
>
> **③ 测试里那条 `from_str_lenient("kiro") == Tmux` 已删除。** 它与本任务 Step 3 自相矛盾：
> Step 3 明确说在 `"codex"` 之后加 `"crew"` 而**保留** `"kiro" => SessionType::Kiro`，
> kiro 回落 Tmux 只在 **Task 11** 删掉该后端后才成立。已改为断言 `"nonsense"` 回落，
> 那条 kiro 断言移到 Task 11 Step 2。

- [ ] **Step 1: 写失败测试**

在 `src/session_manager.rs` 的既有 `#[cfg(test)] mod tests` 内追加：

```rust
    #[test]
    fn crew_session_type_roundtrips() {
        // 持久化往返：DB 里存 "crew"，读回必须还是 Crew（而不是回落 Tmux —— 那会让
        // 一个 Crew 会话在服务重启后变成终端，且 resume_token 被当成垃圾丢掉）。
        assert_eq!(SessionType::Crew.to_string(), "crew");
        assert!(matches!(SessionType::from_str_lenient("crew"), SessionType::Crew));
        // 未知值回落 Tmux（既有约定，最保守：PTY 无 resume 副作用）。
        assert!(matches!(SessionType::from_str_lenient("nonsense"), SessionType::Tmux));
        // 注意：`"kiro"` 此时仍映射 `SessionType::Kiro`（Task 11 才删除该后端），
        // 所以**不能**在这里断言它回落 Tmux —— 那条断言属于 Task 11 Step 2。
    }

    #[test]
    fn crew_resume_token_roundtrips() {
        // Crew 的 resume 载荷是 slot_key（不是 session id）—— 重生时用它
        // `GET /api/chat/slots/{key}` 确认存活即接回。
        let t = ResumeToken::Crew("zmx-abc12345".to_string());
        let (kind, value) = t.to_kind_value();
        assert_eq!(kind, "crew");
        assert_eq!(value, "zmx-abc12345");
        assert!(matches!(
            ResumeToken::from_kind_value("crew", "zmx-abc12345"),
            Some(ResumeToken::Crew(v)) if v == "zmx-abc12345"
        ));
    }

    #[test]
    fn crew_slot_key_reads_both_sources() {
        // 两个源都填 slot_key：spawn 开局那条 System{init}，与每轮的 Result。
        // 照 claude_session_id（:2174-2180）的双臂形状 —— 单臂会让一个从未完成
        // 过一轮的会话（只有 init）拿不到 resume token。
        let init = AcpEvent::System {
            subtype: std::borrow::Cow::Borrowed("init"),
            session_id: Some("zmx-abc12345".into()),
            count: None,
        };
        assert_eq!(crew_slot_key(&init).as_deref(), Some("zmx-abc12345"));
        let result = AcpEvent::Result {
            text: "done".into(), turn_id: 1, session_id: "zmx-abc12345".into(),
            cost_usd: None, tokens_in: None, tokens_out: None,
        };
        assert_eq!(crew_slot_key(&result).as_deref(), Some("zmx-abc12345"));
        // 空 session_id 不算（否则会存一个空 token，重生时 GET /slots/ 变成列表请求）。
        let empty = AcpEvent::Result {
            text: String::new(), turn_id: 1, session_id: String::new(),
            cost_usd: None, tokens_in: None, tokens_out: None,
        };
        assert!(crew_slot_key(&empty).is_none());
        // 其它 System subtype 不带 slot_key。
        let queued = AcpEvent::System {
            subtype: std::borrow::Cow::Borrowed("queued"), session_id: None, count: Some(2),
        };
        assert!(crew_slot_key(&queued).is_none());
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test crew_ 2>&1 | tail -10`（**`cargo test` 只接受一个位置参数 TESTNAME** —— 传多个会 `unexpected argument`；用前缀 `crew_` 一次匹配三个）

Expected: 编译失败 —— `no variant named 'Crew'`。

- [ ] **Step 3: 加枚举变体与映射**

```rust
// session_manager.rs:47-52
pub enum SessionType {
    Tmux,
    Claude,
    Kiro,
    Codex,
    Crew,
}

// :58-67 Display
            SessionType::Crew => write!(f, "crew"),

// :71-78 from_str_lenient（在 "codex" 之后）
            "crew" => SessionType::Crew,

// :83-110 ResumeToken
pub enum ResumeToken {
    // …既有变体…
    /// Crew: the Gateway slot key (`zmx-xxxxxxxx`). Not a session id — reconnect
    /// confirms it with `GET /api/chat/slots/{key}` and re-attaches; the
    /// conversation state lives on the Gateway, so this is a MORE reliable resume
    /// than the other three backends'.
    Crew(String),
}
// to_kind_value 加：
            ResumeToken::Crew(v) => ("crew", v.clone()),
// from_kind_value 加：
            "crew" => Some(ResumeToken::Crew(value.to_string())),

// :1183 —— agent 类会话的判定（Crew 也是 agent，不是 PTY）
            if !matches!(s.session_type,
                SessionType::Claude | SessionType::Kiro | SessionType::Codex | SessionType::Crew) {

// :2183 附近，照 claude_session_id 的形状
/// Crew 的 slot_key 来源有两个：spawn 开局那条 `System{init}`，与每轮的 `Result`。
/// 双臂是必需的 —— 单看 Result 会让一个从未完成过一轮的会话拿不到 resume token。
fn crew_slot_key(evt: &AcpEvent) -> Option<String> {
    match evt {
        AcpEvent::System { session_id: Some(s), .. } if !s.is_empty() => Some(s.clone()),
        AcpEvent::Result { session_id, .. } if !session_id.is_empty() => Some(session_id.clone()),
        _ => None,
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test crew_ 2>&1 | tail -6`

Expected: 3 passed。

- [ ] **Step 5: 加 crew 字段与构造器参数，再加 `spawn_crew` / `create_crew_session`**

**5a. 先加字段**（`SessionManager` 结构体，紧跟 `codex_reasoning`）：

```rust
    /// Kiro Crew Gateway 的端口与数据目录。与 `codex_reasoning` 同理在构造时捕获：
    /// `ensure_running` 重生一个会话时只有 session id + 存储的元数据，没有调用者
    /// 能供给这些值。**secret 不在此处** —— 它由 `crew_process.rs` 在 fan-out 栈上
    /// 从 `crew_home` 现读，绝不进这个结构体（它会被共享）。
    crew_port: u16,
    crew_home: String,
```

`SessionManager::new` 的参数列表加同两项（在 `worktree_isolation` 之前），并在结构体初始化里填上。

**5b. 更新 5 个调用点**：`src/main.rs:463`（传 `args.crew_port` / `crew_home.clone()`）+ 4 个测试 helper（`session_manager.rs:3946` / `:4111` / `:4600` / `:5331`，传 `5476` / `"/tmp/crew".into()` 之类的占位值即可 —— 那些测试不碰 Crew）。

**5c. 再加两个方法**：

```rust
    /// Spawn a Crew session for `id` at `work_dir`, start its fan-out, return the
    /// live handle. `resume` carries a slot key from a previous run.
    async fn spawn_crew(
        &self,
        id: &str,
        work_dir: &str,
        owner_id: &str,
        resume: Option<String>,
    ) -> Result<RunningProcess, String> {
        let cfg = crate::acp::crew_process::CrewConfig::new(
            std::path::PathBuf::from(&self.crew_home),
            self.crew_port,
        );
        let process = crate::acp::crew_process::CrewProcess::spawn(
            cfg, work_dir, resume.as_deref(),
        )
        .await
        .map_err(|e| format!("Failed to start Crew session: {}", e))?;

        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, input_rx) = mpsc::channel::<SessionInput>(64);

        spawn_crew_fanout(
            id.to_string(),
            process,
            event_tx.clone(),
            input_rx,
            self.events.clone(),
            "crew",
            work_dir.to_string(),
            owner_id.to_string(),
            self.weak(),
        );

        Ok(RunningProcess {
            event_tx,
            input_tx,
            pty_pid: None,
            turn_state: TurnState::Idle,
            turn_started_ms: None,
            turn_seq: 0,
            queue_mode: QueueMode::Collect,
        })
    }

    pub async fn create_crew_session(
        &self,
        name: String,
        work_dir: &str,
        cols: u16,
        rows: u16,
        owner_id: &str,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        // worktree 隔离对 Crew **不适用**：cwd 由 Gateway 管（我们 POST project），
        // 所以传 false 而不是 self.worktree_isolation（spec §7）。
        let (effective_dir, worktree_path) = resolve_work_dir(work_dir, &id, false);

        let running = self
            .spawn_crew(&id, &effective_dir.to_string_lossy(), owner_id, None)
            .await
            .map_err(|e| {
                if let Some(wt) = &worktree_path {
                    let base = PathBuf::from(work_dir);
                    remove_worktree(&base, wt);
                }
                e
            })?;

        let session = Session {
            id: id.clone(),
            name,
            session_type: SessionType::Crew,
            cols,
            rows,
            work_dir: effective_dir.to_string_lossy().to_string(),
            owner_id: owner_id.to_string(),
            description: String::new(),
            name_is_auto: true,
            status: SessionMeta::Running,
            resume_token: None,
            worktree_path,
            created_ms: now_millis(),
            source_task_id: None,
            spawning: false,
            last_activity_ms: now_millis(),
            turns_completed: 0,
            run_metrics: VecDeque::new(),
            lifetime_turns: 0,
            lifetime_duration_ms: 0,
            lifetime_cost_usd: 0.0,
            running: Some(running),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
        };

        self.persist_meta(&session);
        self.sessions.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }
```

`ensure_running` 的三处（`:1599` / `:1611-1616` / `:1651`）加 Crew 臂：

```rust
// :1599 —— 可 resume 的组合
                | (SessionType::Crew, Some(ResumeToken::Crew(_)))

// :1611 之后 —— 带 token 重生
            SessionType::Crew => {
                let r = match &resume {
                    Some(ResumeToken::Crew(s)) => Some(s.clone()),
                    _ => None,
                };
                self.spawn_crew(id, &work_dir, &owner_id, r).await
            }

// :1651 —— 无 token 全新重生
                    SessionType::Crew => self.spawn_crew(id, &work_dir, &owner_id, None).await,
```

- [ ] **Step 6: 加 `spawn_crew_fanout`**

**照抄 `spawn_kiro_fanout`（`:3114-3391`）整体结构**，四处差异：

1. `agent_label` 传 `"crew"`。
2. resume token 回填用 `crew_slot_key(&evt)` → `ResumeToken::Crew(k)`（照 kiro fanout 里 `token_saved` 那段的形状）。
3. `SessionInput::Approval { approval_id, action }` 臂：转成 `CrewProcess` 的审批命令（Task 7 加）。
4. 其余 `SessionInput` 臂（`PtyData` / `PtyResize`）静默丢弃 —— 与 kiro fanout 同构。

- [ ] **Step 7: 编译 + 全量测试**

Run: `cargo test 2>&1 | tail -3`

Expected: `400 passed`（Task 4 后的 397 + 本任务 3）。

- [ ] **Step 8: Commit**

```bash
git add src/session_manager.rs
git commit -m "$(cat <<'EOF'
feat(crew): SessionType::Crew + spawn_crew + create_crew_session + fanout

fan-out 从「独占一个子进程」变为「独占一条 WS 连接 + 一个 slot_key」——
与 Codex 走 rmcp client 的先例同构,CLAUDE.md 的「fan-out 是进程唯一所有者」
不变量以此形式保持,Drop 语义天然成立。

ResumeToken::Crew 存的是 slot_key 而非 session id:会话状态在 Gateway 侧
持久,所以重生只需 GET /api/chat/slots/{key} 确认存活 —— 比其余三个后端的
resume 更可靠。

crew_slot_key 双臂(System{init} 与 Result):单看 Result 会让一个从未完成
过一轮的会话拿不到 resume token。

worktree 隔离对 Crew 不适用(cwd 由 Gateway 管),故 resolve_work_dir 传 false。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 接线 —— web.rs 分派 + bump 谓词 + 前端菜单换项

**Files:**
- Modify: `src/web.rs:663-690`（会话创建分派加 Crew 臂）
- Modify: `src/session_manager.rs:2978-2981`（bump 谓词加 `crew_event_is_forward_progress`）
- Modify: `src/auto_titler.rs`（`TitlerBackend` 加 `Crew`，复用 Kiro 的实现路径）
- Modify: `frontend/src/lib/api.ts:1`（`SessionType` 加 `'crew'`）
- Modify: `frontend/src/components/BrandIcons.tsx`（末尾加 `CrewIcon`）
- Modify: `frontend/src/components/Sidebar.tsx:15`（import）、`:72`（`SessionTypeIcon`）、`:581-590`（菜单项原位替换）
- Modify: `frontend/src/components/QuickTargets.tsx:7,15`（import + `RowIcon`）
- Modify: `frontend/src/components/AcpChatView.tsx:57`（`agentType`）、`:682`、`:791`（两处文案）
- Modify: `frontend/src/lib/quickTargets.ts:6`（`AGENTS` 白名单）
- Modify: `frontend/src/lib/terminalInput.ts:81,83-87`（`AgentKey` + `LAUNCH`）
- Modify: `frontend/src/components/MobileKeyBar.tsx:21`（`AGENT_KEYS`）
- Modify: `frontend/src/components/TerminalView.tsx:128`（虚拟键盘分派）
- Modify: `frontend/src/components/AgentDashboard.tsx:31`（标签配色）
- Create: `frontend/src/components/__tests__/crewSessionType.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `create_crew_session`；Task 4 的 `crew_event_is_forward_progress`
- Produces: `SessionType` 前端类型含 `'crew'`；`CrewIcon` 组件；`launchSequence('crew')` → `"kirocrew chat\r"`

**⚠️ 起草期发现 spec §9.1 漏列了三处映射**（漏了会静默坏掉）：

| # | 位置 | 漏了的后果 |
|---|---|---|
| 6 | `lib/quickTargets.ts:6` 的 `AGENTS` 白名单 | crew 快速入口行被判为脏值 → 走 `onChangeAgent`，**用户每次都得重选类型**（而快速入口是日常 90% 路径） |
| 7 | `lib/terminalInput.ts:81,83-87` 的 `AgentKey` / `LAUNCH` | `MobileKeyBar` 的键实际由此定义 |
| 8 | `TerminalView.tsx:128` 的分派 | 虚拟键盘的 crew 键**点了没反应** |

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/components/__tests__/crewSessionType.test.tsx`（代码见附录 E1，6 个测试）。它逐处断言五+三处映射，而不是只断言类型定义 —— 历史上漏一处的表现是"会话能建但列表里图标是终端"或"composer 说 Send a message to Claude"，都不报错，只是静默错。

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run crewSessionType 2>&1 | tail -10`

Expected: 全红（`CrewIcon` 不存在、`selectType('crew')` 找不到）。

- [ ] **Step 3: 前端改动**

`BrandIcons.tsx` 末尾加 `CrewIcon`（代码见附录 E1-A）。**不复用 `KiroIcon`**（`BrandIcons.tsx:28-43`，紫色幽灵 `#9046FF`）—— 历史 kiro 会话仍在会话列表（`Sidebar.tsx:412`），同图标无法区分。同色系 + 记忆环。`<title>Kiro Crew</title>` 是测试唯一稳定的可断言标识，**不要删**。

`Sidebar.tsx:581-590` 整块替换为 Crew（副标题 **"有记忆的 AI agent"** —— 这是唯一能解释"它和 Claude 有何不同"的位置）。**不重排顺序**，仍是 4 项。

其余七处按上表逐一改。`terminalInput.ts` 的 `LAUNCH.crew` 用 **`'kirocrew chat'`**（已实测存在于 `kirocrew --help` 的 "Work with the agent" 段）。

- [ ] **Step 4: 后端改动**

`src/web.rs:663-690` 的 `match req.session_type` 加：

```rust
        crate::session_manager::SessionType::Crew => {
            state.sessions
                .create_crew_session(name.clone(), &work_dir, state.default_cols, state.default_rows, &owner_id)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
```

`src/session_manager.rs:2978-2981` 的 bump 谓词加一项：

```rust
      && crate::acp::crew_process::crew_event_is_forward_progress(evt)
```

放在 `emit` 而非 fan-out，因为 `emit` 是唯一 emit/persist chokepoint（`:2932-2939` 的 T2/D2 不变量），且这一项对其余三后端**恒真**（它们从不发 `System{subtype:"status"}` —— 三者的 `System` 只有 `"init"` 与 `"queued"`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd frontend && npx vitest run crewSessionType 2>&1 | tail -6` → Expected 6 passed。

Run: `cd frontend && npx vitest run 2>&1 | tail -6` → Expected **46 文件 / 268 测试**（基线 45/262 + 本任务 1 文件 6 测试）。

Run: `cargo test 2>&1 | tail -3` → Expected `400 passed`（不变，本任务无新 Rust 测试）。

- [ ] **Step 6: 退化验红**

临时把 `quickTargets.ts:6` 的 `'crew'` 从 `AGENTS` 里删掉，跑 `npx vitest run crewSessionType`。

Expected: **③b 那条红**（精确命中第 6 处映射）。改回来。

- [ ] **Step 7: 端到端手工验收（需 Gateway 运行）**

```bash
systemctl is-active kirocrew   # 必须 active
cd frontend && npm run build && cd .. && cargo build
# --data-dir 是必需的：不带它,测试实例会挂载**生产的 ~/.zeromux**
# (session store / scheduled.db / events.db 全共享),并在启动时跑
# reconcile_orphans。用隔离目录。
mkdir -p /tmp/crew-e2e/data
./target/debug/zeromux --port 18099 --password t \
  --work-dir /home/ubuntu/crew-e2e-wd --data-dir /tmp/crew-e2e/data
```

**legacy 密码模式的认证方式**（省得摸索）：没有 `/api/login`，直接带
`Authorization: Bearer <password>` 或 `?token=<password>`（`auth.rs:216-234`）。
**会话的 prompt 只能走 WebSocket** `/ws/acp/{id}?token=<password>` —— 没有 REST
的 prompt 端点。

浏览器开 `http://127.0.0.1:18099`：

1. New Session 类型菜单是 **4 项**，第 3 项是「Kiro Crew · 有记忆的 AI agent」，**没有** Kiro。
2. 选它建会话 → 会话列表出现紫色带环图标。
3. 发 `pwd` → 返回值等于所选 work_dir（验证 `project` 生效）。
4. 发「跑一下 `echo HELLO && date`」→ `tool_use` 块渲染 **一次**（非 3 次）。
5. 轮次结束后活动看板有摘要（`Result.text` 非空）。
6. **开两个 Crew 会话同时发 prompt → 输出不串台**（I1 端到端）。
7. 忙时再发一条 → 两轮都完整、顺序正确（验证 SSE 响应体被丢弃的决策）。
8. `systemctl stop kirocrew` → 会话报错且不 hang；`systemctl start kirocrew` → 重连恢复。
9. 删除会话 → `curl -H "X-Internal-Secret: $(cat ~/.kiro/crew/run/gateway-5476.secret)" http://127.0.0.1:5476/api/chat/slots` 中该 slot 消失。

Ctrl-C 结束。**任何一条不过就停下报告，不要继续下一个批次。**

- [ ] **Step 8: Commit**

```bash
git add src/web.rs src/session_manager.rs src/auto_titler.rs frontend/src/
git commit -m "$(cat <<'EOF'
feat(crew): 接线 —— web.rs 分派 + bump 谓词 + 菜单原位换项

菜单是原位替换(Kiro→Kiro Crew),仍是 4 项、不重排:现有顺序已是肌肉记忆,
为一个 10% 路径(QuickTargets 才是日常入口)重排全表不值得。

spec §9.1 漏列了三处映射,起草期发现并补上:
- quickTargets.ts 的 AGENTS 白名单 —— 漏了 crew 行被判脏值走 onChangeAgent,
  用户每次都得重选类型(而这是日常 90% 路径)
- terminalInput.ts 的 AgentKey/LAUNCH —— MobileKeyBar 的键实际由此定义
- TerminalView.tsx:128 的分派 —— 漏了虚拟键盘 crew 键点了没反应

bump 谓词加 crew_event_is_forward_progress 放在 emit(唯一 chokepoint)而非
fanout:chat_status 是 Gateway 的 "Thinking…" 心跳,不是前进信号,让它刷
last_activity_ms 会让卡死在工具调用上的轮次永远架空空闲看门狗。该项对其余
三后端恒真(它们的 System 只有 init/queued)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 批次 2：审批 + 上下文用量（后端与前端必须同一 commit）

### Task 7: `AcpEvent` 两个新变体 + 前端两个 case（同一 commit）

**为什么必须同一个 commit**：前端对未知事件是**静默丢弃，不是降级显示** —— `BlockView` 的 `default: return null`（`AcpChatView.tsx:967-968`）、`handleEvent` 的 switch **无 `default` 分支**（`:307-437`）。分开提交会表现为「什么都没发生」，是最难 debug 的失败模式。

**Files:**
- Modify: `src/acp/process.rs`（`Exit` 变体后加两个，已在 Task 4 Step 8 完成 —— 若 Task 4 已做则跳过）
- Modify: `src/acp/crew_process.rs`（`normalize_frame` 加 `"approval"` 与 `"context_usage"` 两臂）
- Modify: `src/acp/ws_handler.rs:22-32`（`ClientMsg` 加 `Approval` 变体）
- Modify: `src/session_manager.rs:114-134`（`SessionInput` 加 `Approval`）
- Modify: `frontend/src/lib/transcript.ts`（`WireEvent` 加 `approval_id`；`Block.type` 加 `'approval'`；`Block` 加 `approvalId`）
- Modify: `frontend/src/components/AcpChatView.tsx`（`ServerEvent` 加字段、`handleEvent` 两个 case、`BlockView` 一个 case、`resolveApproval`、`resolvedApprovals` state、`memo` 比较器两行、`ctxUsage` 显示）
- Create: `frontend/src/test/fakeWs.ts`
- Create: `frontend/src/components/__tests__/crewEventCases.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `normalize_frame`
- Produces:
  - `AcpEvent::Approval { id: String, tool: String, tool_input: Option<String>, tool_purpose: Option<String>, slot: String }`
  - `AcpEvent::ContextUsage { used: u64, total: u64 }`
  - 上行 WS 消息 `{"type":"approval","approval_id":"<id>","action":"approve"|"reject"}`
  - `SessionInput::Approval { approval_id: String, action: String }`

- [ ] **Step 1: 写失败测试（前端）**

创建 `frontend/src/test/fakeWs.ts`（代码见附录 W）—— **任何 mount `AcpChatView` 的测试都需要它**，happy-dom 不提供 `WebSocket` 构造器。

**注意**：`url: string` 必须显式声明字段，**不能**写 `constructor(public url: string)` —— `tsconfig.app.json:26` 开了 `erasableSyntaxOnly`，参数属性会 **TS1294 编译失败**（起草期实测撞到）。

创建 `frontend/src/components/__tests__/crewEventCases.test.tsx`（代码见附录 E2，6 个测试 —— 起草者原稿 8 个，砍掉 2 个 `auto_read` 相关的，因为该档已取消）。

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run crewEventCases 2>&1 | tail -12`

Expected: 全红 —— `需要你批准` 找不到（`BlockView` 无 `approval` 分支 → `default: return null`）。

- [ ] **Step 3: 后端加变体与归一化两臂**

`src/acp/process.rs`（`Exit` 之后）：

```rust
    /// Crew 的 PreToolUse 审批请求。走 fan-out 已独占订阅的那条 Gateway 全局 WS，
    /// 零新增连接。**这是 zeromux 相对 Crew 全部 10 个 IM 渠道的唯一结构性优势** ——
    /// 实测微信 Tappable choices = 0 且不装 approval decider。
    ///
    /// 第一期**不发** `POST /api/chat/mode {"mode":"trust"}`：不带 `slot` 的 mode
    /// 请求会把 Gateway 上所有 slot 和所有 IM 渠道（含微信）永久设为 auto-approve
    /// 并落盘（chat_handlers.py:9016-9040）。
    ///
    /// 字段名照 Gateway 的 payload（interaction_coordinator.py:40-48）：是
    /// `tool_purpose`/`tool_input`，不是 `purpose`/`input`。三者在 Gateway 侧
    /// **已 redact**（凭证与 exfil URL 已抹），此处不再处理。
    Approval {
        /// Gateway 侧的 approval id，回执时用（`POST /api/approvals/{id}/{action}`）。
        id: String,
        /// 待批准的工具/命令，如 `rm -rf /tmp/build`。
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_input: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_purpose: Option<String>,
        /// 来源 slot。同一浏览器可能同时开多个 Crew 会话，前端据此二次校验归属。
        slot: String,
    },
    /// 上下文用量。来自 Crew 的 `context_usage` 帧 —— zeromux **自己没有**这个能力，
    /// 是接入 Crew 白拿的新功能。`total` 恒 > 0（进程层已滤掉 0/缺失，见
    /// crew_process::normalize_frame），前端可直接做分母。
    ContextUsage {
        used: u64,
        total: u64,
    },
```

`src/acp/crew_process.rs` 的 `normalize_frame` 加两臂：

```rust
        // ── approval → Approval（spec §4.5：替代 mode:trust）──
        "approval" => {
            let Some(id) = data.get("id").and_then(|v| v.as_str()) else { return vec![] };
            let tool = data.get("tool").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
            let nonempty = |k: &str| data.get(k).and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()).map(|s| s.to_string());
            vec![AcpEvent::Approval {
                id: id.to_string(),
                tool,
                tool_input: nonempty("tool_input"),
                tool_purpose: nonempty("tool_purpose"),
                slot: my_slot.to_string(),
            }]
        }

        // ── context_usage → ContextUsage ──
        "context_usage" => {
            let used = data.get("used").and_then(|v| v.as_u64());
            let total = data.get("total").or_else(|| data.get("limit")).and_then(|v| v.as_u64());
            match (used, total) {
                // total==0 会让前端渲染 NaN%/Infinity% —— 在进程层就滤掉。
                (Some(used), Some(total)) if total > 0 => vec![AcpEvent::ContextUsage { used, total }],
                _ => vec![],
            }
        }
```

`src/acp/ws_handler.rs`（`ClientMsg` 枚举内）：

```rust
    /// Crew 审批回执。沿用同一条 /ws/acp socket（不新开连接、不新增轮询）；
    /// fan-out 代理到 `POST /api/approvals/{id}/{action}`。
    #[serde(rename = "approval")]
    Approval { approval_id: String, action: String },
```

`src/session_manager.rs`（`SessionInput` 枚举内）：

```rust
    /// Crew: 审批回执（approve / reject）。仅 Crew fan-out 消费；其余 fan-out
    /// 静默丢弃（与 PtyData 对 agent fan-out 的处理同构）。
    Approval { approval_id: String, action: String },
```

`crew_process.rs` 的事件循环 `Cmd` 加一个变体并在 `Cmd::Approval` 臂 detached spawn 一个 `POST /api/approvals/{id}/{action}`（照 `Cmd::Cancel` 的形状 —— 同样不能排在阻塞的 prompt 之后）。

- [ ] **Step 4: 前端加两个 case + 一个 BlockView 分支**

代码见附录 E2。**四个必须点**：

1. `handleEvent` 的 `case 'approval'` 里要 `setLastEventMs(Date.now())` —— **这是起草期发现的一个真实交互 bug**：`stuck` 是**静默**判定（`AcpChatView.tsx:585` 的 `STUCK_SILENCE_MS`），approval 弹出后 agent 就不再产出任何输出（它在等人），不刷新基线的话 60s 后 UI 会显示"可能卡住"+ 中断按钮，用户点中断会白白杀掉一个只需点"批准"的轮次。**审批是真实的前进信号**（agent 主动请求交互），与 `chat_status`（纯噪音）方向相反。
2. `TurnGroupView` 的 `memo` 比较器**必须**加 `prev.resolvedApprovals === next.resolvedApprovals` 与 `prev.onResolveApproval === next.onResolveApproval` 两行 —— `stabilizeGroups`（`AcpChatView.tsx:92`，2026-08-03 F-perf）刻意让已完成 turn 保持对象 identity，不加这两行**点了批准卡片永远不会收起按钮**（表现为"点了没反应"）。
3. `approval_id` 缺失时**整帧丢弃**，不渲染半个卡片 —— 绝不给两个点了没反应的按钮。
4. `density.ts` **无需改**：`partitionBlocks`（`density.ts:18-25`）只特判 `thinking`/`tool_use`，`approval` 落进 `visible.push(b)`，所以 concise 模式下审批卡片不会被折叠进"+N 条思考/工具"—— 这正是想要的。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd frontend && npx vitest run crewEventCases 2>&1 | tail -8`

Expected: 6 passed。

- [ ] **Step 6: 退化验红（确认测试不是空转）**

临时把 `BlockView` 的 `case 'approval'` 删掉（落回 `default: return null`），跑 `npx vitest run crewEventCases`。

Expected: **至少 3 红**。若全绿说明测试是空转的 —— 修测试再继续。改回来。

- [ ] **Step 7: 全量测试 + 类型检查**

Run: `cargo test 2>&1 | tail -3` → Expected `400 passed`（Task 6 后不变 —— 本任务的测试全在前端）。

Run: `cd frontend && npx tsc --noEmit && npx vitest run 2>&1 | tail -6`

Expected: 无类型错误；**47 文件 / 274 测试**（Task 6 的 46/268 + 本任务 1 文件 6 测试）。

- [ ] **Step 8: Commit（后端前端一起）**

```bash
git add src/acp/process.rs src/acp/crew_process.rs src/acp/ws_handler.rs src/session_manager.rs \
        frontend/src/lib/transcript.ts frontend/src/components/AcpChatView.tsx \
        frontend/src/test/fakeWs.ts frontend/src/components/__tests__/crewEventCases.test.tsx
git commit -m "$(cat <<'EOF'
feat(crew): 审批内联卡片 + 上下文用量(后端前端同一 commit)

必须同一 commit:前端对未知事件是静默丢弃 —— BlockView 的 default 是
return null、handleEvent 的 switch 无 default 分支。分开提交会表现为
「什么都没发生」。

审批是 zeromux 相对 Crew 全部 10 个 IM 渠道的唯一结构性优势(实测微信
Tappable choices=0 且不装 approval decider)。走 fan-out 已订阅的那条
全局 WS,零新增连接;回执沿同一条 /ws/acp 上行。

两个易漏点(起草期实测):
- case 'approval' 必须 setLastEventMs:stuck 是静默判定,approval 弹出后
  agent 不再产出输出(它在等人),不刷基线则 60s 后 UI 说「可能卡住」,
  用户点中断会白杀一个只需点批准的轮次
- TurnGroupView 的 memo 比较器必须加 resolvedApprovals ——
  stabilizeGroups 刻意稳定已完成 turn 的对象 identity,不加则点了批准
  卡片永不收起按钮

字段名照 Gateway 实测(interaction_coordinator.py:40-48):tool_purpose/
tool_input,且已在 Gateway 侧 redact。context_usage 的 total==0 在进程层
滤掉(否则前端渲染 NaN%)。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 批次 3：记忆写入（先做，因为记忆现在是空的）

### Task 8: 记忆代理端点（zeromux 后端）

**为什么必须代理**（三条，缺一不可）：

1. **跨源**。前端在 `zeromux.keithyu.cloud:443`，Gateway 在 `127.0.0.1:5476` 且**只绑 loopback**（`kirocrew --help` 原文："the dashboard is the only port Kiro Crew opens, and it binds loopback only"）。浏览器根本连不上，不是 CORS 能解决的。
2. **凭证不能下发**。Gateway token 是 20 小时的全权 JWT（实测 15/15 端点全通）。放进 `localStorage` 等于把 Gateway 交给任何 XSS。而 mint 它要 `X-Local-Secret`（0600 的 secret 文件）—— secret 更不能进前端，那正是 `is_credential_path` 一直在防的东西。
3. **`X-Session-Key` 必须是服务端知识**。写记忆要带一个**已存在的** slot key（实测：缺头 → `missing_session_key`，给不存在的 slot → `unknown session`）。前端不该知道 slot 命名。

**Files:**
- Create: `src/crew_memory.rs`
- Modify: `src/main.rs`（`mod crew_memory;`）
- Modify: `src/web.rs:44` 附近（四条路由，挂在 authed `/api/*` 组内 —— 自动继承 JWT 中间件与 owner-scope）

**Interfaces:**
- Consumes: `AppState.crew_home` / `crew_port`（Task 2）；`crew_process::{read_gateway_secret, mint_ws_token}`（Task 4）
- Produces：
  - `GET /api/crew/memory` → `{preferences, projects, semantic[], lessons[], gateway_ok}`
  - `PUT /api/crew/memory/semantic` body `{key, value, source, confidence}`
  - `DELETE /api/crew/memory/semantic/{key}`
  - `PUT /api/crew/memory/{preferences|projects}` body `{content}`

- [ ] **Step 1: 写失败测试**

在 `src/crew_memory.rs` 内联测试模块里写**纯函数**的测试（HTTP 部分不单测，靠 Step 6 的手工验收）：

```rust
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test crew_memory 2>&1 | tail -8`

Expected: 编译失败 —— `cannot find function 'validate_semantic_key'`。

- [ ] **Step 3: 实现**

```rust
//! Crew 记忆的 zeromux 侧代理。
//!
//! 浏览器不能直连 Gateway（loopback-only + 全权 token 不能下发 + X-Session-Key
//! 是服务端知识），所以记忆面的每一次读写都经这里。**token 只在本模块的函数栈上
//! 存活**：不进 AppState、不进 Session、不进日志、不进响应体。
use serde::{Deserialize, Serialize};

/// Gateway 侧的 key 约束（实测）：`^[a-z][a-z0-9_.]*[a-z0-9]$` 且带命名空间前缀。
/// 在转发前挡掉，免得把一个注定 400 的请求送出去、还让用户以为写成功了。
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
```

HTTP 部分：一个 `async fn crew_token(state) -> Result<String, String>`（读 secret → mint，**`?ttl=20h`**），四个 handler 各自 `reqwest` 打 Gateway。`GET` 那个用 `tokio::try_join!` 并发四个上游请求（**一次 GET 顶四次往返** —— 手机上这很重要），任一失败该字段留空。

**`X-Session-Key` 的取法**：从 `state.sessions` 里找当前 owner 的任一 `SessionType::Crew` 会话，取其 `ResumeToken::Crew(slot_key)`。**找不到就返回 409** + 明确提示「需要先开一个 Kiro Crew 会话」—— **绝不猜一个 slot 名**（会得到 `unknown session`，且用户看不懂）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test crew_memory 2>&1 | tail -6` → Expected 2 passed。

Run: `cargo test 2>&1 | tail -3` → Expected `402 passed`（Task 5 后的 400 + 本任务 2）。

- [ ] **Step 5: 手工验证代理（需 Gateway + 一个 Crew 会话）**

```bash
cargo run -- --port 18099 --password t --work-dir /home/ubuntu &
# 浏览器建一个 Crew 会话后：
curl -s -b /tmp/zmxc -c /tmp/zmxc "http://127.0.0.1:18099/api/crew/memory" | head -c 400
```

Expected: 200，含 `"gateway_ok": true` 与四个字段。

停掉 Gateway 再打一次：Expected 仍是 **200** 且 `"gateway_ok": false`（**不是 5xx**）。

- [ ] **Step 6: Commit**

```bash
git add src/crew_memory.rs src/main.rs src/web.rs
git commit -m "$(cat <<'EOF'
feat(crew): 记忆代理端点

浏览器不能直连 Gateway:①loopback-only,不是 CORS 能解决 ②token 是 20h
全权 JWT(实测 15/15 端点全通),下发给前端等于把 Gateway 交给任何 XSS
③X-Session-Key 必须是已存在的 slot,是服务端知识。

GET /api/crew/memory 并发四个上游请求(一次 GET 顶四次往返 —— 手机上重要),
Gateway 不可达时回 200 + gateway_ok:false 而非 5xx:「读不到」与「真的空」
含义完全不同,混淆了用户会以为记忆被清空。

key 前缀与正则在转发前校验,免得把注定 400 的请求送出去还让用户以为写成功。
找不到活 Crew 会话时回 409 + 明确提示,绝不猜一个 slot 名。

token 只在本模块函数栈上存活:不进 AppState / Session / 日志 / 响应体。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: composer 的就地记忆入口

**为什么在 composer 而不是设置里**：人只在**被冒犯的那一刻**想纠正记忆（agent 刚用了 npm 而你说过 pnpm），那一刻拇指在输入框上。要求用户"打开设置去配置偏好" = 问卷 = 没人填。

**Files:**
- Create: `frontend/src/lib/crewMemory.ts`（纯函数层）
- Create: `frontend/src/lib/__tests__/crewMemory.test.ts`
- Create: `frontend/src/components/__tests__/crewMemoryWrite.test.tsx`
- Modify: `frontend/src/lib/api.ts`（代理层四个函数 + 三个 interface）
- Modify: `frontend/src/components/AcpChatView.tsx`（state / callbacks / popover / 第 3 个按钮 / 两处互斥 / Esc）

**Interfaces:**
- Consumes: Task 8 的四个代理端点
- Produces:
  - `normalizeMemoryKey(input) -> {key, value}`、`KEY_RE`、`parseSemanticValue(json)`、`mdLines(md)`、`dropMdLine(md, idx)`
  - `getCrewMemory()` / `putCrewSemantic(key, value)` / `deleteCrewSemantic(key)` / `putCrewMemoryDoc(doc, content)`
  - `AcpChatView` 新 prop `onOpenMemory?: () => void`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/lib/__tests__/crewMemory.test.ts`（纯函数，7 个测试）与 `frontend/src/components/__tests__/crewMemoryWrite.test.tsx`（组件，6 个测试）。代码见附录 E3。

**关键手法**：组件测试**拦 `globalThis.fetch` 而不是 mock `api.ts`** —— 约束在于发出的 HTTP 形状（路径带不带 key、有没有 `X-Session-Key`），mock 掉 api 层就什么都测不到了。

**受控 input 必须用 `fireEvent.change`**（React 合成事件），直接 dispatch 原生 input 事件不会触发 `onChange`，`value` 会被下一次 render 还原（起草期实测撞到）。

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run crewMemory 2>&1 | tail -10`

Expected: 全红 —— 模块不存在。

- [ ] **Step 3: 实现纯函数层 `crewMemory.ts`**

代码见附录 E3-A。**四个设计点**：

1. `normalizeMemoryKey` 接受两种输入形态（自由句子 / `key = value`），自动补 `pref.` 前缀。**用户在手机上不会也不该自己写 `pref.pkg_manager`。**
2. 已带合法前缀时**不再叠一层**（`project.repo` 不能变成 `pref.project_repo`）—— 这个检查必须在 slug 化**之前**，因为 slug 会把 `.` 折成 `_`。
3. 纯中文输入（无任何 ASCII 词）用稳定 FNV-1a hash 兜底成 `pref.note_<hash>` —— **绝不发一个会被 Gateway 400 掉的 key，也绝不静默丢弃用户的话**。同一句话两次归一化得同一个 key（重写=更新，不堆积）。
4. `mdLines` **跳过标题与 HTML 注释**：实测 `preferences.md` 现在只有 56 字节且全是骨架（`# User Preferences` + 一行注释）。不过滤 → 面板显示"已记 2 条"，用户点删就删掉文件结构。
5. `dropMdLine` 的下标必须**从过滤后映射回原始行号** —— 整文件 PUT，删错行不可逆。

- [ ] **Step 4: 实现 api 代理层与 composer UI**

代码见附录 E3-B/C。**五个必须点**：

1. 第 3 个按钮**只在 `agentType === 'crew'` 渲染** —— 宽度核算：现有 2 按钮 + 发送 = 104px，375px 屏下 textarea 约 246px；加一个 → 136px，textarea 剩 ~214px。Claude/Codex 会话不受影响。
2. `✕` **常驻**，绝不 `group-hover`（Tailwind v4 编进 `@media (hover:hover)` → 手机上隐形按钮）。
3. **二段确认**：点 `✕` 只展开确认行，不发请求；再点才删。不用 `window.confirm`。
4. **写入回执**：成功后在对话流 `pushNotice({kind:'system'})` 留一行「已记住：…」。可见性靠回执不靠面板 —— 用户一天不会主动打开记忆面板。
5. 两个 popover **互斥**（都是 `absolute bottom-full`，同开会重叠），且 `memOpen` 的 callbacks **必须放在 `pushNotice` 定义之后**（依赖它，放前面 TDZ 报错 —— 起草期实测撞到）。
6. **`memReqRef` 单调令牌**：popover 一开就冷 GET，同时用户可能立刻写/删（乐观 `setMemRecent`）。没有它，写入前发出的旧快照迟到会盖掉刚加的条目 / 复活刚删的 ghost。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd frontend && npx vitest run crewMemory 2>&1 | tail -8` → Expected 13 passed（7 + 6）。

- [ ] **Step 6: 退化验红（五条，逐条）**

逐条临时退化并跑测试，确认精确命中：

| 退化 | Expected |
|---|---|
| `normalizeMemoryKey` 不加 `pref.` 前缀 | 红 |
| `putCrewSemantic` 路径带 key | 红 |
| 二段确认退化成一段 | 红 |
| 去掉写入回执 | 红 |
| `mdLines` 不过滤骨架 | 红 |

每条验完改回来。**全绿说明测试空转，必须修测试。**

- [ ] **Step 7: 类型检查 + lint + 全量**

Run: `cd frontend && npx tsc --noEmit && npm run lint 2>&1 | tail -5 && npx vitest run 2>&1 | tail -6`

Expected: 无类型错误；lint 无新增告警；**49 文件 / 288 测试**（Task 7 的 47/274 + 本任务 2 文件 14 测试）。

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/crewMemory.ts frontend/src/lib/api.ts \
        frontend/src/components/AcpChatView.tsx \
        frontend/src/lib/__tests__/crewMemory.test.ts \
        frontend/src/components/__tests__/crewMemoryWrite.test.tsx
git commit -m "$(cat <<'EOF'
feat(crew): composer 就地记忆入口(3 tap 纠正,不离开对话)

人只在「被冒犯的那一刻」想纠正记忆(agent 刚用了 npm 而你说过 pnpm),那一刻
拇指在输入框上。要求用户「打开设置去配置偏好」= 问卷 = 没人填。

动线:1 tap 开 popover → 最近 5 条直接可见(0 tap) → 2 tap 点 ✕ → 3 tap 确认。
不离开对话、不加载新页、不用 window.confirm、不需要软键盘。

三个隐藏约束由纯函数层钉死(每条都会让第一次实现失败):
- PUT 路径不带 key(带 key 是 405)
- 必须带 X-Session-Key 且值是已存在的 slot(后端代理补)
- key 必须匹配 ^[a-z][a-z0-9_.]*[a-z0-9]$ 且带 pref.|project.|user.|lesson. 前缀

用户不会也不该自己写 pref.pkg_manager,故 normalizeMemoryKey 接受自由句子;
纯中文输入用稳定 FNV-1a 兜底成 pref.note_<hash> —— 绝不发一个注定 400 的 key,
也绝不静默丢用户的话;同句两次归一化得同一 key(重写=更新不堆积)。

mdLines 跳过标题与 HTML 注释:实测 preferences.md 只有 56 字节且全是骨架,
不过滤会让面板说「已记 2 条」,用户点删就删掉文件结构。

写入回执走 NoticeBubble 的 system 分支:可见性靠回执不靠面板 —— 用户一天
不会主动打开记忆面板。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 批次 4：记忆面板（第 5 个 overlay view）

### Task 10: `MemoryPanel` + 第 5 个图标

**Files:**
- Create: `frontend/src/components/MemoryPanel.tsx`
- Modify: `frontend/src/App.tsx:21`（`OverlayView` 加 `'memory'`）、`:16`（import）、`:296`（`toggleOverlay` 签名）、`:358` 附近（两个新 prop）、`:385`（`onOpenMemory`）、`:390` 之后（第 4 个渲染点）
- Modify: `frontend/src/components/SessionInfoBar.tsx`（第 5 个图标 + 两个 prop）
- Modify: `frontend/src/components/__tests__/crewMemoryWrite.test.tsx`（追加面板的 4 个测试）

**Interfaces:**
- Consumes: Task 8 的代理端点；Task 9 的 `crewMemory.ts` 纯函数
- Produces: `MemoryPanel` 组件（**不接 `sessionId`** —— 记忆在 Crew 侧是全局的，一份 Gateway 一份记忆）；`SessionInfoBar` 新 prop `onToggleMemory?` / `showMemory?`

- [ ] **Step 1: 写失败测试**

在 `crewMemoryWrite.test.tsx` 追加 `describe('T15-c 记忆面板')` 的 4 个测试（代码见附录 E4）：空状态即写入表单、骨架不算记忆、删行下标映射、`gateway_ok:false` 显示降级条而非空状态。

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run crewMemoryWrite 2>&1 | tail -8`

Expected: 新增 4 条红（`MemoryPanel` 不存在）。

- [ ] **Step 3: 实现 `MemoryPanel.tsx`**

代码见附录 E4-A。**空状态是本设计最重要的一屏** —— 实测记忆现在必然是空的（semantic `[]`、lessons `[]`、preferences 56 字节全骨架）。三条设计：

1. **空态本身就是写入表单**，不是一块"暂无数据"。
2. 文案给因果（"下一轮起它会自动带上"），不是名词解释。
3. `text-base`(16px) + `min-h-[44px]`。

**关键区分**：`gateway_ok:false`（读不到）与"真的空"是**两种完全不同的含义** —— 前者显示黄色降级条，后者显示写入表单。混淆了用户会以为记忆被清空。

`reqRef` 单调令牌是必需的：本面板同时具备「慢 GET」（后端并发四个上游请求）与「乐观 mutation」两个条件，正是本 repo 修过十余次的 stale-clobber 场景。

**教训区只读** —— Crew 侧无 per-lesson DELETE 端点，别给一个点了没反应的 `✕`。

- [ ] **Step 4: `App.tsx` 与 `SessionInfoBar` 接线**

`OverlayView` 加 `'memory'`，`toggleOverlay` 的联合类型跟着加，第 4 个渲染点 `{view === 'memory' && <MemoryPanel />}`。自动继承 `App.tsx:379-381` 的 CSS 可见性保留。

`SessionInfoBar` 第 5 个图标用 `{onToggleMemory && ...}` 门控（照 `:196` 的现成 idiom），仅 `type === 'crew'` 传入。**5 个是硬上限**（已核算：5×22 + 4×4 = 126px，加汉堡 22 + chevron 18 + StatusDot 8 + 内边距 24 ≈ 198px，375px 下 description 余 ~177px）。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd frontend && npx vitest run 2>&1 | tail -6`

Expected: **49 文件 / 292 测试**（Task 9 的 49/288 + 本任务 4 测试，追加进既有文件故文件数不变）。

- [ ] **Step 6: 手工验收（手机视口）**

浏览器 DevTools 切 375px 宽：

1. Crew 会话的 SessionInfoBar 有 **5 个图标**，description 仍可见（未被挤没）。
2. 点 `Brain` → 记忆面板打开；对话状态在切回后完整保留（CSS 可见性）。
3. 记忆为空时看到**写入表单**（不是"暂无数据"）；写一条 → 出现在列表里。
4. 点 `✕` → 下沉展开确认；再点 → 该条消失。
5. `systemctl stop kirocrew` → 面板显示**黄色降级条**（不是"它还什么都没记住"）。
6. 非 Crew 会话（Claude/tmux）**没有**第 5 个图标。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/MemoryPanel.tsx frontend/src/App.tsx \
        frontend/src/components/SessionInfoBar.tsx \
        frontend/src/components/__tests__/crewMemoryWrite.test.tsx
git commit -m "$(cat <<'EOF'
feat(crew): 记忆面板(第 5 个 overlay view)

用 overlay 而非新框架:App.tsx 已有 OverlayView 三态 + 泛型 toggleOverlay +
三个渲染点,加一个 'memory' 是纯增量、零新导航概念,并自动继承 CSS 可见性
保留(对话状态不丢)。

MemoryPanel 不接 sessionId:记忆在 Crew 侧是全局的(一份 Gateway 一份记忆)。

空状态是本设计最重要的一屏 —— 实测记忆现在必然是空的(semantic []、
lessons []、preferences 56 字节全骨架),所以空态本身就是写入表单而不是
一块「暂无数据」。gateway_ok:false(读不到)与真的空是两种含义,前者显示
黄色降级条,混淆了用户会以为记忆被清空。

第 5 个图标是硬上限(375px 宽度核算:126+22+18+8+24≈198px,description 余
~177px),所以审批不占图标位、内联在对话里。

教训区只读:Crew 侧无 per-lesson DELETE,不给点了没反应的 ✕。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 批次 5：删除清理

### Task 11: 删除 Kiro 后端

**排在 Crew 跑通并通过 Task 6 手工验收之后** —— 不要同时改两处。

裸 Kiro 被 Crew **严格支配**：Crew 会话在底层就是 kiro-cli 会话，只是多了记忆、技能、审批。没有任何场景你会理性地选它。实证：线上仅 **1 个** kiro 会话（work_dir 是 `/home/ubuntu`，随手开的）、**0 个** kiro 定时任务；`session_manager.rs:3175/3244/3248` 注释自证 "**Kiro runs no scheduled tasks**"；`auto_titler.rs:5-9` 说 Kiro **无法**安全降为无工具 → Kiro 会话**永远拿不到自动标题**；`lib/quickTargets.ts:3` 注释原文早已预言 "某个 agent 类型日后被移除时（**如 kiro**）"。

**⚠️ `kiro-cli` 二进制不能删** —— 它是 Crew 的运行时依赖（Gateway 靠它跑）。删的是 zeromux 的 Kiro **后端路径**；`--kiro-path` 参数保留无害（Crew 不用它）。

**顺带收益**：当前 `ps` 显示 `kiro-cli acp --trust-all-tools`（zeromux 的）与 `kiro-cli acp --agent kirocrew-lite`（Crew 的）**同时在跑**，两者共享 `~/.kiro/sessions/`。删掉 Kiro 后端顺手消掉这个共享状态的并发风险。

**Files:**
- Delete: `src/acp/kiro_process.rs`（677 行，含内联测试）
- Modify: `src/acp/mod.rs`（删 `pub mod kiro_process;`）
- Modify: `src/session_manager.rs`（`SessionType::Kiro`、`ResumeToken::Kiro`、`spawn_kiro`、`create_kiro_session`、`spawn_kiro_fanout`、`kiro_path` 字段与构造参数、`ensure_running` 三处臂、`:1183` 的 `matches!`）
- Modify: `src/main.rs`（`kiro_path` 传参保留 CLI flag 但不再传给 `SessionManager`）
- Modify: `src/web.rs:663-690`（删 Kiro 臂）
- Modify: `src/auto_titler.rs`（`TitlerBackend::Kiro` 与其分派）
- Modify: `frontend/src/lib/api.ts:1`（`SessionType` 去 `'kiro'`）
- Modify: `frontend/src/components/Sidebar.tsx:72`（`SessionTypeIcon` 去 kiro 臂）、`BrandIcons.tsx`（删 `KiroIcon`）
- Modify: `frontend/src/components/QuickTargets.tsx`（`RowIcon` 去 kiro 臂）
- Modify: `frontend/src/lib/quickTargets.ts`（`AGENTS` 去 `'kiro'`）
- Modify: `frontend/src/lib/terminalInput.ts`（`AgentKey` / `LAUNCH` 去 kiro）

**Interfaces:**
- Consumes: 无
- Produces: 无（净删除）。`SessionType::from_str_lenient("kiro")` 之后回落 `Tmux`（既有约定，`:71-77` 注释原文"最保守，PTY 无 resume 副作用"）。

- [ ] **Step 1: 数据迁移（先做，一条 SQL）**

```bash
sqlite3 ~/.zeromux/zeromux.db "SELECT id, name, type, work_dir FROM sessions WHERE type='kiro';"
```

记录输出（应为 1 行）。然后：

```bash
sqlite3 ~/.zeromux/zeromux.db "UPDATE sessions SET type='crew', resume_kind=NULL, resume_value=NULL WHERE type='kiro';"
sqlite3 ~/.zeromux/zeromux.db "SELECT type, COUNT(*) FROM sessions GROUP BY type;"
```

Expected: 无 `kiro` 行。**`resume_kind`/`resume_value` 必须一并清空** —— 旧的 Kiro session/load token 对 Crew 无意义，留着会让重生时拿一个非法 slot_key 去 `GET /api/chat/slots/{它}`。

（不做迁移也不会崩 —— `from_str_lenient` 回落 Tmux。但那样那个会话会变成一个连不上 shell 的僵尸终端，不如迁移干净。）

- [ ] **Step 2: 前端测试先改（表达"kiro 已不存在"）**

`crewSessionType.test.tsx` 里已有的三条断言此时应从"顺带检查"变成"硬约束"：

```tsx
    expect(line).not.toContain("'kiro'")      // api.ts 的 SessionType
    expect(t).not.toContain('KiroIcon')        // Sidebar
    expect(coerceAgent('kiro')).toBeNull()     // quickTargets 白名单
```

后端同时补上 Task 5 挪过来的那条断言（加进 `crew_session_type_roundtrips`）：

```rust
        // Task 11 起 `"kiro"` 不再是已知类型 → 走未知值回落 Tmux（最保守，
        // PTY 无 resume 副作用）。这条在 Task 5 时不成立，故当时未写。
        assert!(matches!(SessionType::from_str_lenient("kiro"), SessionType::Tmux));
```

Run: `cd frontend && npx vitest run crewSessionType 2>&1 | tail -6`

Expected: **3 条红**（此时 kiro 还在）。这就是本任务的"先验红"。

- [ ] **Step 3: 删后端**

```bash
git rm src/acp/kiro_process.rs
```

按 Files 清单逐处删除。**四个注意点**：

1. `SessionManager::new` 的 `kiro_path` 参数（`:609/621`）删掉后，`main.rs:396-398` 的调用点要跟着改（少传一个参数）。`Args.kiro_path`（`main.rs:51`）**保留**（CLI flag 兼容，不再使用）。
2. `spawn_kiro_fanout`（`:3114-3391`，278 行）整块删。**先确认 `spawn_crew_fanout` 已经存在且工作** —— 它是照抄前者写的。
3. `auto_titler.rs` 的 `TitlerBackend::Kiro` 删除后，检查是否有 `match` 变成非穷尽（`auto_titler.rs:5-9` 那段注释也随之失效，一并删）。
4. `:1183` 的 `matches!` 去掉 `SessionType::Kiro`。

- [ ] **Step 4: 删前端**

按 Files 清单删除。`BrandIcons.tsx` 的 `KiroIcon` 整个函数删掉。

- [ ] **Step 5: 编译 + 无残留检查**

Run: `cargo check 2>&1 | tail -20` → Expected 编译通过。

Run: `grep -rn "Kiro\|kiro" src/ --include=*.rs | grep -viE "kiro-cli|kiro_path|kirocrew|crew|// |///" | head`

Expected: 无输出（除 `kiro-cli` 二进制路径、`kirocrew` 相关与注释）。

Run: `cd frontend && grep -rn "kiro" src/ --include=*.ts --include=*.tsx | grep -viE "kirocrew|crew|//" | head`

Expected: 无输出（`terminalInput.ts` 的 `LAUNCH.crew = 'kirocrew chat'` 含 "kiro" 子串但那是 kirocrew，属预期）。

- [ ] **Step 6: 全量测试**

Run: `cargo test 2>&1 | tail -3`

Expected: `399 passed`（Task 8 的 402 − kiro_process.rs 的 3 个内联测试）。**必须精确** —— 多减了说明误删。

Run: `cd frontend && npx tsc --noEmit && npx vitest run 2>&1 | tail -6`

Expected: 无类型错误；**49 文件 / 292 测试**全绿（Task 10 后不变 —— T13 里那 3 条 kiro 断言从红转绿，不新增计数）。

- [ ] **Step 7: 手工验收**

启动临时实例，确认：

1. New Session 类型菜单 4 项，**无 Kiro**。
2. 迁移过的那个会话（原 kiro）现在是 Crew 类型，能正常连上。
3. 现有 Claude / Codex / tmux 会话不受影响。

- [ ] **Step 8: Commit**

```bash
git add -A src/ frontend/src/
git commit -m "$(cat <<'EOF'
refactor: 删除 Kiro 后端(约 1045 行 + 70 处引用)

裸 Kiro 被 Crew 严格支配:Crew 会话底层就是 kiro-cli 会话,只是多了记忆、
技能、审批。没有任何场景会理性地选它。

实证:线上仅 1 个 kiro 会话、0 个 kiro 定时任务;session_manager.rs:3175
注释自证「Kiro runs no scheduled tasks」;auto_titler.rs:5-9 说 Kiro 无法
安全降为无工具 → Kiro 会话永远拿不到自动标题;quickTargets.ts:3 注释原文
早已预言「某个 agent 类型日后被移除时(如 kiro)」。

kiro-cli 二进制不删 —— 它是 Crew 的运行时依赖(Gateway 靠它跑);删的是
zeromux 的后端路径,--kiro-path flag 保留无害。

顺带收益:当前 kiro-cli acp --trust-all-tools(zeromux 的)与
kiro-cli acp --agent kirocrew-lite(Crew 的)同时在跑且共享 ~/.kiro/sessions/,
删掉后这个共享状态的并发风险一并消失。

迁移:UPDATE sessions SET type='crew', resume_kind=NULL, resume_value=NULL
WHERE type='kiro'(1 行)。resume 必须一并清空 —— 旧 Kiro token 对 Crew 无意义,
留着会让重生时拿非法 slot_key 去 GET /api/chat/slots/{它}。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---
### Task 12: 删除 session notes（后端）

notes 在生产上 3 个月零使用（实测 `notes.db` 只有 1 行，标题「帮我全选」，`2026-06-06T12:00:19Z`，此后无第二条），且其设计目标"按工作目录聚合、跨会话留住上下文"（`README_ZH.md:19`）**逐字就是** Crew `memory/projects.md` 的定义 —— 一个手动的、总共 1 条记录的版本，对一个自动沉淀的版本。用户已确认删除。

**不删 `~/.zeromux/notes.db` 与 `~/.zeromux/notes/` 目录** —— 删代码不删用户数据。

**Files:**
- Delete: `src/notes.rs`（342 行，含 3 个内联测试）
- Modify: `src/main.rs:9`（删 `mod notes;`）
- Modify: `src/main.rs:143`（删 `pub notes: notes::NotesStore,`）
- Modify: `src/main.rs:242-243`（删 `notes_store` 的构造）
- Modify: `src/main.rs:414`（删 `notes: notes_store,`）
- Modify: `src/web.rs:50-52`（删三条路由）
- Modify: `src/web.rs:902-909`（删 `// ── Notes API ──` 标题与 `CreateNoteReq`）
- Modify: `src/web.rs:923-~990`（删 `list_notes` / `create_note` / `delete_note` 三个 handler）

**Interfaces:**
- Consumes: 无
- Produces: 无（净删除）

**⚠️ 不要误删**：`src/web.rs` 里 `4146` / `4279` / `4383` / `4506` / `5176` 等处的 `notes.txt` / `notes.md` 是**路径守卫测试的夹具文件名**，与 session notes 功能无关。`src/prompts.rs:232` 的注释提到 notes.rs（"Private to notes.rs — duplicated here"），删 notes.rs 后该注释失效，**改注释不删代码**（那两个小函数是 prompts 自己的）。

- [ ] **Step 1: 先确认要删的三个 handler 的确切边界**

Run: `grep -n "async fn list_notes\|async fn create_note\|async fn delete_note" src/web.rs`

再对每个 handler 用 `sed -n 'START,+40p' src/web.rs` 找到它闭合的 `}`。**记录这三段的确切行号**再动手 —— 不要凭 grep 的行号盲删。

- [ ] **Step 2: 删除后端代码**

```bash
git rm src/notes.rs
```

然后按 Step 1 记录的行号，在 `src/main.rs` 与 `src/web.rs` 里删掉上面 Files 列出的每一处。`CreateNoteReq`（`web.rs:904-909`）要删，但紧跟其后的 `CreatePromptReq` / `UpdatePromptReq`（`911-921`）**是 prompts 的，保留**。

修 `src/prompts.rs:232` 的注释（把 "Private to notes.rs — duplicated here (two tiny fns, not worth a shared util)." 改成不引用已删文件的说法，例如 "Local helpers (two tiny fns, not worth a shared util)."）。

- [ ] **Step 3: 编译并确认无残留引用**

Run: `cargo check 2>&1 | tail -20`

Expected: 编译通过。若报 `unresolved import` 或 `no field notes`，说明还有引用没删干净——按报错位置继续删。

Run: `grep -rn "NotesStore\|notes::\|state.notes\|listNotes" src/ | grep -v "notes.txt\|notes.md"`

Expected: 无输出（`quick_targets.rs` 的 `kind='note'` 是 Obsidian vault 笔记，**不该出现在这个 grep 里**，因为它不含上面任何模式；若出现说明 grep 写错了）。

- [ ] **Step 4: 跑测试确认零回归（预期减少 3 个）**

Run: `cargo test 2>&1 | tail -3`

Expected: `396 passed`（Task 11 后的 399 − notes.rs 的 3 个内联测试）。**必须精确等于 396** —— 多减了说明误删了别的测试。

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "$(cat <<'EOF'
refactor: 删除 session notes 后端

生产上 3 个月零使用(notes.db 仅 1 行,2026-06-06 之后无新增),且其设计目标
「按工作目录聚合、跨会话留住上下文」逐字就是 Crew memory/projects.md 的定义。
用户已确认删除。

不删 ~/.zeromux/notes.db 与 notes/ 目录 —— 删代码不删用户数据。

注意:web.rs 里的 notes.txt/notes.md 是路径守卫测试的夹具名,与本功能无关,
未触碰;quick_targets 的 kind='note' 是 Obsidian vault 笔记,同样无关。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: 删除 session notes（前端）+ 审批 select 占位

删掉 notes 后，`SessionInfoBar` 的展开面板腾出空间，正好放 Task 9 的审批 select。同时消灭一个手机上摸不到的隐形按钮（`NoteItem` 的删除键用 `hovered` state，`SessionInfoBar.tsx:319`）与一整套 stale-guard（`:55-113` 那段 `reqRef` 是 2026-08-15 修的 MED 级 bug —— **删功能比维护 bug 修复划算**）。

**Files:**
- Modify: `frontend/src/components/SessionInfoBar.tsx`（删 `L3` 的三个 import、`L44-45` 的两个 state、`L55-113` 的 reqRef+loadNotes+add/delete、`L254-290` 的 Notes UI 段、`L292-329` 的 `NoteItem`、`L331-342` 的 `formatNoteDate`；文件将从 342 行降到约 200 行）
- Modify: `frontend/src/lib/api.ts`（删 `L22` 的 `NoteEntry` interface、`L276-297` 的 `listNotes`/`createNote`/`deleteNote`）

**Interfaces:**
- Consumes: 无
- Produces: `SessionInfoBar` 的 props 签名**不变**（notes 从未是 prop）。展开面板腾出的位置由 Task 9 使用。

- [ ] **Step 1: 确认 `NoteEntry` / `StickyNote` 无其他消费者**

Run: `grep -rn "NoteEntry" frontend/src/ | grep -v "api.ts\|SessionInfoBar"`

Expected: 无输出。

Run: `grep -n "StickyNote" frontend/src/components/SessionInfoBar.tsx`

记录它在 import 行里的位置 —— 删 notes UI 后这个 lucide 图标会变成未使用的 import，**必须一并删**（否则 eslint 报 `no-unused-vars`）。

- [ ] **Step 2: 删除前端 notes 代码**

按 Files 列出的行段删除。四个注意点：

1. `L3` 的 import 改为 `import { updateSession } from '../lib/api'`（保留 `updateSession`）。
2. 删 `NoteEntry` 类型的 import（它在 `SessionInfoBar.tsx` 顶部某个 `import type` 里，用 `grep -n "NoteEntry" frontend/src/components/SessionInfoBar.tsx` 定位）。
3. 删 `StickyNote` 图标 import。
4. `L55-66` 那段长注释（解释 notes 的 stale-guard 为何存在）随代码一并删除 —— 它描述的是被删掉的行为。

- [ ] **Step 3: 类型检查 + lint**

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`

Expected: 无输出（零类型错误）。

Run: `cd frontend && npm run lint 2>&1 | tail -20`

Expected: 无新增告警。若报 `'StickyNote' is defined but never used` 之类，说明 Step 2 的第 3 点漏了。

- [ ] **Step 4: 跑前端测试**

Run: `cd frontend && npx vitest run 2>&1 | tail -6`

Expected: **48 文件 / 290 测试**（Task 10 的 49/292 − 删掉的 `SessionInfoBar.notesStale.test.tsx` 整文件 2 测）。**若某个测试失败，检查它是否 mock 了 `listNotes`** —— 那样的 mock 现在指向不存在的导出。

- [ ] **Step 5: 手工验证**

```bash
cd frontend && npm run build && cd .. && cargo build
```

启动一个临时实例（不要碰生产的 8090）：

```bash
cargo run -- --port 18099 --password t --work-dir /home/ubuntu
```

浏览器开 `http://127.0.0.1:18099`，登录后开一个 tmux 会话，展开 SessionInfoBar：**Notes 区段应该完全消失**，description 编辑与 queue mode select 照常工作。Ctrl-C 结束。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/
git commit -m "$(cat <<'EOF'
refactor(frontend): 删除 session notes UI

同时消灭两处技术债:
- NoteItem 的删除按钮用 hovered state(SessionInfoBar.tsx:319),手机上
  需要 mouseenter 才出现 = 摸不到的隐形按钮
- 整套 notes stale-guard(:55-113)是 2026-08-15 修的 MED 级 stale-response
  bug —— 删功能比长期维护这个修复划算

SessionInfoBar 从 342 行降到约 200 行,展开面板腾出的位置留给审批 select。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

---

# 附录：Rust 代码

> 本附录全部代码在一个临时 crate（含仓库真实的 `AcpEvent` 与 `format.rs`）里
> `cargo test` 跑过 —— **21 passed; 0 failed**。生产代码段 0 个 `unwrap()`。

## 附录 D：`AcpEvent` 两个新变体

加在 `src/acp/process.rs` 的 `Exit` 变体（`:92-94`）**之后**、闭合 `}` 之前。

枚举已有 `#[serde(tag="type", rename_all="snake_case")]`（`:25-26`），所以变体名标签自动派生（`Approval` → `"approval"`，`ContextUsage` → `"context_usage"`），**不写** `#[serde(rename=...)]`。`Option` 字段一律加 `skip_serializing_if`（对齐 `:32/34/47/49/71/84` 的既有风格）；必填字段裸写。两个变体**都不加 `turn_id`** —— `with_turn_id` 只盖 `ContentBlock`/`Result`（`session_manager.rs:3030-3037`），加了就得同时改它，是无必要的耦合。

```rust
    /// Crew 的 PreToolUse 审批请求。走 fan-out 已独占订阅的那条 Gateway 全局 WS，
    /// 零新增连接。**这是 zeromux 相对 Crew 全部 10 个 IM 渠道的唯一结构性优势** ——
    /// 实测微信 Tappable choices = 0 且不装 approval decider，一个 44px 的「批准」
    /// 按钮 + Web Push 是它们全都做不到的事。
    ///
    /// 第一期**不发** `POST /api/chat/mode {"mode":"trust"}`：不带 `slot` 的 mode
    /// 请求会把 Gateway 上所有 slot 和所有 IM 渠道（含微信）永久设为 auto-approve
    /// 并落盘（chat_handlers.py:9016-9040），作用域与 Kiro 的 `--trust-all-tools`
    /// 差几个数量级。前端 `BlockView` 渲染成内联卡片 + 两个 `min-h-[44px]` 按钮。
    ///
    /// 字段名照 Gateway 的 payload（interaction_coordinator.py:40-48）：是
    /// `tool_purpose`/`tool_input`，不是 `purpose`/`input`。三者在 Gateway 侧
    /// **已 redact**（凭证与 exfil URL 已抹），此处不再处理。
    Approval {
        /// Gateway 侧的 approval id，回执时用（`POST /api/approvals/{id}/{action}`）。
        id: String,
        /// 待批准的工具/命令，如 `rm -rf /tmp/build`。
        tool: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_input: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_purpose: Option<String>,
        /// 来源 slot。同一浏览器可能同时开多个 Crew 会话，前端据此二次校验归属。
        slot: String,
    },
    /// 上下文用量。来自 Crew 的 `context_usage` 帧 —— zeromux **自己没有**这个能力，
    /// 是接入 Crew 白拿的新功能。`total` 恒 > 0（进程层已滤掉 0/缺失，见
    /// crew_process::normalize_frame），前端可直接做分母。
    ContextUsage {
        used: u64,
        total: u64,
    },
```

**实测线格式**（在临时 crate 里 `serde_json::to_string` 打印的，非推测）：

```json
{"type":"approval","id":"ap-1","tool":"rm","slot":"s1"}
{"type":"approval","id":"ap-1","tool":"rm","tool_purpose":"why","slot":"s1"}
{"type":"context_usage","used":1,"total":2}
```

## 附录 N：`NormState` + `normalize_frame` + bump 谓词（纯函数）

```rust
use std::borrow::Cow;
use super::process::AcpEvent;

/// 归一化的可变状态。三条不变量全部落在这里。
#[derive(Debug, Default)]
pub struct NormState {
    /// I3：本轮 `chat_chunk` 的累积文本。`chat_done` 时 `mem::take` 产出
    /// `Result.text`，**take 即清零**，所以下一轮天然从空开始。
    turn_text: String,
    /// I2：本轮已渲染过的 `tool_call_id` 集合。`chat_done` 时清空。
    seen_tool_calls: std::collections::HashSet<String>,
}

impl NormState {
    pub fn new() -> Self { Self::default() }
}

/// 把一个 Gateway WS 帧归一化成零或多个 `AcpEvent`。
///
/// **纯函数**：无 I/O、无时钟、无 channel —— 这是本模块最重要的设计约束，
/// 它让 T1-T8 能直接喂实测抓到的真实 JSON 帧，不需要 Gateway 在跑。
pub fn normalize_frame(
    frame: &serde_json::Value,
    my_slot: &str,
    st: &mut NormState,
) -> Vec<AcpEvent> {
    let Some(kind) = frame.get("type").and_then(|v| v.as_str()) else { return vec![] };

    // ── I1：slot 过滤 ──
    // 全局帧（heartbeat / slots / dashboard / refresh / mcp_report_update …）没有
    // `data.slot`，在这里就被一并丢掉，不 panic。`data` 是标量（`"data":7`）或
    // `slot` 不是字符串时 `get`/`as_str` 都返回 None，同样走这条门 —— 全函数无
    // unwrap、无索引，畸形帧不可能 panic。
    //
    // 这条必须在 `match kind` **之前**：漏了它不只是「别人的输出进我的会话」，
    // 更隐蔽的是别的 slot 的 `chat_done` 会把我的 turn_text 抽走 → 我的
    // Result.text 变空。
    let Some(data) = frame.get("data") else { return vec![] };
    if data.get("slot").and_then(|v| v.as_str()) != Some(my_slot) { return vec![] }

    match kind {
        // ── chat_chunk → 流式 text 块 + I3 累积 ──
        // `seq` 只用于诊断：按**到达序** append。若拿 seq 做去重/排序，一个非递增
        // 的序列（重连后重编号）会静默丢块 —— 无声的正文缺失，比乱序难查得多。
        "chat_chunk" => {
            let Some(content) = data.get("content").and_then(|v| v.as_str()) else { return vec![] };
            if content.is_empty() { return vec![] }
            st.turn_text.push_str(content);
            vec![AcpEvent::ContentBlock {
                block_type: Cow::Borrowed("text"),
                // 进程层不知道 turn_seq，填 0；fan-out 的 emit 在广播前用
                // with_turn_id 盖真实值（G3.2，session_manager.rs:3030-3037）。
                turn_id: 0,
                text: Some(content.to_string()),
                name: None,
                input: None,
                streaming: Some(true),
                summary: None,
            }]
        }

        // ── tool_call → tool_use 块 + I2 去重 ──
        "tool_call" => {
            let tool = data.get("tool").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
            let is_update = data.get("is_update").and_then(|v| v.as_bool()).unwrap_or(false);
            match data.get("tool_call_id").and_then(|v| v.as_str()) {
                Some(id) => {
                    // insert 返回 false ⇒ 这个 id 已渲染过（含 is_update:true 那两帧）。
                    // 实测一次调用来 3 帧，漏了去重 = UI 里渲染 3 次。
                    if !st.seen_tool_calls.insert(id.to_string()) { return vec![] }
                }
                None => {
                    // 无 id 无法去重 → is_update:true 的只能当更新丢弃，否则每帧渲染一次。
                    if is_update { return vec![] }
                }
            }
            // input_preview 是 Gateway 已序列化好的字符串；先试着解析回 JSON，
            // 解析不了就原样当字符串（前端 input 折叠区两者都能显示）。
            let input = data.get("input_preview").and_then(|v| v.as_str()).map(|s| {
                serde_json::from_str::<serde_json::Value>(s)
                    .unwrap_or_else(|_| serde_json::Value::String(s.to_string()))
            });
            // `purpose` → `summary`：Crew 比现有三后端多给一句「为什么调这个工具」，
            // 前端已渲染成 `name · summary`（AcpChatView.tsx:932-934）。缺 purpose
            // 时回落 format::format_tool_use（未知工具名返回 None）。
            let purpose = data.get("purpose").and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()).map(|s| s.to_string());
            let summary = purpose.or_else(|| super::format::format_tool_use(&tool, input.as_ref()));
            vec![AcpEvent::ContentBlock {
                block_type: Cow::Borrowed("tool_use"),
                turn_id: 0,
                text: None,
                name: Some(tool),
                input,
                streaming: None,
                summary,
            }]
        }

        // ── tool_result → tool_result 块 ──
        // 前端 BlockView 已有 `case 'tool_result'`（AcpChatView.tsx:949）。
        // **不进 turn_text**：Result.text 只该是助手正文，工具输出混进去会污染
        // 活动看板摘要（events.rs:226 的 summarize）与 auto_titler 的输入。
        "tool_result" => {
            let tool = data.get("tool").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
            let text = ["output", "result", "content", "text"].iter()
                .find_map(|k| data.get(*k).and_then(|v| v.as_str())).map(|s| s.to_string())
                .or_else(|| data.get("result").filter(|v| !v.is_null()).map(|v| v.to_string()));
            vec![AcpEvent::ContentBlock {
                block_type: Cow::Borrowed("tool_result"),
                turn_id: 0,
                text,
                name: Some(tool),
                input: None,
                streaming: None,
                summary: None,
            }]
        }

        // ── chat_status → System{subtype:"status"}（非前进信号，见下面的谓词）──
        "chat_status" => vec![AcpEvent::System {
            subtype: Cow::Borrowed("status"),
            session_id: None,
            count: None,
        }],

        // ── chat_done → Result（I3：文本来自累积）──
        // `chat_done` 实测**只带 slot，不带最终文本**。`mem::take` 同时完成两件事：
        // 产出本轮文本 + 把缓冲清零，所以第二轮不会累加第一轮。
        "chat_done" => {
            let text = std::mem::take(&mut st.turn_text);
            st.seen_tool_calls.clear();   // 同一 id 在新一轮应重新渲染
            vec![AcpEvent::Result {
                text,
                turn_id: 0,
                // session_id 填 slot_key：与 Codex 用 Result.session_id 携带 threadId
                // 同构（session_manager.rs:2191-2197）。供 resume token 回填。
                session_id: my_slot.to_string(),
                cost_usd: None,
                tokens_in: None,
                tokens_out: None,
            }]
        }

        // ── chat_error → Error（终态边界）──
        // 同时清本轮状态：失败的轮次不能把半截文本漏进下一轮的 Result
        // （kiro_process.rs:434-441 同型修复，review 2026-08-01）。
        "chat_error" => {
            let _ = std::mem::take(&mut st.turn_text);
            st.seen_tool_calls.clear();
            let msg = ["error", "message", "detail"].iter()
                .find_map(|k| data.get(*k).and_then(|v| v.as_str()))
                .unwrap_or("Crew turn failed").to_string();
            vec![AcpEvent::Error { message: format!("Crew error: {msg}") }]
        }

        // ── approval → Approval（字段名照实测：tool_purpose / tool_input）──
        "approval" => {
            // 无 id 无法回执 → 丢弃。渲染一个点了没反应的卡片比不渲染更糟。
            let Some(id) = data.get("id").and_then(|v| v.as_str()) else { return vec![] };
            let tool = data.get("tool").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
            let nonempty = |k: &str| data.get(k).and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()).map(|s| s.to_string());
            vec![AcpEvent::Approval {
                id: id.to_string(),
                tool,
                tool_input: nonempty("tool_input"),
                tool_purpose: nonempty("tool_purpose"),
                slot: my_slot.to_string(),
            }]
        }

        // ── context_usage → ContextUsage（zeromux 自己没有的能力）──
        "context_usage" => {
            let used = data.get("used").and_then(|v| v.as_u64());
            let total = data.get("total").or_else(|| data.get("limit")).and_then(|v| v.as_u64());
            match (used, total) {
                // total==0 会让前端渲染 NaN%/Infinity% —— 在进程层就滤掉。
                (Some(used), Some(total)) if total > 0 => vec![AcpEvent::ContextUsage { used, total }],
                _ => vec![],
            }
        }

        // ── 其余全部丢弃 ──
        // slots / dashboard / heartbeat / refresh / mcp_report_update / slot_title /
        // chat_segment / chat_message_update / activity_event：全局帧，或已被上面的
        // 专用帧覆盖（chat_segment / chat_message_update 是 chat_chunk 的重复表述，
        // 一起处理会让同一段正文渲染两次）。
        _ => { tracing::debug!("crew: dropped frame type {kind}"); vec![] }
    }
}

/// `emit` 的 bump 谓词对 Crew 的补充（2026-08-05 教训：不前进的信号勿刷看门狗）。
///
/// `System{subtype:"status"}` 是 Gateway 的 "Thinking…" 心跳，**不是** agent 前进
/// 信号。如果它刷新 `last_activity_ms`，一个卡死在工具调用上的轮次会靠 status 心跳
/// 把空闲看门狗永远架空 —— 与 F-CODEX-1-CLOCK 同型。
///
/// 对其余三后端**恒真**（它们的 `System` 只有 `"init"` 和 `"queued"`，见
/// kiro_process.rs:169 / codex_process.rs:412 / session_manager.rs:2897）。
pub fn crew_event_is_forward_progress(evt: &AcpEvent) -> bool {
    !matches!(evt, AcpEvent::System { subtype, .. } if subtype.as_ref() == "status")
}
```

## 附录 I：I/O 部分（secret / token / REST / WS 事件循环）

```rust
use std::process::Stdio as _Unused;  // 删掉这行——crew 不 spawn 进程（保留此注以防照抄 kiro 时误带）
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const TOKEN_TTL: &str = "20h";      // 实测：?ttl= 收 duration 字符串；ttl=300 会静默回落 20h
const REST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const CHAT_POST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3600);
const RECONNECT_INITIAL: std::time::Duration = std::time::Duration::from_secs(3);
const RECONNECT_MAX: std::time::Duration = std::time::Duration::from_secs(60);
const STABLE_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

/// Gateway 连接参数。**不含 secret / token** —— secret 每次从磁盘现读，token 每次
/// 重连现 mint，两者都只在 `run_event_loop` 的栈上活。
#[derive(Clone)]
pub struct CrewConfig {
    pub http_base: String,
    pub ws_base: String,
    pub crew_home: std::path::PathBuf,
    pub port: u16,
}

impl CrewConfig {
    pub fn new(crew_home: std::path::PathBuf, port: u16) -> Self {
        Self {
            http_base: format!("http://127.0.0.1:{port}"),
            ws_base: format!("ws://127.0.0.1:{port}/api/ws"),
            crew_home,
            port,
        }
    }
}

enum Cmd {
    Prompt(String),
    Cancel,
    Approval { approval_id: String, action: String },
    Stop,
}

/// 形状与 `CodexProcess`（codex_process.rs:375-378）逐字对齐：私有 `cmd_tx` +
/// `pub event_rx`，所以 `spawn_crew_fanout` 可以照抄 `spawn_codex_fanout`。
pub struct CrewProcess {
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
    cfg: CrewConfig,
    slot_key: String,
}

/// 读 Gateway 的 internal secret：优先 `<crew_home>/run/gateway-<port>.secret`，
/// 回落 `<crew_home>/.local_secret`（均 32 字节、0600）。
///
/// 错误信息只含**路径**，绝不含内容，也不报长度。`trim()` 是必需的：实测 secret
/// 文件带尾换行，不 trim 会让 `X-Local-Secret` 头带 `\n`，reqwest 直接拒绝构造。
/// 空白文件视为不可读并**继续回落**，而不是当成合法空 secret。
pub fn read_gateway_secret(crew_home: &std::path::Path, port: u16) -> Result<String, String> {
    let primary = crew_home.join("run").join(format!("gateway-{port}.secret"));
    let fallback = crew_home.join(".local_secret");
    for p in [&primary, &fallback] {
        if let Ok(s) = std::fs::read_to_string(p) {
            let t = s.trim();
            if !t.is_empty() { return Ok(t.to_string()); }
        }
    }
    Err(format!(
        "Kiro Crew secret 不可读：{} 与 {} 均无法读取或为空",
        primary.display(), fallback.display()
    ))
}

/// `GET /api/token/local?ttl=20h`，头 `X-Local-Secret: <secret>`。仅 loopback 可用。
pub async fn mint_ws_token(http: &reqwest::Client, base: &str, secret: &str) -> Result<String, String> {
    let resp = http.get(format!("{base}/api/token/local?ttl={TOKEN_TTL}"))
        .header("X-Local-Secret", secret)
        .timeout(REST_TIMEOUT)
        .send().await
        .map_err(|_| "Kiro Crew Gateway 未运行或 token mint 请求失败".to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Kiro Crew token mint 被拒（HTTP {}）", status.as_u16()));
    }
    let body: serde_json::Value = resp.json().await
        .map_err(|_| "Kiro Crew token mint 响应不是 JSON".to_string())?;
    body.get("token").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "Kiro Crew token mint 响应缺少 token 字段".to_string())
}

/// 统一的 REST POST：带 `X-Internal-Secret`，**只读状态码、body 立刻 drop**。
async fn post_json_ok(
    http: &reqwest::Client, base: &str, secret: &str, path: &str,
    body: serde_json::Value, timeout: std::time::Duration,
) -> Result<(), String> {
    let resp = http.post(format!("{base}{path}"))
        .header("X-Internal-Secret", secret)
        .json(&body).timeout(timeout).send().await
        .map_err(|_| format!("Gateway 请求失败：{path}"))?;
    let status = resp.status();
    drop(resp);
    if status.is_success() { Ok(()) } else { Err(format!("Gateway 拒绝 {path}（HTTP {}）", status.as_u16())) }
}

async fn create_slot(http: &reqwest::Client, base: &str, secret: &str, key: &str) -> Result<(), String> {
    post_json_ok(http, base, secret, "/api/chat/slots", serde_json::json!({ "name": key }), REST_TIMEOUT).await
}

async fn set_slot_project(http: &reqwest::Client, base: &str, secret: &str, key: &str, project: &str) -> Result<(), String> {
    post_json_ok(http, base, secret, &format!("/api/chat/slots/{key}/project"),
                 serde_json::json!({ "project": project }), REST_TIMEOUT).await
}

/// 取消当前轮次。**用 `/stop` 而非 `/interrupt`** —— 后者清的是排队，队列空时返回
/// 400 `"queue empty, use /stop instead"`（实测）。
async fn stop_turn(http: &reqwest::Client, base: &str, secret: &str, key: &str) -> Result<(), String> {
    post_json_ok(http, base, secret, &format!("/api/chat/slots/{key}/stop"),
                 serde_json::json!({}), REST_TIMEOUT).await
}

async fn resolve_approval(http: &reqwest::Client, base: &str, secret: &str, id: &str, action: &str) -> Result<(), String> {
    post_json_ok(http, base, secret, &format!("/api/approvals/{id}/{action}"),
                 serde_json::json!({}), REST_TIMEOUT).await
}

async fn delete_slot(http: &reqwest::Client, base: &str, secret: &str, key: &str) {
    let _ = http.delete(format!("{base}/api/chat/slots/{key}"))
        .header("X-Internal-Secret", secret).timeout(REST_TIMEOUT).send().await;
}

async fn slot_alive(http: &reqwest::Client, base: &str, secret: &str, key: &str) -> bool {
    match http.get(format!("{base}/api/chat/slots/{key}"))
        .header("X-Internal-Secret", secret).timeout(REST_TIMEOUT).send().await
    {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

/// **响应体整体丢弃，只读 HTTP 状态码**（load-bearing）：空闲时响应是阻塞整轮的
/// SSE，忙时是 `{"queued":true}`，而实测并发第二条 prompt 时**第二轮的输出会出现在
/// 第一条请求的 SSE 流里** —— 把它当事件源必然轮次串台。
///
/// `reqwest` 的 `send()` 在响应**头**到齐即 resolve，body 是惰性流 —— 所以
/// `drop(resp)` 就是「整体丢弃」的准确实现，不会先把整轮 SSE 拉进内存。
async fn post_prompt(http: &reqwest::Client, base: &str, secret: &str, slot_key: &str, text: &str) -> Result<(), String> {
    let resp = http.post(format!("{base}/api/chat"))
        .header("X-Internal-Secret", secret)
        .json(&serde_json::json!({ "slot": slot_key, "message": text }))
        .timeout(CHAT_POST_TIMEOUT)
        .send().await
        .map_err(|e| if e.is_timeout() {
            // 事件已从 WS 到齐；超时只是挂断那条本就要丢弃的 SSE 流，不是投递失败。
            "prompt 已投递（SSE 流超时挂断，事件走 WS）".to_string()
        } else {
            "投递 prompt 失败：Gateway 不可达".to_string()
        })?;
    let status = resp.status();
    drop(resp);
    if status.is_success() { Ok(()) } else { Err(format!("投递 prompt 被拒（HTTP {}）", status.as_u16())) }
}

/// slot 名。`zmx-` 前缀让 Gateway dashboard 一眼看出是 zeromux 建的；短 uuid 避免
/// 与用户手建的 slot 撞名。
fn new_slot_key() -> String {
    let u = uuid::Uuid::new_v4().to_string();
    format!("zmx-{}", &u[..8])
}

/// 指数退避 + 「稳定才清零」。**不 onopen 即清零**（2026-08-05 教训）：一个连上就
/// 被踢的连接（token 刚过期、Gateway 正在重启）会在 onopen 立刻把退避归零，于是
/// 每 3s 锤一次，永不升级。与前端 `AcpChatView.tsx:236-244` 的修法同构。
struct Backoff { delay: std::time::Duration }

impl Backoff {
    fn new() -> Self { Self { delay: RECONNECT_INITIAL } }
    fn next(&mut self) -> std::time::Duration {
        let d = self.delay;
        self.delay = std::cmp::min(self.delay * 2, RECONNECT_MAX);
        d
    }
    /// 只在这条连接**活过** `STABLE_AFTER` 之后才清零。做成传入「连接存活时长」
    /// 而非读时钟，所以可单测。
    fn mark_stable_if_elapsed(&mut self, connection_lived: std::time::Duration) {
        if connection_lived >= STABLE_AFTER { self.delay = RECONNECT_INITIAL; }
    }
}

enum LoopStep { Continue, Stop }

/// 退避睡眠，但仍响应 `Cmd::Stop` / 通道关闭 —— 否则删会话时要等满 60s 才收尾。
///
/// 退避期间到达的 Prompt/Cancel 会被丢掉（没有连接，也没有可靠的 slot 状态），
/// 但记一行 warn 而非静默。**不排队是刻意的** —— 排队会让「Gateway 挂了 5 分钟」
/// 变成「Gateway 恢复后突然涌进 20 条陈旧 prompt」。
async fn sleep_or_stop(dur: std::time::Duration, cmd_rx: &mut mpsc::Receiver<Cmd>) -> LoopStep {
    let deadline = tokio::time::sleep(dur);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return LoopStep::Continue,
            cmd = cmd_rx.recv() => match cmd {
                Some(Cmd::Stop) | None => return LoopStep::Stop,
                Some(_) => { tracing::warn!("crew: dropped an input received while reconnecting"); continue; }
            }
        }
    }
}

/// 串行 prompt 投递。**响应体整体丢弃**。
///
/// 存在的理由：`POST /api/chat` 空闲时**阻塞整轮**，在 `select!` 臂里 await 它会让
/// WS 读取整轮停摆 —— 帧全堆在 tungstenite 缓冲里，流式文本一个字都不出来，直到
/// 轮次结束才一次性涌出。**与 codex_process.rs:74-77 那条「回调必须 try_send，
/// await 会锁死 rmcp 的 transport reader」是同一类错误。**
async fn prompt_worker(
    http_base: String, secret: String, http: reqwest::Client,
    slot_key: String, mut rx: mpsc::Receiver<String>,
) {
    while let Some(text) = rx.recv().await {
        if let Err(e) = post_prompt(&http, &http_base, &secret, &slot_key, &text).await {
            tracing::warn!("crew send_prompt: {e}");
        }
    }
}

async fn run_event_loop(
    cfg: CrewConfig, secret: String, http: reqwest::Client, slot_key: String,
    event_tx: mpsc::Sender<AcpEvent>, mut cmd_rx: mpsc::Receiver<Cmd>,
) {
    let (prompt_tx, prompt_rx) = mpsc::channel::<String>(64);
    tokio::spawn(prompt_worker(cfg.http_base.clone(), secret.clone(), http.clone(),
                              slot_key.clone(), prompt_rx));

    let mut backoff = Backoff::new();
    let mut st = NormState::new();

    // `let exit_code = 'outer: loop {…}` 保证 Exit 恰好从一个出口发一次。
    let exit_code = 'outer: loop {
        // 每次（重）连都重新 mint token（廉价，且覆盖 token 被 revoke 的情形）。
        let token = match mint_ws_token(&http, &cfg.http_base, &secret).await {
            Ok(t) => t,
            Err(e) => {
                if event_tx.send(AcpEvent::Error { message: e }).await.is_err() { return; }
                match sleep_or_stop(backoff.next(), &mut cmd_rx).await {
                    LoopStep::Continue => continue 'outer,
                    LoopStep::Stop => break 'outer 0,
                }
            }
        };

        // WS 只认 `?token=`（实测 X-Internal-Secret → 403）。
        let url = format!("{}?token={}", cfg.ws_base, token);
        let connect = tokio_tungstenite::connect_async(url.as_str()).await;
        drop(url); drop(token);   // url 带 token —— 到此为止，绝不进 tracing 或事件
        let mut ws = match connect {
            Ok((ws, _resp)) => ws,
            Err(_) => {
                // **绝不格式化 tungstenite 的 Error**：它会回显请求 URL，而 URL 带 token。
                let msg = format!("Kiro Crew Gateway WS 连接失败（127.0.0.1:{}）", cfg.port);
                if event_tx.send(AcpEvent::Error { message: msg }).await.is_err() { return; }
                match sleep_or_stop(backoff.next(), &mut cmd_rx).await {
                    LoopStep::Continue => continue 'outer,
                    LoopStep::Stop => break 'outer 0,
                }
            }
        };

        // 重连后确认 slot 存活；已消失 → Error + Exit，会话需重建。
        if !slot_alive(&http, &cfg.http_base, &secret, &slot_key).await {
            let _ = event_tx.send(AcpEvent::Error {
                message: format!("Crew slot {slot_key} 已在 Gateway 侧消失，会话需重建"),
            }).await;
            break 'outer -1;
        }

        let connected_at = std::time::Instant::now();

        loop {
            tokio::select! {
                msg = ws.next() => {
                    match msg {
                        Some(Ok(WsMessage::Text(txt))) => {
                            let val: serde_json::Value = match serde_json::from_str(&txt) {
                                Ok(v) => v,
                                Err(e) => { tracing::debug!("crew: bad frame: {e}"); continue; }
                            };
                            for evt in normalize_frame(&val, &slot_key, &mut st) {
                                if event_tx.send(evt).await.is_err() { return; }
                            }
                        }
                        // Ping 由 tungstenite 在 read() 内部自动回 Pong。
                        Some(Ok(_)) => continue,
                        Some(Err(_)) | None => {
                            backoff.mark_stable_if_elapsed(connected_at.elapsed());
                            let _ = event_tx.send(AcpEvent::Error {
                                message: "Kiro Crew Gateway 连接中断，正在重连".to_string(),
                            }).await;
                            match sleep_or_stop(backoff.next(), &mut cmd_rx).await {
                                LoopStep::Continue => continue 'outer,
                                LoopStep::Stop => break 'outer 0,
                            }
                        }
                    }
                }
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(Cmd::Prompt(text)) => {
                            // 绝不 await 那个可能阻塞整轮的 POST。
                            if prompt_tx.send(text).await.is_err() {
                                tracing::warn!("crew: prompt worker gone; prompt dropped");
                            }
                        }
                        Some(Cmd::Cancel) => {
                            // detached：它绝不能排在一个正在阻塞的 Prompt POST 之后 ——
                            // 那个 POST 恰好要到轮次结束才返回，而 /stop 的全部意义
                            // 就是提前结束那一轮。
                            let (base, sec, cl, key) = (cfg.http_base.clone(), secret.clone(),
                                                        http.clone(), slot_key.clone());
                            tokio::spawn(async move {
                                if let Err(e) = stop_turn(&cl, &base, &sec, &key).await {
                                    tracing::warn!("crew stop: {e}");
                                }
                            });
                        }
                        Some(Cmd::Approval { approval_id, action }) => {
                            // 同理 detached。404 = 该审批已过期/已被别处回答，属正常。
                            let (base, sec, cl) = (cfg.http_base.clone(), secret.clone(), http.clone());
                            tokio::spawn(async move {
                                if let Err(e) = resolve_approval(&cl, &base, &sec, &approval_id, &action).await {
                                    tracing::warn!("crew approval: {e}");
                                }
                            });
                        }
                        Some(Cmd::Stop) | None => { let _ = ws.close(None).await; break 'outer 0; }
                    }
                }
            }
        }
    };

    // 终态边界（与 kiro_process.rs:373-389 的 Stop 臂同理）：没有它，fan-out 的
    // `if is_boundary` 块不触发，一个被 watchdog-Timeout 或 Cancel 的轮次不记
    // run metric —— 它在 turn_starts FIFO 里的 (start, intent) 会被搁死，与
    // Claude/Codex 的行为分叉。每条退出路径都恰好经过这里一次。
    let _ = event_tx.send(AcpEvent::Exit { code: exit_code }).await;
}

impl CrewProcess {
    pub async fn spawn(cfg: CrewConfig, work_dir: &str, resume: Option<&str>)
        -> Result<Self, Box<dyn std::error::Error + Send + Sync>>
    {
        let secret = read_gateway_secret(&cfg.crew_home, cfg.port)?;   // fail fast
        let http = reqwest::Client::builder()
            // Gateway 在 loopback，任何重定向都是异常；照 push.rs 的 SSRF 硬化惯例
            // 直接禁掉，免得带 secret 的头被跟到别的 host 去。
            .redirect(reqwest::redirect::Policy::none())
            .build().map_err(|e| format!("build crew http client: {e}"))?;

        let slot_key = match resume {
            Some(k) => {
                if !slot_alive(&http, &cfg.http_base, &secret, k).await {
                    return Err(format!("Crew slot 已不存在（{k}），需重建会话").into());
                }
                k.to_string()
            }
            None => {
                let k = new_slot_key();
                create_slot(&http, &cfg.http_base, &secret, &k).await?;
                k
            }
        };

        // project 就是 agent 的真实 cwd（实测 agent `pwd` 与设定值逐字相同）。
        // work_dir=="." 解析成绝对路径 —— Gateway 逐字传给 ACP session/new 的 cwd，
        // 相对路径无意义（照 kiro_process.rs:134-138）。
        let project = if work_dir == "." {
            std::env::current_dir()?.to_string_lossy().to_string()
        } else {
            work_dir.to_string()
        };
        if let Err(e) = set_slot_project(&http, &cfg.http_base, &secret, &slot_key, &project).await {
            if resume.is_none() {
                // 建了 slot 但设 project 失败 → 清掉，别留孤儿
                delete_slot(&http, &cfg.http_base, &secret, &slot_key).await;
            }
            return Err(e.into());
        }

        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(256);   // 与 kiro:164 / codex:407 同容量
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(16);

        // 与 Kiro（kiro_process.rs:167-173）/ Codex（codex_process.rs:409-416）一致：
        // 开局一条 System{init}。session_id 填 slot_key，让 fan-out 的 resume 回填拿到它。
        let _ = event_tx.send(AcpEvent::System {
            subtype: Cow::Borrowed("init"),
            session_id: Some(slot_key.clone()),
            count: None,
        }).await;

        tokio::spawn(run_event_loop(cfg.clone(), secret, http, slot_key.clone(), event_tx, cmd_rx));
        Ok(Self { cmd_tx, event_rx, cfg, slot_key })
    }

    pub fn slot_key(&self) -> &str { &self.slot_key }

    pub async fn send_prompt(&mut self, text: &str) -> Result<(), std::io::Error> {
        self.cmd_tx.send(Cmd::Prompt(text.to_string())).await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "crew loop gone"))
    }

    /// 取消当前轮次（映射到 `/stop`）。
    pub async fn interrupt(&mut self) -> Result<(), std::io::Error> {
        self.cmd_tx.send(Cmd::Cancel).await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "crew loop gone"))
    }

    pub async fn resolve_approval(&mut self, approval_id: &str, action: &str) -> Result<(), std::io::Error> {
        self.cmd_tx.send(Cmd::Approval {
            approval_id: approval_id.to_string(), action: action.to_string(),
        }).await.map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "crew loop gone"))
    }

    pub async fn kill(&mut self) { let _ = self.cmd_tx.send(Cmd::Stop).await; }
}

impl Drop for CrewProcess {
    fn drop(&mut self) {
        // 照 CodexProcess::drop（codex_process.rs:471-481）：try_send 而非 spawn，
        // 运行时关停时 spawn 的任务可能永不执行，把 cmd_tx clone 钉死在未完成的
        // future 里，循环就永远卡在 recv()。
        let _ = self.cmd_tx.try_send(Cmd::Stop);

        // 清远端 slot。必须 spawn（Drop 不能 await），但 secret 在 **Drop 的同步栈上**
        // 现读、再 move 进那个 future —— 不缓存在 self 里，也**不在 async 任务里做
        // 阻塞 fs 读**（生产是 JuiceFS/S3，会阻塞一个 tokio worker）。
        //
        // 已知有界泄漏：运行时正在关停、spawn 的任务没跑起来时，slot 会留在 Gateway
        // 上，下次 GET /api/chat/slots 可见。这比把 secret 常驻结构体安全，也比在
        // Drop 里 block_on 安全（会死锁 current-thread runtime）。
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        let Ok(secret) = read_gateway_secret(&self.cfg.crew_home, self.cfg.port) else { return };
        let Ok(http) = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none()).build() else { return };
        let base = self.cfg.http_base.clone();
        let slot_key = self.slot_key.clone();
        handle.spawn(async move { delete_slot(&http, &base, &secret, &slot_key).await; });
    }
}
```

**注意第一行那个 `use std::process::Stdio as _Unused;` 是提示，实现时删掉** —— Crew 不 spawn 进程，照抄 `kiro_process.rs` 时容易误带这个 import。


## 附录 T：`crew_process.rs` 的 11 个单元测试

放在 `src/acp/crew_process.rs` 末尾。**全部在临时 crate 里实跑通过（21 passed 含 format 回归）。**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 实测抓到的 tool_call 三帧序列（真实 payload）。
    fn tool_call_frames(slot: &str) -> Vec<serde_json::Value> {
        vec![
            json!({"type":"tool_call","data":{"slot":slot,"tool":"echo TOOLTEST && date -u",
                "kind":"execute","is_shell":true,"tool_call_id":"toolu_bdrk_01QWSR",
                "purpose":"Run the exact command the user requested.",
                "input_preview":"{\"command\":\"echo TOOLTEST && date -u\"}"}}),
            json!({"type":"tool_call","data":{"slot":slot,"tool":"echo TOOLTEST && date -u",
                "tool_call_id":"toolu_bdrk_01QWSR","is_update":true}}),
            json!({"type":"tool_call","data":{"slot":slot,"tool":"echo TOOLTEST && date -u",
                "tool_call_id":"toolu_bdrk_01QWSR","is_update":true,"status":"completed"}}),
        ]
    }
    fn chunk(slot: &str, content: &str, seq: u64) -> serde_json::Value {
        json!({"type":"chat_chunk","data":{"slot":slot,"content":content,"seq":seq}})
    }
    fn done(slot: &str) -> serde_json::Value {
        json!({"type":"chat_done","data":{"slot":slot}})
    }
    fn run(frames: &[serde_json::Value], my_slot: &str, st: &mut NormState) -> Vec<AcpEvent> {
        frames.iter().flat_map(|f| normalize_frame(f, my_slot, st)).collect()
    }

    // ── T1 · I1 slot 过滤 ──
    #[test]
    fn t1_only_my_slots_frames_are_emitted() {
        // WS 是全局广播、无 per-slot 订阅，所以客户端过滤是唯一手段。
        // 漏了它 = 会话 A 的输出出现在会话 B 里（跨会话串台）。
        let mut st = NormState::new();
        let frames = vec![
            chunk("s1", "MINE-a", 1),
            chunk("s2", "THEIRS-a", 1),
            json!({"type":"tool_call","data":{"slot":"s2","tool":"rm -rf /","tool_call_id":"other"}}),
            chunk("s1", "MINE-b", 2),
            done("s2"),
        ];
        let evts = run(&frames, "s1", &mut st);
        assert_eq!(evts.len(), 2, "只有本 slot 的两个 chunk 该产出：{evts:?}");
        for e in &evts {
            match e {
                AcpEvent::ContentBlock { text: Some(t), .. } =>
                    assert!(t.starts_with("MINE"), "别的 slot 的文本泄漏了：{t}"),
                other => panic!("expected text ContentBlock, got {other:?}"),
            }
        }
        // 别的 slot 的 chat_done 绝不能把我的累积缓冲抽走（否则我的 Result 变空）。
        let mine = run(&[done("s1")], "s1", &mut st);
        match &mine[0] {
            AcpEvent::Result { text, .. } => assert_eq!(text, "MINE-aMINE-b"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T2 · 全局帧丢弃且不 panic ──
    #[test]
    fn t2_global_frames_without_slot_are_dropped_without_panicking() {
        let mut st = NormState::new();
        let globals = vec![
            json!({"type":"heartbeat"}),
            json!({"type":"heartbeat","data":{}}),
            json!({"type":"slots","data":[{"name":"s1"},{"name":"s2"}]}),
            json!({"type":"dashboard","data":{"uptime":123}}),
            json!({"type":"refresh"}),
            json!({"type":"mcp_report_update","data":{"servers":[]}}),
            json!({"type":"slot_title","data":{"title":"x"}}),
            json!({"type":"chat_segment","data":{"slot":"s1","text":"dup"}}),
            json!({"type":"chat_message_update","data":{"slot":"s1"}}),
            json!({"type":"activity_event","data":{"kind":"tick"}}),
            // 畸形帧：无 type / data 是标量 / data.slot 不是字符串。
            json!({"data":{"slot":"s1"}}),
            json!({"type":"chat_chunk","data":7}),
            json!({"type":"chat_chunk","data":{"slot":42,"content":"x"}}),
            json!(null),
        ];
        let evts = run(&globals, "s1", &mut st);
        assert!(evts.is_empty(), "全局帧/畸形帧必须全部丢弃，却产出了 {evts:?}");
        // 更强的断言：它们也不能污染累积缓冲。chat_segment / chat_message_update
        // 带着本 slot 的 slot 字段（是 chat_chunk 的重复表述），若被当正文处理，
        // Result.text 会把同一段文本渲染两次。
        let r = run(&[chunk("s1", "only", 1), done("s1")], "s1", &mut st);
        match r.last().unwrap() {
            AcpEvent::Result { text, .. } => assert_eq!(text, "only"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T3 · I2 tool_call 去重 ──
    #[test]
    fn t3_repeated_tool_call_id_renders_once() {
        let mut st = NormState::new();
        let evts = run(&tool_call_frames("s1"), "s1", &mut st);
        assert_eq!(evts.len(), 1, "同一 tool_call_id 只该产 1 个块：{evts:?}");
        match &evts[0] {
            AcpEvent::ContentBlock { block_type, name, summary, input, .. } => {
                assert_eq!(block_type.as_ref(), "tool_use");
                assert_eq!(name.as_deref(), Some("echo TOOLTEST && date -u"));
                // purpose → summary（Crew 比现有后端多给的一句）。
                assert_eq!(summary.as_deref(), Some("Run the exact command the user requested."));
                // input_preview 是字符串化的 JSON，解析回结构以便前端折叠区显示。
                assert_eq!(
                    input.as_ref().and_then(|v| v.get("command")).and_then(|v| v.as_str()),
                    Some("echo TOOLTEST && date -u")
                );
            }
            other => panic!("expected tool_use ContentBlock, got {other:?}"),
        }
        // 新一轮里同一个 id 应重新渲染（chat_done 清了去重集）。
        let _ = run(&[done("s1")], "s1", &mut st);
        let again = run(&tool_call_frames("s1"), "s1", &mut st);
        assert_eq!(again.len(), 1, "新一轮同 id 应重新渲染一次：{again:?}");
    }

    // ── T4 · I3 Result 累积 ──
    #[test]
    fn t4_result_text_is_accumulated_from_chunks() {
        // chat_done 实测只带 slot、**不带最终文本**。漏了累积 → Result.text 为空
        // → 活动看板摘要空白、auto_titler 无输入、log_result_event 不可用
        // （与 2026-07-17「Claude is_error result 空白」同型）。
        let mut st = NormState::new();
        let evts = run(&[chunk("s1", "a", 1), chunk("s1", "b", 2), done("s1")], "s1", &mut st);
        assert_eq!(evts.len(), 3, "{evts:?}");   // 2 个流式块 + 1 个 Result
        match &evts[2] {
            AcpEvent::Result { text, session_id, turn_id, .. } => {
                assert_eq!(text, "ab", "Result.text 必须由 chunk 累积而成");
                assert_eq!(session_id, "s1");   // 供 resume token 回填
                assert_eq!(*turn_id, 0);        // 进程层填 0；fan-out 用 with_turn_id 盖
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T5 · I3 跨轮缓冲清零 ──
    #[test]
    fn t5_turn_buffer_is_cleared_between_turns() {
        let mut st = NormState::new();
        let _ = run(&[chunk("s1", "a", 1), chunk("s1", "b", 2), done("s1")], "s1", &mut st);
        let second = run(&[chunk("s1", "c", 1), done("s1")], "s1", &mut st);
        match second.last().unwrap() {
            AcpEvent::Result { text, .. } => assert_eq!(text, "c", "第二轮必须是 \"c\"，不是 \"abc\""),
            other => panic!("expected Result, got {other:?}"),
        }
        // chat_error 同样要清（失败轮次的半截文本不能漏进下一轮，
        // 与 kiro_process.rs:434-441 同型修复）。
        let _ = run(&[chunk("s1", "half", 1),
                      json!({"type":"chat_error","data":{"slot":"s1","error":"boom"}})],
                    "s1", &mut st);
        let third = run(&[chunk("s1", "fresh", 1), done("s1")], "s1", &mut st);
        match third.last().unwrap() {
            AcpEvent::Result { text, .. } =>
                assert_eq!(text, "fresh", "失败轮次的 \"half\" 不得漏进下一轮"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T6 · chunk seq 乱序不丢块 ──
    #[test]
    fn t6_out_of_order_seq_appends_in_arrival_order_and_drops_nothing() {
        // `seq` 只是诊断字段，不是重组依据：按**到达序** append。若拿 seq 做
        // 去重/排序，一个非递增（重连后重编号）的序列会静默丢块 —— 那是无声的
        // 正文缺失，比乱序难查得多。
        let mut st = NormState::new();
        let frames = vec![
            chunk("s1", "one", 3),
            chunk("s1", "two", 1),
            chunk("s1", "three", 1),   // 重复 seq
            chunk("s1", "four", 0),    // 回退
            done("s1"),
        ];
        let evts = run(&frames, "s1", &mut st);
        assert_eq!(evts.len(), 5, "4 个 chunk 块 + 1 个 Result，一块都不许丢：{evts:?}");
        match evts.last().unwrap() {
            AcpEvent::Result { text, .. } =>
                assert_eq!(text, "onetwothreefour", "必须按到达序拼接"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T7 · chat_error → Error ──
    #[test]
    fn t7_chat_error_maps_to_terminal_error() {
        let mut st = NormState::new();
        let evts = run(&[json!({"type":"chat_error","data":{"slot":"s1","error":"model unavailable"}})],
                       "s1", &mut st);
        assert_eq!(evts.len(), 1);
        match &evts[0] {
            AcpEvent::Error { message } => assert!(message.contains("model unavailable"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
        // 字段名回落：error / message / detail 任一。
        for key in ["message", "detail"] {
            let f = json!({"type":"chat_error","data":{"slot":"s1", key:"kaboom"}});
            match &normalize_frame(&f, "s1", &mut st)[0] {
                AcpEvent::Error { message } => assert!(message.contains("kaboom"), "{message}"),
                other => panic!("expected Error, got {other:?}"),
            }
        }
        // 一个字段都没有也必须产出 Error（否则轮次永不结束、前端永远 busy）。
        let bare = json!({"type":"chat_error","data":{"slot":"s1"}});
        assert!(matches!(normalize_frame(&bare, "s1", &mut st)[0], AcpEvent::Error { .. }));
        // 别的 slot 的 chat_error 不许终结我的轮次（I1 与终态的交叉）。
        let theirs = json!({"type":"chat_error","data":{"slot":"s2","error":"not mine"}});
        assert!(normalize_frame(&theirs, "s1", &mut st).is_empty());
    }

    // ── T8 · chat_status 不刷看门狗 ──
    #[test]
    fn t8_chat_status_does_not_bump_the_silence_clock() {
        // 2026-08-05 教训：不前进的信号勿刷看门狗。Gateway 的 "Thinking…" 是心跳，
        // 一个卡死在工具调用上的轮次靠它就能把空闲看门狗永远架空
        // （F-CODEX-1-CLOCK 同型）。
        let mut st = NormState::new();
        let evts = run(&[json!({"type":"chat_status","data":{"slot":"s1","status":"Thinking…"}})],
                       "s1", &mut st);
        assert_eq!(evts.len(), 1);
        match &evts[0] {
            AcpEvent::System { subtype, .. } => assert_eq!(subtype.as_ref(), "status"),
            other => panic!("expected System, got {other:?}"),
        }
        assert!(!crew_event_is_forward_progress(&evts[0]),
            "chat_status 必须不算前进信号，否则它会刷新 last_activity_ms");
        // 真正的前进信号必须仍然算。
        let text_block = AcpEvent::ContentBlock {
            block_type: Cow::Borrowed("text"), turn_id: 0,
            text: Some("real output".into()), name: None, input: None,
            streaming: Some(true), summary: None,
        };
        assert!(crew_event_is_forward_progress(&text_block));
        assert!(crew_event_is_forward_progress(&AcpEvent::Result {
            text: "done".into(), turn_id: 0, session_id: "s1".into(),
            cost_usd: None, tokens_in: None, tokens_out: None,
        }));
        // init 那条 System 是真事件（携带 slot_key 供 resume 回填），不受影响。
        assert!(crew_event_is_forward_progress(&AcpEvent::System {
            subtype: Cow::Borrowed("init"),
            session_id: Some("s1".into()), count: None,
        }));
    }

    // ── T-extra-1 · 退避不 onopen 即清零 ──
    #[test]
    fn backoff_only_resets_after_a_connection_proves_stable() {
        let mut b = Backoff::new();
        assert_eq!(b.next(), std::time::Duration::from_secs(3));
        assert_eq!(b.next(), std::time::Duration::from_secs(6));
        // 短命连接（1s）不许清零 —— 退避必须继续升级。
        b.mark_stable_if_elapsed(std::time::Duration::from_secs(1));
        assert_eq!(b.next(), std::time::Duration::from_secs(12));
        b.mark_stable_if_elapsed(STABLE_AFTER);       // 活过 STABLE_AFTER 才清零
        assert_eq!(b.next(), std::time::Duration::from_secs(3));
        let mut c = Backoff::new();
        for _ in 0..12 { c.next(); }
        assert_eq!(c.next(), RECONNECT_MAX);          // 上限封顶
    }

    // ── T-extra-2 · context_usage / approval 映射 ──
    #[test]
    fn context_usage_and_approval_map_to_the_new_variants() {
        let mut st = NormState::new();
        let cu = json!({"type":"context_usage","data":{"slot":"s1","used":12000,"total":200000}});
        match &normalize_frame(&cu, "s1", &mut st)[0] {
            AcpEvent::ContextUsage { used, total } => assert_eq!((*used, *total), (12000, 200000)),
            other => panic!("expected ContextUsage, got {other:?}"),
        }
        // total 缺失或为 0 → 丢弃（前端会拿它做分母）。
        for bad in [json!({"type":"context_usage","data":{"slot":"s1","used":1}}),
                    json!({"type":"context_usage","data":{"slot":"s1","used":1,"total":0}})] {
            assert!(normalize_frame(&bad, "s1", &mut st).is_empty());
        }
        // 字段名照 Gateway 实测：tool_purpose / tool_input（不是 purpose / input）。
        let ap = json!({"type":"approval","data":{"slot":"s1","id":"ap-1","source":"dashboard",
            "tool":"rm -rf /tmp/build","tool_input":"{\"cmd\":\"rm -rf /tmp/build\"}",
            "tool_purpose":"Clean the build dir.","ts":1.0}});
        match &normalize_frame(&ap, "s1", &mut st)[0] {
            AcpEvent::Approval { id, tool, tool_purpose, tool_input, slot } => {
                assert_eq!(id, "ap-1");
                assert_eq!(tool, "rm -rf /tmp/build");
                assert_eq!(tool_purpose.as_deref(), Some("Clean the build dir."));
                assert!(tool_input.is_some());
                assert_eq!(slot, "s1");
            }
            other => panic!("expected Approval, got {other:?}"),
        }
        // 无 id 无法回执 → 丢弃（渲染一个点不动的卡片比不渲染更糟）。
        let no_id = json!({"type":"approval","data":{"slot":"s1","tool":"x"}});
        assert!(normalize_frame(&no_id, "s1", &mut st).is_empty());
        // 别的 slot 的 approval 不属于我（I1 对 approval 同样适用）。
        let theirs = json!({"type":"approval","data":{"slot":"s2","id":"ap-2","tool":"x"}});
        assert!(normalize_frame(&theirs, "s1", &mut st).is_empty());
    }

    // ── T-extra-3 · secret 读取的回落与错误卫生 ──
    #[test]
    fn secret_falls_back_and_errors_never_echo_content() {
        let dir = std::env::temp_dir().join(format!("crewtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("run")).unwrap();
        std::fs::write(dir.join(".local_secret"), "FALLBACKSECRET\n").unwrap();
        assert_eq!(read_gateway_secret(&dir, 5476).unwrap(), "FALLBACKSECRET");
        std::fs::write(dir.join("run").join("gateway-5476.secret"), "PRIMARYSECRET\n").unwrap();
        assert_eq!(read_gateway_secret(&dir, 5476).unwrap(), "PRIMARYSECRET");  // 首选优先，trim 尾换行
        std::fs::write(dir.join("run").join("gateway-5476.secret"), "   \n").unwrap();
        assert_eq!(read_gateway_secret(&dir, 5476).unwrap(), "FALLBACKSECRET"); // 空文件继续回落
        std::fs::remove_file(dir.join("run").join("gateway-5476.secret")).unwrap();
        std::fs::remove_file(dir.join(".local_secret")).unwrap();
        let err = read_gateway_secret(&dir, 5476).unwrap_err();
        assert!(err.contains("gateway-5476.secret") && err.contains(".local_secret"));
        assert!(!err.contains("SECRET"), "错误信息绝不能回显 secret 内容：{err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

---

# 附录：前端代码

> 本附录代码在仓库外的镜像副本上跑过 `npx tsc -b`（全绿）、`npx vitest run`（全绿）、
> `npx eslint src`（与 baseline 逐 (文件,规则) diff 后净增量为零）。三个新测试
> **逐条做过退化验红**。**已按「砍掉 `auto_read` 档」的决定调整**（见 spec 附录 A.1.3）。

## 附录 W：`frontend/src/test/fakeWs.ts`

`AcpChatView` 一挂载就 `new WebSocket(...)`，happy-dom 不提供构造器 —— **任何 mount 该组件的测试都需要它**。它同时是驱动 `handleEvent` 的唯一入口。

```ts
// 最小 WebSocket 替身。AcpChatView 一挂载就 `new WebSocket(...)`，happy-dom 不提供
// 构造器，所以任何 mount 该组件的测试都必须先装这个。它同时是测试驱动 handleEvent
// 的唯一入口：拿到实例后调 `emit({...})` 就等于服务端推了一帧。
export interface FakeSocket {
  readyState: number
  sent: string[]
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((e: { data: string }) => void) | null
  /** 推一帧到组件（等价于服务端 broadcast）。 */
  emit(evt: unknown): void
}

/** 装上替身，返回「取最近一个实例」的句柄。调用方在 afterEach 里 restore。 */
export function installFakeWebSocket(): { latest: () => FakeSocket; all: FakeSocket[] } {
  const all: FakeSocket[] = []
  class Fake implements FakeSocket {
    static OPEN = 1
    readyState = 1              // OPEN：sendPrompt / interrupt / approval 的守卫要求
    sent: string[] = []
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    // `public url` 参数属性在 erasableSyntaxOnly 下不允许（tsconfig.app.json:26）——
    // 写成 `constructor(public url: string)` 会 TS1294 编译失败（实测撞到）。
    url: string
    constructor(url: string) { this.url = url; all.push(this) }
    send(data: string) { this.sent.push(data) }
    close() { this.readyState = 3 }
    emit(evt: unknown) { this.onmessage?.({ data: JSON.stringify(evt) }) }
  }
  // WebSocket.OPEN 是组件里 readyState 比较的来源，必须一并提供。
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = Fake
  return { latest: () => all[all.length - 1], all }
}
```

## 附录 E1-A：`CrewIcon`（`BrandIcons.tsx` 末尾）

**不复用 `KiroIcon`**（紫色幽灵 `#9046FF`）：历史 kiro 会话在 Task 11 删除前仍在会话列表里（`Sidebar.tsx:412`），同图标无法区分。同色系 + 记忆环。

```tsx
/** Kiro Crew — the Kiro ghost inside a "memory ring". Same purple family
 *  (#9046FF) so it reads as a Kiro-lineage backend, but the ring makes it
 *  distinguishable at 14px from KiroIcon — historical `kiro` sessions still
 *  exist in the session list until Task 11 removes them, so the two marks
 *  must not collide. */
export function CrewIcon({ size = 14, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <title>Kiro Crew</title>
      {/* memory ring: dashed orbit = persisted knowledge around the agent */}
      <circle cx="12" cy="12" r="11" stroke="#9046FF" strokeWidth="1.6" strokeDasharray="3.2 2.4" />
      {/* ghost body, same silhouette family as KiroIcon but solid-purple */}
      <path
        fill="#9046FF"
        d="M12 4.2c-3.02 0-5.2 2.2-5.2 5.32v6.9c0 .62.72.95 1.19.55l1.06-.9a.79.79 0 011.03.01l.87.75a.79.79 0 001.03 0l.87-.75a.79.79 0 011.03 0l.87.75a.79.79 0 001.03 0l.87-.75a.79.79 0 011.03.01l1.06.9c.47.4 1.19.07 1.19-.55v-6.9C17.2 6.4 15.02 4.2 12 4.2z"
      />
      {/* eyes punched out so the mark stays legible on both themes */}
      <circle cx="10.1" cy="9.6" r="1.05" fill="#fff" />
      <circle cx="13.9" cy="9.6" r="1.05" fill="#fff" />
    </svg>
  )
}
```

`<title>Kiro Crew</title>` 是 T13 唯一稳定的可断言标识（SVG path 会变），**不要删**。

## 附录 E1-B：菜单项与八处映射

```tsx
// Sidebar.tsx:581-590 整块替换（原 Kiro 项）
                  {/* 原位替换。仍是 4 项、不重排顺序 —— 现有顺序已是肌肉记忆，
                      为一个 10% 路径（QuickTargets 才是日常入口）重排全表不值得。
                      副标题是唯一能解释「它和 Claude 有何不同」的位置。 */}
                  <button
                    onClick={() => selectType('crew')}
                    className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <CrewIcon size={14} className="shrink-0" />
                    <div className="text-left">
                      <div className="font-medium">Kiro Crew</div>
                      <div className="text-[10px] text-[var(--text-secondary)]">有记忆的 AI agent</div>
                    </div>
                  </button>

// Sidebar.tsx:15 —— import
import { ClaudeCodeIcon, CrewIcon, CodexIcon } from './BrandIcons'

// Sidebar.tsx:72 —— SessionTypeIcon（第 2 处）
    case 'crew':   return <CrewIcon size={size} className={className} />

// api.ts:1（第 1 处）
export type SessionType = 'tmux' | 'claude' | 'crew' | 'codex'

// QuickTargets.tsx:7 + :15（第 3 处）
import { ClaudeCodeIcon, CrewIcon, CodexIcon } from './BrandIcons'
    case 'crew':   return <CrewIcon size={size} className="shrink-0" />

// AcpChatView.tsx:57（第 4 处）
  agentType?: 'claude' | 'crew' | 'codex'

// AcpChatView.tsx:682 / :791 两处文案
agentName={agentType === 'crew' ? 'Crew' : agentType === 'codex' ? 'Codex' : 'Claude'}
placeholder={`Send a message to ${agentType === 'crew' ? 'Crew' : agentType === 'codex' ? 'Codex' : 'Claude'}...`}

// lib/quickTargets.ts:6（第 6 处 —— spec 漏列，漏了 crew 快速入口行会被判脏值）
const AGENTS: readonly SessionType[] = ['tmux', 'claude', 'crew', 'codex']

// lib/terminalInput.ts:81,83-87（第 7 处 —— MobileKeyBar 的键实际由此定义）
export type AgentKey = 'claude' | 'codex' | 'crew'

const LAUNCH: Record<AgentKey, string> = {
  claude: 'claude',
  codex: 'codex',
  // Crew 的交互 CLI 入口。`kirocrew chat` 连本机 gateway(:5476)，与 Crew 会话
  // 后端同源。（已实测存在于 `kirocrew --help` 的 "Work with the agent" 段。）
  crew: 'kirocrew chat',
}

// MobileKeyBar.tsx:21（第 5 处）
  { key: 'crew', label: 'crew' },

// TerminalView.tsx:128（第 8 处 —— 漏了虚拟键盘 crew 键点了没反应）
    if (key === 'claude' || key === 'codex' || key === 'crew') {

// AgentDashboard.tsx:31（顺手，否则活动看板 crew 标签是灰底）
  'crew': 'bg-purple-500/20 text-purple-300',
```

## 附录 E1-C：T13 测试 `crewSessionType.test.tsx`

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import QuickTargets from '../QuickTargets'
import MobileKeyBar from '../MobileKeyBar'
import AcpChatView from '../AcpChatView'
import * as api from '../../lib/api'
import { coerceAgent } from '../../lib/quickTargets'
import { launchSequence } from '../../lib/terminalInput'
import type { QuickTarget } from '../../lib/api'
import { installFakeWebSocket } from '../../test/fakeWs'

// T13:每加/换一个 SessionType，八处映射都必须跟着改。历史上漏一处的表现是
// 「会话能建但列表里图标是终端」或「composer 说 Send a message to Claude」——
// 都不报错，只是静默错。因此逐处断言，而不是只断言类型定义。
//
// 八处（文件:行号，改动前）：
//   1. api.ts:1                 SessionType 联合类型
//   2. Sidebar.tsx:69-77        SessionTypeIcon
//   3. QuickTargets.tsx:11-20   RowIcon
//   4. AcpChatView.tsx:57       agentType
//   5. MobileKeyBar.tsx:18-22   AGENT_KEYS
//   6. lib/quickTargets.ts:6    AGENTS 白名单（spec 漏列）
//   7. lib/terminalInput.ts:81  AgentKey / LAUNCH（spec 漏列）
//   8. TerminalView.tsx:128     虚拟键盘分派（spec 漏列）
describe('T13 crew 八处类型映射不漏', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  beforeEach(() => { vi.restoreAllMocks(); installFakeWebSocket() })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const src = (rel: string) => readFileSync(resolve(__dirname, '../../', rel), 'utf8')

  it('① api.ts 的 SessionType 含 crew 且不再含 kiro', () => {
    const t = src('lib/api.ts')
    const line = t.split('\n').find(l => l.startsWith('export type SessionType'))!
    expect(line).toContain("'crew'")
    // Task 11 之后这条才该绿；Task 6 时它是本任务的「先验红」之一。
    expect(line).not.toContain("'kiro'")
    // 白名单（QuickTargets 用它把库里的脏字符串收敛）必须同步，否则历史 kiro 行
    // 与新 crew 行都会掉进「未知类型」分支。
    expect(coerceAgent('crew')).toBe('crew')
    expect(coerceAgent('kiro')).toBeNull()
  })

  it('② Sidebar 的 SessionTypeIcon 有 crew 分支，类型菜单仍是 4 项', () => {
    const t = src('components/Sidebar.tsx')
    expect(t).toMatch(/case 'crew':\s*return <CrewIcon/)
    expect(t).toContain('Kiro Crew')
    expect(t).toContain("selectType('crew')")
    expect(t).not.toContain("selectType('kiro')")
    expect(t.match(/selectType\('(tmux|claude|crew|codex)'\)/g)?.length).toBe(4)
  })

  it('③ QuickTargets 的 RowIcon 用 CrewIcon 渲染 crew 行', async () => {
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({
      top: [{ kind: 'dir', path: '/w/a', agent: 'crew', display: 'a', hint: '~' } as QuickTarget],
    })
    render(<QuickTargets kind="dir" onPick={() => {}} />)
    await screen.findByText('a')
    // CrewIcon 的 <title> 是它唯一稳定的可断言标识（SVG path 会变）。
    expect(screen.getByTitle('Kiro Crew')).toBeInTheDocument()
  })

  it('③b crew 行点一下直接带 crew 类型创建，不掉进 onChangeAgent（第 6 处映射）', async () => {
    // 这条覆盖 AGENTS 白名单 —— 唯一一处漏了会让「日常 90% 路径」直接坏掉的地方：
    // crew 行被判为脏值 → 走 onChangeAgent → 用户每次都得重选类型。
    vi.spyOn(api, 'listQuickTargets').mockResolvedValue({
      top: [{ kind: 'dir', path: '/w/a', agent: 'crew', display: 'a', hint: '~' } as QuickTarget],
    })
    const onPick = vi.fn()
    const onChangeAgent = vi.fn()
    render(<QuickTargets kind="dir" onPick={onPick} onChangeAgent={onChangeAgent} />)
    ;(await screen.findByText('a')).click()
    expect(onPick).toHaveBeenCalledWith('/w/a', 'crew')
    expect(onChangeAgent).not.toHaveBeenCalled()
  })

  it('④ AcpChatView 的 agentType 接受 crew，且文案说 Crew', () => {
    render(<AcpChatView sessionId="s1" active={false} agentType="crew" />)
    expect(screen.getByPlaceholderText('Send a message to Crew...')).toBeInTheDocument()
    const t = src('components/AcpChatView.tsx')
    const line = t.split('\n').find(l => l.includes('agentType?:'))!
    expect(line).toContain("'crew'")
    expect(line).not.toContain("'kiro'")
  })

  it('⑤⑦ MobileKeyBar 有 crew 键且发 kirocrew chat', () => {
    const onKey = vi.fn()
    render(<MobileKeyBar onKey={onKey} />)
    expect(screen.getByLabelText('crew')).toBeInTheDocument()
    expect(screen.queryByLabelText('kiro')).not.toBeInTheDocument()
    expect(launchSequence('crew')).toBe('kirocrew chat\r')
  })
})
```

**现有测试的三处必要调整**（否则回归）：

```ts
// lib/__tests__/terminalInput.test.ts —— 原 kiro 那条改成 crew
  it('crew 的交互入口是 kirocrew chat（连本机 gateway，与 Crew 会话后端同源）', () => {
    expect(launchSequence('crew')).toBe('kirocrew chat\r')
  })

// components/__tests__/MobileKeyBar.test.tsx:8
    for (const k of ['up', 'down', 'enter', 'ctrl-c', 'claude', 'codex', 'crew']) {

// lib/__tests__/quickTargets.test.ts
    expect(coerceAgent('crew')).toBe('crew')
    // 'kiro' 正是这个场景的实例：后端已换成 crew，库里 quick_targets 的历史
    // kiro 行必须收敛为 null（→ 让用户重选类型），不能原样发给 create_session。
    expect(coerceAgent('kiro')).toBeNull()
    expect(coerceAgent('CLAUDE')).toBeNull()   // 大小写敏感，不做宽松匹配
```

## 附录 E2：审批内联卡片

### E2-A：`transcript.ts` 两处扩展

```ts
// WireEvent 加字段
  /** 仅 block_type==='approval'：Crew 的 approval id，上行 resolve 时用。 */
  approval_id?: string

// Block（:20-29）
export interface Block {
  // 'approval': a Crew tool-approval request. Inline (not an overlay/icon) because
  // it belongs to a specific tool_call of a specific turn — and because 5 icons is
  // the hard width limit in SessionInfoBar. Answered over the SAME /ws/acp socket.
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'approval'
  text?: string
  name?: string
  input?: unknown
  summary?: string
  /** 仅 approval：Crew 的 approval id。resolve 后本地置 resolved 隐藏按钮。 */
  approvalId?: string
}

// foldTranscript 的 content_block push（:91）带上 approvalId
        g.blocks.push({ type: bt, text: e.text, name: e.name, input: e.input, summary: e.summary, approvalId: e.approval_id })
```

**`density.ts` 无需改**：`partitionBlocks`（`density.ts:18-25`）只特判 `thinking`/`tool_use`，`approval` 落进 `visible.push(b)` —— concise 模式下审批卡片**不会**被折叠进「+N 条思考/工具」。这正是想要的（审批绝不能被藏起来）。已实测确认。

### E2-B：`AcpChatView.tsx` 的 state / 上行 / 两个 case / BlockView

```tsx
// ServerEvent（:50 之后）
  // Crew: approval 请求 / 上下文用量。后端加变体与前端加 case 必须同一 commit ——
  // handleEvent 的 switch 没有 default 分支，未知 type 是**静默丢弃**。
  approval_id?: string
  tool?: string
  tool_purpose?: string
  tool_input?: string
  used?: number
  total?: number

// Props（:69 之后）
  /** 「全部 →」跳记忆面板（App 把它接到 toggleOverlay(id,'memory')）。 */
  onOpenMemory?: () => void

// state（紧接 closePreset，:106 之后）
  // approval id → 本端已作出的决定。Gateway 不广播「已解决」帧，所以按钮是否
  // 收起只能由本端记账；replay 后一个已解决的 approval 会重新出现按钮，点第二次
  // 得到 404（后端忽略），这是可接受的降级 —— 好过永久卡住一个无法回答的卡片。
  const [resolvedApprovals, setResolvedApprovals] = useState<Record<string, 'approve' | 'reject'>>({})
  // 上下文用量（Crew 白拿的新能力：zeromux 自己没有）。
  const [ctxUsage, setCtxUsage] = useState<{ used: number; total: number } | null>(null)

// 上行（紧接 appendEvent，:291 之后）
  // 审批上行。照 interrupt 的形状（同一条 /ws/acp socket，后端 fan-out 代理
  // POST /api/approvals/{id}/{action}）—— 不新开连接、不新增轮询。
  // resolve 后本地把该块标 resolved，按钮消失（不等服务端回帧，Gateway 不回执）。
  const resolveApproval = useCallback((approvalId: string, action: 'approve' | 'reject') => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'approval', approval_id: approvalId, action }))
    }
    setResolvedApprovals(prev => (prev[approvalId] ? prev : { ...prev, [approvalId]: action }))
  }, [])

// handleEvent 两个新 case（插在 case 'system' 之前，:322 之前）
      case 'approval': {
        // **必须有这个 case** —— handleEvent 的 switch 没有 default 分支，未知顶层
        // type 是静默忽略：后端发了、前端没接 = 「什么都没发生」。
        const aid = evt.approval_id
        if (!aid) break
        // 作为一个 content_block 折进它所属的 turn，与那次 tool_use 相邻渲染。
        appendEvent({
          type: 'content_block',
          block_type: 'approval',
          turn_id: evt.turn_id ?? activeTurnIdRef.current ?? 0,
          approval_id: aid,
          name: evt.tool,
          summary: evt.tool_purpose,
          text: evt.tool_input,
        })
        // 审批请求是**真实的前进信号**（agent 在等人），刷新静默基线。
        // stuck 是静默判定（:585 的 STUCK_SILENCE_MS）：approval 弹出后 agent 就不再
        // 产出任何输出，不刷基线的话 60s 后 UI 显示「可能卡住」+ 中断按钮，用户点
        // 中断会白白杀掉一个只需点「批准」的轮次。与 chat_status（纯噪音）方向相反。
        setLastEventMs(Date.now())
        break
      }

      case 'context_usage': {
        // Crew 独有的能力，zeromux 自己没有 —— 纯白拿。
        if (typeof evt.used === 'number' && typeof evt.total === 'number' && evt.total > 0) {
          setCtxUsage({ used: evt.used, total: evt.total })
        }
        break
      }

// handleEvent 的 deps 加 resolveApproval
  }, [pushNotice, appendEvent, bumpMetrics, adoptQueueMode, settleActiveTurn, resolveApproval])

// BlockView 的 case 'approval'（插在 case 'tool_result' 之前，:948 之前）
    case 'approval': {
      // 内联而非图标位：审批天然属于某个 turn 的某个 tool_call，且 SessionInfoBar
      // 的 5 图标已是硬上限。**必须有这个 case** —— BlockView 的 default 是
      // `return null`，未知 block_type 渲染为空 = 什么都没发生。
      const aid = block.approvalId
      return (
        <div className="border-l-2 border-[var(--accent-red)] pl-2.5 py-1.5 text-xs">
          <div className="flex items-center gap-1 text-[var(--accent-red)] font-medium">
            <AlertCircle size={12} className="shrink-0" />
            <span>需要你批准</span>
            {block.name && (
              <span className="text-[var(--text-primary)] font-normal truncate min-w-0 flex-1">· {block.name}</span>
            )}
          </div>
          {block.summary && (
            <p className="mt-1 text-[11px] text-[var(--text-secondary)] break-words leading-snug">{block.summary}</p>
          )}
          {block.text && (
            <pre className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border)] overflow-x-auto max-h-40 overflow-y-auto">
              {block.text.length > 2000 ? block.text.substring(0, 2000) + '\n...(truncated)' : block.text}
            </pre>
          )}
          {approvalDecision ? (
            <p className="mt-1.5 text-[11px] text-[var(--text-muted)] italic">
              {approvalDecision === 'approve' ? '已批准' : '已拒绝'}
            </p>
          ) : aid ? (
            /* min-h-[44px] 触控目标。 */
            <div className="mt-2 flex gap-2">
              <button
                data-testid="approval-reject"
                onClick={() => onResolveApproval?.(aid, 'reject')}
                className="flex-1 min-h-[44px] rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent-red)] hover:border-[var(--accent-red)] text-xs font-medium transition-colors inline-flex items-center justify-center gap-1"
              >
                <Ban size={13} />拒绝
              </button>
              <button
                data-testid="approval-approve"
                onClick={() => onResolveApproval?.(aid, 'approve')}
                className="flex-1 min-h-[44px] rounded-lg bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] text-white text-xs font-medium transition-colors inline-flex items-center justify-center gap-1"
              >
                <Check size={13} />批准
              </button>
            </div>
          ) : (
            /* approval_id 缺失 = 后端 bug。绝不渲染两个点了没反应的按钮。 */
            <p className="mt-1.5 text-[11px] text-[var(--accent-yellow)]">审批 id 缺失，无法在此回答</p>
          )}
        </div>
      )
    }
```

### E2-C：三处贯通（否则点批准不会重渲染）

```tsx
// BlockView 签名（:944）
function BlockView({ block, isComplete, approvalDecision, onResolveApproval }: {
  block: ContentBlock
  isComplete: boolean
  approvalDecision?: 'approve' | 'reject'
  onResolveApproval?: (approvalId: string, action: 'approve' | 'reject') => void
}) {

// TurnGroupViewImpl 签名（:891）
function TurnGroupViewImpl({ group, agentName = 'Claude', density = 'concise', onExpand, resolvedApprovals, onResolveApproval }: {
  group: TurnGroup; agentName?: string; density?: Density; onExpand?: () => void
  /** approval id → 本端已作出的决定；有值则卡片收起按钮，显示结果。 */
  resolvedApprovals?: Record<string, 'approve' | 'reject'>
  onResolveApproval?: (approvalId: string, action: 'approve' | 'reject') => void
}) {

// :910 BlockView 调用点
          {visible.map((b, i) => (
            <BlockView
              key={i}
              block={b}
              isComplete={group.complete}
              approvalDecision={b.approvalId ? resolvedApprovals?.[b.approvalId] : undefined}
              onResolveApproval={onResolveApproval}
            />
          ))}

// :929-937 memo 比较器 —— 这两行是关键
const TurnGroupView = memo(
  TurnGroupViewImpl,
  (prev, next) =>
    prev.group === next.group &&
    prev.agentName === next.agentName &&
    prev.density === next.density &&
    prev.onExpand === next.onExpand &&
    // Must be compared, or answering an approval would not re-render the card:
    // stabilizeGroups (:92, 2026-08-03 F-perf) deliberately keeps a completed
    // turn's object identity, so nothing else changes when the decision lands.
    prev.resolvedApprovals === next.resolvedApprovals &&
    prev.onResolveApproval === next.onResolveApproval
)

// :680 groups.map 传入
            resolvedApprovals={resolvedApprovals}
            onResolveApproval={resolveApproval}

// ctxUsage 显示（替换 :639-643）
      {(lifetime.turns > 0 || ctxUsage) && (
        <div className="px-5 pt-2 pb-0 flex justify-end items-center gap-2">
          {ctxUsage && (
            <span className="text-[10px] text-[var(--text-muted)]" title="上下文用量（Crew 提供）">
              ctx {Math.round((ctxUsage.used / ctxUsage.total) * 100)}%
            </span>
          )}
          {lifetime.turns > 0 && <SessionLifetimeBadge agentType={agentType} lifetime={lifetime} />}
        </div>
      )}
```

`memo` 比较器那两行是**必须的**，这是整个设计里最容易漏、且表现为「点了没反应」的一处。

### E2-D：T14 测试 `crewEventCases.test.tsx`（6 个）

```tsx
import { render, screen, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket, type FakeSocket } from '../../test/fakeWs'

// T14:防的是「静默丢弃」陷阱 ——
//   · handleEvent 的 switch **没有 default 分支**（:307-437 改动前）
//   · BlockView 的 default 是 `return null`（:967-968 改动前）
// 所以「后端先发新变体、前端以后补 case」的表现是**什么都没发生**。
//
// 断言必须是「渲染出东西」而不是「代码里有 case 'approval'」：源码字符串断言在
// case 存在但落进 default:null 时仍然绿。
describe('T14 Crew 新事件变体在前端有 case（防静默丢弃）', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  let ws: () => FakeSocket
  beforeEach(() => { vi.restoreAllMocks(); ws = installFakeWebSocket().latest })
  afterEach(() => { (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs })

  const mount = () => render(<AcpChatView sessionId="s1" active agentType="crew" />)

  it('approval 帧渲染出内联审批卡片与两个 ≥44px 按钮', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', approval_id: 'ap1', tool: 'rm -rf /tmp/build',
                  tool_purpose: '清理构建产物', turn_id: 1 })
    })
    expect(await screen.findByText('需要你批准')).toBeInTheDocument()
    expect(screen.getByText(/rm -rf \/tmp\/build/)).toBeInTheDocument()
    expect(screen.getByText('清理构建产物')).toBeInTheDocument()
    const approve = screen.getByTestId('approval-approve')
    const reject = screen.getByTestId('approval-reject')
    // 触控目标 ≥44px（手机是主设备）。
    expect(approve.className).toMatch(/min-h-\[44px\]/)
    expect(reject.className).toMatch(/min-h-\[44px\]/)
  })

  it('点「批准」把决定沿同一条 /ws/acp socket 上行，并收起按钮', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', approval_id: 'ap1', tool: 'bash', tool_purpose: 'p', turn_id: 1 })
    })
    await act(async () => { screen.getByTestId('approval-approve').click() })
    // 上行格式（后端 fan-out 据此代理 POST /api/approvals/{id}/{action}）。
    const msgs = ws().sent.map(s => JSON.parse(s))
    expect(msgs).toContainEqual({ type: 'approval', approval_id: 'ap1', action: 'approve' })
    // 已决定 → 按钮消失（Gateway 不回执，收起只能由本端记账）。
    // 这一条同时钉住 memo 比较器：不加 resolvedApprovals 比较项时它会红。
    await waitFor(() => expect(screen.queryByTestId('approval-approve')).not.toBeInTheDocument())
    expect(screen.getByText('已批准')).toBeInTheDocument()
  })

  it('拒绝路径同样上行 reject', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', approval_id: 'ap2', tool: 'bash', tool_purpose: 'p', turn_id: 1 })
    })
    await act(async () => { screen.getByTestId('approval-reject').click() })
    expect(ws().sent.map(s => JSON.parse(s)))
      .toContainEqual({ type: 'approval', approval_id: 'ap2', action: 'reject' })
    await waitFor(() => expect(screen.getByText('已拒绝')).toBeInTheDocument())
  })

  it('approval_id 缺失时不渲染两个点了没反应的按钮', async () => {
    mount()
    await act(async () => {
      ws().emit({ type: 'approval', tool: 'bash', tool_purpose: 'p', turn_id: 1 })
    })
    await waitFor(() => expect(screen.queryByTestId('approval-approve')).not.toBeInTheDocument())
    expect(screen.queryByText('需要你批准')).not.toBeInTheDocument()
  })

  it('context_usage 帧渲染出上下文用量（zeromux 自己没有这个能力，纯白拿）', async () => {
    mount()
    await act(async () => { ws().emit({ type: 'context_usage', used: 30_000, total: 200_000 }) })
    expect(await screen.findByText('ctx 15%')).toBeInTheDocument()
  })

  it('context_usage 的 total 为 0 时不渲染（不产生 NaN%/Infinity%）', async () => {
    mount()
    await act(async () => { ws().emit({ type: 'context_usage', used: 5, total: 0 }) })
    await waitFor(() => expect(screen.queryByText(/^ctx /)).not.toBeInTheDocument())
  })
})
```

**退化验红矩阵**（起草期实跑过）：

| 退化 | Expected |
|---|---|
| 删 `BlockView` 的 `case 'approval'`（落回 `default: return null`） | **4 红** |
| 删 `handleEvent` 的两个 case | **6 红** |
| `memo` 比较器不加 `resolvedApprovals` | 「点批准收起按钮」那条红 |

## 附录 E3：记忆写入（纯函数层 + api 代理层 + composer 入口）

### E3-A：`frontend/src/lib/crewMemory.ts`

抽成独立模块是因为三个隐藏约束必须单测钉死，而且 `dropMdLine` 的下标映射是个**不可逆的破坏性 bug 温床**（整文件 PUT，删错行没法回退）。

```ts
// Crew 记忆的纯函数层。抽出来是因为这三条约束每一条都会让第一次实现失败：
//   1. PUT /api/memory/semantic 路径**不带** key（带 key 是 405）—— 后端代理保证
//   2. 必须有 X-Session-Key，且值是已存在的 slot —— 后端代理补齐
//   3. key 必须带命名空间前缀（pref.|project.|user.|lesson.）且匹配
//      ^[a-z][a-z0-9_.]*[a-z0-9]$，否则 "Key must match an allowed prefix"
const ALLOWED_PREFIXES = ['pref.', 'project.', 'user.', 'lesson.'] as const

/** Gateway 侧的 key 正则（实测）。 */
export const KEY_RE = /^[a-z][a-z0-9_.]*[a-z0-9]$/

/**
 * 把用户自由输入变成一对合法 (key, value)。
 *
 * 用户在手机上不会（也不该）自己写 `pref.pkg_manager`。输入两种形态都接受：
 *   - `包管理器用 pnpm`     → key 由前几个 ASCII 词生成，value 为整句原文
 *   - `pkg_manager = pnpm` → 显式 key=value，key 自动补 `pref.` 前缀
 * 无法从输入提取任何 ASCII 词时（纯中文），用稳定的 `pref.note_<hash>` 兜底 ——
 * 绝不发一个会被 Gateway 400 掉的 key，也绝不静默丢弃用户的话。
 */
export function normalizeMemoryKey(input: string): { key: string; value: string } {
  const text = input.trim()
  const eq = text.indexOf('=')
  let rawKey = ''
  let value = text
  if (eq > 0) {
    rawKey = text.slice(0, eq).trim()
    value = text.slice(eq + 1).trim() || text
  }
  if (!rawKey) rawKey = text
  const lowered = rawKey.toLowerCase().trim()
  // 已经是一个合法的带前缀 key（如 `project.repo`）→ 原样采用。这一步必须在
  // slug 化**之前**：slug 把 `.` 也折成 `_`，会把 project.repo 变成
  // pref.project_repo（前缀丢失、语义漂移，Gateway 侧成了另一条记忆）。
  if (hasAllowedPrefix(lowered) && KEY_RE.test(lowered)) return { key: lowered, value }
  // slug：小写、非 [a-z0-9] 折成 `_`、掐头去尾。中文字符全被折掉，故可能为空。
  let slug = lowered.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  // 限长，避免把整段话当 key。
  slug = slug.split('_').filter(Boolean).slice(0, 4).join('_')
  if (!slug || !KEY_RE.test(slug)) slug = `note_${stableHash(text)}`
  return { key: `pref.${slug}`, value }
}

function hasAllowedPrefix(k: string): boolean {
  return ALLOWED_PREFIXES.some(p => k.startsWith(p))
}

/** 稳定的 32-bit FNV-1a，转 base36。同一句话总得到同一个 key（重写=更新而非堆积）。 */
function stableHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** Gateway 的 `value_json` 是 JSON 字符串（`"\"pnpm\""`）；坏数据回落原文不抛。 */
export function parseSemanticValue(valueJson: string): string {
  try {
    const v = JSON.parse(valueJson)
    return typeof v === 'string' ? v : JSON.stringify(v)
  } catch {
    return valueJson
  }
}

/**
 * markdown 文档 → 可显示/可删的「行」。跳过标题（`#`）、HTML 注释与空行 ——
 * `# User Preferences` 和 `<!-- Learned from conversations -->` 是骨架，不是记忆。
 * 实测 preferences.md 现在只有 56 字节且全是骨架：不过滤 → 面板显示「已记 2 条」，
 * 用户点删就删掉文件结构。
 */
export function mdLines(md: string): string[] {
  return md.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('<!--'))
}

/**
 * 删掉 mdLines 的第 idx 行后重组整个文档。
 * 关键：idx 是**过滤后**列表的下标，必须映射回原始行号，否则会删错行
 * （标题和注释都在原始数组里占位）。preferences 的 PUT 是整文件覆盖，删错不可逆。
 */
export function dropMdLine(md: string, idx: number): string {
  const raw = md.split('\n')
  let seen = -1
  const out: string[] = []
  for (const line of raw) {
    const t = line.trim()
    const isContent = t.length > 0 && !t.startsWith('#') && !t.startsWith('<!--')
    if (isContent) {
      seen += 1
      if (seen === idx) continue   // 跳过被删的那一行
    }
    out.push(line)
  }
  return out.join('\n')
}
```

### E3-B：`api.ts` 代理层（插在 `:299` 的 `// Prompt presets API` 之前）

```ts
// ── Crew memory proxy（zeromux 后端代理 Crew Gateway :5476 的记忆面）──
// 浏览器不能直连 Gateway：跨源（Gateway 只绑 loopback）+ token 是 20h 全权 JWT，
// 把它交给前端等于把 Gateway 放进 localStorage。所有调用走 zeromux 自己的
// `/api/crew/memory/*`，由后端持 token 并在服务端补齐 X-Session-Key。

export interface SemanticEntry {
  key: string
  /** Gateway 原样返回 JSON 字符串（如 `"\"pnpm\""`），用 parseSemanticValue 读。 */
  value_json: string
  confidence: number
  source: string
  created_at: string
  updated_at: string
  is_deleted: number
}

export interface LessonEntry {
  id: string
  text: string
  created_at: string
}

export interface CrewMemory {
  /** memory/preferences.md 原文（纯 markdown） */
  preferences: string
  /** memory/projects.md 原文（纯 markdown） */
  projects: string
  semantic: SemanticEntry[]
  lessons: LessonEntry[]
  /** Gateway 不可达时为 false，其余字段为空 —— 面板据此显示降级提示而非空状态。 */
  gateway_ok: boolean
}

/** 一次取回记忆面板全部分区（后端并发四个上游请求，前端一次 GET）。 */
export async function getCrewMemory(): Promise<CrewMemory> {
  const res = await api('/api/crew/memory')
  if (!res.ok) throw new ApiError(res.status, 'getCrewMemory failed')
  return res.json()
}

/** 写一条语义记忆。后端补 X-Session-Key 并用**不带 key** 的 PUT。 */
export async function putCrewSemantic(key: string, value: string): Promise<void> {
  const res = await api('/api/crew/memory/semantic', {
    method: 'PUT',
    body: JSON.stringify({ key, value, source: 'user_explicit', confidence: 1.0 }),
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
}

export async function deleteCrewSemantic(key: string): Promise<void> {
  const res = await api(`/api/crew/memory/semantic/${encodeURIComponent(key)}`, { method: 'DELETE' })
  if (!res.ok) throw new ApiError(res.status, await res.text())
}

/** 整文件 PUT（Gateway 只支持整文件；面板本地重组 markdown 后调用）。 */
export async function putCrewMemoryDoc(doc: 'preferences' | 'projects', content: string): Promise<void> {
  const res = await api(`/api/crew/memory/${doc}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
}
```

### E3-C：composer 的记忆入口

```tsx
// AcpChatView.tsx:2-4 头部
import { wsUrl, uploadSessionFile, getSessionRuns, getCrewMemory, putCrewSemantic, deleteCrewSemantic } from '../lib/api'
import type { SemanticEntry } from '../lib/api'
import { normalizeMemoryKey, parseSemanticValue } from '../lib/crewMemory'
import { ChevronDown, Wrench, Brain, AlertCircle, FileText, Terminal, Search, Bot, Paperclip, ListPlus, X, Check, Ban, type LucideIcon } from 'lucide-react'

// state（紧接 closePreset，:106 之后）
  // ── 就地记忆写入（composer 第 3 个按钮）──
  // 人只在「被冒犯的那一刻」想纠正记忆（agent 刚用了 npm 而你说过 pnpm），那一刻
  // 拇指在输入框上。要求用户「打开设置去配置偏好」= 问卷 = 没人填。
  const [memOpen, setMemOpen] = useState(false)
  const [memDraft, setMemDraft] = useState('')
  const [memRecent, setMemRecent] = useState<SemanticEntry[]>([])
  const [memBusy, setMemBusy] = useState(false)
  const [memErr, setMemErr] = useState<string | null>(null)
  const [memConfirming, setMemConfirming] = useState<string | null>(null)
  // 单调请求令牌：popover 一开就冷 GET，同时用户可能立刻写/删（乐观 setMemRecent）。
  // 没有它，写入前发出的旧快照迟到会盖掉刚加的条目 / 复活刚删的 ghost。
  const memReqRef = useRef(0)
  const closeMem = useCallback(() => { setMemOpen(false); setMemConfirming(null); setMemErr(null) }, [])

// callbacks —— **必须放在 pushNotice 之后**（:286 之后）。它们依赖 pushNotice，
// 放前面会 TDZ 报错（起草期实测撞到）。
  const loadMemRecent = useCallback(async () => {
    const req = ++memReqRef.current
    try {
      const data = await getCrewMemory()
      if (memReqRef.current !== req) return
      // 最近 5 条：updated_at 倒序（Gateway 不保证顺序）。
      setMemRecent([...data.semantic]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 5))
      setMemErr(null)
    } catch (e) {
      if (memReqRef.current !== req) return
      setMemErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const rememberMem = useCallback(async () => {
    const text = memDraft.trim()
    if (!text || memBusy) return
    setMemBusy(true)
    setMemErr(null)
    try {
      const { key, value } = normalizeMemoryKey(text)
      await putCrewSemantic(key, value)
      memReqRef.current++
      const now = new Date().toISOString()
      setMemRecent(prev => [
        { key, value_json: JSON.stringify(value), confidence: 1.0, source: 'user_explicit',
          created_at: now, updated_at: now, is_deleted: 0 },
        ...prev.filter(e => e.key !== key),
      ].slice(0, 5))
      setMemDraft('')
      // 写入回执：在对话流留一行轻量提示。可见性靠回执，不靠面板 —— 用户一天不会
      // 主动打开记忆面板。NoticeBubble 的 system 分支（:865-868）正是这个视觉。
      pushNotice({ id: newId(), kind: 'system', text: `已记住：${value}` })
    } catch (e) {
      setMemErr(e instanceof Error ? e.message : String(e))
    }
    setMemBusy(false)
  }, [memDraft, memBusy, pushNotice])

  const forgetMem = useCallback(async (key: string) => {
    setMemConfirming(null)
    memReqRef.current++
    setMemRecent(prev => prev.filter(e => e.key !== key))
    try {
      await deleteCrewSemantic(key)
      pushNotice({ id: newId(), kind: 'system', text: `已忘掉：${key}` })
    } catch (e) {
      setMemErr(e instanceof Error ? e.message : String(e))
    }
    loadMemRecent()
  }, [pushNotice, loadMemRecent])

// popover JSX（紧接 presetOpen 的捕获层，:785 之后）
        {memOpen && (
          <div className="fixed inset-0 z-10" onClick={closeMem} aria-hidden="true" />
        )}
        {memOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-2 mx-2 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-lg z-20">
            <div className="p-2 flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <Brain size={12} className="text-[var(--accent-purple)] shrink-0" />
                <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider flex-1">记忆</span>
              </div>
              <div className="flex gap-2">
                <input
                  value={memDraft}
                  onChange={e => setMemDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); rememberMem() } }}
                  placeholder="让它记住…"
                  aria-label="memory draft"
                  /* text-base = 16px：低于 16px 时 iOS Safari 聚焦会自动放大整页，
                     把发送键挤出视口（Composer.tsx:225-226 的既有教训）。 */
                  className="flex-1 min-w-0 text-base bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg px-3 py-2 min-h-[44px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-purple)] placeholder-[var(--text-muted)]"
                />
                <button
                  onClick={rememberMem}
                  disabled={!memDraft.trim() || memBusy}
                  className="shrink-0 px-3 min-h-[44px] rounded-lg bg-[var(--accent-purple)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white text-xs font-medium transition-colors"
                >
                  {memBusy ? '写入中' : '记住'}
                </button>
              </div>
              {memErr && <p className="text-[10px] text-[var(--accent-red)] break-words">{memErr}</p>}
              <div className="text-[10px] text-[var(--text-muted)]">
                {memRecent.length > 0 ? `它记错了？(最近 ${memRecent.length} 条)` : '还没有记住任何偏好'}
              </div>
              {/* ✕ 常驻，绝不 group-hover（Tailwind v4 编进 @media (hover:hover)，
                  手机上 = 隐形按钮）。点 ✕ → 该行下沉展开确认，不用 window.confirm。 */}
              {memRecent.map(e => (
                <div key={e.key} className="rounded border border-[var(--border)]">
                  <div className="flex items-center gap-2 px-2 py-1.5 min-h-[44px]">
                    <span className="flex-1 min-w-0 text-[11px] text-[var(--text-primary)] break-words leading-snug">
                      {e.key.replace(/^(pref|project|user|lesson)\./, '')}
                      <span className="text-[var(--accent-purple)]"> = {parseSemanticValue(e.value_json)}</span>
                    </span>
                    <button
                      onClick={() => setMemConfirming(cur => cur === e.key ? null : e.key)}
                      data-testid="mem-forget"
                      aria-label={`forget ${e.key}`}
                      className="shrink-0 w-8 min-h-[44px] -my-1.5 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--accent-red)] transition-colors"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  {memConfirming === e.key && (
                    <button
                      data-testid="mem-forget-confirm"
                      onClick={() => forgetMem(e.key)}
                      className="flex items-center gap-2 w-full px-2 py-2 min-h-[44px] border-t border-[var(--border)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-hover)]"
                    >
                      <X size={12} className="shrink-0" />确认移除，让它忘掉
                    </button>
                  )}
                </div>
              ))}
              <div className="flex justify-between">
                <button
                  onClick={() => { closeMem(); onOpenMemory?.() }}
                  className="px-2 py-1 text-[10px] font-semibold text-[var(--accent-purple)] hover:opacity-80"
                >
                  全部 →
                </button>
                <button onClick={closeMem} className="px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}

// 第 3 个按钮（rightSlot 内，Paperclip 之后 :809）
              {/* 仅 Crew 会话。宽度核算：现有 2 按钮各 p-2+size16 ≈ 32px 加发送键
                  40px = 104px；375px 屏下 textarea 约 246px。加这个 → 136px，
                  textarea 剩 ~214px。接近极限，故其它后端不渲染。 */}
              {agentType === 'crew' && (
                <button
                  onClick={() => {
                    setMemConfirming(null)
                    closePreset()
                    setMemOpen(o => { if (!o) loadMemRecent(); return !o })
                  }}
                  aria-label="memory"
                  className="self-end p-2 text-[var(--text-muted)] hover:text-[var(--accent-purple)] rounded-lg transition-colors"
                  title="记忆"
                >
                  <Brain size={16} />
                </button>
              )}

// 两处必要的既有代码修改（否则两个弹层会重叠）
// preset 按钮（原 :793-796）加一行互斥
                  onClick={() => {
                    setPresetManaging(false)
                    // 两个 popover 都是 absolute bottom-full，同时开会重叠 —— 互斥。
                    setMemOpen(false)
                    setPresetOpen(o => { if (!o) presetStore.reload(); return !o })
                  }}

// Esc 处理（在既有 presetOpen 的 Esc effect :601-607 之后新增）
  // Esc 同样关记忆 popover（与 preset 一致，否则桌面端两个弹层行为不一致）。
  useEffect(() => {
    if (!memOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMem() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [memOpen, closeMem])
```

### E3-D：T15 测试（纯函数 7 个 + 组件 6 个）

纯函数部分放 `frontend/src/lib/__tests__/crewMemory.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { normalizeMemoryKey, KEY_RE, mdLines, dropMdLine, parseSemanticValue } from '../crewMemory'

// T15-a:key 归一化（约束 3：前缀 + 正则）。实测约束:key 必须匹配
// ^[a-z][a-z0-9_.]*[a-z0-9]$ 且带前缀 pref.|project.|user.|lesson.,否则
// Gateway 回 "Key must match an allowed prefix"。
describe('T15-a key 归一化', () => {
  it('自由中文输入自动加 pref. 前缀，且 key 合法', () => {
    const { key, value } = normalizeMemoryKey('提交前必须先跑 npm test')
    expect(key.startsWith('pref.')).toBe(true)
    expect(KEY_RE.test(key)).toBe(true)
    // value 保留用户原话 —— key 是索引，不是内容。
    expect(value).toBe('提交前必须先跑 npm test')
  })

  it('纯中文（无任何 ASCII 词）也产出合法 key，绝不发一个会被 400 掉的 key', () => {
    const { key } = normalizeMemoryKey('回复一律用中文')
    expect(key.startsWith('pref.note_')).toBe(true)
    expect(KEY_RE.test(key)).toBe(true)
  })

  it('同一句话两次归一化得到同一个 key（重写=更新，不堆积重复行）', () => {
    expect(normalizeMemoryKey('回复一律用中文').key)
      .toBe(normalizeMemoryKey('回复一律用中文').key)
  })

  it('key=value 形态：key 补前缀，value 取右侧', () => {
    const { key, value } = normalizeMemoryKey('pkg_manager = pnpm')
    expect(key).toBe('pref.pkg_manager')
    expect(value).toBe('pnpm')
  })

  it('已带合法前缀时不再叠一层（不产出 pref.pref.x / pref.project_repo）', () => {
    expect(normalizeMemoryKey('project.repo = zeromux').key).toBe('project.repo')
    expect(normalizeMemoryKey('lesson.no_force_push = true').key).toBe('lesson.no_force_push')
  })

  it('大写/空格/标点被折成合法 slug，且不以 _ 收尾（正则要求末位是 [a-z0-9]）', () => {
    const { key } = normalizeMemoryKey('Use PNPM, Not NPM!')
    expect(KEY_RE.test(key)).toBe(true)
    expect(key.endsWith('_')).toBe(false)
    expect(key.startsWith('pref.')).toBe(true)
  })

  it('超长输入不把整段话当 key（限 4 段）', () => {
    expect(normalizeMemoryKey('a b c d e f g h i j k l').key).toBe('pref.a_b_c_d')
  })
})

describe('T15-b markdown 层', () => {
  it('骨架（标题 + HTML 注释）不算记忆，所以初始状态是「空」', () => {
    // 实测 preferences.md 只有 56 字节：一个标题 + 一行注释。若把它们列成可删行，
    // 用户会删掉文件结构，并误以为「已经记了两条」。
    expect(mdLines('# User Preferences\n\n<!-- Learned from conversations -->\n')).toEqual([])
    expect(mdLines('# User Preferences\n\n- 用 pnpm\n- 提交前跑测试\n'))
      .toEqual(['- 用 pnpm', '- 提交前跑测试'])
  })

  it('删一行按过滤后下标映射回原始行号（否则删错行，且 PUT 整文件不可逆）', () => {
    const md = '# User Preferences\n\n<!-- note -->\n- 用 pnpm\n- 提交前跑测试\n'
    // idx=1 是过滤后的第二条（「提交前跑测试」），原始数组里它是第 5 行。
    const next = dropMdLine(md, 1)
    expect(mdLines(next)).toEqual(['- 用 pnpm'])
    // 骨架必须完整保留。
    expect(next).toContain('# User Preferences')
    expect(next).toContain('<!-- note -->')
  })

  it('value_json 是 JSON 字符串，坏数据回落原文不抛', () => {
    expect(parseSemanticValue('"pnpm"')).toBe('pnpm')
    expect(parseSemanticValue('{"a":1}')).toBe('{"a":1}')
    expect(parseSemanticValue('not json')).toBe('not json')
  })
})
```

组件部分放 `frontend/src/components/__tests__/crewMemoryWrite.test.tsx`：

```tsx
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AcpChatView from '../AcpChatView'
import { installFakeWebSocket } from '../../test/fakeWs'
import type { CrewMemory } from '../../lib/api'

// T15:前两条约束由 zeromux 后端代理承担（浏览器不该持 Gateway token，也无法
// 跨源），所以前端侧的断言是「打的是代理端点、路径不带 key」。
//
// 关键手法：**拦 globalThis.fetch 而不是 mock api.ts** —— 约束在于发出的 HTTP
// 形状（路径带不带 key、有没有 X-Session-Key），mock 掉 api 层就什么都测不到了。
const memory = (over: Partial<CrewMemory> = {}): CrewMemory => ({
  preferences: '# User Preferences\n\n<!-- Learned from conversations -->\n',
  projects: '# Active Projects\n\n<!-- Current work context -->\n',
  semantic: [], lessons: [], gateway_ok: true, ...over,
})

describe('T15-c 走代理端点：路径不带 key，凭证不进前端', () => {
  const origWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket
  const origFetch = globalThis.fetch
  beforeEach(() => { vi.restoreAllMocks(); installFakeWebSocket() })
  afterEach(() => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWs
    globalThis.fetch = origFetch
  })

  const captureFetch = () => {
    const calls: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, init })
      const isGet = !init?.method || init.method === 'GET'
      const body = url.includes('/api/crew/memory') && isGet ? memory() : { ok: true }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return calls
  }

  it('composer 的「记住」PUT 到 /api/crew/memory/semantic —— 路径不带 key', async () => {
    const calls = captureFetch()
    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    await act(async () => { screen.getByLabelText('memory').click() })
    const input = await screen.findByLabelText('memory draft')
    // 受控 input：必须走 fireEvent.change（React 合成事件），直接 dispatch 原生
    // input 事件不会触发 onChange，value 会被下一次 render 还原（实测撞到）。
    fireEvent.change(input, { target: { value: 'pkg_manager = pnpm' } })
    await act(async () => { screen.getByText('记住').click() })

    const put = await waitFor(() => {
      const c = calls.find(c => c.init?.method === 'PUT')
      if (!c) throw new Error('no PUT yet')
      return c
    })
    // 约束 1：key 只在 body 里，路径就是 .../semantic，末尾没有 /pref.xxx。
    expect(put.url).toBe('/api/crew/memory/semantic')
    expect(put.url).not.toMatch(/semantic\/.+/)
    // 约束 3：body 的 key 带前缀。source/confidence 是 Gateway 必需字段。
    expect(JSON.parse(put.init!.body as string)).toEqual({
      key: 'pref.pkg_manager', value: 'pnpm', source: 'user_explicit', confidence: 1.0,
    })
    // 约束 2：X-Session-Key / Gateway token 都**不**出现在前端请求里 —— 由后端补。
    const headers = (put.init!.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers).map(h => h.toLowerCase())).not.toContain('x-session-key')
    expect(put.url).not.toContain('token=')
  })

  it('删除走 DELETE /api/crew/memory/semantic/{key}（这一侧路径**要**带 key），且二段确认', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, init })
      const isGet = !init?.method || init.method === 'GET'
      return new Response(JSON.stringify(isGet ? memory({
        semantic: [{
          key: 'pref.pkg_manager', value_json: '"pnpm"', confidence: 1.0,
          source: 'user_explicit', created_at: '2026-09-13T00:00:00Z',
          updated_at: '2026-09-13T00:00:00Z', is_deleted: 0,
        }],
      }) : { ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    await act(async () => { screen.getByLabelText('memory').click() })
    // 最近 5 条直接可见（0 tap），✕ 常驻（不用 group-hover：手机上会变隐形按钮）。
    const x = await screen.findByTestId('mem-forget')
    expect(x.className).not.toMatch(/opacity-0|group-hover/)
    // 二段确认：第一下只展开确认行，不发请求。
    await act(async () => { x.click() })
    expect(calls.some(c => c.init?.method === 'DELETE')).toBe(false)
    await act(async () => { screen.getByTestId('mem-forget-confirm').click() })
    await waitFor(() => expect(calls.some(c =>
      c.init?.method === 'DELETE' && c.url === '/api/crew/memory/semantic/pref.pkg_manager')).toBe(true))
  })

  it('写入成功后在对话流留一行回执（可见性靠回执，不靠面板）', async () => {
    captureFetch()
    render(<AcpChatView sessionId="s1" active agentType="crew" />)
    await act(async () => { screen.getByLabelText('memory').click() })
    const input = await screen.findByLabelText('memory draft')
    fireEvent.change(input, { target: { value: '提交前必须先跑 npm test' } })
    await act(async () => { screen.getByText('记住').click() })
    expect(await screen.findByText('已记住：提交前必须先跑 npm test')).toBeInTheDocument()
  })

  it('非 Crew 会话没有记忆按钮（宽度预算只给 Crew）', () => {
    captureFetch()
    render(<AcpChatView sessionId="s2" active agentType="claude" />)
    expect(screen.queryByLabelText('memory')).not.toBeInTheDocument()
  })
})
```

**退化验红矩阵**（起草期实跑过）：

| 退化 | Expected |
|---|---|
| `normalizeMemoryKey` 不加 `pref.` 前缀 | 红 |
| `putCrewSemantic` 路径带 key | 红 |
| 二段确认退化成一段 | 红 |
| 去掉写入回执 | 红 |
| `mdLines` 不过滤骨架 | 红 |

## 附录 E4-A：`MemoryPanel.tsx`

见起草稿完整实现。**四个要点**（实施时逐条对照）：

1. **空状态本身就是写入表单**，不是「暂无数据」—— 实测记忆现在必然是空的（semantic `[]`、lessons `[]`、preferences 56 字节全骨架）。文案给因果（"下一轮起它会自动带上"）。输入框 `text-base` + 按钮 `min-h-[44px]`。
2. **`gateway_ok:false` 显示黄色降级条，与"真的空"是两种完全不同的含义** —— 混淆了用户会以为记忆被清空。
3. **`reqRef` 单调令牌** —— 本面板同时具备「慢 GET」（后端并发四个上游请求）与「乐观 mutation」两个条件，正是本 repo 修过十余次的 stale-clobber 场景。fetch 顶部 bump，每个乐观写前也 bump。
4. **教训区只读** —— Crew 侧无 per-lesson DELETE 端点，别给一个点了没反应的 `✕`。
5. **`MemoryRow` 的 `✕` 常驻**，绝不 `group-hover`；二段确认下沉展开（照 `QuickTargets.tsx:134-165`）。

```tsx
// 结构骨架（完整实现照上述五点写）：
export default function MemoryPanel() {
  const [mem, setMem] = useState<CrewMemory | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const req = ++reqRef.current
    setLoading(true)
    try {
      const data = await getCrewMemory()
      if (reqRef.current !== req) return
      setMem(data); setErr(null)
    } catch (e) {
      if (reqRef.current !== req) return
      setErr(e instanceof Error ? e.message : String(e))
    }
    if (reqRef.current === req) setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // remember / removeSemantic / removeDocLine：三者都先 reqRef.current++ 再乐观
  // setMem，然后 await，最后 load() 纠正。
  // removeDocLine 用 dropMdLine(cur, idx) 重组后整文件 PUT —— markdown 层没有
  // per-line DELETE。这也是为什么「让它记住」写 semantic 而非 preferences：
  // semantic 有真正的 DELETE /{key}，长期可纠正性更好。

  // 分区：语义记忆 / 偏好(markdown) / 项目上下文(markdown) / 教训(只读)
  // 每区用 <Section title count> 包裹，count===0 时整区不渲染。
}
```

`App.tsx` 五处改动与 `SessionInfoBar` 的第 5 图标见 Task 10 正文。

---

# 附加任务（spec §11.3，自审时发现原计划漏了）

### Task 14: 让定时任务能用 Crew 会话执行

spec §11.3 的结论是"保留 zeromux 调度，只让 `TaskConfig.agent_type` 支持 `"crew"`"。**自审时发现这个改动比 spec 以为的大**：

实测 `trigger_run`（`session_manager.rs:1208-1264`）**硬编码**调用 `create_acp_session_tagged`（即 Claude），**完全不读 `agent_type`**。`TaskConfig.agent_type`（`scheduled_tasks.rs:357`，注释就写着 `// "claude"`）目前只是一个**记录字段**，不参与分派 —— 所以生产库里那唯一一行 `agent_type='claude'` 从来没被当作选择依据。

**这意味着**：spec 说的"`agent_type` 已是自由字符串，只需 `trigger_run` 的 spawn 分派加一臂"—— 前半句对，后半句低估了：那里现在**没有分派**，要新建一个。

**Files:**
- Modify: `src/session_manager.rs:1208-1264`（`trigger_run` 加 `agent_type` 参数与分派）
- Modify: `src/scheduled_tasks.rs:1164`（调用点传 `&task.agent_type`）
- Modify: `src/web.rs:3293`（手动触发的调用点同样传）
- Modify: `src/session_manager.rs`（`create_crew_session_tagged`，照 `create_acp_session_tagged`）

**Interfaces:**
- Consumes: Task 5 的 `create_crew_session`
- Produces: `trigger_run(run_id, name, work_dir, owner_id, task_id, prompt, agent_type: &str)`（多一个尾参）

- [ ] **Step 1: 写失败测试**

```rust
    #[test]
    fn scheduled_agent_type_maps_to_session_type() {
        // agent_type 是自由字符串（DB 里存什么都行），所以必须有一个显式映射函数，
        // 且未知值要有明确回落 —— 否则一个手改过 DB 的 agent_type 会静默变成
        // 别的后端，而定时任务是无人值守的（错了没人当场看见）。
        assert!(matches!(scheduled_session_type("claude"), SessionType::Claude));
        assert!(matches!(scheduled_session_type("crew"), SessionType::Crew));
        assert!(matches!(scheduled_session_type("codex"), SessionType::Codex));
        // 未知/空 → 回落 Claude（既有行为：生产库里 1 行 agent_type='claude'，
        // 且 trigger_run 一直硬编码 Claude，所以这个回落等于保持现状）。
        assert!(matches!(scheduled_session_type("kiro"), SessionType::Claude));
        assert!(matches!(scheduled_session_type(""), SessionType::Claude));
        assert!(matches!(scheduled_session_type("nonsense"), SessionType::Claude));
    }
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test scheduled_agent_type 2>&1 | tail -6`

Expected: `cannot find function 'scheduled_session_type'`。

- [ ] **Step 3: 实现映射与分派**

```rust
/// 定时任务的 `agent_type` → `SessionType`。
///
/// `agent_type` 是 DB 里的自由字符串（`scheduled_tasks.rs:357`），所以映射必须显式
/// 且有回落。**回落 Claude 是保持现状**：`trigger_run` 在本任务之前一直硬编码
/// Claude，生产库里唯一一行也是 `'claude'`。
///
/// 未知值不 fail 而是回落，理由：定时任务是无人值守的，一个 fail 会让 run 静默
/// 失败并进 failed 终态；回落到一个能跑的后端至少留下可读的输出。
fn scheduled_session_type(agent_type: &str) -> SessionType {
    match agent_type {
        "crew" => SessionType::Crew,
        "codex" => SessionType::Codex,
        _ => SessionType::Claude,
    }
}
```

`trigger_run` 的 `create_acp_session_tagged` 调用点改为按类型分派：

```rust
        let sid = match scheduled_session_type(agent_type) {
            SessionType::Crew => self
                .create_crew_session_tagged(/* 同参数 */)
                .await
                .map_err(/* 同既有错误处理 */)?,
            _ => self
                .create_acp_session_tagged(/* 既有参数，保持不变 */)
                .await
                .map_err(/* 既有 */)?,
        };
```

`create_crew_session_tagged` 照 `create_acp_session_tagged` 写（同样设 `source_task_id`、`name_is_auto`）。

**注意**：Crew 定时会话**照旧进 E1 门** —— 它和其它调度会话一样被 `active_run_count()`（`scheduled_tasks.rs:600-605`）计入，`auto_update.rs:126` 的 `summary.scheduled > 0` 因此照常阻塞升级。这是保留 zeromux 调度的核心理由（spec §11.2），不能因为换了后端就绕过。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test scheduled_agent_type 2>&1 | tail -5` → Expected 1 passed。

Run: `cargo test 2>&1 | tail -3` → Expected `397 passed`（Task 13 后的 396 + 本任务 1）。

- [ ] **Step 5: 手工验收**

在 UI 里新建一个定时任务，agent 类型选 Crew，触发一次手动运行：

1. 该 run 创建的是 Crew 会话（会话列表里紫色带环图标）。
2. run 完成后 `agent_task_runs` 有对应记录且 `state='succeeded'`。
3. **run 进行中时** `GET /api/status`（zeromux 自己的）的 `running_summary.scheduled` ≥ 1 —— 证明 E1 门照常计入。

- [ ] **Step 6: Commit**

```bash
git add src/session_manager.rs src/scheduled_tasks.rs src/web.rs
git commit -m "$(cat <<'EOF'
feat(crew): 定时任务可用 Crew 会话执行

自审发现 spec §11.3 低估了改动量:trigger_run(session_manager.rs:1208-1264)
一直**硬编码** create_acp_session_tagged(Claude),完全不读 agent_type ——
TaskConfig.agent_type 至今只是个记录字段,不参与分派。所以不是「加一臂」,
而是新建一个分派。

scheduled_session_type 的未知值回落 Claude = 保持现状(生产库唯一一行是
'claude',且 trigger_run 一直就是 Claude)。不 fail 而回落的理由:定时任务
无人值守,fail 会静默进 failed 终态,回落到能跑的后端至少留下可读输出。

Crew 定时会话照旧进 E1 门(被 active_run_count 计入 → auto_update.rs:126
的 summary.scheduled>0 照常阻塞升级)—— 这是保留 zeromux 调度的核心理由,
不能因为换后端就绕过。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 附：交付顺序与验证门

| 批次 | 任务 | 完成判据 |
|---|---|---|
| **0** | Task 1-3 | `cargo test` 386；`systemd-analyze verify` 无错 |
| **1** | Task 4-6 | `cargo test` 400；前端 46/268；**手工验收 9 条全过** |
| **2** | Task 7 | `cargo test` 400；前端 47/274；退化验红 ≥3 红 |
| **3** | Task 8-9 | `cargo test` 402；前端 49/288；退化验红 5 条逐条命中 |
| **4** | Task 10 | 前端 49/292；手机视口 6 条手工验收 |
| **5** | Task 11-13 | `cargo test` 396；前端 48/290 |
| **附加** | Task 14 | `cargo test` 397；E1 门验证通过 |

**总验证门**：
- `cargo test` 最终 **397 passed**。逐批核算：382（基线）→383（T1 +1）→386（T2 +3）→397（T4 +11）→400（T5 +3）→402（T8 +2）→399（T11 −3）→396（T12 −3）→**397**（T14 +1）
- 前端最终 **48 文件 / 290 测试**
- `npm run lint` 无新增告警；`npx tsc --noEmit` 零错误
- `npm run build` + `cargo build` 成功（**前端必须先 build** —— `rust-embed` 编译期读 `frontend/dist/`）
- **产品判据**：一周内成功写入 ≥3 条记忆（spec §9.2 —— 这是唯一能证明"接 Crew 有意义"的行为指标）
