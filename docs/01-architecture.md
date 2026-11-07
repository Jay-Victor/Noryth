# 01 · 架构、数据模型与算法

---

## 1. 五条不变量

违反任意一条，后面的设计都不成立。每条都落成了表约束或断言，不只是纸面规则。

| # | 不变量 | 强制手段 |
|---|---|---|
| **I1** | 未授权内容**不进提示词**。先过滤，后拼装；不存在"先喂进去再要求它别提" | `cognition` 表 + `visibleFacts()`；探针断言越权计数 = 0 |
| **I2** | 事实只 **supersede**，不覆盖。当前值恒等于 `valid_to IS NULL` | 生成列 `slot_key` + 部分唯一索引 `ux_fact_slot` |
| **I3** | 回退覆盖 **8 个状态域**，且**开新分支、不删旧分支** | `branch(parent_id, fork_seq)` + 检查点重放；验收逐域计数 |
| **I4** | 一切写入走命令层 + **幂等收据**；模型不持有写权限 | `receipt(project_id, idempotency_key, request_hash)` |
| **I5** | **SQLite 是领域唯一权威**，Markdown 是受控镜像 | `outbox(expected_hash, applied_rev)` + 内容哈希校验 |

---

## 2. 分层与代码组织

```
noryth/
├─ packages/
│  ├─ core/         纯 TS 领域层。调度、上下文装配、限知、导演、收束求值、回退规划。
│  │                零 I/O —— 全部依赖通过 port 注入，因此可在 Node 里裸跑测试。
│  ├─ store/        SQLite 适配 + 迁移 + 命令总线 + 投影。唯一能碰 SQL 的包。
│  ├─ memory/       检索（RRF+MMR）、摘要、嵌入、事件卡抽牌。
│  ├─ providers/    模型适配（OpenAI 兼容 / Anthropic / 本地 Ollama）、嵌入适配、重试与降级。
│  ├─ git/          MinGit 封装：init / commit / diff / log / show / restore。
│  ├─ cli/          `noryth` 命令。**唯一的无头验收面**。
│  ├─ tui/          Ink 界面（P4）。
│  └─ desktop/      Electron 主进程 + 渲染进程（P5）。
├─ design/probe/    设计探针（不是产品代码，不参与打包）
├─ docs/            本套文档 + schema + 参数表
└─ scripts/         check.py
```

**依赖方向是单向的**：`desktop → cli → core ← store`。`core` 不 import `store`，`store` 不 import `desktop`。
这条规则的价值：调度器可以在没有 Electron、没有数据库、没有网络的情况下跑 500 拍仿真——于是"最贵的错误 #1"能在写第一行 UI 之前被发现。

技术选型与理由：

| 选择 | 理由 | 放弃的替代 |
|---|---|---|
| TypeScript strict + pnpm workspaces | 结构化输出要类型；多包共享领域模型 | 单包：`core` 会被 Electron 拖进渲染进程 |
| better-sqlite3 | 同步 API，事务语义直白，单进程桌面场景最优 | `node:sqlite`（Electron 版本绑定不稳）；Prisma（重、生成步骤多） |
| Zod | 模型输出**必须**过 schema 才能提交 | 手写校验：漏一个字段就是脏数据入库 |
| React 19 + Vite + Zustand | 三栏布局 + 高频局部更新 | Redux（样板过多）；TanStack Query（数据全来自 IPC 推送，不是请求） |
| CodeMirror 6 | Markdown 编辑、体积可控、扩展点清晰 | Monaco（~4 MB，为代码编辑器设计） |
| Ink | TUI 复用 React 心智，P4 成本低 | blessed（命令式，维护差） |
| MinGit（打包） | 用户机器上不保证有 git | 依赖系统 git：企业环境常见缺失 |

**Node 版本**：状态包导出依赖 zstd，CLI/TUI 声明 `engines: node >=22.15`。Electron 主进程跟随 Electron 自带 Node；P5 落地时必须验证其 `zstdCompressSync` 可用（Electron 版本选型以该能力为准）。本机开发用的 26 只影响 CLI。

---

