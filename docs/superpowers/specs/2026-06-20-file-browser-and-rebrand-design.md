# 工作区文件浏览器 + Logo 重塑 — 设计 spec

- 日期：2026-06-20
- 范围：PR 2（B + C，均偏前端，合一分支）。B：把当前 `'files'` overlay 的 markdown 查看器升级为真 · 工作区文件浏览器（真目录树 + 图片/HTML 预览 + 二进制下载 + 安全底座加固）。C：用 lobehub 几何风重塑品牌 logo，保留品牌色。
- 灵感：naozhi PR #2152（workspace file browser）。动机：远程 EC2 上不装 code-server 也能拿文件 / 看 agent 产物。
- 已过 CTO + PM 双重评审（2026-06-20），本 spec 已吸收其 P0/P1 结论。

---

# B. 工作区文件浏览器

## B0. 现状校正（评审 P0 事实）

B **不是从零造**，比概要小一个量级。已存在（`web.rs` + `MarkdownViewer.tsx`）：`list_session_files / get_session_file / write / delete / rename / upload / dir` 全套端点，前端右键菜单 + 内联重命名 + 编辑保存 + 上传都在。**真实缺口只有三块：**

1. **不是真目录树**：`collect_files`（`web.rs`）是扁平 glob 递归、默认 `*.md`、跳过隐藏目录——返回的是「匹配文件扁平列表」，不是「当前目录的子目录 + 文件」。
2. **不支持二进制/图片/pdf**：`get_session_file` 只 `read_to_string`（纯文本、1MB 上限）。
3. **预览类型单一**：只渲染 markdown。

## B1. 写操作：保留但降权（PM 拍板，已采纳）

- 概要原写「UI 不含删除/重命名/建目录」**与现状矛盾**（现在就有）。**决策：保留写操作，收进右键菜单 + 二次确认**，不砍。理由：手机远程 EC2 上「删掉跑歪的产物 / 重命名报告再下载」是真实需求；砍掉制造「为何 code-server 能干你不能」落差。
- **安全模型不依赖 UI 隐藏**：spec 明确——删除/重命名 API 的安全性由 auth + 路径校验保证，不由「前端没画按钮」保证。

## B2. 真实工作量：单层目录列举端点（B 的主要新增）

- 新增 `GET /api/sessions/{id}/dir/list?path=` → 返回该目录下一层的 `{ entries: [{name, type: dir|file, size, mtime, is_writable}], truncated }`，`ReadDir` 上限 2000 + `truncated` 标志。
- 前端用它做单列下钻 + 面包屑。**单列 + 面包屑在手机上够用且更好**（多列窄屏是灾难）。
- 保留现有过滤与安全（见 B4）。`collect_files` 的扁平 glob 保留给「按 pattern 搜索」用途，不删。

## B3. 预览与下载（优先级按手机高频场景）

手机用户高频场景排序（PM）：①看 agent 刚生成的产物（图/架构图/HTML 报告）②下载日志/产物 ③传参考图给 agent（已有，见 B5）。预览优先级：

- **图片预览 P0**：直接服务「agent 到底做出了什么」的视觉验收。
- **HTML sandbox 预览 P0**：「agent 生成网页/报告/dashboard，手机立刻看长啥样」是对「完成了吗」的最强视觉证据。**硬约束见 B4。**
- **文本预览**：已有，复用 `MarkdownContent`（KaTeX/mermaid 管线）。
- **PDF 预览：砍掉（或留接缝）**——EC2 上 agent 生成 pdf 低频，四类里 ROI 最低。
- **二进制下载 P0**：新增 raw 字节流端点（见 B4），任意类型可下载到本地。

## B4. 安全底座加固（评审 P0——B 能不能上的前提）

CTO 读代码发现：现有 read/write/upload **缺 canonicalize 复查、从未用 O_NOFOLLOW**，符号链接 TOCTOU 有真实残留窗口；叠加默认 bind `0.0.0.0`（`main.rs:34`）+ cookie auth + 新增 raw 下载 = 漏洞放大器。**功能升级前必须先补底座。**

