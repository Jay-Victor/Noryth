import { describe, expect, it } from 'vitest'
import { hashManifestRows, normalizeBody, type ManifestRow } from '../../../src/main/db/hash'

const rows: ManifestRow[] = [
  { sceneId: 'scn_a', sceneOrd: 1, beatOrd: 1, speakerType: 'narrator', speakerId: 'narrator', body: '她把茶盏往他那边推了推。' },
  { sceneId: 'scn_a', sceneOrd: 1, beatOrd: 2, speakerType: 'character', speakerId: 'chr_lin', body: '「你见过那只匣子吗？」' },
  { sceneId: 'scn_b', sceneOrd: 2, beatOrd: 1, speakerType: 'narrator', speakerId: 'narrator', body: '雨停了。' }
]

/** 固定 fixture：规范形式一旦漂移，这个 hash 必须变化（PHASE-02 §7 风险表）。 */
const FIXTURE_HASH = '179840b99995cf441c7cbca29a7916fa53c524f56fc66911002f216f3ace05fc'

describe('hashManifestRows', () => {
  it('同一清单两次计算结果一致，且等于固定 fixture', () => {
    expect(hashManifestRows(rows)).toBe(hashManifestRows(rows))
    expect(hashManifestRows(rows)).toBe(FIXTURE_HASH)
    expect(hashManifestRows(rows)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('同一场景内拍顺序变化会改变 hash', () => {
    const swapped = [rows[1]!, rows[0]!, rows[2]!]
    expect(hashManifestRows(swapped)).not.toBe(FIXTURE_HASH)
  })

  it('场景顺序变化会改变 hash（scene 头防止同文碰撞）', () => {
    const sameBody = [
      { ...rows[0]!, sceneId: 'scn_a', body: '同一段正文' },
      { ...rows[2]!, sceneId: 'scn_b', body: '同一段正文' }
    ]
    const reversed = [sameBody[1]!, sameBody[0]!]
    expect(hashManifestRows(sameBody)).not.toBe(hashManifestRows(reversed))
  })

  it('CRLF 归一化后 hash 不变', () => {
    const crlf = rows.map((row) => ({ ...row, body: row.body.replace(/\n/g, '\r\n') }))
    expect(normalizeBody('a\r\nb')).toBe('a\nb')
    expect(hashManifestRows(crlf)).toBe(FIXTURE_HASH)
  })
})