## 3. 运行时拓扑与安全边界

```
┌─────────────────────────── Electron 主进程 ───────────────────────────┐
│  命令总线 → core（调度/上下文/导演） → store（SQLite） → outbox → 文件   │
│  providers（HTTP）  git（child_process）  safeStorage（OS 凭据库）      │
└───────────────▲───────────────────────────────────────────────────────┘
                │ contextBridge：白名单 IPC，请求/响应均过 Zod
┌───────────────┴───────────────┐        ┌──────────────────────────────┐
│  渲染进程（沙箱，无 Node）      │        │  CLI / TUI（同进程，无 IPC）   │
│  React + CodeMirror            │        │  直接调用 core + store        │
└────────────────────────────────┘        └──────────────────────────────┘
```

硬规则：

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 渲染进程**永远**拿不到 `fs`、`child_process`、数据库句柄。IPC 只暴露 ~30 个具名方法，参数走 Zod。
- **actor 由主进程根据当前会话注入**，不接受渲染进程或模型自报身份。否则"模型不能写库"这条规则在 IPC 层就被绕过了。
- 密钥存 OS 凭据库（Windows DPAPI / macOS Keychain，经 Electron `safeStorage`）。项目文件夹里只有 `provider: "openai"` 这样的引用，**没有 key**。
- 项目导出包（zip）默认排除 `.noryth/`，避免把数据库和历史一起发出去。

**单实例策略**：项目文件夹里放 `.noryth/lock.pid`。第二个实例打开同一项目 → 只读模式 + 顶部横幅提示。SQLite WAL 允许多读者，但业务层不允许两个写入者（因果顺序会乱）。

---

## 4. 唯一写入路径

所有状态变更只有这一条路。UI 按钮、CLI 命令、Agent 提案，最终都变成同一条 `Command`。

```
Command (Zod 校验)
  → 取 branch head_seq
  → 查幂等收据：同 key 同 request_hash → 直接返回原结果（不重放副作用）
                  同 key 不同 hash → 拒绝
  → 授权检查：actor 来自宿主，不来自 payload
  → 生成提案（propose）
  → 校验（validate）：
       · 知识边界：本条消息 assert/reveal 的 fact 是否都在 actor 的 cognition 里
       · 设定锁：命中 lock.slot_key 即拒
       · 槽位唯一：单值谓词已有 active 版本 → 必须 supersede
       · 引用完整性：scene/beat/entity 必须属于同一 branch
  → BEGIN IMMEDIATE
       append event(seq)
       apply projections（message / fact / cognition / relation / scene / beat …）
       update branch.head_seq
       write receipt
    COMMIT
  → 提交后（可重试、可失败）：
       outbox 入队（章节文件）
       job 入队（摘要 / 嵌入 / 抽取）
```

四个必须遵守的细节：

1. **幂等键含作用域**（`project_id + key`），否则跨项目误合并。
2. **提交前针对"最终候选投影"校验全部引用**。故意提交一个无效引用，断言同批消息、事实、认知、事件、head、收据**全部回滚**；失败的操作**不占用幂等键**。
3. **迟到结果由提交层拒绝**：每个模型/摘要/嵌入任务带 `expected_seq + generation`。取消 HTTP 请求不保证远端停止，迟到的结果如果直接写库，就会把已回退的状态写回来。
4. **模型只拿投影后的上下文**，不拿数据库行对象、不拿其他角色的私有记忆。

---

## 5. 数据模型地图

26 张表，按生命周期分五组。
完整 DDL 见 `02-schema.sql`（已在真引擎上跑过 73 条约束断言：26 表 / 26 索引 / 10 触发器 / 6 视图）。

```
项目线   project ─ branch ─ checkpoint ─ snapshot
                       └─ project_state（活动指针）

审计线   event（只追加）─ receipt（幂等）
         beat（调度审计 · stale 标记）

世界线   entity ─ fact ─ cognition
                └ predicate_spec（谓词值数：single / multi）
         relation（有向轴）
         scene（idx = 叙事顺序；story_* = 故事内时间；timeline 分线）
         message（supersedes_id 支撑"仅替换"重写）
         event_card
         lock（设定锁）

文本线   chapter ─ chapter_scene ─ scene
         revision
         issue（审批产出）
         outbox（文件发布）

记忆线   memory_node（resolved_seq 支撑悬念回收）─ memory_edge（DAG）
         job（后台任务）
```

