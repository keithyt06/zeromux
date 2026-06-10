# 设计:手机端 agent 会话文件上传

> **类型**:实现 spec
> **日期**:2026-06-10
> **场景**:出差时用手机浏览器登录 zeromux,把照片/截图/文件中保存的内容上传给 agent 会话(Kiro / Claude Code / Codex)。
> **状态**:设计已批准,待写实现计划

## 背景与目标

用户常在手机(出差、不在电脑旁)需要把**照片、截图、文件**发给正在对话的 agent。现状:
- 后端 `POST /api/sessions/{id}/upload`(base64,10MB,路径受限会话 work_dir 内)**已存在**,但唯一入口在 `MarkdownViewer`(文件浏览器视图)里,**与 agent 对话脱节** —— 上传后文件只是躺在磁盘,agent 不知道,用户还得手动在 prompt 里打文件名。
- 三个 `send_prompt`(`process.rs`/`kiro_process.rs`/`codex_process.rs`)全是纯文本,无图片/附件处理。

**目标**:在 agent 聊天 composer(`AcpChatView`)加附件入口,手机端可从相册选图或选任意文件,上传后把路径**自动拼进这一轮 prompt**,让 agent 用工具(Read 等)读取。

## 已确认决策

| 决策点 | 选择 |
|---|---|
| 传递方式 | **路 A:文件落盘 + 路径注入 prompt**(三后端统一,复用现有端点)。排除路 B(原生多模态 block:只 Claude 可能支持,Kiro/Codex 协议大概率不支持,高风险) |
| 存放位置 | **会话 work_dir 根**(原名 + 重名加后缀)。agent 一眼看到,路径最短 |
| 上传入口 | composer 旁 📎 按钮 → 两个隐藏 input:`accept="image/*"`(相册/图片)+ `accept="*/*"`(任意文件)。**不做**相机拍照、剪贴板粘贴 |
| 多文件 | **支持多选**(`<input multiple>`),攒成一批跟这轮 prompt 一起发 |
| 纯文字/纯附件 | 附件可**单独发**(无文字时自动生成"我上传了这些文件,请查看");也可配文字发 |
| 重名冲突 | 后端**原子去重**(`create_new(true)`,`a.png`→`a-1.png`);返回实际写入文件名(评审 E2) |
| 文件大小上限 | **20MB**(评审 E1;手机原图常超 10MB)。配套 `DefaultBodyLimit ≈ 27MB`(20MB×1.34 base64 膨胀),否则 axum 默认 2MB 直接 413 |
| 文件名安全 | 注入 prompt 前 **sanitize**(剥换行/控制字符,防二阶注入 + 格式破坏,评审 E3) |
| prompt 措辞 | **指令化**(`请先用 Read 工具读取后再回应`),实现期三后端各验证一次会读(评审 E4) |
| 图片压缩 | **不做**(YAGNI,20MB 上限够手机原图,撞了再说) |
| 多模态 block(路 B) | 不做(远期) |

> **PM/CTO 评审修订(2026-06-10)**:本 spec 经 PM(scope/真问题)+ CTO(failure-mode)双帽走查后修订。
> - **E1(critical,上线即坏)**:`build_router` 全程无 `DefaultBodyLimit`,axum 默认请求体上限 **2MB**。手机截图 base64 后约 4MB+ 会在提取层 **413**,端点内的大小检查根本到不了(原 spec "现有端点已接受此开销" 是错误推断——MarkdownViewer 入口大概率从没传过 >2MB,bug 休眠至今)。必须显式设 body limit。已决:文件上限提到 20MB + body limit ≈27MB。
> - **E2(correctness)**:`dedupe_filename` "先 check 再 write" 有 TOCTOU——多截图并发上传(主场景)可能两个同名都算出 `a.png` 后互相覆盖。改用 `OpenOptions::create_new(true)` 原子创建,冲突递增后缀重试。
> - **E3(security,P1)**:`file.name` 用户可控,被拼进发给 agent 的 prompt = 二阶注入面;含换行/控制字符还会破坏注入块格式。落盘 + 注入前 sanitize。
> - **E4(product)**:`请查看` 措辞下 agent 可能只"看到"不"打开"(尤其纯附件无文字)。改指令化 `请先用 Read 工具读取后再回应`,实现期对三后端各验证一次(同 titler 当时做法)。

