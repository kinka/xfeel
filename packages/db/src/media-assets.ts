import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDB } from "./database";
import type { Database } from "bun:sqlite";

export type MediaKind = "image" | "voice" | "video";

export interface MediaAsset {
  id: string;
  owner_id?: string;
  kind: MediaKind;
  source_platform?: string;
  source_url?: string;
  source_media_id?: string;
  local_path: string;
  mime?: string;
  bytes?: number;
  sha256?: string;
  caption?: string;
  message_id?: string;
  status: string;
  created_at?: string;
}

/** 媒体落地根目录：默认 data/media，可用 XFEEL_MEDIA_DIR 覆盖（与 XFEEL_DB_PATH 对齐时更可控）。 */
export function resolveMediaDir(): string {
  if (process.env.XFEEL_MEDIA_DIR) return resolve(process.env.XFEEL_MEDIA_DIR);
  const dbPath = process.env.XFEEL_DB_PATH;
  if (dbPath) return resolve(dirname(resolve(dbPath)), "media");
  return resolve(process.cwd(), "data", "media");
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "audio/amr": "amr",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
};

export function extForMime(mime?: string, fallback = "bin"): string {
  if (!mime) return fallback;
  const normalized = mime.split(";")[0]!.trim().toLowerCase();
  return MIME_EXT[normalized] || fallback;
}

/**
 * 按内容 sha256 + 扩展名拼出落地路径，并按年月分目录。
 * 纯函数，便于测试；返回绝对路径与用于回看的相对路径。
 */
export function buildMediaPath(sha256: string, ext: string, now = new Date()): { absPath: string; relPath: string } {
  const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const relPath = `${yyyymm}/${sha256}.${ext}`;
  return { absPath: resolve(resolveMediaDir(), relPath), relPath };
}

export interface SaveMediaInput {
  buffer: Uint8Array;
  mime?: string;
  ownerId?: string;
  kind?: MediaKind;
  sourcePlatform?: string;
  sourceUrl?: string;
  sourceMediaId?: string;
  db?: Database;
}

/** 写文件（按 sha256 去重，已存在则复用）并登记一条 media_assets 记录，返回资产。 */
export function saveMediaBuffer(input: SaveMediaInput): MediaAsset {
  const db = input.db || getDB();
  const buffer = input.buffer;
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const kind: MediaKind = input.kind || "image";
  const ext = extForMime(input.mime, kind === "image" ? "jpg" : kind === "video" ? "mp4" : "bin");
  const { absPath, relPath } = buildMediaPath(sha256, ext);

  if (!existsSync(absPath)) {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, buffer);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO media_assets (
      id, owner_id, kind, source_platform, source_url, source_media_id,
      local_path, mime, bytes, sha256, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored')
  `).run(
    id,
    input.ownerId ?? null,
    kind,
    input.sourcePlatform ?? null,
    input.sourceUrl ?? null,
    input.sourceMediaId ?? null,
    relPath,
    input.mime ?? null,
    buffer.byteLength,
    sha256,
  );

  return {
    id, owner_id: input.ownerId, kind, source_platform: input.sourcePlatform,
    source_url: input.sourceUrl, source_media_id: input.sourceMediaId,
    local_path: relPath, mime: input.mime, bytes: buffer.byteLength, sha256, status: "stored",
  };
}

/** 从 URL（微信 PicUrl）下载并落地。PicUrl 几天后失效，必须收到即下。 */
export async function downloadAndStoreMedia(input: {
  url: string;
  ownerId?: string;
  kind?: MediaKind;
  sourcePlatform?: string;
  sourceMediaId?: string;
  timeoutMs?: number;
  db?: Database;
}): Promise<MediaAsset> {
  const resp = await fetch(input.url, { signal: AbortSignal.timeout(input.timeoutMs ?? 20_000) });
  if (!resp.ok) throw new Error(`download media failed: ${resp.status} ${input.url}`);
  const mime = resp.headers.get("content-type") || undefined;
  const buffer = new Uint8Array(await resp.arrayBuffer());
  return saveMediaBuffer({
    buffer,
    mime,
    ownerId: input.ownerId,
    kind: input.kind,
    sourcePlatform: input.sourcePlatform,
    sourceUrl: input.url,
    sourceMediaId: input.sourceMediaId,
    db: input.db,
  });
}

/** 回写 vision 转写结果与关联的 pipeline message_id。 */
export function recordMediaCaption(id: string, caption: string, messageId?: string, db: Database = getDB()): void {
  db.prepare("UPDATE media_assets SET caption = ?, message_id = COALESCE(?, message_id), status = 'captioned' WHERE id = ?")
    .run(caption, messageId ?? null, id);
}

export function markMediaFailed(id: string, db: Database = getDB()): void {
  db.prepare("UPDATE media_assets SET status = 'failed' WHERE id = ?").run(id);
}

export function getMediaAsset(id: string, db: Database = getDB()): MediaAsset | undefined {
  const row = db.prepare("SELECT * FROM media_assets WHERE id = ?").get(id) as MediaAsset | undefined;
  return row || undefined;
}

export function getMediaAssetAbsPath(asset: Pick<MediaAsset, "local_path">): string {
  return resolve(resolveMediaDir(), asset.local_path);
}

/** 统计与这些 turn 关联的媒体数量（删除预览用）。 */
export function countMediaForTurns(turnIds: string[], db: Database = getDB()): number {
  const ids = turnIds.filter(Boolean);
  if (!ids.length) return 0;
  const ph = ids.map(() => "?").join(",");
  return (db.prepare(`SELECT COUNT(*) AS c FROM media_assets WHERE message_id IN (${ph})`).get(...ids) as { c: number }).c;
}

/**
 * 删除与这些 turn 关联的媒体资产行；落地文件仅在没有其它资产共用（sha256 去重）时才删。
 * 返回删除的行数与文件数。
 */
export function deleteMediaForTurns(turnIds: string[], db: Database = getDB()): { rows: number; files: number } {
  const ids = turnIds.filter(Boolean);
  if (!ids.length) return { rows: 0, files: 0 };
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, local_path FROM media_assets WHERE message_id IN (${ph})`).all(...ids) as Array<{ id: string; local_path: string }>;
  if (!rows.length) return { rows: 0, files: 0 };
  db.prepare(`DELETE FROM media_assets WHERE message_id IN (${ph})`).run(...ids);
  let files = 0;
  for (const row of rows) {
    const stillUsed = db.prepare("SELECT 1 FROM media_assets WHERE local_path = ? LIMIT 1").get(row.local_path);
    if (stillUsed) continue;
    try {
      const p = resolve(resolveMediaDir(), row.local_path);
      if (existsSync(p)) { unlinkSync(p); files++; }
    } catch { /* 文件缺失忽略 */ }
  }
  return { rows: rows.length, files };
}
