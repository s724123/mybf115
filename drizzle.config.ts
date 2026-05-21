import { neonConfig } from "@neondatabase/serverless";
import { defineConfig } from "drizzle-kit";
import ws from "ws";

// @neondatabase/serverless 在 Node.js/Bun 環境下需要手動設定 WebSocket
// 否則 drizzle-kit migrate 會因無法建立 WebSocket 連線而失敗
neonConfig.webSocketConstructor = ws;

const migrationUrl =
  process.env.DATABASE_URL_MIGRATION ?? process.env.DATABASE_URL;

if (!migrationUrl) {
  throw new Error(
    "DATABASE_URL_MIGRATION or DATABASE_URL is required for drizzle-kit.",
  );
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: migrationUrl,
  },
});
