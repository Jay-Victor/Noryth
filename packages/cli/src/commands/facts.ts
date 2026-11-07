/** P2 CLI：事实 / 设定锁 / 认知。只做参数、输出与退出码，业务在 store。 */
import {
  CommandBus,
  getActiveBranch,
  listEntities,
  listFacts,
  listLocks,
  listPredicates,
  type EntityListItem,
  type FactListItem,
  type LockListItem,
} from '@noryth/store';
import { openProject, openProjectForWrite } from './project.js';

export function parseObjectArg(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw; // 允许 `fact assert 林砚 住在 客栈`
  }
}

export interface EntityAddOptions {
  dir?: string;
  kind: 'character' | 'place' | 'item' | 'org' | 'concept';
  name: string;
  aliases?: string[];
  card?: Record<string, unknown>;
  status?: 'active' | 'dead' | 'missing' | 'destroyed' | 'unknown';
}

export function runEntityAdd(options: EntityAddOptions): {
  entityId: string;
  name: string;
  kind: string;
  action: string;
} {
  const opened = openProjectForWrite(options.dir);
  try {
    const bus = new CommandBus(opened.db);
    return bus.submit<{ entityId: string; name: string; kind: string; action: string }>(
      { type: 'user', id: 'author' },
      {
        kind: 'entity.add',
        idempotencyKey: `cli-entity-${options.kind}-${options.name}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: {
          kind: options.kind,
          name: options.name,
          ...(options.aliases !== undefined ? { aliases: options.aliases } : {}),
          ...(options.card !== undefined ? { card: options.card } : {}),
          ...(options.status !== undefined ? { status: options.status } : {}),
        },
      },
    ).result;
  } finally {
    opened.close();
  }
}

export function runEntityList(
  dir: string | undefined,
  options: { kind?: string; name?: string } = {},
): EntityListItem[] {
  const opened = openProject(dir);
  try {
    return listEntities(opened.db, options);
  } finally {
    opened.close();
  }
}

export function runPredicateDefine(
  dir: string | undefined,
  options: { predicate: string; cardinality: 'single' | 'multi'; description?: string },
): { predicate: string; cardinality: string } {
  const opened = openProjectForWrite(dir);
  try {
    const bus = new CommandBus(opened.db);
    return bus.submit<{ predicate: string; cardinality: string }>(
      { type: 'user', id: 'author' },
      {
        kind: 'predicate.define',
        idempotencyKey: `cli-predicate-${options.predicate}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: {
          predicate: options.predicate,
          cardinality: options.cardinality,
          ...(options.description !== undefined ? { description: options.description } : {}),
        },
      },
    ).result;
  } finally {
    opened.close();
  }
}

export interface FactAssertOptions {
  dir?: string;
  subject: string;
  predicate: string;
  object: unknown;
  truth?: -1 | 0 | 1;
  secrecy?: number;
  at?: string;
}

export function runFactAssert(options: FactAssertOptions): {
  factId: string;
  slotKey: string;
  action: string;
  supersededId: string | null;
  truth: number;
} {
  const opened = openProjectForWrite(options.dir);
  try {
    const bus = new CommandBus(opened.db);
    const result = bus.submit<{
      factId: string;
      slotKey: string;
      action: string;
      supersededId: string | null;
      truth: number;
    }>(
      { type: 'user', id: 'author' },
      {
        kind: 'fact.assert',
        idempotencyKey: `cli-fact-${options.subject}-${options.predicate}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: {
          subject: options.subject,
          predicate: options.predicate,
          object: options.object,
          ...(options.truth !== undefined ? { truth: options.truth } : {}),
          ...(options.secrecy !== undefined ? { secrecy: options.secrecy } : {}),
          ...(options.at !== undefined ? { validFrom: options.at } : {}),
        },
      },
    );
    return result.result;
  } finally {
    opened.close();
  }
}

export function runFactList(
  dir: string | undefined,
  options: { subject?: string; predicate?: string; all?: boolean } = {},
): FactListItem[] {
  const opened = openProject(dir);
  try {
    return listFacts(opened.db, {
      subject: options.subject,
      predicate: options.predicate,
      includeHistorical: options.all,
    });
  } finally {
    opened.close();
  }
}

export function runFactClose(
  dir: string | undefined,
  options: { subject: string; predicate: string; object?: unknown; at?: string },
): { closed: number; ids: string[]; at: string } {
  const opened = openProjectForWrite(dir);
  try {
    const bus = new CommandBus(opened.db);
    return bus.submit<{ closed: number; ids: string[]; at: string }>(
      { type: 'user', id: 'author' },
      {
        kind: 'fact.close',
        idempotencyKey: `cli-fact-close-${options.subject}-${options.predicate}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: {
          subject: options.subject,
          predicate: options.predicate,
          ...(options.object !== undefined ? { object: options.object } : {}),
          ...(options.at !== undefined ? { at: options.at } : {}),
        },
      },
    ).result;
  } finally {
    opened.close();
  }
}

