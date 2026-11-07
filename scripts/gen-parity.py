#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从设计探针生成跨语言一致性夹具。

只读取 design/probe/noryth_proto.py（不修改它），输出
packages/core/test/fixtures/parity.json。TS 侧 parity.test.ts 逐项比对：
任何一处公式漂移都会让测试变红，而不是等到 P1 才发现行为已经偏了。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "design" / "probe"))
import noryth_proto as p  # noqa: E402

OUT = ROOT / "packages" / "core" / "test" / "fixtures" / "parity.json"

HASH_PARTS = [
    ("1", "1", "char:lin"),
    ("7", "3", "c0"),
    ("42", "17", "narrator"),
    ("2026", "1", "e_shen"),
    ("长" * 200,),
    ("multi-block-" * 40,),
]
TOKENS = [
    "",
    "雨",
    "雨雨雨",
    "你迟到了。",
    "雨水顺着屋檐砸在青石板上。",
    "hello world",
    "混合 mixed 文本 123",
]

CANDIDATES = [
    {"id": "char:lin", "goal_rel": 1.0, "initiative": 0.9, "stake": 0.57,
     "addressed": 0.0, "is_narrator": False, "since": 0, "_streak": 1, "speak_count": 12},
    {"id": "char:shen", "goal_rel": 1.0, "initiative": 0.6, "stake": 0.57,
     "addressed": 1.0, "is_narrator": False, "since": 1, "_streak": 0, "speak_count": 9},
    {"id": "char:qi", "goal_rel": 0.0, "initiative": 0.3, "stake": 0.27,
     "addressed": 0.0, "is_narrator": False, "since": 9, "_streak": 0, "speak_count": 2},
    {"id": "narrator", "goal_rel": 0.0, "initiative": 0.5, "stake": 0.0,
     "addressed": 0.0, "is_narrator": True, "since": 99, "_streak": 0, "speak_count": 5},
]
CTX = {"conflict_level": 2.1, "consecutive_dialogue": 2, "beats_since_narrator": 3}

CAPPED = [
    {"id": "char:lin", "goal_rel": 1.0, "initiative": 1.0, "stake": 1.0,
     "addressed": 0.0, "is_narrator": False, "since": 0, "_streak": 3, "speak_count": 20},
    {"id": "char:shen", "goal_rel": 0.5, "initiative": 0.5, "stake": 0.4,
     "addressed": 0.0, "is_narrator": False, "since": 2, "_streak": 0, "speak_count": 4},
]


def scored(cands, ctx, seed, seq):
    return [
        {"id": r["id"], "base": r["base"], "score": r["score"], "jitter": r["jit"],
         "parts": r["parts"], "addressed": r["addressed"], "speak_count": r["speak_count"]}
        for r in p.score_candidates(cands, ctx, seed, seq)
    ]


def damped(cands, ctx, seed, seq):
    ranked = p.score_candidates(cands, ctx, seed, seq)
    out = p.apply_damping(ranked, cands)
    return [
        {"id": r["id"], "score": r["score"], "capped": bool(r.get("capped", False))}
        for r in out
    ]


def context_fixture():
    beat_prose = ("雨水顺着屋檐砸在青石板上，林砚把账本往袖口里又塞了塞，" * 2)[:118]
    beat_struct = '{"line":"你迟到了。","act":"把伞收拢","mind":"他在试探我","intent":"试探"}'
    fact_txt = "林砚持有沈昼的秘密7（保密2）"
    sections = [
        {"name": "card", "items": [{"full": "卡" * 400, "summary": "卡" * 340,
                                     "triple": "卡" * 280, "id": "c1", "keep_rank": 1}]},
        {"name": "recent", "items": [{"full": beat_prose + beat_struct,
                                       "summary": beat_prose[:60], "triple": "林砚·迟到",
                                       "id": f"b{i}", "keep_rank": 2} for i in range(40)]},
        {"name": "memory", "items": [{"full": fact_txt, "summary": "林砚知道秘密7",
                                       "triple": "林砚|知道|秘密7",
                                       "id": f"m{i}", "keep_rank": 3} for i in range(200)]},
    ]
    kept, level, tokens, dropped = p.pack_context(sections, p.BUDGET_TOTAL)
    tiny = [{"name": "x", "items": [{"full": "字" * 5000, "summary": "字" * 4000,
                                     "triple": "字" * 3000, "id": "字" * 2000,
                                     "keep_rank": i} for i in range(10)]}]
    kept2, level2, tokens2, dropped2 = p.pack_context(tiny, 1000)
    fits = [{"name": "s", "items": [{"full": "短句", "summary": "短", "triple": "短",
                                      "id": "s1", "keep_rank": 1}]}]
    kept3, level3, tokens3, dropped3 = p.pack_context(fits, 100)
    return {
        "big": {"kept": [f"{s}:{it['id']}" for s, it in kept], "level": level,
                "tokens": tokens, "dropped": dropped},
        "tiny": {"kept": [f"{s}:{it['id']}" for s, it in kept2], "level": level2,
                 "tokens": tokens2, "dropped": dropped2},
        "fits": {"kept": [f"{s}:{it['id']}" for s, it in kept3], "level": level3,
                 "tokens": tokens3, "dropped": dropped3},
    }


