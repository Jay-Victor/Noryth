#!/usr/bin/env python3
"""校验 Noryth 页面设计的布局算术与线框结构。

用法:
    python docs/scripts/check_ui_spec.py                 # 全部检查
    python docs/scripts/check_ui_spec.py --layout-only   # 只算栅格
    python docs/scripts/check_ui_spec.py --emit-table    # 打印 Markdown 表
    python docs/scripts/check_ui_spec.py --html docs/assets/wireframes.html

检查项:
  1. 三档布局在 1280 / 1360 / 1440 / 1600 / 1920 / 2560 下的列宽
  2. 不变量: 对话 >= 420, 预览 >= 520, 正文列 32–42 字/行, 固定栅 <= 视口 40%
  3. 首页两栏最小宽与设置窗口内容区
  4. 线框图: 6 个页面帧, 4 个工作台各有 4 个分区, 设置 9 个分类

纯标准库, 退出码 0 = 通过。
"""
from __future__ import annotations

import argparse
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

# ---- 外壳尺寸（像素） -------------------------------------------------------
NAV = 56            # 左侧导航
DIV = 1             # 分区之间 1px 分隔线
CHAT_MIN = 420
PREVIEW_MIN = 520
PROSE_PX = 15       # 正文字号
PROSE_PAD = 64      # 预览区左右内边距合计
PROSE_MAX = 630     # 正文列上限
HOME_MAX = 1120
HOME_PAD = 26
HOME_LEFT_MIN = 720
HOME_RIGHT = 298
HOME_GAP = 26
SETTINGS_NAV = 220
SETTINGS_MIN_INNER = 560

# 模式: (名称, 生效下限, 会话列表宽, 文件树宽, 树形态, 预览/对话 宽度比)
MODES = [
    ("W1", 1600, 248, 224, "pane", 1.2),
    ("W2", 1360, 248, 44, "rail", 1.2),
    ("W3", 1280, 64, 44, "rail", 1.2),
]
VIEWPORTS = [1280, 1360, 1440, 1600, 1920, 2560]


def mode_for(width: int):
    for name, floor, sessions, tree, tree_mode, ratio in MODES:
        if width >= floor:
            return name, sessions, tree, tree_mode, ratio
    return None


def mode_name(width: int) -> str | None:
    mode = mode_for(width)
    return None if mode is None else mode[0]


def measure(width: int):
    mode = mode_for(width)
    if mode is None:
        return None
    name, sessions, tree, tree_mode, ratio = mode
    fixed = NAV + sessions + tree + 3 * DIV
    free = width - fixed
    chat = free / (1 + ratio)
    preview = free - chat
    column = min(max(preview - PROSE_PAD, 0), PROSE_MAX)
    return {
        "viewport": width,
        "mode": name,
        "nav": NAV,
        "sessions": sessions,
        "chat": chat,
        "preview": preview,
        "tree": tree,
        "tree_mode": tree_mode,
        "column": column,
        "chars": column / PROSE_PX,
        "fixed_ratio": fixed / width,
    }


def rows() -> list[dict]:
    out = []
    for width in VIEWPORTS:
        row = measure(width)
        if row is None:
            continue
        out.append(row)
    return out