关键字段与约束（只列决定性的）：

| 表 | 关键字段 | 约束 / 语义 |
|---|---|---|
| `fact` | `subject_id, predicate, object_json, card, truth, valid_from, valid_to` | `card` 冗余自 `predicate_spec`，因为生成列只能引用同行；`slot_key` 生成列 + 部分唯一索引保证单值槽位只有一个当前值 |
| `cognition` | `(branch, character, fact)` 主键 | **没有行 = 不知道**。`attitude ∈ knows/believes/suspects/doubts/falsely_believes` |
| `message` | `audience, percept` | `percept='whisper'` 必须有受众；`soliloquy`/`narrator_reader` 必须**没有**受众 |
| `scene` | `beats, max_beats` | `CHECK(beats <= max_beats)` —— 绝不静默超拍 |
| `revision` | `(chapter_id, rev)` 唯一 | 触发器强制 rev 连续；跳号说明有事务被部分提交 |
| `memory_node` | `hard, pinned` | `CHECK(hard=0 OR pinned=1)`：禁忌必然常驻 |
| `lock` | `(branch, scope, slot_key)` 主键 | 触发器拦"换 ID 写同一槽位"，不只是拦 UPDATE |

**为什么 `fact` 与 `memory_node` 是两张表**：前者是**权威**（有真假、有效期、唯一性约束），后者是**检索材料**（有重要性、衰减、嵌入）。
把它们合并，就会出现"检索到一条摘要，然后把它当成世界真相写回去"的经典事故。

### 5.1 时序模型：三条互不推导的时间轴

小说里的"时间"是三个独立的量，挤进一个字段就会同时产生三种 bug。

| 轴 | 字段 | 回答什么问题 | 混用会怎样 |
|---|---|---|---|
| **故事时间** | `scene.story_start / story_end` | 这件事发生在世界里的哪一刻 | 与讲述顺序合并 → **闪回被判成时间线矛盾** |
| **叙事顺序** | `scene.idx`（同分支唯一） | 读者读到的先后 | 拿它当故事时间 → 插叙、倒叙全部写不了 |
| **时间线** | `scene.timeline`：`main` / `flashback-a` / `dream` | 这是哪条线 | 不分线 → 无法表达"同一时刻的两条线" |

规则：

1. 同一 `timeline` 内，`story_start` 随 `idx` **单调不减**，由触发器 `ck_scene_time_regression` 强制。
2. **闪回必须换 timeline**。这不是限制，是逼作者把意图写明——审批 Agent 才分得清"叙事技巧"和"真的写错了"。
3. 物品持有、生死、契约这类**事实**的前后关系用 `fact.valid_from/valid_to` 判，**不用** `scene.idx`。讲述顺序颠倒不影响事实因果。
4. `event.seq` 是**系统**时间，与前两者无关，只服务回退与审计。三条时间轴不能互相推导。

第 3 条是最容易写错的：如果用 `scene.idx` 判"这封信是否已经送达"，闪回一段就会把已送达的信判成未送达，整条因果链崩掉。

---

## 6. 六个核心算法

每个算法给齐六件：签名、输入输出、公式、超参默认值、复杂度、边界。

### A1 · 发言调度评分

```ts
scoreCandidates(cands: Candidate[], ctx: SchedCtx, seed: bigint, seq: int): Ranked[]
```

**输入**：在场且可发言的候选（角色 + 旁白，≤ 8 个）。每个候选带 `goal_rel, addressed, stake, initiative`。
**输出**：按分数降序的排名，每项含 `base / jitter / score / parts`（写入 `beat.breakdown`，供事后归因）。

```
score(a) = 0.34·goal_rel + 0.30·addressed + 0.16·stake
         + 0.12·narrator_need + 0.08·initiative
         + jitter,        jitter = hash(seed, seq, a) / 2^64 × 0.05
```

