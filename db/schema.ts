import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";

// PostgreSQL namespace 隔離
// 透過 PG_SCHEMA 環境變數切換，預設 "bf_v9"
// V9 使用 bf_v9（Better Auth 整合版本）
// 注意：不能使用 "public" 作為 schema 名稱（Drizzle 限制）
const schemaName = process.env.PG_SCHEMA || "bf_v9";
if (schemaName === "public") {
  throw new Error(
    'PG_SCHEMA cannot be "public". Use a custom schema name or leave it unset to use the default "bf_v9".',
  );
}
const appSchema = pgSchema(schemaName);

// 對照 shared/contracts.ts：
//   MenuItem { id, entityId, logicalId, version, name, price, category,
//              description, image_url, isCurrentVersion, changeReason,
//              createdBy, createdAt }
//   Order { id, userId: string, total, status, createdAt, submittedAt }
//   OrderItem { menuItemId, menuItemName, menuItemPrice, ... , qty }
//
// V10.2 設計：menu_items 採版本化儲存（方案A），每次修改建立新版本。
// order_items 只存 menuItemId FK 指向特定版本，不存快照。
// userId 對應 Better Auth 的 user.id（text PK）

export const menuItemsTable = appSchema.table(
  "menu_items",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    entityId: text("entity_id").notNull(),
    logicalId: integer("logical_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    price: integer("price").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    imageUrl: text("image_url").notNull(),
    isCurrentVersion: boolean("is_current_version").notNull().default(true),
    supersedes: integer("supersedes"),
    changeReason: text("change_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    entityVersionIdx: uniqueIndex("menu_entity_version_idx").on(
      table.entityId,
      table.version,
    ),
    logicalIdIdx: index("menu_logical_id_idx").on(table.logicalId),
    currentVersionIdx: index("menu_current_version_idx").on(
      table.isCurrentVersion,
    ),
  }),
);

export const ordersTable = appSchema.table("orders", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  total: integer("total").notNull().default(0),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
});

export const orderItemsTable = appSchema.table(
  "order_items",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orderId: integer("order_id")
      .notNull()
      .references(() => ordersTable.id, { onDelete: "cascade" }),
    menuItemId: integer("menu_item_id")
      .notNull()
      .references(() => menuItemsTable.id),
    qty: integer("qty").notNull(),
  },
  (table) => ({
    orderItemUniqueIdx: uniqueIndex("order_items_order_item_idx").on(
      table.orderId,
      table.menuItemId,
    ),
  }),
);
