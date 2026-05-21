/**
 * scripts/check-db.ts
 *
 * 驗證 Neon 資料庫部署是否成功。
 * 用法：bun scripts/check-db.ts
 */

import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const DATABASE_URL = process.env.DATABASE_URL;
const PG_SCHEMA = process.env.PG_SCHEMA ?? "public";

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL 未設定");
  process.exit(1);
}

const safeUrl = DATABASE_URL.replace(/:([^@]+)@/, ":****@");
console.log(`\n🔌 連線目標：${safeUrl}`);
console.log(`📂 App Schema：${PG_SCHEMA}\n`);

const pool = new Pool({ connectionString: DATABASE_URL });

async function check(
  label: string,
  fn: () => Promise<string>,
): Promise<boolean> {
  try {
    const result = await fn();
    console.log(`  ✅ ${label}：${result}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ ${label}：${msg}`);
    return false;
  }
}

async function main() {
  const client = await pool.connect();
  let allOk = true;

  try {
    // ── 1. 基本連線 ────────────────────────────────────────────
    console.log("【1】基本連線");
    allOk =
      (await check("ping", async () => {
        const { rows } = await client.query<{ now: string }>(
          "SELECT NOW() AS now",
        );
        return `OK（server time: ${rows[0]!.now}）`;
      })) && allOk;

    // ── 2. Schema 存在 ─────────────────────────────────────────
    console.log("\n【2】Schema 檢查");
    allOk =
      (await check(`app schema "${PG_SCHEMA}" 存在`, async () => {
        const { rows } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM information_schema.schemata
             WHERE schema_name = $1
           ) AS exists`,
          [PG_SCHEMA],
        );
        if (!rows[0]!.exists)
          throw new Error(`schema "${PG_SCHEMA}" 不存在`);
        return "存在";
      })) && allOk;

    allOk =
      (await check("drizzle 追蹤 schema 存在", async () => {
        const { rows } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM information_schema.schemata
             WHERE schema_name = 'drizzle'
           ) AS exists`,
        );
        if (!rows[0]!.exists)
          throw new Error(
            'schema "drizzle" 不存在，請先執行 bun run db:migrate',
          );
        return "存在";
      })) && allOk;

    // ── 3. Table 存在 ──────────────────────────────────────────
    console.log("\n【3】Table 檢查");
    for (const table of ["users", "menu_items", "orders", "order_items"]) {
      allOk =
        (await check(`${PG_SCHEMA}.${table}`, async () => {
          const { rows } = await client.query<{ exists: boolean }>(
            `SELECT EXISTS(
               SELECT 1 FROM information_schema.tables
               WHERE table_schema = $1 AND table_name = $2
             ) AS exists`,
            [PG_SCHEMA, table],
          );
          if (!rows[0]!.exists) throw new Error("table 不存在");
          const { rows: cnt } = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "${PG_SCHEMA}"."${table}"`,
          );
          return `存在（${cnt[0]!.count} 筆）`;
        })) && allOk;
    }

    // ── 4. Migration 追蹤記錄 ──────────────────────────────────
    console.log("\n【4】Migration 追蹤");
    allOk =
      (await check("drizzle.__drizzle_migrations 有記錄", async () => {
        const { rows } = await client.query<{
          count: string;
          latest: string;
        }>(
          `SELECT COUNT(*)::text AS count,
                  MAX(to_timestamp(created_at / 1000))::text AS latest
           FROM drizzle."__drizzle_migrations"`,
        );
        const { count, latest } = rows[0]!;
        if (count === "0")
          throw new Error("追蹤表是空的，請先執行 bun run db:migrate");
        return `${count} 筆，最新：${latest}`;
      })) && allOk;

    // ── 5. 環境變數 ────────────────────────────────────────────
    console.log("\n【5】環境變數");
    if (process.env.PG_SCHEMA) {
      console.log(`  ✅ PG_SCHEMA="${process.env.PG_SCHEMA}" 已設定`);
    } else {
      console.log(`  ⚠️  PG_SCHEMA 未設定，使用預設值 "public"`);
      console.log(`      若 tables 在 bf_v8 schema，請設定 PG_SCHEMA=bf_v8`);
      allOk = false;
    }
  } finally {
    client.release();
    await pool.end();
  }

  // ── 總結 ───────────────────────────────────────────────────
  console.log("\n" + "─".repeat(50));
  if (allOk) {
    console.log("🎉 所有檢查通過！Neon 部署成功。");
  } else {
    console.log("⚠️  部分檢查失敗，請依上方訊息修正。");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n❌ 連線失敗：", err.message);
  console.error("   請確認 DATABASE_URL 正確，且 Neon 資料庫可連線。");
  pool.end().catch(() => {});
  process.exit(1);
});
