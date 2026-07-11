import { createHash } from "node:crypto";
import { getDB } from "../../../db/src/database";
import { normalizeOwnerId } from "../../../domain/src/owner";
import type { UnderstandingCategory, UnderstandingItem } from "./profile-types";

export type UnderstandingFeedbackAction = "confirm" | "reject" | "retract" | "correct";
export type UnderstandingVisibility = "private" | "family";

export interface UnderstandingFeedback {
  id: string; ownerId: string; understandingKey: string; action: UnderstandingFeedbackAction;
  originalStatement: string; replacementStatement?: string; category: UnderstandingCategory;
  subject: string; visibility: UnderstandingVisibility; createdAt: string; updatedAt: string;
}

interface FeedbackRow {
  id: string; owner_id: string; understanding_key: string; action: UnderstandingFeedbackAction;
  original_statement: string; replacement_statement: string | null; category: UnderstandingCategory;
  subject: string; visibility: UnderstandingVisibility; created_at: string; updated_at: string;
}

export function understandingKey(item: Pick<UnderstandingItem, "category" | "subject" | "statement">): string {
  return createHash("sha256").update([item.category, item.subject.trim(), item.statement.trim()].join("\u001f")).digest("hex").slice(0, 24);
}

export function listUnderstandingFeedback(ownerId?: string): UnderstandingFeedback[] {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) return [];
  return (getDB().prepare("SELECT * FROM understanding_feedback WHERE owner_id = ? ORDER BY updated_at DESC")
    .all(owner) as FeedbackRow[]).map(rowToFeedback);
}

export function saveUnderstandingFeedback(input: {
  ownerId: string; item: Pick<UnderstandingItem, "category" | "subject" | "statement">;
  action: UnderstandingFeedbackAction; replacementStatement?: string; visibility?: UnderstandingVisibility;
}): UnderstandingFeedback {
  const owner = normalizeOwnerId(input.ownerId);
  if (!owner) throw new Error("ownerId is required");
  const replacement = input.replacementStatement?.trim();
  if (input.action === "correct" && !replacement) throw new Error("replacementStatement is required for correct");
  const key = understandingKey(input.item);
  const existing = getDB().prepare("SELECT id, created_at FROM understanding_feedback WHERE owner_id = ? AND understanding_key = ?")
    .get(owner, key) as { id: string; created_at: string } | undefined;
  const id = existing?.id || crypto.randomUUID();
  const now = new Date().toISOString();
  getDB().prepare(`
    INSERT INTO understanding_feedback
      (id, owner_id, understanding_key, action, original_statement, replacement_statement, category, subject, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, understanding_key) DO UPDATE SET action=excluded.action,
      replacement_statement=excluded.replacement_statement, visibility=excluded.visibility, updated_at=excluded.updated_at
  `).run(id, owner, key, input.action, input.item.statement.trim(), replacement || null, input.item.category,
    input.item.subject.trim(), input.visibility || "private", existing?.created_at || now, now);
  return listUnderstandingFeedback(owner).find(f => f.understandingKey === key)!;
}

export function applyUnderstandingFeedback(ownerId: string | undefined, items: UnderstandingItem[]): UnderstandingItem[] {
  const feedback = new Map(listUnderstandingFeedback(ownerId).map(f => [f.understandingKey, f]));
  return items.flatMap(item => {
    const f = feedback.get(understandingKey(item));
    if (!f) return [item];
    if (f.action === "reject" || f.action === "retract") return [];
    return [{ ...item,
      statement: f.action === "correct" ? f.replacementStatement! : item.statement,
      confidence: f.action === "confirm" || f.action === "correct" ? Math.max(item.confidence, 0.95) : item.confidence,
      support: { ...item.support, userConfirmed: f.action === "confirm" || f.action === "correct" },
      lastConfirmedAt: f.updatedAt.slice(0, 10),
    }];
  });
}

function rowToFeedback(row: FeedbackRow): UnderstandingFeedback {
  return { id: row.id, ownerId: row.owner_id, understandingKey: row.understanding_key, action: row.action,
    originalStatement: row.original_statement, replacementStatement: row.replacement_statement || undefined,
    category: row.category, subject: row.subject, visibility: row.visibility, createdAt: row.created_at, updatedAt: row.updated_at };
}