- `goal_rel` 在**场景开启时**由规划结果写死（0 / 0.5 / 1），拍内不变 → 每拍评分完全确定。
- `addressed` 命中上一拍的点名者 = 1，否则 0。
- `stake` 由四项构成，全部是可断言的具名常量（`check.py --params` 会逐项比对）：

```
stake = clamp(0.15 + 0.22·(conflict_level/4) + 0.30·secret_threat + 0.20·goal_ownership, 0, 1)
```

  `conflict_level` 先归一到 0–1 再乘系数。不归一的话，冲突升到 3 以上时所有在场角色的 stake 都会顶到 1.0，`0.16` 这一项就失去区分度——而"高冲突"恰恰是最需要区分"谁最输不起"的时刻。
  满配 `0.15+0.22+0.30+0.20 = 0.87 < 1`，永远不会触顶。
- `narrator_need` 只在旁白候选上非零；但旁白**主要靠硬节奏**上台（见下）。

**阻尼**（乘法，不是减分）：

```
if cap_on and since == 0 and streak >= 3:  score = 0        // 硬上限
if addressed >= 0.5:                       不阻尼           // 被点名豁免
if since == 0:                             score *= 0.35
if since == 1:                             score *= 0.55
```

乘法而非减分：加分项总和固定为 1，减 0.3 会让"目标相关"永远压不过"刚说过话"；乘法把连任压到 1/3，同时保留被点名时的绝对优先。
**硬上限必须在被点名者也生效**（只有用户硬指定才豁免）——否则审问戏里被连续追问的人会连任 5 拍以上。

**旁白节奏是硬约束，不是权重竞争**：

```
if beats_since_narrator >= 5:  强制旁白（establishing shot / 换气）
场景第一拍：                    强制旁白
```

理由见实测：`W_NARRATOR = 0.12` 在 5 个角色在场时，旁白得分恒低于任一角色，占比 **0%**。用权重表达节奏需求是错的——节奏是政策。

**仲裁**：只有两个以上 `score>0` 的候选且 `top1-top2 < 0.05` 时，调小模型在 top-3 里选一个（输入最近 2 拍 + 三个角色的"想要"，输出 ≤ 60 tok）。实测触发率 **13.5%**（约每 7–8 拍一次）。
`δ=0.03` 只触发 6.5%，等于没有仲裁；`δ=0.06` 触发 20%，等于每五拍就多一次调用。**换候选数必须重扫 δ**，它不是常数。

**复杂度**：O(n log n)，n ≤ 8。
**边界**：空候选集 → `[]`；全员 0 分 → 按"被点名 → 发言次数少 → hash(id)"决定；同 seed 同上下文必须复演同一条序列（探针断言）。

---

### A2 · 上下文装配

```ts
pack(sections: Section[], budget: int): { items, level, tokens, dropped }
```

**公式**：分七段，各自配额 = `budget × ratio`：

| 段 | ratio | 内容 | 稳定性 |
|---|---|---|---|
| card | 0.15 | 角色卡 + 输出契约 | **逐字节稳定**（命中前缀缓存） |
| scene | 0.10 | 场景卡：地点、时间、在场者、目标、冲突等级 | 每场一次 |
| recent | 0.30 | 该角色**感知到的**最近 K 拍 | 每拍变 |
| memory | 0.20 | 该角色已知事实 + 相关记忆 top-8 | 每拍变 |
| relation | 0.10 | 对该场在场者的关系快照 | 每拍变 |
| clue | 0.05 | 未结线索 / 私密目标 | 低频变 |
| contract | 0.10 | 输出 JSON schema + 禁止项 | 稳定 |

**降级阶梯**：`full → summary → triple → id → drop`。整体超预算时先降级全部条目，仍超则按 `keep_rank` 升序**整条丢弃**。
不变式：`tokens ≤ budget` 恒成立；**宁可整条丢，也不截半句**——截断会让模型看到半句话然后自己补全。

