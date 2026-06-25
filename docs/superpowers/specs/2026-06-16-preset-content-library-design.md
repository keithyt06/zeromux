# 预设库内容设计：专业级编码 agent 任务 prompt（8 条）

> 承接 [prompt-presets feature](2026-06-15-prompt-presets-design.md)（功能管道）与其[复审 + `{{input}}` 插值](2026-06-15-prompt-presets-fixes.md)。本文档定义**实际填入预设库的内容**——8 条覆盖编码 agent 全流程的高质量任务 prompt。这是内容设计，不改任何代码：交付物是 8 条 `(title, body)`，通过既有 `/api/prompts` POST 写入线上库。

## 背景与约束

预设是 **verbatim 发给编码 agent（Claude Code / Codex / Kiro）的用户消息任务指令**（不是 system prompt，走既有 `initial_prompt` / Composer `onSend` 透传通道）。点 chip 时 `{{input}}` 被替换成用户当前输入框内容（文件名 / bug 现象 / 需求描述）；为空则移除。agent 工作目录每次按规范选定，所以 prompt 可假设 agent 已在正确的 repo 里。

产品负责人的要求（2026-06-16）：
- body 用**英文**（指令遵循度更高）。
- 但每条要求 agent **用中文与用户交流**（用户读中文）。
- 现有草稿"太简单"，要更专业、效果更好。
- 关键纠偏：**"更专业" = 信号密度更高 + 任务契约更紧，不是更长**。这些发给 context 窗口为最稀缺资源的 agent，冗长是失败模式而非改进。

## 调研基础（PE / CE / agentic loop）

