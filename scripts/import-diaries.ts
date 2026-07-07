/**
 * 导入已有日记到记忆管线
 * 
 * 用法：
 *   bun run scripts/import-diaries.ts                    # 导入内置 demo 日记（examples/demo-diaries）
 *   bun run scripts/import-diaries.ts /path/to/diaries   # 导入指定目录
 *   bun run scripts/import-diaries.ts --skip-llm         # 跳过 LLM，仅用规则抽取
 *   bun run scripts/import-diaries.ts --dry-run          # 只分类，不入库
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, join } from "path";
import { getDB, closeDB } from "../packages/db/src/database";
import { initSchema } from "../packages/db/src/schema";
import { prepareRawMessageEventDeletion } from "../packages/db/src/memory-events";
import { classify } from "../packages/extractors/src/classify";
import { extract, ruleBasedExtract } from "../packages/extractors/src/extract";
import { normalizeOwnerId } from "../packages/domain/src/owner";
import {
  deriveEventDate,
  EXTRACTOR_VERSION,
  SEARCH_TEXT_VERSION,
  VOCAB_VERSION,
} from "../packages/domain/src/provenance";
import { buildCanonicalSearchText } from "../packages/domain/src/search-text";

const args = process.argv.slice(2);
const skipLLM = args.includes("--skip-llm");
const dryRun = args.includes("--dry-run");
const dirArg = args.find(a => !a.startsWith("--"));

// 默认日记来源：仓库内置的合成 demo 数据
const DEFAULT_DIARY_DIR = resolve(process.cwd(), "examples", "demo-diaries");
const diaryDir = dirArg || DEFAULT_DIARY_DIR;

async function main() {
  console.log("=== xfeel-v2 记忆管线 - 日记导入 ===");
  console.log(`来源目录: ${diaryDir}`);
  console.log(`跳过 LLM: ${skipLLM}`);
  console.log(`试运行: ${dryRun}`);
  console.log();

  // 初始化数据库
  const db = getDB();
  initSchema(db);

  // 读取日记文件
  const diaries = loadDiaries(diaryDir);
  console.log(`加载了 ${diaries.length} 篇日记`);

  if (diaries.length === 0) {
    console.log("没有找到日记文件。请指定日记目录或检查 example-diaries/data/ 目录。");
    closeDB();
    return;
  }

  let classified = 0;
  let meaningful = 0;
  let extracted = 0;
  let stored = 0;
  let errors = 0;

  const insertEvent = db.prepare(`
    INSERT INTO memory_events (
      id,
      raw_message_id,
      event_index,
      original_span,
      event_date,
      extractor_version,
      vocab_version,
      search_text_version,
      source_archive_id,
      summary,
      original_text,
      event_type,
      entities,
      emotion,
      tags,
      canonical_search_text,
      event_time,
      confidence,
      source,
      source_layer,
      user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDiary = db.prepare(`
    INSERT INTO diaries (id, user_id, content, diary_date, source, event_ids)
    VALUES (?, ?, ?, ?, 'import', ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id=excluded.user_id,
      content=excluded.content,
      diary_date=excluded.diary_date,
      event_ids=excluded.event_ids
  `);

  const deleteRawMessageEvents = prepareRawMessageEventDeletion(db);

  for (let i = 0; i < diaries.length; i++) {
    const diary = diaries[i]!;
    const progress = `[${i + 1}/${diaries.length}]`;

    try {
      // 分类
      let isMeaningful = true;
      let category = "diary";

      if (!skipLLM) {
        const classifyResult = await classify(diary.content);
        classified++;
        isMeaningful = classifyResult.is_meaningful;
        category = classifyResult.category;
        
        if (!isMeaningful) {
          if (i % 50 === 0) process.stdout.write(`
${progress} `);
          process.stdout.write(".");
          continue;
        }
      } else {
        // 规则分类
        isMeaningful = diary.content.length > 10;
      }

      if (!isMeaningful) continue;
      meaningful++;

      if (dryRun) {
        process.stdout.write("✓");
        continue;
      }

      // 抽取
      let events;
      if (!skipLLM) {
        events = await extract(diary.content, { ownerId: diary.ownerId, speakerId: diary.ownerId });
      } else {
        events = ruleBasedExtract(diary.content, { ownerId: diary.ownerId, speakerId: diary.ownerId });
      }
      extracted += events.length;

      // 存储
      const eventIds: string[] = [];
      const transaction = db.transaction(() => {
        deleteRawMessageEvents(diary.id, diary.ownerId || null);

        for (const [eventIndex, event] of events.entries()) {
          const eventId = `import:${diary.id}:event:${event.event_index ?? eventIndex}:${EXTRACTOR_VERSION}`;
          const userId = event.user_id || diary.ownerId;
          const eventDate = event.event_date || deriveEventDate(event.event_time, diary.date, event.created_at);
          insertEvent.run(
            eventId,
            diary.id,
            event.event_index ?? eventIndex,
            event.original_span || event.original_text || event.summary,
            eventDate,
            event.extractor_version || EXTRACTOR_VERSION,
            event.vocab_version || VOCAB_VERSION,
            event.search_text_version || SEARCH_TEXT_VERSION,
            event.source_archive_id || null,
            event.summary,
            event.original_text,
            event.event_type,
            JSON.stringify(event.entities),
            JSON.stringify(event.emotion),
            JSON.stringify(event.tags),
            buildCanonicalSearchText({ ...event, user_id: userId }),
            event.event_time || null,
            event.confidence,
            event.source,
            event.source_layer,
            userId || null,
          );
          eventIds.push(eventId);
          stored++;
        }

        // 存储原始日记
        insertDiary.run(
          `import:${diary.id}`,
          diary.ownerId || null,
          diary.content,
          diary.date || null,
          JSON.stringify(eventIds),
        );
      });

      transaction();

      if ((i + 1) % 10 === 0) {
        process.stdout.write(`
${progress} ✓ ${events.length} events extracted`);
      } else {
        process.stdout.write("✓");
      }
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`
${progress} ❌ Error: ${msg}`);
    }

    // 进度报告
    if ((i + 1) % 100 === 0) {
      console.log(`
--- 进度: ${i + 1}/${diaries.length} | 有意义: ${meaningful} | 已抽取: ${extracted} | 已入库: ${stored} | 错误: ${errors} ---`);
    }
  }

  console.log("\n\n=== 导入完成 ===");
  console.log(`总日记数: ${diaries.length}`);
  console.log(`已分类: ${classified}`);
  console.log(`有意义: ${meaningful}`);
  console.log(`已抽取事件: ${extracted}`);
  console.log(`已入库: ${stored}`);
  console.log(`错误: ${errors}`);

  // 打印统计
  const stats = db.prepare("SELECT event_type, COUNT(*) as c FROM memory_events GROUP BY event_type ORDER BY c DESC").all();
  console.log("\n事件类型分布:");
  for (const row of stats as Array<{event_type: string; c: number}>) {
    console.log(`  ${row.event_type}: ${row.c}`);
  }

  closeDB();
}

function loadDiaries(dir: string): Array<{id: string; content: string; date?: string; ownerId?: string}> {
  const diaries: Array<{id: string; content: string; date?: string; ownerId?: string}> = [];

  if (!existsSync(dir)) {
    console.warn(`目录不存在: ${dir}`);
    return diaries;
  }

  // 尝试读取 JSON 格式
  const jsonFiles = readdirSync(dir).filter(f => f.endsWith(".json"));
  for (const file of jsonFiles) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (Array.isArray(data)) {
        for (const [index, item] of data.entries()) {
          if (item.content || item.text || item.diary) {
            diaries.push({
              id: resolveDiaryId(item, `${file}:${index}`),
              content: item.content || item.text || item.diary,
              date: item.date || item.created_at || item.timestamp,
              ownerId: resolveDiaryOwnerId(item),
            });
          }
        }
      }
    } catch {}
  }

  // 尝试读取 Markdown 格式
  const mdFiles = readdirSync(dir).filter(f => f.endsWith(".md"));
  for (const file of mdFiles) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      // 按 --- 或 ### 分割
      const sections = content.split(/\n---\n|\n### /);
      for (const [index, section] of sections.entries()) {
        const trimmed = section.trim();
        if (trimmed.length > 20) {
          diaries.push({ id: `${file}:${index}`, content: trimmed });
        }
      }
    } catch {}
  }

  return diaries;
}

function resolveDiaryId(item: Record<string, unknown>, fallback: string): string {
  return String(item.id || item.objectId || item._id || item.uuid || fallback);
}

function resolveDiaryOwnerId(item: Record<string, unknown>): string | undefined {
  const owner =
    normalizeOwnerId(item.owner_id as string | undefined) ||
    normalizeOwnerId(item.user_id as string | undefined) ||
    normalizeOwnerId(item.userId as string | undefined) ||
    normalizeOwnerId(item.ownerId as string | undefined);

  if (owner) return owner;

  const ownerObject = item.owner;
  if (ownerObject && typeof ownerObject === "object" && "objectId" in ownerObject) {
    return normalizeOwnerId(String((ownerObject as { objectId?: string }).objectId));
  }

  return undefined;
}

main().catch(console.error);
