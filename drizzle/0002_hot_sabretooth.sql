DROP INDEX "bf_v10"."order_items_order_item_idx";--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "entity_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "logical_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "is_current_version" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "supersedes" integer;--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "change_reason" text;--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "created_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bf_v10"."menu_items" ADD COLUMN "created_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" ADD COLUMN "menu_item_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" ADD CONSTRAINT "order_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "bf_v10"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_entity_version_idx" ON "bf_v10"."menu_items" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "menu_logical_id_idx" ON "bf_v10"."menu_items" USING btree ("logical_id");--> statement-breakpoint
CREATE INDEX "menu_current_version_idx" ON "bf_v10"."menu_items" USING btree ("is_current_version");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_item_idx" ON "bf_v10"."order_items" USING btree ("order_id","menu_item_id");--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN "item_id";--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN "price";--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "bf_v10"."order_items" DROP COLUMN "image_url";