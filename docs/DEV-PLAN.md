# Noryth 开发方案（DEV-PLAN）

> 版本 v0.3 ｜ 状态：可开工 ｜ 配套：`docs/PRD.md` v0.6、`docs/UI-DESIGN.md` v0.4 ｜ 范围：M0–M2
>
> 本方案把 PRD 的「做什么」翻译成「怎么建、按什么顺序、怎么证明做对了」。与 PRD 冲突时以 PRD 为准；本方案只补 PRD 未定义的工程实现细节，凡属补充均在标题标注「工程补充」。
>
> 文中的 TypeScript / SQL / YAML 片段是**契约示意**，用于固定字段、顺序与不变量，不是可直接编译的实现；落地时以锁定的库版本 API 为准。

**阅读指引**：只看三节 —— §3（模块边界，决定权限能不能落地）、§6（工具层，决定 42 个工具是不是真的可审计）、§12（阶段顺序与砍单，决定 M0 的范围能不能守住）。其余是实现细节，按需查。

### 章节地图

| 区块 | 节 | 回答的问题 |
|---|---|---|
| 判断 | 0–1 | 这份方案补了什么、目标与约束是什么（先读 §0.1） |
| 选型与骨架 | 2–4 | 用什么技术、代码怎么分、进程与 IPC 怎么走 |
| 数据与核心机制 | 5–10 | 状态存哪、工具怎么授权、一拍怎么跑、记忆怎么固化（重点 §6） |
| 界面与交付 | 11–14 | UI 怎么落地、多少工作量、怎么测、怎么发版 |
| 风险与验收 | 15–18 | 会死在哪、怎么证明做对了、还有什么没定 |


---

## 0 本方案补什么

### 0.1 十条工程结论

1. **单人开发，按阶段顺序推进**。没有并行人力，关键路径就是唯一路径：「工具层 → 调度器 → 审批 patch → 记忆应用」。
2. **单 main 进程 + 单 SQLite 连接 + 单写队列**是 R2/R5 的实现形态。不要为性能引入第二个写入者；写入吞吐在这个产品里不是瓶颈。
3. **工具层先于 Agent**：42 个 manifest 在 M0 全部存在，36 个有实现，6 个按里程碑开关（T22/T23/T25/T26/T29/T40）。Agent 提示词最后写。
4. **revision 采用「beat 版本 + revision 清单」**，不复制正文。每拍落盘写 1 行正文 + N 行清单（N = 本章拍数），不是复制整章。
5. **上下文装配与 token 预算必须是纯函数 + 可回放快照**，否则「这轮为什么贵/为什么差」无法归因（PRD §9.5）。
6. **测试主力是假模型服务器**，不是真实 API。CI 不烧钱、不抖动；真实 API 只做 nightly 冒烟。
7. **UI 栅格数字从 `check_ui_spec.py` 生成**，TS 侧不手抄，避免文档与代码两份真相。
8. **`docs/` 目前被 `.gitignore` 整体排除**，PRD 要求的「CI 比对工具清单与 UI 断言」在干净 clone 上跑不起来。开工前必须修（§3.4）。
9. **M0 砍单**：关系图、世界时间线 UI、伏笔追踪、覆盖检查、DOCX 导出、分支 UI、成本报表全部后移。M0 只证明闭环成立（§12.5）。
10. **验收以 PRD §10 的 M0 退出标准为唯一口径**，逐条映射测试 ID（§16），不做「差不多做完了」的汇报。

### 0.2 PRD 未定义、本方案必须补的八个工程缺口

| # | 缺口 | 后果 | 本方案落点 |
|---|---|---|---|
| 1 | 叙事序 `seq` 的分配规则未定义 | `learned_seq` / `covered_until_seq` / `as_of` 全部无锚点 | §5.3 |
| 2 | `beat` 与 `revision` 的复制策略未定义 | 每拍复制整章正文，30 章后库膨胀到不可备份 | §5.4 |
| 3 | 工具 manifest 的生成与 CI 比对没有落地方式 | 「文档说能调、代码没授权」的双份真相 | §6.2 |
| 4 | `grounding` 子集校验的存储结构未定义 | 只能校验 ID 存在，不能校验引用真的被返回过 | §6.6 |
| 5 | 上下文 token 预算只有顺序、没有算法 | 裁剪不可预测，同一章两次跑结果不同 | §7.3 |
| 6 | 中文 bigram 检索只有原则、没有实现 | 查「账本」返回 0 行 | §10.4 |
| 7 | `docs/` 被 gitignore，校验脚本不在仓库 | CI 无法在干净 clone 上执行 PRD 的硬门 | §3.4 |
| 8 | UI 栅格数字在 TS 侧没有单一真源 | 断点与 §2.2 表漂移，1440 又变成四栅 | §11.2 |

---

## 1 工程目标、约束与原则

### 1.1 工程目标（可验证）

| # | 目标 | 验证方式 |
|---|---|---|
| E1 | 空项目 → 3000 字定稿 → 第 2 章检索到第 1 章记忆，全程零手工改库/改文件 | E2E-M0-A（§13.4） |
| E2 | 五条铁律 R1–R5 每条只有一个代码落点，且有 100% 覆盖的测试 | §16.2 铁律落点表 |
| E3 | 42 个工具契约在 M0 冻结；未授权工具不下发；越权成功调用 = 0 | 契约测试 + 注册表快照（§6.8） |
| E4 | 崩溃重启后已确认拍零丢失；生成中的拍可重试 | 混沌测试（§13.6） |
| E5 | 改一拍 → 下游标脏 → 回退 → 逐域状态一致 | 回退测试（§13.5） |
| E6 | 30 章 / 10 万字项目打开、切换、导出不卡（M1/M2 验收） | 性能基线（§13.7） |
| E7 | 打包产物在干净 Windows 10/11 上安装、启动、更新不阻塞写作 | 安装冒烟（§14.4） |

### 1.2 约束

| 约束 | 内容 | 工程含义 |
|---|---|---|
| 单人作者、单窗口写 | 不做账号、不做协作、不做服务端 | 无鉴权、无租户、无并发写协调；只有项目锁 |
| Windows 10/11 x64 首发 | NSIS + 自动更新 | 原生模块 ABI、路径、杀软误报都要在 M0 处理 |
| 纯云端生成、本地嵌入 | 生成需要网络；阅读/编辑/导出离线可用 | 模型层必须可注入假实现；嵌入必须在本地 worker |
| 项目是文件夹 | SQLite 权威 + Markdown 镜像 | 备份 = 复制文件夹；恢复要校验 `schema_version` |
| 预算敏感 | 自动模式可能长跑 | 预算检查在调度器每拍执行，不在 UI 事后统计 |
| 单人开发 | 1 人 | 不引入微服务、消息队列、独立向量库、插件系统；没有并行人力 |

### 1.3 五条工程原则

1. **状态机先于 UI**：闸门与拍状态由 main 的纯 reducer 决定，renderer 只渲染投影。任何「UI 自己判断能不能点」都是缺陷。
2. **契约先于实现**：Zod schema 是唯一真源；DB DDL、工具 manifest、IPC、报告 schema 要么由它派生，要么对它断言。
3. **单写入口**：正文只有 `DocController` 写；记忆/世界状态只有 `MemoryExecutor` 写；其余模块一律 propose。
4. **确定性测试优先**：完整章跑在假模型 + 固定 fixture 上；真模型只验证协议兼容性。
5. **模块边界 = 权限边界**：目录结构直接映射 PRD §4.3 权限矩阵，越界 import 由 CI 拒绝。

### 1.4 单人开发约束

- **1 人**：设计、开发、测试、打包、发布都是同一人；没有并行人力，也没有交接余量。
- 设计输入由 `docs/UI-DESIGN.md` 固定，M0 不做品牌/视觉探索，只做实现与走查。
- 进度只按阶段完成度与验收清单计算。
- 每个阶段以「进入下一阶段的条件」为闸门；不满足就不进入下一阶段。

### 1.5 工程非目标

- 不做多窗口协同编辑、云同步、账号体系（PRD 明确不做）。
- 不做通用插件/MCP/第三方工具安装（PRD §4.9.2 明确 M0–M2 不开放）。
- 不做端侧生成模型；嵌入模型不暴露给作者配置。
- 不做 i18n；M0–M2 只有简体中文界面（代码层留 `t()` 边界即可，不建翻译表）。
- 不做自动发布、封面生成、翻译（PRD §10 明确不做）。

---

## 2 技术选型

### 2.1 选型表

| 领域 | 选择 | 理由 | 被拒方案与原因 |
|---|---|---|---|
| 桌面壳 | Electron + electron-vite | 三入口（main/preload/renderer）开箱即用，HMR 与打包链路成熟 | Electron Forge（配置分散）、Tauri（WebView2 版本差异 + 原生模块生态不足） |
| 打包 | electron-builder + NSIS + electron-updater（GitHub provider） | PRD 指定 NSIS + GitHub Releases；`asarUnpack` 与原生模块重建支持最好 | Squirrel（Windows 上更新体验差）、MSIX（签名与分发门槛高） |
| 语言 | TypeScript `strict`，ESM | 契约多、状态多，类型是第一道闸门 | 纯 JS（42 个工具 schema 无法约束） |
| UI | React 19 + Zustand + CSS Modules + CSS 变量 | 状态少而集中；设计 token 严格，组件库会带来覆盖成本 | Tailwind（token 约束弱）、MUI/AntD（视觉不可控、体积大） |
| 正文编辑 | CodeMirror 6（拍级纯文本）+ 自绘只读 `ProseView` | 中文 IME 稳定、撤销栈可靠、按拍编辑边界清晰 | TipTap/ProseMirror（富文本能力用不上，反而引入 schema 复杂度）、textarea（长文撤销与选中体验差） |
| 数据库 | better-sqlite3 + 手写 SQL 迁移 + Kysely | 同步 API 简化事务；SQL 迁移能写部分唯一索引、CHECK、触发器 | Drizzle（schema 与 SQL 两份真源）、Prisma（引擎重、迁移不可控）、TypeORM（装饰器与 ESM 摩擦） |
| 向量 | sqlite-vec（Plan B：BLOB + 进程内余弦） | 与状态同库，无双写；PRD §7.4 明确 P0 不引入独立向量库 | LanceDB/Chroma（第二个真相源、打包体积） |
| 嵌入 | `@huggingface/transformers`（ONNX，bge-small-zh-v1.5，q8）跑在 `utilityProcess` | 离线、CPU 可接受、模型随包分发；进程隔离防 ONNX 崩溃拖死 main | onnxruntime-node 直连（要自己做 tokenizer/pooling）、调用云端 embedding（违背离线与成本约束） |
| 校验 | Zod + `zod-to-json-schema` | 一份 schema 同时做运行时校验、工具 JSON Schema、IPC 校验 | JSON Schema 手写（易漂移）、io-ts（生态弱） |
| 模型调用 | 自研 OpenAI-compatible 适配器（fetch + SSE） | 需要控制流式增量、工具调用增量拼装、错误归一化、取消 | openai SDK（供应商差异与重试策略不可控）、LangChain（不可审计的抽象层） |
| 测试 | Vitest + Playwright（`_electron`）+ 假 LLM 服务器 | 单测快；E2E 能驱动真实 Electron；假模型保证确定性 | Jest（ESM+TS 配置成本）、仅手工测试（42 工具无法覆盖） |
| 日志 | pino → JSONL（按项目分文件 + 全局环形缓冲） | 结构化、可脱敏、可打包诊断 | console（不可检索）、winston（重） |
| 依赖边界 | dependency-cruiser | 把「renderer 不能 import main」「shared 不能 import electron」变成 CI 规则 | ESLint 手写规则（覆盖不全） |
| 包管理 | pnpm | 原生模块与 Electron 重建的锁文件稳定；磁盘占用低 | npm（hoisting 导致原生模块解析歧义） |

### 2.2 版本锁定策略

- Electron、better-sqlite3、sqlite-vec、onnxruntime 四个包**同一批次升级**，升级必须过 §13.6 的打包冒烟；其余依赖按月升级。
- `package.json` 记录 `electron` 精确版本（不带 `^`）；CI 用 `pnpm install --frozen-lockfile`。
- 每个里程碑冻结一次依赖树，冻结后只接受安全补丁。

### 2.3 原生模块与打包的三个硬约束

| 约束 | 做法 | 失败表现 |
|---|---|---|
| better-sqlite3 ABI 必须匹配 Electron | `electron-rebuild` 作为 postinstall；`electron-builder` 开 `npmRebuild` | `NODE_MODULE_VERSION` 不匹配，启动即崩 |
| sqlite-vec 是 loadable extension | `asarUnpack: ["**/*.node", "**/sqlite-vec*/**", "resources/models/**"]`；`app.isPackaged` 时从 `process.resourcesPath` 解析 | 打包后 `db.loadExtension` 找不到文件 |
| ONNX 模型与运行时不能进 asar | 模型放 `resources/models/bge-small-zh-v1.5/`，`extraResources` 复制；`env.localModelPath` 指向该目录 | 首启去 HuggingFace 下载，离线失败 |

---

## 3 仓库结构与模块边界

### 3.1 目录树（M0 目标形态）

```
noryth/
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json / tsconfig.node.json / tsconfig.web.json
├─ .dependency-cruiser.cjs
├─ resources/
│  ├─ models/bge-small-zh-v1.5/        # ONNX + tokenizer，随包分发
│  └─ icons/
├─ src/
│  ├─ shared/                          # 纯 TS：两端共用，禁止 import electron / node:fs
│  │  ├─ schema/                       # Zod：信封、报告、提案、分镜、DSL、IPC
│  │  ├─ domain/                       # 枚举、状态迁移表、错误码、常量
│  │  ├─ layout/                       # 栅格 token（由脚本生成）
│  │  └─ util/                         # 纯函数：hash、canonicalJson、bigram、token 估算
│  ├─ preload/
│  │  └─ index.ts                      # contextBridge，按命名空间暴露，无通用 invoke
│  ├─ main/
│  │  ├─ index.ts                      # app 生命周期、单实例、窗口、协议
│  │  ├─ ipc/                          # 路由注册 + Zod 校验 + 错误映射
│  │  ├─ db/                           # 连接、迁移、repos、verify、backup、lock
│  │  ├─ tools/                        # 注册表、解析、调用、闸门、幂等、审计
│  │  ├─ agents/                       # 6 个 Agent 的运行时与提示词
│  │  ├─ context/                       # L0–L3 装配、预算、裁剪、快照
│  │  ├─ model/                        # 适配器、能力探测、SSE、重试、绑定快照
│  │  ├─ scheduler/                    # 发牌、收束、预算、暂停、恢复
│  │  ├─ doc/                          # 文档控制器、revision、patch、finalize
│  │  ├─ memory/                       # 抽取、提案、执行器、重建、检索
│  │  ├─ review/                       # 报告、复检、维度映射
│  │  ├─ embed/                        # utilityProcess 入口与协议
│  │  ├─ settings/                     # safeStorage、预设、绑定
│  │  └─ observability/                # 日志、turn_metric、诊断包
│  ├─ renderer/
│  │  ├─ app/                          # 路由、外壳、命令面板、通知
│  │  ├─ pages/{home,plan,write,review,memory,settings}/
│  │  ├─ components/                   # 拍卡、确认条、报告、diff、提案、chips
│  │  ├─ stores/                       # project / session / run / ui
│  │  └─ styles/                       # tokens.css、reset、排版
│  └─ workers/                         # 假 LLM 服务器、fixture 加载（仅测试）
├─ tests/
│  ├─ unit/  ├─ contract/  ├─ integration/  ├─ e2e/  └─ fixtures/
├─ scripts/                            # 生成物校验、打包、诊断
└─ docs/                               # 设计文档 + tools/*.json（见 §3.4）
```

### 3.2 依赖规则（CI 强制）

| 规则 | 原因 | 违规示例 |
|---|---|---|
| `renderer` 不得 import `main` / `node:*` / `electron` | renderer 无文件与 Key 权限（PRD §4.1） | `import fs from 'node:fs'` |
| `shared` 不得 import `electron` / `node:fs` / `main` / `renderer` | 两端共用，必须可在一个纯 JS 环境跑测试 | `shared/schema` 里读文件 |
| `main` 不得 import `renderer` | 反向依赖会把 UI 状态带进状态机 | 复用 renderer 的 store |
| `db` 不得 import `agents` / `scheduler` | 存储层不知道业务；否则事务边界失控 | repo 里调 LLM |
| `tools` 只能通过 `db/repos` 与 `services` 访问数据 | 工具不得直接写 SQL（I1） | `tool` 里 `db.prepare(...)` |
| `renderer` 只能通过 `window.noryth` 访问能力 | IPC 白名单 | 直接 `ipcRenderer.invoke` |

### 3.3 模块 → PRD 映射

| 模块 | PRD 落点 | 唯一职责 | 明确不做 |
|---|---|---|---|
| `db/repos` | §7 | 事务内的读写原语 | 业务判断、状态迁移 |
| `tools` | §4.9–4.11 | 注册、解析、调用、审计 | 拼上下文、裁决质量 |
| `context` | §8.1 | L0–L3 装配与预算 | 检索（只消费 refs） |
| `scheduler` | §6.2、§6.5 | 发牌、收束、暂停、预算 | 生成正文、改分镜 |
| `doc` | §4.7、§5.3 | revision、hash、patch、定稿 | 判断内容好坏 |
| `memory` | §6.4、§7.5、§10 | 抽取、提案、应用、检索 | 改正文、读初稿 |
| `review` | §5.3、§6.3 | 报告、patch 提案、复检 | 定稿、改设定 |
| `agents` | §4.2、§4.6 | 提示词、信封、工具意图 | 直接落盘 |

### 3.4 开工前必须修的仓库问题

`.gitignore` 当前包含 `/docs/`，注释是「设计文档（本地保留，不进仓库）」。这带来两个直接后果：

1. PRD §4.10 要求「`docs/tools/*.json` 与本节由 CI 比对」，`docs/scripts/check_ui_spec.py` 也要求可执行——干净 clone 上这些文件不存在，CI 硬门形同虚设。
2. 换机器或重装后拿到仓库，没有任何规格可读。

**处理（三选一，建议 A）**：

| 方案 | 做法 | 评价 |
|---|---|---|
| A（建议） | 把 `/docs/` 改为只忽略草稿：`/docs/**/*.local.md`，其余入库；`docs/tools/`、`docs/scripts/`、`docs/PRD.md`、`docs/UI-DESIGN.md` 必须入库 | 契约与规格可追溯，CI 可跑 |
| B | 把 `tools/*.json` 与校验脚本移到 `spec/`，`docs/` 继续本地 | 契约入库，但文档仍不可追溯 |
| C | 维持现状，CI 跳过文档比对 | 等于放弃 PRD §4.10 的硬门，不建议 |

同时补 `scripts/gen-check.mjs`：所有生成物（`docs/tools/*.json`、`src/shared/layout/grid.generated.ts`、`src/main/tools/generated/allowlist.ts`）重新生成后必须与仓库一致，不一致即 CI 失败。

---

## 4 进程、IPC 与安全

### 4.1 进程模型

