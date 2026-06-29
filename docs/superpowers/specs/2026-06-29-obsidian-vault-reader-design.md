# Obsidian Vault 只读阅读器 — 设计文档

日期:2026-06-29
状态:已批准设计,待写实现计划

## 背景与动机

用户有一个真实的 Obsidian vault(`/home/ubuntu/s3-workspace/keith-space/obsidian`,568 篇 `.md`,含 `.obsidian` 配置和 knowledge/projects/journals/life 等分类目录),希望在手机/浏览器上**浏览目录树、打开任意 `.md` 渲染成可读页面**,主要用于阅读。

调查结论(已核实):
- 用户提到的 `feynote.keithyu.cloud`「我的笔记」无反应,**不是 bug**:feynote 是独立的原型应用(Rust/axum,8091 端口),后端只有 `/api/health` + 静态托管,Obsidian 集成"待接入"(README 明示),该逻辑从未实现。
- ZeroMux(`zeromux.keithyu.cloud`,8090)已有成熟的文件浏览 + Markdown 渲染 + 鉴权 + 敏感目录安全底座,复用度最高。

决策(已与用户确认):**做进 ZeroMux**,不在 feynote 实现。接受代价:阅读功能在 zeromux.keithyu.cloud 下出现,feynote 的「我的笔记」按钮仍无反应(属另一应用,本 spec 不修)。

## 范围决策(已确认)

- 宿主:**ZeroMux**(非 feynote)。
- 入口:侧栏固定「📓 笔记库」全局入口(仿 `AdminPanel`/`ScheduledTasksPanel` 模式),不绑定任何会话。
- 数据通路:**方案 A —— 新增 vault 专用只读端点**(不寄生在某个 session 上)。理由见下"为何不复用现有端点"。
- 模式:**严格只读**。无新建/编辑/上传/删除/重命名。
- vault 路径:**A1 —— `--vault-dir` CLI 参数**,默认指向上述 vault;单 vault(不做多 vault 切换)。
- Obsidian 语法:**一期** = 目录树 + 普通 Markdown 渲染 + 图片显示。

## 非目标(防范围蔓延)

- 不做任何写操作(编辑/新建/删除/上传/重命名)。
- 不做 `[[双链]]` 点击跳转、`![[嵌入笔记]]`、`.canvas`、callout(`> [!note]`)、`#标签`聚合、frontmatter 特殊渲染——记为二期候选。
- 不做全文搜索(二期候选)。
- 不做多 vault 切换。
- 不修 feynote(独立应用)。
- 不复用 per-session 的 overlay 状态机(笔记库是全局视图)。

## 为何不复用现有 file/dir 端点(方案 A vs B)

现有 `GET /api/sessions/{id}/dir/list`、`/file`、`/file/raw` 都过 `require_session_access`——**即使带 `base_dir` override,也必须存在一个属于当前用户的真实 session**。没有"脱离 session 浏览"的路径。

- 方案 B(借一个 session id 复用):零后端改动,但脆弱——用户一个 session 都没有时笔记库打不开;语义别扭(浏览 vault 却要借会话);且把"全局阅读"耦合到某个会话生命周期。
- **方案 A(采纳):新增 vault 专用只读端点**,职责单一,不依赖任何会话存在,安全面更可控。后端新增两个只读 handler,全部复用现有 `ensure_under_home` + 敏感目录守卫 + 凭证过滤 + 1MB 上限 helper。

---

## 后端设计

### 配置

`src/main.rs`:
- `Args` 加 `#[arg(long)] vault_dir: Option<String>`(无默认值;未提供则功能禁用)。
- 启动时若提供:展开 `~`(同 `data_dir` 的处理,main.rs ~192)、`canonicalize`、校验在 `$HOME` 下且非敏感目录(复用 `ensure_under_home` 同款逻辑);校验失败则打印 warning 并视为未配置(不 panic,不阻止启动)。
- `AppState` 加 `pub vault_dir: Option<String>`(存校验后的 canonical 绝对路径)。
- live systemd unit 的 `ExecStart` 追加 `--vault-dir /home/ubuntu/s3-workspace/keith-space/obsidian`(部署时改 unit)。

