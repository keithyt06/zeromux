# 模糊搜索 —— New Session 目录 + Obsidian 文件夹/笔记 — 设计

日期：2026-09-25
状态：v2（已经 CTO + PM 交叉 review 并修订，待用户审阅）

## 修订记录

**v2（本版）** —— CTO（技术）+ PM（产品）并行交叉 review。两位 reviewer 的关键断言
均由本人复核（本 repo 教训：reviewer 方向对但细节常编造，一律不采信未核实的断言）：
线上 journal `06:23:33 serving vault → 06:24:19 listening` 证实 vault 同步遍历 46s；
`deploy.sh:82` 注释证实健康检查 90s 窗口即为此；`~/.zeromux/zeromux.db` 中 12 个 dir
frecency 路径有 3 个在 vault 内；`Sidebar.tsx:183-188` + `:811` 证实选类型后进 prompt 页
且 textarea `autoFocus`；`docTabs.ts:1` 证实 DocTab 只有 `{id,title,kind}`。

v2 相对 v1 的实质改动：

| # | 改动 | 来源 | 理由 |
|---|---|---|---|
| 1 | vault 索引也改为**启动异步构建** | CTO MAJOR-1 | 现状同步遍历 46s 阻塞 listener bind；顺手把 deploy/重启宕机窗口从 ~46s 降到秒级 |
| 2 | 目录索引**不再排除 vault 子树** | CTO MAJOR-2 / PM P1-3 | 用户真实在 vault 文件夹里开 agent（3/12）；同一路径在「目录」「笔记」两段语义不同（开会话 / 读），不算重复 |
| 3 | IndexSlot 状态机补全（未建/首建/刷新/panic 复位） | CTO MAJOR-3 | v1 首建期间会双重遍历；panic 后 `rebuilding` 永不复位 = 永不刷新 |
| 4 | VaultDir 只收「子树含 .md」的文件夹 | CTO MAJOR-4 | 2124 个文件夹只有 409 个含笔记，231 个是 `__pycache__` 等 |
| 5 | frecency 加分写死公式 + 按 path 聚合 | CTO MAJOR-5 | v1「成比例有上限」不可实现；表按 `(path, agent)` 分行 |
| 6 | 目录结果**一击直达**（有历史 agent 时） / 选类型后直接创建 | PM P0-1 | v1 点目录 → 选类型 → prompt 页 + 第二次弹键盘，退化成老流程 |
| 7 | 输入框放弹层底部 + 结果区限高 + visualViewport 补偿 | PM P0-2 | 弹层 `bottom-full` 向上长，v1 顶部输入框会被 40 条结果顶出屏 |
| 8 | 目录零结果时**立即触发刷新** | PM P0-3 | 「刚 clone 的 repo」是核心场景，10 分钟 TTL 下必然搜不到 |
| 9 | 每段 6 条、按段内最高分排段序 | PM P1-2 | 每段 20 条 × 48px 远超弹层高度；固定「目录在前」会埋掉笔记 |
| 10 | 删 `/api/vault/search`，不留兼容壳 | CTO MINOR-6 / PM P1-7 | 前端 rust-embed 进同一二进制，不存在版本错位 |
| 11 | 点笔记**复用最近的 doc tab**；`target` 只存内存 | PM P1-5 / CTO MINOR-7 | 每点一次新开 tab，手机上越开越多，且每个 tab 常驻挂载一份 VaultReader |
| 12 | 删 QuickTargets `onEmpty` + `failed` | PM P2-1 | 首屏有搜索框后空壳论据不成立；`Sidebar.tsx:519` 是唯一调用方 |

## 背景

两个入口都缺「搜」：

1. **New Session 选目录**只能逐层点（`Sidebar.tsx` `pick-dir`），每层一次
   `GET /api/directories`，JuiceFS 上带 8s abort。QuickTargets Top5
   （`2026-09-13-quick-targets-design.md`）只覆盖**用过的**目录；找一个从没开过的 repo
   仍要点 5 层。
2. **VaultReader 搜索**（`web.rs:3523` `vault_search_filter`）：
   - 纯子串 `contains`：`zmx` 搜不到 `zeromux`，`gsai` 搜不到 `github-search/ai`；
   - 只索引 `.md`，**不含文件夹**；
   - **不排序**，按遍历序截前 100；
   - 索引**只在启动时同步建一次**（`main.rs:434`），新笔记重启前搜不到，且这一次遍历
     让启动阻塞 46s。

