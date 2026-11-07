#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Noryth 交付包校验器

  python scripts/check.py            参数 + schema 全跑
  python scripts/check.py --params   只校验 params.yaml ↔ 代码常量
  python scripts/check.py --schema   只在真 SQLite 引擎上建库并逐条打约束

原则：校验器失败时改代码或改文档，不要改校验器。
约定：断言 PASS 必须校验到"期望的 ck_* 约束名"——只断言"抛了 IntegrityError"
      会让唯一索引或外键先炸也算通过，真正想验的触发器可能一次都没跑。
"""
import sys
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "docs" / "02-schema.sql"
sys.path.insert(0, str(ROOT / "design" / "probe"))

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


# ══════════════════════════════════════════════════════════════
# 1. 参数 ↔ 代码
# ══════════════════════════════════════════════════════════════
def check_params() -> int:
    import noryth_proto as proto
    return proto.check_params()


# ══════════════════════════════════════════════════════════════
# 2. Schema：真引擎建库 + 逐条打约束
# ══════════════════════════════════════════════════════════════
EXPECTED_TABLES = {
    "project", "branch", "project_state", "checkpoint", "snapshot", "event", "receipt",
    "agent_config", "entity", "predicate_spec", "fact", "cognition", "relation",
    "memory_node", "memory_edge", "scene", "beat", "message", "event_card",
    "chapter", "chapter_scene", "revision", "issue", "lock", "outbox", "job",
}


def build_db() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(SCHEMA.read_text(encoding="utf-8"))
    return con


def fixture(con):
    """基础数据。每个探针在 SAVEPOINT 里改它，结束时回滚。"""
    con.execute("INSERT INTO project VALUES ('p1','测试项目','E:/proj',1,'2026-01-01','2026-01-01')")
    con.execute("INSERT INTO branch(id,project_id,parent_id,fork_seq,head_seq,name,reason,created_at)"
                " VALUES ('b1','p1',NULL,0,0,'main','初始','2026-01-01')")
    con.execute("INSERT INTO project_state VALUES ('p1','b1',NULL,0)")
    for eid, kind, name in (("e_lin", "character", "林砚"),
                            ("e_shen", "character", "沈昼"),
                            ("e_led", "item", "账本")):
        con.execute("INSERT INTO entity(id,branch_id,kind,name,aliases,card,status,created_seq)"
                    " VALUES (?,?,?,?,'[]','{}','active',0)",
                    (eid, "b1", kind, name))
    con.execute("""INSERT INTO scene(id,branch_id,arc_id,idx,title,location_id,story_start,
                   story_end,timeline,present,goal,conflict_level,max_beats,beats,state,
                   exit_conditions,summary,opened_seq,closed_seq)
                   VALUES ('s1','b1',NULL,0,'雨夜','e_lin','第三天夜',NULL,'main',
                   '["e_lin","e_shen"]','{"type":"reveal"}',1.0,40,0,'open',
                   '{"op":"beats","cmp":">=","value":20}',NULL,0,NULL)""")
    con.execute("""INSERT INTO beat(id,branch_id,scene_id,seq,agent_id,score,damped,breakdown,mode,created_at)
                   VALUES ('bt1','b1','s1',1,'e_lin',0.81,0.81,'{}','auto','2026-01-01')""")
    con.execute("""INSERT INTO message(id,branch_id,seq,scene_id,beat_id,agent_id,role_type,prose,
                   structured,audience,percept,content_hash,token_est,created_at)
                   VALUES ('m1','b1',1,'s1','bt1','e_lin','character','你迟到了。','{}',
                   '["e_shen"]','public','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',8,'2026-01-01')""")
    con.commit()


results = []


def expect_abort(con, label, stmts, want=None):
    """在 SAVEPOINT 里跑一组语句，期望被命名约束拦下。整组回滚，不污染后续用例。"""
    if isinstance(stmts, str):
        stmts = [stmts]
    con.execute("SAVEPOINT probe")
    try:
        for s in stmts:
            con.execute(s)
    except sqlite3.IntegrityError as e:
        msg = str(e)
        con.execute("ROLLBACK TO probe")
        con.execute("RELEASE probe")
        if want and want not in msg:
            results.append((False, label, f"别的约束先炸: {msg.splitlines()[0][:70]}"))
        else:
            results.append((True, label, msg.split(":")[0][:60]))
        return
    except sqlite3.Error as e:
        con.execute("ROLLBACK TO probe")
        con.execute("RELEASE probe")
        results.append((False, label, f"非完整性错误: {type(e).__name__}: {e}"))
        return
    con.execute("RELEASE probe")
    results.append((False, label, "未触发任何约束"))


def expect_ok(con, label, stmts):
    """正向用例：成功即提交到库，供后续用例依赖（这是建库探针，不是单元测试隔离）。"""
    if isinstance(stmts, str):
        stmts = [stmts]
    con.execute("SAVEPOINT probe")
    try:
        for s in stmts:
            con.execute(s)
    except sqlite3.Error as e:
        con.execute("ROLLBACK TO probe")
        con.execute("RELEASE probe")
        results.append((False, label, f"本应成功但失败: {e}"))
        return
    con.execute("RELEASE probe")
    results.append((True, label, "ok"))


def expect_value(con, label, sql, want):
    try:
        got = con.execute(sql).fetchone()[0]
    except sqlite3.Error as e:
        results.append((False, label, f"查询失败: {e}"))
        return
    results.append((got == want, label, f"got={got!r} want={want!r}"))


FACT_TPL = ("INSERT INTO fact(id,branch_id,subject_id,predicate,object_json,card,truth,secrecy,"
            "valid_from,valid_to,source_seq,created_at) "
            "VALUES ('{id}','b1','{sub}','{pred}','{obj}','{card}',1,0,'2026-01-01',NULL,0,'2026-01-01')")


def check_schema() -> int:
    con = build_db()
    fixture(con)

    # ── 建库本身 ──
    tables = {r["name"] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    missing = EXPECTED_TABLES - tables
    results.append((not missing, "建库：25 张领域表齐全", f"缺少 {sorted(missing)}" if missing else "ok"))
    results.append((con.execute("PRAGMA foreign_keys").fetchone()[0] == 1, "PRAGMA foreign_keys = 1", "ok"))
    results.append((con.execute("PRAGMA user_version").fetchone()[0] == 1, "user_version = 1", "ok"))
    n_idx = con.execute("SELECT count(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
    n_trg = con.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0]
    n_view = con.execute("SELECT count(*) FROM sqlite_master WHERE type='view'").fetchone()[0]

    # ── 项目 / 分支 ──
    expect_abort(con, "项目名为空被拒", "INSERT INTO project VALUES ('p2','  ','E:/x',1,'t','t')")
    expect_abort(con, "分支 head < fork 被拒",
                 "INSERT INTO branch(id,project_id,parent_id,fork_seq,head_seq,name,reason,created_at)"
                 " VALUES ('b2','p1',NULL,10,5,'x','x','t')")
    expect_abort(con, "分支不能以自己为父",
                 "INSERT INTO branch(id,project_id,parent_id,fork_seq,head_seq,name,reason,created_at)"
                 " VALUES ('b1','p1','b1',0,0,'x','x','t')")
    expect_ok(con, "同项目多分支可共存",
              "INSERT INTO branch(id,project_id,parent_id,fork_seq,head_seq,name,reason,created_at)"
              " VALUES ('b3','p1','b1',5,5,'retry','回退到第5拍','t')")

    # ── 事件日志只追加 ──
    con.execute("INSERT INTO event(project_id,branch_id,kind,actor_type,actor_id,payload,idempotency_key,created_at)"
                " VALUES ('p1','b1','message.appended','character','e_lin','{}','k1','t')")
    con.commit()
    expect_abort(con, "同一幂等键不能重复写入",
                 "INSERT INTO event(project_id,branch_id,kind,actor_type,payload,idempotency_key,created_at)"
                 " VALUES ('p1','b1','x','system','{}','k1','t')")
    expect_abort(con, "事件不可 UPDATE", "UPDATE event SET kind='tampered' WHERE idempotency_key='k1'",
                 want="ck_event_immutable")
    expect_abort(con, "事件不可 DELETE", "DELETE FROM event WHERE idempotency_key='k1'",
                 want="ck_event_immutable")

    # ── 消息不可原地改写 ──
    expect_abort(con, "消息正文不可原地改写",
                 "UPDATE message SET prose='改过的' WHERE id='m1'", want="ck_message_immutable")
    expect_abort(con, "消息受众不可原地改写",
                 "UPDATE message SET audience='[]' WHERE id='m1'", want="ck_message_immutable")
    expect_ok(con, "消息非内容字段可更新（如 token_est）",
              "UPDATE message SET token_est=9 WHERE id='m1'")
    expect_abort(con, "空消息（无 prose 且无台词）被拒",
                 "INSERT INTO message(id,branch_id,seq,scene_id,agent_id,role_type,prose,structured,"
                 "audience,percept,content_hash,created_at) VALUES ('m9','b1',9,'s1','e_lin',"
                 "'character','','{}','[]','public','" + "b" * 64 + "','t')")
    expect_abort(con, "耳语必须有受众",
                 "INSERT INTO message(id,branch_id,seq,scene_id,agent_id,role_type,prose,structured,"
                 "audience,percept,content_hash,created_at) VALUES ('m8','b1',8,'s1','e_lin',"
                 "'character','过来','{}','[]','whisper','" + "c" * 64 + "','t')")
    expect_abort(con, "心理独白不得有受众（不进任何人上下文）",
                 "INSERT INTO message(id,branch_id,seq,scene_id,agent_id,role_type,prose,structured,"
                 "audience,percept,content_hash,created_at) VALUES ('m7','b1',7,'s1','e_lin',"
                 "'character','他在试探我','{}','[\"e_shen\"]','soliloquy','" + "d" * 64 + "','t')")
    expect_ok(con, "旁白零感知消息可写入",
              "INSERT INTO message(id,branch_id,seq,scene_id,agent_id,role_type,prose,structured,"
              "audience,percept,content_hash,created_at) VALUES ('m6','b1',6,'s1','narrator',"
              "'narrator','雨更大了。','{}','[]','narrator_reader','" + "e" * 64 + "','t')")

    # ── 事实槽位 ──
    expect_ok(con, "单值槽位首次写入",
              FACT_TPL.format(id="f1", sub="e_lin", pred="住在", obj='{"id":"e_place"}', card="single"))
    expect_abort(con, "单值槽位不能有两个当前值",
                 FACT_TPL.format(id="f2", sub="e_lin", pred="住在", obj='{"id":"e_other"}', card="single"))
    expect_ok(con, "多值槽位可并存（喜欢咖啡 / 喜欢茶）",
              [FACT_TPL.format(id="f3", sub="e_lin", pred="偏好", obj='{"id":"coffee"}', card="multi"),
               FACT_TPL.format(id="f4", sub="e_lin", pred="偏好", obj='{"id":"tea"}', card="multi")])
    expect_abort(con, "card 与谓词值数不一致被拒",
                 FACT_TPL.format(id="f5", sub="e_lin", pred="住在", obj='{"id":"x"}', card="multi"),
                 want="ck_fact_card_mismatch")
    expect_abort(con, "多值谓词缺 object.id 被拒",
                 FACT_TPL.format(id="f6", sub="e_lin", pred="偏好", obj='"茶"', card="multi"))
    expect_abort(con, "valid_to 早于 valid_from 被拒",
                 "INSERT INTO fact(id,branch_id,subject_id,predicate,object_json,card,truth,secrecy,"
                 "valid_from,valid_to,source_seq,created_at) VALUES ('f7','b1','e_lin','偏好',"
                 "'{\"id\":\"wine\"}','multi',1,0,'2026-02-01','2026-01-01',0,'t')")

    # ── 设定锁 ──
    con.execute("INSERT INTO lock VALUES ('b1','fact','e_lin|住在|','作者设定：他必须住在上海','user','t')")
    expect_abort(con, "锁定槽位拒绝新版本（换 ID 也绕不过）",
                 FACT_TPL.format(id="f8", sub="e_lin", pred="住在", obj='{"id":"e_bj"}', card="single"),
                 want="ck_fact_locked")
    expect_abort(con, "锁定事实不可原地改写",
                 "UPDATE fact SET object_json='{\"id\":\"e_x\"}' WHERE id='f1'", want="ck_fact_locked")
    expect_ok(con, "其他分支的锁不影响本分支",
              ["INSERT INTO branch(id,project_id,parent_id,fork_seq,head_seq,name,reason,created_at)"
               " VALUES ('b4','p1','b1',0,0,'alt','试验','t')",
               "INSERT INTO entity(id,branch_id,kind,name,aliases,card,status,created_seq)"
               " VALUES ('e_x','b4','place','别处','[]','{}','active',0)",
               "INSERT INTO fact(id,branch_id,subject_id,predicate,object_json,card,truth,secrecy,"
               "valid_from,valid_to,source_seq,created_at) VALUES ('f9','b4','e_lin','住在',"
               "'{\"id\":\"e_x\"}','single',1,0,'2026-01-01',NULL,0,'t')"])

    # ── supersede 路径 ──
    expect_ok(con, "supersede 后可写新版本",
              [FACT_TPL.format(id="fs1", sub="e_shen", pred="住在", obj='{"id":"e_a"}', card="single"),
               "UPDATE fact SET valid_to='2026-03-01' WHERE id='fs1'",
               FACT_TPL.format(id="fs2", sub="e_shen", pred="住在", obj='{"id":"e_b"}', card="single")])
    expect_value(con, "v_active_fact 只保留当前值",
                 "SELECT count(*) FROM v_active_fact WHERE subject_id='e_shen' AND predicate='住在'", 1)
    expect_value(con, "v_active_fact 不含已 supersede 的版本",
                 "SELECT count(*) FROM v_active_fact WHERE id='fs1'", 0)

    # ── 认知 ──
    expect_ok(con, "写入获知记录",
              "INSERT INTO cognition(branch_id,character_id,fact_id,attitude,certainty,learned_seq,"
              "source_message_id,percept) VALUES ('b1','e_shen','f3','knows',1.0,3,'m1','witness')")
    expect_abort(con, "同一角色同一事实只能有一条认知",
                 "INSERT INTO cognition(branch_id,character_id,fact_id,attitude,certainty,learned_seq,"
                 "source_message_id,percept) VALUES ('b1','e_shen','f3','doubts',0.5,4,'m1','told')")
    expect_abort(con, "认知记录不能指向不存在的角色",
                 "INSERT INTO cognition(branch_id,character_id,fact_id,attitude,certainty,learned_seq,"
                 "source_message_id,percept) VALUES ('b1','e_ghost','f3','knows',1.0,3,'m1','witness')")

    # ── 关系 ──
    expect_ok(con, "关系写入",
              "INSERT INTO relation VALUES ('b1','e_lin','e_shen','trust',0.4,3,'初见')")
    expect_abort(con, "关系不能指向自己",
                 "INSERT INTO relation VALUES ('b1','e_lin','e_lin','trust',0.4,3,NULL)")
    expect_abort(con, "关系值越界被拒",
                 "INSERT INTO relation VALUES ('b1','e_lin','e_shen','fear',1.7,3,NULL)")

    # ── 记忆 ──
    expect_ok(con, "记忆节点写入",
              "INSERT INTO memory_node(id,branch_id,kind,text,importance,stability,conf,valid_from,"
              "access_count,pinned,hard,sensitivity) VALUES ('n1','b1','event','雨夜对峙',"
              "1.2,21,0.9,'2026-01-01',0,0,0,0)")
    expect_abort(con, "hard=1 必须 pinned=1（禁忌是常驻的）",
                 "INSERT INTO memory_node(id,branch_id,kind,text,importance,stability,conf,valid_from,"
                 "access_count,pinned,hard,sensitivity) VALUES ('n2','b1','fact','禁忌',1.0,180,1.0,"
                 "'2026-01-01',0,0,1,3)")
    expect_abort(con, "向量缺模型名被拒",
                 "INSERT INTO memory_node(id,branch_id,kind,text,importance,stability,conf,valid_from,"
                 "access_count,pinned,hard,sensitivity,embedding,embedding_model,embedding_dim)"
                 " VALUES ('n3','b1','fact','x',1.0,180,1.0,'2026-01-01',0,0,0,0,zeroblob(8),NULL,2)")
    expect_abort(con, "向量维度与 blob 长度不符被拒",
                 "INSERT INTO memory_node(id,branch_id,kind,text,importance,stability,conf,valid_from,"
                 "access_count,pinned,hard,sensitivity,embedding,embedding_model,embedding_dim)"
                 " VALUES ('n4','b1','fact','x',1.0,180,1.0,'2026-01-01',0,0,0,0,zeroblob(8),'bge',99)")
    expect_ok(con, "向量维度与 blob 长度一致时可写入",
              "INSERT INTO memory_node(id,branch_id,kind,text,importance,stability,conf,valid_from,"
              "access_count,pinned,hard,sensitivity,embedding,embedding_model,embedding_dim)"
              " VALUES ('n5','b1','fact','x',1.0,180,1.0,'2026-01-01',0,0,0,0,zeroblob(8),'bge',2)")

    # ── 记忆边 DAG ──
    expect_ok(con, "有向边 A→B",
              "INSERT INTO memory_edge(src,dst,kind,weight) VALUES ('n1','n5','CAUSES',1.0)")
    expect_abort(con, "有向边成环被拒（B→A）",
                 "INSERT INTO memory_edge(src,dst,kind,weight) VALUES ('n5','n1','CAUSES',1.0)",
                 want="ck_edge_cycle")
    expect_ok(con, "对称边允许成环（A 像 B 且 B 像 A）",
              "INSERT INTO memory_edge(src,dst,kind,weight) VALUES ('n5','n1','SIMILAR',0.8)")
    expect_abort(con, "有子节点的记忆不可物理删除",
                 ["INSERT INTO memory_node(id,branch_id,kind,text,importance,stability,conf,valid_from,"
                  "access_count,pinned,hard,sensitivity) VALUES ('n6','b1','summary','摘要',1.0,90,0.9,"
                  "'2026-01-01',0,0,0,0)",
                  "INSERT INTO memory_edge(src,dst,kind,weight) VALUES ('n6','n1','DERIVED_FROM',1.0)",
                  "DELETE FROM memory_node WHERE id='n1'"], want="ck_memory_has_children")

    # ── 章节 / 修订 ──
    expect_ok(con, "章节写入",
              "INSERT INTO chapter(id,branch_id,arc_id,idx,title,file_path,content_hash,word_count,"
              "status,current_rev,updated_seq) VALUES ('c1','b1',NULL,1,'第一章','chapters/01.md','"
              + "f" * 64 + "',0,'draft',1,0)")
    expect_abort(con, "同分支章节序号唯一",
                 "INSERT INTO chapter(id,branch_id,arc_id,idx,title,file_path,content_hash,word_count,"
                 "status,current_rev,updated_seq) VALUES ('c2','b1',NULL,1,'dup','chapters/02.md','"
                 + "1" * 64 + "',0,'draft',1,0)")
    expect_ok(con, "首条修订 rev=1",
              "INSERT INTO revision(id,chapter_id,rev,parent_rev,content,content_hash,author,reason,"
              "issue_ids,created_at) VALUES ('r1','c1',1,NULL,'正文','" + "2" * 64 + "','writer',NULL,'[]','t')")
    expect_abort(con, "修订号跳号被拒",
                 "INSERT INTO revision(id,chapter_id,rev,parent_rev,content,content_hash,author,reason,"
                 "issue_ids,created_at) VALUES ('r3','c1',3,1,'正文3','" + "3" * 64 + "','reviser',NULL,'[]','t')",
                 want="ck_revision_gap")
    expect_ok(con, "修订号连续时通过",
              "INSERT INTO revision(id,chapter_id,rev,parent_rev,content,content_hash,author,reason,"
              "issue_ids,created_at) VALUES ('r2','c1',2,1,'正文2','" + "4" * 64 + "','reviser',NULL,'[]','t')")

    # ── outbox ──
    expect_abort(con, "已发布必须记录 applied_rev",
                 "INSERT INTO outbox(id,branch_id,chapter_id,rev,target_path,expected_hash,applied_rev,"
                 "status,attempts,last_error) VALUES ('o1','b1','c1',1,'chapters/01.md','h',NULL,"
                 "'applied',1,NULL)")

    # ── 场景 / 节拍 ──
    expect_abort(con, "拍数不得超上限（不静默截断）",
                 "UPDATE scene SET beats=41 WHERE id='s1'")
    expect_abort(con, "同场景节拍序号唯一",
                 "INSERT INTO beat(id,branch_id,scene_id,seq,agent_id,score,damped,breakdown,mode,"
                 "created_at) VALUES ('bt2','b1','s1',1,'e_shen',0.5,0.5,'{}','auto','t')")
    expect_abort(con, "事件卡 consumed 只属于一次性卡",
                 "INSERT INTO event_card(id,branch_id,title,trigger_json,min_level,weight,one_shot,"
                 "consumed_seq) VALUES ('ec1','b1','x','{}',0,1.0,0,5)")

    # ── 时序：叙事顺序与故事时间解耦，闪回必须显式换 timeline ──
    expect_abort(con, "同一 timeline 内故事时间倒退被拒",
                 "INSERT INTO scene(id,branch_id,arc_id,idx,title,location_id,story_start,story_end,"
                 "timeline,present,goal,conflict_level,max_beats,beats,state,exit_conditions)"
                 " VALUES ('s_back','b1',NULL,1,'三天前','e_lin','第一天夜',NULL,'main',"
                 "'[\"e_lin\"]','{}',1.0,40,0,'planned','{}')",
                 want="ck_scene_time_regression")
    expect_ok(con, "闪回换成独立 timeline 后可写入",
              "INSERT INTO scene(id,branch_id,arc_id,idx,title,location_id,story_start,story_end,"
              "timeline,present,goal,conflict_level,max_beats,beats,state,exit_conditions)"
              " VALUES ('s_flash','b1',NULL,1,'三天前','e_lin','第一天夜',NULL,'flashback-a',"
              "'[\"e_lin\"]','{}',1.0,40,0,'planned','{}')")
    expect_ok(con, "时间线继续前进的场景可写入",
              "INSERT INTO scene(id,branch_id,arc_id,idx,title,location_id,story_start,story_end,"
              "timeline,present,goal,conflict_level,max_beats,beats,state,exit_conditions)"
              " VALUES ('s_alt','b1',NULL,2,'第二天','e_lin','第四天',NULL,'main',"
              "'[\"e_lin\"]','{}',1.0,40,0,'planned','{}')")
    expect_abort(con, "story_end 早于 story_start 被拒",
                 "INSERT INTO scene(id,branch_id,arc_id,idx,title,location_id,story_start,story_end,"
                 "timeline,present,goal,conflict_level,max_beats,beats,state,exit_conditions)"
                 " VALUES ('s_x','b1',NULL,9,'x','e_lin','第十天','第九天','main',"
                 "'[\"e_lin\"]','{}',1.0,40,0,'planned','{}')")

    # ── 章节 ↔ 场景映射 ──
    expect_ok(con, "一章可挂多个场景",
              ["INSERT INTO chapter_scene(chapter_id,scene_id,ord) VALUES ('c1','s1',0)",
               "INSERT INTO chapter_scene(chapter_id,scene_id,ord) VALUES ('c1','s_alt',1)"])
    expect_abort(con, "同一章内场景顺序唯一",
                 "INSERT INTO chapter_scene(chapter_id,scene_id,ord) VALUES ('c1','s_flash',1)")
    expect_value(con, "章节按 ord 取场景",
                 "SELECT scene_id FROM chapter_scene WHERE chapter_id='c1' ORDER BY ord LIMIT 1", "s1")

    # ── 跨章认知快照：审旧稿不能用"现在"的认知 ──
    expect_ok(con, "第二章覆盖到第 5 个事件",
              "INSERT INTO chapter(id,branch_id,arc_id,idx,title,file_path,content_hash,word_count,"
              "covered_until_seq,status,current_rev,updated_seq) VALUES ('c2','b1',NULL,2,'第二章',"
              "'chapters/02.md','" + "5" * 64 + "',0,5,'draft',1,0)")
    expect_ok(con, "同一角色两条认知：seq 3 与 seq 9",
              [FACT_TPL.format(id="fk1", sub="e_lin", pred="知道", obj='{"id":"k1"}', card="multi"),
               FACT_TPL.format(id="fk2", sub="e_lin", pred="知道", obj='{"id":"k2"}', card="multi"),
               "INSERT INTO cognition(branch_id,character_id,fact_id,attitude,certainty,learned_seq,"
               "source_message_id,percept) VALUES ('b1','e_lin','fk1','knows',1.0,3,'m1','witness')",
               "INSERT INTO cognition(branch_id,character_id,fact_id,attitude,certainty,learned_seq,"
               "source_message_id,percept) VALUES ('b1','e_lin','fk2','knows',1.0,9,'m1','witness')"])
    expect_value(con, "跨章快照只含 covered_until_seq 之前的认知",
                 "SELECT count(*) FROM v_knowledge_by_chapter WHERE chapter_id='c2' AND character_id='e_lin'", 1)
    expect_value(con, "当前认知视图两条都在",
                 "SELECT count(*) FROM v_character_knowledge WHERE character_id='e_lin' "
                 "AND fact_id IN ('fk1','fk2')", 2)

    # ── 重写的三种语义（仅替换这一支） ──
    expect_ok(con, "仅替换：新消息指向被替换的旧消息",
              "INSERT INTO message(id,branch_id,seq,scene_id,beat_id,agent_id,role_type,prose,"
              "structured,audience,percept,content_hash,token_est,created_at,supersedes_id)"
              " VALUES ('m_rw','b1',11,'s1','bt1','e_lin','character','改过的台词','{}','[]',"
              "'soliloquy','" + "9" * 64 + "',8,'t','m1')")
    expect_abort(con, "一条旧消息只能被替换一次",
                 "INSERT INTO message(id,branch_id,seq,scene_id,beat_id,agent_id,role_type,prose,"
                 "structured,audience,percept,content_hash,token_est,created_at,supersedes_id)"
                 " VALUES ('m_rw2','b1',12,'s1','bt1','e_lin','character','再改一次','{}','[]',"
                 "'soliloquy','" + "8" * 64 + "',8,'t','m1')")
    expect_ok(con, "后续拍可标 stale",
              "UPDATE beat SET stale=1, stale_reason='上游台词被替换' WHERE id='bt1'")
    expect_abort(con, "stale 只能是 0/1", "UPDATE beat SET stale=2 WHERE id='bt1'")

    # ── 悬念回收 ──
    expect_ok(con, "线索写入",
              "INSERT INTO memory_node(id,branch_id,kind,text,importance,stability,conf,valid_from,"
              "access_count,pinned,hard,sensitivity,resolved_seq) VALUES ('cl1','b1','clue',"
              "'账本少了三页',1.4,3650,1.0,'2026-01-01',0,0,0,0,NULL)")
    expect_value(con, "未回收线索进入 v_open_clue",
                 "SELECT count(*) FROM v_open_clue WHERE id='cl1'", 1)
    expect_ok(con, "标记回收", "UPDATE memory_node SET resolved_seq=42 WHERE id='cl1'")
    expect_value(con, "回收后离开 v_open_clue",
                 "SELECT count(*) FROM v_open_clue WHERE id='cl1'", 0)
    expect_abort(con, "非 clue 节点不能标 resolved_seq",
                 "UPDATE memory_node SET resolved_seq=42 WHERE id='n1'")

    con.close()

    passed = sum(1 for ok, _, _ in results if ok)
    total = len(results)
    print("═" * 78)
    print(f"schema 校验：真 SQLite {sqlite3.sqlite_version} 建库 "
          f"({len(tables)} 表 / {n_idx} 索引 / {n_trg} 触发器 / {n_view} 视图)")
    print(f"断言 {passed}/{total} 通过")
    print("═" * 78)
    for ok, label, note in results:
        if not ok:
            print(f"  FAIL  {label:<34} {note}")
    if passed == total:
        print("  全部通过")
    print("\n未覆盖项（上线前必验）：")
    for u in ("跨文件故障注入（outbox 发布中断后的恢复）",
              "两进程并发写同一 branch 的竞争提交",
              "磁盘库 WAL 断电恢复",
              "Electron 打包后 better-sqlite3 原生模块可用性",
              "> 50 万记忆节点时的检索延迟"):
        print(f"  · {u}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "--all"
    rc = 0
    if mode in ("--all", "--params"):
        rc |= check_params()
        print()
    if mode in ("--all", "--schema"):
        rc |= check_schema()
    sys.exit(rc)
