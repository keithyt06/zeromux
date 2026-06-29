# Obsidian Vault 只读阅读器 — 设计文档

日期:2026-06-29
状态:经 CTO + PM 双重对抗评审重写,待写实现计划

## 背景与动机

用户有一个真实 Obsidian vault(`/home/ubuntu/s3-workspace/keith-space/obsidian`),希望在手机/浏览器上浏览并阅读其中的 `.md` 笔记。**实测数据(决定设计的硬约束)**:
- 568 篇 `.md`;目录嵌套深(**232 篇在第 8 层、87 篇第 7 层、64 篇第 6 层**)。
- **452 篇(80%)含 `[[双链]]`,双链总数 2554 处** —— 这是一个高度互链的知识网络,双链是其主导航结构。
- 含 `.obsidian` 配置、`attachments/`/`assets/` 图片、`canvas/` 等目录。

调查结论:用户提到的 `feynote.keithyu.cloud`「我的笔记」无反应**不是 bug**——feynote 是独立原型应用(Rust/axum,8091),后端只有 `/api/health` + 静态托管,Obsidian 集成"待接入"(从未实现)。决定做进 ZeroMux(`zeromux.keithyu.cloud`,8090),复用其文件读取 + Markdown 渲染 + 鉴权 + 安全底座。

## 一期范围:按"阅读闭环"切,而非按工程难度切

PM 评审的核心结论:**阅读闭环 = 找到那篇(搜索/最近)+ 读它(渲染)+ 顺着读下去(双链跳转)**。原设计按"好不好做"把搜索和双链推到二期,导致一期技术完整但产品残缺(用户第一次想读就卡在"找不到",读到第一个 `[[链接]]` 就卡在"跳不过去",且两个卡点都在最高频动作上)。故一期必须含搜索 + 双链。

一期(本 spec):
- 目录树浏览 + 普通 Markdown 渲染 + 图片显示。
- **文件名/路径搜索**(8 层深、568 篇,无搜索=手机上弃用级)。
- **双链 `[[...]]` 点击跳转**(basename → relpath 索引)。
- **最近打开**列表(前端 localStorage,零后端)。
- 手机**两段式布局**(列表态 ↔ 阅读态)+ 为长文调过的阅读容器。
- feynote「我的笔记」按钮做跳转/提示,消除静默无反应。
- 严格只读;入口命名避开"笔记"(用「Obsidian」)。

二期(不做,记录):`![[嵌入]]`、`.canvas`、callout(`> [!note]`)、frontmatter 特殊渲染、**全文内容搜索**、多 vault、阅读位置记忆、agent 读 vault(独立大特性)。

## 非目标(防范围蔓延)

- 不做任何写操作(编辑/新建/删除/上传/重命名)。
- 二期项一律不做(见上)。
- 不修 feynote 后端集成(仅改其按钮 onClick 做跳转/提示)。
- 不复用 per-session overlay 状态机(笔记库是全局视图)。

---

## 后端设计

### 配置(`src/main.rs`)

- `Args` 加 `#[arg(long)] vault_dir: Option<String>`,**无代码默认值**(未提供则功能禁用)。live 部署由 systemd unit `--vault-dir` 注入路径。
- 启动时若提供:展开 `~`、校验复用抽出的 `validate_browse_root`(见下);失败则打 warning 并视为未配置(不 panic、不阻止启动)。
- `AppState` 加 `pub vault_dir: Option<String>`(canonical 绝对路径)+ `pub vault_index: Option<Arc<VaultIndex>>`(双链 basename 索引,见下)。

### 安全 helper 抽取(消除漂移,CTO P1)

