/**
 * 端到端测试 — 覆盖完整管线 + 词表标准化
 */

import { initSchema } from "../packages/db/src/schema";
import { getDB } from "../packages/db/src/database";
import { processMessage } from "../packages/pipeline/src/pipeline";
import { recall, getStats, getTagStats, getEmotionStats } from "../packages/retrieval/src/recall";
import { normalizeTag, normalizeTags } from "../packages/domain/src/tag-vocabulary";
import { normalizeEmotion } from "../packages/domain/src/emotion-vocabulary";

const db = getDB();
initSchema(db);

// 清理
db.exec("DELETE FROM entity_events; DELETE FROM entities; DELETE FROM memory_events; DELETE FROM pipeline_status;");

console.log("=== 词表标准化测试 ===\n");

// 标签标准化
const tagTests: [string, string | null][] = [
  ["夜醒", "夜醒"],
  ["睡觉", "自主入睡"],
  ["长牙", "出牙"],
  ["打针", "疫苗"],
  ["压力大", "育儿压力"],
  ["不存在的标签", null],
];
for (const [input, expected] of tagTests) {
  const result = normalizeTag(input);
  const ok = result === expected ? "✅" : "❌";
  console.log(`${ok} tag: "${input}" → "${result}" (expect: "${expected}")`);
}

console.log("");

// 情绪标准化
const emotionTests: [string, string | null][] = [
  ["崩溃", "崩溃"],
  ["好累", "疲惫"],
  ["高兴", "开心"],
  ["欣慰", "满足"],
  ["慌", "焦虑"],
  ["不存在的情绪", null],
];
for (const [input, expected] of emotionTests) {
  const result = normalizeEmotion(input);
  const word = result?.word ?? null;
  const ok = word === expected ? "✅" : "❌";
  console.log(`${ok} emotion: "${input}" → "${word}" (expect: "${expected}")`);
}

console.log("\n=== 管线测试 ===\n");

const testCases = [
  {
    name: "多事件拆分",
    input: "今天带星星去打了疫苗，她哭了一会儿就好了。回来路上睡着了，应该是太累了。",
    expectEvents: 2,
    expectTags: ["疫苗"],
    expectEmotion: "",  // LLM 情绪不固定
  },
  {
    name: "情绪+标签标准化",
    input: "星星昨晚又醒了三次，我快崩溃了，爸爸倒是睡得很香",
    expectEvents: 1,
    expectTags: ["夜醒"],
    expectEmotion: "崩溃",
  },
  {
    name: "里程碑事件",
    input: "今天星星自己站起来走了三步！太厉害了！全家都鼓掌",
    expectEvents: 1,
    expectTags: [],    // LLM 标签由模型决定，不强制
    expectEmotion: "", // 开心/自豪 都合理
  },
  {
    name: "噪声过滤",
    input: "嗯嗯",
    expectEvents: 0,
    expectTags: [],
    expectEmotion: "",
  },
  {
    name: "工作压力",
    input: "最近工作压力特别大，每天加班到很晚。回家孩子都睡了，感觉亏欠他们。",
    expectEvents: 1,
    expectTags: ["工作压力"],
    expectEmotion: "",  // 压力/愧疚/疲惫 都合理
  },
];

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  console.log(`--- ${tc.name} ---`);
  console.log(`输入: "${tc.input}"`);
  
  const result = await processMessage(tc.input, { userId: "test" });
  
  if (result.skipped) {
    if (tc.expectEvents === 0) {
      console.log("✅ 正确跳过（噪声）");
      passed++;
    } else {
      console.log("❌ 意外跳过");
      failed++;
    }
    console.log("");
    continue;
  }
  
  console.log(`抽取: ${result.events.length} 个事件`);
  
  // 检查事件数
  if (result.events.length >= tc.expectEvents) {
    console.log(`✅ 事件数 >= ${tc.expectEvents}`);
  } else {
    console.log(`❌ 事件数 ${result.events.length} < ${tc.expectEvents}`);
    failed++;
  }
  
  // 检查标签
  if (tc.expectTags.length > 0) {
    const allTags = result.events.flatMap(e => e.tags);
    for (const expectedTag of tc.expectTags) {
      if (allTags.includes(expectedTag)) {
        console.log(`✅ 包含标签: ${expectedTag}`);
      } else {
        console.log(`❌ 缺少标签: ${expectedTag} (实际: ${allTags.join(", ")})`);
        failed++;
      }
    }
  }
  
  // 检查情绪
  if (tc.expectEmotion) {
    const emotions = result.events.map(e => e.emotion.primary);
    if (emotions.includes(tc.expectEmotion)) {
      console.log(`✅ 情绪匹配: ${tc.expectEmotion}`);
    } else {
      console.log(`❌ 情绪不匹配: 期望 ${tc.expectEmotion}, 实际 ${emotions.join(", ")}`);
      failed++;
    }
  }
  
  for (const event of result.events) {
    console.log(`  - [${event.event_type}] ${event.summary}`);
    console.log(`    entities: ${event.entities.join(", ")}`);
    console.log(`    emotion: ${event.emotion.primary} (${event.emotion.intensity}) ${event.emotion.valence}`);
    console.log(`    tags: ${event.tags.join(", ") || "(无)"}`);
  }
  
  passed++;
  console.log("");
}

console.log("=== 检索测试 ===\n");

// 实体检索
const r1 = recall({ entities: ["星星"] });
console.log(`按实体[星星]查: ${r1.total} 条`);

// 类型检索
const r2 = recall({ event_types: ["sleep"] });
console.log(`按类型[sleep]查: ${r2.total} 条`);

// 标签检索（标准化）
const r3 = recall({ tags: ["睡觉"] }); // 应该标准化为"自主入睡"
console.log(`按标签[睡觉→自主入睡]查: ${r3.total} 条`);

// 情绪检索
const r4 = recall({ emotions: ["崩溃"] });
console.log(`按情绪[崩溃]查: ${r4.total} 条`);

// valence 检索
const r5 = recall({ valence: "negative" });
console.log(`按 valence[negative]查: ${r5.total} 条`);

// 全文搜索
const r6 = recall({ text: "疫苗" });
console.log(`全文搜索[疫苗]: ${r6.total} 条`);

console.log("\n=== 统计 ===\n");

const stats = getStats();
console.log(`总事件: ${stats.totalEvents}`);
console.log(`按类型: ${stats.byType.map((t: any) => `${t.event_type}(${t.c})`).join(", ")}`);

const tagStats = getTagStats();
console.log(`标签: ${tagStats.slice(0, 5).map(t => `${t.tag}(${t.count})`).join(", ")}`);

const emotionStats = getEmotionStats();
console.log(`情绪: ${emotionStats.slice(0, 5).map(e => `${e.emotion}(${e.count})`).join(", ")}`);

console.log(`\n✅ 测试完成 (${passed} passed, ${failed} failed)`);

// 清理
db.exec("DELETE FROM entity_events; DELETE FROM entities; DELETE FROM memory_events; DELETE FROM pipeline_status;");

if (failed > 0) process.exit(1);