### 实测规模（2026-09-25）

`$HOME` 目录（跳过 dot / node_modules / target / __pycache__；Rust `read_dir + file_type`
模拟实现冷缓存口径）：

| maxdepth | 目录数 | 耗时 |
|---|---|---|
| 5 | 274 | 1.2s |
| 6 | 650 | 3.7s |
| 7 | 2462 | 8.0s |

vault（`~/s3-workspace/keith-space/obsidian`，JuiceFS）：2124 个文件夹（其中子树含 .md 的
409 个）、9680 个文件（662 个 `.md`），完整遍历 **46s**。

nucleo 性能（CTO 实测）：128 字符 / 64 atom 最坏查询扫 7000 条 13.8ms；常规查询亚毫秒。

结论：不能现场遍历；内存全量匹配毫秒级。

## 目标 / 非目标

目标：
- New Session 首屏搜索框：同一次输入出「目录」「笔记」两段结果，fzf 式子序列匹配 + 排序。
  - 点目录 = 以它为 work_dir 建会话（有历史 agent 则一击直达）。
  - 点笔记 = 在 Obsidian doc tab 打开；点笔记文件夹 = doc tab 定位到该文件夹。
- VaultReader 搜索框换成同一匹配器，结果含文件夹。
- vault 索引异步 + 可刷新（修「新笔记重启前搜不到」+ 启动 46s 阻塞）。

非目标（明确不做）：
- 全文搜索（只搜路径/名字）；拼音匹配（`kaoyan` 不命中 `考研`）。
- `$HOME` 之外的目录；dot 目录；vault 之外的 `.md` 文件（New Session 的「笔记」段只含 vault）。
- 实时文件系统监听（inotify 在 JuiceFS 上不可靠）。
- 命中字符高亮；↑/↓ 键盘导航（只做 Enter = 打开第一条）。
- DirectoryPicker（定时任务表单，低频）与 Sidebar `pick-dir` 加搜索——接口通用，以后只是接线。

## 后端

### 1. `src/fuzzy_index.rs`（新模块）

```rust
pub enum EntryKind { Dir, VaultDir, VaultNote }
pub struct IndexEntry {
    pub path: String,        // Dir: 绝对路径；Vault*: vault 相对路径（note 带 .md）
    pub kind: EntryKind,
    haystack: String,        // 参与匹配的串：Dir 为 ~ 缩写路径；Vault 为相对路径（note 去 .md）
    basename_off: usize,     // haystack 中 basename 起始字节偏移，供 basename 加权
}
pub struct PathIndex { pub entries: Vec<IndexEntry>, pub built_at_ms: i64, pub truncated: bool }

pub struct IndexSlot {
    cur: RwLock<Option<Arc<PathIndex>>>,  // None = 从未建成
    rebuilding: AtomicBool,
}
```

vault 的 `PathIndex` 与 wikilink 用的 `VaultIndex`（字段不变）**在同一次遍历中产出**，
装进同一个快照 `VaultSnapshot { paths: PathIndex, wiki: VaultIndex }`，
`AppState.vault_index: Option<Arc<VaultIndex>>` 改为 `vault: Option<IndexSlot<VaultSnapshot>>`。
`IndexSlot` 对快照类型泛型化；目录侧快照即 `PathIndex`。现有调用方只有 `vault_search`（删）
与 `vault_resolve`（改读快照），影响面已 grep 确认。

#### 1a. 目录索引

- 根 `$HOME`，`maxdepth = 6`，条目上限 5000，**BFS**（截断时丢最深层，而非随机子树）。
- 跳过规则与 `list_directories` 一致：`file_type()` 不跟 symlink；跳过 `.` 开头；跳过
  `node_modules | target | __pycache__`。**不排除 vault 子树**。
- 守卫：对每个候选的**遍历路径词法形式**过 `path_hits_sensitive_dir` + `read_hits_home_dotdir`
  （纵深防御——跳过 `.` 开头已使其在构造上不命中）。**不 canonicalize**：JuiceFS 上约 10ms/次，
  650 条多 6.5s。

#### 1b. vault 索引

