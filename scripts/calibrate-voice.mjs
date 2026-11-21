import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 声音阈值校准（PHASE-19 §5.2 / M2-1）。
 *
 *   node scripts/calibrate-voice.mjs            # 校准并写 calibration-result.json
 *   node scripts/calibrate-voice.mjs --check    # 只打印，不写文件
 *
 * 语料 `tests/fixtures/voice/zh-corpus.json` 是合成中文夹具：同一角色的拍分两半
 * 作为「同人对照」，同场不同角色作为「异人对照」。指标函数直接复用
 * `src/main/voice/metrics.ts`（Node 26 的类型剥离），保证脚本与产品口径一致。
 *
 * 判定：threshold = argmax(TPR − FPR)，并要求 同人误报 ≤5%、异人检出 ≥80%；
 * 结果 clamp 到 [0.12, 0.30]（低于 0.12 会把正常的短句角色对判成同一个人，
 * 高于 0.30 会让大量真实区分被忽略）。脚本不修改阈值常量，只产出结果文件；
 * `src/shared/domain/voice.ts` 与 `tests/unit/voice/threshold.test.ts` 守住一致性。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CORPUS_PATH = join(ROOT, 'tests', 'fixtures', 'voice', 'zh-corpus.json')
const RESULT_PATH = join(ROOT, 'tests', 'fixtures', 'voice', 'calibration-result.json')
const CHECK_ONLY = process.argv.includes('--check')

const { computeCharacterMetrics, pairDistinctness } = await import(
  new URL('../src/main/voice/metrics.ts', import.meta.url)
)

const raw = readFileSync(CORPUS_PATH)
const corpusHash = createHash('sha256').update(raw).digest('hex')
const corpus = JSON.parse(raw.toString('utf8'))
if (!Array.isArray(corpus.scenes) || corpus.scenes.length === 0) {
  throw new Error('语料没有 scenes')
}

function toInput(character, beats) {
  return {
    characterId: character.id,
    name: character.name,
    catchphrase: character.catchphrase,
    beats: beats.map((body, index) => ({ ord: index + 1, body }))
  }
}

const sameScores = []
const differentScores = []
let characterInstances = 0

for (const scene of corpus.scenes) {
  const profiles = scene.characters.map((character) => {
    const beats = character.beats
    if (!Array.isArray(beats) || beats.length < 4) throw new Error(`${scene.id}/${character.id} 拍数不足`)
    const half = Math.floor(beats.length / 2)
    const firstHalf = computeCharacterMetrics(toInput(character, beats.slice(0, half)))
    const secondHalf = computeCharacterMetrics(toInput(character, beats.slice(half)))
    characterInstances += 1
    const same = pairDistinctness(firstHalf, secondHalf)
    sameScores.push({ scene: scene.id, character: character.id, score: same.score })
    return { character, full: computeCharacterMetrics(toInput(character, beats)) }
  })

  for (let left = 0; left < profiles.length; left += 1) {
    for (let right = left + 1; right < profiles.length; right += 1) {
      const pair = pairDistinctness(profiles[left].full, profiles[right].full)
      differentScores.push({
        scene: scene.id,
        a: profiles[left].character.id,
        b: profiles[right].character.id,
        score: pair.score
      })
    }
  }
}

function evaluate(threshold) {
  const tpr = differentScores.filter((item) => item.score >= threshold).length / differentScores.length
  const fpr = sameScores.filter((item) => item.score >= threshold).length / sameScores.length
  return { tpr, fpr, objective: tpr - fpr }
}

const candidates = [...new Set([...sameScores, ...differentScores].map((item) => item.score))].sort(
  (left, right) => left - right
)
let best = null
for (const threshold of candidates) {
  const metrics = evaluate(threshold)
  if (best === null || metrics.objective > best.objective + 1e-9) {
    best = { threshold, ...metrics }
  } else if (Math.abs(metrics.objective - best.objective) <= 1e-9) {
    // 平台期取中位数：避免把阈值贴在同一人的最高分上（换语料就翻车）。
    best = { ...best, plateauHigh: threshold }
  }
}

if (best === null) throw new Error('没有可评估的阈值')
const plateauLow = best.threshold
const plateauHigh = best.plateauHigh ?? best.threshold
const rawThreshold = (plateauLow + plateauHigh) / 2
const clamped = Math.min(0.3, Math.max(0.12, rawThreshold))
const distinctnessMin = Math.round(clamped * 1000) / 1000
const final = evaluate(distinctnessMin)

const sameAlarm = sameScores.filter((item) => item.score >= distinctnessMin)
const missed = differentScores.filter((item) => item.score < distinctnessMin)
const result = {
  version: corpus.version,
  corpus: 'tests/fixtures/voice/zh-corpus.json',
  corpusHash,
  calibratedAt: corpus.created_at,
  scenes: corpus.scenes.length,
  characterInstances,
  samePairs: sameScores.length,
  differentPairs: differentScores.length,
  threshold: distinctnessMin,
  rawThreshold: Math.round(rawThreshold * 1000) / 1000,
  plateau: [Math.round(plateauLow * 1000) / 1000, Math.round(plateauHigh * 1000) / 1000],
  sameCharacterFalseAlarm: Math.round(final.fpr * 10000) / 10000,
  differentCharacterDetection: Math.round(final.tpr * 10000) / 10000,
  sameScores: {
    min: Math.min(...sameScores.map((item) => item.score)),
    max: Math.max(...sameScores.map((item) => item.score)),
    median: median(sameScores.map((item) => item.score))
  },
  differentScores: {
    min: Math.min(...differentScores.map((item) => item.score)),
    max: Math.max(...differentScores.map((item) => item.score)),
    median: median(differentScores.map((item) => item.score))
  },
  passed: final.fpr <= 0.05 && final.tpr >= 0.8,
  notes: [
    '语料是合成夹具而不是出版小说：阈值是起点，换语料必须升版本并重算历史 voice_metric。',
    `同人误报 ${sameAlarm.length}/${sameScores.length}；异人漏检 ${missed.length}/${differentScores.length}。`
  ]
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

console.log(JSON.stringify(result, null, 2))
if (!CHECK_ONLY) {
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(`\nwrote ${RESULT_PATH}`)
}
if (!result.passed) {
  console.error('校准未达标：同人误报 ≤5% 且异人检出 ≥80% 才算通过')
  process.exitCode = 1
}
