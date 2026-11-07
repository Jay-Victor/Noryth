/**
 * 离线模型：`noryth run --offline` 的 provider。
 *
 * 04-ui.md §10.2 要求"用 stub provider 读 fixtures/beats/*.json 跑完整流程"，
 * 黄金场景回归与 P1 门禁都走这条路径。它不是占位实现：选择函数是确定性的
 * hash(seed, seq, agentName)，回退后同一拍必须取到同一句（门禁 9）。
 *
 * 真正的供应商适配在 P3 接入；这里只保证"没有网络也能验完整链路"。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { h01, type ModelPort, type ModelRequest } from '@noryth/core';
import { ModelError } from '@noryth/store';

interface FixtureLine {
  line?: string;
  action?: string;
  thought?: string;
  intent?: string;
  addressed_to?: string[];
  asserts?: { subject: string; predicate: string; object: unknown; claims_true?: boolean }[];
  reveals?: string[];
  emotion?: string;
  paragraphs?: string[];
  focus?: string;
}

interface Fixture {
  name: string;
  kind: 'character' | 'narrator';
  lines: FixtureLine[];
  closings?: FixtureLine[];
}

const DEFAULT_DIR = path.join('fixtures', 'beats');

function walkForFixtures(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, DEFAULT_DIR);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function fixtureDir(): string {
  const fromEnv = process.env.NORYTH_FIXTURES;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new ModelError(`NORYTH_FIXTURES 指向的目录不存在：${fromEnv}`);
    }
    return fromEnv;
  }
  const found = walkForFixtures(process.cwd()) ?? (typeof __dirname !== 'undefined' ? walkForFixtures(__dirname) : null);
  if (!found) {
    throw new ModelError('找不到 fixtures/beats（设置 NORYTH_FIXTURES 或从仓库根运行）');
  }
  return found;
}

export class OfflineModel implements ModelPort {
  readonly name = 'offline';

  constructor(private readonly fixtures: Map<string, Fixture>) {}

  static load(dir = fixtureDir()): OfflineModel {
    const fixtures = new Map<string, Fixture>();
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Fixture;
      if (!parsed.name || !Array.isArray(parsed.lines) || parsed.lines.length === 0) {
        throw new ModelError(`fixture 格式不对（需要 name + lines）：${file}`);
      }
      fixtures.set(parsed.name, parsed);
    }
    if (fixtures.size === 0) throw new ModelError(`fixtures 目录为空：${dir}`);
    return new OfflineModel(fixtures);
  }

  async generate(request: ModelRequest): Promise<string> {
    const fixture = this.fixtures.get(request.agentName);
    if (!fixture) {
      throw new ModelError(
        `离线模式没有「${request.agentName}」的 fixture（可用：${[...this.fixtures.keys()].join('、')}）`,
      );
    }
    const pool =
      request.intent === 'closing' && fixture.closings && fixture.closings.length > 0
        ? fixture.closings
        : fixture.lines;
    const index = Math.min(
      pool.length - 1,
      Math.floor(h01(request.seed, request.seq, request.agentName, request.intent ?? 'beat') * pool.length),
    );
    const chosen = pool[index]!;
    if (fixture.kind === 'narrator') {
      return JSON.stringify({
        paragraphs: chosen.paragraphs ?? [chosen.line ?? ''],
        focus: chosen.focus ?? '环境',
      });
    }
    return JSON.stringify({
      line: chosen.line ?? '',
      action: chosen.action ?? '',
      thought: chosen.thought ?? '',
      intent: chosen.intent ?? '',
      addressed_to: chosen.addressed_to ?? [],
      asserts: chosen.asserts ?? [],
      reveals: chosen.reveals ?? [],
      emotion: chosen.emotion ?? 'calm',
    });
  }
}