## 架构

```
手机 composer 选文件(多选)
  → FileReader 读成 base64(前端,已有逻辑)
  → 逐个 POST /api/sessions/{id}/upload(已存在端点;改为返回实际写入 path)
  → 收集所有上传成功的实际文件名 → composer 上方显示待发 chip
  → 发送 turn:prompt = [用户文字] + 附件块(列出所有实际路径)
  → 走现有 SessionInput::Prompt 通道 → 三后端统一(无需改 send_prompt)
```

不破坏 `session_manager.rs` 的广播扇出不变量(上传是独立 HTTP 端点;发送仍走现有 prompt 通道)。

### work_dir / worktree 核对(已验证)

agent 会话跑在隔离 worktree(`.zeromux-worktrees/<id>/`)。`SessionManager::work_dir(session_id)` 返回 `session.work_dir`,该字段在会话创建时已设为 **effective_dir(worktree 路径)**(`session_manager.rs:647`/`:734`)。`resolve_base_dir` → `work_dir()` 因此已指向 worktree。**结论:现有上传端点落盘位置正是 agent 能看到的目录,无需额外 worktree 处理。** 注入 prompt 的相对路径(`./文件名`)对 agent 的 cwd 成立。

---

## Feature 1 — 后端:body limit + 原子去重(评审 E1/E2)

### 当前行为(要改的)

- `build_router`(`web.rs:18`)**无 `DefaultBodyLimit`** → axum 默认请求体 **2MB**(评审 E1)。
- `upload_session_file`(`web.rs:872`)`std::fs::write` **直接覆盖**同名文件,返回 `StatusCode::OK`(无 body)。问题:覆盖用户仓库已有文件;前端拿不到实际写入名,无法准确注入 prompt 路径。

### 新行为

1. **body limit(E1)**:给 upload 端点设 `DefaultBodyLimit::max(28_311_552)`(≈27MB = 20MB×1.34 base64 膨胀,留余量)。优先**只作用于 upload 路由**(`.layer(DefaultBodyLimit::max(...))` 挂在该 route 上),避免放大其他端点的攻击面;若 axum 版本下 per-route 不便,退而给 `api` 组设。实现期确认作用域。
2. **文件大小上限提到 20MB**:端点内 `if bytes.len() > 20_971_520`(原 10MB → 20MB),错误信息相应改 "max 20MB"。
3. **原子去重(E2)**:新增 `dedupe_and_create(dir: &Path, name: &str) -> io::Result<(File, String)>`,用 `OpenOptions::new().write(true).create_new(true).open(dir/name)`;`AlreadyExists` 则在扩展名前加 `-1`/`-2`… 重试(`a.png`→`a-1.png`;无扩展名 `log`→`log-1`),返回**打开的 File 句柄 + 实际文件名**。这样"判定不存在"与"占位创建"是同一原子操作,消除并发覆盖窗口。纯逻辑部分(后缀生成 `next_candidate(name, n) -> String`)抽出可单测。
4. `upload_session_file`:解出 work_dir 根 + 经 `resolve_session_path` 路径遍历防护后,对**文件名部分** sanitize(见 Feature 3 的 `sanitize_filename`)→ `dedupe_and_create` → 写 bytes 到返回的 File 句柄。
5. 响应改为 `Json(UploadResp { path: 实际写入的相对文件名 })`。

> **兼容性**:`MarkdownViewer` 现有调用方收到新响应体但当前忽略返回值(只 `loadFiles()` 刷新),向后兼容。前端 `uploadSessionFile` 返回类型 `Promise<void>`→`Promise<string>`(实际 path),`MarkdownViewer` 调用处无需改(忽略返回值即可)。
> **MarkdownViewer 去重副作用**:文件浏览器上传现在也会去重(原本静默覆盖)。这是更安全的行为(不丢用户文件),视为改进而非回归。

---

## Feature 2 — composer 附件入口(主要工作量)

### 改动位置

- `frontend/src/components/AcpChatView.tsx` 的 composer 区(`sendPrompt` 附近,`:292`)。
- 复用 `frontend/src/lib/api.ts` 的 `uploadSessionFile`(改返回实际 path)。

### 交互

