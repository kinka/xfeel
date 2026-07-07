/**
 * 已废弃：embedding 已迁移到独立 vec DB；请使用 migrate-embeddings-to-vec-db.ts。
 */

async function main() {
  console.log("deprecated; use migrate-embeddings-to-vec-db.ts");
  process.exit(0);
}

main().catch(e => { console.error("迁移失败：", e); process.exit(1); });