**七段配额什么时候生效**：配额（`budget × ratio`）是**超预算时的公平上限**，不是常态硬切。
常态按 `full → summary → triple → id` 整体降级，只要某一级总量 ≤ budget 就停在该级——A2 下面的实测数字走的就是这条路径。
到 `id` 仍超预算时，才逐段裁剪：已知段保留到自己的配额（按 `keep_rank` 整条丢弃），未知段只受全局预算约束；若仍超，再全局按 `keep_rank` 丢弃。
这样既保留「上下文成本与场景长度解耦」，也避免 `recent` 一段在极端情况下吃掉整份预算。

**实测**（6 角色、该角色已知 34 条事实）：

| 场景规模 | 全量注入 | 限知注入 | 缩减 | 装配后 | 等级 |
|---|---|---|---|---|---|
| 40 拍 / 200 事实 | 5712 | 1490 | 3.83× | 4352 | full |
| 80 拍 / 400 事实 | 9792 | 1490 | 6.57× | 4631 | summary |
| 120 拍 / 800 事实 | 15672 | 1490 | 10.52× | 4550 | triple |

注意"限知注入"恒定 1490：近期窗口封顶 16 拍、已知事实封顶 34 条，**不随场景变长而膨胀**。这是限知带来的第二个收益——上下文成本与场景长度解耦。

**排序细节**：动态内容一律放 user turn，system 只放稳定内容。每轮改写 system 会让前缀缓存整体失效（差一个数量级）。记忆块内按分数**升序**排列（最优的紧贴用户消息，利用近因效应）。

**复杂度**：O(m)，m = 条目数。
**边界**：单条超预算 → 丢弃并记 `dropped`；`keep_rank` 相同时按 id 稳定排序；空 memory 段 → 注入"无相关记忆"标记，不静默省略（否则模型会以为"它应该记得但没给"）。

---

### A3 · 知识边界过滤

```ts
visibleFacts(facts: Fact[], charId: string, cog: Cognition[]): Fact[]
```

**规则**：`f ∈ result ⇔ ∃c ∈ cog: c.character_id = charId ∧ c.fact_id = f.id`。
没有认知行 = 不知道。`secrecy ≥ 3` 且该角色在 `redact_for` 里 → 返回 `object: "（未知）"`。

**感知建模**（写入侧，决定 cognition 行怎么产生）：

```ts
buildAudience(present, actor, mode, privateTo?, addressedTo?): string[]
  public          → present - {actor}
  whisper         → privateTo - {actor}          // 耳语只给指定人
  soliloquy       → []                           // 心理独白不进任何人
  narrator_reader → []                           // 旁白默认零感知
```

**关键区分**：`同场 ≠ 可感知`。在场只是必要条件；受众是**每条消息自己的属性**。

**台词不等于事实**：角色输出里的 `asserts` 生成的是 **claim**：
- 若与某 `fact` 匹配且 `truth=1` → 受众获得 `attitude='knows'`
- 若 `truth=-1` 或无对应事实 → 受众获得 `attitude='falsely_believes'`，**世界状态不变**
- 只有作者 / 规划 Agent 能写 `fact`

**实测**：72 次装配下，全量注入平均每次 **128.7 条越权**，前置过滤**累计 0 条**。
**复杂度**：O(F + C)。
**边界**：未知角色 → `[]`；fact 已 supersede → 不注入（即便有认知行，视图 `v_character_knowledge` 已过滤）；`narrator` 的 audience 恒为空。

---

### A4 · 记忆检索

四通道加权 RRF + 绝对刻度 + 有界时效 + 三层收口。

```
s      = Σ_c  w_c / (60 + rank_c)
         w: slot 2.0 | fts 1.3 | vector 1.0 | graph 0.6
rrf_ref = (2.0 + 1.3) / 61 = 0.054098          // "两个精确通道都排第一"
rel     = min(1, s / rrf_ref) × (0.75 + 0.25·R)
final   = 0.60·rel + 0.25·importance + 0.15·conf          // 权重和 = 1
```

**绝不按本次查询的 max 归一**。`rel = s/max` 会让任何查询的头名都拿到 1.0，于是"低于 0.45 当作没记住"这条规则一次也不会触发——你批评过的"阈值不可移植"会在自己设计里原样重演。