**强制复用,不得重写任何路径/敏感判定**:
- 现有 `resolve_and_verify(base_canonical, rel)`(web.rs ~1107,词法 `..` + canonicalize + starts_with)、`list_dir_entries(base, rel)`(~1183,已是纯函数,含凭证过滤/2000上限/排序)、`descends_into_sensitive_dir`(~1066)、`is_credential_path`(~1025)—— vault 端点直接调用,传 `state.vault_dir` 作为 `base_canonical`。
- 新抽 `read_text_file_capped(base, rel) -> Result<(String, bool)>`(把 `get_session_file` 的 size 检查 + 读取段抽出,返回内容 + 是否截断;session 端点也改用它)。
- 新抽 `validate_browse_root(dir: &str) -> Result<PathBuf, String>`(把 `ensure_under_home` 的判定核心抽出:canonicalize + 在 $HOME 下 + is_dir + 非敏感目录);`ensure_under_home`(HTTP 版)与启动校验共用,杜绝漂移。

### 双链索引(`VaultIndex`)

- 启动时(或首次访问惰性)遍历 vault,建 `HashMap<String, String>`:Obsidian 双链按 **basename**(无扩展名)解析 → 相对路径。例:`EKS 网络模型` → `knowledge/aws/EKS 网络模型.md`。568 项,内存几 KB。
- 同名冲突:保留第一个 + 记录(一期简单处理;Obsidian 自身也按最近/同目录优先,二期再精化)。

### 端点(`src/web.rs`,挂 `/api/*` 鉴权组,**admin-only**)

**鉴权(CTO P1)**:每个 vault 端点开头 `require_admin(&user)`(`if !user.is_admin() { 403 }`)。legacy 单用户模式 `CurrentUser::legacy()` 是合成 admin → 无感;OAuth 多用户下只有 admin(=vault 主人)能读,杜绝把私人 journals 暴露给其他 active 用户。

1. `GET /api/vault/meta` → `{ enabled, name }`(`enabled = vault_dir.is_some()`;`name` = vault basename)。前端据此显隐入口。
2. `GET /api/vault/list?path=<rel>` → `{ entries, truncated }`(调 `list_dir_entries(vault_dir, path)`)。
3. `GET /api/vault/file?path=<rel>` → `{ path, content, truncated }`(调 `read_text_file_capped`;**超 1MB 读前 1MB + `truncated:true`**,不整篇拒绝——阅读器场景"看部分">"看不了",CTO P2)。
4. `GET /api/vault/file/raw?path=<rel>` → 图片原始字节(见下,**不照抄 get_file_raw**)。
5. `GET /api/vault/search?q=<query>` → `{ results: [{ path, name }] }`(一期=文件名/路径模糊匹配,遍历索引或 list;**全文内容搜索二期**)。
6. `GET /api/vault/resolve?name=<basename>` → `{ path }` 或 404(双链点击时解析 basename → relpath;或前端直接拿 meta 时下发的索引,二选一,实现时取较小传输者)。

### 图片端点设计(CTO P0,**不照抄 get_file_raw**)

`get_file_raw` 强制 `Content-Disposition: attachment` + `application/octet-stream` + `nosniff`,目的本就是阻止内联渲染——照抄则 `<img>` 触发下载、图片必坏。vault raw 端点改为:
- 按扩展名**白名单**:`png/jpg/jpeg/gif/webp` → 发**真实 `image/<type>` Content-Type** + `inline`(去掉 attachment),保留 `nosniff`。
- **白名单外(含 `.svg`)→ 仍 `octet-stream + attachment + nosniff`**(SVG 是 XSS 载体,一期不内联)。
- 全局 CSP `img-src 'self'` 允许同源该端点,无需改 CSP。
- 仍走 `resolve_and_verify`(path 安全)+ admin-only。

### 安全小结

- 只读,绝不写。
- path:`resolve_and_verify`(词法 + canonicalize + starts_with vault_dir,挡 `..` 与符号链接逃逸)。
- vault_dir 启动时经 `validate_browse_root` 校验(在 $HOME 下 + 非敏感目录)。
- 凭证文件沿用 `is_credential_path` 过滤。
- 鉴权 admin-only。
- 图片白名单 + SVG 不内联,避免 XSS。

---

