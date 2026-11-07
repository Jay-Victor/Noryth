import { NorythError, type ErrorCode } from '@noryth/store';

export interface Warning {
  code: string;
  message: string;
}

export interface Meta {
  seq?: number;
  branch?: string;
  ms: number;
}

export interface Envelope<T> {
  ok: boolean;
  data?: T;
  warnings?: Warning[];
  error?: { code: string; name?: string; message: string };
  meta: Meta;
}

const EXIT_CODE: Record<ErrorCode, number> = {
  usage: 2,
  constraint: 3,
  model: 4,
  human: 5,
  budget: 6,
  io: 1,
  schema: 1,
};

export function exitCodeFor(error: unknown): number {
  if (error instanceof NorythError) return EXIT_CODE[error.code];
  return 1;
}

/** 失败也返回合法信封 + 非零退出码：脚本不需要判两套格式（04-ui.md §10.4）。 */
export function failureEnvelope(error: unknown, ms: number): Envelope<never> {
  if (error instanceof NorythError) {
    return {
      ok: false,
      error: {
        code: error.code,
        ...(error.constraint ? { name: error.constraint } : {}),
        message: error.message,
      },
      meta: { ms },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'io', message }, meta: { ms } };
}

export function successEnvelope<T>(
  data: T,
  warnings: Warning[],
  meta: Meta,
): Envelope<T> {
  return {
    ok: true,
    data,
    ...(warnings.length > 0 ? { warnings } : {}),
    meta,
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