def emit_table() -> str:
    lines = [
        "| 视口 | 模式 | 导航 | 会话列表 | 对话 | 文件预览 | 文件树 | 正文列 | 字/行 |",
        "|---:|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in rows():
        tree = f"{r['tree']}（轨道）" if r["tree_mode"] == "rail" else f"{r['tree']}"
        lines.append(
            "| {v} | {m} | {nav} | {s} | {c:.1f} | {p:.1f} | {t} | {col:.0f} | {ch:.1f} |".format(
                v=r["viewport"], m=r["mode"], nav=r["nav"], s=r["sessions"],
                c=r["chat"], p=r["preview"], t=tree, col=r["column"], ch=r["chars"],
            )
        )
    return "\n".join(lines)


def four_pane_at(width: int = 1440) -> dict:
    """同一视口强行四栅并列的对照：证明 1440 下不可读。"""
    fixed = NAV + 248 + 224 + 3 * DIV
    free = width - fixed
    chat = free / 2.2
    preview = free - chat
    column = preview - PROSE_PAD
    return {"width": width, "chat": chat, "preview": preview, "chars": column / PROSE_PX}


def check_layout() -> list[str]:
    errors: list[str] = []
    alt = four_pane_at()
    if alt["chars"] >= 32:
        errors.append(f"四栅 @1440 的正文列 {alt['chars']:.1f} 字/行 未低于 32，断点论证失效")
    for r in rows():
        if r["chat"] < CHAT_MIN:
            errors.append(f"{r['viewport']}px: 对话区 {r['chat']:.1f} < {CHAT_MIN}")
        if r["preview"] < PREVIEW_MIN:
            errors.append(f"{r['viewport']}px: 预览区 {r['preview']:.1f} < {PREVIEW_MIN}")
        if not (32 <= r["chars"] <= 42):
            errors.append(f"{r['viewport']}px: 正文列 {r['chars']:.1f} 字/行，超 32–42")
        if r["fixed_ratio"] > 0.40:
            errors.append(f"{r['viewport']}px: 固定栅占比 {r['fixed_ratio']:.1%} > 40%")

    # 断点两侧必须落在不同模式，且最小值不越界
    if mode_name(1599) != "W2" or mode_name(1600) != "W1":
        errors.append("1600px 断点未在 W2/W1 之间切换")
    if mode_name(1359) != "W3" or mode_name(1360) != "W2":
        errors.append("1360px 断点未在 W3/W2 之间切换")
    if mode_name(1279) is not None:
        errors.append("低于 1280px 仍返回布局，应要求最小窗口 1280×800")

    # 首页两栏：左 1fr + 右 298，内容上限 1120
    home_left = HOME_MAX - 2 * HOME_PAD - HOME_RIGHT - HOME_GAP
    if home_left < HOME_LEFT_MIN:
        errors.append(f"首页左列 {home_left} < {HOME_LEFT_MIN}")
    if HOME_MAX > 1280 - NAV:
        errors.append(f"首页内容上限 {HOME_MAX} 在最小窗口 1280 下放不下")
    # 设置窗口
    inner = 1040 - SETTINGS_NAV
    if inner < SETTINGS_MIN_INNER:
        errors.append(f"设置内容区 {inner} < {SETTINGS_MIN_INNER}")
    return errors


def check_html(path: Path) -> list[str]:
    if not path.is_file():
        return [f"找不到线框图: {path}"]
    html = path.read_text(encoding="utf-8")
    errors: list[str] = []

    pages = re.findall(r'data-page="([a-z]+)"', html)
    expected = {"home", "plan", "write", "review", "memory", "settings"}
    if set(pages) != expected:
        errors.append(f"页面帧 {sorted(set(pages))} != {sorted(expected)}")
    if len(pages) != 6:
        errors.append(f"页面帧数量 {len(pages)} != 6")

    # 每个工作台帧内必须出现四个分区
    frame_re = re.compile(r'<section class="frame" data-page="(\w+)"(.*?)</section>', re.S)
    panes = {"sessions", "chat", "preview", "tree"}
    for page, body in frame_re.findall(html):
        found = set(re.findall(r'data-pane="(\w+)"', body))
        if page in {"plan", "write", "review", "memory"}:
            missing = panes - found
            if missing:
                errors.append(f"{page}: 缺分区 {sorted(missing)}")
    if len(frame_re.findall(html)) != 6:
        errors.append("线框帧未被 <section class=\"frame\" data-page=...> 结构包裹")

    home = re.search(r'<section class="frame" data-page="home">(.*?)</section>', html, re.S)
    if not home:
        errors.append("缺少首页帧")
    else:
        body = home.group(1)
        for token in ('class="hleft"', 'class="hright"', 'class="hcard dash"',
                      '<span class="sn">01</span>', '<span class="sn">02</span>'):
            if token not in body:
                errors.append(f"首页缺少结构: {token}")
        if body.count('class="prow"') < 3:
            errors.append("首页项目库少于 3 行（含状态样例）")

        # 去重：同一动作/标签在首页只出现一次
        text = re.sub(r"<[^>]+>", "", body)
        for token, limit in (("新建项目", 1), ("Ctrl K", 1), ("设置", 1),
                             ("项目库", 1), ("回退", 1)):
            count = text.count(token)
            if count > limit:
                errors.append(f"首页「{token}」出现 {count} 次（上限 {limit}）")

    cats = re.findall(r'data-cat="([a-z-]+)"', html)
    if len(cats) != 9:
        errors.append(f"设置分类 {len(cats)} != 9: {cats}")

    if not re.search(r"\.frame\{[^}]*width:\s*1200px", html):
        errors.append("线框画布不是 1200px 固定宽（缩放基准会漂）")
    hex_colors = re.findall(r"#[0-9a-fA-F]{3,8}\b", html)
    if hex_colors:
        errors.append(f"线框出现硬编码颜色: {sorted(set(hex_colors))[:5]}")
    return errors


def emit_json() -> str:
    """给 scripts/gen-layout.mjs 的单一真源：TS 侧不手抄这些数字。"""
    import json

    data = {
        "nav": NAV,
        "divider": DIV,
        "titleBar": 40,
        "statusBar": 24,
        "chatMin": CHAT_MIN,
        "previewMin": PREVIEW_MIN,
        "prose": {
            "fontSize": PROSE_PX,
            "pad": PROSE_PAD,
            "maxColumn": PROSE_MAX,
            "minChars": 32,
            "maxChars": 42,
        },
        "breakpoints": {name: floor for name, floor, *_ in MODES},
        "modes": {
            name: {
                "sessions": sessions,
                "tree": tree,
                "treeMode": tree_mode,
                "ratio": ratio,
            }
            for name, _floor, sessions, tree, tree_mode, ratio in MODES
        },
    }
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=False)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layout-only", action="store_true")
    parser.add_argument("--emit-table", action="store_true")
    parser.add_argument("--emit-json", action="store_true")
    parser.add_argument("--html", default=str(Path(__file__).resolve().parents[1] / "assets" / "wireframes.html"))
    args = parser.parse_args(argv[1:])

    if args.emit_json:
        print(emit_json())
        return 0

    if args.emit_table:
        print(emit_table())
        return 0

    errors = check_layout()
    if not args.layout_only:
        errors += check_html(Path(args.html))

    print("check_ui_spec")
    for r in rows():
        print(
            "  {v:>4}px {m} 会话{s:>3} 对话{c:>6.1f} 预览{p:>6.1f} 树{t:>3} "
            "正文{col:>3.0f}px {ch:>4.1f}字/行 固定栅{fx:>5.1%}".format(
                v=r["viewport"], m=r["mode"], s=r["sessions"], c=r["chat"],
                p=r["preview"], t=r["tree"], col=r["column"], ch=r["chars"],
                fx=r["fixed_ratio"],
            )
        )
    if errors:
        print(f"FAIL: {len(errors)} 个问题")
        for error in errors:
            print(f"  - {error}")
        return 1
    home_left = HOME_MAX - 2 * HOME_PAD - HOME_RIGHT - HOME_GAP
    print(
        f"  home: 左{home_left} 右{HOME_RIGHT} 内容上限{HOME_MAX}；"
        f"settings: 内容区{1040 - SETTINGS_NAV}"
    )
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