## 前端设计

### 入口(`Sidebar.tsx`)

- header 图标栏加「Obsidian」入口(lucide `BookOpen`/`Library`;**命名避开"笔记"**,与现有 Notes 区分:Notes=随手记/可写/跟会话,Obsidian=知识库/只读/全局)。
- 仅当 `getVaultMeta()` 返回 `enabled:true` 显示。
- `const [showVault, setShowVault] = useState(false)` + `{showVault && <VaultReader onClose={...} />}`(仿 AdminPanel 全屏覆盖)。

### `VaultReader.tsx`(新建,全局,不接 sessionId)

**手机两段式布局(PM P1)**——非"折叠侧栏",而是:
- **列表态**(全屏):顶部搜索框 + 最近打开 + 目录树。
- **阅读态**(全屏):正文 + 顶部返回按钮(回列表态)。
- 桌面可左右分栏(列表窄栏 + 阅读区),手机走两段式切换。

组件构成:
- **搜索框**:输入 → `getVaultSearch(q)` → 结果列表点击进阅读态。
- **最近打开**:localStorage 存最近 10 篇 relpath,列表态顶部展示。
- **目录树**:`listVault(path)` 递归;**前端过滤掉 `.obsidian`/`.trash`/`.` 开头目录 + 只显示 dir 与 `.md`**(CTO P2)。
- **阅读区**:`getVaultFile(rel)` → `<MarkdownContent text={content} resolveSrc={...} onWikiLink={...} />`;`truncated` 时提示"内容过长,仅显示前 1MB"。
- **阅读态容器**:为长文调过(限宽 measure、加大字号/行距、暗色跟随)——不直接套 agent 聊天的默认渲染(PM P1)。

### `MarkdownContent.tsx` 扩展(可选 prop,不影响 agent 聊天路径)

- 加可选 `resolveSrc?: (src: string) => string`:透传给 react-markdown 的 img 处理(`components.img` 或 `transformImageUri`),只对真正的 image node 生效;VaultReader 注入,把相对 img src → `vaultRawUrl(join(noteDir, rel))`。默认 undefined → 行为不变(CTO P0)。
- 加可选 `onWikiLink?: (basename: string) => void`:渲染 `[[X]]` 为可点击元素,点击回调由 VaultReader 用索引解析并打开目标(PM P0)。默认 undefined → `[[X]]` 渲染为纯文字(agent 聊天不受影响)。

### `lib/api.ts`(新增)

- `getVaultMeta()`、`listVault(path)`、`getVaultFile(path)`、`vaultRawUrl(path)`、`getVaultSearch(q)`、`resolveWikiLink(name)`(或 meta 下发索引)。复用现有 `DirListEntry`。

### feynote 按钮处置(PM P0,消除答非所问)

- feynote 是静态托管。改 `/home/ubuntu/feynote/frontend/index.html` 里「我的笔记」按钮的 onClick:跳转到 `https://zeromux.keithyu.cloud`(并可提示"笔记阅读已迁移至 ZeroMux")。仅前端一行级改动,不碰 feynote 后端。重启/重载 feynote 静态资源生效。

---

## 数据流

入口显隐:Sidebar 挂载 `getVaultMeta` → enabled 决定显隐。
阅读:点入口 → VaultReader → 列表态(搜索/最近/目录树)→ 选篇 → 阅读态 `getVaultFile` → `MarkdownContent` 渲染(图片经 `resolveSrc`→vault raw;双链经 `onWikiLink`→索引解析→打开)。纯只读拉取,无 WS。

## 错误处理

- vault 未配置/非 admin:meta `enabled:false` / 端点 403;前端不显示入口。
- path 逃逸/不存在:400/404。
- 文件 >1MB:读前 1MB + `truncated:true`(不拒绝)。
- 双链 basename 无命中:点击提示"未找到对应笔记"。
- 图片白名单外:浏览器按 attachment 处理(不内联),不报错。

## 测试(TDD)

