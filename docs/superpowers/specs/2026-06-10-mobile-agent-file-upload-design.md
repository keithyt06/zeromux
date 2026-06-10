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
| 重名冲突 | 后端**自动加后缀**(`a.png`→`a-1.png`),防覆盖用户仓库已有同名文件;返回实际写入文件名 |
| 图片压缩 | **不做**(YAGNI,先看是否真撞 10MB,撞了再说) |
| 多模态 block(路 B) | 不做(远期) |

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

## Feature 1 — 后端重名处理(唯一后端改动)

### 当前行为(要改的)

`upload_session_file`(`web.rs:872`)用 `std::fs::write(&file_path, &bytes)` **直接覆盖**同名文件,且返回 `StatusCode::OK`(无 body)。问题:用户仓库已有 `screenshot.png` 时上传会盖掉;且前端拿不到实际写入名,无法准确注入 prompt 路径。

### 新行为

1. 新增纯函数 `dedupe_filename(dir: &Path, name: &str) -> String`:若 `dir/name` 不存在返回 `name`;否则在扩展名前加 `-1`/`-2`… 直到不冲突(`a.png`→`a-1.png`→`a-2.png`;无扩展名 `log`→`log-1`)。可独立单测。
2. `upload_session_file` 在写盘前对**文件名部分**调用 `dedupe_filename`(仅当 `req.path` 是放进 work_dir 根的简单文件名时;保留现有 `resolve_session_path` 的路径遍历防护)。
3. 响应从 `StatusCode::OK` 改为 `Json(UploadResp { path: 实际写入的相对文件名 })`,供前端注入。

> **兼容性**:`MarkdownViewer` 现有调用方也会收到新响应体。它当前忽略返回值(只 `loadFiles()` 刷新),改动向后兼容(多一个被忽略的 path 字段)。前端 `uploadSessionFile` 的返回类型从 `Promise<void>` 改为 `Promise<string>`(实际 path),`MarkdownViewer` 调用处无需改(忽略返回值即可)。

---

## Feature 2 — composer 附件入口(主要工作量)

### 改动位置

- `frontend/src/components/AcpChatView.tsx` 的 composer 区(`sendPrompt` 附近,`:292`)。
- 复用 `frontend/src/lib/api.ts` 的 `uploadSessionFile`(改返回实际 path)。

### 交互

1. composer 左侧加 📎 附件按钮。点击弹出小菜单(或两个并排小图标):**图片**(触发隐藏 `<input type="file" accept="image/*" multiple>`)、**文件**(触发隐藏 `<input type="file" accept="*/*" multiple>`)。
2. 选中文件后:对每个文件 `FileReader.readAsDataURL` → 取 base64 → `uploadSessionFile(id, file.name, base64)`,期间 composer 上方显示"上传中 N 个"。
3. 每个上传成功 → 用返回的**实际 path** 在 composer 上方加一个**待发附件 chip**(显示文件名 + ✕ 移除按钮)。失败 → 提示该文件失败,不阻塞其他文件。
4. 用户可在发送前点 ✕ 移除某个 chip(仅从待发列表移除;已上传的文件留在磁盘,不做删除 —— YAGNI)。
5. 发送时:把待发 chip 的实际路径拼进 prompt(见格式),`sendPrompt`,清空 chip 列表。

### 待发附件状态

composer 维护 `pendingAttachments: string[]`(实际相对路径)。发送成功后清空。切换会话/视图时清空(附件是 per-compose 的瞬态)。

### 启用条件

附件按钮在 composer 能接收 prompt 时才可用(复用现有 composer enabled / busy 逻辑;会话未运行或 turn 进行中时的行为与现有文字发送一致)。

---

## Feature 3 — prompt 注入格式

纯函数(前端),可单测:

```
<用户文字,可为空>

[我上传了以下文件,请查看:
./screenshot-1.png
./error-log.txt]
```

规则:
- 有附件时,在用户文字后追加附件块(空行分隔)。
- 用户文字为空时,只发附件块(无前导空行)。
- 单附件也用列表格式(保持一致)。
- 路径用 `./<文件名>`(相对会话 cwd,agent Read 可直接用)。
- 与 collect 合并、scheduled-run 等无交互:这是普通交互 prompt,走现有通道。

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
| `src/web.rs` | `dedupe_filename` 纯函数(+单测);`upload_session_file` 写盘前去重 + 返回 `Json({path})`;新增 `UploadResp` 结构 |

无 `session_manager.rs`、无 `send_prompt`、无三后端协议改动。无 DB 改动。

---

## 测试策略(goal-driven)

| 单元 | 测试 | 验证标准 |
|---|---|---|
| `dedupe_filename`(后端纯函数) | 不存在→原名;存在→`-1`;`-1`也存在→`-2`;无扩展名→`name-1` | `cargo test`,tempdir fixture |
| upload 端点返回实际 path | 同名上传两次,第二次响应 path 带后缀;落盘内容正确 | 集成/手动 |
| `buildPromptWithAttachments`(前端纯函数) | 有文字+多附件 / 无文字+单附件 / 无附件→原文 | vitest |
| 手动端到端(手机) | composer 选 2 张截图 + 打字 → 上传 chip 出现 → 发送 → agent 收到带 `./xxx` 路径的 prompt → Read 能读到文件;选任意文件(PDF)同理;移除 chip 后该文件不进 prompt;>10MB 文件提示报错不阻塞 | 真机 + agent 实际响应 |

命令:`cargo test`、`cargo build`、`npm test`(vitest)、`npm run lint`、`npm run build`。

---

## 风险与边界

- **10MB 限制**:手机照片常 3-8MB,够用;原图可能超。前端不压缩(YAGNI),撞限后端返回 400,前端提示"文件太大(>10MB)",不阻塞其他文件/文字。若实际频繁撞限,再加前端 canvas 压缩(远期)。
- **重名覆盖(已解)**:`dedupe_filename` 加后缀,绝不覆盖用户仓库文件。
- **路径遍历**:沿用现有 `resolve_session_path` 的 `..`/绝对路径防护;附件名来自文件选择器(`file.name`),仍经该防护(去重只作用于最终落 work_dir 根的简单文件名)。
- **base64 体积**:base64 比原文件大 ~33%,10MB 文件 → ~13MB JSON body。现有端点已接受此开销(无新 body limit 问题;若 axum 默认 body limit 撞上,实现期确认 `/api/*` 是否需 `DefaultBodyLimit` 调整 —— 现有 MarkdownViewer 上传已在用同端点,说明当前限制够)。
- **多文件部分失败**:逐个上传,失败的单独提示,成功的照常进 chip;发送时只注入成功的。
- **scrollback/回放**:附件文件落在 work_dir 里(持久);prompt 注入文本进 scrollback(随会话回放)。不专门记附件元数据(YAGNI)。

---

## NOT in scope / 远期

- **路 B 原生多模态图片 block**:让 Claude"一眼看图"而非 Read 文件。只 Claude stream-json 可能支持,Kiro/Codex 待验证,独立 spec。
- **相机拍照 / 剪贴板粘贴**:本期排除(手机浏览器粘贴支持参差;拍照场景少)。
- **前端图片压缩**:撞 10MB 限制再做。
- **附件历史/缩略图回放**:naozhi 的 event-log 富内容持久化(借鉴清单 #3)是独立大工程,与本期无关。
- **会话专属附件子目录**(`.zeromux-uploads/<id>/`):本期选了 work_dir 根(最简、agent 一眼见)。若仓库根被上传污染成问题,再迁子目录。