### 端点(`src/web.rs`,挂在已鉴权的 `/api/*` 组下,但**不**过 `require_session_access`)

1. `GET /api/vault/meta` → `{ enabled: bool, name: String }`
   - `enabled = state.vault_dir.is_some()`;`name` = vault 目录的 basename(供前端标题/入口显隐)。
   - 前端据此决定是否显示「📓 笔记库」入口。

2. `GET /api/vault/list?path=<rel>` → `{ entries: [DirEntryOut], truncated: bool }`
   - `path` 为 vault 内相对路径(默认根),用于逐层展开。
   - 在 `state.vault_dir` 基础上解析:复用现有的相对路径拼接 + `canonicalize` + `starts_with(vault_dir)` 校验(挡 `../` traversal),复用现有 `DirEntryOut`(name/type/size/mtime/writable)、目录优先排序、2000 项上限、凭证文件过滤(`.env`/`*.pem`/`id_*`/`*credentials`)。
   - `vault_dir` 为 None → 404 / `{enabled:false}`。
   - 一期前端只展示 `.md` 文件和目录 + 图片(由前端过滤;后端照常返回全部,简化)。

3. `GET /api/vault/file?path=<rel>` → `{ path, content }`(Markdown 文本,1MB 上限,同 `get_session_file`)。

4. `GET /api/vault/file/raw?path=<rel>` → 原始字节(图片用),`Content-Type: application/octet-stream` + `X-Content-Type-Options: nosniff`,带 `?token=` 鉴权(同 `get_file_raw`)。

**复用而非重写**:把现有 `list_dir`/`get_session_file`/`get_file_raw` 里"解析 base + 校验 path + 读取"的核心逻辑抽成共用 helper(以 base_dir 为参数),vault 端点传 `state.vault_dir`,session 端点传 `resolve_base_dir(...)` 的结果。若抽取成本过高,vault 端点可独立实现但必须逐一对齐安全校验(canonicalize + starts_with + 凭证过滤 + 大小上限)。实现时取较干净的一种,并在测试里钉死安全等价性。

### 安全

- vault 端点只读,绝不写。
- `path` 经 `canonicalize` + `starts_with(vault_dir)`,挡 `../` 逃逸和符号链接逃逸。
- vault_dir 本身在启动时已校验"在 $HOME 下且非敏感目录"。
- 凭证文件过滤沿用现有 denylist(vault 里若混入 `.env` 等不被枚举)。
- 鉴权:挂在 `/api/*`(过 `auth_middleware`);因无 session 概念,不做 owner 校验——任何已登录用户都能读 vault(单用户部署可接受;多用户 OAuth 下 vault 是共享只读参考库,符合预期)。

---

## 前端设计

### 入口(`Sidebar.tsx`)

- header 右侧图标栏(`Clock`定时任务 与 `Users`管理 之间或之后)加一个「📓 笔记库」图标按钮(lucide `BookText` 或 `Notebook`)。
- 仅当 `GET /api/vault/meta` 返回 `enabled:true` 时显示。
- 本地 state `const [showVault, setShowVault] = useState(false)`,点击 `setShowVault(true)`;`{showVault && <NoteVaultPanel onClose={() => setShowVault(false)} />}`(仿 `AdminPanel` 的 `absolute inset-0 z-50` 全屏覆盖)。

### `NoteVaultPanel.tsx`(新建)

- 全局组件,**不接收 sessionId**;Props `{ onClose: () => void }`。
- 布局:左目录树(可展开/收起目录,调 `GET /api/vault/list?path=`),右内容区(选中 `.md` → 调 `GET /api/vault/file` → `<MarkdownContent text={content} isComplete={true} />` 渲染)。
- 左侧只显示目录 + `.md` 文件(前端过滤 entries),图片等非 md 不在树里列(一期阅读为主)。
- 图片渲染:`MarkdownContent` 里相对图片路径 `![](attachments/x.png)` 需重写为 `/api/vault/file/raw?path=...&token=...`。一期最小处理:在 `NoteVaultPanel` 渲染前对 content 做相对图片 URL 改写(把相对 src 指向 vault raw 端点),或在 `MarkdownContent` 接一个可选的 `resolveSrc` 回调。取较小改动者,实现时定。
- **只读**:无任何 Create/Edit/Save/Upload/Delete 按钮(区别于 `FileBrowser`/`MarkdownViewer` 的可写 UI)。
- 移动端:全屏,顶部返回/关闭按钮;目录树可折叠(仿现有 overlay 的移动适配)。

