/**
 * 回放验证：对比“有/无 长期理解(L3)+近期状态(L2)”时的共情回复差异。
 * 对每条消息各跑两遍（关闭/开启理解层），直观看出“懂这个人”带来的不同。
 * 只写入 XFEEL_DB_PATH 指向的拷贝库。
 *
 * 用法：XFEEL_DB_PATH=/tmp/xfeel-replay.db bun run scripts/replay-profile.ts
 */
import { getDB } from "../packages/db/src/database";
import { chatWithMemory } from "../packages/conversation/src/conversation";
import { loadUnderstandingContext } from "../packages/conversation/src/memory/profile-context";
import { resolveOwnerLabel } from "../packages/domain/src/owner";

const OWNER = process.env.REPLAY_OWNER || "demo-dad-owner"; // 爸爸
const DATE = process.env.REPLAY_DATE || "2026-06-19";

// 共情/倾诉类（不是事实检索）：最能体现“理解层”是否在起作用。
const MESSAGES = [
  "今天有点累，感觉自己哪哪都没做好",
  "阿星昨晚又咳嗽了，半夜咳得我有点慌",
  "项目今天被领导当众表扬了，但我心里还是有点虚",
];

async function runOnce(text: string, useUnderstanding: boolean): Promise<string> {
  if (useUnderstanding) delete process.env.XFEEL_UNDERSTANDING_DISABLED;
  else process.env.XFEEL_UNDERSTANDING_DISABLED = "1";
  const result = await chatWithMemory({ text, owner_id: OWNER, date: DATE, mode: "chat" });
  return result.reply;
}

async function main() {
  const db = getDB();
  const label = resolveOwnerLabel(OWNER) || OWNER;
  console.log(`回放库：${db.filename}\nowner=${label} date=${DATE}\n${"=".repeat(70)}`);

  const ctx = loadUnderstandingContext({ owner_id: OWNER });
  console.log(`\n注入的理解层（hasLongTerm=${ctx.hasLongTerm}, hasRecent=${ctx.hasRecent}）：\n${ctx.text ? ctx.text.slice(0, 800) + (ctx.text.length > 800 ? "…" : "") : "（无）"}`);
  console.log(`\n${"=".repeat(70)}`);

  for (const text of MESSAGES) {
    console.log(`\n👤 用户：${text}`);
    const without = await runOnce(text, false);
    console.log(`\n🅰️  无理解层：\n   ${without.replace(/\n/g, "\n   ")}`);
    const withU = await runOnce(text, true);
    console.log(`\n🅱️  有理解层（懂这个人）：\n   ${withU.replace(/\n/g, "\n   ")}`);
    console.log(`\n${"-".repeat(70)}`);
  }

  delete process.env.XFEEL_UNDERSTANDING_DISABLED;
  console.log("\n完成（生产库未改动）。");
}

main().catch(e => { console.error("回放失败：", e); process.exit(1); });
