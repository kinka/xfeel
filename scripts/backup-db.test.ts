import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupXfeelDb } from "./backup-db";

describe("backupXfeelDb", () => {
  test("creates an integrity-checked sqlite backup and prunes snapshots older than retention", () => {
    const dir = mkdtempSync(join(tmpdir(), "xfeel-backup-"));
    const source = join(dir, "source.db");
    const targetDir = join(dir, "icloud");
    const db = new Database(source);
    db.exec("create table sample(id text primary key); insert into sample values ('ok');");
    db.close();

    try {
      const first = backupXfeelDb({
        source,
        targetDir,
        retentionDays: 7,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const second = backupXfeelDb({
        source,
        targetDir,
        retentionDays: 7,
        now: new Date("2026-01-10T00:00:00.000Z"),
      });

      expect(first.integrity).toBe("ok");
      expect(first.tableCount).toBe(1);
      expect(second.integrity).toBe("ok");
      expect(second.removed).toEqual([first.target]);

      const backup = new Database(second.target, { readonly: true });
      const row = backup.query("select id from sample").get() as { id: string };
      backup.close();
      expect(row.id).toBe("ok");
      expect(existsSync(`${second.target}-wal`)).toBe(false);
      expect(existsSync(`${second.target}-shm`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