**收口三层**：绝对下限（头名 `rel < 0.45` → 返回空，上层注入"无相关记忆"）→ 相对截断（`< 0.6·max`）→ MMR（前 3 名免疫，只对第 4 名起去冗余）。

**时效因子有界且弱**：`0.75 + 0.25·R`。R 的职责是"忘没忘"，不是"排不排序"。若用 `0.4+0.6·R`，"两年前的吵架"会被"一起看剧"压掉；正确性靠双时态过滤，不靠降权。

**R 的定义**（与记忆系统参考文档的偏离，明确说明）：

```
R = 0.5 ** (age_days / halflife[kind])
halflife: event 30 | summary 180 | preference 365 | fact ∞ | relationship ∞ | clue ∞
```

`clue` 不衰减，因为它**靠 `resolved_seq` 退出召回，而不是靠时间**——第 3 章埋的伏笔要记到第 40 章，给它 14 天半衰期等于保证它会丢。回收后移出 `v_open_clue`，自然不再被检索。

参考文档给的是幂律 + FSRS 形状，那是**陪伴型长期记忆**的优化，目标是"模拟遗忘"。
小说项目的正确目标是**相关性与限知**，不是遗忘；而且 `fact`（设定）绝不该衰减。所以 P0 用按 kind 的指数半衰期，简单、可解释、可验证。若 P2 发现陈旧线索持续干扰，再换幂律——那时有真实语料可以对照。

**三个常驻通道不进相关性排序**：`pinned`（关系里程碑/设定）、未结 `clue`（按 `clue_max_age_chapters` 判是否陈旧）、`hard=1` 的禁忌。它们**单独成段**注入，否则被钉住的里程碑在无关查询里也会排第一，把真正相关的内容挤下去。

**复杂度**：向量通道 O(N·d)（12 万条 512 维 = 55 ms）；其余通道走索引，各自 O(log n + k)。
**边界**：空候选 → `[]`；全同分 → 按 id 稳定；单条超预算 → 降级而非截断；`sensitivity ≥ 3` 不进任何自动召回。

---

### A5 · 收束条件求值

```ts
evalExit(expr: ExitExpr, state: SceneState): boolean
```

六个算子，够用且好测：

```
fact   {op:'fact', subject, predicate, object}
rel    {op:'rel', from, to, axis, cmp, value}
beats  {op:'beats', cmp, value}
all / any / not
```

```json
{"op":"any","of":[
  {"op":"all","of":[
    {"op":"fact","subject":"信","predicate":"送达","object":true},
    {"op":"rel","from":"林砚","to":"沈昼","axis":"trust","cmp":"<","value":-0.3}
  ]},
  {"op":"beats","cmp":">=","value":18}
]}
```

**规则**：每拍评估；满足 → 进 `closing`（再写 1 拍收束旁白）→ `closed`。
到 `max_beats` 仍未满足 → 关闭场景 + 写 `WARN exit_conditions_unsatisfied` + **未结线索清单**，不静默截断。

**为什么不用"模型觉得差不多了"**：同源模型自评会通胀，永远"差不多了"；结果是永不结束，或只能靠 60 拍硬截断，而截断处 100% 需要人工收尾。

**复杂度**：O(节点数)，≤ 12。
**边界**：未知算子抛错（不静默 false）；`rel` 轴缺失按 0；`fact` 三态比较用严格相等（`truth=0` 不等于 `true`）。

---

### A6 · 回退：检查点 + 分支重放

```ts
restore(target: {checkpointId} | {seq}): BranchId
```

步骤：

```
1. 找到 ≤ target 的最近快照（同分支）
2. 新建分支 B'：parent = B, fork_seq = target
3. 把快照内容写入 B' 作用域的表（8 个域一起复制）
4. 重放 (snapshot.seq, target] 的事件到 B'
5. 在 B' 上写 restore 事件（记录 from_branch / from_seq）
6. 切换 project_state.active_branch_id = B'
7. 对比章节内容哈希，有变化的入 outbox 重新发布
```

