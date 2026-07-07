import type { Database } from "bun:sqlite";

export function prepareRawMessageEventDeletion(db: Database) {
  const deleteCausalChainsForMessage = db.prepare(`
    DELETE FROM causal_chains
    WHERE cause_event_id IN (
      SELECT id FROM memory_events
      WHERE raw_message_id = ?
        AND COALESCE(user_id, '') = COALESCE(?, '')
    )
      OR effect_event_id IN (
        SELECT id FROM memory_events
        WHERE raw_message_id = ?
          AND COALESCE(user_id, '') = COALESCE(?, '')
      )
  `);
  const deleteEntityLinksForMessage = db.prepare(`
    DELETE FROM entity_events
    WHERE event_id IN (
      SELECT id FROM memory_events
      WHERE raw_message_id = ?
        AND COALESCE(user_id, '') = COALESCE(?, '')
    )
  `);
  const deleteEventsForMessage = db.prepare(`
    DELETE FROM memory_events
    WHERE raw_message_id = ?
      AND COALESCE(user_id, '') = COALESCE(?, '')
  `);

  return (rawMessageId: string, ownerId?: string | null) => {
    const scopedOwnerId = ownerId || null;
    deleteCausalChainsForMessage.run(rawMessageId, scopedOwnerId, rawMessageId, scopedOwnerId);
    deleteEntityLinksForMessage.run(rawMessageId, scopedOwnerId);
    deleteEventsForMessage.run(rawMessageId, scopedOwnerId);
  };
}
