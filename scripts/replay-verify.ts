/**
 * 真实回放验证：拿真实消息走一遍最新的 handleProductMessage（真实 LLM）。
 * 写入只落到 XFEEL_DB_PATH 指向的拷贝库，不污染生产库。
 *
 * 用法：XFEEL_DB_PATH=/tmp/xfeel-replay.db bun run scripts/replay-verify.ts
 */
import { getDB } from "../packages/db/src/database";
import { getAliasContextForSpeaker } from "../packages/db/src/family";
import { handleProductMessage } from "../packages/conversation/src/product-loop";

const OWNER = "demo-dad-owner"; // 爸爸
const FAMILY = "xfeel-family-main";
const DATE = "2026-06-18";

const MESSAGES = [
  "爸爸上次压力大是什么时候",
  "更早之前呢",
];

async function main() {
  const db = getDB();
  console.log(`回放库：${db.filename}\n${"=".repeat(60)}`);
  const aliasContext = getAliasContextForSpeaker({ family_id: FAMILY }, db) || undefined;

  for (const text of MESSAGES) {
    console.log(`\n👤 用户：${text}`);
    const t0 = Date.now();
    const result = await handleProductMessage({
      text,
      owner_id: OWNER,
      date: DATE,
      aliasContext,
    });
    const ms = Date.now() - t0;
    console.log(`🤖 助手[intent=${result.intent}, ${ms}ms]：${result.reply}`);
    const events = "events" in result ? result.events : [];
    if (events && events.length) {
      console.log(`   召回 ${events.length} 条：`);
      for (const e of events.slice(0, 6)) {
        console.log(`     - ${e.event_time ? e.event_time.slice(0, 10) + " " : ""}${e.summary}${e.emotion ? `（${e.emotion}）` : ""}`);
      }
    } else {
      console.log("   召回：无");
    }
  }
  console.log(`\n${"=".repeat(60)}\n完成（生产库未改动）。`);
}

main().catch(e => { console.error("回放失败：", e); process.exit(1); });
