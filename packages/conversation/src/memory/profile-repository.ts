import { getDB } from "../../../db/src/database";
import { normalizeOwnerId } from "../../../domain/src/owner";
import type {
  LongTermProfile,
  LongTermProfileContent,
  MemoryProfile,
  ProfileLayer,
  RecentProfile,
  RecentProfileContent,
} from "./profile-types";

interface ProfileRow {
  id: string;
  owner_id: string;
  layer: ProfileLayer;
  content: string;
  version: number;
  covers_from: string | null;
  covers_to: string | null;
  evidence_count: number;
  source_model: string | null;
  generated_at: string;
  updated_at: string;
}

function rowToProfile<C>(row: ProfileRow): MemoryProfile<C> {
  let content: C;
  try {
    content = JSON.parse(row.content || "{}") as C;
  } catch {
    content = {} as C;
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    layer: row.layer,
    content,
    version: row.version,
    coversFrom: row.covers_from ?? undefined,
    coversTo: row.covers_to ?? undefined,
    evidenceCount: row.evidence_count,
    sourceModel: row.source_model ?? undefined,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  };
}

function getProfileRow(ownerId: string, layer: ProfileLayer): ProfileRow | undefined {
  return getDB().prepare(
    `SELECT * FROM memory_profiles WHERE owner_id = ? AND layer = ?`,
  ).get(ownerId, layer) as ProfileRow | undefined;
}

export function getLongTermProfile(ownerId?: string): LongTermProfile | null {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) return null;
  const row = getProfileRow(owner, "long_term");
  return row ? rowToProfile<LongTermProfileContent>(row) : null;
}

export function getRecentProfile(ownerId?: string): RecentProfile | null {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) return null;
  const row = getProfileRow(owner, "recent");
  return row ? rowToProfile<RecentProfileContent>(row) : null;
}

/** 写入/更新一层快照：同 (owner, layer) 维度 upsert，version 自增，保留历史靠 updated_at。 */
export function upsertProfile(input: {
  ownerId: string;
  layer: ProfileLayer;
  content: unknown;
  coversFrom?: string;
  coversTo?: string;
  evidenceCount?: number;
  sourceModel?: string;
}): MemoryProfile {
  const owner = normalizeOwnerId(input.ownerId);
  if (!owner) throw new Error("ownerId is required");
  const db = getDB();
  const now = new Date().toISOString();
  const existing = getProfileRow(owner, input.layer);
  const id = existing?.id || crypto.randomUUID();
  const version = (existing?.version ?? 0) + 1;
  const content = JSON.stringify(input.content ?? {});

  db.prepare(`
    INSERT INTO memory_profiles
      (id, owner_id, layer, content, version, covers_from, covers_to, evidence_count, source_model, generated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, layer) DO UPDATE SET
      content = excluded.content,
      version = excluded.version,
      covers_from = excluded.covers_from,
      covers_to = excluded.covers_to,
      evidence_count = excluded.evidence_count,
      source_model = excluded.source_model,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at
  `).run(
    id, owner, input.layer, content, version,
    input.coversFrom ?? null, input.coversTo ?? null,
    input.evidenceCount ?? 0, input.sourceModel ?? null, now, now,
  );

  return {
    id,
    ownerId: owner,
    layer: input.layer,
    content: input.content,
    version,
    coversFrom: input.coversFrom,
    coversTo: input.coversTo,
    evidenceCount: input.evidenceCount ?? 0,
    sourceModel: input.sourceModel,
    generatedAt: now,
    updatedAt: now,
  };
}