### `lib/api.ts`(新增客户端)

- `getVaultMeta(): Promise<{ enabled: boolean; name: string }>`
- `listVault(path = ''): Promise<{ entries: DirListEntry[]; truncated: boolean }>`(复用现有 `DirListEntry` 类型)
- `getVaultFile(path: string): Promise<string>`(返回 content)
- `vaultRawUrl(path: string): string`(带 token,供 `<img src>`)

---

## 数据流

入口显隐:App/Sidebar 挂载时 `getVaultMeta` → enabled 决定是否渲染「笔记库」图标。
浏览:点图标 → `NoteVaultPanel` 打开 → `listVault('')` 列根 → 点目录递归 `listVault(rel)` → 点 `.md` → `getVaultFile(rel)` → `MarkdownContent` 渲染;图片经 `vaultRawUrl`。纯拉取、只读、无 WS、无持久状态。

## 错误处理

- vault 未配置:`/api/vault/*` → `{enabled:false}`/404;前端不显示入口。
- path 逃逸/不存在:400/404(canonicalize 失败或 starts_with 不成立)。
- 文件 >1MB:400(同 `get_session_file`);前端提示"文件过大,暂不支持预览"。
- 非 md 文件被点(理论上树里已过滤):前端忽略或提示。

## 测试(TDD)

**后端(Rust 内联 `#[cfg(test)]`)**:
- vault path 校验:合法相对路径解析正确;`../` 逃逸被拒(canonicalize + starts_with);符号链接逃逸被拒。
- vault_dir 未配置 → meta `enabled:false`。
- 凭证文件不被 `vault/list` 枚举(parity:与现有 denylist 一致)。
- 启动校验:vault_dir 指向敏感目录/$HOME → 视为未配置(warning,不启用)。
- 文件 >1MB → 400。

**前端(vitest)**:
- vault meta enabled 控制入口显隐(纯逻辑可抽 `shouldShowVault(meta)`)。
- 目录树:entries 过滤(只留 dir + .md),目录展开调用正确 path。
- 相对图片 URL 改写为 vault raw 端点(纯函数 `rewriteVaultImageSrc(content, base)` 或等价)。
- NoteVaultPanel 只读:断言无 Create/Edit/Upload 按钮渲染。

## 改动文件清单

后端:
- `src/main.rs` — `Args.vault_dir` + 启动校验 + `AppState.vault_dir`。
- `src/web.rs` — `/api/vault/{meta,list,file,file/raw}` 四个 handler + 路由 + 抽取/对齐的安全 helper。

前端:
- `frontend/src/lib/api.ts` — 4 个 vault 客户端函数。
- `frontend/src/components/Sidebar.tsx` — 「📓 笔记库」入口 + showVault state(meta-gated)。
- `frontend/src/components/NoteVaultPanel.tsx` — 新建只读阅读面板。
- (可能)`frontend/src/components/markdown/MarkdownContent.tsx` — 若走 `resolveSrc` 回调方案,加一个可选 prop。
- `frontend/src/App.tsx` — App 挂载时拉 `getVaultMeta` 并下传(或在 Sidebar 内自取,取较简者)。

部署:
- live systemd unit `ExecStart` 追加 `--vault-dir /home/ubuntu/s3-workspace/keith-space/obsidian`。

## 二期候选(本 spec 不做,记一笔)

- `[[双链]]` 解析为可点击跳转(需 vault 内文件名索引)。
- `![[嵌入]]`、`.canvas`、callout、frontmatter 渲染。
- 全文搜索(568 篇,可能是阅读外最高频诉求)。
- 多 vault 切换。
- 修 feynote「我的笔记」(独立应用,另立项)。
