import { getDB, getEmbeddingDB } from "../../db/src/database";
import { classify } from "../../extractors/src/classify";
import { extract, extractWithClassification } from "../../extractors/src/extract";
import type { MemoryEvent } from "../../domain/src/memory-event";
import { resolveOwnerContext } from "../../domain/src/owner";
import type { AliasContext } from "../../domain/src/family";
import {
  deriveEventDate,
  EXTRACTOR_VERSION,
  SEARCH_TEXT_VERSION,
  VOCAB_VERSION,
} from "../../domain/src/provenance";
import { buildCanonicalSearchText } from "../../domain/src/search-text";
import { normalizeOpenFacts } from "../../domain/src/open-facts";
import { createHash } from "node:crypto";
import { upsertEmbeddingsForEvents, type UpsertEmbeddingsResult } from "../../../scripts/embedding-common";
import { hashId, logError, logInfo, logWarn, safeErrorMessage, textLogFields } from "../../observability/src/logging";

export interface ProcessMessageOptions {
  ownerId?: string;
  userId?: string;
  speakerId?: string;
  speakerLabel?: string;
  aliasContext?: AliasContext;
  messageId?: string;
  force?: boolean;
  turnDate?: string;
  diaryDate?: string;
  eventDate?: string;
  createdAt?: string;
  sourceArchiveId?: string;
  extractEvents?: (text: string, ownerContext: ReturnType<typeof resolveOwnerContext>) => Promise<MemoryEvent[]>;
  combinedExtract?: boolean;
  /** 最近对话上下文：供 combined 分类器判断这条是不是「对追问的简短延续回应」，避免把闲聊碎片当独立日记抽取。 */
  recentDialogue?: string;
  embedNewEvents?: boolean;
  embeddingBatchSize?: number;
}

export interface PipelineResult {
  message_id: string;
  classified: boolean;
  meaningful: boolean;
  category: string;
  events: MemoryEvent[];
  stored: number;
  skipped: boolean;
  reason?: string;
  embedding?: UpsertEmbeddingsResult;
  /** true 表示抽取退化到规则兜底，存入的事件质量不可靠。 */
  degraded?: boolean;
}

