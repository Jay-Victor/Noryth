import { z } from 'zod';

/** 项目清单：存放在项目根，进 Git，人可读。 */
export const MANIFEST_FILE = 'noryth.json';
export const MANIFEST_SCHEMA_VERSION = 1;

export const ManifestSchema = z.strictObject({
  schemaVersion: z.number().int().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  branch: z.string().min(1),
  /** 项目级设置差异；读取时与全局设置 deep-merge。 */
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * 项目骨架布局。INIT_ENTRIES 是 P0 门禁 3 断言的"7 个文件/目录"，
 * 每一项的用途见 INIT_ENTRY_SPECS（与 04-ui.md §2 第 5 步逐项对应）。
 */
export const PROJECT_LAYOUT = {
  manifest: MANIFEST_FILE,
  stateDir: '.noryth',
  database: '.noryth/project.db',
  chapters: 'chapters',
  skills: 'skills',
  gitignore: '.gitignore',
  gitDir: '.git',
} as const;

export interface InitEntrySpec {
  path: string;
  kind: 'file' | 'dir';
  purpose: string;
}

/**
 * 7 项骨架的唯一权威枚举。
 * 前 4 项由 04-ui.md §2 第 5 步点名；后 3 项来自数据与配置设计：
 * 数据库是 SQLite 权威，skills/ 是项目级 skill 目录（04 §9.3），
 * .git/ 是首次提交与检查点绑定的载体（P0 门禁 6）。
 */
export const INIT_ENTRY_SPECS: readonly InitEntrySpec[] = [
  { path: PROJECT_LAYOUT.manifest, kind: 'file', purpose: '项目清单：id / 名称 / schema 版本 / 分支指针 / 设置差异' },
  { path: PROJECT_LAYOUT.stateDir, kind: 'dir', purpose: '项目状态目录：数据库、日志、发布状态' },
  { path: PROJECT_LAYOUT.database, kind: 'file', purpose: 'SQLite 权威库：26 张表，Markdown 只是镜像' },
  { path: PROJECT_LAYOUT.chapters, kind: 'dir', purpose: '正文章节目录：一章一个 Markdown 文件' },
  { path: PROJECT_LAYOUT.skills, kind: 'dir', purpose: '项目级 skill 目录：与全局同名时项目级覆盖' },
  { path: PROJECT_LAYOUT.gitignore, kind: 'file', purpose: '排除运行时数据库与日志，避免二进制进 Git' },
  { path: PROJECT_LAYOUT.gitDir, kind: 'dir', purpose: '本地版本库：首次提交携带 Noryth-Checkpoint' },
];

export const INIT_ENTRIES: readonly string[] = INIT_ENTRY_SPECS.map((entry) => entry.path);

/**
 * Git 提交里的完整领域状态导出（01 §7）。
 * 它**不是** init 骨架的第 8 项：只在场景关闭时写入，随提交进 Git，
 * 用于 `restore --from-commit` 在丢库/换机器后恢复 8 个状态域。
 */
export const STATE_PACKAGE_PATH = '.noryth/state.json.zst';
export const STATE_PACKAGE_FORMAT = 'noryth-state';
export const STATE_PACKAGE_VERSION = 1;

/** .noryth/ 里的运行时数据库与日志不进 Git；.noryth/state.json.zst 会进（01 §7）。 */
export const PROJECT_GITIGNORE = [
  '# Noryth 运行时状态：数据库与日志不进 Git（01-architecture.md §7）',
  '.noryth/*.db',
  '.noryth/*.db-wal',
  '.noryth/*.db-shm',
  '.noryth/logs/',
  '',
].join('\n');
