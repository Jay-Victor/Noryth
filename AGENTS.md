# AGENTS.md · Noryth

给编码 Agent 的操作契约。**先读完本文件，再读 `docs/`。**
本文件不重复设计，只说明：读什么、不许做什么、怎么算做完。

---

## 0. 当前状态

- 设计交付包 v1.2 已完成（6 份文档 + schema + 参数表 + 探针 + 校验器 + 两张图）。
- **P0 六条门禁已全过**：pnpm monorepo（`packages/core|store|git|cli`）、`@noryth/core` 领域类型与五个核心函数、SQLite 迁移器、命令总线（幂等收据）、`noryth init / open / status / doctor / config`、Git 首次提交 + 检查点绑定。
- 五个核心函数（评分 / 阻尼 / 上下文装配 / 限知过滤 / 收束求值）已用 TS 实现，探针的 44 条断言已搬成 vitest；跨语言数值夹具见 `packages/core/test/fixtures/parity.json`。
- P0 期间补全的两处规格：项目骨架 7 项以 `packages/core/src/manifest.ts` 的 `INIT_ENTRY_SPECS` 为唯一权威（`docs/04-ui.md §2` 有同步表）；A2 配额见 `docs/01-architecture.md §6 A2`，只在 `id+drop` 阶段生效。
- **下一步是 P1**。P0 唯一未收尾项：`05-roadmap.md §3.2` 要求的三平台 Electron 最小壳 + `better-sqlite3` 原生模块验证（本机仅 Windows，且仓库还没有 CI）。

> 若所用工具只认固定文件名（`CLAUDE.md`、`.cursorrules`、`.github/copilot-instructions.md`），
> 把本文件复制或软链过去即可，内容不需要改。

---

## 1. 先读什么

按顺序读，不要跳。每份文件解决一个不同的问题。

| 顺序 | 文件 | 它回答什么 |
|---|---|---|
| 1 | `docs/00-review.md` | 需求判定（保留/修改/删除/补充）、三个最贵的错误、边界 |
| 2 | `docs/01-architecture.md` | 5 条不变量、分层、写入路径、6 个算法、时序模型、性能 |
| 3 | `docs/02-schema.sql` | **唯一权威**的数据模型：26 表 / 26 索引 / 10 触发器 / 6 视图 |
| 4 | `docs/03-agents.md` | 六类 Agent 契约、提示词全文、调度时序、冲突检测、导入、质量仪器 |
| 5 | `docs/04-ui.md` | 布局、交互、CLI 命令面、TUI、设置 schema、skill 机制 |
| 6 | `docs/05-roadmap.md` | 分期、每期门禁、测试与 CI、SLO、风险 |
| 7 | `docs/params.yaml` | 58 个参数（7 个可调），与代码常量必须一致 |
| 8 | `design/probe/noryth_proto.py` | 算法参考实现（Python）+ 44 条行为断言 |

赶时间的话，最低限度：**`02-schema.sql` + `01-architecture.md` 的 5 条不变量 + 本文件 §2**。

代码的阅读顺序（P0 之后）：`packages/core/src` → `packages/store/src` → `packages/cli/src` → `packages/*/test`。
`core` 零 I/O，先读它；`store` 是唯一能写 SQL 的包；`cli` 只做参数、输出与退出码。

`packages/core/test/probe.test.ts` 是行为基线（44 条），改调度 / 装配 / 限知 / 收束之前先跑它。

---

## 2. 不可违背的规则

违反任意一条，产物不可合并——不是风格问题，是会坏。

1. **文档是规格，不是建议。** 与文档冲突时停下来问，不许"先这样，回头再说"。
2. **`docs/02-schema.sql` 是权威。** 不许改表结构、约束名（`ck_*`）、触发器。缺字段就报告，不许顺手加。
3. **模型没有写权限。** 所有 Agent 产出都是提案，由命令层校验后提交。模型不碰文件、不碰数据库。
4. **先过滤，后拼装。** 未授权内容不得进入提示词。"喂进去再要求它别提"是禁止的。
5. **事实只 supersede，不覆盖。** 当前值恒等于 `valid_to IS NULL`。
6. **回退覆盖 8 个域**（消息/事实/认知/关系/正文/卡牌/摘要/向量），且**开新分支、不删旧分支**。
7. **不许留 TODO、mock、占位实现。** 跑不通就报告跑不通，不要写一个能编译但不对的东西。
8. **不许改 `design/probe/` 和 `assets/`。** 那是设计证据。为了让测试变绿去改探针，等于改考卷。
9. **不许跳过门禁。** 每期门禁见 `docs/05-roadmap.md §2`。
10. **汇报必须贴真实命令输出。** 没贴 = 没做。