| 进程 | 职责 | 生命周期 | 崩溃影响 |
|---|---|---|---|
| `main` | 窗口、IPC、SQLite、向量索引、调度器、Agent 运行时、模型调用、文件 IO | 与应用同寿 | 全崩；靠 job 表恢复 |
| `renderer` | 只做 UI 与本地交互状态 | 每窗口一个 | 重载即可；不持有未落盘正文 |
| `embed utilityProcess` | ONNX 推理、tokenize、批量嵌入 | 懒启动，空闲 5 分钟退出 | 只影响检索；main 重启 worker 并降级为 `facts_only` |

**不引入**：独立 Node 服务、第二个 SQLite 连接、renderer 内的数据库访问。所有写入串行经过 main 的写队列（`p-queue` concurrency=1，按 `project_id` 分键）。

### 4.2 IPC 契约

```ts
// shared/schema/ipc.ts
export const IpcRequest = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({ requestId: z.string(), payload });

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };
```

| 规则 | 内容 |
|---|---|
| 通道命名 | `<domain>.<action>`，如 `project.open`、`beat.confirm`、`review.run` |
| 参数校验 | 每个 handler 入口 `schema.parse`；失败返回 `invalid_args`，不抛异常到 renderer |
| 错误模型 | 统一 `IpcResult`；renderer 不 catch 原始异常 |
| 事件 | `event:<domain>.<name>`，payload 必带 `jobId` 与 `seq`（单调），renderer 丢弃乱序 |
| 流式 | main 以 32ms 批量 flush token；`seq` 递增；`done` 事件带最终 `revisionId` |
| 背压 | renderer 每 200ms 回 `ack(seq)`；未 ack 超过 500 条时 main 暂停发送（仅影响 UI，不影响落盘） |
| 取消 | `job.cancel(jobId)` → AbortController；迟到结果由 `epoch + expected_revision` 拒绝（PRD §4.9.5） |

**preload 只暴露命名空间，不暴露通用 `invoke(channel, ...)`**：

```ts
contextBridge.exposeInMainWorld('noryth', {
  project: { create, open, list, removeFromList },
  plan:    { send, stop, applySuggestion, confirmG1 },
  write:   { start, pause, resume, confirmBeat, regenerate, editBeat, switchMode },
  review:  { run, discuss, authorizePatches, decidePatch, finalize },
  memory:  { propose, apply, rebuild, query },
  settings:{ get, setProvider, testProvider, bindAgent },
  on: (event, cb) => { /* 白名单事件 */ },
});
```

### 4.3 IPC 方法表（M0）

| 域 | 方法 | 请求要点 | 返回 | 闸门 |
|---|---|---|---|---|
| project | `create` | 目录、题材、篇幅、POV、边界 | `{projectId}` | G0 |
| project | `open` | 路径 | `{projectId, readOnly, setupState}` | — |
| project | `list` | — | 项目摘要数组 | — |
| project | `removeFromList` | id | `{ok}`（不删盘） | — |
| plan | `send` | sessionId、文本、引用 chips | `{jobId}` | — |
| plan | `confirmG1` | 蓝图版本、角色清单 | `{registered, setupState}` | G1 |
| plan | `applySuggestion` | 建议 id | `{draftVersion}` | — |
| write | `start` | chapterId、mode（beat/auto） | `{jobId}` | G2 |
| write | `pause` / `resume` | jobId | `{status}` | — |
| write | `confirmBeat` | beatId、expectedRevision | `{revisionId, nextBeatId?}` | G3 |
| write | `regenerate` | beatId、expectedRevision | `{jobId}` | G3 |
| write | `editBeat` | beatId、text、expectedRevision、range 策略 | `{revisionId}` | G3 |
| write | `switchMode` | chapterId、mode | `{mode}` | — |
| review | `run` | chapterId、revisionId | `{jobId}` | G4 |
| review | `authorizePatches` | reportId | `{jobId}` | G5 |
| review | `decidePatch` | patchId、accept/reject | `{revisionId?}` | G5 |
| review | `finalize` | chapterId、revisionId、ackUnreviewed | `{finalRevisionId, memoryJobId}` | G6 |
| memory | `propose` | chapterId、revisionId | `{jobId}` | — |
| memory | `apply` | jobId、decisions[] | `{appliedCount}` | G7 |
| memory | `rebuild` | chapterId | `{jobId}` | author_confirm |
| settings | `setProvider` / `testProvider` | provider、key、baseUrl | `{status, models[], latencyMs}` | — |
| settings | `bindAgent` | agentKey、provider、model、params | `{bindingVersion}` | — |
| export | `run` | 范围、格式 | `{path}` | — |

### 4.4 安全基线（M0 必须全绿）

| 项 | 设置 | 验证 |
|---|---|---|
| `contextIsolation` | `true` | 启动断言 |
| `nodeIntegration` | `false` | 启动断言 |
| `sandbox` | `true`（preload 只用 IPC） | 启动断言 |
| CSP | `default-src 'self'; connect-src 'none'`（renderer 不发网络请求） | 响应头检查 |
| 导航 | `will-navigate` 拒绝外部；`setWindowOpenHandler` 一律 deny | E2E 点击外链 |
| 外链 | 只允许 `https://` 且走 `shell.openExternal` | 单元测试 |
| API Key | `safeStorage.encryptString` → `%APPDATA%/noryth/secrets.bin` | 断言项目目录无 Key 字符串 |
| 日志脱敏 | Key、Authorization、baseUrl 的 query、正文不入日志 | 日志扫描测试 |
| 诊断包 | 只含日志、schema 版本、job 摘要；不含正文与 Key | 手工检查 |

### 4.5 窗口与项目锁

- 单实例：`app.requestSingleInstanceLock()`；第二次启动聚焦已有窗口。
- 项目锁：`<project>/.noryth.lock`，内容 `{pid, host, windowId, appVersion, heartbeatAt}`；心跳 5s；判定过期 = 进程不存在或心跳 > 30s。
- 第二个窗口打开同一项目 → `readOnly: true`，顶部 32px 常驻横幅，所有写入 IPC 在 main 侧直接拒绝（`project_locked`），不是靠 UI 禁用。
- 崩溃后残留锁：启动时检测 pid 不存在 → 自动接管并写 `lock_recovered` 日志。

---

## 5 数据层

### 5.1 存储布局

```
<project>/
├─ noryth.db            # SQLite WAL：状态权威
├─ noryth.db-wal / -shm
├─ .noryth.lock         # 项目锁
├─ manuscript/          # Markdown 镜像：ch-001.md
├─ assets/              # 角色卡导出、只读参考稿（不进任何上下文）
├─ exports/             # 导出快照
├─ backups/             # checkpoint-<seq>.db、daily-<date>/
└─ logs/                # turn JSONL、tool JSONL（可关闭）
```

### 5.2 连接与 PRAGMA

```ts
const db = new Database(join(projectDir, 'noryth.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');
db.pragma('wal_autocheckpoint = 1000');
```

- 单连接、单写队列；读也走同一连接（同步 API，微秒级），不做连接池。
- 长任务（导出、重建索引）分批提交，避免长事务阻塞 WAL checkpoint。
- 备份用 `VACUUM INTO`（一致性快照），不用文件复制（WAL 未 checkpoint 时复制会拿到半状态）。

### 5.3 叙事序 `seq` 分配（工程补充）

PRD 用 `seq` / `learned_seq` / `covered_until_seq` / `as_of` 描述认知边界，但没定义谁分配。规则：

1. `project.seq_head` 是唯一计数器，**只在写事务内递增**（`UPDATE project SET seq_head = seq_head + 1 WHERE id = ? RETURNING seq_head`）。
2. 一次「叙事事件」分配一个 seq：一拍提交、一条世界事实断言、一条关系边变化。同一次记忆应用的多条条目共享同一个 seq（它们来自同一段叙事）。
3. `beat.seq` 在 `doc.commit_beat` 内分配；`memory_entry.learned_seq` = 来源 `beat.seq`，**不重新分配**，否则 as-of 会把记忆放到未来。
4. `chapter.covered_until_seq` = 本章所有 `confirmed/author_edited` 拍的最大 `seq`，在每次提交与定稿时重算。
5. 回退不回收 seq（append-only）；回退后新写入继续用更大的 seq，`as_of` 仍单调。

### 5.4 revision 模型：beat 版本 + 清单（工程补充）

PRD §7.1 的 `beat.revision_id` 若理解为「每拍复制整章」，30 章 × 24 拍 × 24 次重生成会产生数万行重复正文。本方案改为：

| 实体 | 语义 |
|---|---|
| `beat` | 一个**正文版本**：一行文本、一个状态、一个 `created_revision_id`，被替换时标 `superseded` 并保留 |
| `revision` | 一次落盘的**清单**：`content_hash` + `parent_revision_id` + 作者/来源 |
| `revision_beat` | 清单成员：`(revision_id, scene_ord, beat_ord) → beat_id` |
| `chapter.current_revision_id` | 指向当前草稿清单 |
| `chapter.final_revision_id` | 指向定稿清单（只读） |

收益：一次拍提交写 1 行正文 + N 行清单；定稿是清单快照，不是正文复制；对比任意两版只需 join 两张清单。

`content_hash` 的规范形式（必须固定，否则跨机器不一致）：

```
for each scene in chapter_scene order:
  "## scene:<scene_id>\n"
  for each beat in revision_beat order:
    "<speaker_type>:<speaker_id>\n<body>\n\n"
sha256(utf8(concat)) → hex
```

### 5.5 核心 DDL（迁移 0001）

```sql
CREATE TABLE _migration (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE project (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  genre           TEXT NOT NULL DEFAULT '',
  pov             TEXT NOT NULL CHECK (pov IN ('first','third_limited','third_omniscient')),
  target_words    INTEGER,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  setup_state     TEXT NOT NULL DEFAULT 'pending' CHECK (setup_state IN ('pending','complete','failed')),
  embedding_model TEXT NOT NULL,
  embedding_dim   INTEGER NOT NULL,
  default_preset  TEXT NOT NULL CHECK (default_preset IN ('openai','deepseek','tongyi')),
  seq_head        INTEGER NOT NULL DEFAULT 0,
  write_epoch     INTEGER NOT NULL DEFAULT 0,
  schema_version  INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE outline_node (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES outline_node(id) ON DELETE RESTRICT,
  kind       TEXT NOT NULL CHECK (kind IN ('main','volume','chapter')),
  ord        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','locked')),
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX outline_root_ord  ON outline_node(project_id, ord) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX outline_child_ord ON outline_node(parent_id, ord) WHERE parent_id IS NOT NULL;

CREATE TABLE character (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  card_json    TEXT NOT NULL,
  card_version INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE chapter (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  outline_node_id     TEXT NOT NULL UNIQUE REFERENCES outline_node(id),
  ord                 INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (
                        'planned','storyboard_ready','drafting','draft_complete',
                        'under_review','revising','approved','finalized','paused','abandoned')),
  covered_until_seq   INTEGER NOT NULL DEFAULT 0,
  current_revision_id TEXT,          -- 软引用 revision(id)：避免与 revision 循环外键
  final_revision_id   TEXT,
  opened_at           TEXT,
  finalized_at        TEXT,
  UNIQUE (project_id, ord)
);

CREATE TABLE scene (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,          -- 项目内展示顺序；章内顺序以 chapter_scene.ord 为准
  location         TEXT NOT NULL,
  participants_json TEXT NOT NULL,            -- [{character_id, role}]
  goal             TEXT NOT NULL,
  entry            TEXT NOT NULL DEFAULT '',
  exit_json        TEXT NOT NULL,             -- DSL AST（§8.4）
  status           TEXT NOT NULL CHECK (status IN ('planned','open','closing','closed','paused')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE chapter_scene (
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  scene_id   TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  PRIMARY KEY (chapter_id, ord),
  UNIQUE (chapter_id, scene_id)
);

CREATE TABLE revision (
  id                 TEXT PRIMARY KEY,
  chapter_id         TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES revision(id),
  kind               TEXT NOT NULL CHECK (kind IN ('draft','final')),
  content_hash       TEXT NOT NULL,
  created_by         TEXT NOT NULL CHECK (created_by IN ('author','doc_controller','reviewer')),
  note               TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE beat (
  id                  TEXT PRIMARY KEY,
  chapter_id          TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  scene_id            TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  ord                 INTEGER NOT NULL,
  seq                 INTEGER,
  speaker_type        TEXT NOT NULL CHECK (speaker_type IN ('character','narrator')),
  speaker_id          TEXT NOT NULL,
  intent              TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  grounding_json      TEXT NOT NULL DEFAULT '[]',
  trace_ref           TEXT,
  status              TEXT NOT NULL CHECK (status IN (
                        'proposed','generating','draft','waiting_for_human','confirmed',
                        'regenerating','rejected','author_edited','stale','superseded','interrupted')),
  supersedes_id       TEXT REFERENCES beat(id),
  created_revision_id TEXT NOT NULL,
  max_words           INTEGER,
  word_count          INTEGER NOT NULL DEFAULT 0,
  author_edited       INTEGER NOT NULL DEFAULT 0,
  decided_by          TEXT CHECK (decided_by IN ('author','auto')),  -- 自动模式接受时记 auto
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX beat_ord_live      ON beat(scene_id, ord) WHERE status <> 'superseded';
CREATE UNIQUE INDEX beat_supersedes_once ON beat(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX beat_by_chapter           ON beat(chapter_id, scene_id, ord);

CREATE TABLE revision_beat (
  revision_id TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  beat_id     TEXT NOT NULL REFERENCES beat(id),
  scene_ord   INTEGER NOT NULL,
  beat_ord    INTEGER NOT NULL,
  PRIMARY KEY (revision_id, scene_ord, beat_ord),
  UNIQUE (revision_id, beat_id)
);

CREATE TABLE patch (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  proposal_id       TEXT NOT NULL,
  revision_id       TEXT NOT NULL REFERENCES revision(id),
  beat_id           TEXT NOT NULL REFERENCES beat(id),
  before            TEXT NOT NULL,
  after             TEXT NOT NULL,
  reason            TEXT NOT NULL,
  issue_ref         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','applied','superseded')),
  applied_revision_id TEXT,
  created_at        TEXT NOT NULL,
  decided_at        TEXT
);
```

### 5.6 知识与审计表

```sql
CREATE TABLE memory_entry (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL REFERENCES character(id),
  kind              TEXT NOT NULL CHECK (kind IN ('experience','fact','relationship','cognition')),
  text              TEXT NOT NULL,
  learned_seq       INTEGER NOT NULL,
  source_chapter_id TEXT NOT NULL REFERENCES chapter(id),
  source_revision_id TEXT NOT NULL REFERENCES revision(id),
  source_beat_id    TEXT REFERENCES beat(id),
  importance        REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  pinned            INTEGER NOT NULL DEFAULT 0,
  valid_from_seq    INTEGER,
  valid_to_seq      INTEGER,
  supersedes_id     TEXT REFERENCES memory_entry(id),
  embedding_model   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','superseded')),
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_supersedes_once ON memory_entry(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX memory_own ON memory_entry(character_id, status, learned_seq);

CREATE TABLE world_fact (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL,
  predicate      TEXT NOT NULL,
  object         TEXT NOT NULL,
  single_value   INTEGER NOT NULL DEFAULT 1,     -- 由谓词登记表决定；1 时启用单值槽唯一索引
  truth          TEXT NOT NULL CHECK (truth IN ('objective','claim')),
  visibility     TEXT NOT NULL CHECK (visibility IN ('public','secret')),
  known_by_json  TEXT NOT NULL DEFAULT '[]',
  reveal_seq     INTEGER,
  valid_from_seq INTEGER NOT NULL,
  valid_to_seq   INTEGER,
  source_type    TEXT NOT NULL CHECK (source_type IN ('author','event','memory')),
  source_id      TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX world_single_value
  ON world_fact(project_id, subject, predicate)
  WHERE valid_to_seq IS NULL AND single_value = 1 AND truth = 'objective';
CREATE INDEX world_asof ON world_fact(project_id, valid_from_seq, valid_to_seq);

CREATE TABLE character_belief (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES character(id),
  fact_id       TEXT REFERENCES world_fact(id),
  belief_text   TEXT NOT NULL,
  confidence    REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  learned_seq   INTEGER NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN ('dialogue','narration','inference','author')),
  source_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','inactive')),
  created_at    TEXT NOT NULL
);

CREATE TABLE relationship_edge (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  from_id       TEXT NOT NULL REFERENCES character(id),
  to_id         TEXT NOT NULL REFERENCES character(id),
  axis          TEXT NOT NULL CHECK (axis IN ('trust','intimacy','tension')),
  value         REAL NOT NULL CHECK (value BETWEEN -1 AND 1),
  since_seq     INTEGER NOT NULL,
  valid_to_seq  INTEGER,
  source_type   TEXT NOT NULL CHECK (source_type IN ('event','memory','author')),
  source_id     TEXT,
  supersedes_id TEXT REFERENCES relationship_edge(id),
  CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX rel_one_active
  ON relationship_edge(from_id, to_id, axis) WHERE valid_to_seq IS NULL;

CREATE TABLE approval_report (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id    TEXT NOT NULL REFERENCES chapter(id),
  revision_id   TEXT NOT NULL REFERENCES revision(id),
  round         INTEGER NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','pass_with_notes','fail')),
  blocking_json TEXT NOT NULL DEFAULT '[]',
  suggestions_json TEXT NOT NULL DEFAULT '[]',
  dimensions_json  TEXT NOT NULL DEFAULT '{}',
  degraded      TEXT,
  model         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE gate_record (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  gate_id     TEXT NOT NULL CHECK (gate_id IN ('G0','G1','G2','G3','G4','G5','G6','G7','author_confirm')),
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approve','reject','edit')),
  actor       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  token_hash  TEXT,
  expires_at  TEXT,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX gate_token ON gate_record(token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE job (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type               TEXT NOT NULL CHECK (type IN (
                       'beat.generate','review.run','patch.propose','memory.extract',
                       'memory.apply','memory.rebuild','export.run','index.rebuild','backup.create')),
  status             TEXT NOT NULL CHECK (status IN ('queued','running','paused','succeeded','failed','cancelled','interrupted')),
  expected_revision  TEXT,
  epoch              INTEGER NOT NULL,
  idempotency_key    TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  result_json        TEXT,
  error_code         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX job_idem ON job(project_id, idempotency_key);

CREATE TABLE tool_call (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_id           TEXT NOT NULL,
  turn_id          TEXT NOT NULL,
  tool             TEXT NOT NULL,
  tool_version     TEXT NOT NULL,
  actor_id         TEXT NOT NULL,
  scope_json       TEXT NOT NULL,
  args_hash        TEXT NOT NULL,
  result_ids_json  TEXT NOT NULL DEFAULT '[]',
  result_json      TEXT,              -- 仅幂等工具（propose/execute）存首结果，用于重放
  status           TEXT NOT NULL CHECK (status IN ('ok','error')),
  error_code       TEXT,
  latency_ms       INTEGER NOT NULL,
  degraded         TEXT,
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX tool_idem ON tool_call(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX tool_by_turn ON tool_call(turn_id);

CREATE TABLE model_binding (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_key   TEXT NOT NULL,        -- planner/orchestrator/narrator/reviewer/memory/character/character:<id>
  provider    TEXT NOT NULL CHECK (provider IN ('openai','deepseek','tongyi')),
  model       TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, agent_key)
);

CREATE TABLE model_binding_audit (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_key  TEXT NOT NULL,
  old_json   TEXT,
  new_json   TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('manuscript_md')),
  path          TEXT NOT NULL,
  expected_hash TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  published_at  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE turn_metric (
  turn_id        TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_id         TEXT NOT NULL,
  beat_id        TEXT,
  agent_key      TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_cny       REAL,
  latency_ms     INTEGER,
  first_token_ms INTEGER,
  context_json   TEXT NOT NULL,     -- 区块 + token + refs，用于检查器与归因
  degraded_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);

CREATE TABLE memory_proposal_item (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('experience','fact','relationship','cognition','world_fact','belief')),
  character_id      TEXT REFERENCES character(id),
  text              TEXT NOT NULL,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  source_chapter_id TEXT NOT NULL REFERENCES chapter(id),
  source_revision_id TEXT NOT NULL REFERENCES revision(id),
  source_beat_id    TEXT REFERENCES beat(id),
  importance        REAL NOT NULL DEFAULT 0.5,
  pinned            INTEGER NOT NULL DEFAULT 0,
  decision          TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','accept','edit','reject')),
  edited_text       TEXT,
  decided_at        TEXT
);
CREATE INDEX proposal_by_job ON memory_proposal_item(job_id, decision);
```