export async function processMessage(
  text: string,
  opts: ProcessMessageOptions = {}
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const db = getDB();
  const messageId = opts.messageId || crypto.randomUUID();
  const ownerContext = resolveOwnerContext({
    ownerId: opts.ownerId,
    userId: opts.userId,
    speakerId: opts.speakerId,
    speakerLabel: opts.speakerLabel,
    aliasContext: opts.aliasContext,
  });
  const baseLog = {
    message_id: messageId,
    owner_hash: hashId(ownerContext.ownerId),
    speaker_hash: hashId(opts.speakerId),
    speaker_label: opts.speakerLabel,
    force: Boolean(opts.force),
    embed_new_events: opts.embedNewEvents !== false,
    ...textLogFields("text", text),
  };
  logInfo("pipeline_start", baseLog);

  const upsertStatus = db.prepare(`
    INSERT INTO pipeline_status (message_id, stage, status, result)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET stage=excluded.stage, status=excluded.status, result=excluded.result, updated_at=datetime('now')
  `);

  try {
    // Step 1/2: 分类 + 抽取。微信产品路径可用 combinedExtract 将两个 LLM 调用合并为一次。
    const combinedExtract = Boolean(opts.combinedExtract && !opts.extractEvents);
    const classifyStartedAt = Date.now();
    let classifyResult: Awaited<ReturnType<typeof classify>>;
    let rawEvents: MemoryEvent[] = [];
    let degraded = false;

    if (combinedExtract) {
      const combined = await extractWithClassification(text, ownerContext, opts.recentDialogue);
      classifyResult = combined.classification;
      rawEvents = combined.events;
      degraded = combined.degraded;
    } else {
      const knownEntities = [
        ...(ownerContext.aliasContext?.aliases || []).flatMap(alias => [alias.alias, alias.label]),
        ...(ownerContext.aliasContext?.collectiveChildren || []),
      ];
      classifyResult = await classify(text, [...new Set(knownEntities)]);
    }

    upsertStatus.run(messageId, "classified", "done", JSON.stringify(classifyResult));
    logInfo("pipeline_classified", {
      ...baseLog,
      category: classifyResult.category,
      meaningful: classifyResult.is_meaningful,
      modality: classifyResult.modality,
      reason: classifyResult.reason,
      combined: combinedExtract,
      duration_ms: Date.now() - classifyStartedAt,
    });

    // 非日记类别（对话延续/命令/噪声）即便被误判为 meaningful 也不入库：
    // 避免把「对追问的简短回应」当独立事件存进长期记忆（会带主语误归属、污染召回）。
    const nonDiaryCategory = classifyResult.category === "chat"
      || classifyResult.category === "noise"
      || classifyResult.category === "command";
    const worthStoring = classifyResult.is_meaningful && !nonDiaryCategory;
    if (!opts.force && !worthStoring) {
      const skippedResult = {
        message_id: messageId,
        classified: true,
        meaningful: false,
        category: classifyResult.category,
        events: [],
        stored: 0,
        skipped: true,
        reason: classifyResult.reason || (nonDiaryCategory ? `non-diary category: ${classifyResult.category}` : "not meaningful"),
      };
      logInfo("pipeline_done", {
        ...baseLog,
        category: classifyResult.category,
        meaningful: false,
        skipped: true,
        stored: 0,
        events_count: 0,
        duration_ms: Date.now() - startedAt,
      });
      return skippedResult;
    }

    const extractStartedAt = Date.now();
    if (!combinedExtract) {
      rawEvents = opts.extractEvents
        ? await opts.extractEvents(text, ownerContext)
        : await extract(text, ownerContext);
    }

    const events = rawEvents.map((event, index) => normalizeExtractedEvent({
      event,
      text,
      eventIndex: index,
      messageId,
      ownerId: ownerContext.ownerId,
      opts,
    }));
    upsertStatus.run(messageId, "extracted", "done", JSON.stringify({ count: events.length }));
    logInfo("pipeline_extracted", {
      ...baseLog,
      events_count: events.length,
      event_types: countValues(events.map(event => event.event_type)),
      combined: combinedExtract,
      duration_ms: Date.now() - extractStartedAt,
    });

    // Step 3: 存储
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
        open_facts,
        canonical_search_text,
        location,
        event_time,
        confidence,
        source,
        source_layer,
        user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        raw_message_id=excluded.raw_message_id,
        event_index=excluded.event_index,
        original_span=excluded.original_span,
        event_date=excluded.event_date,
        extractor_version=excluded.extractor_version,
        vocab_version=excluded.vocab_version,
        search_text_version=excluded.search_text_version,
        source_archive_id=excluded.source_archive_id,
        summary=excluded.summary,
        original_text=excluded.original_text,
        event_type=excluded.event_type,
        entities=excluded.entities,
        emotion=excluded.emotion,
        tags=excluded.tags,
        open_facts=excluded.open_facts,
        canonical_search_text=excluded.canonical_search_text,
        location=excluded.location,
        event_time=excluded.event_time,
        confidence=excluded.confidence,
        source=excluded.source,
        source_layer=excluded.source_layer,
        user_id=excluded.user_id,
        updated_at=datetime('now')
    `);
    const selectEventIdsForMessage = db.prepare(`
      SELECT id FROM memory_events
      WHERE raw_message_id = ?
        AND COALESCE(user_id, '') = COALESCE(?, '')
        AND source_layer = 'extracted'
    `);
    const deleteEntityLinksForMessage = db.prepare(`
      DELETE FROM entity_events
      WHERE event_id IN (
        SELECT id FROM memory_events
        WHERE raw_message_id = ?
          AND COALESCE(user_id, '') = COALESCE(?, '')
          AND source_layer = 'extracted'
      )
    `);
    const deleteOpenFactsForMessage = db.prepare(`
      DELETE FROM memory_open_facts
      WHERE event_id IN (
        SELECT id FROM memory_events
        WHERE raw_message_id = ?
          AND COALESCE(user_id, '') = COALESCE(?, '')
          AND source_layer = 'extracted'
      )
    `);
    const deleteOpenFactsForEvent = db.prepare("DELETE FROM memory_open_facts WHERE event_id = ?");
    const insertOpenFact = db.prepare(`
      INSERT INTO memory_open_facts (
        id, event_id, owner_id, kind, value, surface, evidence_start, evidence_end,
        confidence, polarity, actor_id, experiencer_id, observer_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        event_id=excluded.event_id,
        owner_id=excluded.owner_id,
        kind=excluded.kind,
        value=excluded.value,
        surface=excluded.surface,
        evidence_start=excluded.evidence_start,
        evidence_end=excluded.evidence_end,
        confidence=excluded.confidence,
        polarity=excluded.polarity,
        actor_id=excluded.actor_id,
        experiencer_id=excluded.experiencer_id,
        observer_id=excluded.observer_id,
        updated_at=datetime('now')
    `);
    const deleteCausalChainsForEvent = db.prepare(`
      DELETE FROM causal_chains
      WHERE cause_event_id = ? OR effect_event_id = ?
    `);
    const deleteEventById = db.prepare("DELETE FROM memory_events WHERE id = ?");

    let stored = 0;
    let staleDeleted = 0;
    const storeStartedAt = Date.now();
    const transaction = db.transaction(() => {
      const scopedOwnerId = ownerContext.ownerId || null;
      const existingEventIds = (selectEventIdsForMessage.all(messageId, scopedOwnerId) as Array<{ id: string }>)
        .map(row => row.id);
      const currentEventIds = new Set(events.map(event => event.id).filter((id): id is string => Boolean(id)));
      const staleEventIds = existingEventIds.filter(id => !currentEventIds.has(id));
      staleDeleted = staleEventIds.length;

      deleteEntityLinksForMessage.run(messageId, ownerContext.ownerId || null);
      deleteOpenFactsForMessage.run(messageId, ownerContext.ownerId || null);
      for (const eventId of staleEventIds) {
        deleteCausalChainsForEvent.run(eventId, eventId);
        deleteOpenFactsForEvent.run(eventId);
        deleteEventById.run(eventId);
      }

      for (const event of events) {
        const eventId = event.id || deterministicEventId(messageId, ownerContext.ownerId, event.event_index ?? 0);
        const rawMessageId = event.raw_message_id || messageId;
        const eventDate = event.event_date || deriveEventDate(
          event.event_time,
          opts.eventDate,
          opts.turnDate,
          opts.diaryDate,
          event.created_at,
          opts.createdAt ? new Date(opts.createdAt) : undefined,
        );
        const extractorVersion = event.extractor_version || EXTRACTOR_VERSION;
        const vocabVersion = event.vocab_version || VOCAB_VERSION;
        const searchTextVersion = event.search_text_version || SEARCH_TEXT_VERSION;
        const sourceArchiveId = event.source_archive_id || opts.sourceArchiveId || null;
        const confidence = event.confidence ?? 1;
        const source = event.source || "user";
        const sourceLayer = event.source_layer || "extracted";
        const userId = ownerContext.ownerId;
        const openFacts = normalizeOpenFacts(event.open_facts || [], { ...event, id: eventId });
        insertEvent.run(
          eventId,
          rawMessageId,
          event.event_index ?? null,
          event.original_span || event.original_text || event.summary,
          eventDate,
          extractorVersion,
          vocabVersion,
          searchTextVersion,
          sourceArchiveId,
          event.summary,
          event.original_text,
          event.event_type,
          JSON.stringify(event.entities),
          JSON.stringify(event.emotion),
          JSON.stringify(event.tags),
          JSON.stringify(openFacts),
          buildCanonicalSearchText({ ...event, open_facts: openFacts, user_id: userId }),
          event.location || null,
          event.event_time || null,
          confidence,
          source,
          sourceLayer,
          userId || null,
        );
        for (const fact of openFacts) {
          insertOpenFact.run(
            fact.id || crypto.randomUUID(),
            eventId,
            userId || null,
            fact.kind,
            fact.value,
            fact.surface,
            fact.evidence_span?.[0] ?? null,
            fact.evidence_span?.[1] ?? null,
            fact.confidence ?? 0.75,
            fact.polarity || "actual",
            fact.actor_id || null,
            fact.experiencer_id || null,
            fact.observer_id || null,
          );
        }
        stored++;

        // 实体图谱（entities/entity_events）已废弃：线上回复链路从不读取，
        // 仅离线分析使用，且因果/实体图整体下线中。停止写入，旧行随消息重处理
        // 经上方 deleteEntityLinksForMessage 逐步清空。见 docs/decommission-knowledge-graph.md
      }
    });

    transaction();
    logInfo("pipeline_stored", {
      ...baseLog,
      stored,
      events_count: events.length,
      stale_deleted_count: staleDeleted,
      duration_ms: Date.now() - storeStartedAt,
    });

    let embedding: UpsertEmbeddingsResult | undefined;
    if (opts.embedNewEvents !== false) {
      const embeddingStartedAt = Date.now();
      try {
        embedding = await upsertEmbeddingsForEvents(getEmbeddingDB(), events, { batchSize: opts.embeddingBatchSize || 32, reset: true });
        logInfo("pipeline_embedding", {
          ...baseLog,
          attempted: true,
          units: embedding.units,
          pending: embedding.pending,
          written: embedding.written,
          model: embedding.model,
          duration_ms: Date.now() - embeddingStartedAt,
        });
      } catch (error) {
        logWarn("pipeline_embedding", {
          ...baseLog,
          attempted: true,
          skipped: true,
          events_count: events.length,
          duration_ms: Date.now() - embeddingStartedAt,
          error: safeErrorMessage(error),
        });
      }
    } else {
      logInfo("pipeline_embedding", {
        ...baseLog,
        attempted: false,
        skipped: true,
        reason: "disabled",
        events_count: events.length,
      });
    }

    upsertStatus.run(messageId, "indexed", degraded ? "degraded" : "done", JSON.stringify({ stored, embedding, degraded }));
    if (degraded) {
      logWarn("pipeline_degraded_extraction", {
        ...baseLog,
        stored,
        events_count: events.length,
        reason: classifyResult.reason,
      });
    }

    logInfo("pipeline_done", {
      ...baseLog,
      category: classifyResult.category,
      meaningful: true,
      skipped: false,
      stored,
      events_count: events.length,
      embedding_written: embedding?.written,
      duration_ms: Date.now() - startedAt,
    });
    return {
      message_id: messageId,
      classified: true,
      meaningful: true,
      category: classifyResult.category,
      events,
      stored,
      skipped: false,
      embedding,
      degraded,
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    upsertStatus.run(messageId, "error", "error", JSON.stringify({ error: errorMsg }));
    logError("pipeline_error", {
      ...baseLog,
      duration_ms: Date.now() - startedAt,
      error: safeErrorMessage(e),
    });
    throw e;
  }
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function normalizeExtractedEvent(input: {
  event: MemoryEvent;
  text: string;
  eventIndex: number;
  messageId: string;
  ownerId?: string;
  opts: ProcessMessageOptions;
}): MemoryEvent {
  const { event, text, eventIndex, messageId, ownerId, opts } = input;
  const createdAt = event.created_at || opts.createdAt || new Date().toISOString();
  const normalizedEventIndex = event.event_index ?? eventIndex;
  // processMessage is a single-owner pipeline. Keeping extractor-supplied
  // user_id values would make the replace scope differ from the insert scope.
  const userId = ownerId;

  return {
    ...event,
    id: isStructuredStableEvent(event) && event.id
      ? event.id
      : deterministicEventId(messageId, ownerId, normalizedEventIndex),
    raw_message_id: messageId,
    event_index: normalizedEventIndex,
    original_span: event.original_span || event.original_text || event.summary || text,
    event_date: event.event_date || deriveEventDate(
      event.event_time,
      opts.eventDate,
      opts.turnDate,
      opts.diaryDate,
      new Date(createdAt),
    ),
    extractor_version: event.extractor_version || EXTRACTOR_VERSION,
    vocab_version: event.vocab_version || VOCAB_VERSION,
    search_text_version: event.search_text_version || SEARCH_TEXT_VERSION,
    source_archive_id: event.source_archive_id || opts.sourceArchiveId,
    user_id: userId,
    open_facts: normalizeOpenFacts(event.open_facts || [], event),
    created_at: createdAt,
  };
}

function deterministicEventId(messageId: string, ownerId: string | undefined, eventIndex: number): string {
  return stableUuid([
    "processMessage",
    EXTRACTOR_VERSION,
    ownerId || "",
    messageId,
    String(eventIndex),
  ]);
}

function stableUuid(parts: string[]): string {
  const chars = createHash("sha256")
    .update(parts.join("\x1f"))
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isStructuredStableEvent(event: MemoryEvent): boolean {
  return Boolean(event.id && event.source_layer === "structured");
}
