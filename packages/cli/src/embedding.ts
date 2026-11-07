/**
 * 嵌入 provider 的 CLI 装配。
 *
 * - 默认本地 hash provider：确定性、零网络，跑通"词面可解集"。
 * - 远程 OpenAI 兼容 /embeddings：只有显式设置 NORYTH_EMBED_URL 才启用。
 *   维度必须等于 memory.vector_dim（512），否则拒绝——把 1536 维截成 512 是造假。
 *   密钥只从环境读，不写进项目文件（01 §9：项目文件、日志、导出包均不含密钥）。
 */
import { HashEmbeddingProvider, PARAMS, type EmbeddingProvider } from '@noryth/core';
import { ModelError } from '@noryth/store';

class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'http';
  readonly dim = PARAMS['memory.vector_dim'];

  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey.length > 0 ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelError(`嵌入服务返回 ${response.status}：${await response.text()}`);
      }
      const body = (await response.json()) as {
        data?: { embedding?: number[] }[];
      };
      const rows = body.data ?? [];
      if (rows.length !== texts.length) {
        throw new ModelError(`嵌入服务返回 ${rows.length} 条，期望 ${texts.length} 条`);
      }
      return rows.map((row, i) => {
        const vector = row.embedding;
        if (!Array.isArray(vector)) throw new ModelError(`第 ${i} 条嵌入缺失 embedding`);
        if (vector.length !== this.dim) {
          throw new ModelError(
            `嵌入维度 ${vector.length} 与 memory.vector_dim=${this.dim} 不一致：换 provider 需要先迁移向量`,
          );
        }
        return Float32Array.from(vector);
      });
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError(
        `嵌入请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const url = process.env.NORYTH_EMBED_URL?.trim();
  if (url) {
    return new HttpEmbeddingProvider(
      url,
      process.env.NORYTH_EMBED_MODEL?.trim() || 'text-embedding-3-small',
      process.env.NORYTH_EMBED_KEY ?? '',
    );
  }
  return new HashEmbeddingProvider();
}
