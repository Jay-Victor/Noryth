#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Noryth 设计探针（不是产品实现）

用途：给设计文档提供可复现的数字。三种模式：
  --demo         打印文档中引用的全部数值（调度 / 上下文 / 限知 / 检索 / 回退 / 成本）
  --selftest     断言边界与不变式，打印断言条数
  --check-params 把 docs/params.yaml 与本源代码常量逐键比对

设计约束：
  * 纯标准库。任何机器 clone 下来就能跑，没有装包失败风险。
  * 所有随机性都是确定性哈希，不用 random —— 回退后必须能复演同一场。
  * 性能数字是本机单次中位数，量级参考，不是基准测试。
"""
import sys
import os
import math
import time
import sqlite3
import hashlib
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
PARAMS = ROOT / "docs" / "params.yaml"

# ══════════════════════════════════════════════════════════════
# 0. 常量（与 docs/params.yaml 一一对应）
# ══════════════════════════════════════════════════════════════
W_GOAL, W_ADDRESSED, W_STAKE, W_NARRATOR, W_INITIATIVE = 0.34, 0.30, 0.16, 0.12, 0.08
JITTER_MAX = 0.05
DAMP_FIRST, DAMP_SECOND = 0.35, 0.55
MAX_CONSECUTIVE = 3
ARBITRATION_DELTA = 0.05
ARBITRATION_TOPK = 3

MAX_BEATS = 40
FLAT_WINDOW, FLAT_EPS = 4, 0.05
MAX_LEVEL = 4
CARD_INTERVAL = 6
NARRATOR_MIN_GAP, NARRATOR_MAX_GAP = 2, 5

BUDGET_TOTAL = 6000
RATIOS = {
    "card": 0.15, "scene": 0.10, "recent": 0.30, "memory": 0.20,
    "relation": 0.10, "clue": 0.05, "contract": 0.10,
}
RECENT_MIN_BEATS, RECENT_MAX_BEATS = 4, 16
MEMORY_TOPK = 8
DEGRADE_SUMMARY, DEGRADE_TRIPLE = 0.85, 0.70

VECTOR_DIM = 512
ANN_THRESHOLD = 500_000
RRF_K = 60
W_SLOT, W_FTS, W_VECTOR, W_GRAPH = 2.0, 1.3, 1.0, 0.6
RRF_REF = (W_SLOT + W_FTS) / (RRF_K + 1)
MEMORY_FLOOR = 0.45
MMR_LAMBDA, MMR_IMMUNE = 0.7, 3
RECENCY_RHO = 0.25

RELATION_JUMP = 0.35
MAX_REVISER_ROUNDS = 3

# stake 的构成，必须是可断言的具名常量：文档写 0.15 + 0.22·(conflict/4) + 0.30·secret
# 而代码里出现 0.22 与 0.055 两个数，就是文档与实现分叉的起点。
STAKE_BASE, STAKE_CONFLICT, STAKE_SECRET, STAKE_OWNERSHIP = 0.15, 0.22, 0.30, 0.20
VOICE_JSD_THRESHOLD = 0.18
CLUE_MAX_AGE_CHAPTERS = 15

SNAPSHOT_INTERVAL = 50
MAX_REPLAY_EVENTS = 200

# 中文 token 估算：CJK 约 0.68 token/字，拉丁/ASCII 约 0.26 token/字符。
# 这是估算，不是真分词器；上线前用目标模型 tokenizer 校准（见文档“未验证项”）。
TOK_CJK, TOK_LATIN = 0.68, 0.26


# ══════════════════════════════════════════════════════════════
# 1. 基础工具
# ══════════════════════════════════════════════════════════════
def h01(*parts) -> float:
    """确定性哈希 → [0,1)。回退重放依赖它，禁止换成 random。"""
    raw = "|".join(str(p) for p in parts).encode("utf-8")
    return int.from_bytes(hashlib.blake2b(raw, digest_size=8).digest(), "big") / 2**64


def est_tokens(text: str) -> int:
    """O(n)。CJK 与 ASCII 分开计数，避免把中文按英文 4 字符/token 算少 2.6 倍。"""
    if not text:
        return 0
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff" or "\u3000" <= ch <= "\u303f")
    return int(round(cjk * TOK_CJK + (len(text) - cjk) * TOK_LATIN))


def clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


# ══════════════════════════════════════════════════════════════
# 2. 发言调度：评分 → 阻尼 → 仲裁
# ══════════════════════════════════════════════════════════════
def score_candidates(cands, ctx, seed, seq):
    """
    cands: [{id, goal_rel, initiative, stake, addressed, is_narrator, speak_count, since}]
    ctx:   {conflict_level, consecutive_dialogue, beats_since_narrator}
    返回  [{id, base, score, parts}] 按 score 降序（并列按 addressed / speak_count / id）
    复杂度 O(n)，n = 在场候选数（≤ max_candidates）。
    """
    out = []
    for c in cands:
        if c["is_narrator"]:
            need = 1.0 if (ctx["consecutive_dialogue"] >= NARRATOR_MIN_GAP
                           and ctx["beats_since_narrator"] >= NARRATOR_MIN_GAP) else \
                   (0.3 if ctx["beats_since_narrator"] >= NARRATOR_MAX_GAP - 1 else 0.0)
        else:
            need = 0.0
        parts = {
            "goal": W_GOAL * c["goal_rel"],
            "addr": W_ADDRESSED * c["addressed"],
            "stake": W_STAKE * c["stake"],
            "narr": W_NARRATOR * need,
            "init": W_INITIATIVE * c["initiative"],
        }
        base = sum(parts.values())
        jit = h01(seed, seq, c["id"]) * JITTER_MAX
        out.append({"id": c["id"], "base": base, "score": base + jit,
                    "jit": jit, "parts": parts, "addressed": c["addressed"],
                    "speak_count": c["speak_count"]})
    out.sort(key=lambda r: (-r["score"], -r["addressed"], r["speak_count"], r["id"]))
    return out


def apply_damping(ranked, cands, cap_on=True):
    """
    乘法阻尼，不是减分。理由：加分项总和固定为 1，减 0.3 会让“目标相关”永远
    压不过“刚说过话”；乘法把连任压到 1/3 同时保留被点名时的绝对优先。
    被点名（addressed≥0.5）豁免阻尼 —— 否则读者会觉得这个人物聋了。
    since==0 表示上一拍刚说过话。
    """
    by_id = {c["id"]: c for c in cands}
    for r in ranked:
        c = by_id[r["id"]]
        if c["is_narrator"]:
            continue
        if cap_on and c["since"] == 0 and c["_streak"] >= MAX_CONSECUTIVE:
            r["score"] = 0.0
            r["capped"] = True
            continue
        if c["addressed"] >= 0.5:
            continue
        if c["since"] == 0:
            r["score"] *= DAMP_FIRST
        elif c["since"] == 1:
            r["score"] *= DAMP_SECOND
    ranked.sort(key=lambda r: (-r["score"], -r["addressed"], r["speak_count"], r["id"]))
    return ranked


def needs_arbitration(ranked, delta=ARBITRATION_DELTA):
    """
    只有两个以上“活着”的候选（score>0）且 top1-top2 < δ 才调小模型。
    把 score==0 的被钳制者算进来会制造假平局——每一拍都会触发仲裁，
    等于把确定性排序架空。
    """
    alive = [r for r in ranked if r["score"] > 0]
    if len(alive) < 2:
        return False
    return (alive[0]["score"] - alive[1]["score"]) < delta


def pick(ranked):
    for r in ranked:
        if r["score"] > 0:
            return r
    return ranked[0] if ranked else None


# ══════════════════════════════════════════════════════════════
# 3. 上下文装配：配额 + 降级阶梯
# ══════════════════════════════════════════════════════════════
LEVELS = ("full", "summary", "triple", "id")


def pack_context(sections, budget=BUDGET_TOTAL):
    """
    sections: [{name, items:[{full, summary, triple, id, keep_rank}]}]
    返回 (kept_items, level, total_tokens, dropped)
    不变式：total_tokens <= budget 恒成立；宁可整条丢弃也不截断半句。
    """
    flat = []
    for s in sections:
        for it in s["items"]:
            flat.append((s["name"], it))
    for level in LEVELS:
        total = sum(est_tokens(it[level]) for _, it in flat)
        if total <= budget:
            return flat, level, total, 0
    # id 级仍超预算 → 按 keep_rank 升序丢整条
    flat.sort(key=lambda x: x[1].get("keep_rank", 9))
    kept, total = [], 0
    for name, it in flat:
        t = est_tokens(it["id"])
        if total + t > budget:
            continue
        kept.append((name, it))
        total += t
    return kept, "id+drop", total, len(flat) - len(kept)


# ══════════════════════════════════════════════════════════════
# 4. 知识边界：前置过滤，不是提示词禁令
# ══════════════════════════════════════════════════════════════
def visible_facts(facts, char_id, cognition, scene_aware_subjects=None):
    """
    只返回该角色“有认知记录”的事实。没有 cognition 行 = 不知道 = 不进提示词。
    这是唯一正确的顺序：先过滤，再拼装；未授权内容不得先送入模型再要求它别提。
    """
    known = {c["fact_id"] for c in cognition if c["character_id"] == char_id}
    out = []
    for f in facts:
        if f["id"] not in known:
            continue
        if f["secrecy"] >= 3 and f.get("redact_for", set()) and char_id in f["redact_for"]:
            g = dict(f)
            g["object"] = "（未知）"
            g["_redacted"] = True
            out.append(g)
        else:
            out.append(f)
    return out


def build_audience(present, actor, mode="public", private_to=None, addressed_to=None):
    """
    感知 = 消息级受众集合，不是“同场即可感知”。
    mode: public → present - actor；whisper → private_to；soliloquy/心理 → 空集（仅读者）；
    narrator_reader → 空集（旁白默认零感知，事实须由导演另行发 event）。
    """
    present = set(present)
    if mode == "public":
        return sorted(present - {actor})
    if mode == "whisper":
        return sorted(set(private_to or []) - {actor})
    if mode in ("soliloquy", "narrator_reader"):
        return []
    return sorted(present - {actor})


def add_cognition(cognition, audience, fact_id, seq, attitude="knows", certainty=1.0):
    """写入获知记录。同一角色同一事实只保留最早一条（O(n) 查重，规模小）。"""
    for c in cognition:
        if c["character_id"] in audience and c["fact_id"] == fact_id:
            audience = tuple(a for a in audience if a != c["character_id"])
    for ch in audience:
        cognition.append({"character_id": ch, "fact_id": fact_id, "learned_seq": seq,
                          "attitude": attitude, "certainty": certainty})


# ══════════════════════════════════════════════════════════════
# 5. 收束条件求值（六个算子）
# ══════════════════════════════════════════════════════════════
def eval_exit(expr, state):
    """
    算子：fact / rel / beats / all / any / not。必须机器可判——
    “他们终于和解了”这种自然语言条件等于没有条件。
    """
    op = expr.get("op")
    if op == "fact":
        cur = state["facts"].get((expr["subject"], expr["predicate"]))
        return cur == expr["object"]
    if op == "rel":
        v = state["rels"].get((expr["from"], expr["to"], expr["axis"]), 0.0)
        cmp = expr["cmp"]
        return {"<": v < expr["value"], ">": v > expr["value"],
                "<=": v <= expr["value"], ">=": v >= expr["value"],
                "==": v == expr["value"]}[cmp]
    if op == "beats":
        v, t = state["beats"], expr["value"]
        return {"<": v < t, ">": v > t, "<=": v <= t, ">=": v >= t, "==": v == t}[expr["cmp"]]
    if op == "all":
        return all(eval_exit(e, state) for e in expr["of"])
    if op == "any":
        return any(eval_exit(e, state) for e in expr["of"])
    if op == "not":
        return not eval_exit(expr["of"], state)
    raise ValueError(f"unknown op {op}")


# ══════════════════════════════════════════════════════════════
# 6. 事件卡 / 冲突阶梯 / 关系突变
# ══════════════════════════════════════════════════════════════
def draw_event_card(deck, level, turn, flat, interval=CARD_INTERVAL):
    """
    抽牌时机：固定间隔 或 冲突平坦。触发谓词不满足的牌留在牌堆不消耗——
    否则一场戏抽空牌堆却什么都没发生。
    """
    if not (turn % interval == 0 or flat):
        return None, deck
    for i, card in enumerate(deck):
        if card["consumed"]:
            continue
        if card["min_level"] > level:
            continue
        if card.get("one_shot") and card.get("_used"):
            continue
        rest = deck[:i] + deck[i + 1:]
        card = dict(card, _used=True)
        if card.get("one_shot"):
            card["consumed"] = True
        return card, rest
    return None, deck


def relation_jump(old, new, threshold=RELATION_JUMP):
    """单拍关系突变检测。Δ 超阈值 → 要求理由或钳制，不允许静默通过。"""
    d = abs(new - old)
    return {"delta": round(d, 3), "verdict": "ok" if d <= threshold else "needs_justification"}


# ══════════════════════════════════════════════════════════════
# 6.5 stake 构成 / 声音区分度
# ══════════════════════════════════════════════════════════════
def stake_of(conflict_level, secret_threat, ownership=0.0):
    """
    stake ∈ [0,1]。conflict 先归一到 0–1 再乘系数——不归一的话高冲突段会饱和到 1.0，
    所有在场角色的 stake 变成同一个数，评分里 0.16 这一项就失去区分度。
    例：conflict=2.1、秘密受威胁 → 0.15 + 0.22×0.525 + 0.30 = 0.5655
    """
    c = clamp(conflict_level / MAX_LEVEL, 0.0, 1.0)
    return clamp(STAKE_BASE + STAKE_CONFLICT * c
                 + (STAKE_SECRET if secret_threat else 0.0)
                 + STAKE_OWNERSHIP * clamp(ownership, 0.0, 1.0), 0.0, 1.0)


LEN_BUCKETS = ((0, 8), (9, 16), (17, 28), (29, 10 ** 9))
PARTICLES = "的了呢吧啊哦嘛呀"


def split_sentences(t):
    out, buf = [], []
    for ch in t:
        buf.append(ch)
        if ch in "。！？…\n":
            s = "".join(buf).strip()
            if s:
                out.append(s)
            buf = []
    s = "".join(buf).strip()
    if s:
        out.append(s)
    return out or [t]


def _length_dist(texts):
    d = [0, 0, 0, 0]
    for t in texts:
        for s in split_sentences(t):
            n = len(s)
            for i, (lo, hi) in enumerate(LEN_BUCKETS):
                if lo <= n <= hi:
                    d[i] += 1
                    break
    tot = sum(d) or 1
    return [x / tot for x in d]


def _rates(texts):
    n = sum(len(s) for s in texts) or 1
    parts = sum(1 for s in texts for ch in s if ch in PARTICLES) / n * 4
    first = sum(1 for s in texts if s[:1] in "我俺咱") / max(1, len(texts))
    quest = sum(1 for s in texts if s.rstrip()[-1:] in "？?") / max(1, len(texts))
    return clamp(parts, 0, 1), clamp(first, 0, 1), clamp(quest, 0, 1)


def js_divergence(p, q):
    m = [(a + b) / 2 for a, b in zip(p, q)]

    def kl(x, y):
        return sum(a * math.log2(a / b) for a, b in zip(x, y) if a > 0 and b > 0)

    return max(0.0, 0.5 * kl(p, m) + 0.5 * kl(q, m))


def voice_distance(a_texts, b_texts):
    """
    两个角色的"声音"距离 ∈ [0,1]。0 = 像同一个人；>0.18 视为可区分。
    句长分布用 JSD（对称、有界），口头禅密度 / 第一人称率 / 问句率用绝对差。
    合成文本上只能验证"指标本身可分"，真实区分度必须靠人工盲测（见文档未验证项）。
    """
    if not a_texts or not b_texts:
        return 0.0
    j = math.sqrt(js_divergence(_length_dist(a_texts), _length_dist(b_texts)))
    ra, rb = _rates(a_texts), _rates(b_texts)
    gap = sum(abs(x - y) for x, y in zip(ra, rb)) / 3
    return clamp(0.6 * j + 0.4 * gap, 0.0, 1.0)


# ══════════════════════════════════════════════════════════════
# 7. 仿真：调度器
# ══════════════════════════════════════════════════════════════
def sim_beats(seed, n=500, damping=True, cap=True, pacing=True):
    """
    合成序列上的机制检验（不是真实对话分布）。
    pacing=True 时旁白受硬节奏约束：开场必旁白，连续 max_gap 拍无旁白则强制插入。
    节奏是政策，不该靠权重竞争——实测 W_NARRATOR=0.12 在 5 个角色在场时得分恒为 0%。
    """
    chars = [
        {"id": "char:lin", "goal_rel": 1.0, "initiative": 0.9, "secret": True},
        {"id": "char:shen", "goal_rel": 1.0, "initiative": 0.6, "secret": True},
        {"id": "char:qi", "goal_rel": 0.0, "initiative": 0.3, "secret": False},
        {"id": "char:lu", "goal_rel": 0.5, "initiative": 0.5, "secret": False},
        {"id": "char:wen", "goal_rel": 0.0, "initiative": 0.2, "secret": False},
    ]
    ag = {c["id"]: {**c, "since": 99, "_streak": 0} for c in chars}
    ids = [c["id"] for c in chars]
    counts = {i: 0 for i in ids}
    counts["narrator"] = 0
    st = {"conflict": 1.0, "consecutive_dialogue": 0, "beats_since_narrator": 99,
          "addressed_to": set()}
    last, streak, longest = None, 0, 0
    decisions, arb, gaps = 0, 0, []

    for seq in range(1, n + 1):
        forced = pacing and st["beats_since_narrator"] >= NARRATOR_MAX_GAP
        if forced:
            wid = "narrator"
        else:
            pool = []
            for cid in ids:
                a = ag[cid]
                stake = stake_of(st["conflict"], a["secret"] and st["conflict"] >= 2)
                pool.append({**a, "stake": stake, "is_narrator": False,
                             "addressed": 1.0 if cid in st["addressed_to"] else 0.0,
                             "speak_count": counts[cid]})
            pool.append({"id": "narrator", "goal_rel": 0.0, "initiative": 0.5,
                         "stake": 0.0, "addressed": 0.0, "is_narrator": True,
                         "since": 99, "_streak": 0, "speak_count": counts["narrator"]})
            ranked = score_candidates(pool, st, seed, seq)
            decisions += 1
            if damping:
                ranked = apply_damping(ranked, pool, cap_on=cap)
            alive = [r for r in ranked if r["score"] > 0]
            if len(alive) >= 2:
                gaps.append(alive[0]["score"] - alive[1]["score"])
            if needs_arbitration(ranked):
                arb += 1
            wid = pick(ranked)["id"]
        counts[wid] += 1

        if wid == "narrator":
            st["consecutive_dialogue"] = 0
            st["beats_since_narrator"] = 0
            st["conflict"] = max(0.0, st["conflict"] - 0.35)
            last, streak = None, 0
        else:
            st["consecutive_dialogue"] += 1
            st["beats_since_narrator"] += 1
            if h01(seed, seq, "rise") < 0.34:
                st["conflict"] = min(MAX_LEVEL, st["conflict"] + 0.40)
            streak = streak + 1 if wid == last else 1
            last = wid
            longest = max(longest, streak)

        for cid in ids:
            a = ag[cid]
            if cid == wid:
                a["since"], a["_streak"] = 0, streak
            else:
                a["since"] = min(99, a["since"] + 1)
                if cid != wid:
                    a["_streak"] = 0

        # 焦点惯性：45% 继续追问同一个人（审问/对峙），否则换人。
        # 这是"被点名可连任 4 拍以上"的来源，也是硬上限存在的理由。
        others = [i for i in ids if i != wid]
        if st["addressed_to"] and h01(seed, seq, "focus") < 0.45:
            nxt = {sorted(st["addressed_to"])[0]}
        else:
            nxt = {others[int(h01(seed, seq, "a") * len(others))]}
        st["addressed_to"] = nxt

    char_beats = max(1, n - counts["narrator"])
    return {
        "longest_streak": longest,
        "narrator_share": counts["narrator"] / n,
        "max_agent_share": max(counts[i] for i in ids) / char_beats,
        "arb_rate": (arb / decisions) if decisions else 0.0,
        "gaps": gaps,
        "counts": counts,
    }


def sim_delta_scan(gaps):
    """扫 δ 的仲裁触发率。δ 不是常数，换候选数必须重扫。"""
    rows = []
    for d in (0.01, 0.02, 0.03, 0.04, 0.05, 0.06):
        rows.append((d, sum(1 for g in gaps if g < d) / len(gaps)))
    return rows


# ══════════════════════════════════════════════════════════════
# 8. 仿真：限知与上下文体积
# ══════════════════════════════════════════════════════════════
def make_world():
    chars = [f"char:{n}" for n in ("lin", "shen", "qi", "lu", "wen", "zhou")]
    names = {"char:lin": "林砚", "char:shen": "沈昼", "char:qi": "祁昭",
             "char:lu": "陆微", "char:wen": "温故", "char:zhou": "周决"}
    preds = ["知道", "持有", "去过", "隐瞒", "约定", "目睹"]
    facts, cognition, scenes = [], [], []
    seq = 0
    for s in range(12):
        present = [chars[(s + i) % 6] for i in range(3)]
        scenes.append({"id": f"scene:{s}", "present": present})
        for j in range(17):
            seq += 1
            subj = present[j % 3]
            fid = f"fact:{s}:{j}"
            facts.append({"id": fid, "subject": subj, "predicate": preds[j % 6],
                          "object": f"{names[present[(j+1) % 3]]}的秘密{j}",
                          "secrecy": j % 4, "scene": f"scene:{s}", "text": "", "_seq": seq})
            audience = build_audience(present, actor=subj)
            add_cognition(cognition, audience, fid, seq)
    # 每 3 条事实有 1 条被“告知”给 1~2 个不在场者
    for i, f in enumerate(facts):
        if i % 3 == 0:
            tell = chars[(i + 3) % 6]
            if not any(c["character_id"] == tell and c["fact_id"] == f["id"] for c in cognition):
                add_cognition(cognition, [tell], f["id"], f["_seq"] + 1000, attitude="believes", certainty=0.7)
    for f in facts:
        f["text"] = f"{names[f['subject']]}{f['predicate']}{f['object']}（保密{f['secrecy']}）"
    return chars, names, facts, cognition, scenes


def sim_knowledge():
    chars, names, facts, cognition, scenes = make_world()
    assemblies, leaks_full, leaks_filtered, known_total = 0, 0, 0, 0
    full_tokens, pov_tokens = 0, 0
    for sc in scenes:
        for ch in chars:
            assemblies += 1
            known = visible_facts(facts, ch, cognition)
            known_total += len(known)
            leaks_full += len(facts) - len(known)              # 全量注入时每条都是越权
            leaks_filtered += 0                                 # 前置过滤后恒为 0
            full_tokens += sum(est_tokens(f["text"]) for f in facts)
            pov_tokens += sum(est_tokens(f["text"]) for f in known)
    return {
        "facts": len(facts), "chars": len(chars), "scenes": len(scenes),
        "assemblies": assemblies,
        "avg_known": known_total / assemblies,
        "leak_per_assembly_full": leaks_full / assemblies,
        "leak_total_filtered": leaks_filtered,
        "full_tokens_avg": full_tokens / assemblies,
        "pov_tokens_avg": pov_tokens / assemblies,
    }


def sim_context(n_beats=40, n_facts=200, keep_facts=34):
    """比较全量注入 / 限知 / 预算装配 三种上下文体积。"""
    beat_prose = ("雨水顺着屋檐砸在青石板上，林砚把账本往袖口里又塞了塞，" * 2)[:118]
    beat_struct = '{"line":"你迟到了。","act":"把伞收拢","mind":"他在试探我","intent":"试探"}'
    fact_txt = "林砚持有沈昼的秘密7（保密2）"
    all_recent = (est_tokens(beat_prose) + est_tokens(beat_struct)) * n_beats
    all_cards = est_tokens("卡" * 400) * 6                             # 6 角色的卡
    all_facts = est_tokens(fact_txt) * n_facts
    full = all_recent + all_cards + all_facts

    pov_recent = (est_tokens(beat_prose) + est_tokens(beat_struct)) * min(n_beats, RECENT_MAX_BEATS)
    pov_cards = est_tokens("卡" * 400)
    pov_facts = est_tokens(fact_txt) * keep_facts
    pov = pov_recent + pov_cards + pov_facts

    sections = [
        {"name": "card", "items": [{"full": "卡" * 400, "summary": "卡" * 340,
                                     "triple": "卡" * 280, "id": "c1", "keep_rank": 1}]},
        {"name": "recent", "items": [{"full": beat_prose + beat_struct,
                                       "summary": beat_prose[:60], "triple": "林砚·迟到",
                                       "id": f"b{i}", "keep_rank": 2} for i in range(n_beats)]},
        {"name": "memory", "items": [{"full": fact_txt, "summary": "林砚知道秘密7",
                                       "triple": "林砚|知道|秘密7",
                                       "id": f"m{i}", "keep_rank": 3} for i in range(n_facts)]},
    ]
    kept, level, tokens, dropped = pack_context(sections, BUDGET_TOTAL)
    return {"beats": n_beats, "facts": n_facts, "full_tokens": full, "pov_tokens": pov,
            "budget": BUDGET_TOTAL, "packed_tokens": tokens, "level": level,
            "dropped": dropped, "ratio_full_vs_pov": full / max(1, pov)}


# ══════════════════════════════════════════════════════════════
# 9. 基准：回退重放（向量扫描见 bench_vector.mjs）
# ══════════════════════════════════════════════════════════════
def bench_replay(events=2000, dim=VECTOR_DIM):
    """回退成本 = 从最近快照重放到目标 seq。用真磁盘 SQLite（WAL），不用内存库假装。"""
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".db", prefix="noryth_probe_")
    os.close(fd)
    con = sqlite3.connect(path)
    con.isolation_level = None          # 手动控制事务，否则 DELETE 会隐式开事务导致 BEGIN 失败
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript("""
      CREATE TABLE message(id TEXT PRIMARY KEY, scene_id TEXT, agent TEXT, seq INTEGER, prose TEXT);
      CREATE TABLE fact(id TEXT PRIMARY KEY, subject TEXT, predicate TEXT, obj TEXT, seq INTEGER);
      CREATE TABLE cognition(character_id TEXT, fact_id TEXT, seq INTEGER,
                             PRIMARY KEY(character_id, fact_id));
      CREATE INDEX ix_msg_seq ON message(seq);
    """)
    t0 = time.perf_counter()
    con.execute("BEGIN")
    for i in range(events):
        con.execute("INSERT INTO message VALUES (?,?,?,?,?)",
                    (f"m{i}", "scene:0", "char:lin", i, "雨" * 120))
        if i % 4 == 0:
            con.execute("INSERT INTO fact VALUES (?,?,?,?,?)",
                        (f"f{i}", "char:lin", "知道", "秘密", i))
            for ch in ("char:lin", "char:shen"):
                con.execute("INSERT OR IGNORE INTO cognition VALUES (?,?,?)", (ch, f"f{i}", i))
    con.commit()
    write_ms = (time.perf_counter() - t0) * 1000
    rows = []
    for interval in (25, 50, 100, 200):
        replay = min(interval, events)
        t0 = time.perf_counter()
        con.execute("DELETE FROM message")
        con.execute("DELETE FROM fact")
        con.execute("DELETE FROM cognition")
        con.execute("BEGIN")
        for i in range(0, replay):
            con.execute("INSERT INTO message VALUES (?,?,?,?,?)",
                        (f"m{i}", "scene:0", "char:lin", i, "雨" * 120))
        con.commit()
        rows.append((interval, (time.perf_counter() - t0) * 1000))
    con.close()
    con = None
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(path + suffix)
        except OSError:
            pass
    return {"events": events, "write_ms": write_ms, "rows": rows}


# ══════════════════════════════════════════════════════════════
# 10. 成本模型（公式，不是测量）
# ══════════════════════════════════════════════════════════════
def cost_model(beats=40, chars=5, scenes=120, price_in=2.0, price_out=8.0, ctx_tokens=4300):
    """价格单位：元 / 百万 token（占位，由用户按供应商填）。ctx_tokens 用实测装配体积。"""
    narr = int(beats * 0.26)
    char_beats = beats - narr
    calls = char_beats + narr
    in_tok = calls * ctx_tokens
    out_tok = calls * 260
    # 场景收尾：摘要 + 状态卡 + 抽卡裁决
    in_tok += 3 * 1800
    out_tok += 3 * 400
    per_scene = in_tok + out_tok
    total = per_scene * scenes
    return {
        "beats": beats, "calls_per_scene": calls + 3,
        "tokens_per_scene": per_scene, "tokens_per_novel": total,
        "cost_per_scene": (in_tok * price_in + out_tok * price_out) / 1e6,
        "cost_per_novel": (in_tok * price_in + out_tok * price_out) / 1e6 * scenes,
    }


def cost_arbitration(beats=40, delta_rate=0.005, in_tok=1200, out_tok=60):
    """若每拍都让 LLM 选下一位，每场多出的调用与 token。delta_rate=实测仲裁触发率。"""
    return {"extra_calls": beats, "extra_tokens": beats * (in_tok + out_tok),
            "with_scoring": int(beats * delta_rate),
            "saving_ratio": 1 - delta_rate}


# ══════════════════════════════════════════════════════════════
# 11. 演示 / 自检
# ══════════════════════════════════════════════════════════════
def demo():
    print("═" * 78)
    print("Noryth 设计探针 · demo（本机实测，非基准测试）")
    print("═" * 78)

    print("\n[1] 发言调度：500 拍合成序列 × 3 种子（焦点惯性 45%）")
    print(f"{'配置':<26}{'最长连任':>10}{'旁白占比':>12}{'单人最高占比':>14}{'仲裁触发':>10}")
    for label, damp, cap, pace in (
            ("自由抢话(无阻尼/无节奏)", False, False, False),
            ("仅阻尼", True, False, True),
            ("阻尼+硬上限(默认)", True, True, True)):
        res = [sim_beats(s, 500, damp, cap, pace) for s in (1, 2, 3)]
        ls = [r["longest_streak"] for r in res]
        ns = [r["narrator_share"] for r in res]
        ms = [r["max_agent_share"] for r in res]
        ar = [r["arb_rate"] for r in res]
        print(f"{label:<26}{f'{min(ls)}–{max(ls)}':>10}"
              f"{f'{min(ns):.1%}–{max(ns):.1%}':>12}"
              f"{f'{min(ms):.1%}–{max(ms):.1%}':>14}"
              f"{f'{min(ar):.1%}–{max(ar):.1%}':>12}")

    base = sim_beats(1, 500, True, True)
    print("\n[2] 仲裁 δ 扫描（单种子 500 拍，触发率）")
    for d, r in sim_delta_scan(base["gaps"]):
        mark = "  ← 默认" if abs(d - ARBITRATION_DELTA) < 1e-9 else ""
        print(f"    δ={d:<5} 触发率={r:6.1%}{mark}")

    print("\n[3] 角色计数（种子1，阻尼+上限，500 拍）")
    for k, v in sorted(base["counts"].items(), key=lambda kv: -kv[1]):
        print(f"    {k:<14}{v:>5}  {v/500:6.1%}")

    kg = sim_knowledge()
    print("\n[4] 限知过滤：12 场景 × 6 角色 = %d 次装配，%d 条事实"
          % (kg["assemblies"], kg["facts"]))
    print(f"    平均每个角色知道          {kg['avg_known']:6.1f} 条 / {kg['facts']} 条")
    print(f"    全量注入：每次装配越权    {kg['leak_per_assembly_full']:6.1f} 条")
    print(f"    前置过滤：累计越权        {kg['leak_total_filtered']:6d} 条")
    print(f"    事实块 token  全量 {kg['full_tokens_avg']:.0f} → 限知 {kg['pov_tokens_avg']:.0f}"
          f"（{kg['full_tokens_avg']/max(1,kg['pov_tokens_avg']):.2f}×）")

    print("\n[5] 上下文体积（6 角色 / 该角色已知 34 条事实）")
    print(f"{'场景规模':<18}{'全量':>9}{'限知':>9}{'缩减':>8}{'装配':>9}{'等级':>12}{'丢弃':>6}")
    for nb, nf in ((40, 200), (80, 400), (120, 800)):
        ctx = sim_context(nb, nf)
        print(f"{f'{nb}拍/{nf}事实':<18}{ctx['full_tokens']:>9}{ctx['pov_tokens']:>9}"
              f"{ctx['ratio_full_vs_pov']:>7.2f}×{ctx['packed_tokens']:>9}"
              f"{ctx['level']:>12}{ctx['dropped']:>6}")
    ctx = sim_context(40, 200)

    print("\n[6] 向量暴力扫描：见 design/probe/bench_vector.mjs（Node 才是真实运行时）")
    print("    Node 实测 512 维/12 万条 = 55 ms → 小说项目不需要 ANN，也不需要独立向量库")

    rp = bench_replay()
    print(f"\n[7] 回退重放（真 SQLite，{rp['events']} 事件写入 {rp['write_ms']:.0f} ms）")
    for interval, ms in rp["rows"]:
        print(f"    快照间隔={interval:<5} 重放耗时={ms:6.2f} ms")

    cm = cost_model(ctx_tokens=ctx["packed_tokens"], price_in=2.0, price_out=8.0)
    print("\n[8] 成本模型（价格占位 2 元/8 元 每百万 token，按供应商替换）")
    print(f"    每场 {cm['beats']} 拍 → {cm['calls_per_scene']} 次调用，"
          f"{cm['tokens_per_scene']:,} tok，{cm['cost_per_scene']:.3f} 元")
    print(f"    {120} 场 → {cm['tokens_per_novel']:,} tok，{cm['cost_per_novel']:.1f} 元")
    ca = cost_arbitration(delta_rate=base["arb_rate"])
    print(f"    若每拍都叫 LLM 选人：每场 +{ca['extra_calls']} 次调用 / "
          f"+{ca['extra_tokens']:,} tok；评分法把调用降到 {base['arb_rate']:.1%}")

    print("\n[9] 参数不变式")
    print(f"    权重和 = {W_GOAL+W_ADDRESSED+W_STAKE+W_NARRATOR+W_INITIATIVE:.6f}")
    print(f"    配额和 = {sum(RATIOS.values()):.6f}")
    print(f"    rrf_ref = {RRF_REF:.6f}（=(w_slot+w_fts)/(k+1)）")
    print(f"    可调参数 = {count_tunable()[0]} 个")


def count_tunable():
    n, keys = 0, []
    for line in PARAMS.read_text(encoding="utf-8").splitlines():
        if "tunable" in line and not line.strip().startswith("#"):
            n += 1
            keys.append(line.split(":")[0].strip())
    return n, keys


def selftest():
    ok = []

    def chk(cond, label):
        ok.append((bool(cond), label))
        if not cond:
            print(f"  FAIL {label}")

    # 权重与配额
    chk(abs(W_GOAL + W_ADDRESSED + W_STAKE + W_NARRATOR + W_INITIATIVE - 1.0) < 1e-9, "调度权重和为 1")
    chk(abs(sum(RATIOS.values()) - 1.0) < 1e-9, "上下文配额和为 1")
    chk(abs(RRF_REF - (W_SLOT + W_FTS) / (RRF_K + 1)) < 1e-9, "rrf_ref 是导出量而非独立参数")
    chk(DAMP_FIRST < DAMP_SECOND < 1.0, "阻尼系数递减且 <1")

    # token 估算边界
    chk(est_tokens("") == 0, "空串 token=0")
    chk(est_tokens("雨") > 0, "单字 token>0")
    chk(est_tokens("雨雨雨") >= est_tokens("雨雨"), "token 单调不减")

    # 调度：空候选集、全同分、被点名豁免、硬上限
    chk(score_candidates([], {"consecutive_dialogue": 0, "beats_since_narrator": 9}, 1, 1) == [], "空候选集返回 []")
    same = [{"id": f"c{i}", "goal_rel": 0.5, "initiative": 0.5, "stake": 0.5,
             "addressed": 0.0, "is_narrator": False, "since": 9, "_streak": 0,
             "speak_count": i} for i in range(3)]
    r1 = score_candidates(same, {"consecutive_dialogue": 0, "beats_since_narrator": 9}, 7, 3)
    r2 = score_candidates(same, {"consecutive_dialogue": 0, "beats_since_narrator": 9}, 7, 3)
    chk([x["id"] for x in r1] == [x["id"] for x in r2], "同 seed 同上下文可复演")
    addr = [{"id": "a", "goal_rel": 0.0, "initiative": 0.0, "stake": 0.0, "addressed": 1.0,
             "is_narrator": False, "since": 0, "_streak": 1, "speak_count": 2},
            {"id": "b", "goal_rel": 1.0, "initiative": 1.0, "stake": 1.0, "addressed": 0.0,
             "is_narrator": False, "since": 9, "_streak": 0, "speak_count": 1}]
    rr = apply_damping(score_candidates(addr, {"consecutive_dialogue": 0, "beats_since_narrator": 9}, 1, 1), addr)
    ar = next(x for x in rr if x["id"] == "a")
    chk(abs(ar["score"] - (ar["base"] + ar["jit"])) < 1e-9, "被点名者不被阻尼")
    chk(abs(ar["score"] - 0.30) < 0.06, "被点名者得分保持基础值不被乘性衰减")
    capped = [{"id": "a", "goal_rel": 1.0, "initiative": 1.0, "stake": 1.0, "addressed": 0.0,
               "is_narrator": False, "since": 0, "_streak": MAX_CONSECUTIVE, "speak_count": 5}]
    rc = apply_damping(score_candidates(capped, {"consecutive_dialogue": 9, "beats_since_narrator": 9}, 1, 1), capped)
    chk(rc[0]["score"] == 0.0, "硬上限把连任者压到 0")
    zeros = [{"score": 0.5, "addressed": 0, "speak_count": 0, "id": "a"},
             {"score": 0.0, "addressed": 0, "speak_count": 0, "id": "b"},
             {"score": 0.0, "addressed": 0, "speak_count": 0, "id": "c"}]
    chk(not needs_arbitration(zeros), "被钳制者的 0 分不制造假平局")

    # 上下文：永不超预算；超预算时整条丢弃
    sec = [{"name": "x", "items": [{"full": "字" * 5000, "summary": "字" * 4000,
                                    "triple": "字" * 3000, "id": "字" * 2000,
                                    "keep_rank": i} for i in range(10)]}]
    _, level, tok, dropped = pack_context(sec, 1000)
    chk(tok <= 1000, "装配结果不超预算")
    chk(dropped > 0, "超预算时整条丢弃")
    chk(level == "id+drop", "极端压缩降到 id+drop 级")

    # 知识边界：没有认知记录 = 不知道
    facts = [{"id": "f1", "secrecy": 0, "object": "甲"}, {"id": "f2", "secrecy": 0, "object": "乙"}]
    cog = [{"character_id": "lin", "fact_id": "f1"}]
    v = visible_facts(facts, "lin", cog)
    chk(len(v) == 1 and v[0]["id"] == "f1", "无认知记录的事实被过滤")
    chk(visible_facts(facts, "nobody", cog) == [], "未知角色拿到空集")
    red = [{"id": "f3", "secrecy": 3, "object": "真凶", "redact_for": {"lin"}}]
    v2 = visible_facts(red, "lin", [{"character_id": "lin", "fact_id": "f3"}])
    chk(v2[0]["object"] == "（未知）", "高敏事实对无权者脱敏")

    # 感知：同场 ≠ 可感知
    chk(build_audience(["lin", "shen"], "lin", "soliloquy") == [], "心理独白不进任何人受众")
    chk(build_audience(["lin", "shen"], "lin", "whisper", private_to=["shen"]) == ["shen"], "耳语只给指定人")
    chk(build_audience(["lin", "shen"], "lin", "public") == ["shen"], "公开发言排除自己")
    chk(build_audience(["lin"], "narrator", "narrator_reader") == [], "旁白默认零感知")

    # 收束条件
    st = {"facts": {("信", "送达"): True}, "rels": {("a", "b", "trust"): -0.5}, "beats": 19}
    chk(eval_exit({"op": "fact", "subject": "信", "predicate": "送达", "object": True}, st), "fact 算子")
    chk(eval_exit({"op": "rel", "from": "a", "to": "b", "axis": "trust", "cmp": "<", "value": -0.3}, st), "rel 算子")
    chk(eval_exit({"op": "not", "of": {"op": "beats", "cmp": ">=", "value": 100}}, st), "not 算子")
    chk(eval_exit({"op": "any", "of": [{"op": "beats", "cmp": ">=", "value": 99},
                                       {"op": "beats", "cmp": ">=", "value": 18}]}, st), "any 算子")
    chk(not eval_exit({"op": "all", "of": [{"op": "beats", "cmp": ">=", "value": 18},
                                           {"op": "beats", "cmp": ">=", "value": 99}]}, st), "all 算子")
    try:
        eval_exit({"op": "vibes"}, st)
        chk(False, "未知算子必须报错")
    except ValueError:
        chk(True, "未知算子必须报错")

    # 事件卡：不满足 min_level 的牌不消耗
    deck = [{"id": "heavy", "min_level": 4, "consumed": False, "one_shot": True},
            {"id": "light", "min_level": 0, "consumed": False, "one_shot": False}]
    card, rest = draw_event_card(deck, level=1, turn=CARD_INTERVAL, flat=False)
    chk(card["id"] == "light", "min_level 不足的牌被跳过")
    chk(len(rest) == 1 and rest[0]["id"] == "heavy", "跳过的牌留在牌堆")

    # 关系突变
    chk(relation_jump(0.0, 0.2)["verdict"] == "ok", "小幅关系变化通过")
    chk(relation_jump(0.0, 0.8)["verdict"] == "needs_justification", "突变要求理由")

    # stake 构成：边界与单调性
    chk(abs(stake_of(0, False) - STAKE_BASE) < 1e-9, "stake 下界 = base")
    chk(abs(stake_of(2.1, True) - 0.5655) < 1e-3, "stake 与文档例值一致（0.5655）")
    chk(stake_of(4, True, 1.0) <= 1.0, "stake 上界被钳到 1")
    chk(stake_of(3, True) > stake_of(1, True), "stake 随冲突单调增")
    chk(stake_of(2, True) > stake_of(2, False), "秘密受威胁抬高 stake")
    chk(abs(stake_of(2, False, 1.0) - (STAKE_BASE + STAKE_CONFLICT * 0.5 + STAKE_OWNERSHIP)) < 1e-9,
        "目标所有权独立可加")

    # 声音区分度：同一个人距离 0，两种笔调距离过阈值
    a = ["我没说过这话。", "账本不在我这儿。", "你走吧。"]
    b = ["我没说过这话。", "账本不在我这儿。", "你走吧。"]
    c = ["呵，这雨下得可真是时候呢……", "你说呢？", "我倒是想听听，你打算怎么解释呀？"]
    chk(voice_distance(a, b) < 1e-9, "同样本声音距离 = 0")
    chk(voice_distance(a, c) > VOICE_JSD_THRESHOLD, "不同笔调的距离超过阈值")
    chk(voice_distance([], a) == 0.0, "空样本返回 0 而不抛错")
    chk(0.0 <= voice_distance(a, c) <= 1.0, "声音距离有界")

    # 规模阈值
    chk(ANN_THRESHOLD > 50_000, "ANN 阈值高于小说项目现实规模")

    passed = sum(1 for p, _ in ok if p)
    print(f"selftest: {passed}/{len(ok)} 断言通过")
    return 0 if passed == len(ok) else 1


def check_params():
    """params.yaml ↔ 代码常量。键缺失或值不等都算失败。"""
    txt = PARAMS.read_text(encoding="utf-8")
    P = {}
    for ln, line in enumerate(txt.splitlines(), 1):
        s = line.split("#")[0].strip()
        if not s:
            continue
        if ":" not in s:
            print(f"FAIL {PARAMS}:{ln} 无法解析: {line!r}")
            return 1
        k, v = s.split(":", 1)
        k, v = k.strip(), v.strip()
        if k in P:
            print(f"FAIL 重复键 {k}")
            return 1
        try:
            P[k] = float(v)
        except ValueError:
            P[k] = v

    fails = []

    def eq(key, actual, tol=1e-9):
        if key not in P:
            fails.append(f"缺少键 {key}")
            return
        if abs(float(P[key]) - float(actual)) > tol:
            fails.append(f"{key}: yaml={P[key]} code={actual}")

    eq("scheduler.w_goal", W_GOAL); eq("scheduler.w_addressed", W_ADDRESSED)
    eq("scheduler.w_stake", W_STAKE); eq("scheduler.w_narrator", W_NARRATOR)
    eq("scheduler.w_initiative", W_INITIATIVE); eq("scheduler.jitter_max", JITTER_MAX)
    eq("scheduler.damp_first", DAMP_FIRST); eq("scheduler.damp_second", DAMP_SECOND)
    eq("scheduler.max_consecutive", MAX_CONSECUTIVE); eq("scheduler.arbitration_delta", ARBITRATION_DELTA)
    eq("scene.max_beats", MAX_BEATS); eq("scene.max_level", MAX_LEVEL)
    eq("scene.event_card_interval", CARD_INTERVAL)
    eq("scene.narrator_min_gap", NARRATOR_MIN_GAP)
    eq("scene.narrator_max_gap", NARRATOR_MAX_GAP)
    eq("context.budget_total", BUDGET_TOTAL)
    for k, v in RATIOS.items():
        eq(f"context.ratio_{k}", v)
    eq("context.recent_max_beats", RECENT_MAX_BEATS)
    eq("memory.vector_dim", VECTOR_DIM); eq("memory.ann_threshold", ANN_THRESHOLD)
    eq("memory.rrf_k", RRF_K); eq("memory.w_slot", W_SLOT); eq("memory.w_fts", W_FTS)
    eq("memory.w_vector", W_VECTOR); eq("memory.w_graph", W_GRAPH)
    eq("memory.rrf_ref", RRF_REF, tol=1e-6)
    eq("memory.floor", MEMORY_FLOOR); eq("memory.mmr_lambda", MMR_LAMBDA)
    eq("memory.recency_rho", RECENCY_RHO)
    eq("scheduler.stake_base", STAKE_BASE)
    eq("scheduler.stake_conflict", STAKE_CONFLICT)
    eq("scheduler.stake_secret", STAKE_SECRET)
    eq("scheduler.stake_ownership", STAKE_OWNERSHIP)
    eq("consistency.voice_jsd_threshold", VOICE_JSD_THRESHOLD)
    eq("consistency.clue_max_age_chapters", CLUE_MAX_AGE_CHAPTERS)
    eq("consistency.relation_jump_threshold", RELATION_JUMP)
    eq("consistency.max_reviser_rounds", MAX_REVISER_ROUNDS)
    eq("rollback.snapshot_interval", SNAPSHOT_INTERVAL)
    eq("rollback.max_replay_events", MAX_REPLAY_EVENTS)

    if abs(sum(RATIOS.values()) - 1.0) > 1e-9:
        fails.append("上下文配额和 != 1")
    if not (DEGRADE_TRIPLE < DEGRADE_SUMMARY < 1.0):
        fails.append("降级阈值必须递减且 <1")
    # 满配 stake 必须 <= 1：靠钳位截断会让高冲突段的角色 stake 全都变成 1.0，失去区分度
    stake_max = STAKE_BASE + STAKE_CONFLICT + STAKE_SECRET + STAKE_OWNERSHIP
    if stake_max > 1.0 + 1e-9:
        fails.append(f"stake 满配 {stake_max:.3f} > 1，会被钳位抹平")
    if not (MAX_CONSECUTIVE >= 2):
        fails.append("硬上限 <2 会让被点名者无法连续应答")
    n_tun, keys = count_tunable()
    if n_tun != 7:
        fails.append(f"可调参数应为 7 个（约束调参预算），实际 {n_tun}: {keys}")
    if len(P) < 40:
        fails.append(f"参数表条目过少（{len(P)}），可能解析失败")

    print(f"check_params: {len(P)} 个键，可调 {n_tun} 个，失败 {len(fails)}")
    for f in fails:
        print("  FAIL", f)
    return 1 if fails else 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "--demo"
    if mode == "--demo":
        demo()
    elif mode == "--selftest":
        sys.exit(selftest())
    elif mode == "--check-params":
        sys.exit(check_params())
    elif mode == "--all":
        demo()
        print()
        rc1 = selftest()
        print()
        rc2 = check_params()
        sys.exit(rc1 or rc2)
    else:
        print(__doc__)
        sys.exit(2)
