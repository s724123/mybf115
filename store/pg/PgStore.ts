import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  MenuItem,
  MenuItemVersionHistory,
  Order,
  OrderItem,
} from "../../shared/contracts.ts";
import { db } from "../../db/client.ts";
import {
  menuItemsTable,
  orderItemsTable,
  ordersTable,
} from "../../db/schema.ts";
import type { Store } from "../Store.ts";

interface PgStoreOptions {
  dataFilePath?: string;
}

// Seed 用的內部型別（來自 data/store.json）
interface SeedData {
  menu?: Array<{
    id: number;
    name: string;
    price: number;
    category: string;
    description: string;
    image_url: string;
  }>;
}

function calculateTotal(items: ReadonlyArray<OrderItem>): number {
  return items.reduce((sum, oi) => sum + oi.menuItemPrice * oi.qty, 0);
}

/**
 * 將 DB order_items + menu_items JOIN 結果轉換為 OrderItem
 */
function toOrderItem(
  oi: { id: number; orderId: number; menuItemId: number; qty: number },
  mi: {
    id: number;
    logicalId: number;
    name: string;
    price: number;
    category: string;
    description: string;
    imageUrl: string;
    version: number;
  },
): OrderItem {
  return {
    menuItemId: mi.id,
    logicalId: mi.logicalId,
    menuItemName: mi.name,
    menuItemPrice: mi.price,
    menuItemCategory: mi.category,
    menuItemDescription: mi.description,
    menuItemImageUrl: mi.imageUrl,
    menuItemVersion: mi.version,
    qty: oi.qty,
  };
}

/**
 * 將 DB orders row + items 轉換為 Order
 */
function toOrder(
  row: {
    id: number;
    userId: string;
    total: number;
    status: string;
    createdAt: Date;
    submittedAt: Date | null;
  },
  items: OrderItem[],
): Order {
  return {
    id: row.id,
    userId: row.userId,
    items,
    total: row.total,
    status: row.status === "submitted" ? "submitted" : "pending",
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
    submittedAt: row.submittedAt
      ? row.submittedAt instanceof Date
        ? row.submittedAt.toISOString()
        : new Date(row.submittedAt).toISOString()
      : undefined,
  };
}

/**
 * 將 DB menu_items row 轉換為 MenuItem
 */
function toMenuItem(row: {
  id: number;
  entityId: string;
  logicalId: number;
  version: number;
  name: string;
  price: number;
  category: string;
  description: string;
  imageUrl: string;
  isCurrentVersion: boolean;
  changeReason: string | null;
  createdBy: string;
  createdAt: Date;
}): MenuItem {
  return {
    id: row.id,
    entityId: row.entityId,
    logicalId: row.logicalId,
    version: row.version,
    name: row.name,
    price: row.price,
    category: row.category,
    description: row.description,
    image_url: row.imageUrl,
    isCurrentVersion: row.isCurrentVersion,
    changeReason: row.changeReason ?? undefined,
    createdBy: row.createdBy,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  };
}

export class PgStore implements Store {
  private readonly dataFilePath: string;
  private menu: MenuItem[] = [];
  private orders: Order[] = [];

  constructor(options: PgStoreOptions = {}) {
    this.dataFilePath = options.dataFilePath ?? "./data/store.json";
  }

  async init(): Promise<void> {
    await db.execute(sql`select 1`);
    await this.seedFromJsonIfEmpty();
    await this.reloadFromDatabase();
  }

  // ── Menu ────────────────────────────────────────────────────

  getMenu(): ReadonlyArray<MenuItem> {
    return this.menu;
  }

  async getMenuItemVersions(
    logicalId: number,
  ): Promise<MenuItemVersionHistory[]> {
    const rows = await db
      .select()
      .from(menuItemsTable)
      .where(eq(menuItemsTable.logicalId, logicalId))
      .orderBy(desc(menuItemsTable.version));

    return rows.map((row) => ({
      version: row.version,
      id: row.id,
      name: row.name,
      price: row.price,
      category: row.category,
      description: row.description,
      image_url: row.imageUrl,
      changeReason: row.changeReason ?? undefined,
      createdBy: row.createdBy,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(row.createdAt).toISOString(),
    }));
  }