---

## 3. 文件所有权

| 范围 | 权限 |
|---|---|
| `packages/**`、`tests/**`、`scripts/**` | 可自由创建与修改 |
| `packages/core/test/fixtures/parity.json` | 由 `scripts/gen-parity.py` 生成；只许重新生成，不许手改 |
| `docs/02-schema.sql`、`docs/params.yaml` | **需申请**：说明为什么现有模型不够，等我确认 |
| `docs/*.md` | **需申请**：文档改动要单独提交，混在功能提交里一律打回 |
| `design/probe/**`、`assets/**` | **禁止修改** |
| `AGENTS.md` | **需申请**：用户批准后更新 |

---

## 4. 环境与命令

Windows 11 · bash（MSYS）· Node 26 · pnpm 11 · Python 3.14 · SQLite 3.53 · git 2.53。

```bash
# 安装与构建（一次）
pnpm install
pnpm build                 # tsc -b，产物在 packages/*/dist

# P0 总门禁：构建 + 覆盖率 + 契约 + 门禁 3–6，必须 EXIT=0
pnpm gate:p0

# 分开跑
pnpm test                  # vitest，全部用例
pnpm test:coverage         # core 纯函数层：行 ≥90% / 分支 ≥80%
python -B scripts/check.py            # 真 SQLite 建库 + 逐条打约束（当前 73 条）
python -B scripts/check.py --params   # 参数表 ↔ 常量（58 键 / 7 可调 / 0 失败）
node scripts/check-p0.mjs             # 只跑门禁 3–6

# CLI（构建后）
pnpm noryth init <dir>
pnpm noryth status --project <dir>

# 算法探针（设计证据，只读）
python -B design/probe/noryth_proto.py --demo
python -B design/probe/noryth_proto.py --selftest
node design/probe/bench_vector.mjs
```

`-B` 是必需的：Python 会在 `design/probe/` 旁边写 `__pycache__`，那会弄脏设计证据目录。

**数字会变**：新增 vitest 用例、新增迁移后，契约断言数与表数会增长。门禁看的是"全部通过"，不是固定数字。

---

## 5. 技术栈（已锁定）

| 用途 | 选择 | 换掉需要 |
|---|---|---|
| 语言 | TypeScript strict | 不可能 |
| 包管理 | pnpm workspaces | 给理由 |
| 桌面 | Electron + React 19 + Vite | 给理由 |
| 数据库 | better-sqlite3（主进程） | 给理由 + 三平台验证 |
| 校验 | Zod（模型输出、IPC 边界） | 给理由 |
| 编辑器 | CodeMirror 6 | 给理由 |
| TUI | Ink | 给理由 |
| 版本控制 | MinGit（Windows 打包） | 给理由 |

依赖方向单向：`desktop → cli → core ← store`。`core` 不 import `store`，`store` 不 import `desktop`。

P0 实际版本：TypeScript 5.9.3（`strict`，CommonJS 输出）、pnpm 11.22、better-sqlite3 13.0.3（Node 26 / SQLite 3.53.4 已 require 通过）、Zod 4.6、Vitest 5.1。
Electron / React / Ink 尚未安装，P4/P5 再落；`packages/desktop`、`packages/tui` 现在不存在。

---

## 6. 当前做 P1

P0 六条门禁已全过（`pnpm gate:p0`，EXIT=0）。P0 的唯一未收尾项见 §0。

P1 的交付物与 12 条门禁以 `docs/05-roadmap.md §2「P1 · 剧场内核」` 为准。开工顺序：

1. 调度器接场景状态与 `beat` 落库（`packages/core/src/scheduler.ts` 已有评分/阻尼/硬上限/仲裁与 44 条断言）；
2. 上下文装配接 `cognition` 与最近拍（`context.ts` 已有配额/降级）；
3. 限知过滤落库（`knowledge.ts` + `cognition` 表）；
4. 导演：事件卡、冲突阶梯、收束求值（`events.ts` / `exit.ts`）；
5. `noryth run --scene` 与检查点回退（8 域逐域计数）。

P1 的三个陷阱（`05-roadmap.md §2`）：旁白靠硬节奏而不是权重；仲裁只看 `score > 0`；回退必须逐域验证。

`packages/core/test/probe.test.ts` 是这五步的行为基线；改任何一步先跑它和 `parity.test.ts`。