**为什么是"复制快照 + 重放"而不是"给每行加版本号"**：单用户小说项目的分支数是个位数。复制快照的存储成本可以忽略，而多版本行的读路径会给每条查询加 `branch_id + seq` 过滤——那是所有 bug 的来源。

**实测重放成本**（真磁盘 SQLite，WAL）：

| 快照间隔 | 重放耗时 |
|---|---|
| 25 | 0.22 ms |
| 50 | 0.19 ms |
| 100 | 0.22 ms |
| 200 | 0.45 ms |

200 个事件 0.45 ms。**没有任何理由为了省这点时间而只回退一部分状态。**
所以快照间隔取 50（`params.yaml` 的 `rollback.snapshot_interval`；50 事件实测 0.19 ms）。

**8 个状态域**（验收必须逐域计数）：消息、事实、认知、关系、正文、事件卡、摘要、向量。
少退一个域不会报错，只会让下一轮读到已撤销的状态。

**复杂度**：O(快照间隔)。
**边界**：target 早于第一个快照 → 从头重放（罕见，可接受）；分支已存在同名 → 加后缀；回退到当前 head → 拒绝（无意义且会制造空分支）。

---

## 7. Git 与文件发布

**两层版本控制，职责不重叠**：

| 层 | 管什么 | 触发 | 回退方式 |
|---|---|---|---|
| 检查点（SQLite） | **全部 8 个状态域** | 每 50 事件自动 + 场景关闭 + 手动 | `noryth restore --checkpoint` → 开新分支 |
| Git 提交 | **章节文件 + 状态导出包** | 场景关闭 / `noryth commit` 手动 / 桌面壳关应用前（P5） | `noryth restore --from-commit` → 读包 → 开新分支 |

提交内容：

```
chapters/01.md            正文（人可读、可 diff、可外部编辑）
noryth.json               项目清单（模型配置、分支指针）
.noryth/state.json.zst    完整领域状态导出（AI 可恢复）
```

**为什么不提交 `project.db`**：二进制 + WAL + 每次打开都变，git diff 无意义，且二进制冲突无法合并。

**状态导出包（`.noryth/state.json.zst`）**：

- 编码：JSON（UTF-8）→ zstd；`format: noryth-state`、`version: 1`、`schemaVersion: 1`（与 `02-schema.sql` 的 schema 版本一致）。
- 内容：8 个状态域 + 运行必需表（`entity` / `agent_config` / `scene` / `beat` / `message` / `fact` / `cognition` / `relation` / `chapter` / `revision` / `chapter_scene` / `issue` / `event_card` / `lock` / `outbox` / `job` / `memory_node` / `memory_edge`）；列名与 schema 一致，BLOB 以 base64 包装。
- 元数据：`projectId` / `projectName` / `createdAt`、源分支 id/name/seq、`activeSceneId`。
- 导入：只创建新分支，不删除旧分支；主键重分配，外键 / JSON 引用 / 管道引用一起重映射；新分支 head 重新起算（取当前事件 max+1、包 seq+1、包内最大 `message.seq`+1 的最大值），保证复制消息仍排在后续新拍之前。
- 复制来的 beat 没有本分支事件，`breakdown.eventSeq` 归零；该分支只能整体回退到恢复点，不能逐拍 `beat rewind`。需要另一条重来分支时，用同一提交加 `--label`。
- 写入与提交：场景关闭（含收束 / WARN）或显式 `noryth commit` 写包；提交只带 `noryth.json`、状态包、`chapters/`，消息带 `Noryth-Checkpoint/Branch/Schema/Event` trailer。`restore --from-commit` 读提交里的包，不读工作区文件。
- **敏感内容**：包内含完整正文、角色卡和秘密字段；对带远端的仓库执行 push 前必须确认可见性。
- 实现约束：场景提交用临时 index + `commit-tree`，不触发 Git hooks/GPG 签名；需要签名时手动提交。