  async createMenuItem(input: {
    name: string;
    price: number;
    category: string;
    description: string;
    image_url: string;
    createdBy: string;
  }): Promise<MenuItem> {
    // 取得下一個 logicalId
    const [maxRow] = await db
      .select({ max: sql<number>`COALESCE(MAX(logical_id), 0)` })
      .from(menuItemsTable);
    const logicalId = (maxRow?.max ?? 0) + 1;

    const entityId = crypto.randomUUID();
    const now = new Date();

    const [inserted] = await db
      .insert(menuItemsTable)
      .values({
        entityId,
        logicalId,
        version: 1,
        name: input.name,
        price: input.price,
        category: input.category,
        description: input.description,
        imageUrl: input.image_url,
        isCurrentVersion: true,
        changeReason: null,
        createdBy: input.createdBy,
        createdAt: now,
      })
      .returning();

    if (!inserted) throw new Error("Failed to insert menu item");

    const created = toMenuItem(inserted);
    this.menu.push(created);
    return created;
  }

  async updateMenuItem(
    menuId: number,
    patch: {
      name?: string;
      price?: number;
      category?: string;
      description?: string;
      image_url?: string;
      reason: string;
      createdBy: string;
    },
  ): Promise<MenuItem | null> {
    // 找到當前版本
    const [current] = await db
      .select()
      .from(menuItemsTable)
      .where(
        and(
          eq(menuItemsTable.logicalId, menuId),
          eq(menuItemsTable.isCurrentVersion, true),
        ),
      )
      .limit(1);

    if (!current) return null;

    // 標記當前版本為非當前
    await db
      .update(menuItemsTable)
      .set({ isCurrentVersion: false })
      .where(eq(menuItemsTable.id, current.id));

    // 插入新版本
    const now = new Date();
    const [inserted] = await db
      .insert(menuItemsTable)
      .values({
        entityId: current.entityId,
        logicalId: current.logicalId,
        version: current.version + 1,
        name: patch.name ?? current.name,
        price: patch.price ?? current.price,
        category: patch.category ?? current.category,
        description: patch.description ?? current.description,
        imageUrl: patch.image_url ?? current.imageUrl,
        isCurrentVersion: true,
        supersedes: current.id,
        changeReason: patch.reason,
        createdBy: patch.createdBy,
        createdAt: now,
      })
      .returning();

    if (!inserted) throw new Error("Failed to insert menu item version");

    const created = toMenuItem(inserted);

    // 更新記憶體中的 menu
    const idx = this.menu.findIndex((item) => item.logicalId === menuId);
    if (idx !== -1) {
      this.menu[idx] = created;
    } else {
      this.menu.push(created);
    }

    return created;
  }

  async deleteMenuItem(menuId: number): Promise<MenuItem | null> {
    // 刪除所有版本（FK 約束會阻止有關聯訂單的項目被刪除）
    const [removed] = await db
      .delete(menuItemsTable)
      .where(eq(menuItemsTable.logicalId, menuId))
      .returning();

    if (!removed) return null;

    const removedItem = toMenuItem(removed);

    this.menu = this.menu.filter((item) => item.logicalId !== menuId);

    return removedItem;
  }

  // ── Orders ──────────────────────────────────────────────────

  getOrders(): ReadonlyArray<Order> {
    return this.orders;
  }

  getCurrentOrderByUserId(userId: string): Order | undefined {
    const pendingOrders = this.orders.filter(
      (o) => o.userId === userId && o.status === "pending",
    );

    if (pendingOrders.length === 0) return undefined;

    return pendingOrders.reduce((latest, current) =>
      current.id > latest.id ? current : latest,
    );
  }