1. composer 左侧加 📎 附件按钮。点击弹出小菜单(或两个并排小图标):**图片**(触发隐藏 `<input type="file" accept="image/*" multiple>`)、**文件**(触发隐藏 `<input type="file" accept="*/*" multiple>`)。
2. 选中文件后:**串行**(逐个,非并行,评审 E5 缓解手机内存)对每个文件 `FileReader.readAsDataURL` → 取 base64 → `uploadSessionFile(id, file.name, base64)`,期间 composer 上方显示"上传中 N 个"。
3. 每个上传成功 → 用返回的**实际 path** 在 composer 上方加一个**待发附件 chip**(显示文件名 + ✕ 移除按钮)。失败 → 提示该文件失败,不阻塞其他文件。
4. 用户可在发送前点 ✕ 移除某个 chip(仅从待发列表移除;已上传的文件留在磁盘,不做删除 —— YAGNI)。
5. 发送时:把待发 chip 的实际路径拼进 prompt(见格式),`sendPrompt`,清空 chip 列表。

### 待发附件状态

composer 维护 `pendingAttachments: string[]`(实际相对路径)。发送成功后清空。切换会话/视图时清空(附件是 per-compose 的瞬态)。

### 启用条件

附件按钮在 composer 能接收 prompt 时才可用(复用现有 composer enabled / busy 逻辑;会话未运行或 turn 进行中时的行为与现有文字发送一致)。

---

## Feature 3 — prompt 注入格式 + 文件名 sanitize(评审 E3/E4)

### 注入格式(指令化措辞,评审 E4)

纯函数(前端),可单测:

```
<用户文字,可为空>

[用户上传了以下文件,请先用 Read 工具读取后再回应:
./screenshot-1.png
./error-log.txt]
```

规则:
- 有附件时,在用户文字后追加附件块(空行分隔)。
- 用户文字为空时,只发附件块(无前导空行)。
- 单附件也用列表格式(保持一致)。
- 路径用 `./<文件名>`(相对会话 cwd,agent Read 可直接用)。
- 与 collect 合并、scheduled-run 等无交互:普通交互 prompt,走现有通道。
- **实现期验证(E4)**:对 claude/kiro/codex 各发一次带附件的 turn,确认 agent 真的调用 Read 打开文件(而非只口头确认)。若某后端措辞下不读,实现期微调措辞——以"放过 happy path、agent 真读文件"为准。

### 文件名 sanitize(评审 E3)