来源：Anthropic [Claude Code best-practices](https://code.claude.com/docs/en/best-practices) + [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)。锁定的有效杠杆：

- **给可验证的 check 让 agent 自闭环**：否则 agent 停在"looks done"，用户成了验证循环。定义显式 done-condition（测试/构建/lint 的通过信号）。
- **工作流脊柱**：Explore → Plan → Implement → Commit。把研究/计划与实现分开。
- **具体化**：限定文件/场景；指向代码库已有模式；bug 给"症状 + 可能位置 + 修好长啥样"。
- **给证据不空说**：贴命令 + 输出 / 截图，而非断言成功。
- **根因不治标**。
- **Context engineering**：最小高信号 token 集；just-in-time 读取（让 agent 读它需要的，别预灌架构）；**调研推给 subagent** 保主 context 干净；长任务用结构化笔记。
- **对抗式 review 在 fresh context** 只报正确性/需求 gap，不报风格——被要求找 gap 的 reviewer 会编问题，限定范围可防过度工程。

## 核心设计决策（CTO 评审锁定）

1. **任务契约 > 指令清单。** 每条答三问：Task（干什么 + 框住 `{{input}}`）/ Approach（怎么做：Explore→Plan→Implement 脊 + JIT 读 + 调研用 subagent）/ Done when（可验证条件 + 要贴的证据）。**done-when 是全 prompt 最高价值的 token**——让 agent 自闭环。
2. **验证是门控不是建议。** "跑测试" → "跑 X；贴命令 + 输出；失败就修再跑；没有绿输出不准报成功"。
3. **采用统一 4 行骨架**（非自由散文）：`Task: / Approach: / Done when: / [可选 guardrail 行] / 中文输出行`。理由：① click 时 8 个 chip 可一眼比较，显专业；② 强制写出 done-when（散文一半会漏）；③ 仍是紧凑 labeled-line 非重模板，信号密度不损。guardrail 行**仅在该失败模式真实时**出现（如 plan 的 STOP gate、review 的 no-bloat 规则）。
4. **中文输出指令一行、放末尾、限定范围。** 短指令靠 recency 管全程。务必限定：`用中文与我交流（代码/命令/标识符/提交信息保持英文）`——否则会出中文变量名 / 坏的 git commit subject。按场景微调（commit/PR 那条特别说明 message 用英文；纯讲解类不提 commit）。
5. **具体化靠 `{{input}}` 槽不靠堆长度。** prompt 负责框住槽（`{{input}}` 放在"目标"位置）+ 指示 JIT 读取；不预灌架构。
6. **不重复全局规则。** 平台已注入 mermaid/math/table 前导，worktree 已隔离——每个复述已知 context 的 token 都是偷任务的 token。
7. **库为 8 条，非 9 条。** 砍掉原草稿的"补测试"（与 TDD 80% 重复）。owner 要 better 不是 more，多一个无法与 TDD 区分的 chip 是负价值。#1 explore + #2 plan 保持分开但 pipeline（explore 的 done-when 明确产出"供 plan 消费的 map"）。**不新增**其它（generate docs / optimize perf 等更稀有，稀释 chip 选择）。

## 明确不做（YAGNI）

- ❌ system prompt 类 prompt（功能定位是任务指令，且三 backend 无 system-prompt 通道）。
- ❌ 第 9 条"补测试"（并入 #3 TDD）。
- ❌ AWS 专项预设（本批为通用编码全流程；将来同一 API 可加）。
- ❌ 变量插值除 `{{input}}` 外的占位符（`{{file}}`/`{{selection}}` 需会话上下文，独立 feature）。
- ❌ 复述平台已注入的渲染前导 / worktree 隔离。

## 交付内容：8 条预设

排序按 Explore → Plan → Implement → Review → Refactor → Explain → Commit 脊柱。每条 body 英文 + 末尾中文输出行；`{{input}}` 框住目标。

> **标题语言（2026-06-16 调整）**：title 全部改为中文（保留 emoji），body 不变。
>
> **写入后对抗式 review（2026-06-16，gpt-5.5 网关上游不可用，改用 subagent review）发现并修正的 4 类真实问题**，已 PUT 更新线上库 + 同步本文档：
> - **P1 跨后端可移植**：`{{input}}` 预设逐字发给 claude/codex/kiro 三后端，但只有 Claude Code 有 subagent。原"Use a subagent"硬指令在 codex/kiro 是无效/误导。改为能力条件式"spawn a subagent … if you can; otherwise …"（#1/#4/#5）。
> - **P2 空 `{{input}}` 兜底**：空输入时"Explain ." / "symptom: ."读不通、诱导 agent 瞎猜。加"if nothing given, ask me first"（#1/#4/#7）。
> - **P3 PR 降级**：#8 done-when 死扣 PR 链接，无 `gh`/remote/auth 时必半途失败。改为 commit+push 必做、PR 不可行则给可粘贴草稿。
> - **P4 隐含前提兜底**：#6 假设有测试 → 无测试先加 characterization test；#5 假设有 diff → 无 diff 则停下告知。
> - **#2 写计划、#3 TDD 经评审为全场最强，body 不动。**

### 1. 🔍 探索代码库
```
Task: Map how this codebase handles {{input}}, read-only — change nothing. If I named no area above, ask me what to focus on first.

Approach: Investigate without bloating this transcript — spawn a subagent for the digging if you can; otherwise read only what's relevant and don't dump source back to me.

Done when: you return a tight map the planning step can act on — the key files and their roles, the data flow, existing reusable patterns/utilities, and the constraints I should know before touching it.

用中文与我交流（代码、命令、标识符保持英文）。
```

### 2. 📋 写实现计划
```
Task: Write a detailed implementation plan for {{input}}.

Approach: First explore the relevant code (read-only) and the nearest existing patterns to follow. Do NOT write or edit any code yet.

Done when: the plan lists which files change and how, the data flow, edge cases, the tests to add, and the verification (test/build/lint) for each step. STOP and show me the plan for approval before implementing.

用中文与我交流（代码、命令、标识符、提交信息保持英文）。
```

### 3. ✅ TDD 实现
```
Task: Implement {{input}} using test-driven development.

Approach: Read the nearest existing tests + the code you'll touch to match conventions (don't read the whole repo). Write tests for the happy path and key edge/error cases BEFORE implementing; run them and confirm they fail for the right reason (red). Then write the minimum code to pass — no speculative abstractions or scope beyond {{input}}.

Done when: the new tests and the existing relevant suite all pass. Paste the final test command and its green output as evidence, and state briefly what behavior the tests pin down. If you can't reach green, stop and report what's blocking — never claim success without passing output.

用中文与我交流（代码、命令、标识符、提交信息保持英文）。
```

### 4. 🐛 修 Bug（根因）
```
Task: Fix this bug — symptom: {{input}}. If no symptom is given above, ask me for one before touching code.

Approach: First write a failing test that reproduces the symptom. Find the root cause — spawn a subagent for deep tracing if you can, otherwise trace it directly. Do not patch over the symptom.

Done when: the reproducing test passes, the relevant suite still passes (no regression), and you've explained the root cause in one or two sentences. Paste before/after test output as evidence.

用中文与我交流（代码、命令、标识符、提交信息保持英文）。
```

### 5. 👀 对抗式评审
```
Task: Review the current uncommitted/branch changes (git diff) for {{input}}, with fresh, skeptical eyes — assume it's wrong until proven otherwise. If there's no diff to review, tell me and stop.

Approach: Read the diff and only the surrounding code needed to judge it; for deeper tracing, spawn a subagent if you can so this review stays focused. Hunt only for real defects: logic errors, unhandled edge cases/inputs, race conditions, broken error paths, security holes, and requirement gaps (does it do what was asked?).

Done when: each finding is file:line → concrete problem → smallest fix, ordered by severity. Do NOT report style/naming/formatting. Do NOT demand defensive code or abstractions for cases that can't occur — flagging non-problems is itself a failure. If nothing is materially wrong, say so plainly rather than inventing issues.

用中文与我交流（代码、命令、标识符保持英文）。
```

### 6. ♻️ 简化重构
```
Task: Refactor {{input}} to be simpler, with behavior unchanged.

Approach: Confirm the relevant tests are green first — if none cover it, tell me and add a characterization test before refactoring. Touch only what serves this goal — don't "improve" unrelated code, comments, or formatting. If 200 lines can become 50, do it, but every changed line must trace to the refactor.

Done when: the same tests still pass after (behavior is identical). Paste the test output as evidence, and summarize what got simpler and why it's safe.

用中文与我交流（代码、命令、标识符、提交信息保持英文）。
```

### 7. 📖 解释代码
```
Task: Explain {{input}}. If nothing is named above, ask me what to explain before reading.

Approach: Read the actual code (and its git history if a decision looks deliberate). Point to concrete file:line.

Done when: I understand what it does, how to use it, what it depends on, and WHY it's written this way rather than an obvious alternative. Aim for fast onboarding — not a line-by-line recital.

用中文与我交流（代码、命令、标识符保持英文）。
```

### 8. 📝 提交并开 PR
```
Task: Commit {{input}} and open a PR.

Approach: If not on a feature branch, create one first. Run verification (tests/build/lint) before committing; if it fails, fix it — don't commit broken work. Push, then open a PR with `gh` if it's available and authenticated; if PR creation isn't possible here, push the branch and give me a ready-to-paste PR title + body instead. Follow the repo's existing branch/PR conventions.

Done when: a descriptive commit (message explains WHY, not just what) is pushed, and either the PR is open (report the link) or you've reported the branch + PR draft. Include verification evidence (test output).

用中文与我交流（代码保持英文；commit message 与 PR 描述用英文，正文说明可中文）。
```

## 写入方式

通过既有 `/api/prompts` POST（每条 `{ title, body }`）。`title` 含 emoji 前缀（手机 chip 截断到 ~120px，emoji 一眼区分——"元数据即信号"的轻量应用）。`sort_order` 由后端 `MAX+1` 自动递增，POST 顺序即上面 1→8 的展示顺序。body 远低于 20000 字符上限。

写入后**真机冒烟**：每条 chip 点开看 body 正确填入；含 `{{input}}` 的在输入框先敲字再点 chip，确认包裹；跨设备（桌面写、手机刷新可见）。

## 影响的文件

无代码改动。仅：
- 本 spec 文档（存档）。
- 线上预设库 8 条记录（运行时数据，非代码）。
