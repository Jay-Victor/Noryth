#!/usr/bin/env python3
"""比对 PRD §4.10 工具清单与 docs/tools/*.json。

用法:
    python docs/scripts/check_tool_spec.py
    python docs/scripts/check_tool_spec.py --tools docs/tools --prd docs/PRD.md

检查项:
  1. 42 个 Agent 工具的编号、名称、允许调用（actors）、类（side_effect）与 PRD 一致
  2. 8 个系统能力存在、agent_callable=false、side_effect=commit/execute 不等于 none（job.cancel 除外）
  3. M0 有效工具数 = 36；六个 Agent 的 allowlist 与 §4.11 的 M0 数字一致
  4. 清单字段齐全（name/version/family/summary/actors/side_effect/agent_callable/requires_gate/idempotency/limits/degrade/audit）

纯标准库，退出码 0 = 通过。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Windows 控制台默认不是 UTF-8（CI 上是 cp1252），中文输出会直接抛 UnicodeEncodeError
_stdout_reconfigure = getattr(sys.stdout, "reconfigure", None)
if callable(_stdout_reconfigure):
    _stdout_reconfigure(encoding="utf-8", errors="replace")
_stderr_reconfigure = getattr(sys.stderr, "reconfigure", None)
if callable(_stderr_reconfigure):
    _stderr_reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]

AGENT_NAMES = {
    "规划": "planner",
    "编排": "orchestrator",
    "角色": "character",
    "旁白": "narrator",
    "审批": "reviewer",
    "记忆": "memory",
}

M0_COUNTS = {
    "planner": 8,
    "orchestrator": 16,
    "character": 9,
    "narrator": 5,
    "reviewer": 17,
    "memory": 13,
}

SYSTEM_NAMES = {
    "doc.commit_beat",
    "doc.apply_patch",
    "doc.finalize_chapter",
    "memory.apply_executor",
    "index.rebuild",
    "export.run",
    "backup.create",
    "job.cancel",
}

KIND_TO_SIDE_EFFECT = {
    "读": "none",
    "校验": "none",
    "提案": "propose",
    "执行": "execute",
    "交互": "none",
}

REQUIRED_FIELDS = [
    "name",
    "version",
    "family",
    "summary",
    "actors",
    "side_effect",
    "agent_callable",
    "requires_gate",
    "idempotency",
    "limits",
    "degrade",
    "audit",
]

ROW_RE = re.compile(r"^\|\s*(T\d{2})\s*\|\s*`([a-z_]+(?:\.[a-z_]+)+)`\s*\|(.*?)\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|")


def parse_prd(path: Path) -> dict[str, dict]:
    tools: dict[str, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = ROW_RE.match(line)
        if not match:
            continue
        tool_id, name, _desc, actors_cell, kind_cell = match.groups()
        actors = []
        for token in re.split(r"[/、,]\s*", actors_cell.strip()):
            key = AGENT_NAMES.get(token.strip())
            if key and key not in actors:
                actors.append(key)
        kind = kind_cell.strip()
        tools[tool_id] = {
            "name": name,
            "actors": sorted(actors),
            "side_effect": KIND_TO_SIDE_EFFECT.get(kind, kind),
            "kind": kind,
        }
    return tools


def load_manifests(tools_dir: Path) -> dict[str, dict]:
    manifests: dict[str, dict] = {}
    for path in sorted(tools_dir.glob("*.json")):
        if path.name.startswith("_"):
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        manifests[data["name"]] = data
    return manifests


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tools", default=str(ROOT / "docs" / "tools"))
    parser.add_argument("--prd", default=str(ROOT / "docs" / "PRD.md"))
    args = parser.parse_args(argv[1:])

    errors: list[str] = []
    prd_tools = parse_prd(Path(args.prd))
    manifests = load_manifests(Path(args.tools))

    if len(prd_tools) != 42:
        errors.append(f"PRD 解析出 {len(prd_tools)} 个工具，期望 42")

    by_id = {}
    for path in Path(args.tools).glob("*.json"):
        if path.name.startswith("_"):
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        by_id[data.get("tool_id")] = data

    for tool_id, expected in sorted(prd_tools.items()):
        actual = by_id.get(tool_id)
        if actual is None:
            errors.append(f"{tool_id} 缺清单")
            continue
        if actual["name"] != expected["name"]:
            errors.append(f"{tool_id} 名称 {actual['name']} != {expected['name']}")
        if sorted(actual["actors"]) != expected["actors"]:
            errors.append(f"{tool_id} actors {actual['actors']} != {expected['actors']}")
        if actual["side_effect"] != expected["side_effect"]:
            errors.append(f"{tool_id} side_effect {actual['side_effect']} != {expected['side_effect']}")
        if actual.get("agent_callable") is not True:
            errors.append(f"{tool_id} agent_callable 必须为 true")

    for tool_id, data in sorted(by_id.items()):
        if tool_id in prd_tools:
            continue
        if data["name"] not in SYSTEM_NAMES:
            errors.append(f"多余清单 {tool_id} {data['name']} 不在 PRD §4.10")
            continue
        if data.get("agent_callable") is not False:
            errors.append(f"系统能力 {data['name']} 必须 agent_callable=false")
        if data["side_effect"] == "commit" and data["name"] != "doc.commit_beat":
            if data["name"] != "doc.apply_patch" and data["name"] != "doc.finalize_chapter":
                errors.append(f"系统能力 {data['name']} commit 语义需复核")

    missing_system = SYSTEM_NAMES - {data["name"] for data in by_id.values()}
    for name in sorted(missing_system):
        errors.append(f"缺少系统能力 {name}")

    for name, data in manifests.items():
        for field in REQUIRED_FIELDS:
            if field not in data:
                errors.append(f"{name}: 缺字段 {field}")

    m0 = [data for data in manifests.values() if data.get("agent_callable") is True and data.get("m0") is True]
    if len(m0) != 36:
        errors.append(f"M0 有效工具数 {len(m0)} != 36")

    for agent, expected in M0_COUNTS.items():
        actual = sum(1 for data in m0 if agent in data["actors"])
        if actual != expected:
            errors.append(f"{agent} M0 工具数 {actual} != {expected}")

    if errors:
        print(f"check_tool_spec FAIL: {len(errors)} 个问题")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(
        f"check_tool_spec PASS: PRD {len(prd_tools)} 工具 / "
        f"清单 {len(manifests)}（系统 {len(SYSTEM_NAMES)}）/ M0 {len(m0)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