`file.name` 用户可控,既落盘又拼进 prompt。两处都要 sanitize:
- **后端落盘前**(`sanitize_filename(name) -> String`,Rust 纯函数,可单测):剥换行/控制字符(`\n\r\t` 及 `< 0x20`),去路径分隔符(`/` `\`,虽 `resolve_session_path` 已防遍历,双保险),空或全非法 → 回退 `upload-<序号>`。
- **前端注入 prompt 时**:用后端返回的实际 path(已 sanitize),故前端无需再处理——**单一真相源是后端返回值**。

> 安全目标:含 `\n[系统指令:…]` 的恶意/畸形文件名既不能破坏注入块格式,也不能落成畸形磁盘文件名。单用户场景威胁有限,但低成本顺手做。

---

## 前端改动清单

| 文件 | 改动 |
|---|---|
| `frontend/src/components/AcpChatView.tsx` | composer 加 📎 按钮 + 两个隐藏 file input(image/* 与 */*,multiple)+ 上传处理 + `pendingAttachments` 状态 + 待发 chip UI(文件名+✕)+ 发送时注入路径 + 清空 |
| `frontend/src/lib/api.ts` | `uploadSessionFile` 返回类型 `Promise<void>` → `Promise<string>`(解析响应 `{path}` 并返回) |
| (prompt 注入纯函数) | 抽 `buildPromptWithAttachments(text, paths): string`(AcpChatView 内或 lib 内),可单测 |

## 后端改动清单

| 文件 | 改动 |
|---|---|
| `src/web.rs` | upload 路由加 `DefaultBodyLimit::max(≈27MB)`(E1);文件上限 10MB→20MB;`next_candidate`(后缀生成纯函数,+单测)+ `dedupe_and_create`(原子,E2);`sanitize_filename`(纯函数,+单测,E3);`upload_session_file` 重写(sanitize→原子去重→写句柄)+ 返回 `Json(UploadResp{path})`;新增 `UploadResp` 结构 |

无 `session_manager.rs`、无 `send_prompt`、无三后端协议改动。无 DB 改动。`DefaultBodyLimit` 需 `axum::extract::DefaultBodyLimit`(确认 axum 版本已含;现有 Cargo 依赖里 axum 应支持)。

---

## 测试策略(goal-driven)

| 单元 | 测试 | 验证标准 |
|---|---|---|
| `next_candidate`(后端纯函数,E2) | `a.png` n=1→`a-1.png`;n=2→`a-2.png`;无扩展名 `log` n=1→`log-1` | `cargo test` |
| `dedupe_and_create`(原子,E2) | `a.png` 不存在→建并返回 `a.png`;已存在→`a-1.png`;`a-1` 也在→`a-2`;**并发**两次同名→两个不同名、都不丢 | `cargo test`,tempdir fixture |
| `sanitize_filename`(后端纯函数,E3) | `截图.png`→原样;`a\nb.png`→剥换行;`../etc`→去分隔符;空/全非法→`upload-N` | `cargo test` |
| upload 端点 | 同名上传两次第二次 path 带后缀;落盘内容正确;**>20MB → 400**;**~25MB body 不被 413 挡**(E1 body limit 生效) | 集成/手动 |
| `buildPromptWithAttachments`(前端纯函数,E4) | 有文字+多附件 / 无文字+单附件 / 无附件→原文;措辞含 "请先用 Read 工具读取" | vitest |
| 手动端到端(手机) | composer 选 2 张截图 + 打字 → 上传 chip 出现 → 发送 → agent 收到带 `./xxx` 的 prompt → **三后端各验证 Read 真打开文件(E4)**;选任意文件(PDF)同理;移除 chip 后该文件不进 prompt;>20MB 提示报错不阻塞其他;**手机真实 ~5MB 截图能传成功(E1 验证)** | 真机 + agent 实际响应 |

命令:`cargo test`、`cargo build`、`npm test`(vitest)、`npm run lint`、`npm run build`。

---

## 风险与边界

- **body limit(E1,已解)**:必须显式设 `DefaultBodyLimit ≈27MB`,否则 axum 默认 2MB 让一切手机照片上传 413。这是 feature 能用的前提,非可选。
- **20MB 限制**:手机原图常 3-12MB,20MB 够绝大多数;超限后端返回 400,前端提示"文件太大(>20MB)",不阻塞其他文件/文字。前端不压缩(YAGNI),频繁撞限再加 canvas 压缩(远期)。
- **重名覆盖(E2,已解)**:`dedupe_and_create` 原子创建 + 后缀重试,并发多截图也绝不覆盖/丢文件。
- **文件名注入/遍历(E3,已解)**:`resolve_session_path` 防 `..`/绝对路径;`sanitize_filename` 剥换行/控制字符/分隔符,防二阶注入 + 注入块格式破坏 + 畸形磁盘名。
- **base64 内存(E5)**:`readAsDataURL` 对大文件占内存;多文件**串行**(非并行)上传缓解手机弱设备卡顿。
- **孤儿文件(E6)**:上传成功但发送前切走会话 → chip 清空、文件已落盘但无 prompt 引用。可接受(work_dir 里一个没引用的文件无害,且文件浏览器可见可手动删)。
- **多文件部分失败**:逐个上传,失败的单独提示,成功的照常进 chip;发送时只注入成功的。
- **scrollback/回放**:附件文件落在 work_dir 里(持久);prompt 注入文本进 scrollback(随会话回放)。不专门记附件元数据(YAGNI)。

---

## NOT in scope / 远期

- **路 B 原生多模态图片 block**:让 Claude"一眼看图"而非 Read 文件。只 Claude stream-json 可能支持,Kiro/Codex 待验证,独立 spec。
- **相机拍照 / 剪贴板粘贴**:本期排除(手机浏览器粘贴支持参差;拍照场景少)。
- **前端图片压缩**:撞 20MB 限制再做。
- **附件历史/缩略图回放**:naozhi 的 event-log 富内容持久化(借鉴清单 #3)是独立大工程,与本期无关。
- **会话专属附件子目录**(`.zeromux-uploads/<id>/`):本期选了 work_dir 根(最简、agent 一眼见)。若仓库根被上传污染成问题,再迁子目录。