  getOrderHistoryByUserId(userId: string): ReadonlyArray<Order> {
    return this.orders
      .filter((o) => o.userId === userId && o.status === "submitted")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getOrderById(orderId: number): Order | undefined {
    return this.orders.find((o) => o.id === orderId);
  }

  async createOrder(input: { userId: string }): Promise<Order> {
    const existingOrder = this.getCurrentOrderByUserId(input.userId);
    if (existingOrder) {
      return existingOrder;
    }

    const createdAt = new Date();

    const [inserted] = await db
      .insert(ordersTable)
      .values({ userId: input.userId, status: "pending", total: 0, createdAt })
      .returning();

    if (!inserted) throw new Error("Failed to create order");

    const order = toOrder(inserted, []);
    this.orders.push(order);
    return order;
  }

  async updateOrderItem(
    orderId: number,
    input: { userId: string; logicalId: number; qty: number },
  ): Promise<
    | { ok: true; order: Order }
    | {
        ok: false;
        code:
          | "ORDER_NOT_FOUND"
          | "MENU_ITEM_NOT_FOUND"
          | "ORDER_NOT_OWNED"
          | "ORDER_NOT_EDITABLE";
      }
  > {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) return { ok: false, code: "ORDER_NOT_FOUND" };
    if (order.userId !== input.userId)
      return { ok: false, code: "ORDER_NOT_OWNED" };
    if (order.status !== "pending")
      return { ok: false, code: "ORDER_NOT_EDITABLE" };

    // 由 logicalId 找到當前版本
    const [currentVersion] = await db
      .select()
      .from(menuItemsTable)
      .where(
        and(
          eq(menuItemsTable.logicalId, input.logicalId),
          eq(menuItemsTable.isCurrentVersion, true),
        ),
      )
      .limit(1);

    if (!currentVersion) return { ok: false, code: "MENU_ITEM_NOT_FOUND" };

    // 查詢此訂單中是否有相同 logicalId 的項目（可能指向舊版本）
    const [existingRow] = await db
      .select({ id: orderItemsTable.id, qty: orderItemsTable.qty })
      .from(orderItemsTable)
      .innerJoin(
        menuItemsTable,
        eq(orderItemsTable.menuItemId, menuItemsTable.id),
      )
      .where(
        and(
          eq(orderItemsTable.orderId, orderId),
          eq(menuItemsTable.logicalId, input.logicalId),
        ),
      )
      .limit(1);

    if (existingRow) {
      if (input.qty === 0) {
        await db
          .delete(orderItemsTable)
          .where(eq(orderItemsTable.id, existingRow.id));
      } else {
        // 更新數量並指向最新版本
        await db
          .update(orderItemsTable)
          .set({
            qty: input.qty,
            menuItemId: currentVersion.id,
          })
          .where(eq(orderItemsTable.id, existingRow.id));
      }
    } else if (input.qty > 0) {
      await db.insert(orderItemsTable).values({
        orderId,
        menuItemId: currentVersion.id,
        qty: input.qty,
      });
    }

    // 重新從 DB 載入此訂單以取得最新資料
    const reloaded = await this.reloadOrder(orderId);
    if (reloaded) {
      const idx = this.orders.findIndex((o) => o.id === orderId);
      if (idx !== -1) this.orders[idx] = reloaded;
      return { ok: true, order: reloaded };
    }

    return { ok: false, code: "ORDER_NOT_FOUND" };
  }

  async submitOrder(
    orderId: number,
    input: { userId: string },
  ): Promise<
    | { ok: true; order: Order }
    | {
        ok: false;
        code:
          | "ORDER_NOT_FOUND"
          | "ORDER_NOT_OWNED"
          | "ORDER_NOT_EDITABLE"
          | "EMPTY_ORDER"
          | "OUTDATED_ITEMS";
        outdatedItems?: Array<{ logicalId: number; name: string }>;
      }
  > {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) return { ok: false, code: "ORDER_NOT_FOUND" };
    if (order.userId !== input.userId)
      return { ok: false, code: "ORDER_NOT_OWNED" };
    if (order.status !== "pending")
      return { ok: false, code: "ORDER_NOT_EDITABLE" };
    if (order.items.length === 0) return { ok: false, code: "EMPTY_ORDER" };

    // ── 驗證所有項目是否仍為當前版本 ─────────────────────────────
    const menuItemIds = order.items.map((oi) => oi.menuItemId);

    const versionRows = await db
      .select({
        id: menuItemsTable.id,
        logicalId: menuItemsTable.logicalId,
        name: menuItemsTable.name,
        isCurrentVersion: menuItemsTable.isCurrentVersion,
      })
      .from(menuItemsTable)
      .where(inArray(menuItemsTable.id, menuItemIds));