**编辑冲突（I5 的落地）**：用户在 VS Code 里改了 `chapters/01.md`，哈希变了。
命令层在发布前比对 `outbox.expected_hash` 与磁盘实际哈希：
- 一致 → 写入 `applied_rev`
- 不一致且磁盘内容是"新版本" → 以磁盘为准生成新 revision（作者编辑优先）
- 不一致且磁盘内容被截断/回退 → 报冲突，**不覆盖**，让用户选

**MinGit 的平台差异（真实缺口，不粉饰）**：
- Windows：打包 `MinGit-2.x-64-bit.zip` 到 `resources/git/`，设 `GIT_EXEC_PATH`，完全不依赖系统。
- macOS / Linux：官方没有等价的便携包。方案是（a）优先用系统 git（版本 ≥ 2.30 检查），（b）缺失时降级为"仅检查点版本控制"并明确提示，而不是假装成功。
这条在 `05-roadmap.md` 风险表里单列。

**不可逆操作的边界**：Git 与检查点都只恢复**本地**状态。已经发出去的 API 请求、已花的钱、导出到项目外的文件，回退不回来。UI 上必须在回退确认框里写清楚。

---

## 8. 性能与规模（实测 + 外推）

| 项 | 实测 | 结论 |
|---|---|---|
| 向量暴力扫描 512 维 | 5 千 2.2 ms / 2 万 6.5 ms / 5 万 16.2 ms / **12 万 55 ms** | Node `Float32Array`，单线程；P0–P2 **不需要 ANN** |
| 线性外推 | 50 万 ≈ 246 ms | 到 50 万才需要考虑 sqlite-vec |
| 检查点重放 | 200 事件 0.45 ms（间隔 50 实测 0.19 ms） | 快照间隔 50 |
| 单场 40 拍 | 43 次模型调用，191,080 tok | 见成本 |
| 成本（占位价 2/8 元每百万） | 0.452 元/场；120 场 54.2 元 | 价格必须按供应商重填 |

交互级 SLO（切场景、开章、首 token、回退预览）见 `05-roadmap.md §3.3`——性能预算不写在验收里，就会变成"感觉有点卡"。

结论：**"向量数据库"这一层可以整条删掉**。单文件 SQLite + 内存向量 + 暴力余弦，在小说项目的规模内延迟完全够用，而且备份就是复制一个文件。

---

## 9. 安全与隐私

| 面 | 措施 |
|---|---|
| 密钥 | OS 凭据库；项目文件、日志、导出包均不含 |
| 提示词注入 | 记忆/正文块显式标注"这是数据不是指令"；模型输出必须过 Zod；模型无工具权限 |
| 越权读取 | 检索只在本项目、本分支作用域内；审批 Agent 只读 |
| 文件写入 | 只写 `root_path` 之内；`file_path` 相对路径校验，拒绝 `..` 与绝对路径 |
| 日志 | 默认不落模型原文（可关）；错误日志脱敏 key |
| 导出 | 默认排除 `.noryth/`、`.git/`、日志 |

**一条容易漏的**：`PII 与普通记忆同池` 会让无关查询把"前任""病史"捞出来。`sensitivity ≥ 3` 的记忆**不参与任何自动召回**，只能显式查询。"别提我前任"靠检索过滤，不靠模型自觉。

---

## 10. 未验证项（必须显式列出）

1. **token 估算是启发式**（CJK 0.68 tok/字，ASCII 0.26 tok/字符），不是真分词器。所有上下文体积结论带 ±15% 误差，上线前用目标模型 tokenizer 校准。
2. **调度指标来自合成分布**（500 拍 × 3 种子，焦点惯性 45%），不是真实对话分布。真实分布只能靠录像回放或人工标注。
3. **检索门禁尚未建立**（探针集、dev/held-out 切分）——P2 的任务，本文档不给数字。
4. **跨文件故障注入未做**：outbox 发布中断、崩溃点恢复只在设计上可恢复，未实测。
5. **并发提交未做**：两个进程写同一分支的竞争，只有单实例锁的策略，没有测试。
6. **Electron 打包后 better-sqlite3 原生模块**未验证（`electron-rebuild` 是已知路径，但未在本机跑通）。
7. **成本数字是公式不是账单**：价格、缓存命中率、重试率都会改变结果。
