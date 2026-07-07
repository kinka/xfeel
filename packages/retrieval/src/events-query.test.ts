import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../../db/src/schema";
import { buildEventsQuery, queryEvents } from "./events-query";

const DAD = "demo-dad-owner";
const MOM = "demo-mom-owner";

describe("buildEventsQuery", () => {
  test("无筛选时不带 WHERE，使用默认分页", () => {
    const q = buildEventsQuery();
    expect(q.sql).not.toContain("WHERE");
    expect(q.countSql).not.toContain("WHERE");
    expect(q.params).toEqual([]);
    expect(q.limit).toBe(20);
    expect(q.offset).toBe(0);
  });

  test("owner 筛选映射到 user_id", () => {
    const q = buildEventsQuery({ owner: DAD });
    expect(q.sql).toContain("user_id = ?");
    expect(q.params).toEqual([DAD]);
  });

  test("since/until 按 event_date 过滤", () => {
    const q = buildEventsQuery({ since: "2025-01-01", until: "2025-01-31" });
    expect(q.sql).toContain("NULLIF(event_date, '')");
    expect(q.sql).toContain(">= ?");
    expect(q.sql).toContain("<= ?");
    expect(q.params).toEqual(["2025-01-01", "2025-01-31"]);
  });

  test("非法日期格式抛错", () => {
    expect(() => buildEventsQuery({ since: "2025/01/01" })).toThrow("since must be YYYY-MM-DD");
    expect(() => buildEventsQuery({ until: "yesterday" })).toThrow("until must be YYYY-MM-DD");
  });

  test("limit 被钳制在 [1, 500]", () => {
    expect(buildEventsQuery({ limit: 0 }).limit).toBe(1);
    expect(buildEventsQuery({ limit: 99999 }).limit).toBe(500);
    expect(buildEventsQuery({ offset: -5 }).offset).toBe(0);
  });
});

describe("queryEvents (in-memory db)", () => {
  function makeDB() {
    const db = new Database(":memory:");
    initSchema(db);
    const insert = db.prepare(`
      INSERT INTO memory_events (id, summary, original_text, event_type, entities, emotion, tags, event_time, event_date, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("e1", "星星第一次站起来", "星星今天第一次站起来了", "milestone",
      JSON.stringify(["星星"]), JSON.stringify({ primary: "开心" }), JSON.stringify(["里程碑"]),
      "2025-01-10T09:00:00", "2025-01-10", MOM);
    insert.run("e2", "夜醒三次", "昨晚星星夜醒三次", "sleep",
      JSON.stringify(["星星"]), JSON.stringify({ primary: "疲惫" }), JSON.stringify(["夜醒"]),
      "2025-01-15T07:00:00", "2025-01-15", DAD);
    insert.run("e3", "打疫苗", "今天带星星打疫苗", "health",
      JSON.stringify(["星星", "妈妈"]), JSON.stringify({ primary: "担心" }), JSON.stringify(["疫苗"]),
      "2025-02-01T10:00:00", "2025-02-01", MOM);
    return db;
  }

  test("owner 筛选只返回对应 owner 的事件", () => {
    const db = makeDB();
    const dad = queryEvents(db, { owner: DAD });
    expect(dad.total).toBe(1);
    expect((dad.events[0] as { id: string }).id).toBe("e2");
    const mom = queryEvents(db, { owner: MOM });
    expect(mom.total).toBe(2);
  });

  test("日期范围筛选（含边界）", () => {
    const db = makeDB();
    const jan = queryEvents(db, { since: "2025-01-01", until: "2025-01-31" });
    expect(jan.total).toBe(2);
    expect((jan.events as { id: string }[]).map(e => e.id).sort()).toEqual(["e1", "e2"]);
    const fromFeb = queryEvents(db, { since: "2025-02-01" });
    expect(fromFeb.total).toBe(1);
    expect((fromFeb.events[0] as { id: string }).id).toBe("e3");
  });

  test("日期范围在 event_date 缺失时回退到 created_at", () => {
    const db = makeDB();
    db.prepare(`
      INSERT INTO memory_events (id, summary, original_text, event_type, entities, emotion, tags, event_time, event_date, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "created-fallback",
      "created_at 兜底",
      "created_at 兜底",
      "daily",
      JSON.stringify(["星星"]),
      JSON.stringify({ primary: "平静" }),
      JSON.stringify([]),
      null,
      "",
      DAD,
      "2025-01-20T08:00:00.000Z",
    );

    const jan = queryEvents(db, { since: "2025-01-20", until: "2025-01-20" });
    expect((jan.events as { id: string }[]).map(event => event.id)).toContain("created-fallback");
  });

  test("created_at 兜底按本地时区分日", () => {
    const db = makeDB();
    db.prepare(`
      INSERT INTO memory_events (id, summary, original_text, event_type, entities, emotion, tags, event_time, event_date, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "beijing-date-fallback",
      "北京时间日期兜底",
      "北京时间日期兜底",
      "daily",
      JSON.stringify(["星星"]),
      JSON.stringify({ primary: "平静" }),
      JSON.stringify([]),
      null,
      "",
      DAD,
      "2025-01-14T17:30:00.000Z",
    );

    const jan15 = queryEvents(db, { since: "2025-01-15", until: "2025-01-15" });
    expect((jan15.events as { id: string }[]).map(event => event.id)).toContain("beijing-date-fallback");
  });

  test("owner + 日期 + 情绪组合筛选", () => {
    const db = makeDB();
    const r = queryEvents(db, { owner: MOM, since: "2025-01-01", emotion: "担心" });
    expect(r.total).toBe(1);
    expect((r.events[0] as { id: string }).id).toBe("e3");
  });

  test("tag / entity / type 筛选", () => {
    const db = makeDB();
    expect(queryEvents(db, { tag: "夜醒" }).total).toBe(1);
    expect(queryEvents(db, { entity: "妈妈" }).total).toBe(1);
    expect(queryEvents(db, { type: "milestone" }).total).toBe(1);
  });

  test("分页：total 不受 limit 影响，按时间倒序", () => {
    const db = makeDB();
    const page = queryEvents(db, { limit: 2 });
    expect(page.total).toBe(3);
    expect(page.events.length).toBe(2);
    expect((page.events[0] as { id: string }).id).toBe("e3");
    const next = queryEvents(db, { limit: 2, offset: 2 });
    expect((next.events[0] as { id: string }).id).toBe("e1");
  });
});