- 扩展 `build_vault_index` 为一次遍历同时产出 `VaultIndex` 与 `PathIndex`：
  - `VaultNote`：现有 `.md` 规则不变。
  - `VaultDir`：只收**子树含 `.md`** 的文件夹（遍历时对每个 `.md` 的祖先链打标记，零额外 IO），
    并额外跳过 `node_modules | target | __pycache__`（仅影响 VaultDir 与后续下钻，不改变现有
    `.md` 收录范围——这些目录下的 `.md` 本来就极少，且非笔记）。

  > 注：跳过这三个名字确会让其中的 `.md` 从 wikilink 索引消失。实测 vault 中这三类目录下
  > `.md` 数为 0（实现时以测试 fixture 固定此行为）。

#### 1c. 状态机（两个 slot 共用）

| 状态 | `cur` | `rebuilding` | 搜索行为 |
|---|---|---|---|
| 首建中 | None | true | 返回该类空结果 + `indexing: true` |
| 就绪 | Some | false | 正常匹配 |
| 刷新中 | Some | true | 用旧快照正常匹配 + `refreshing: true`（**不是** indexing） |

- **首建**：启动代码先 `rebuilding.store(true)` 再 `spawn_blocking(build)`，保证首建期间的搜索
  请求 CAS 失败、不会并发第二次遍历。listener bind **不再等待** vault 遍历。
- **刷新触发**（CAS `false→true` 成功者发起，失败者什么都不做）：
  - 快照年龄 > 10 分钟（stale-while-revalidate，本次请求用旧快照）；
  - 或：目录段**零结果**且快照年龄 > 30 秒（「刚 clone」逃生口，30s 下限防每次敲键都触发）。
    vault 段同理（「刚写的笔记」）。
- **复位**：`rebuilding` 由一个 Drop guard 复位，guard 在 `spawn_blocking` 闭包内持有——
  构建 panic 同样复位，下次过期可重建。构建成功才替换 `cur`，失败/panic 保留旧快照。
- 只有搜索请求会触发刷新：空闲时零遍历。vault 刷新一次约 45s 后台元数据遍历，最多每 10 分钟一次。
- `vault_resolve` 在首建中返回 503 `"vault indexing"`；前端 `resolveWikiLink` 对 503 提示
  「笔记索引建立中，请稍候」而非「未找到」。

### 2. 匹配（`nucleo-matcher 0.3`）

- 每请求 `Matcher::new(Config::DEFAULT.match_paths())`（`Send`，100 次 new 共 281µs，不共享、不加锁）；
  `Pattern::parse(q, CaseMatching::Smart, Normalization::Smart)`（空格分词 AND，fzf 语法 `^ $ ' !`）。
- `full = pattern.score(haystack)`；`base = pattern.score(haystack[basename_off..])`；
  **`text = max(full, base + 20)`**。实测 `zmx`/`zeromux` 对 `.../zeromux` 与 `.../zeromux/docs`
  全路径分相同，basename 加权才能把 repo 本身排在其子目录前。
- **丢弃 `score == 0`**：纯否定查询（`!docs`）对所有条目返回 `Some(0)`，否则会返回任意 20 条。
- **frecency 加分**（仅 Dir / VaultNote；VaultDir 无 frecency）：
  - 取该用户 `candidates(user_id, kind)`（既有，`LIMIT 16` 按 `last_ms`——只有最近 16 行能加分，接受）；
  - 按 path 聚合：`s = Σ decayed_score`，`bonus = floor(12 · s / (s + 1))`，上限 12；
  - 12 < nucleo 单字符匹配分 16（`score.rs:6` `SCORE_MATCH`），frecency 不会压过更好的文本匹配。
- Dir 结果额外带 `agent`：该 path 下 `decayed_score` 最高的那一行的 agent（经 `coerceAgent` 同款
  白名单校验，不合法则为 null）。无历史则 null。
- 排序：`text + bonus` 降序；并列按 haystack 长度升序。

### 3. 接口 `GET /api/search?q=&scope=all|dirs|notes&limit=`

