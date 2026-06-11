/**
 * scripts/run-migration.ts
 *
 * 備案 migration 腳本：當 drizzle-kit migrate 因 @neondatabase/serverless
 * WebSocket 問題靜默失敗時，直接讀取 SQL 檔並透過 Pool 執行。
 *
 * 用法：bun scripts/run-migration.ts
 */

import { neonConfig, Pool } from "@neondatabase/serverless";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const DATABASE_URL =
  process.env.DATABASE_URL_MIGRATION ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL_MIGRATION or DATABASE_URL is required.");
  process.exit(1);
}

const DRIZZLE_DIR = join(import.meta.dir, "..", "drizzle");
const JOURNAL_PATH = join(DRIZZLE_DIR, "meta", "_journal.json");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const pool = new Pool({ connectionString: DATABASE_URL });

/** 從 SQL 文字中掃描 CREATE TABLE "schema".<table> 用到的所有 schema 名稱 */
function extractSchemaNames(sql: string): string[] {
  const found = new Set<string>();
  const re = /CREATE\s+TABLE\s+"([^"]+)"\./gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    found.add(m[1]!);
  }
  return [...found];
}

async function main() {
  const client = await pool.connect();

  try {
    // 建立 drizzle migrations 追蹤 schema（若不存在）
    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
        id       serial  PRIMARY KEY,
        hash     text    NOT NULL,
        created_at bigint
      )
    `);

    // 建立應用 schema（若不存在）
    const pgSchema = process.env.PG_SCHEMA ?? "public";
    if (pgSchema !== "public") {
      console.log(`[setup] Creating schema "${pgSchema}" if not exists...`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${pgSchema}"`);
    }

    const journalText = await readFile(JOURNAL_PATH, "utf-8");
    const journal = JSON.parse(journalText) as Journal;

    for (const entry of journal.entries) {
      const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);

      // 逐步執行每個 statement（以 --> statement-breakpoint 分割）
      const sqlText = await readFile(sqlPath, "utf-8");
      const statements = sqlText
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      console.log(
        `\n[migration] ${entry.tag} (${statements.length} statements)`,
      );

      // 在 BEGIN 前，確保此 SQL 中用到的所有 schema 都已建立
      // （CREATE SCHEMA 不能在 transaction 內執行）
      const schemasInSql = extractSchemaNames(sqlText);
      for (const schema of schemasInSql) {
        if (
          schema !== "public" &&
          schema !== pgSchema &&
          schema !== "drizzle"
        ) {
          console.log(`[setup] Creating schema "${schema}" if not exists...`);
          await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        }
      }

      await client.query("BEGIN");

      let committed = false;
      try {
        for (let i = 0; i < statements.length; i++) {
          const stmt = statements[i]!;
          const savepointName = `sp_${i}`;
          console.log(`  [${i + 1}/${statements.length}] executing...`);

          // 每個 statement 前建立 SAVEPOINT，防止單一失敗污染整個 transaction
          await client.query(`SAVEPOINT ${savepointName}`);

          try {
            await client.query(stmt);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (
              msg.includes("already exists") ||
              msg.includes("duplicate_table")
            ) {
              // 可忽略：回滾到 SAVEPOINT，transaction 保持 active，繼續下一條
              console.warn(`  [skip] already exists: ${msg.split("\n")[0]}`);
              await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            } else {
              // 真正的錯誤：回滾整個 transaction 後拋出
              console.error(`  [error] ${msg}`);
              await client.query("ROLLBACK");
              committed = true;
              throw err;
            }
          }
        }

        await client.query("COMMIT");
        committed = true;
        console.log(`  [✓] ${entry.tag} applied`);
      } finally {
        if (!committed) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // 已在 catch 中 ROLLBACK 過，忽略重複呼叫
          }
        }
      }
    }

    console.log("\n[✓] All migrations applied successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
