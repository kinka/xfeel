import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { getDB, closeDB } = await import("./database");
const { initSchema } = await import("./schema");
const { extForMime, buildMediaPath, saveMediaBuffer, recordMediaCaption, getMediaAsset, getMediaAssetAbsPath } = await import("./media-assets");

describe("media assets storage", () => {
  let dbPath = "";
  let mediaDir = "";
  const originalMediaDir = process.env.XFEEL_MEDIA_DIR;

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-media-${crypto.randomUUID()}.db`);
    mediaDir = join(tmpdir(), `xfeel-media-dir-${crypto.randomUUID()}`);
    process.env.XFEEL_MEDIA_DIR = mediaDir;
    initSchema(getDB(dbPath));
  });

  afterEach(() => {
    closeDB();
    if (originalMediaDir === undefined) delete process.env.XFEEL_MEDIA_DIR;
    else process.env.XFEEL_MEDIA_DIR = originalMediaDir;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(mediaDir, { force: true, recursive: true });
  });

  test("extForMime maps known types and falls back", () => {
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg; charset=binary")).toBe("jpg");
    expect(extForMime("application/octet-stream", "jpg")).toBe("jpg");
    expect(extForMime(undefined, "jpg")).toBe("jpg");
  });

  test("buildMediaPath shards by year-month and uses sha+ext", () => {
    const now = new Date(Date.UTC(2026, 5, 30));
    const { absPath, relPath } = buildMediaPath("abc123", "jpg", now);
    expect(relPath).toBe("2026-06/abc123.jpg");
    expect(absPath).toContain(mediaDir);
    expect(absPath.endsWith("2026-06/abc123.jpg")).toBe(true);
  });

  test("saveMediaBuffer writes the file, records a row, and dedups by content", () => {
    const buf = new TextEncoder().encode("fake-jpeg-bytes");
    const a = saveMediaBuffer({ buffer: buf, mime: "image/jpeg", ownerId: "dad", kind: "image", sourceUrl: "http://pic", sourcePlatform: "weixin" });

    expect(a.local_path.endsWith(".jpg")).toBe(true);
    expect(a.bytes).toBe(buf.byteLength);
    const abs = getMediaAssetAbsPath(a);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs)).toEqual(Buffer.from(buf));

    const stored = getMediaAsset(a.id)!;
    expect(stored.owner_id).toBe("dad");
    expect(stored.source_url).toBe("http://pic");
    expect(stored.status).toBe("stored");

    // 同内容再存一次：复用同一文件路径（sha 相同），但产生新的资产行。
    const b = saveMediaBuffer({ buffer: buf, mime: "image/jpeg", ownerId: "mom", kind: "image" });
    expect(b.local_path).toBe(a.local_path);
    expect(b.id).not.toBe(a.id);
  });

  test("recordMediaCaption attaches caption + message id and flips status", () => {
    const a = saveMediaBuffer({ buffer: new TextEncoder().encode("x"), mime: "image/png", ownerId: "dad" });
    recordMediaCaption(a.id, "照片里孩子在荡秋千，笑得很开心", "msg-1");

    const stored = getMediaAsset(a.id)!;
    expect(stored.caption).toBe("照片里孩子在荡秋千，笑得很开心");
    expect(stored.message_id).toBe("msg-1");
    expect(stored.status).toBe("captioned");
  });
});