```json
{
  "dirs":  [{ "path": "/home/ubuntu/…/zeromux", "display": "zeromux", "hint": "~/s3-workspace/…/ai", "agent": "claude" }],
  "notes": [{ "path": "projects/x/_index.md", "kind": "note", "display": "_index", "hint": "projects/x" },
            { "path": "projects/x", "kind": "folder", "display": "x", "hint": "projects" }],
  "indexing":   { "dirs": false, "notes": false },
  "refreshing": { "dirs": false, "notes": false },
  "truncated":  { "dirs": false, "notes": false }
}
```

- `display/hint` 复用 `dir_display_hint` / `note_display_hint`。
- `limit` 默认 6，上限 50。
- `q`：trim 后为空 → 空结果；长度按 **`chars().count()` ≤ 128**（按字节会误伤中文），超出 400。
- **authz**：
  - `dirs`：所有已认证用户，与 `/api/directories` 同级——后者本就允许非 admin 逐层枚举 `$HOME`
    非 dot 目录，本接口信息集相同，**不是新泄漏**。
  - `notes`：沿用 `vault_base()`（admin + vault 已配置）；不满足时 `notes` 恒为空、不报错
    （New Session 首屏不因非 admin 整块失败）。
  - frecency 按 `user.id` 查（`candidates` 已 owner-scoped）。
- **删除** `/api/vault/search`、`vault_search`、`vault_search_filter` 及前端 `getVaultSearch`。

依赖：`nucleo-matcher = "0.3"`（纯 Rust）。

## 前端

### 4. New Session 首屏（`Sidebar.tsx` `step === 'quick'`）

布局（弹层 `absolute bottom-full`，向上生长，锚在底部 New session 按钮）：

```
┌ 新建会话 ───────────────┐
│ [结果区 / QuickTargets] │  ← max-h-[40vh] overflow-y-auto，内容变长只在此区滚动
│ 其他目录…               │  ← 常驻
│ Obsidian 笔记库         │  ← vaultEnabled 时
│ [🔍 搜索目录或笔记…   ] │  ← 输入框在底部：贴近锚点与拇指，结果变长不移动它
└─────────────────────────┘
```

- **键盘**：手机不 `autoFocus`（主路径仍是 QuickTargets 一击，自动弹键盘会盖住它）；桌面 `autoFocus`。
  手机键盘弹起时，弹层底部用 `visualViewport`（`height + offsetTop` 相对 `innerHeight` 的差）
  上抬，参照 `TerminalView.tsx:391-410` 的现有做法。
- 输入 `maxLength={128}`；防抖 150ms；monotonic `reqRef` 守卫（发请求前 bump，await 后比对）。
- 查询词存 Sidebar 级 state：从结果进 `pick-type` 再返回 `quick` 时保留；`openTypePicker` 时清空。
- Enter = 打开第一条结果。

结果呈现：
- 空查询：保持现状（QuickTargets + 其他目录… + Obsidian）。
- 有查询：结果区替换 QuickTargets 为两段「目录」「笔记」，每段 ≤ 6 条，**段序按段内最高分**。
  - 笔记段仅在 `vaultEnabled` 时渲染（非 admin / 未配置 vault 时整段不出现，不显示「无匹配」）。
  - 行样式复用 QuickTargets 行（≥48px，display + hint 两行，行首图标 = 会开出什么）。
    实现上把 QuickTargets 的行渲染抽成共享组件，而非复制。

点击行为：
- **目录行，`agent` 非 null** → `onCreate(agent, path)` + `closeAfterCreate()`（一击直达，同 QuickTargets）。
  行尾 `⋮` 操作单：「换 agent 类型」「带 prompt 打开」（复用 QuickTargets 操作单；无「从列表移除」）。
- **目录行，`agent` 为 null** → `setPendingDir(path)` + `pick-type`，选完类型**直接创建**，不进
  prompt 页（新增 `pendingSkipPrompt` 标志；QuickTargets「换 agent 类型」的既有流程不变）。
  tmux 仍走 `pick-terminal-mode`。
- **笔记行 / 笔记文件夹行** → `onOpenVault({ path, kind })` + `closeAfterCreate()`。

边界态：

| 状态 | 目录段 | 笔记段 |
|---|---|---|
| 首建中（`indexing`） | 「正在建立目录索引…」 | 「正在建立笔记索引…」 |
| 刷新中且零结果 | 「索引刷新中…」，前端 4s 后自动重查一次 | 同左 |
| 零结果 | 「未找到（仅索引 6 层内）· 用「其他目录…」浏览」 | 「无匹配笔记」 |
| `truncated` | 不提示（Top 6 远小于上限） | 不提示 |
| 请求失败 | 结果区静默隐藏 + 行内「重试」；其余入口照常 | 同左 |