1. **统一 `resolve_and_verify(base, rel) -> canonical_path`**：所有端点（list/read/raw/write/upload/delete/rename）走同一函数。canonicalize 后**再次** `starts_with(base_canonical)`（现有 delete/rename 做了，read/write/upload **没做**——补上）；canonicalize 失败（dangling symlink）即拒。
2. **真正堵 TOCTOU**：对最终文件 + **每一级父目录**用 `O_NOFOLLOW`（`OpenOptionsExt::custom_flags(libc::O_NOFOLLOW)`）或 `openat2` + `RESOLVE_BENEATH`/`RESOLVE_NO_SYMLINKS`（6.17 内核支持）。canonicalize+recheck 只缩小窗口、不消除；openat2 才消除。raw 下载用同一路径，**绝不用** `fs::read(path)`。
3. **credential 文件永不枚举**：deny-list（`.env*`/`.aws`/`id_*`/`*.pem`/`*.key`/`.ssh`/凭据名）在 **list 结果集就过滤掉**（不只 read 时拒），且逻辑路径 + canonical 真实路径**各查一次**。
4. **`.git`/`.zeromux`/`.zeromux-worktrees` 可浏览禁写**：禁写在写端点判，判 canonicalize 后真实路径（防 symlink 绕过）。
5. **raw 下载响应头三件套**：`Content-Type: application/octet-stream` + `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment`。预览渲染由前端在受控沙箱做，不靠服务端 content-type。
6. **HTML/SVG 预览**：`<iframe sandbox="" srcdoc=...>`，**绝不加 `allow-same-origin`**（渲染的是 agent 生成的不可信 HTML，应用同源 + cookie auth 下会变成真 XSS/凭证泄露）。markdown 走前端 sanitizer，不 `dangerouslySetInnerHTML` 原文。
7. **全局 CSP 响应头**（纵深防御）：现在 `try_serve_embedded` 无任何 CSP；加上以挡 raw 端点万一漏配。

## B5. 上传修正 + 协同（评审 P1）

- **上传目录 bug**：现有上传只取 `file_name()` 丢目录部分，永远落 work_dir 根。**修正**：上传 target = 当前面包屑目录 join file_name（经 B4 校验）。
- **body-limit**：路由层已 28MB（`web.rs:33`，留了 base64 ×4/3 膨胀余量）。但 JSON 信封开销可能让极限大文件被截断成 413 而非预期 400 → 前端在 20MB 二进制处就拦（更友好）。非流式、内存上限文档化（multipart 流式留接缝，YAGNI）。
- **复用统一上传**：文件浏览器上传复用现有 `uploadSessionFile`，不造第二套逻辑。
- **拆 MarkdownViewer**：拆成 `FileBrowser`（列目录/选文件/预览分发）+ 复用 `MarkdownContent` 渲染 md。MarkdownViewer 现在身兼「文件管理器 + md 渲染器」职责过载。
- **边界与接缝**：GitViewer 管「版本差异」，FileBrowser 管「工作区快照」，不重叠；留 FileBrowser→GitViewer「看 git 历史」跳转接缝。留「→ 发给 agent」动作位（复用已有路径注入上传，MVP 可不接但 UI 留位）。

## B6. 前端结构

- 新建 `FileBrowser.tsx` 替换 `'files'` overlay 当前指向。面包屑 + 单列目录列表 + 每文件下载/预览 + 拖拽上传（XHR 进度 + 409 覆盖提示）。零 inline onclick（沿用项目约定）。
- 预览分发：图片 → `<img src=raw>`；html → sandbox iframe；md/文本 → `MarkdownContent`；其他 → 下载按钮。

## B7. B 的测试（安全矩阵 P0）

