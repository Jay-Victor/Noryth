import { describe, expect, it } from 'vitest'
import {
  checkEvidence,
  normalizeEvidenceText,
  quoteInBody
} from '../../../src/main/memory/evidence'

/**
 * H1 证据校验（DEV-PLAN §10.1）：quote 归一化后必须是来源拍正文的连续子串。
 * 只做等价字符归一（NFKC / 空白 / 零宽），不做改写、同义替换、分词重组。
 */

const BODY = '她把茶盏往他那边推了推，声音压得很低：「账本在祠堂。」'

describe('evidence', () => {
  it('归一化：NFKC、全角空格、零宽字符、行尾空白', () => {
    expect(normalizeEvidenceText('　账本　在祠堂　')).toBe('账本 在祠堂')
    expect(normalizeEvidenceText('账本\u200b在祠堂')).toBe('账本在祠堂')
    expect(normalizeEvidenceText('甲\r\n乙  ')).toBe('甲\n乙')
  })

  it('连续子串命中；改写/拼接不命中', () => {
    expect(quoteInBody('「账本在祠堂。」', BODY)).toBe(true)
    expect(quoteInBody('账本\u200b在祠堂', BODY)).toBe(true)
    expect(quoteInBody('账本藏在祠堂', BODY)).toBe(false)
    expect(quoteInBody('账本在祠堂」她把茶盏', BODY)).toBe(false)
  })

  it('缺拍 / 缺 quote / 拍不在定稿清单 / 不是子串 各自返回明确原因', () => {
    const bodies = new Map([['bt_1', BODY]])
    expect(checkEvidence({ beatId: null, quote: '账本', bodies }).reason).toBe('missing_beat')
    expect(checkEvidence({ beatId: 'bt_1', quote: '   ', bodies }).reason).toBe('missing_quote')
    expect(checkEvidence({ beatId: 'bt_9', quote: '账本', bodies }).reason).toBe('beat_not_in_revision')
    expect(checkEvidence({ beatId: 'bt_1', quote: '账本藏在祠堂', bodies }).reason).toBe('quote_not_substring')
    expect(checkEvidence({ beatId: 'bt_1', quote: '账本在祠堂', bodies })).toEqual({
      ok: true,
      reason: null,
      quote: '账本在祠堂'
    })
  })
})
