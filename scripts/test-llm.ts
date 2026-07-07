/**
 * 测试 LLM 抽取（从 .env 读取 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY）
 */
import { classify } from "../packages/extractors/src/classify";
import { extract } from "../packages/extractors/src/extract";

async function main() {
  console.log("=== LLM 抽取测试 ===\n");

  const testCases = [
    "星星昨晚又醒了三次，我快崩溃了，爸爸倒是睡得很香",
    "今天带星星去打了疫苗，她哭了一会儿就好了，回来路上睡着了",
    "最近工作压力好大，客户一直在改需求，宝宝们又不太听话，感觉快要撑不住了",
    "嗯嗯",
    "禾禾今天第一次自己用勺子吃饭，虽然弄得到处都是，但真的很棒",
  ];

  for (const text of testCases) {
    console.log(`\n--- 输入: "${text}" ---`);
    
    try {
      const cls = await classify(text);
      console.log(`分类: meaningful=${cls.is_meaningful}, category=${cls.category}`);
      
      if (cls.is_meaningful) {
        const events = await extract(text);
        for (const e of events) {
          console.log(`  事件: [${e.event_type}] ${e.summary}`);
          console.log(`  实体: ${e.entities.join(", ")}`);
          console.log(`  情绪: ${e.emotion.primary} (${e.emotion.intensity.toFixed(1)}) ${e.emotion.valence}`);
          console.log(`  标签: ${e.tags.join(", ") || "(无)"}`);
        }
      } else {
        console.log("⏭ 无意义，跳过");
      }
    } catch (e) {
      console.error("❌ 错误:", e instanceof Error ? e.message : e);
    }
  }

  console.log("\n✅ 测试完成");
}

main().catch(console.error);