- symlink 逃逸（base 内 symlink→base 外，read/raw/write/upload/list 五端点各一例，全拒）、dangling symlink、`..` 词法、绝对路径注入。
- credential deny-list：逻辑路径 + canonical 双查；**list 结果不含 credential 文件**。
- `.git` 禁写。
- raw 端点三件套响应头齐全；HTML/SVG 下载不被 inline 执行。
- 上传落当前目录（非根）；20MB 边界（成功）/ 20MB+1（前端拦 / 400 非 413）。

---

# C. Logo 重塑（lobehub 几何风，内联 SVG，零新依赖）

## C0. 现状

- 现 logo = Keith Haring「黄底黑 Z + 四角 tick」，`HaringLogo.tsx` + `favicon.svg`，品牌色 `#f7b500`，出现在登录页 + favicon + theme-color。上次重塑见 `docs/superpowers/specs/2026-06-06-haring-rebrand-ui-polish-design.md`，本次替换该 Haring 风格。
- 仓库刻意不引 `@lobehub/icons`（8MB + antd peer deps），但 `BrandIcons.tsx` 已内联 lobehub 的 SVG path——**沿用此做法：内联 SVG 匹配 lobehub 美学，零新依赖。**

## C1. 品牌叙事与方向（PM）

- 名字 = **Zero**（单二进制 / 零依赖 / 零配置）× **Mux**（多路复用 / 多会话 / 多 agent 流）。现 logo 只讲了 Z，没讲 Mux，也没讲「终端」气质。
- 出 3 个候选让用户选，**我内心排序：多路复用 ≥ Z 现代化 > `>_`**：
  1. **多路复用向（首选）**：多条流汇聚/分叉的几何；可让 Z 的对角线本身就是「多路汇聚」隐喻——一个符号同时讲 Z + Mux，最省心，也最契合差异化（不是又一个终端，而是一人稳定盯住多条 agent 流）。
  2. **Z 现代化向**：把黑 Z 重绘成 lobehub 风 squircle，保留品牌延续。
  3. **`>_` 终端向**：呼应「Web 终端」本质，但太通用（每个终端工具都用）。

## C2. 视觉约束

- **保留品牌色 `#f7b500`**（用户嫌的是 Haring 风格不是这抹黄；它是唯一品牌资产，换掉是净损失）。**重塑的是形不是色。**
- 采用 lobehub 几何简洁，但**保留单色/双色硬朗，不上多色渐变**（否则终端复用器看起来像消费级 App，丢掉终端气质）。

## C3. 落地与一致性清单

- `HaringLogo.tsx` → 改名 `BrandLogo`（或并入 `BrandIcons.tsx` 统一管理），返回内联 `<svg>` React 组件（不走静态资产路径，免额外 HTTP + 缓存更新问题）。
- 一致性替换 6~7 处：`favicon.svg`、`index.html` theme-color、PWA `manifest.json`（**当前缺失**——补 192/512 icon）、`index.css --accent-brand`、`LoginPage.tsx`、`Sidebar.tsx`、组件改名引用。
- **工程坑（CTO）**：manifest.json/favicon.svg 必须真打进 Vite bundle 并 embed，否则未知路径被 `try_serve_embedded` SPA fallback 静默返回 `index.html`（content-type 错乱，难排查）。
- 若加 CSP（见 B4.7），放行 inline SVG / data-URI favicon。

## C4. C 的范围警告

- C 是三项里对核心命题**杠杆最低**——品牌债不是能力债。做，但**不写厚 spec、不阻塞 B**。流程：出 3 候选 → 用户选 → 替换 6~7 文件。
- **砍掉**：换品牌色、多色渐变。

## C5. C 的测试

- smoke：`GET /manifest.json` 断言 content-type 是 manifest 而非 `text/html`（防 SPA fallback 吞掉）；`GET /favicon.svg` 同理。
- 前端：BrandLogo 渲染 + 各引用点不报错。

---

# 交付

- 分支 `feat/file-browser-and-rebrand`，worktree 隔离，subagent-driven TDD，执行用 opus。
- C 的 logo 候选先渲染出实际 SVG（截图）给用户选定，再定稿。
- 完成后双评审（我 + codex）→ 合并 main + push → 部署 live 需用户点头。