**中文关键词检索（工程补充，§10.4 使用）**：

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  character_id UNINDEXED,
  bigrams,
  tokenize = 'ascii'
);
```

`bigrams` 由应用层写入：`父亲书房` → `父亲 亲书 书房`；查询串同样展开，`MATCH '父亲 OR 亲书'`。不依赖分词器，不会把整段中文当一个 token。

**向量索引（Plan A）**：

```sql
-- sqlite-vec 的 metadata 列语法随版本略有差异（TEXT 列或 `+memory_id TEXT`），以 S1 spike 锁定的版本为准
CREATE VIRTUAL TABLE memory_vec USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding FLOAT[512]
);
```

Plan B（spike 失败时）：`embedding BLOB` 存在 `memory_entry` 扩展表，进程内余弦；2 万条 × 512 维 ≈ 40MB，单次全扫 10–20ms，可接受。

### 5.7 约束与索引清单（验收用）

| # | 约束 | 落点 | 防什么 |
|---|---|---|---|
| C1 | 章内场景顺序唯一 | `chapter_scene` PK | 一章两场同序 |
| C2 | 一拍只有一个现行版本 | `beat_ord_live` 部分唯一 | 重生成产生双活拍 |
| C3 | 一拍只能被替换一次 | `beat_supersedes_once` | 追溯链分叉 |
| C4 | 单值槽同时只有一个有效事实 | `world_single_value` | 「住上海」与「住北京」并存 |
| C5 | 关系边每个轴一条有效边 | `rel_one_active` | 信任值双写 |
| C6 | 记忆条目只被取代一次 | `memory_supersedes_once` | 记忆链分叉 |
| C7 | 任务幂等键唯一 | `job_idem` | 重复提交生成双份 |
| C8 | 工具幂等键唯一 | `tool_idem` | 重放写两次 |
| C9 | 闸门令牌只能用一次 | `gate_token` 唯一 + `consumed_at` | 令牌跨 job 复用 |

### 5.8 outbox 与 Markdown 镜像

1. `doc.commit_beat` 在同一事务里写 `beat`、`revision`、`revision_beat`、`outbox`。
2. 事务提交后，`OutboxPublisher` 读未发布行，渲染 Markdown，写临时文件 `ch-001.md.tmp` → `fsync` → `rename`。
3. 期望 hash 写进 `outbox.expected_hash`；发布后校验磁盘 hash，不一致标 `publish_pending` 并重试（最多 5 次，指数退避）。
4. 外部编辑检测：打开项目、切章、保存前各比对一次 `mtime + size + hash`；不一致 → `file_conflict`，冻结该章写入，要求作者选「以 DB 为准」或「导入外部正文镜像」。
5. Markdown 格式固定（frontmatter 不含 hash，避免自指）：

```markdown
---
chapter_id: ch_003
revision: rev_012
title: 祠堂夜谈
---

她把茶盏往他那边推了推……

