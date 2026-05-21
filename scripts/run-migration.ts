/**
 * scripts/run-migration.ts
 *
 * 使用 drizzle-orm 原生 migrate() 取代 drizzle-kit migrate CLI，
 * 可避免 @neondatabase/serverless WebSocket 在 Node.js/Bun 環境下的問題。
 * 並正確寫入 drizzle.__drizzle_migrations 追蹤表，防止重複套用。
 *
 * 用法：bun scripts/run-migration.ts
 */

import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { join } from "node:path";
import ws from "ws";

// Node.js / Bun 環境下必須手動指定 WebSocket 實作
neonConfig.webSocketConstructor = ws;

const DATABASE_URL =
  process.env.DATABASE_URL_MIGRATION ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL_MIGRATION or DATABASE_URL is required.");
  process.exit(1);
}

const DRIZZLE_DIR = join(import.meta.dir, "..", "drizzle");
const pgSchema = process.env.PG_SCHEMA ?? "public";
const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();

  try {
    // 1. 確保 app schema 存在（migrate() 不自動建立）
    if (pgSchema !== "public") {
      console.log(`[setup] Ensuring schema "${pgSchema}" exists...`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${pgSchema}"`);
    }

    // 2. 確保 drizzle 追蹤 schema 和 table 存在
    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
        id         SERIAL PRIMARY KEY,
        hash       text   NOT NULL,
        created_at bigint
      )
    `);

    // 3. 偵測「舊腳本已套用 tables 但未寫追蹤記錄」的情況
    //    舊腳本會建立 tables 但不插入 __drizzle_migrations 記錄，
    //    導致 migrate() 誤以為未套用而再試一次（CREATE TABLE 失敗）。
    const { rows: trackingRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle."__drizzle_migrations"`,
    );
    const trackingCount = parseInt(trackingRows[0]!.count, 10);

    if (trackingCount === 0) {
      // 檢查 app schema 的 table 是否已存在
      const { rows: tableRows } = await client.query<{ count: string }>(
        `
        SELECT COUNT(*)::text AS count
        FROM   information_schema.tables
        WHERE  table_schema = $1
          AND  table_name   IN ('users', 'menu_items', 'orders', 'order_items')
      `,
        [pgSchema],
      );
      const tableCount = parseInt(tableRows[0]!.count, 10);

      if (tableCount > 0) {
        // Tables 已存在但追蹤表是空的 → 補填追蹤記錄
        console.log(
          `[info] Tables already exist (${tableCount}/4) but not tracked. ` +
            `Registering migrations...`,
        );
        const migrations = readMigrationFiles({
          migrationsFolder: DRIZZLE_DIR,
        });
        for (const migration of migrations) {
          await client.query(
            `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
            [migration.hash, migration.folderMillis],
          );
          console.log(
            `  [✓] Registered: hash=${migration.hash.slice(0, 12)}...  ts=${migration.folderMillis}`,
          );
        }
      }
    }
  } finally {
    client.release();
  }

  // 4. 執行正式 migrate()：只套用尚未追蹤的 migration，並寫入追蹤記錄
  const db = drizzle({ client: pool });
  console.log(`\n[migration] Applying migrations from ${DRIZZLE_DIR} ...`);
  await migrate(db, { migrationsFolder: DRIZZLE_DIR });

  console.log("[✓] All migrations applied successfully.");
  await pool.end();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  pool.end().catch(() => {});
  process.exit(1);
});