**后端(Rust 内联)**:
- vault path:合法解析;`../` 拒;符号链接逃逸拒(复用 `resolve_and_verify` 既有覆盖)。
- vault_dir 未配置 → meta `enabled:false`;指向敏感目录/$HOME → `validate_browse_root` 拒 → 视为未配置。
- 凭证文件不被 list 枚举(parity)。
- admin-only:非 admin → 403(legacy 合成 admin → 通过)。
- 文件 >1MB → 读前 1MB + `truncated:true`(非 400)。
- 图片端点:png/jpg → `image/*` + inline;svg → octet-stream + attachment。
- 双链索引:basename → relpath 解析正确;同名冲突取第一个。
- 文件名搜索:query 匹配 path/name。

**前端(vitest)**:
- meta enabled 控制入口显隐(纯函数)。
- 目录树过滤(滤 `.obsidian`/`.trash`/`.`开头,只留 dir+.md)。
- `resolveSrc` 相对图片 → vault raw URL(纯函数 + 默认 identity 不影响聊天)。
- `onWikiLink`:`[[X]]` 渲染为可点击,点击触发 basename 回调;无 prop 时纯文字。
- 最近打开 localStorage 读写。
- 搜索结果点击进阅读态。

## 改动文件清单

后端:
- `src/main.rs` — `Args.vault_dir` + 启动校验(`validate_browse_root`)+ `AppState.vault_dir`/`vault_index`。
- `src/web.rs` — 6 个 vault 端点 + admin-only 守卫 + 抽 `read_text_file_capped`/`validate_browse_root` + 复用现有 path/凭证 helper + 图片白名单 Content-Type + `VaultIndex` 构建。

前端:
- `frontend/src/lib/api.ts` — 6 个 vault 客户端函数。
- `frontend/src/components/Sidebar.tsx` — 「Obsidian」入口(meta-gated)+ showVault。
- `frontend/src/components/VaultReader.tsx` — 新建:两段式只读阅读面板(搜索/最近/目录树/阅读态)。
- `frontend/src/components/markdown/MarkdownContent.tsx` — 加可选 `resolveSrc` + `onWikiLink`(默认不影响 agent 聊天)。

feynote:
- `/home/ubuntu/feynote/frontend/index.html` — 「我的笔记」按钮 onClick 跳转 zeromux + 迁移提示。

部署:
- live systemd unit `ExecStart` 追加 `--vault-dir /home/ubuntu/s3-workspace/keith-space/obsidian`。

## 双评审采纳记录

CTO:
- P0:vault raw 端点不照抄 get_file_raw → 图片白名单(png/jpg/jpeg/gif/webp)发真实 image/* + inline,SVG 不内联。
- P0:图片 src 重写是一期阻塞项 → `MarkdownContent.resolveSrc` 回调(非字符串预处理)。
- P1:删"可独立实现/二选一" → 强制复用 `resolve_and_verify`/`list_dir_entries`/`descends_into_sensitive_dir`/`is_credential_path`,只抽 `read_text_file_capped`。
- P1:vault 端点 admin-only(legacy 合成 admin 单用户无感),不再"全 active 用户可读"。
- P2:抽 `validate_browse_root` 共用启动+HTTP 校验;删默认值矛盾(无代码默认值);超 1MB 读前 1MB 不拒绝;前端滤 `.obsidian`/`.trash`。

PM:
- P0:一期加文件名/路径搜索(全文搜索降级二期)。
- P0:一期加双链 `[[...]]` 点击跳转(basename 索引)。
- P0:feynote「我的笔记」按钮跳转/提示,消除静默无反应。
- P1:手机两段式布局(列表↔阅读)+ 长文阅读容器(限宽/字号/暗色)。
- P2:入口命名避开"笔记"(用「Obsidian」),与现有 Notes 区分;最近打开(localStorage)。
- 记录不做:agent 读 vault(独立大特性,一期后端的搜索+索引已为其铺路)。
