/** main ⇄ utilityProcess 的嵌入协议（DEV-PLAN §10.5）。双向都是纯 JSON。 */

export type EmbedKindWire = 'query' | 'doc'

export interface EmbedWorkerRequest {
  id: string
  method: 'embed' | 'warmup'
  texts: string[]
  kind: EmbedKindWire
}

export type EmbedFailureCode = 'model_missing' | 'oom' | 'timeout' | 'internal'

export type EmbedWorkerResponse =
  | { id: string; ok: true; vectors: number[][]; dim: number; model: string }
  | { id: string; ok: false; code: EmbedFailureCode; message?: string }