    const outdatedItems: Array<{ logicalId: number; name: string }> = [];
    for (const row of versionRows) {
      if (!row.isCurrentVersion) {
        outdatedItems.push({
          logicalId: row.logicalId,
          name: row.name,
        });
      }
    }

    if (outdatedItems.length > 0) {
      return {
        ok: false,
        code: "OUTDATED_ITEMS",
        outdatedItems,
      };
    }

    // ── 送出訂單 ───────────────────────────────────────────────
    const submittedAt = new Date();

    // 重新計算總額
    order.total = calculateTotal(order.items);

    await db
      .update(ordersTable)
      .set({
        status: "submitted",
        total: order.total,
        submittedAt,
      })
      .where(eq(ordersTable.id, orderId));

    order.status = "submitted";
    order.submittedAt = submittedAt.toISOString();

    return { ok: true, order };
  }

  // ── Private ─────────────────────────────────────────────────

  /**
   * 從 DB 重新載入單一訂單（含 items JOIN menu_items）
   */
  private async reloadOrder(orderId: number): Promise<Order | null> {
    const [orderRow] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId))
      .limit(1);

    if (!orderRow) return null;

    const oiRows = await db
      .select()
      .from(orderItemsTable)
      .innerJoin(
        menuItemsTable,
        eq(orderItemsTable.menuItemId, menuItemsTable.id),
      )
      .where(eq(orderItemsTable.orderId, orderId));

    const items: OrderItem[] = oiRows.map(({ order_items, menu_items }) =>
      toOrderItem(order_items, menu_items),
    );

    return toOrder(orderRow, items);
  }

  private async seedFromJsonIfEmpty(): Promise<void> {
    const [countRow] = await db
      .select({ value: sql<number>`count(*)` })
      .from(menuItemsTable);

    if (Number(countRow?.value ?? 0) > 0) return;

    const file = Bun.file(this.dataFilePath);
    if (!(await file.exists())) return;

    const parsed = JSON.parse(await file.text()) as SeedData;
    const menu = Array.isArray(parsed.menu) ? parsed.menu : [];

    if (menu.length > 0) {
      const now = new Date();
      await db.insert(menuItemsTable).values(
        menu.map((item) => ({
          entityId: crypto.randomUUID(),
          logicalId: item.id,
          version: 1,
          name: item.name,
          price: item.price,
          category: item.category,
          description: item.description,
          imageUrl: item.image_url,
          isCurrentVersion: true,
          changeReason: "初始建立",
          createdBy: "系統",
          createdAt: now,
        })),
      );
    }

    const schema = process.env.PG_SCHEMA ?? "public";
    await db.execute(
      sql.raw(
        `select setval('${schema}.menu_items_id_seq', coalesce((select max(id) from ${schema}.menu_items), 1), true)`,
      ),
    );
  }

  private async reloadFromDatabase(): Promise<void> {
    // ── 載入菜單（只取當前版本） ────────────────────────────────
    const menuRows = await db
      .select()
      .from(menuItemsTable)
      .where(eq(menuItemsTable.isCurrentVersion, true))
      .orderBy(asc(menuItemsTable.logicalId));

    this.menu = menuRows.map((row) => toMenuItem(row));

    // ── 載入訂單 ───────────────────────────────────────────────
    const orderRows = await db
      .select()
      .from(ordersTable)
      .orderBy(desc(ordersTable.createdAt), desc(ordersTable.id));

    const allOiRows = await db
      .select()
      .from(orderItemsTable)
      .innerJoin(
        menuItemsTable,
        eq(orderItemsTable.menuItemId, menuItemsTable.id),
      )
      .orderBy(asc(orderItemsTable.id));

    const itemsByOrderId = new Map<number, OrderItem[]>();
    for (const { order_items, menu_items } of allOiRows) {
      const items = itemsByOrderId.get(order_items.orderId) ?? [];
      items.push(toOrderItem(order_items, menu_items));
      itemsByOrderId.set(order_items.orderId, items);
    }

    this.orders = orderRows.map((row) =>
      toOrder(row, itemsByOrderId.get(row.id) ?? []),
    );
  }
}