export function runPredicateList(dir: string | undefined): ReturnType<typeof listPredicates> {
  const opened = openProject(dir);
  try {
    return listPredicates(opened.db);
  } finally {
    opened.close();
  }
}

export interface LockSetOptions {
  dir?: string;
  scope: 'fact' | 'relation' | 'entity' | 'world' | 'timeline';
  slotKey?: string;
  subject?: string;
  predicate?: string;
  object?: unknown;
  fromId?: string;
  toId?: string;
  axis?: 'trust' | 'affection' | 'fear' | 'debt' | 'power';
  reason: string;
}

export function runLockSet(options: LockSetOptions): {
  scope: string;
  slotKey: string;
  lockedBy: string;
} {
  const opened = openProjectForWrite(options.dir);
  try {
    const bus = new CommandBus(opened.db);
    return bus.submit<{ scope: string; slotKey: string; lockedBy: string }>(
      { type: 'user', id: 'author' },
      {
        kind: 'lock.set',
        idempotencyKey: `cli-lock-${options.scope}-${options.slotKey ?? options.subject ?? ''}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: {
          scope: options.scope,
          ...(options.slotKey !== undefined ? { slotKey: options.slotKey } : {}),
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.predicate !== undefined ? { predicate: options.predicate } : {}),
          ...(options.object !== undefined ? { object: options.object } : {}),
          ...(options.fromId !== undefined ? { fromId: options.fromId } : {}),
          ...(options.toId !== undefined ? { toId: options.toId } : {}),
          ...(options.axis !== undefined ? { axis: options.axis } : {}),
          reason: options.reason,
        },
      },
    ).result;
  } finally {
    opened.close();
  }
}

export function runLockList(dir: string | undefined): LockListItem[] {
  const opened = openProject(dir);
  try {
    return listLocks(opened.db);
  } finally {
    opened.close();
  }
}

export function runLockRelease(
  dir: string | undefined,
  options: Omit<LockSetOptions, 'reason'>,
): { scope: string; slotKey: string; released: true } {
  const opened = openProjectForWrite(dir);
  try {
    const bus = new CommandBus(opened.db);
    return bus.submit<{ scope: string; slotKey: string; released: true }>(
      { type: 'user', id: 'author' },
      {
        kind: 'lock.release',
        idempotencyKey: `cli-unlock-${options.scope}-${options.slotKey ?? options.subject ?? ''}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: {
          scope: options.scope,
          ...(options.slotKey !== undefined ? { slotKey: options.slotKey } : {}),
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.predicate !== undefined ? { predicate: options.predicate } : {}),
          ...(options.object !== undefined ? { object: options.object } : {}),
          ...(options.fromId !== undefined ? { fromId: options.fromId } : {}),
          ...(options.toId !== undefined ? { toId: options.toId } : {}),
          ...(options.axis !== undefined ? { axis: options.axis } : {}),
        },
      },
    ).result;
  } finally {
    opened.close();
  }
}

export function runKnowGrant(
  dir: string | undefined,
  options: {
    characterId: string;
    factId: string;
    attitude?: 'knows' | 'believes' | 'suspects' | 'doubts' | 'falsely_believes';
    certainty?: number;
    percept?: 'witness' | 'told' | 'reported' | 'inferred' | 'discovered';
  },
): { characterId: string; factId: string; attitude: string; created: boolean } {
  const opened = openProjectForWrite(dir);
  try {
    const bus = new CommandBus(opened.db);
    return bus.submit<{
      characterId: string;
      factId: string;
      attitude: string;
      created: boolean;
    }>(
      { type: 'user', id: 'author' },
      {
        kind: 'cognition.grant',
        idempotencyKey: `cli-know-${options.characterId}-${options.factId}-${getActiveBranch(opened.db)!.headSeq}`,
        payload: {
          characterId: options.characterId,
          factId: options.factId,
          ...(options.attitude !== undefined ? { attitude: options.attitude } : {}),
          ...(options.certainty !== undefined ? { certainty: options.certainty } : {}),
          ...(options.percept !== undefined ? { percept: options.percept } : {}),
        },
      },
    ).result;
  } finally {
    opened.close();
  }
}
