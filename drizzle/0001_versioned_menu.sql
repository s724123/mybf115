-- 0001_versioned_menu
-- 方案A：menu_items 版本化儲存
-- order_items 改用 menu_item_id FK，移除快照欄位
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "entity_id" text;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "logical_id" integer;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "version" integer;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "is_current_version" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "supersedes" integer;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "change_reason" text;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "created_by" text;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "created_at" timestamp with time zone;
--> statement-breakpoint
-- 將現有 12 筆菜單資料轉換為第一個版本
UPDATE "bf_v10"."menu_items" SET
  entity_id = gen_random_uuid()::text,
  logical_id = id,
  version = 1,
  is_current_version = true,
  change_reason = '初始建立',
  created_by = '系統',
  created_at = NOW()
WHERE entity_id IS NULL;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ALTER COLUMN "entity_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ALTER COLUMN "logical_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ALTER COLUMN "version" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ALTER COLUMN "created_by" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ALTER COLUMN "created_at" SET NOT NULL;
--> statement-breakpoint
-- 版本化索引
CREATE UNIQUE INDEX IF NOT EXISTS "menu_entity_version_idx" ON "bf_v10"."menu_items" USING btree ("entity_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_logical_id_idx" ON "bf_v10"."menu_items" USING btree ("logical_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_current_version_idx" ON "bf_v10"."menu_items" USING btree ("is_current_version");
--> statement-breakpoint
-- order_items：加入 menu_item_id FK
ALTER TABLE "bf_v10"."order_items" ADD COLUMN "menu_item_id" integer;
--> statement-breakpoint
-- 將現有 order_items 資料對應到 menu_items 的當前版本
UPDATE "bf_v10"."order_items" oi SET
  menu_item_id = mi.id
FROM "bf_v10"."menu_items" mi
WHERE mi.logical_id = oi.item_id AND mi.is_current_version = true;
--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" ALTER COLUMN "menu_item_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bf_v10"."order_items" ADD CONSTRAINT "order_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "bf_v10"."menu_items"("id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN IF EXISTS "item_id";
--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN IF EXISTS "name";
--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN IF EXISTS "price";
--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN IF EXISTS "category";
--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN IF EXISTS "description";
--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN IF EXISTS "image_url";
--> statement-breakpoint
-- 重新建立 unique index（舊 index 因 item_id 被 drop 而自動移除）
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_order_item_idx" ON "bf_v10"."order_items" USING btree ("order_id","menu_item_id");
