import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const {
  createCareItem, listDeliverableCare, takeCareLineForWechat,
  dismissCare, closeCareByTopics, countCareCreatedToday, getCareItem,
} = await import("./care-queue");

describe("pending care queue", () => {
  let dbPath = "";
  const owner = "care-owner-1";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-care-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("creates and lists deliverable items once trigger time passes", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const ready = createCareItem({ owner_id: owner, kind: "concern", topic: "星星发烧", content: "星星退烧了吗？", trigger_after: past });
    const notYet = createCareItem({ owner_id: owner, kind: "concern", topic: "下周面试", content: "面试怎么样？", trigger_after: future });
    expect(ready).not.toBeNull();
    expect(notYet).not.toBeNull();

    const deliverable = listDeliverableCare({ owner_id: owner });
    expect(deliverable.map(item => item.id)).toEqual([ready!.id]);
  });

  test("dedupes pending items with same owner/kind/topic", () => {
    expect(createCareItem({ owner_id: owner, kind: "concern", topic: "星星发烧", content: "第一句" })).not.toBeNull();
    expect(createCareItem({ owner_id: owner, kind: "concern", topic: "星星发烧", content: "第二句" })).toBeNull();
    // 不同 kind 不互斥
    expect(createCareItem({ owner_id: owner, kind: "anticipation", topic: "星星发烧", content: "第三句" })).not.toBeNull();
  });

  test("dedupes echo by source event id", () => {
    expect(createCareItem({ owner_id: owner, kind: "echo", content: "回声一", source_event_id: "evt-1" })).not.toBeNull();
    expect(createCareItem({ owner_id: owner, kind: "echo", content: "回声二", source_event_id: "evt-1" })).toBeNull();
  });

  test("wechat take delivers at most one item per local day", () => {
    createCareItem({ owner_id: owner, kind: "concern", topic: "a", content: "第一条" });
    createCareItem({ owner_id: owner, kind: "concern", topic: "b", content: "第二条" });

    const first = takeCareLineForWechat({ owner_id: owner });
    expect(first).not.toBeNull();
    expect(first!.status).toBe("delivered");
    expect(first!.delivered_via).toBe("wechat");

    // 当天第二次：不再投递
    expect(takeCareLineForWechat({ owner_id: owner })).toBeNull();
    // 第一条已 delivered，不再出现在可投递列表
    expect(listDeliverableCare({ owner_id: owner }).map(item => item.topic)).toEqual(["b"]);
  });

  test("expired items are lazily marked and not delivered", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const item = createCareItem({ owner_id: owner, kind: "echo", content: "过期回声", trigger_after: past, expires_at: past });
    expect(item).not.toBeNull();
    expect(listDeliverableCare({ owner_id: owner })).toHaveLength(0);
    expect(getCareItem(item!.id)?.status).toBe("expired");
  });

  test("dismiss closes the item and it never comes back", () => {
    const item = createCareItem({ owner_id: owner, kind: "anticipation", topic: "体检", content: "体检顺利吗？" })!;
    expect(dismissCare({ id: item.id, owner_id: owner })).toBe(true);
    expect(listDeliverableCare({ owner_id: owner })).toHaveLength(0);
    expect(getCareItem(item.id)?.status).toBe("closed");
    // 错误 owner 无法关闭别人的
    const other = createCareItem({ owner_id: owner, kind: "concern", topic: "x", content: "y" })!;
    expect(dismissCare({ id: other.id, owner_id: "someone-else" })).toBe(false);
  });

  test("closeCareByTopics resolves matching pending threads", () => {
    createCareItem({ owner_id: owner, kind: "concern", topic: "星星发烧", content: "退烧了吗" });
    createCareItem({ owner_id: owner, kind: "concern", topic: "失眠", content: "睡得好点了吗" });
    const closed = closeCareByTopics({ owner_id: owner, topics: ["星星发烧", "不存在的"] });
    expect(closed).toBe(1);
    expect(listDeliverableCare({ owner_id: owner }).map(item => item.topic)).toEqual(["失眠"]);
  });

  test("countCareCreatedToday counts per kind", () => {
    createCareItem({ owner_id: owner, kind: "echo", content: "回声", source_event_id: "e1" });
    expect(countCareCreatedToday(owner, "echo")).toBe(1);
    expect(countCareCreatedToday(owner, "concern")).toBe(0);
  });
});