def knowledge_fixture():
    facts = [
        {"id": "f1", "secrecy": 0, "object": "甲"},
        {"id": "f2", "secrecy": 0, "object": "乙"},
        {"id": "f3", "secrecy": 3, "object": "真凶", "redact_for": {"lin"}},
        {"id": "f4", "secrecy": 3, "object": "账本", "redact_for": set()},
    ]
    cog = [
        {"character_id": "lin", "fact_id": "f1"},
        {"character_id": "lin", "fact_id": "f3"},
        {"character_id": "lin", "fact_id": "f4"},
        {"character_id": "shen", "fact_id": "f2"},
    ]
    return {
        "lin": [{"id": f["id"], "object": f["object"], "redacted": bool(f.get("_redacted"))}
                for f in p.visible_facts(facts, "lin", cog)],
        "shen": [{"id": f["id"], "object": f["object"]} for f in p.visible_facts(facts, "shen", cog)],
        "nobody": p.visible_facts(facts, "nobody", cog),
    }


def audience_fixture():
    present = ["lin", "shen", "qi"]
    return [
        {"mode": "public", "audience": p.build_audience(present, "lin")},
        {"mode": "whisper", "audience": p.build_audience(present, "lin", "whisper", ["shen", "qi"])},
        {"mode": "soliloquy", "audience": p.build_audience(present, "lin", "soliloquy")},
        {"mode": "narrator_reader", "audience": p.build_audience(present, "narrator", "narrator_reader")},
    ]


def exit_fixture():
    state = {"facts": {("信", "送达"): True, ("账本", "持有"): "shen"},
             "rels": {("a", "b", "trust"): -0.5}, "beats": 19}
    cases = [
        {"op": "fact", "subject": "信", "predicate": "送达", "object": True},
        {"op": "fact", "subject": "信", "predicate": "送达", "object": False},
        {"op": "fact", "subject": "账本", "predicate": "持有", "object": "shen"},
        {"op": "rel", "from": "a", "to": "b", "axis": "trust", "cmp": "<", "value": -0.3},
        {"op": "rel", "from": "a", "to": "b", "axis": "affection", "cmp": ">", "value": 0.1},
        {"op": "beats", "cmp": ">=", "value": 18},
        {"op": "not", "of": {"op": "beats", "cmp": ">=", "value": 100}},
        {"op": "any", "of": [{"op": "beats", "cmp": ">=", "value": 99},
                             {"op": "beats", "cmp": ">=", "value": 18}]},
        {"op": "all", "of": [{"op": "beats", "cmp": ">=", "value": 18},
                             {"op": "beats", "cmp": ">=", "value": 99}]},
    ]
    return {"state": {"facts": [{"subject": "信", "predicate": "送达", "object": True},
                                {"subject": "账本", "predicate": "持有", "object": "shen"}],
                      "rels": [{"from": "a", "to": "b", "axis": "trust", "value": -0.5}],
                      "beats": 19},
            "cases": [{"expr": c, "expected": p.eval_exit(c, state)} for c in cases]}


def voice_fixture():
    a = ["我没说过这话。", "账本不在我这儿。", "你走吧。"]
    b = ["我没说过这话。", "账本不在我这儿。", "你走吧。"]
    c = ["呵，这雨下得可真是时候呢……", "你说呢？", "我倒是想听听，你打算怎么解释呀？"]
    return [
        {"a": a, "b": b, "distance": p.voice_distance(a, b)},
        {"a": a, "b": c, "distance": p.voice_distance(a, c)},
        {"a": [], "b": a, "distance": p.voice_distance([], a)},
    ]


def main() -> int:
    ranked = scored(CANDIDATES, CTX, 7, 3)
    damp = damped(CANDIDATES, CTX, 7, 3)
    damp_cap = damped(CAPPED, CTX, 7, 3)
    cards = [
        {"id": "heavy", "min_level": 4, "consumed": False, "one_shot": True},
        {"id": "light", "min_level": 0, "consumed": False, "one_shot": False},
    ]
    card, rest = p.draw_event_card(cards, level=1, turn=p.CARD_INTERVAL, flat=False)
    data = {
        "note": "由 scripts/gen-parity.py 从 design/probe/noryth_proto.py 生成；不要手改",
        "hash": [{"parts": list(parts), "value": p.h01(*parts)} for parts in HASH_PARTS],
        "tokens": [{"text": t, "value": p.est_tokens(t)} for t in TOKENS],
        "scheduler": {
            "candidates": CANDIDATES,
            "ctx": CTX,
            "seed": 7,
            "seq": 3,
            "ranked": ranked,
            "damped": damp,
            "capped_input": CAPPED,
            "capped": damp_cap,
            "arbitration": p.needs_arbitration(p.apply_damping(
                p.score_candidates(CANDIDATES, CTX, 7, 3), CANDIDATES)),
            "pick": p.pick(p.apply_damping(p.score_candidates(CANDIDATES, CTX, 7, 3),
                                           CANDIDATES))["id"],
        },
        "stake": [
            {"conflict": 0, "secret": False, "ownership": 0, "value": p.stake_of(0, False)},
            {"conflict": 2.1, "secret": True, "ownership": 0, "value": p.stake_of(2.1, True)},
            {"conflict": 4, "secret": True, "ownership": 1.0, "value": p.stake_of(4, True, 1.0)},
            {"conflict": 2, "secret": False, "ownership": 1.0, "value": p.stake_of(2, False, 1.0)},
        ],
        "context": context_fixture(),
        "knowledge": knowledge_fixture(),
        "audience": audience_fixture(),
        "exit": exit_fixture(),
        "voice": voice_fixture(),
        "relation": [
            {"old": 0.0, "new": 0.2, **p.relation_jump(0.0, 0.2)},
            {"old": 0.0, "new": 0.8, **p.relation_jump(0.0, 0.8)},
        ],
        "card": {
            "deck": cards,
            "level": 1,
            "turn": p.CARD_INTERVAL,
            "flat": False,
            "card": card["id"] if card else None,
            "rest": [c["id"] for c in rest],
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