「你在我爹书房里，见过一只黑漆匣子吗？」
```

### 5.9 项目锁、备份与恢复

| 项 | 规则 |
|---|---|
| 检查点 | 每章 `finalized` 后 `VACUUM INTO backups/checkpoint-<seq>.db` |
| 日备份 | 每日首次打开时复制整个项目文件夹到 `backups/daily-<yyyy-mm-dd>/`（排除 `backups/` 自身） |
| 保留 | 默认 10 个检查点 + 7 个日备份；可在设置调整 |
| 恢复 | 打开备份目录 → 校验 `schema_version` 与 `PRAGMA integrity_check` → 只读打开确认 → 复制回项目 |
| 删除 | 删项目文件夹 + 清 `%APPDATA%/noryth/cache/<projectId>`；不做软删除 |

### 5.10 迁移与 schema 版本

- 迁移文件 `src/main/db/migrations/0001_init.sql`、`0002_*.sql`，只前进不回滚。
- 每个文件首行 `-- name: ...`；迁移器计算 sha256 存入 `_migration.checksum`，已应用文件被改动 → 启动失败并报 `migration_checksum_mismatch`。
- `schema_version` = 最大迁移号，写入 `project.schema_version`。
- 打开更高版本项目：只读打开 + 提示「需要更新应用」；打开更低版本：先备份，再迁移，失败不写库。
- 迁移期间禁用自动更新写入，避免半迁移状态。

### 5.11 完整性校验 `db.verify()`

启动、备份前、导出前各跑一次（只读）：

1. `PRAGMA integrity_check` + `PRAGMA foreign_key_check`。
2. 孤儿检查：`beat.created_revision_id` 不存在、`revision_beat.beat_id` 不存在、`chapter.current_revision_id` 不存在。
3. 单调检查：同一章 `beat.seq` 随 `(scene_ord, beat_ord)` 不减；`project.seq_head >= max(seq)`。
4. 双活检查：同 `(scene_id, ord)` 存在 >1 条非 superseded 拍。
5. 镜像检查：`manuscript/*.md` 的 hash 与当前 revision 一致（不一致只告警，不自动改）。
6. 结果写 `logs/verify-<date>.json`；失败时 UI 显示「项目需要修复」并给出诊断包入口。

### 5.12 容量与性能估算

| 项 | 估算 | 结论 |
|---|---|---|
| 一章正文 | 3,500 字 ≈ 7KB UTF-8 | 30 章 ≈ 210KB |
| 一拍一行 | 24 拍/章 × 30 章 = 720 行 | 可忽略 |
| revision | 每拍一次 → 24 × 30 = 720 条 + 清单 17k 行 | 清单行 ~50B，共 <2MB |
| 记忆条目 | 5 角色 × 30 章 × 8 条 = 1,200 条 | 向量 1,200 × 512 × 4B ≈ 2.5MB |
| 工具调用 | 6 次/拍 × 720 拍 = 4,320 条 | 可忽略 |
| 检索 | 1,200 条暴力余弦 <5ms | sqlite-vec 不是性能必需，是一致性选择 |
| 打开项目 | 迁移 + verify + 最近章加载 | 小项目 <300ms；30 章目标见 §13.7 |

**结论**：这个产品的数据规模很小，性能风险不在数据库，在「流式渲染」与「上下文组装」。不要把工程预算花在存储优化上。

---

## 6 工具层

工具层是 PRD v0.6 的重心，也是本方案里最不能「先做个能跑的再说」的部分。原因很简单：**工具层一旦允许模型传身份，后面所有隔离、审计、回退都要重写**。

### 6.1 文件布局与生成物

```
src/main/tools/
├─ define.ts              # defineTool()：类型收窄 + 运行时断言
├─ manifests/             # 42 个 .ts，一类一文件，一个工具一个导出
│  ├─ structure.ts        # T01–T09
│  ├─ knowledge.ts        # T10–T23
│  ├─ verify.ts           # T24–T30
│  ├─ propose.ts          # T31–T41
│  └─ interaction.ts      # T42
├─ system.ts              # 8 个系统能力（agent_callable=false）
├─ registry.ts            # 唯一目录：加载、校验、版本索引
├─ resolve.ts             # 基线 ∩ 实例收窄 ∩ 项目策略
├─ invoke.ts              # 调用流水线（§6.4）
├─ gates.ts               # 令牌签发/校验/消费
├─ idempotency.ts         # canonical hash + 重放
├─ budget.ts              # 单轮/单工具计数
├─ audit.ts               # tool_call 落库
├─ errors.ts              # 错误码 + 模型可见文案（唯一文案源）
└─ generated/
   ├─ allowlist.ts        # 由 manifests 生成：agent → tool names
   └─ toolset-version.ts  # 清单内容 hash
```

| 生成物 | 来源 | 校验 |
|---|---|---|
| `docs/tools/<name>.json` | manifest → JSON Schema | `gen-check` 重新生成后 diff 必须为空 |
| `generated/allowlist.ts` | manifest 的 `actors` | 与 PRD §4.11 的 10/18/9/5/20/16 逐项比对 |
| `generated/toolset-version.ts` | 全部 manifest 的 `name@version` 排序后 sha256 | 写入 job、turn_metric，用于回放 |

### 6.2 Manifest schema（唯一契约）

```ts
// src/main/tools/define.ts
const Actor = z.enum(['planner','orchestrator','character','narrator','reviewer','memory']);

export const ToolManifest = z.object({
  name: z.string().regex(/^[a-z]+\.[a-z_]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  family: z.enum(['structure','knowledge','verify','propose','interaction']),
  summary: z.string().min(8).max(120),
  actors: z.array(Actor).min(1),
  sideEffect: z.enum(['none','propose','execute','commit']),
  agentCallable: z.boolean(),
  requiresGate: z.enum(['G1','G5','G6','G7','author_confirm']).nullable(),
  idempotency: z.enum(['natural','key_required']),
  injected: z.array(z.string()).default([]),
  input: z.custom<z.ZodObject<any>>(),
  output: z.custom<z.ZodObject<any>>(),
  limits: z.object({
    timeoutMs: z.number().int().positive(),
    maxResultTokens: z.number().int().positive(),
    maxCallsPerTurn: z.number().int().positive(),
  }),
  degrade: z.array(z.enum(['full','summary','facts_only','empty','fail'])).min(1),
  audit: z.object({ logArgs: z.enum(['full','hash','none']), logResultIds: z.boolean() }),
  handler: z.function(),
});
```

**构建期五条断言**（违反即构建失败，PRD §4.11 执行点 1）：

| # | 断言 | 理由 |
|---|---|---|
| A1 | `sideEffect === 'commit' → agentCallable === false` | commit 只属于文档控制器 |
| A2 | `injected` 与 `input.shape` 的键交集为空 | 身份参数不得由模型传（I3） |
| A3 | `input` / `output` 都是 `.strict()` | `additionalProperties:false` |
| A4 | `name` 全局唯一，`version` 合法 semver | 注册表唯一目录 |
| A5 | `actors` 非空且 ⊆ 六角色；`requiresGate !== null` 时 `sideEffect !== 'none'` | 无「有闸门的只读工具」 |

**字段命名**：TS 内部用 camelCase（`sideEffect` / `agentCallable`），生成 `docs/tools/*.json` 时按 PRD §4.9.2 的 snake_case（`side_effect` / `agent_callable` / `input_schema` …）输出；映射只在 codegen 一处做，避免两份真源。

**运行期剔除**：单个工具加载或初始化失败 → 标 `tool_unavailable`，从有效工具集移除，不影响其他工具；不静默替换实现（PRD §4.9.2）。

### 6.3 授权解析

```ts
export function resolveToolset(agentKey: AgentKey, policy: ProjectPolicy, snapshot: RegistrySnapshot): Toolset {
  const baseline = snapshot.baselineFor(agentKey);            // 生成物，唯一来源
  const enabled = baseline.filter(t => policy.enabled(t.name)); // P1：按项目禁用
  const tools = enabled.map(t => narrowForInstance(t, agentKey));
  return { version: snapshot.version, tools, agentKey, resolvedAt: snapshot.at };
}

function narrowForInstance(t: Tool, agentKey: AgentKey): Tool {
  if (!agentKey.startsWith('character:')) return t;
  const characterId = agentKey.slice('character:'.length);
  // 角色实例：裁掉「查别人」的参数，身份改由注入提供
  const input = t.instanceNarrowing === 'self_only'
    ? t.input.omit({ character_id: true })
    : t.input;
  return { ...t, input, injected: [...t.injected, 'character_id'], instanceId: characterId };
}
```

| 场景 | 基线 | 收窄 | 结果 |
|---|---|---|---|
| `character:char_lin` 调 `memory.retrieve_own` | 在基线 | `character_id` 注入，schema 无此字段 | 只能拿到 `char_lin` |
| `character:char_lin` 调 `relationship.get_edges` | 在基线 | schema 裁掉 `character_id` | 只能看与本人相关的边 |
| `reviewer` 调 `memory.retrieve_audit` | 在基线 | 保留 `character_id`（审计目标） | 可审计任意角色，但写不进正文 |
| `narrator` 调 `world.get_objective` | 不在基线 | — | 不下发，硬调返回 `tool_not_found` |
| 任意 Agent 调 `doc.commit_beat` | `agent_callable=false` | — | 不在 `tools` 列表 |

**快照语义**：`Toolset` 在 job 开始时解析并冻结（含 `version`），中途改设置只影响下一个 job。`turn_metric.binding_version` 与 `toolset_version` 一起写，回放时能还原「当时它手里有什么」。

### 6.4 调用流水线

```ts
export async function invokeTool(call: ToolCallIntent, ctx: TurnContext): Promise<ToolResult> {
  // 1. 从快照取工具：未授权 = 不存在
  const tool = ctx.toolset.get(call.tool);
  if (!tool) { await auditUnauthorized(call, ctx); return err('tool_not_found'); }

  // 2. 参数校验（strict，多余字段拒绝）
  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) return err('invalid_args', { fields: parsed.error.issues.map(i => i.path) });

  // 3. 身份注入：模型不可见、不可覆盖
  const runtime = buildRuntimeArgs(tool, ctx);   // project_id, actor_id, character_id, as_of, job_id, turn_id, epoch, expected_revision, gate_token?

  // 4. 幂等重放（propose/execute）
  if (tool.idempotency === 'key_required') {
    const key = idempotencyKey(ctx, tool, parsed.data);
    const hit = await idem.lookup(key);
    if (hit) return { ...hit.result, duplicate: true };
  }

  // 5. 单轮预算
  if (!ctx.budget.take(tool.name, tool.limits.maxCallsPerTurn)) return err('tool_budget_exceeded');

  // 6. 闸门（一次性令牌）
  if (tool.requiresGate) {
    const gate = await gates.check(tool.requiresGate, runtime.gate_token, runtime);
    if (!gate.ok) return err(gate.code);           // gate_required / stale_revision / gate_consumed
  }

  // 7. 执行 + 超时 + 降级
  const output = await withTimeout(tool.handler(parsed.data, runtime), tool.limits.timeoutMs)
    .catch(e => degrade(tool, e));

  // 8. 截断（不静默）
  const shaped = truncateToTokens(output, tool.limits.maxResultTokens);

  // 9. 审计 + 登记 refs
  await audit.success(tool, runtime, shaped, ctx);
  ctx.turnRefs.register(shaped.refs);

  return shaped;
}
```

**顺序不能换的三处**：

- 「授权 → 参数」必须在「身份注入」之前：未授权工具不进入参数解析，避免通过报错探测 schema。
- 「幂等」必须在「预算」之前：重放不该消耗额度，也不该被拒。
- 「闸门」必须在「执行」之前，且令牌**成功后才消费**：失败重试复用同一令牌（PRD §4.9.5）。

### 6.5 闸门令牌与幂等

**令牌格式**（`gates.ts`）：

```
payload = { g, et, eid, rev, job, exp, nonce }
token   = base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(secret, base64url(JSON(payload))))
```

| 规则 | 实现 |
|---|---|
| 密钥 | 每安装一个，`safeStorage` 加密存 `%APPDATA%/noryth/gate.key`；换机即失效（可接受） |
| TTL | 10 分钟；`exp` 由主进程时钟签发与校验，不信任渲染层 |
| 绑定 | `gate_id + entity_type + entity_id + revision + job_id` 五项全绑定 |
| 存储 | `gate_record.token_hash = sha256(token)`；不存明文 |
| 消费 | job **成功提交后** `consumed_at = now`；调用失败不消费 |
| 复用 | 已被消费的令牌再用 → `gate_consumed` |
| 实体不匹配 | → `stale_revision`（不区分「令牌错」与「稿件变了」，防探测） |

**幂等键**：

```ts
const key = sha256(canonicalJson({
  project_id, job_id, tool: tool.name, version: tool.version, args_hash: sha256(canonicalJson(args))
}));
```

- `canonicalJson` 递归排序键、拒绝 `undefined`、数字不转字符串。
- 命中重放返回首次结果 + `duplicate: true`，不重复写入。
- 只对 `propose` / `execute` 生效；只读工具 `natural`，不存结果。
- `tool_call.result_json` 只在有幂等键时写入（体积控制）。

### 6.6 grounding 子集校验（工程补充）

PRD v0.6 把 `grounding` 收紧为「本轮工具返回引用的子集」。落地需要一张**轮内引用登记表**：

```ts
class TurnRefRegistry {
  private byKey = new Map<string, { type: RefType; id: string; quote: string; seq?: number }>();
  register(refs: ToolRef[]) { for (const r of refs) this.byKey.set(`${r.type}:${r.id}`, r); }
  has(type: RefType, id: string) { return this.byKey.has(`${type}:${id}`); }
  quoteOf(type: RefType, id: string) { return this.byKey.get(`${type}:${id}`)?.quote; }
}
```

校验规则（`agents/validate.ts`）：

| # | 规则 | 失败处理 |
|---|---|---|
| V1 | `grounding.length ≤ 8` | 拒绝，重试 1 次 |
| V2 | 每项 `type` ∈ `memory/belief/fact/canon/outline/manuscript` | 拒绝 |
| V3 | `(type,id)` 必须在本轮 `turnRefs` 中 | 拒绝，错误码 `grounding_not_returned` |
| V4 | `quote` 归一化（NFKC + 去空白）后必须是 ref.quote 的子串 | 拒绝，错误码 `grounding_quote_mismatch` |
| V5 | 同一 `(type,id)` 不重复 | 去重，不算失败 |

- 失败重试一次，重试提示里只列**允许的 ref id 与 quote**（不列被过滤内容）。
- 二次失败 → 本拍不落盘，标 `rejected` + `invalid_grounding`，作者可手动重生成。**不静默删掉不合法的 grounding**——那会把「校验失败」伪装成「模型很守规矩」。
- 校验通过的 `grounding` 写 `beat.grounding_json`，并冗余 `turn_metric.context_json.refs`，供依据 chips 回放。

### 6.7 预算、超时、截断、降级

| 项 | 规则 |
|---|---|
| 单轮调用上限 | 旁白 4 / 角色 6 / 规划 8 / 编排 8 / 记忆 8 / 审批 12（PRD §4.9.4），项目可调，但只能调低不能调高（防误配烧钱） |
| 单工具上限 | manifest `maxCallsPerTurn`；`memory.retrieve_own` = 3 |
| 超时 | 检索 800ms、校验 2s、提案 5s；写工具超时不重试 |
| 超时返回 | 有部分结果 → `ok:true, degraded:'summary', truncated:true`；无 → `ok:false, code:'timeout'` |
| 截断 | 按条目整条丢弃（不切 quote 中间），`truncated=true, total=原始条数` |
| 空结果 | `ok:true, refs:[], degraded:'empty'`；与失败严格区分 |
| 降级阶梯 | `full → summary → facts_only → empty`，每一级都必须标 `degraded` |
| 只读重试 | 超时/429 可重试 1 次（同参数、同幂等语义） |
| 写工具重试 | 不自动重试，交作者重发；靠幂等防重复 |

### 6.8 契约测试（每个工具六类 + 注册表三类）

```ts
// tests/contract/harness.ts
export function contractSuite(manifest: ToolManifest, fixtures: ToolFixtures) {
  describe(manifest.name, () => {
    it('schema round-trip', ...);        // 合法样例通过，缺字段/多余字段拒绝
    it('identity isolation', ...);       // 换 actor 拿不到；A 的 job 查不到 B 的 mem_*
    it('empty is not error', ...);       // ok:true, degraded:'empty'
    it('truncation is explicit', ...);   // truncated:true + total
    it('timeout degrades', ...);         // 注入慢 handler
    it('idempotent replay', ...);        // 同 key 两次 → 一条记录 + duplicate:true
  });
}
```

| 注册表测试 | 断言 |
|---|---|
| 未授权不下发 | 每个 agent 的 `tools` 快照与 `generated/allowlist.ts` 完全一致；M0 快照 narrator 5 / reviewer 17，全集（M2）narrator 5 / reviewer 20 |
| 版本不漂移 | job 运行中修改 manifest → 该 job 仍用 `toolset_version` 快照 |
| 清单一致 | `docs/tools/*.json` 与源码重新生成后 0 diff |

**覆盖率硬门**：`resolve.ts`、`invoke.ts`、`gates.ts`、`idempotency.ts`、`context/budget.ts`、`scheduler/transition.ts` 六个文件行覆盖 100%，分支 ≥95%。这些文件出 bug 的代价是数据错乱，不是 UI 难看。

### 6.9 42 个工具的 M0 实现映射

| # | 工具 | 后端模块 | M0 | 实现要点 |
|---|---|---|---|---|
| T01 | `project.get_meta` | `repos/project` | ✅ | 不含 Key、费用明细 |
| T02 | `outline.get_subtree` | `repos/outline` | ✅ | 只返回草案与已批准版本 |
| T03 | `outline.get_chapter_brief` | `services/brief` | ✅ | 脱敏：只给一句话目标 |
| T04 | `character.get_own_card` | `repos/character` | ✅ | 无参数；`character_id` 注入 |
| T05 | `character.get_public_profile` | `services/projection` | ✅ | 剔除欲望/恐惧/禁忌/私有记忆 |
| T06 | `character.get_card_full` | `repos/character` | ✅ | 审批引用最小必要证据 |
| T07 | `storyboard.get_chapter` | `repos/storyboard` | ✅ | 只读当前版本 |
| T08 | `storyboard.get_beat` | `repos/storyboard` | ✅ | 只给本拍，不给后续拍 |
| T09 | `scene.get` | `repos/storyboard` | ✅ | 在场者超阈值返回告警字段 |
| T10 | `memory.retrieve_own` | `memory/retrieval` | ✅ | 身份注入；空 ≠ 失败 |
| T11 | `memory.retrieve_audit` | `memory/retrieval` | ✅ | 返回最小证据；报告不整段复制 |
| T12 | `canon.search_public` | `memory/canon` | ✅ | 不含私有记忆 ID、未揭示事实 |
| T13 | `world.get_limited` | `world/projection` | ✅ | `known_by` 含本人或公开 |
| T14 | `world.get_reader_known` | `world/projection` | ✅ | `reveal_seq ≤ as_of` |
| T15 | `world.get_objective` | `world/projection` | ✅ | 含秘密，只给编排/审批/记忆 |
| T16 | `belief.get_own` | `world/belief` | ✅ | 可错、可矛盾，不升格为事实 |
| T17 | `belief.get_for_character` | `world/belief` | ✅ | 排戏与泄漏判定用 |
| T18 | `relationship.get_edges` | `world/relations` | ✅ | 角色只看与本人相关（注入） |
| T19 | `manuscript.search_final` | `manuscript/search` | ✅ | 只搜 `kind=final` |
| T20 | `manuscript.get_final_chapter` | `manuscript` | ✅ | 无定稿返回空，不回退草稿 |
| T21 | `draft.get_chapter` | `manuscript` | ✅ | 只读；revision 必须属于当前章 |
| T22 | `foreshadow.list_open` | — | P1 | 先定契约，M0 不注册实现 |
| T23 | `timeline.query` | `world/timeline` | M1 | 三轴分开返回 |
| T24 | `consistency.check` | `validator/deterministic` | ✅ | 只报可判定项；语义标 candidate |
| T25 | `voice.metrics` | — | M2 | 阈值需中文语料重标 |
| T26 | `coverage.check` | — | P1 | 建议项，不阻断 G1 |
| T27 | `storyboard.validate` | `storyboard/validator` | ✅ | 硬冲突拒绝提交，软冲突告警 |
| T28 | `exit_dsl.validate` | `scheduler/dsl` | ✅ | 只接受 DSL AST |
| T29 | `impact.analyze` | — | P1 | 蓝图变更前必须跑 |
| T30 | `report.get_latest` | `repos/review` | ✅ | 只给摘要，全文不进上下文 |
| T31 | `blueprint.propose_patch` | `proposal/blueprint` | ✅ | 只写草案；G1 后走变更流程 |
| T32 | `character.propose_card` | `proposal/character` | ✅ | 不换 ID；改版列受影响章节 |
| T33 | `roster.propose` | `proposal/roster` | ✅ | 规划不建库 |
| T34 | `storyboard.propose` | `proposal/storyboard` | ✅ | 提交前跑 T27 |
| T35 | `report.submit` | `review/report` | ✅ | schema 失败降级纯文本 |
| T36 | `patch.propose` | `review/patch` | ✅ | 需 G5；只改草稿区已有拍 |
| T37 | `memory.proposal.submit` | `memory/proposal` | ✅ | 只从定稿抽取 |
| T38 | `memory.namespace.create` | `memory/namespace` | ✅ | G1 长期授权；自检隔离 |
| T39 | `memory.apply` | `memory/executor` | ✅ | 需 G7 + 幂等键 |
| T40 | `memory.rebuild` | `memory/rebuild` | M1 | `author_confirm` 令牌 |
| T41 | `refusal.raise` | `agents/character` | ✅ | 合法输出；理由不得越界 |
| T42 | `author.request_choice` | `agents/planner` | ✅ | 自动模式/批处理中拒绝 |

**M0 注册 36 个，6 个按里程碑开关。** 每个 Agent 在 M0 的有效工具数（`generated/allowlist.ts` 的断言值）：

| Agent | PRD 全集 | M0 有效 | 差额 |
|---|---:|---:|---|
| 规划 | 10 | 8 | T26、T29（P1） |
| 编排 | 18 | 16 | T22（P1）、T23（M1） |
| 角色 | 9 | 9 | — |
| 旁白 | 5 | 5 | — |
| 审批 | 20 | 17 | T22、T23、T25 |
| 记忆 | 16 | 13 | T22、T23、T40 |

### 6.10 工具层的四条工程红线

1. **不写 SQL、不读文件、不发网络**：工具只能调 `repos` 与 `services`；`eslint` 禁止 `tools/**` import `better-sqlite3` / `node:fs` / `fetch`。
2. **不在工具里调 LLM**：一次调用一次确定性行为；判断交给 Agent，计费归模型层（PRD §4.9.8）。
3. **不跨身份缓存**：缓存键必须含 `project_id + actor_id + character_id + as_of`；M0 只对 `canon.search_public` 与 `outline.get_subtree` 开缓存，其余不缓存，避免隔离在缓存层破一次。
4. **不返回存储细节**：不返回表名、文件路径、向量维度、embedding 版本；这些只在项目元数据与设置页给作者看。

---

## 7 Agent 运行时

### 7.1 单拍流水线

```
runTurn(job, beatSpec)
 1. 冻结绑定与工具集（binding snapshot + toolset snapshot）
 2. 装配上下文（纯函数，产出 ContextBundle）
 3. 渲染提示词（稳定前缀 + 动态块）
 4. 调模型（流式；解析工具调用增量）
 5. 组装信封（body / trace / grounding / meta）
 6. 结构校验（schema、speaker、字数）
 7. grounding 子集校验（§6.6）
 8. DocController.commitBeat（§9.1）
 9. 写 turn_metric + 发事件
10. 返回 TurnResult（含 nextBeat / 收束判定所需的 facts）
```

失败在 4–7 任一步：**不落正文**，job 标 `failed` 或 `interrupted`，已确认拍不受影响。

### 7.2 信封 schema 与校验

```ts
export const Envelope = z.object({
  turn_id: z.string(),
  speaker: z.object({
    type: z.enum(['character','narrator']),
    id: z.string(),
  }),
  trace: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('thought'), text: z.string().max(2000) }),
    z.object({
      type: z.literal('tool_call'), call_id: z.string(), tool: z.string(),
      args: z.record(z.unknown()).default({}),
      runtime_args: z.record(z.unknown()).default({}),
      result_ids: z.array(z.string()).default([]),
      degraded: z.string().optional(), latency_ms: z.number().optional(),
    }),
  ])).max(40).default([]),
  body: z.string().min(1),
  grounding: z.array(z.object({
    type: z.enum(['memory','belief','fact','canon','outline','manuscript']),
    id: z.string(), quote: z.string(),
  })).max(8).default([]),
  meta: z.object({
    model: z.string(), degraded: z.boolean(),
    tokens_in: z.number().nullable(), tokens_out: z.number().nullable(),
  }),
}).strict();
```

| 校验 | 规则 | 不是这一层能做的 |
|---|---|---|
| `speaker.id === beat.speaker_id` | 强制 | 「body 里替别人说话」是语义问题，交审批 |
| `body` 字数 ≤ `max_words × 1.3` | 强制（中文按字符数） | 文笔好坏 |
| `grounding` ⊆ 本轮 refs | 强制（§6.6） | 语义越界 |
| `trace` 不落正文 | `commitBeat` 只取 `body` | — |
| `meta.degraded` | 三源任一为真则必须为真（检索空/裁剪/降级） | 模型是否诚实 |

**`trace` 的存储**：不写 `beat` 表；写 `logs/trace/<jobId>/<turnId>.json`（可关闭），`beat.trace_ref` 存相对路径。这样正文表保持小，轨迹可单独归档/清理。

### 7.3 上下文装配（L0–L3）

```ts
type Layer = 'L0' | 'L1' | 'L2' | 'L3';
type CtxBlock = {
  id: string; layer: Layer;
  stable: boolean;         // 稳定前缀：参与前缀缓存
  priority: number;        // 裁剪顺序：越小越先裁
  tokens: number;
  text: string;
};
type ContextBundle = { blocks: CtxBlock[]; totalTokens: number; trimmed: string[] };
```

**预算算法**（纯函数，输入相同则输出相同）：

```
contextWindow = 绑定模型的能力探测值（未知则按 32k）
hardCap       = min(contextWindow * 0.5, 12000)
reserveOut    = ceil(maxWords * 1.4) + 400
budget        = hardCap - reserveOut

固定分配（先到先得，不可被后续挤占）：
  L0 章级      ≤ 900
  L1 场景级    ≤ 600
  角色卡核心   ≤ 700   （身份 / voice / 欲望 / 恐惧 / 禁忌，永不裁剪）
  本拍意图     ≤ 160   （永不裁剪）
  L3 旁观者    ≤ 150 × min(在场非发言者, 8)

剩余给 L2 动态：
  1. pinned 记忆块（最多 5 条，独立成段，不参与相关性排序）
  2. 检索 refs（top_k，按融合分排序）
  3. 最近 N 拍正文（从新到旧，默认 6 拍）

裁剪顺序（超预算时循环执行，直到不超）：
  a. 最近拍 N-1（保留至少 2 拍）
  b. top_k -1（最低 2）
  c. L3 丢弃张力最低的旁观者（保留发言者与场景目标相关者）
  d. pinned 5 → 3 → 1
  e. 记忆降级 full → summary → facts_only
  f. 仍超 → 抛 context_overflow（视为配置错误，不静默截角色卡）
```

| 层 | 内容 | 谁可见 | 备注 |
|---|---|---|---|
| L0 | 章纲、本章核心事件、目标、禁揭清单 | 编排/审批全文；角色/旁白只拿脱敏一句话目标 | 禁揭清单永不进角色/旁白 |
| L1 | 地点、在场者、场景目标、入口/出口、上一场结果 | 四类工作 Agent | 场景内稳定 |
| L2 | 角色卡、限知世界、私有记忆、最近拍、本拍意图 | 仅发言者 | 最大块 |
| L3 | 80–150 token 状态卡 | 在场非发言者 | 离场角色完全移出 |

**确定性要求**：`blocks` 按 `(layer, priority, id)` 排序；检索结果按 `(score desc, id asc)`；不使用 `Object.keys` 顺序或 `Set` 迭代顺序。测试用同一 fixture 跑两次，`totalTokens` 与块顺序必须一致。

### 7.4 Token 估算与校准

```ts
export function estimateTokens(text: string): number {
  let cjk = 0, latin = 0, punct = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) cjk++;
    else if (/[A-Za-z0-9]/.test(ch)) latin++;
    else punct++;
  }
  return Math.ceil(cjk * 1.05 + latin / 3.6 + punct * 0.6);
}
```

- 每个 provider 维护 `calibration`：最近 20 次真实 `usage.prompt_tokens` / 估算值的中位数，clamp `[0.7, 1.6]`；写 `settings.json`。
- 估算只用于**预算与裁剪**，不用于计费；计费以供应商返回的 `usage` 为准。
- 上下文检查器显示「估算 token + 上次实际 ratio」，不显示假精确值。

### 7.5 模型适配器

```ts
export interface ChatAdapter {
  probe(cfg: ProviderConfig): Promise<Capabilities>;
  stream(req: ChatRequest, hooks: StreamHooks): Promise<ChatResult>;
}
export type Capabilities = {
  stream: boolean; tools: boolean; jsonMode: boolean;
  contextWindow: number; maxOutput: number; pricing: { in: number; out: number };
};
```

| 错误归一化 | 触发 | 重试 | 呈现 |
|---|---|---|---|
| `auth` | 401/403 | 否 | 「Key 无效或过期」+ 去设置 |
| `rate_limit` | 429 | 2 次（500ms/1500ms + jitter） | 「供应商限流，已重试」 |
| `timeout` | 连接/首 token 超时 | 2 次 | 拍卡可重试 |
| `context_overflow` | 400 + 特定文案 | 否 | 触发裁剪后重试一次（仅一次） |
| `server` | 5xx | 2 次 | 暂停当前拍 |
| `protocol` | SSE 解析失败/工具增量不合法 | 1 次 | `tool_protocol_error` |
| `content_filter` | 供应商拒答 | 否 | 转人工，不自动改写 |

**不静默降级到弱模型**（PRD §9.3）：供应商失败只提示切预设或暂停；绑定变化只由作者在设置里做。

### 7.6 工具调用能力与 JSON 回退

| 模型能力 | 路径 | 约束 |
|---|---|---|
| 原生 tool calling | 标准 `tools` + 增量拼装 `tool_calls` | 支持并行只读调用；提案类串行 |
| 无 tool calling，有 JSON mode | 适配器注入「单轮 JSON 协议」：`{"tool_calls":[...],"final":{...}}` | 一次只允许一轮工具；不支持并行 |
| 两者都无 | 不允许绑定为需要工具的角色；设置页禁用该模型 | 防止「裸答」绕过取材 |

JSON 回退协议：

```
你必须只输出一个 JSON 对象，形如：
{"tool_calls":[{"tool":"<name>","args":{...}}],"final":null}
或
{"tool_calls":[],"final":{<信封>}}
不得输出 JSON 以外的任何字符。
```

解析失败 → 带错误信息重问一次；连续 2 次 → `tool_protocol_error`，本次任务暂停（PRD §4.9.2），**不静默裸答**。

### 7.7 绑定快照与路由

| 规则 | 实现 |
|---|---|
| 解析顺序 | `character:<id>` → `character` → `project.default_preset`；其他 agent 直接 `project.default_preset` |
| 快照时机 | job 创建时解析一次，写 `job.payload_json.bindings`；job 内所有拍复用 |
| 生效边界 | 改绑定只影响下一个 job；正在跑的 job 不换模型（PRD §5.6） |
| 审计 | `model_binding_audit` 记录旧/新、时间、操作者；设置页可回滚上一套 |
| 默认路由 | 角色/旁白强模型；规划/编排强推理；审批尽量与生成不同供应商；记忆用便宜模型 + schema 校验 |
| 异构复检 | M1；M0 至少允许审批单独绑另一家（PRD M0 退出标准要求「一个 Agent 绑第二家仍能完成一章」） |

### 7.8 流式、取消与事件

- SSE 解析按行缓冲，`data: [DONE]` 结束；工具调用增量按 `index` 拼装 `id/name/arguments`。
- 渲染层以 32ms 批量刷新；只更新当前拍，不重排已确认段落（UI-DESIGN §5.4）。
- 取消：`AbortController.abort()` → 适配器停止读流 → job 标 `cancelled`；迟到 chunk 丢弃。
- 事件序列：`beat.start` → `beat.delta*` → `beat.validated` → `beat.committed` → `beat.failed`。
- 每个事件带 `{jobId, turnId, seq}`；renderer 用 `seq` 丢弃乱序。

### 7.9 提示词结构（稳定前缀）

```
[SYSTEM]        角色/任务/输出契约/禁则（稳定，无时间戳、无 job id）
[TOOLS]         由 API 下发，不进 system 文本
[L0 章级]       稳定（章内不变）
[L1 场景]       稳定（场景内不变）
[L2 发言者]     角色卡 → pinned → refs → 最近拍 → 意图
[L3 旁观者]     每角色一段
```

- 稳定前缀用于供应商前缀缓存；`turn_metric.context_json.prefixHash` 记录前缀 hash，命中率可统计。
- 工具结果只作为带分隔符的材料注入，不拼进 system（防注入，PRD §4.9.4）。
- 提示词里**不写**「不要查别人的记忆」这类规则——隔离在接口层，提示词不承担权限。

### 7.10 失败与退化（运行时视角）

| 场景 | 行为 | 标记 |
|---|---|---|
| 检索为空 | 只用卡与场景，正文照常生成 | `memory_empty`，`meta.degraded=true` |
| 上下文裁剪 | 按 §7.3 顺序裁，正文照常 | `context_trimmed` + 裁剪明细 |
| 模型降级（能力探测缺失） | 不支持工具的模型走 JSON 回退 | `tool_protocol='json_fallback'` |
| 工具超预算 | 以现有材料收束本拍 | `tool_budget_exceeded` |
| 必需工具不可用 | 暂停当前任务（初稿/角色卡/限知/本拍指令） | `tool_unavailable` |
| 校验失败 2 次 | 本拍 `rejected`，不落盘 | `invalid_grounding` / `schema_invalid` |

---

## 8 调度器、状态机与出口 DSL

### 8.1 状态机（代码即表）

```ts
// src/main/scheduler/transitions.ts
export const BEAT_TRANSITIONS = {
  proposed:            { GENERATE: 'generating' },
  generating:          { DELTA: 'generating', COMPLETE: 'draft', FAIL: 'interrupted', CANCEL: 'interrupted' },
  draft:               { WAIT: 'waiting_for_human', AUTO_ACCEPT: 'confirmed', REJECT: 'rejected' },
  waiting_for_human:   { CONFIRM: 'confirmed', REGENERATE: 'regenerating', EDIT: 'author_edited' },
  regenerating:        { COMPLETE: 'superseded', FAIL: 'waiting_for_human' },  // COMPLETE：同事务插入新拍 draft
  author_edited:       { UPSTREAM_CHANGED: 'stale' },
  confirmed:           { UPSTREAM_CHANGED: 'stale', REPLACE: 'superseded' },
  stale:               { RERUN: 'regenerating', IGNORE: 'confirmed' },
  interrupted:         { RETRY: 'generating', DISCARD: 'rejected' },
  rejected:            { RETRY: 'generating' },
  superseded:          {},
} as const;
```

| 状态 | 进入条件 | 可迁移 | 副作用 |
|---|---|---|---|
| `proposed` | 分镜确认 | `generating` | — |
| `generating` | 调度器发牌 | `draft` / `interrupted` | 写 job 心跳 |
| `draft` | 正文落草稿 | `waiting_for_human` / `confirmed`(auto) / `rejected` | `turn_metric` |
| `waiting_for_human` | 逐拍模式 | `confirmed` / `regenerating` / `author_edited` | 通知 |
| `confirmed` | 作者确认或自动接受 | `stale` / `superseded` | 计入 `covered_until_seq` |
| `author_edited` | 作者改正文 | `stale` | 下游标脏 |
| `stale` | 上游改动 | `regenerating` / `confirmed` | UI 三选一 |
| `rejected` | 校验失败/作者拒绝/自动中止 | `generating` | 保留 trace |

章 / 场景 / 任务的状态迁移沿用 PRD §6.5，不在此重复；代码中以 `CHAPTER_TRANSITIONS` / `SCENE_TRANSITIONS` / `JOB_TRANSITIONS` 同构实现，测试逐条覆盖。

**重生成的补偿事务**：旧拍进入 `regenerating` 并保持唯一活行，新文本先在内存里校验；成功 → 同一事务里旧拍标 `superseded`、插入新拍 `draft`；失败 → 旧拍回 `waiting_for_human`，不产生新行。这样既不破 `beat_ord_live` 唯一索引，也不会出现「两拍都不活」。

### 8.2 调度循环

```ts
export async function runChapter(job: Job, chapter: Chapter) {
  while (job.status === 'running') {
    const beat = nextActionableBeat(chapter);        // 按 chapter_scene.ord, beat.ord
    if (!beat) {
      if (!exitSatisfied(currentScene)) return finish(job, 'storyboard_exhausted');
      return closeScene(currentScene);
    }
    if (autoMode && sceneBeatCount >= scene.maxBeats) return closeScene(currentScene, 'WARN');
    if (budget.exceeded(job)) return pause(job, 'budget_exceeded');

    const result = await runTurn(job, beat);
    if (result.kind === 'refusal') return pause(job, 'character_refusal');
    if (result.kind === 'failed')  return pause(job, result.code);

    if (mode === 'beat') return waitForHuman(job, beat);   // 退出循环，等 IPC
    // auto: 继续下一拍
  }
}
```

| 停止条件 | 触发 | 后续 |
|---|---|---|
| 出口满足 | `exitSatisfied` 为真 | `closing → closed` |
| `max_beats` | 场景拍数达上限 | `closed + WARN` |
| 预算 | token/费用超章预算 | `paused`，预算横幅 |
| 角色拒演 | T41 | `paused`，拒演卡 |
| 分镜耗尽 | 无可用拍且出口未满足 | `paused` + `storyboard_exhausted` |
| 模型错误 | 重试 2 次仍失败 | `paused` + `model_error` |
| 作者暂停 | IPC | `paused`，保留当前拍 |
| 闸门 | 需要 G4/G6 | 退出循环 |

### 8.3 暂停、恢复、取消

| 动作 | 语义 | 数据 |
|---|---|---|
| 暂停 | 当前拍完成或中断后停；不丢弃已生成 | `job.status='paused'`，`beat` 保持 `draft`/`interrupted` |
| 恢复 | 从 `paused` 续跑；先重算预算与出口 | 新 `epoch` 检查；`expected_revision` 不变则续 |
| 取消 | 停止读流；迟到结果丢弃 | `job.status='cancelled'`；`epoch` 不变，靠 `expected_revision` 拒绝 |
| 崩溃 | 启动扫描 `running` → `interrupted` | `beat.generating` → `interrupted` |

### 8.4 出口 DSL

```ts
export type Cmp = '>=' | '>' | '<=' | '<' | '==' | '!=';
export type ExitExpr =
  | { op: 'fact'; subject: string; predicate: string; object?: string }
  | { op: 'rel'; from: string; to: string; axis: 'trust'|'intimacy'|'tension'; cmp: Cmp; value: number }
  | { op: 'beats'; cmp: Cmp; value: number }
  | { op: 'all'; of: ExitExpr[] }
  | { op: 'any'; of: ExitExpr[] }
  | { op: 'not'; of: ExitExpr };
```

**校验规则**（`exit_dsl.validate`）：

| # | 规则 | 失败 |
|---|---|---|
| D1 | 深度 ≤ 5，节点 ≤ 20 | `invalid_dsl` |
| D2 | `all/any` 子节点 ≥ 2；`not` 恰好 1 个 | `invalid_dsl` |
| D3 | `fact.subject` 必须在实体登记表（角色/地点/道具/概念） | `machine_decidable:false` |
| D4 | `fact.predicate` 必须在谓词登记表（含 `single_value` 与值域） | `machine_decidable:false` |
| D5 | `fact.object` 省略 = 「存在某个值」；给出则必须是非空字符串 | `invalid_dsl` |
| D6 | `rel.from/to` 必须在场者内；`value ∈ [-1,1]` | `invalid_dsl` |
| D7 | `beats.value` ∈ [1, max_beats] | `invalid_dsl` |
| D8 | 至少一个 `fact`/`rel` 叶；纯 `beats` 标记 `beats_only` | 告警，不拒绝 |

**求值**：只查 `world_fact`（`as_of = 当前 seq`）、`relationship_edge`（有效边）、场景拍数。纯函数、无模型、无自然语言。

**自然语言出口**：直接拒绝（`machine_decidable:false`），不允许「模型自评是否收束」——这是 PRD §6.2 与风险表「无法收束」的唯一致命点。

### 8.5 自动模式预检

| 步骤 | 内容 |
|---|---|
| 1 | 计算剩余拍数 N、预估每拍 token（最近 5 拍中位数，缺省 900） |
| 2 | 按当前绑定计价估算区间 `[N × 0.7, N × 1.3]` |
| 3 | 显示：将连续生成 N 拍、预估费用、`max_beats`、章预算余额 |
| 4 | 作者确认后才开跑；确认写 `gate_record`（G2 的子记录，不新增闸门） |
| 5 | 运行中每拍检查预算；超预算立即暂停，不静默续跑 |

### 8.6 收束与耗尽

- 出口满足 → `closing`：调度器停止发牌，生成收尾（若分镜有收尾拍则执行，否则直接关）。
- 出口未满足但 `max_beats` 到 → `closed + WARN(exit_conditions_unsatisfied)`，写入 `job.result_json`，UI 显示「未按出口收束」。
- 分镜耗尽且出口未满足 → **不即兴续写**，标 `storyboard_exhausted`，给作者「补分镜」入口。
- 连续多拍无旁白 → 只提示「建议插入旁白」，不改分镜（PRD §6.2）。

### 8.7 崩溃恢复

1. 启动读 `project.write_epoch`，扫描 `job`：`running` → `interrupted`；`queued` 保留。
2. 扫描 `beat.status='generating'` → `interrupted`，保留已收到的部分正文（若有）为 `draft` 不可确认，标 `partial`。
3. 扫描 `outbox.published_at IS NULL` → 重试发布（幂等：hash 相同则跳过）。
4. 校验 `revision_beat` 清单完整性；缺失则从当前 revision 重建（只读修复，写日志）。
5. 清理过期闸门令牌（`expires_at < now` 未消费 → 标 `expired`）。

### 8.8 并发规则

| 操作 | 并发 | 机制 |
|---|---|---|
| 同项目写 | 串行 | 写队列 concurrency=1 + `BEGIN IMMEDIATE` |
| 跨项目写 | 并行 | 不同 DB 文件，互不阻塞 |
| 只读工具 | 单轮内并行 | `Promise.all`，各自超时 |
| 提案工具 | 串行 | 同轮内按顺序 |
| 世界状态写 | 串行 | 只有 `memory.apply` 写，且按章排队 |
| 导出 | 与写并行（读快照） | 用 `VACUUM INTO` 快照或只读事务 |

---

## 9 文档控制器、修订与定稿

### 9.1 `commitBeat` 事务

```ts
export function commitBeat(input: CommitBeatInput): CommitResult {
  return db.tx(() => {
    const project = repo.project.get();
    if (project.write_epoch !== input.epoch) throw new StaleRevision('epoch');
    const chapter = repo.chapter.get(input.chapterId);
    if (chapter.current_revision_id !== input.expectedRevision) throw new StaleRevision('revision');

    const seq = repo.project.allocateSeq();                 // §5.3
    const beat = repo.beat.insert({ ...input, seq, status: 'draft' });

    if (input.supersedesId) repo.beat.markSuperseded(input.supersedesId);

    const parent = chapter.current_revision_id;
    // 先在内存里算出新清单与 hash，再一次性写入：revision 保持只 INSERT
    const manifest = repo.revisionBeat.buildNext(parent, beat);   // [{sceneOrd, beatOrd, beatId}]
    const hash = hashManifestRows(manifest);
    const revision = repo.revision.insert({
      chapterId: chapter.id, parentRevisionId: parent, kind: 'draft',
      createdBy: 'doc_controller', contentHash: hash,
    });
    repo.revisionBeat.insertMany(revision.id, manifest);
    repo.chapter.setCurrentRevision(chapter.id, revision.id, seq);
    repo.outbox.enqueue({ kind: 'manuscript_md', chapterId: chapter.id, expectedHash: hash });
    return { revisionId: revision.id, beatId: beat.id, seq, hash };
  });
}
```

| 不变量 | 检查点 |
|---|---|
| 只有这里写 `beat.body` | `eslint` + 自审；`beat` 表无其他 UPDATE 路径 |
| revision 不可变 | `revision` 只 INSERT，无 UPDATE/DELETE；`content_hash` 在插入前算好 |
| 清单完整 | 每次提交后 `revision_beat` 行数 = 场景数 × 拍数，缺一行即回滚 |
| hash 可复算 | `hashManifest(revisionId)` 与 `revision.content_hash` 必须一致 |

### 9.2 `expected_revision` 与 `epoch`

| 概念 | 含义 | 何时变 |
|---|---|---|
| `expected_revision` | 客户端发起写入时看到的 revision | 每次落盘后变；旧请求被拒 `stale_revision` |
| `write_epoch` | 项目写纪元 | 回退、重新打开定稿、导入外部版本时 +1 |
| `job.epoch` | 任务开始时的 epoch | 任务内不变；不匹配即丢弃 |

三者任一不匹配 → 丢弃并返回 `stale_revision`，**不尝试合并**。合并语义太贵，M0 不做。

### 9.3 patch 应用

```ts
export function applyPatches(proposalId: string, decisions: Decision[]) {
  return db.tx(() => {
    const patches = repo.patch.list(proposalId);
    const chapter = repo.chapter.get();
    const base = chapter.current_revision_id;
    if (patches.some(p => p.revision_id !== base)) throw new StaleRevision('patch_base');

    for (const d of decisions.filter(d => d.accept)) {
      const p = patches.find(x => x.id === d.patchId)!;
      const beat = repo.beat.get(p.beat_id);
      if (!sameText(beat.body, p.before)) throw new PatchConflict(p.id);  // 不强行套用
      repo.beat.updateBody(p.beat_id, p.after, { authorEdited: false });
      repo.patch.markApplied(p.id);
    }
    // 以 base 清单为底，替换被接受的拍，再一次性写入新 revision（hash 同 §9.1）
    const acceptedBeatIds = decisions
      .filter(d => d.accept)
      .map(d => patches.find(x => x.id === d.patchId)!.beat_id);
    const manifest = repo.revisionBeat.buildNext(base, acceptedBeatIds);
    const revision = repo.revision.insert({
      chapterId: chapter.id, parentRevisionId: base, kind: 'draft',
      createdBy: 'reviewer', contentHash: hashManifestRows(manifest),
    });
    repo.revisionBeat.insertMany(revision.id, manifest);
    return { revisionId: revision.id };
  });
}
```

| 规则 | 内容 |
|---|---|
| 只改草稿区已有拍 | 不接受新增拍、不接受改 scene/outline（PRD §5.3） |
| `before` 必须匹配 | 归一化（去行尾空白、统一全半角标点）后不完全一致 → `patch_conflict`，不套用 |
| 逐条接受 | 一次事务内只应用 accepted 的 patch；rejected 保留记录 |
| 复检范围 | 按 `issue_ref.type` 映射维度（§9.7），只跑受影响维度 |
| 不无限重提 | 同 `issue_ref` 再提案必须带新 `reason`，否则报告里标「上轮已拒绝」 |

### 9.4 直接编辑与 stale 传播

- 编辑以拍为单位；保存后 `beat.author_edited=1`、`status='author_edited'`。
- 同章内：所有 `confirmed` 且 `(scene_ord, beat_ord)` 大于当前拍的拍 → `stale`。
- 跨章：M0 **不自动标脏**，UI 提示「后续章节未标脏，M1 提供影响分析」；这是已知限制，写进验收说明，不假装支持。
- 三选一（UI-DESIGN §5.4）：仅替换 / 替换并重跑后续 / 开新分支（默认）。
- M0 的「分支」= 新的 draft revision 链，旧 revision 可读；不做分支树 UI。

### 9.5 定稿 `finalize`

```ts
export function finalize(chapterId: string, revisionId: string, ack: Ack) {
  return db.tx(() => {
    const chapter = repo.chapter.get(chapterId);
    if (chapter.status === 'finalized') throw new InvalidState('already_finalized');
    if (hasBlockingUnacked(chapter, ack)) throw new GateRequired('G6');
    const hash = hashManifest(revisionId);
    const final = repo.revision.insert({
      chapterId, parentRevisionId: revisionId, kind: 'final',
      createdBy: 'author', contentHash: hash,
    });
    repo.revisionBeat.copyManifest(revisionId, final.id);
    repo.chapter.finalize(chapterId, final.id, maxSeqOf(final.id));
    repo.gateRecord.write({ gateId: 'G6', entityType: 'chapter', entityId: chapterId, decision: 'approve', actor: 'author' });
    const job = repo.job.enqueue({ type: 'memory.extract', payload: { chapterId, revisionId: final.id } });
    return { finalRevisionId: final.id, memoryJobId: job.id };
  });
}
```

| 守卫 | 规则 |
|---|---|
| 阻断项 | 有未确认阻断 → 拒绝；作者勾选「我已复核」可越过，但写 `ack` 与理由 |
| 未复检改动 | 列出清单，要求勾选 |
| 幂等 | 已最终化 → 返回现有 final revision，不重复建 |
| 定稿后 | `beat` 不可改；patch 不能以 final 为 base；重建记忆走 rebuild |

### 9.6 重新打开定稿章

`finalized → revising`：新建 draft revision，`parent = final`；`final_revision_id` 保留为历史；再次定稿生成新的 final，`final_revision_id` 指向新 final。旧 final 永久可读，用于对比与回退。

### 9.7 维度映射（复检范围）

| issue 类型 | 复检维度 |
|---|---|
| `knowledge_leak`、`unauthorized_speech` | 人物一致性 + 剧情逻辑 |
| `outline_conflict`、`missing_event` | 纲要对齐 |
| `timeline`、`continuity`、`reference_missing` | 剧情逻辑 |
| `voice`、`prose` | 文笔 |
| 其他/未分类 | 全维度（保守） |

### 9.8 文档控制器的四条不变量

1. 没有第二个函数写 `beat.body`（含 patch、编辑、重生成）。
2. 没有 `revision` 的 UPDATE/DELETE；hash 在插入前计算。
3. 每次写都产生 `outbox` 行；漏写由 `db.verify()` 发现。
4. 定稿只能由 `finalize` 产生，且必须带 G6 记录。

---

## 10 记忆与检索

### 10.1 抽取输入与输出

**输入**（只读定稿）：

```ts
type ExtractionInput = {
  chapter: { id: string; title: string; coveredUntilSeq: number };
  beats: Array<{ id: string; seq: number; speakerType: 'character'|'narrator'; speakerId: string; body: string }>;
  characters: Array<{ id: string; name: string; card: CharacterCard }>;
  facts: Array<{ id: string; subject: string; predicate: string; object: string; validToSeq: number | null }>;
  beliefs: Array<{ id: string; characterId: string; text: string }>;
  edges: Array<{ from: string; to: string; axis: string; value: number }>;
};
```

**输出**（`memory.proposal.submit` 的 payload，逐条落 `memory_proposal_item`）：

```ts
type ProposalItem = {
  kind: 'experience'|'fact'|'relationship'|'cognition'|'world_fact'|'belief';
  characterId?: string;
  text: string;
  evidence: { beatId: string; quote: string };   // quote 必须是该拍正文的子串
  importance: number;                             // 0–1
  pin: boolean;
  payload?: Record<string, unknown>;              // 关系轴/值、事实三元组等
};
```

Schema 校验之外还有两条**代码级**规则：

| 规则 | 实现 |
|---|---|
| `quote` 必须是 `beat.body` 的子串（归一化后） | `assertEvidence()`；不匹配 → 丢弃该条并记 `evidence_mismatch` |
| 台词不能产生 `world_fact` | `classifyEvidence()`：`speaker_type='character'` → 只允许 `belief` 或 `fact(truth='claim')`；`world_fact` 必须来自旁白事件或作者确认 |

### 10.2 事实、信念、声称三分

| 输入证据 | 允许产出 | 不允许 |
|---|---|---|
| 角色台词「账本在祠堂」 | 该角色的 `belief`；或 `world_fact(truth='claim')` 提案 | 直接 `objective` 事实 |
| 旁白叙述「账本被放进祠堂」 | `world_fact(truth='objective')` 提案 | 自动生效（仍需 G7） |
| 分镜声明的事件（`event` 拍） | `world_fact` + `relationship_edge` | 由模型自由发明事件 |
| 作者在世界状态里手写 | `world_fact` 直接生效（作者权限） | — |

### 10.3 提案 → 决策 → 应用

```
memory.extract job
  → 生成 proposal items（pending）
  → UI 逐条 accept / edit / reject（写 decision，不写库）
  → G7 令牌签发
  → memory.apply(jobId, decisions[])
     1. 校验令牌 + 幂等键
     2. 计算所有待写入条目（文本 + 向量）
     3. 单个事务：写 memory_entry / world_fact / edge + memory_vec + 审计
     4. job=applied；令牌消费
```

| 阶段 | 写什么 | 不写什么 |
|---|---|---|
| 抽取 | `job.payload_json`、`memory_proposal_item` | 记忆库、世界状态 |
| 决策 | `memory_proposal_item.decision/edited_text` | 任何长期状态 |
| 应用 | `memory_entry`、`world_fact`、`relationship_edge`、`memory_vec` | 正文、分镜、角色卡 |

**向量与事务**：先批量算 embedding（worker），再单事务写文本 + 向量；embedding 失败 → 整个 apply 失败可重试，不出现「有文本无向量」的半状态。

**supersede 规则**：

| 谓词类型 | 换宾语 | 处理 |
|---|---|---|
| 单值（住址、生死、身份、持有唯一物） | 旧值 | 旧条目 `valid_to_seq` 或 `status='superseded'`，新条目 `supersedes_id` 指向旧 |
| 多值（喜欢、认识、去过） | 新值 | 并存，不 supersede |
| 否定（「不喜欢摄影」） | 与肯定句 | 先判极性再去重；不把否定当重复 |

### 10.4 检索管线（三通道 + 收口）

```ts
export async function retrieveOwn(q: Query, ctx: RetrievalCtx): Promise<Ref[]> {
  const { characterId, asOf, topK } = ctx;             // 全部来自运行时注入
  const vec = await vecSearch(q.text, characterId, asOf, 30);
  const kw  = await kwSearch(q.text, characterId, asOf, 30);
  const pinned = await pinnedBlock(characterId, asOf, 5);

  const fused = rrf([vec, kw], { k: 60, weights: [1.0, 0.7] });
  const gated = fused.filter(h => h.cosine >= ctx.threshold || h.bm25 >= ctx.kwFloor);
  if (gated.length === 0) return [];                   // 空 ≠ 失败
  const cut = gated.filter(h => h.score >= 0.4 * gated[0].score);
  const deduped = dedupeByText(cut);
  return deduped.slice(0, topK).map(toRef).concat(pinnedRefs(pinned));
}
```

| 步骤 | 规则 |
|---|---|
| 可见性过滤 | SQL 里 `character_id = ?` + `status='active'` + `learned_seq <= asOf` + (`valid_to_seq IS NULL OR valid_to_seq > asOf`)；不在应用层过滤 |
| 向量召回 | `memory_vec MATCH ? AND k=30`；`character_id` 过滤在 join 中完成 |
| 关键词召回 | bigram 展开 → FTS5 `MATCH` → BM25 top 30 |
| 融合 | RRF，k=60；权重向量 1.0、关键词 0.7 |
| 绝对下限 | cosine < 阈值（默认 0.35，按模型校准）且 BM25 < 下限 → 丢弃；全丢 → 空 |
| 相对截断 | 低于头名 40% 丢弃 |
| 去重 | 归一化文本 hash；保留 `importance` 高者 |
| pinned | 独立成段，最多 5 条，不参与相关性排序（PRD §8.4） |
| 时间衰减 | **不做**（PRD §8.4） |

**中文 bigram（工程补充）**：

```ts
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
export function bigrams(text: string): string {
  const chars = [...text.normalize('NFKC')].filter(c => !/\s/.test(c));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) {
    if (CJK.test(chars[i]) && CJK.test(chars[i + 1])) out.add(chars[i] + chars[i + 1]);
  }
  const latin = text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  for (const w of latin) out.add(w);
  return [...out].sort().join(' ');
}
```

- 写入时对 `text` 生成 bigrams 存 `memory_fts`；查询时同样展开。
- 单字查询（「信」）走 `LIKE`，不走向量；避免 bigram 为空导致 0 行。
- 阈值与 `top_k` 按角色档位：主角 8、配角 5、群众 2（PRD §7.5）。

### 10.5 嵌入 worker

```ts
// 协议：main ⇄ utilityProcess
type EmbedReq = { id: string; method: 'embed'; texts: string[]; kind: 'query'|'doc' };
type EmbedRes =
  | { id: string; ok: true; vectors: Float32Array[]; dim: number; model: string }
  | { id: string; ok: false; code: 'model_missing'|'oom'|'timeout'|'internal' };
```

| 项 | 规则 |
|---|---|
| 模型 | bge-small-zh-v1.5，512 维，q8；随包分发，路径 `resources/models/` |
| 启动 | 项目打开后懒启动，warmup 2 条短文本；空闲 5 分钟退出 |
| 批量 | 32 条/批；单条截断 512 token |
| 维度校验 | `project.embedding_dim` 与 worker 返回不一致 → 拒绝写入，提示重建索引 |
| 失败 | 检索降级为 `facts_only`；抽取任务失败可重试；不阻塞正文生成 |
| 版本 | `embedding_model` 写项目元数据；换模型必须全量重建索引（PRD §7.5） |

### 10.6 按章重建（M1）

1. `memory.rebuild(chapterId)` 需 `author_confirm` 令牌。
2. 旧条目（`source_chapter_id = chapterId`）→ `status='inactive'`，不物理删除。
3. 以新 final revision 重新抽取 → 新 job → 逐条决策（可「全部接受」）→ apply。
4. 关系边与事实：旧值 `valid_to_seq = 新 seq`，新值插入；不删历史。
5. 审计记录：旧/新 revision、inactive 数、重建数、操作者。

### 10.7 隔离自检（T38）

`memory.namespace.create` 返回前必须做：

1. 为每个角色写入一条探针记忆 `__probe__<characterId>`。
2. 以每个角色身份检索探针，断言只命中自己的。
3. 跨角色检索断言 0 条；命中即 `isolation_violation`，建库失败。
4. 删除探针（软删），写 `isolation_verified=1` 到项目元数据。
5. 自检失败 → `setup_state='failed'`，禁止开演（PRD §6.1）。

### 10.8 阈值校准

- M0 收集每个项目前 200 次检索的 `cosine` 分布（top1、top5、空结果率），写 `logs/retrieval-calibration.jsonl`。
- 按嵌入模型给一个默认阈值，项目级可覆盖；**不按当次最高分归一化**（PRD §8.3）。
- 空结果率 > 30% 时 UI 提示「补记忆或调 top_k」，不自动放宽阈值。

---

## 11 界面工程

### 11.1 外壳与栅格的单一真源

UI-DESIGN §2.2 的六个视口数字目前只存在于 Python 脚本里。TS 侧若手抄，必然漂移。做法：

```
docs/scripts/check_ui_spec.py --emit-json  →  scripts/gen-layout.mjs  →  src/shared/layout/grid.generated.ts
```

```ts
// 生成物示例（不要手改）
export const GRID = {
  W1: { sessions: 248, tree: 224, treeMode: 'pane', ratio: 1.2 },
  W2: { sessions: 248, tree: 44,  treeMode: 'rail', ratio: 1.2 },
  W3: { sessions: 64,  tree: 44,  treeMode: 'rail', ratio: 1.2 },
} as const;
export const BREAKPOINTS = { W1: 1600, W2: 1360, W3: 1280 } as const;
export const PROSE = { minChars: 32, maxChars: 42, maxColumn: 630, pad: 64 } as const;
```

| 规则 | 实现 |
|---|---|
| 组件不写死宽度 | `AppShell` 用 `gridTemplateColumns: ${nav}px ${sessions}px 1fr ${tree}px`，值来自 `GRID` |
| 断点判定唯一 | `useLayoutMode()` 只读 `window.innerWidth` 与 `BREAKPOINTS`；不在 CSS media query 里重复数字 |
| 正文列宽 | `min(max(previewWidth - PROSE.pad, 0), PROSE.maxColumn)`，与脚本同一公式 |
| CI 断言 | `python docs/scripts/check_ui_spec.py` + `pnpm gen:check`；生成物与源码不一致即失败 |
| 视觉回归 | Playwright 在 1280/1440/1600 三档读取 `getBoundingClientRect()`，与 `GRID` 计算值误差 ≤1px |

**为什么不用 media query**：断点同时决定「几栏」与「栏宽」，两份数字一定漂移；JS 计算 + CSS 变量只有一个真源。

### 11.2 组件清单（M0）

| 区域 | 组件 | 关键约束 |
|---|---|---|
| 外壳 | `AppShell` / `NavRail` / `StatusBar` | 导航 56；状态栏 24；闸门禁用必须带原因 |
| 外壳 | `SessionList` / `SessionRow` | 行高 32；状态点 6px；未读点在右 |
| 外壳 | `ChatPane` / `Composer` / `Message` | 消息最大宽 288；Agent 消息标「仅讨论/用于草案」 |
| 外壳 | `PreviewPane` / `PreviewTabs` / `FileTree` | tab 上限 6；章节正文 tab 不可关 |
| 外壳 | `CommandPalette` / `Toast` / `ConfirmDialog` | 定稿命令必须走确认框；无快捷键 |
| 创作 | `ProseView` / `BeatAnchor` / `BeatCard` | 连续正文；gutter `bt_012`；stale 虚线徽标 |
| 创作 | `BeatEditor` | CodeMirror 6；只挂载当前拍；IME 不拦截 |
| 创作 | `ConfirmBar` | 56px；`拍 12/24 · 沈昼 · 78 字`；主按钮唯一 |
| 创作 | `TraceDisclosure` / `RefChips` / `RefPanel` | 轨迹折叠；chips 不证明事实，面板顶部固定说明 |
| 创作 | `ContextInspector` | ≥1600 占对话栅；<1600 模态并置顶当前拍 |
| 创作 | `StoryboardTable` / `ConflictBadge` | 行内冲突；`notes` 固定提示「不进上下文」 |
| 规划 | `OutlineTree` / `FieldEditor` / `CharacterCardForm` | voice 四项必填；自动保存 800ms |
| 规划 | `GateBar` | 主按钮 + 阻塞原因 + 计数 |
| 审批 | `ReportView` / `IssueCard` / `DimensionBar` | 每条 issue 必须有 beat 与证据 |
| 审批 | `DiffView` / `PatchCard` | 三视图；hunk 级接受/拒绝 |
| 审批 | `VersionList` | 只读；定稿不可在此回退 |
| 记忆 | `ProposalList` / `ProposalRow` | 逐条接受/编辑/拒绝；台词不提供「转为事实」 |
| 记忆 | `MemoryBrowser` / `MemoryDetail` | 过滤 + 审计链 + 按章重建 |
| 记忆 | `WorldStateTable` | M0 只读当前视图；as-of 滑块与时间线 M1（§12.5 已砍） |
| 设置 | `ProviderCard` / `BindingTable` / `TestResult` | Key 只显末 4 位；继承链可见 |
| 通用 | `EmptyState` / `ErrorInline` / `TaskCard` | 空态 = 一句解释 + 一个主操作 + 一个链接 |

### 11.3 状态模型

```ts
// renderer/stores
type ProjectState = {
  meta: ProjectMeta | null;
  chapters: ChapterSummary[];
  currentChapterId: string | null;
  lock: { readOnly: boolean; holder?: string };
};

type RunState = {
  jobId: string | null;
  beatId: string | null;
  mode: 'beat' | 'auto';
  phase: 'idle' | 'generating' | 'waiting' | 'paused';
  buffer: string;                 // 仅当前拍的流式文本
  expectedRevision: string | null;
  pausedReason?: ErrorCode;
};

type UiState = {
  layout: 'W1' | 'W2' | 'W3';
  tabs: PreviewTab[];
  inspectorOpen: boolean;
  focusScope: 'global' | 'page' | 'editor';
};
```

| 规则 | 理由 |
|---|---|
| 正文不做乐观更新 | 只有 `beat.committed` 携带 `revisionId` 后才替换正文；否则流式与落盘会短暂不一致 |
| `buffer` 与正文分离 | 流式只影响当前拍占位，不触碰已确认段落 |
| revision 是渲染键 | 任何正文区域用 `revisionId` 做 key，避免「同一拍两份文本」 |
| 事件按 `seq` 丢弃乱序 | IPC 批量 flush 可能重排 |
| 断线/崩溃后重拉 | 重载时以 DB 投影为准，不信任内存 store |

### 11.4 拍级编辑

- 只挂载当前编辑拍的 CodeMirror 实例；退出编辑即卸载，避免 24 个编辑器抢内存。
- 中文 IME：`compositionstart/end` 期间不提交、不拦截 Enter、不重排 DOM。
- 保存：`Ctrl+Enter` 或失焦 400ms；提交带 `expectedRevision`；`stale_revision` → 行内提示 + 重新载入该章。
- 撤销：CM6 内建历史；跨提交撤销不支持（明确写进 UI 提示，不假装能撤销已落盘 revision）。
- 作者编辑后标 `author_edited`；若下游有已确认拍 → 三选一对话框（默认开新分支）。

### 11.5 流式渲染

| 项 | 规则 |
|---|---|
| flush | 32ms 或 24 字符，先到者 |
| 重渲染范围 | 只更新当前拍节点；兄弟节点 `React.memo`，props 不含 buffer |
| 布局稳定 | 新拍只追加到场景末尾；不重排已确认段落 |
| 光标 | 段末 2px accent 竖线 + 「生成中 3.2s」 |
| 无障碍 | `aria-live=polite` 只在 `beat.committed` 播报一次，不逐 token |
| 停止 | 保留已生成文本，标 `draft`；不自动丢弃 |

### 11.6 键盘与焦点

| Scope | 键 | 动作 | 守卫 |
|---|---|---|---|
| global | `Ctrl K` | 命令面板 | 无 |
| global | `Ctrl ,` | 设置 | 无 |
| write | `Enter` | 确认当前拍 | 焦点不在编辑器/输入框；非 IME composing |
| write | `Ctrl R` | 重新生成 | 当前拍为 `waiting_for_human` |
| write | `E` | 编辑当前拍 | 同上 |
| write | `J` / `K` | 下一 / 上一拍 | 只移动焦点，不确认 |
| write | `Space` | 自动模式暂停/继续 | 焦点不在输入框 |
| review | `A` / `X` | 接受/拒绝选中 patch | 有选中项 |
| review | `N` / `P` | 下/上一问题 | 无 |
| global | `Esc` | 关闭浮层 | 焦点回到触发元素 |

- 启动时做键位冲突检测（同一 scope 同一组合键重复 → dev 环境抛错）。
- 定稿、删除项目、移除记忆条目**没有单击快捷键**（UI-DESIGN §9.7）。

### 11.7 错误面

| 层 | 用法 | 例子 |
|---|---|---|
| 行内 | 可就地解决 | `stale_revision` → 「稿件已变更，点击重载」 |
| toast | 需要知道但不用决策 | 「已从列表移除，文件没有动」 |
| 对话框 | 破坏性/不可逆/花钱 | 定稿、删除、切换模型预估费用 |
| 全屏阻塞 | 项目级故障 | 迁移失败、`integrity_check` 失败 |

**不用 alert/confirm 原生弹窗**；所有对话框有 `role=dialog` 与焦点陷阱。

### 11.8 性能预算

| 项 | 目标 | 测量 |
|---|---|---|
| 冷启动到首页 | < 2.5s（SSD） | `performance.mark` |
| 打开项目 | < 800ms（含迁移与 verify） | main 日志 |
| 章节切换 | < 120ms 正文可读 | E2E 计时 |
| 输入延迟 | < 16ms/键 | Playwright 输入 200 字测量 |
| 流式 flush | 32ms 批量；UI 不掉帧 | 长任务观察 |
| 24 拍渲染 | 首屏 < 200ms | React Profiler |
| 30 章列表 | 滚动 60fps | M1 虚拟列表 |

---

## 12 工作分解、阶段顺序与砍单

### 12.1 里程碑与退出标准

| 里程碑 | 范围摘要 | 退出标准（可验证） |
|---|---|---|
| **M0 最小闭环** | 1 项目 / 5 角色 / 2 章；六页中的五页（首页、规划、创作、审批、记忆）+ 设置；默认逐拍 + 自动模式；2 家预设；工具注册表 + 36 个实现 | PRD §10 M0 全部 11 条（§16.1 映射） |
| **M1 多章与可回退** | 3 卷 30 章；章↔场景多对多；时间三轴；as-of 查询；记忆重建；关系图；NSIS + 自动更新；DOCX | PRD §10 M1 四条 |
| **M2 质量与规模化** | 声音区分度、伏笔回收、预算化自动模式、多供应商路由、成本报表、10 万字实测 | PRD §10 M2 三条 |

### 12.2 工作流与范围（M0）

| 流 | 内容 | 主要风险 |
|---|---|---|
| A 平台与外壳 | 脚手架、窗口、IPC、栅格、命令面板、日志 | Electron 打包与原生模块 |
| B 数据与存储 | 迁移、repos、seq/revision、outbox、备份、锁 | DDL 约束写错，后期返工 |
| C 工具层 | 注册表、解析、调用、闸门、幂等、审计、契约测试 | 顺序写错导致隔离破 |
| D 模型与运行时 | 适配器、上下文装配、信封校验、提示词、绑定 | 供应商工具调用差异 |
| E 规划台 | 对话、蓝图、角色卡、G1、建库 | 蓝图编辑器范围蔓延 |
| F 创作台与调度器 | 分镜、状态机、DSL、拍循环、正文 UI、自动模式 | 状态机补偿事务 |
| G 审批台 | 报告、patch、diff、G5/G6、复检 | patch 冲突与复检范围 |
| H 记忆台 | 抽取、提案、apply、浏览、隔离自检 | 事实/信念分类错 |
| I 设置与供应商 | 预设、Key、绑定、测试连接 | safeStorage 与代理 |
| J 测试与交付 | 假模型、E2E、混沌、打包、性能、安全 | E2E 不稳定 |


### 12.3 M0 任务表

| ID | 任务 | 依赖 | 交付 / 验收 |
|---|---|---|---|
| A1 | 仓库脚手架：electron-vite、TS strict、ESLint、dependency-cruiser、CI 骨架 | — | `pnpm dev` 起窗；依赖规则违规即 CI 失败 |
| A2 | 窗口、单实例、项目锁、只读第二窗口 | A1 | 双开同项目 → 第二窗口只读；写 IPC 被拒 |
| A3 | IPC 路由 + preload 命名空间 + 统一错误封装 | A1 | 非法参数返回 `invalid_args`；renderer 无原始异常 |
| A4 | 设计 token、`AppShell`、三档栅格、导航、状态栏 | A1 | 1280/1440/1600 与生成 token 误差 ≤1px |
| A5 | 命令面板、toast、对话框、焦点管理 | A4 | Esc 归位；定稿命令走确认框 |
| A6 | 日志、诊断包、设置存储 | A1 | 日志无 Key/正文 |
| B1 | 迁移器 + 0001 DDL + checksum | A1 | 迁移可重入；checksum 改动即失败 |
| B2 | repos：project/outline/character/chapter/scene/beat/revision | B1 | 单测覆盖 CRUD 与约束 |
| B3 | seq 分配、revision 清单、hash、`db.verify()` | B2 | 同 fixture 两次 hash 一致 |
| B4 | outbox、Markdown 镜像、外部编辑检测 | B2 | 外部改动 → `file_conflict`，不覆盖 |
| B5 | 备份、恢复、检查点 | B2 | `VACUUM INTO` 可打开；恢复校验 schema |
| B6 | 新建/打开项目向导后端（G0） | B1 | 目录校验、回滚空目录 |
| C1 | `defineTool`、registry、codegen、构建期五断言 | A1 | 42 个 manifest 生成 JSON；A1–A5 全绿 |
| C2 | 授权解析 + 角色实例收窄 + 快照 | C1 | 角色 schema 无 `character_id` |
| C3 | 调用流水线、预算、超时、截断 | C2 | 六类契约测试通过 |
| C4 | 闸门令牌、幂等、审计 | C3 | 令牌单次消费；重放不双写 |
| C5 | 42 个 manifest 契约（含 6 个未实现） | C1 | 与 PRD §4.10 名称/actors 一致 |
| C6 | 36 个工具实现 | C3、B2 | 逐工具契约测试 |
| C7 | 契约 harness + fixtures | C5 | 缺测试的 manifest 即 CI 失败 |
| D1 | SSE 适配器、工具增量、错误归一化、重试 | A1 | 两家预设流式 + 工具调用通过 |
| D2 | 能力探测 + 设置页测试连接后端 | D1 | 探测结果落 settings |
| D3 | 上下文装配 L0–L3 + 预算 + 确定性 | B2 | 同输入两次 bundle 完全一致 |
| D4 | 信封校验 + grounding 子集校验 | C3 | 越界引用 100% 拒绝 |
| D5 | 6 个 Agent 提示词 + JSON 回退协议 | D1、D3 | 无工具模型走回退不死循环 |
| D6 | 绑定快照、继承链、路由 | D2 | job 内不换模型 |
| E1 | 规划会话、流式、消息类型 | A3、D1 | 停止保留已生成 |
| E2 | 蓝图编辑器（结构树 + 字段 + 自动保存） | B2、A4 | 800ms 自动保存；G1 后只读 |
| E3 | 角色卡编辑器（voice 四项必填） | E2 | 缺 voice 阻断 G1 |
| E4 | G1 流程 + 注册清单 + 建库 + setup_incomplete | C6、D5 | 建库失败可重试，蓝图不回滚 |
| E5 | 覆盖检查占位（P1 开关关闭） | E2 | 不阻断 G1；开关可见 |
| F1 | 分镜编辑器 + `storyboard.validate` + G2 | B2、C6 | 冲突行内提示；冲突 0 才能开演 |
| F2 | 调度器循环、状态机、暂停/恢复/取消 | B3、C3 | 11 个拍状态迁移全覆盖 |
| F3 | 出口 DSL：解析、校验、求值 | B2 | 纯 beats 出口告警；自然语言拒绝 |
| F4 | 生成 → 校验 → 落盘 → 确认/重生成/编辑 | F2、D4、B4 | 重生成无孤儿；三重试补偿正确 |
| F5 | 正文视图、拍卡、流式、拍级编辑器 | A4、F4 | Enter 确认；IME 正常；stale 徽标 |
| F6 | 自动模式预检 + 预算暂停 | F4、D6 | 超预算必停；出口满足即停 |
| F7 | 拒演、耗尽、模型错误、离线状态面 | F4 | 四类暂停原因可见且可恢复 |
| G1 | 审批报告 schema + 运行 + 展示 | F4、D5 | 每条 issue 有 beat + 证据 |
| G2 | patch 提案 + diff + 逐条接受/拒绝 | G1、B2 | `before` 不匹配不套用 |
| G3 | G5/G6、定稿、未复检勾选 | G2 | 定稿仅作者；无快捷键 |
| G4 | 复检维度映射 + 3 轮上限 | G2 | 只跑受影响维度 |
| G5 | 版本列表与只读对比 | B3 | 定稿不可回退 |
| H1 | 抽取管线 + 证据子串校验 + 事实分类 | G3、D5 | 台词不产生 objective 事实 |
| H2 | 提案 UI + 逐条决策 | H1、A4 | 编辑/拒绝不写库 |
| H3 | apply 执行器 + 向量 + 幂等 + G7 | H1、C4、B2 | 重放不双写；事务原子 |
| H4 | 记忆浏览 + 审计 + 世界状态只读 | H3 | 软失效；来源可追 |
| H5 | 隔离自检 + 建库失败态 | E4、H3 | 跨角色探针 0 命中 |
| I1 | 供应商预设、safeStorage、Key UI | A1 | 项目目录无 Key 明文 |
| I2 | 绑定表 + 继承 + 审计 + 回滚 | I1、D6 | 改绑定只影响下一 job |
| I3 | 测试连接 + 能力/计价展示 | I1、D2 | 失败给错误码与建议 |
| I4 | 外观与基础偏好（亮色 + token 就绪） | A4 | 主题切换即时生效 |
| J1 | 假 LLM 服务器 + fixture 格式 | D1 | 可按 beat 注入文本/工具/错误 |
| J2 | E2E M0-A 黄金路径 | F、G、H | 全链路无手工改库 |
| J3 | 混沌：强杀、断电模拟、outbox 中断 | F4、H3 | 已确认拍零丢失 |
| J4 | NSIS 打包 + 原生模块 + 自动更新 | A1 | 干净 Win10/11 安装启动 |
| J5 | 性能基线 + 诊断导出 | 全部 | 记录 P50/P95 |
| J6 | 安全清单 + 无障碍 + 200% 缩放 | A4 | §4.4 全绿 |

### 12.3.1 开工 spike（决定三个 ADR）

| ID | 验证什么 | 通过线 | 失败回退 |
|---|---|---|---|
| S1 | sqlite-vec 在 Electron main 与打包产物中可加载 | dev + NSIS 安装包均可 `loadExtension`；20k 条查询 P95 < 80ms | Plan B：BLOB + 进程内余弦（§5.6） |
| S2 | ONNX 嵌入 worker 冷启动与吞吐 | 冷启动 < 1.5s；单条 < 120ms；512 维 | 换更小模型或降 q4（D7） |
| S3 | 三家预设的 SSE 流式 + 工具调用增量 | 至少两家能完整拼装 `tool_calls` 与 `usage` | JSON 回退协议（§7.6）；M0 只承诺两家 |
| S4 | NSIS + 自动更新在干净 Windows 上可用 | 安装、启动、检查更新不阻塞；卸载干净 | 手动下载安装包；自动更新降级为 M1 |

> spike 代码不进主干；结论写 `docs/adr/0001..0003`，失败即改方案，不带病开工。

### 12.4 阶段顺序

| 阶段 | 文档 | 主要任务 | 出口 |
|---:|---|---|---|
| 1 | `PHASE-01-SKELETON.md` | S1–S4、A1–A6、B1、B6 | 能建/开项目；IPC 隔离；打包可用 |
| 2 | `PHASE-02-DATA.md` | B2–B5 | 约束、hash、outbox、备份、verify 全绿 |
| 3 | `PHASE-03-TOOLS.md` | C1–C7 | 42 manifest、36 实现、契约测试全绿 |
| 4 | `PHASE-04-RUNTIME.md` | D1–D6 | 假模型产出合法信封；grounding 拒绝 |
| 5 | `PHASE-05-SLICE.md` | V1–V3 | 一拍端到端跑通；重启不丢 |
| 6 | `PHASE-06-PLANNING.md` | E1–E5 | G1 完成；建库与隔离通过 |
| 7 | `PHASE-07-WRITING.md` | F1–F7 | 一章 draft_complete；自动模式收束 |
| 8 | `PHASE-08-REVIEW.md` | G1–G5 | 报告 → patch → G6 定稿 |
| 9 | `PHASE-09-MEMORY.md` | H1–H5 | G7 应用；第 2 章召回 |
| 10 | `PHASE-10-DELIVERY.md` | I1–I4、J1–J6 | 两家预设；E2E；NSIS；M0 验收 |

每份阶段文档包含范围、任务、交付物、验收与退出条件；本表只定义顺序与出口。

**依赖链**：S1 → C1 → C3 → F4 → G2 → H3 → J2。任一环阻塞只能砍范围（§12.5），不挪用测试。

### 12.5 M0 砍单清单（写死在范围里）

| 砍掉 | 原属 | 理由 | 去向 |
|---|---|---|---|
| 关系图 UI | 记忆台 P1 | 不影响闭环；数据先有，图后画 | M1 |
| 世界状态时间线 as-of UI | 记忆台 P1 | 查询先做（T13/T14/T15），UI 后置 | M1 |
| 伏笔追踪 | P1 | 无数据模型，先定契约 | M1 |
| 覆盖检查 | 规划台 P1 | M0 只保留占位与开关 | M1 |
| 影响分析 | P1 | 跨章标脏依赖它；M0 明示限制 | M1 |
| DOCX 导出 | M1 | Markdown/TXT 够验收 | M1 |
| 分支树 UI | — | M0 用线性 revision + 旧版可读 | M1 |
| 异构模型复检 | 审批 P1 | M0 只做「手动绑第二家」 | M1 |
| 成本/耗时报表 | M2 | 先落 `turn_metric`，报表后置 | M2 |
| 主题/外观完整设置 | 设置 P1 | M0 只亮色 + token 就绪 | M1 |
| 项目模板 | P2 | 与「不支持导入」一起后置 | M2 |
| 自动补旁白建议 | P2 | 只保留提示，不自动插拍 | M2 |

### 12.6 M1 / M2 任务概要

**M1 任务**

| ID | 任务 |
|---|---|
| M1-1 | 章↔场景多对多 UI + 场景管理 |
| M1-2 | 时间三轴（`story_start/end`、`idx`、`timeline`） |
| M1-3 | as-of 查询 + 世界时间线 UI |
| M1-4 | 按章重建 + 审计 |
| M1-5 | 关系图（回放 + 来源） |
| M1-6 | DOCX 导出 |
| M1-7 | NSIS 签名/通道/自动更新 GA |
| M1-8 | 影响分析 + 蓝图变更流程 |
| M1-9 | 30 章性能 + 虚拟列表 |
| M1-10 | 伏笔列表与节奏提示 |
| M1-11 | 覆盖检查 |
| M1-12 | 多项目切换 + 首页完善 |
| M1-13 | 章末摘要 + L0 压缩 |
| M1-14 | 导出批注与格式选项 |
| M1-15 | QA / 硬化 |

**M2 任务**

| ID | 任务 |
|---|---|
| M2-1 | `voice.metrics` + 中文阈值校准 |
| M2-2 | 声音漂移告警 |
| M2-3 | 预算化自动模式 + 费用预测 |
| M2-4 | 多供应商路由与故障切换策略 |
| M2-5 | 成本/耗时报表（按章/Agent） |
| M2-6 | 10 万字项目性能专项 |
| M2-7 | P2 归档（仅非事实类） |
| M2-8 | 异构复检 + 评分校准 |
| M2-9 | 提示词与上下文成本优化 |
| M2-10 | QA / 内测 |

### 12.7 范围控制规则

- 任何阶段做不完 → 先砍该阶段对应的 P1 项，不挪用测试资源。
- 不在 M0 内追加 PRD 未列功能；新想法进 `docs/BACKLOG.md`。
- 阶段 05 失败 → 停止进入 06，先修集成问题。
- 砍单必须同步更新 §12.5 与 §16 验收表，避免「砍了但验收还要求」。

### 12.8 Definition of Done（每个任务）

1. 代码 + 单测/契约测试；关键路径有集成测试。
2. 涉及契约（工具、IPC、schema）→ 生成物更新且 `gen:check` 通过。
3. 涉及 UI 状态 → 加入 §10 状态矩阵 fixture。
4. 新增错误码 → 进 `errors.ts` 与 §18.2 文案表。
5. 无 `TODO`/`FIXME` 进主干；确需后置 → 建 issue 并标里程碑。
6. 提交说明含：改了什么、怎么验证、对铁律的影响（无影响也要写「无」）。

---

## 13 测试策略

### 13.1 测试金字塔与数量目标

| 层 | 工具 | 目标数量（M0） | 运行时机 | 单次运行上限 |
|---|---|---:|---|---|
| 单元 | Vitest | ~350 | 每次提交 | < 30s |
| 契约 | Vitest + harness | 36 × 6 + 12 注册表 | 每次提交 | < 60s |
| 集成 | Vitest + 临时项目目录 | ~80 | 每次提交 | < 3min |
| E2E | Playwright `_electron` | 12 场景 | 每次提交（Windows） | < 8min |
| 混沌 | Node 脚本 | 8 场景 | nightly | < 5min |
| 性能 | Node + Playwright | 6 基线 | nightly | < 10min |
| 手工 | 清单 | §13.9 | 每里程碑 | — |

### 13.2 假 LLM 服务器

```yaml
# tests/fixtures/m0-a/planner.blueprint.yaml
match:
  agent: planner
  beat: plan.blueprint
response:
  stream:
    - "我先给出一版可执行的蓝图草案。\n"
    - "主线：一封遗书牵出账本，账本牵出祠堂。\n"
  tool_calls:
    - tool: blueprint.propose_patch
      args:
        ops:
          - op: add_node
            kind: volume
            title: 第一卷 · 黑漆匣子
  usage: { in: 1800, out: 420 }
```

| 能力 | 说明 |
|---|---|
| 按 `agent + beat` 匹配 | 请求里带 `[BEAT:bt_012]` 标记（仅测试模式） |
| 流式切片 | 按字符/词切片，带 5–20ms 延迟 |
| 工具调用 | 可返回并行/串行、非法参数、未知工具 |
| 错误注入 | `timeout` / `429` / `500` / `protocol` / `content_filter` |
| 确定性 | 同一 fixture 同一请求序列 → 同一输出；不使用随机数 |
| 计费 | 返回固定 `usage`，用于预算测试 |

### 13.3 单元与契约

| 模块 | 必测点 |
|---|---|
| `scheduler/transition` | 11 个拍状态全迁移；非法迁移抛错；重生成补偿 |
| `scheduler/dsl` | 6 种节点、深度/节点上限、未知实体、纯 beats、求值边界 |
| `context/budget` | 裁剪顺序、永不裁角色卡、确定性、超预算抛错 |
| `tools/resolve` | 六个 Agent 数量、角色收窄、未授权不下发 |
| `tools/invoke` | 九步顺序、预算、超时、截断、错误码 |
| `tools/gates` | 过期、错实体、已消费、失败不消费 |
| `tools/idempotency` | 同键重放、不同参数不同键、canonical JSON |
| `doc/hash` | 规范序列化、空章、单拍、顺序变化 |
| `memory/classify` | 台词→belief、旁白→fact、否定不合并 |
| `memory/retrieval` | bigram、空结果、阈值、pinned 独立 |

### 13.4 E2E 黄金路径 `E2E-M0-A`

固定项目「黑漆匣子」：5 角色、2 章、每章 3 场 24 拍、每章 3000+ 字。

| 步 | 操作 | 断言 |
|---:|---|---|
| 1 | 新建项目（G0） | 目录、DB、五个子目录存在；`gate_record` 有 G0 |
| 2 | 规划对话 → 生成蓝图 | 草案字段齐全；对话不改文件 |
| 3 | G1 确认 | 5 角色注册；5 私有库 + 1 公共库；`setup_state=complete` |
| 4 | 建库隔离自检 | 跨角色探针 0 命中 |
| 5 | 生成分镜（3 场 24 拍）→ G2 | 冲突 0；`storyboard_revision` 落库 |
| 6 | 逐拍：前 6 拍（4 确认、2 重生成） | 旧拍 `superseded`；无孤儿；`revision` 链完整 |
| 7 | 切自动模式跑到出口 | 在出口条件处停；不超 `max_beats` |
| 8 | 送审（G4） | 报告含 2 阻断、3 建议；每阻断有 beat + 证据 |
| 9 | G5 → 3 条 patch | 接受 2、拒绝 1；新 revision；拒绝保留原文 |
| 10 | 复检 → G6 定稿 | `kind=final`；定稿后写正文被拒 |
| 11 | G7：14 条提案，删 2、改 1 | `applied_count=12`；重放不双写 |
| 12 | 第 2 章生成一拍 | 检索命中第 1 章 ≥1 条记忆；`grounding` ⊆ refs |
| 13 | 导出 Markdown | hash 与当前 revision 一致 |
| 14 | 强杀重启 | 已确认拍零丢失；`running` job → `interrupted` |

**断言方式**：DB 快照（选定表的规范化 JSON）+ 关键 UI 状态；不做全文快照（文案会变）。

### 13.5 回退与状态一致性 `E2E-ROLLBACK-01`

1. 定稿第 1 章 → 应用记忆 → 写第 2 章 3 拍。
2. 回退到第 1 章定稿前（新建 draft、`write_epoch+1`）。
3. 断言：正文、世界事实、信念、关系边、记忆条目五域回到该检查点；迟到 job 被 `stale_revision` 拒绝。
4. 重新定稿 → 旧记忆 `inactive` → 按章重建 → 新记忆 `active`。

### 13.6 混沌与崩溃

| 场景 | 注入 | 断言 |
|---|---|---|
| 生成中强杀 | `taskkill /F` | 已确认拍完整；当前拍 `interrupted` |
| 落盘事务中强杀 | 事务前/后杀 | 无半条 revision；无孤儿 `revision_beat` |
| outbox 发布中断 | 写完临时文件后杀 | 重启重试；hash 一致则跳过 |
| 记忆 apply 中断 | 事务中杀 | 要么全写，要么全不写 |
| 数据库锁 | 第二进程持有 | 5s 超时后报 `project_locked`，不静默失败 |
| 磁盘满 | 模拟写失败 | 明确错误；不产生 0 字节 db |
| 版本更新中断 | 中断下载 | 启动不受影响；可手动重装 |

### 13.7 性能基线

| 场景 | 数据量 | 目标 |
|---|---|---|
| 打开 30 章项目 | 30 章 / 120k 字 / 3k 记忆 | < 800ms |
| 切章 | 同上 | < 120ms |
| 检索 | 20k 记忆 | P95 < 80ms |
| 生成一拍（不含模型） | 24 拍章节 | 装配 + 校验 < 150ms |
| 导出 30 章 Markdown | 120k 字 | < 2s |
| 内存 | 打开项目后 | < 600MB |

### 13.8 安全与隔离测试

| ID | 断言 |
|---|---|
| `SEC-ISO-01` | 角色 A 的 `memory.retrieve_own` 结果不含 B 的 `mem_*`；缓存键含身份 |
| `SEC-ISO-02` | 角色 schema 中不存在 `character_id`；硬塞该字段 → `invalid_args` |
| `SEC-TOOL-01` | 每个 Agent 的 `tools` 快照 = allowlist；旁白 5、审批 20 |
| `SEC-TOOL-02` | 未授权工具硬调 → `tool_not_found` + `unauthorized_tool_attempt` 审计 |
| `SEC-GATE-01` | 无令牌 `memory.apply` → `gate_required`；作者未点 G6 无法产生 final |
| `SEC-GROUND-01` | 伪造 grounding（不在本轮 refs）→ 拒绝；quote 改写 → 拒绝 |
| `SEC-KEY-01` | 项目目录与日志中搜不到 Key 明文 |
| `SEC-IPC-01` | renderer 调未注册通道 → 拒绝；参数多余字段 → 拒绝 |

### 13.9 手工探索清单（每里程碑）

- 1280×800 三档布局；200% 缩放按钮不截断。
- 中文 IME 连续输入 200 字、撤销、切拍。
- 断网：生成禁用、阅读/编辑/导出可用。
- 双开项目：第二窗口只读。
- 移动项目文件夹后打开：路径失效 → 重新定位。
- 只读介质：写失败提示清晰。
- 长章节（60 拍）滚动与确认延迟。
- 审批报告 20 条 issue 的定位与滚动。
- 记忆提案 50 条的批量操作。

### 13.10 覆盖目标

| 范围 | 目标 |
|---|---|
| 状态机、工具解析/调用、闸门、幂等、hash、预算 | 行 100% / 分支 ≥95% |
| repos、doc controller、memory executor、scheduler | 行 ≥85% |
| renderer 组件 | 行 ≥60%；关键交互（确认条、patch 卡）≥80% |
| 整体 | 行 ≥75%，不达标不进入下一任务 |

覆盖率不是目的；上表前两行是「出错会坏数据」的模块，必须死守。

---

## 14 CI/CD 与发布

### 14.1 流水线

```yaml
name: ci
on:
  push: { branches: [dev, main], tags: ['v*'] }
  workflow_dispatch:

jobs:
  verify:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm depcruise
      - run: pnpm test:unit --coverage
      - run: pnpm test:contract
      - run: python docs/scripts/check_ui_spec.py
      - run: python docs/scripts/check_tool_spec.py --manifests docs/tools --prd docs/PRD.md
      - run: pnpm gen:check
      - run: pnpm build

  integration:
    runs-on: windows-latest
    needs: verify
    steps:
      - run: pnpm test:integration

  e2e:
    runs-on: windows-latest
    needs: verify
    steps:
      - run: pnpm build
      - run: pnpm test:e2e

  package:
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: windows-latest
    needs: [integration, e2e]
    steps:
      - run: pnpm dist
      - uses: actions/upload-artifact@v4
        with: { name: nsis, path: release/*.exe }
```

### 14.2 硬门（不通过不进入下一任务）

| 门 | 命令 | 失败含义 |
|---|---|---|
| 类型 | `tsc --noEmit` | 契约被破坏 |
| 依赖边界 | `depcruise` | renderer 摸到了 main/fs |
| 工具清单 | `check_tool_spec.py` | 文档与代码双份真相 |
| 清单生成 | `gen:check` | 忘记重新生成 |
| UI 栅格 | `check_ui_spec.py` | 断点/字宽漂移 |
| 单元 + 契约 | `vitest run` | 状态机/权限回归 |
| 集成 | `vitest run tests/integration` | 事务/迁移问题 |
| E2E | `playwright test` | 闭环断了 |

### 14.3 构建与发布

| 项 | 做法 |
|---|---|
| 版本 | semver，`0.x` 阶段；tag `v0.1.0-m0.1` |
| 通道 | `dev`（每次 dev 构建）、`beta`（内测）、`stable`（里程碑） |
| 发布物 | NSIS `.exe` + `latest.yml` + blockmap |
| 自动更新 | `electron-updater` GitHub provider；启动检查失败不阻塞（PRD §9.1） |
| 回滚 | 重发上一版本并提高版本号；客户端允许降级仅限同一 minor |
| 签名 | M0 不签名（内测）；M1 决定是否购买 Authenticode（§17 D2） |
| 产物保留 | 每个 tag 永久保留；内测构建保留最近 3 个 |

### 14.4 安装冒烟（每个里程碑）

1. 干净 Windows 10 22H2 与 Windows 11 各一台（或 VM）。
2. 安装 → 启动 → 新建项目 → 生成一拍（真实 API）→ 关闭 → 重开。
3. 检查：无缺少 DLL、无杀软拦截、无 `asar` 路径错误、更新检查不阻塞。
4. 卸载 → 用户数据目录保留（项目在用户选定目录）。

### 14.5 发布检查清单

- [ ] `schema_version` 与迁移齐全；旧项目可打开。
- [ ] 更新 `docs/PRD.md` 变更记录（若契约变更）。
- [ ] `docs/tools/*.json` 与代码一致。
- [ ] M0 验收表（§16）全绿。
- [ ] 回滚方案与上一版安装包可用。
- [ ] 诊断包导出可用（无正文、无 Key）。

---

## 15 工程风险

| # | 风险 | 触发信号 | 影响 | 对策 |
|---|---|---|---|---|
| R1 | sqlite-vec 在打包后加载失败 | dev 可跑、安装包报 `no such module` | 检索不可用，M0 阻塞 | 开工 spike 验证；失败切 Plan B（BLOB + 余弦） |
| R2 | ONNX 模型冷启动过慢/体积过大 | 首查 > 2s；安装包 > 250MB | 体验差、分发困难 | q8 + 懒加载 + warmup；必要时换更小模型 |
| R3 | 供应商工具调用协议差异 | 某预设工具调用解析失败 | 该预设不可用 | 能力探测 + JSON 回退；M0 只承诺两家 |
| R4 | 中文 IME 与编辑器冲突 | 输入重复/丢字/回车提交 | 写作不可用 | CM6 + composition 守卫；开工时手工测 200 字 |
| R5 | E2E 不稳定 | 随机失败 > 5% | CI 失去意义 | 假模型 + 固定时钟 + 等待条件（不用 sleep） |
| R6 | 范围蔓延 | M0 加 P1 功能 | 延期 | §12.5 砍单清单；变更先写进文档再动手 |
| R7 | `docs/` 不入库 | 换机器后无规格、CI 缺脚本 | 硬门失效 | 开工前修 `.gitignore`（§3.4） |
| R8 | 无代码签名触发 SmartScreen | 用户不敢装 | 转化低 | M1 评估证书；内测给校验值 |
| R9 | 杀软误报原生模块 | 安装被拦 | 无法启动 | 提交误报；签名；提供 zip 版 |
| R10 | 单人中断（生病/长假/设备故障） | 长时间无法推进 | 进度停摆 | 始终保持可运行构建；ADR 与恢复步骤写进 docs；密钥/证书有备份 |
| R11 | SQLite 断电损坏 | `integrity_check` 失败 | 丢数据 | WAL + 每日备份 + `VACUUM INTO` 检查点 |
| R12 | 开发期真实 API 费用 | 频繁跑全章 | 成本高 | CI 全用假模型；真实调用限 nightly 冒烟 |
| R13 | 上下文装配不确定 | 同章两次结果差异大 | 无法复现/归因 | 纯函数 + 排序键 + 快照测试 |
| R14 | 审批 patch 冲突率高 | 大量 `patch_conflict` | 修订体验差 | 严格 base revision + 逐条接受 + 提示重跑 |

---

## 16 验收对照

### 16.1 PRD M0 退出标准 → 验证手段

| # | PRD 标准 | 测试 ID | 验证方式 |
|---:|---|---|---|
| 1 | 空项目到一章 3000+ 字定稿，全程无手工改库/文件 | `E2E-M0-A` | 全链路脚本；结束后 `db.verify()` 通过 |
| 2 | 默认逐拍确认路径可用 | `E2E-M0-BEAT` | 6 拍中 4 确认 2 重生成；无孤儿 |
| 3 | 自动模式可显式开启并在出口条件处停下 | `E2E-M0-AUTO` | 出口 DSL 求值；`job.result_json.exit=satisfied` |
| 4 | 至少两家预设可切换；一个 Agent 绑第二家仍能完成一章 | `E2E-M0-PROVIDER` | 规划用 A、审批用 B；一章跑通 |
| 5 | 第 2 章检索到第 1 章定稿后的至少一条记忆 | `E2E-M0-MEMORY` | 断言 `memory_entry.source_chapter_id=ch1` 被召回 |
| 6 | 越权检索返回空 | `SEC-ISO-01` | 跨角色探针 0 命中；审计有 `filtered_count` |
| 7 | 审批 patch 可逐条接受/拒绝 | `E2E-M0-PATCH` | 2 接受 1 拒绝；拒绝保留原文 |
| 8 | 定稿只能由作者触发 | `SEC-GATE-01` | 无 G6 令牌调用 finalize → 拒绝 |
| 9 | 崩溃重启后已确认拍不丢 | `CHAOS-01` | 强杀后逐拍比对 hash |
| 10 | 未授权工具不出现在模型工具列表 | `SEC-TOOL-01` | 快照与 manifest allowlist 一致 |
| 11 | `grounding` 引用全部来自本轮工具返回 | `SEC-GROUND-01` | 伪造/改写 quote 均被拒 |

### 16.2 铁律落点

| 铁律 | 唯一落点 | 测试 |
|---|---|---|
| R1 作者定稿权不可代理 | `doc/finalize.ts` 要求 G6 令牌；UI 定稿按钮只在审批台 header；无快捷键 | `SEC-GATE-01` |
| R2 一个文件一个写入者 | `doc/commitBeat` 写正文；`memory/executor` 写记忆；ESLint 禁其他路径 | `UNIT-DOC-01` |
| R3 限知由权限强制 | `tools/resolve` 收窄 + `injected` 身份 + SQL 过滤 | `SEC-ISO-01/02` |
| R4 正文与轨迹分离 | `Envelope` → `commitBeat` 只取 `body`；`trace_ref` 归档 | `UNIT-ENV-01` |
| R5 一切状态可回退 | revision 链 + append-only 事实 + `memory.rebuild` + 备份 | `E2E-ROLLBACK-01` |

### 16.3 工具层不变式

| 不变式 | 落点 | 测试 |
|---|---|---|
| I1 唯一能力出口 | `tools/**` 禁 fs/sql/fetch；Agent 运行时无句柄 | `SEC-TOOL-02` |
| I2 可见性由注册表决定 | `resolve` + `generated/allowlist` | `SEC-TOOL-01` |
| I3 身份运行时注入 | `injected` 与 `input` 交集为空（A2） | `SEC-ISO-02` |
| I4 只提案或凭令牌执行 | `sideEffect` 断言 + `gates` | `SEC-GATE-01` |

### 16.4 工程目标

| 目标 | 测试 | 通过线 |
|---|---|---|
| E1 闭环 | `E2E-M0-A` | 14 步全绿 |
| E2 铁律落点 | §16.2 | 每条有测试且通过 |
| E3 工具契约 | 契约套件 | 36 × 6 + 12 全绿 |
| E4 崩溃恢复 | `CHAOS-01..08` | 已确认拍零丢失 |
| E5 回退一致 | `E2E-ROLLBACK-01` | 五域一致 |
| E6 规模 | `PERF-01` | §13.7 达标 |
| E7 安装 | 安装冒烟 | Win10/11 各一台通过 |

**判定规则**：任一条不通过 → M0 不算完成；不允许用「已知问题」清单替代阻断项。唯一例外是 PRD 明确的 M1/M2 项（§12.5 砍单清单）。

---

## 17 待定技术决策（ADR）

| ID | 问题 | 决策期限 | 判定规则 | 备选 |
|---|---|---|---|---|
| D1 | sqlite-vec vs BLOB 余弦 | 开工 spike 后 | 打包后可加载 且 20k 条 P95 < 80ms → A；否则 B | A: sqlite-vec；B: BLOB |
| D2 | 是否购买 Authenticode 证书 | M1 开始前 | 内测安装成功率 < 80% 或 SmartScreen 拦截率高 → 买 | 签名 / 不签名 + 校验值 |
| D3 | 是否收集匿名遥测 | M1 开始前 | 默认不做；只做用户主动导出诊断包 | 无遥测 / opt-in |
| D4 | 审批异构复检是否默认开启 | M2 | 成本增加 < 20% 且阻断漏报下降 → 默认开 | 默认开 / 手动 |
| D5 | 自动更新是否允许跨 minor 降级 | M1 | 只允许同 minor 降级，防 schema 回退 | — |
| D6 | 编辑器最终选型 | 开工 spike 后 | CM6 在 200 字 IME 测试无丢字 → 采用；否则 textarea 降级 | CM6 / textarea |
| D7 | 嵌入模型 bge-small vs 更小 | W2 结束 | 冷启动 < 1.5s 且检索空结果率 < 25% → bge-small | bge-small / mini |

**ADR 写法**：`docs/adr/NNNN-title.md`，含背景、选项、决定、后果、回滚方式。决定后不改文档，只增补。

---

## 18 附录

### 18.1 里程碑交付物

| 里程碑 | 可交付 | 不可交付（明示） |
|---|---|---|
| M0 | 安装包、示例项目、M0 验收报告、工具清单 JSON、schema v1 | 关系图、DOCX、伏笔、覆盖检查、影响分析 |
| M1 | 30 章项目、as-of 查询、重建、关系图、DOCX、自动更新 GA | 声音指标、成本报表 |
| M2 | 声音/伏笔指标、预算化自动、路由、成本报表、10 万字报告 | 协作、云同步、导入旧稿 |

### 18.2 错误码与 UI 文案

| code | UI 文案 | 可操作 |
|---|---|---|
| `model_error` | 模型超时或不可用，已重试 2 次 | 重试 / 切预设 |
| `model_auth` | API Key 无效或过期 | 去设置 |
| `rate_limit` | 供应商限流，请稍后再试 | 重试 / 暂停 |
| `content_filter` | 供应商拒绝了本次生成 | 改分镜 / 换模型 |
| `memory_empty` | 没有检索到可用记忆，本拍依据不足 | 补记忆 / 调 top_k |
| `context_trimmed` | 上下文已裁剪（历史拍/检索条数） | 查看明细 |
| `storyboard_conflict` | 分镜有冲突，无法开演 | 定位冲突 |
| `character_refusal` | 角色拒演：{reason} | 改分镜 / 改卡 / 换人 |
| `storyboard_exhausted` | 分镜已用完但场景未收束 | 补分镜 |
| `file_conflict` | 正文文件被外部修改 | 以 DB 为准 / 导入 |
| `human_takeover` | 已修订 3 轮，转人工 | 定稿 / 人工处理 |
| `tool_unavailable` | 工具不可用，任务已暂停 | 重试 / 查看日志 |
| `tool_protocol_error` | 模型无法按要求调用工具 | 换模型 / 重试 |
| `tool_budget_exceeded` | 本轮取材已达上限 | 继续（依据不足） |
| `stale_revision` | 稿件已变更，请重新读取 | 重载 |
| `gate_required` | 需要作者确认 | 打开闸门 |
| `gate_consumed` | 该确认已使用 | 重新确认 |
| `invalid_args` | 参数不合法 | 重试 |
| `timeout` | 查询超时，已返回部分结果 | 重试 |
| `invalid_grounding` | 依据校验失败，本拍未保存 | 重生成 |
| `patch_conflict` | 原文已变，patch 未套用 | 重新生成 patch |
| `project_locked` | 项目已在另一窗口打开 | 只读打开 |
| `migration_checksum_mismatch` | 迁移文件被修改，无法启动 | 恢复备份 |
| `isolation_violation` | 记忆隔离自检失败 | 重建命名空间 |
| `context_overflow` | 上下文超预算且无法裁剪 | 调小 top_k / 换模型 |
| `setup_incomplete` | 角色库未建好，暂不能开演 | 重试建库 |
| `already_finalized` | 本章已定稿 | 重新打开 |
| `project_not_found` | 项目不存在或路径不可用 | 重新定位 / 从列表移除 |
| `project_create_failed` | 无法创建项目 | 换位置 / 导出诊断 |
| `vector_unavailable` | 向量索引不可用，检索已降级 | 重装 / 查看日志 |
| `internal_error` | 发生内部错误，请导出诊断包 | 导出诊断 / 重启 |

原则：文案只说「能不能继续」，不解释「为什么被拒」；原因进日志。

### 18.3 术语与代码命名对照

| 中文 | 代码 | 表 |
|---|---|---|
| 规划 / 编排 / 角色 / 旁白 / 审批 / 记忆 | `planner` / `orchestrator` / `character` / `narrator` / `reviewer` / `memory` | `model_binding.agent_key` |
| 拍 | `beat` | `beat` |
| 分镜 | `storyboard` | `scene` + `beat`(planned) |
| 正文 | `body` | `beat.body` |
| 轨迹 | `trace` | `logs/trace/*` + `beat.trace_ref` |
| 依据 | `grounding` | `beat.grounding_json` |
| 初稿 / 定稿 | `draft` / `final` | `revision.kind` |
| 闸门 | `gate` | `gate_record` |
| 记忆固化 | `memory.apply` | `memory_entry` + `world_fact` |
| 提案 | `proposal` | `memory_proposal_item` / `patch` |
| 角色私有记忆 | `memory_entry` | 按 `character_id` 隔离 |
| 世界状态 | `world_fact` + `character_belief` + `relationship_edge` | 投影，不是大表 |

### 18.4 方案变更流程

1. 任何影响工具契约、DB schema、闸门语义的改动 → 写 ADR + 更新 PRD 变更记录。
2. 只影响实现 → 更新本方案对应小节 + 在提交说明里引用小节号。
3. 阶段顺序或范围变更 → 更新 §12 并写进变更记录；不凭记忆改。
4. 砍单 → 必须同时更新 §12.5 与验收表，避免「砍了但验收还要求」。

### 18.5 开工清单

- [ ] 修 `.gitignore`：`docs/` 入库（或至少 `docs/tools`、`docs/scripts`）。
- [ ] 跑 S1–S4 四个 spike，写 ADR-0001（向量）与 ADR-0002（编辑器）。
- [ ] 建 `docs/tools/` 目录与 42 个 manifest 的空壳（只有 name/actors/version）。
- [ ] 写 `check_tool_spec.py` 的第一版：解析 PRD §4.10 表格，比对名称与 actors。
- [ ] 给 `check_ui_spec.py` 加 `--emit-json`，生成 `grid.generated.ts`。
- [ ] 建 `tests/fixtures/m0-a/` 骨架：5 角色、2 章、24 拍的分镜 JSON。
- [ ] 建 `docs/adr/` 与 `docs/BACKLOG.md`。
- [ ] 确认 CI 在 windows-latest 上能跑 `pnpm install + build`（先不跑 E2E）。

---

## 变更记录

- **v0.4（阶段 01 实施）**：S1 确认 sqlite-vec Plan A（ADR-0001），S2 确认 bge-small-zh-v1.5 q8/512 维（ADR-0004）；`_migration` 由迁移器创建，`0001_init.sql` 不再重复建表；新增 4 个错误码（`project_not_found` / `project_create_failed` / `vector_unavailable` / `internal_error`）；`docs/tools/*.json` 首版是契约外壳（`contract_complete:false`），input/output schema 由阶段 03 C5 补齐。
- **v0.3**：移除全部进度估算，只保留阶段顺序、范围、依赖与验收。
- **v0.2**：改为单人开发口径：移除人员编制与并行分工，改为阶段顺序。
- **v0.1**：首版。补 PRD v0.6 未定义的八个工程缺口（seq 分配、revision 清单、manifest 生成、grounding 登记、token 预算、中文 bigram、docs 入库、栅格真源）；给出技术选型、模块边界、DDL、工具层调用流水线、状态机与 DSL、WBS 与阶段顺序、测试与 CI、验收对照。