---

## 7. 阶段门禁速查

| 期 | 一句话终点 | 门禁条数 | 状态 |
|---|---|---|---|
| P0 | `noryth init` 建出可提交的项目 | 6 | 已过（§3.2 三平台验证待补） |
| P1 | CLI 跑完一场 40 拍，可回退 | 12 | 下一期 |
| P2 | 角色不再说漏，设定锁生效 | 9 | 未开始 |
| P3 | 一场戏 → 一章稿 → 审出问题 → 改一版 | 11 | 未开始 |
| P4 | 不用鼠标跑完 20 拍（TUI） | 4 | 未开始 |
| P5 | 三条主路径可点通（GUI） | 6 | 未开始 |
| P6 | 可交给陌生人安装使用 | — | 未开始 |

一次只做一期。做完 P0 想接着做 P1，回答是：先过 P0 门禁。

---

## 8. 已知陷阱（照抄自文档，别重犯）

这些是设计阶段与 P0 实现已经踩过的坑，每一条都会真实发生：

1. **抖动不能用 `random`。** 用 `hash(seed, seq, agentId)`。随机抖动会让回退后无法复演同一场。
2. **检索不按本次查询的 max 归一。** 否则任何查询头名都是 1.0，"低于 0.45 当作没记住"永不触发。用绝对参考点 `rrf_ref`。
3. **旁白的节奏是硬约束，不是权重。** `W_NARRATOR=0.12` 在多个角色在场时永远拿不到最高分（实测占比 0%）。
4. **仲裁只看 `score > 0` 的候选。** 把被钳制到 0 的算进平局，会让每一拍都触发仲裁。
5. **上下文超预算时整条丢弃，不截断半句。** 截断会让模型看到半句话然后自己补全。
6. **回退少退一个域不会报错**，只在下一轮表现为"角色说漏了"。必须逐域计数。
7. **`cognition` 没有行 = 不知道。** 不要用"同场即可感知"代替受众过滤。
8. **中文输入法组合态**（`isComposing` / `keyCode 229`）下 `Enter` 是选词，不是发送。
9. **TUI/GUI 里不许出现业务分支**（`if (tui) …`）。分支只能在绘制层。
10. **`fact.card` 与 `predicate_spec` 必须一致。** 生成列无法跨表，靠触发器守；改谓词值数要连 `card` 一起改。
11. **BLAKE2b 的 `digest_size` 是参数化，不是截断。** Node 只有 blake2b512；`digest_size=8` 必须实现 8 字节输出的 BLAKE2b，否则抖动序列与 Python 不一致，回退复演会漂。
12. **`h01` 只接受整数。** Python `str(1.0)` 是 `"1.0"`，JS `String(1)` 是 `"1"`；浮点 seed 会静默分叉。
13. **pnpm 11 不读 `package.json` 的 `pnpm` 字段。** 原生模块的构建许可写在 `pnpm-workspace.yaml` 的 `allowBuilds`；写成 `onlyBuiltDependencies` 会被忽略。
14. **better-sqlite3 的约束错误是 `SqliteError`（`code` 以 `SQLITE_CONSTRAINT` 开头），不是自定义异常。** `ck_*` 名只在 message 里；命令层用 `asConstraintError` 统一映射，别在 catch 里猜类型。
15. **schema 只从 `docs/02-schema.sql` 读，不复制。** 复制就会漂移；打包（P6）时再放进 resources。
16. **A2 配额只在 `id+drop` 阶段生效。** 常态按 `full → summary → triple → id` 降级；把配额做成常态硬切会让文档的 4352 tok 实测表全部作废。

---

## 9. 汇报格式

每次交付按这三段写，不要多：

```
1. 做了什么        文件清单 + 一句话说明
2. 门禁结果        真实命令输出，原样粘贴
3. 卡住/存疑       与文档冲突、设计没覆盖到、你不确定的地方（列出来，不要自己拍板）
```

不要复述你打算做什么，也不要在结尾写"如需进一步优化请告知"。直接做，做完报结果。

---

## 10. 遇到冲突

按这个优先级判断：

1. `docs/02-schema.sql`（数据模型 + 约束）
2. `docs/01-architecture.md` 的 5 条不变量
3. 本文件 §2
4. `docs/03-agents.md` / `docs/04-ui.md` 的具体设计
5. `docs/05-roadmap.md` 的门禁

**高优先级赢。** 如果冲突影响到交付物本身，停下来问，不要自己选一个继续写——选错的那条会成为后面所有 bug 的地基。
