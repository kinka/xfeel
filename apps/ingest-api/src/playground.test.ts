import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../../../packages/ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chat() {
        throw new Error("LLM unavailable in test");
      },
      async chatJSON(...args: unknown[]) {
        const serialized = JSON.stringify(args);
        if (serialized.includes("超慢处理")) {
          await new Promise(resolve => setTimeout(resolve, 700));
        } else if (serialized.includes("慢处理")) {
          await new Promise(resolve => setTimeout(resolve, 260));
        }
        throw new Error("LLM unavailable in test");
      },
    };
  },
}));

process.env.XFEEL_AUTH_DISABLED = "1"; // 测试内直连数据接口，旁路 JWT 登录门
process.env.WECHAT_RETRY_HOLD_TIMEOUT_MS = "150";
process.env.WECHAT_FINAL_RETRY_REPLY_TIMEOUT_MS = "300";
process.env.WECHAT_DISPLAYABLE_ATTEMPT = "3";

const { buildApp } = await import("./server");
const { closeDB, getDB } = await import("../../../packages/db/src/database");
const { upsertProfile } = await import("../../../packages/conversation/src/memory/profile-repository");

describe("conversation playground", () => {
  let dbPath = "";
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-playground-${crypto.randomUUID()}.db`);
    process.env.XFEEL_DB_PATH = dbPath;
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    closeDB();
    delete process.env.XFEEL_DB_PATH;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("defaults the playground owner selector to dad", async () => {
    const res = await app.inject({ method: "GET", url: "/conversation/playground" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<option value="demo-dad-owner" selected>爸爸</option>');
  });

  test("exposes day navigation, URL state, and archive preview controls", async () => {
    const res = await app.inject({ method: "GET", url: "/conversation/playground" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-testid="day-summary"');
    expect(res.body).toContain('data-testid="yesterday"');
    expect(res.body).toContain('data-testid="archive-preview"');
    expect(res.body).toContain("URLSearchParams(location.search)");
    expect(res.body).toContain("/^\\d{4}-\\d{2}-\\d{2}$/");
    expect(res.body).toContain("dry_run:dryRun");
  });

  test("understanding feedback API changes the effective statement immediately", async () => {
    const item = {
      category: "interaction_preference", subject: "记录者", statement: "遇到压力时希望马上听建议。",
      kind: "inferred", status: "active", confidence: 0.7,
      support: { evidenceCount: 2, consistency: 1, userConfirmed: false },
      supportDates: ["2026-05-01", "2026-06-01"],
    } as const;
    upsertProfile({ ownerId: "owner-understanding", layer: "long_term",
      content: { narrative: "", understandings: [item], addressBook: [], openQuestions: [] } });

    const before = await app.inject({ method: "GET", url: "/understanding?owner_id=owner-understanding" });
    expect(before.statusCode).toBe(200);
    const key = before.json().understandings[0].key;
    const saved = await app.inject({ method: "POST", url: "/understanding/feedback", payload: {
      owner_id: "owner-understanding", key, action: "correct", replacement_statement: "先听我说完，再一起想办法。",
    } });
    expect(saved.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/understanding?owner_id=owner-understanding" });
    expect(after.json().understandings[0].statement).toContain("先听我说完");
    expect(after.json().understandings[0].feedback.action).toBe("correct");
  });

  test("uses family owner ids for the playground dad and mom selectors", async () => {
    const db = getDB();
    db.prepare("INSERT INTO families (id, name) VALUES (?, ?)").run("xfeel-family-main", "真实家庭");
    db.prepare("INSERT INTO family_members (id, family_id, label, role) VALUES (?, ?, ?, ?)").run("real-dad", "xfeel-family-main", "爸爸", "parent");
    db.prepare("INSERT INTO family_members (id, family_id, label, role) VALUES (?, ?, ?, ?)").run("real-mom", "xfeel-family-main", "妈妈", "parent");
    db.prepare(`
      INSERT INTO family_settings (family_id, timezone, record_mode, default_owner_id, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run("xfeel-family-main", "Asia/Shanghai", "balanced", "real-dad", "{}");

    const page = await app.inject({ method: "GET", url: "/conversation/playground" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<option value="real-dad" selected>爸爸</option>');
    expect(page.body).toContain('<option value="real-mom">妈妈</option>');

    const diagnostics = await app.inject({
      method: "GET",
      url: "/conversation/playground/diagnostics?date=2026-06-22",
    });
    expect(JSON.parse(diagnostics.body).owner_id).toBe("real-dad");
  });

  test("diagnostics joins turn metadata with pipeline status and extracted events", async () => {
    const db = getDB();
    db.prepare(`
      INSERT INTO conversation_turns (id, owner_id, role, content, turn_date, source, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "turn-1",
      "demo-dad-owner",
      "user",
      "今天星星睡前哭了一会儿。",
      "2026-06-22",
      "log",
      JSON.stringify({
        mode: "log_with_contextual_reply",
        pipeline_message_id: "msg-1",
        current_event_ids: ["event-1"],
      }),
      "2026-06-22T10:00:00.000Z",
    );
    db.prepare(`
      INSERT INTO pipeline_status (message_id, stage, status, result)
      VALUES (?, ?, ?, ?)
    `).run("msg-1", "indexed", "done", JSON.stringify({ stored: 1 }));
    db.prepare(`
      INSERT INTO memory_events (
        id, raw_message_id, summary, original_text, event_type, entities, emotion, tags, event_date, event_time, user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "event-1",
      "msg-1",
      "星星睡前哭了一会儿",
      "今天星星睡前哭了一会儿。",
      "sleep",
      JSON.stringify(["小星"]),
      JSON.stringify({ primary: "难过" }),
      JSON.stringify(["睡前"]),
      "2026-06-22",
      "2026-06-22T10:00:00.000Z",
      "demo-dad-owner",
    );

    const res = await app.inject({
      method: "GET",
      url: "/conversation/playground/diagnostics?owner_id=demo-dad-owner&date=2026-06-22",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      owner_id: string;
      date: string;
      diagnostics: Array<{
        intent: string;
        pipeline: { stage: string; status: string; result: { stored: number } } | null;
        current_events: Array<{ id: string; summary: string; entities: string[]; emotion: { primary: string } }>;
      }>;
    };
    expect(body.owner_id).toBe("demo-dad-owner");
    expect(body.date).toBe("2026-06-22");
    expect(body.diagnostics[0]?.intent).toBe("log_with_contextual_reply");
    expect(body.diagnostics[0]?.pipeline).toMatchObject({ stage: "indexed", status: "done", result: { stored: 1 } });
    expect(body.diagnostics[0]?.current_events[0]).toMatchObject({
      id: "event-1",
      summary: "星星睡前哭了一会儿",
      entities: ["小星"],
      emotion: { primary: "难过" },
    });
  });
});