QuickTargets 清理：删除 `onEmpty` prop 与 `failed` state（`Sidebar.tsx:519` 为唯一调用方）。
全新库首屏 = 搜索框 + 其他目录… + Obsidian；开 Terminal/Claude 比现在多 1 tap，可接受。

### 5. App / doc tab

- `Sidebar` 新增 prop `onOpenVault(target: { path: string; kind: 'note' | 'folder' })`，不复用
  `onCreate` 的 `workDir` 参数位。
- `App.handleOpenVault`：若已有 doc tab → 激活**最近创建**的那个并下发 target；否则新建一个。
  （取舍：复用会让该 tab 当前阅读位置被替换——与在 VaultReader 内点链接行为一致；换来的是
  手机上 tab 不无限增长、不多挂载 VaultReader。）
- 下发方式：`docTargets: Record<tabId, { path, kind, nonce }>`（App 内存 state），VaultReader 新 prop
  `target`，`useEffect` 按 `nonce` 消费（note → `openNote`；folder → `setMode('list')` + `setCwd` + `setQuery('')`）。
- `target` **不持久化**（`saveDocTabs` 不变）：刷新页面回到列表模式，与 `docTabs.ts:5-6` 既有设计一致。

### 6. VaultReader 搜索

- 搜索框改调 `/api/search?scope=notes&limit=50`，结果含文件夹（`Folder` 图标），显示 display + hint。
- 点笔记 → `openNote`；点文件夹 → `setCwd(path)` **并 `setQuery('')`**（否则 `query` 非空时仍渲染
  结果列表，点击看似无反应）。
- 既有 `searchReqRef` 守卫保留；`indexing` 时显示「笔记索引建立中…」；截断提示改为「仅显示前 50 条」。

## 测试

Rust（`fuzzy_index.rs` `#[cfg(test)]`，临时目录 fixture）：
- 遍历：跳 dot / symlink / 噪音名；maxdepth；上限 + BFS 截断丢最深层；vault 子树**被包含**。
- VaultDir：只收子树含 `.md` 的文件夹；`__pycache__` 不收。
- 同一次遍历产出的 `VaultIndex` 与现有 `build_vault_index` 行为一致（复用既有 wikilink 测试）。
- 匹配：`zmx`→zeromux；`gsai`→github-search/ai；`考研`→考研英语；basename 加权使 repo 排在子目录前；
  `!docs` 不返回 score 0 条目；frecency 加分让等分者靠前但不压过多一个字符的更好匹配；按 path 聚合多 agent 行。
- 状态机：首建中搜索不触发第二次构建；刷新中返回旧快照 + `refreshing`；构建 panic 后 `rebuilding` 复位
  且旧快照保留；零结果 30s 下限。
- 接口：非 admin `notes` 为空；空 q；129 个汉字 400、128 个通过；`vault_resolve` 首建中 503。

前端（vitest）：
- 首屏：输入 → 两段渲染、段序按最高分；stale 响应被丢弃（**先注释守卫验红**）；
  有 agent 的目录行一击调用 `onCreate`；无 agent 行进 pick-type 后直接创建、不进 pick-prompt；
  笔记行调用 `onOpenVault`；非 vaultEnabled 不渲染笔记段；返回 quick 保留查询词。
- VaultReader：`target` nonce 变化打开笔记 / 定位文件夹并清空查询；搜索结果点文件夹清空查询。
- App：已有 doc tab 时复用最近创建的，不新增 tab。

手机真机验收（iOS Safari）：键盘弹起时输入框与结果区前 3 条可见；结果区滚动不带动输入框。

## 风险

- vault 后台刷新 ≈ 45s JuiceFS 元数据遍历，最多每 10 分钟一次、仅在有人搜索时发生。
- 启动后前 ~46s 内 vault 搜索 / wikilink 解析不可用（`indexing` / 503）——相比现在整站 46s 不可用是净改善。
- deploy.sh 的 90s 健康检查窗口可在本改动上线后另议缩短（本 spec 不改）。
- 5000 条目录上限：当前 650，余量充足。
