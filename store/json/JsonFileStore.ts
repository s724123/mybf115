import { mkdir, rename } from "node:fs/promises";
import type {
  MenuItem,
  MenuItemVersionHistory,
  Order,
  OrderItem,
} from "../../shared/contracts.ts";
import type { Store } from "../Store.ts";

interface StoredUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

interface DataStore {
  users: StoredUser[];
  menu: MenuItem[];
  orders: Order[];
  userIdCounter: number;
  menuIdCounter: number;
  orderIdCounter: number;
}

interface JsonFileStoreOptions {
  dataFilePath: string;
}

const defaultMenu: MenuItem[] = [
  {
    id: 1,
    entityId: crypto.randomUUID(),
    logicalId: 1,
    version: 1,
    name: "火腿蛋吐司",
    price: 40,
    category: "餐點",
    description: "現煎雞蛋搭配火腿與生菜，使用微烤白吐司，口感清爽不油膩。",
    image_url: "/imgs/menu/ham-egg-toast.webp",
    isCurrentVersion: true,
    changeReason: "初始建立",
    createdBy: "系統",
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    entityId: crypto.randomUUID(),
    logicalId: 2,
    version: 1,
    name: "起司豬排堡",
    price: 65,
    category: "餐點",
    description: "厚切豬排搭配起司與生菜，外酥內嫩，適合喜歡有咬勁的你。",
    image_url: "/imgs/menu/cheese-pork-burger.webp",
    isCurrentVersion: true,
    changeReason: "初始建立",
    createdBy: "系統",
    createdAt: new Date().toISOString(),
  },
  {
    id: 3,
    entityId: crypto.randomUUID(),
    logicalId: 3,
    version: 1,
    name: "鮪魚蛋吐司",
    price: 45,
    category: "餐點",
    description: "自調鮪魚沙拉配上煎蛋與生菜，口味濃郁但不會太鹹。",
    image_url: "/imgs/menu/tuna-egg-toast.webp",
    isCurrentVersion: true,
    changeReason: "初始建立",
    createdBy: "系統",
    createdAt: new Date().toISOString(),
  },
  {
    id: 4,
    entityId: crypto.randomUUID(),
    logicalId: 4,
    version: 1,
    name: "培根蛋餅",
    price: 45,
    category: "餐點",
    description: "煎到微酥的蛋餅皮包裹煙燻培根與雞蛋，是經典台式早餐選擇。",
    image_url: "/imgs/menu/bacon-egg-roll.webp",
    isCurrentVersion: true,
    changeReason: "初始建立",
    createdBy: "系統",
    createdAt: new Date().toISOString(),
  },
];

function cloneDefaultMenu(): MenuItem[] {
  return defaultMenu.map((item) => ({
    ...item,
    entityId: crypto.randomUUID(),
  }));
}

function calculateOrderTotal(items: OrderItem[]): number {
  return items.reduce((sum, oi) => sum + oi.menuItemPrice * oi.qty, 0);
}

/**
 * 回溯舊版 store.json 中缺少版本欄位的 menu items
 */
function normalizeMenuItem(item: Partial<MenuItem>): MenuItem {
  return {
    id: item.id ?? 0,
    entityId: item.entityId ?? crypto.randomUUID(),
    logicalId: item.logicalId ?? item.id ?? 0,
    version: item.version ?? 1,
    name: item.name ?? "",
    price: item.price ?? 0,
    category: item.category ?? "",
    description: item.description ?? "",
    image_url: item.image_url ?? "",
    isCurrentVersion: item.isCurrentVersion ?? true,
    changeReason: item.changeReason ?? "初始建立",
    createdBy: item.createdBy ?? "系統",
    createdAt: item.createdAt ?? new Date().toISOString(),
  };
}

function normalizeUserId(rawId: unknown): string {
  if (typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0) {
    return String(rawId).padStart(4, "0");
  }

  if (typeof rawId === "string" && rawId.trim() !== "") {
    const trimmed = rawId.trim();
    if (/^\d+$/.test(trimmed)) {
      return trimmed.padStart(4, "0");
    }
    return trimmed;
  }

  return "0001";
}

function normalizeUser(user: Partial<StoredUser>): StoredUser {
  return {
    id: normalizeUserId(user.id),
    email: user.email ?? "",
    name: user.name ?? "",
    password: user.password ?? "",
  };
}

const defaultUsers: StoredUser[] = [
  {
    id: "0001",
    email: "demo@example.com",
    name: "示範使用者",
    password: "1234",
  },
  {
    id: "0002",
    email: "amy@example.com",
    name: "Amy",
    password: "1234",
  },
];

function cloneDefaultUsers(): StoredUser[] {
  return defaultUsers.map((user) => ({ ...user }));
}

/** 從 MenuItem 找出該 logicalId 當前版本的 id */
function findCurrentVersionId(menu: MenuItem[], logicalId: number): number {
  const item = menu.find(
    (mi) => mi.logicalId === logicalId && mi.isCurrentVersion,
  );
  return item?.id ?? 0;
}

/** 從 menu array 建構 OrderItem（含 menu item 資訊的 flat fields） */
function buildOrderItem(
  menu: MenuItem[],
  logicalId: number,
  qty: number,
): OrderItem {
  // 用當前版本
  const version = menu.find(
    (mi) => mi.logicalId === logicalId && mi.isCurrentVersion,
  );
  return {
    menuItemId: version?.id ?? 0,
    menuItemName: version?.name ?? "",
    menuItemPrice: version?.price ?? 0,
    menuItemCategory: version?.category ?? "",
    menuItemDescription: version?.description ?? "",
    menuItemImageUrl: version?.image_url ?? "",
    menuItemVersion: version?.version ?? 1,
    qty,
  };
}

/** 從 menu array 查詢指定版 ID 的資訊，回填到 OrderItem */
function enrichOrderItem(menu: MenuItem[], oi: OrderItem): OrderItem {
  const version = menu.find((mi) => mi.id === oi.menuItemId);
  if (version) {
    return {
      ...oi,
      menuItemName: version.name,
      menuItemPrice: version.price,
      menuItemCategory: version.category,
      menuItemDescription: version.description,
      menuItemImageUrl: version.image_url,
      menuItemVersion: version.version,
    };
  }
  return oi;
}

export class JsonFileStore implements Store {
  private readonly dataFilePath: string;

  private users: StoredUser[] = [];
  private menu: MenuItem[] = [];
  private orders: Order[] = [];
  private userIdCounter = 0;
  private menuIdCounter = 0;
  private orderIdCounter = 0;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonFileStoreOptions) {
    this.dataFilePath = options.dataFilePath;
  }

  async init(): Promise<void> {
    const file = Bun.file(this.dataFilePath);

    if (!(await file.exists())) {
      const initialStore = this.createInitialStore();
      this.applyStore(initialStore);
      await this.saveStore(initialStore);
      return;
    }

    try {
      const rawText = await file.text();
      const parsed = JSON.parse(rawText) as Partial<DataStore>;

      if (!Array.isArray(parsed.menu) || !Array.isArray(parsed.orders)) {
        throw new Error("Invalid store schema");
      }

      const normalizedUsers = Array.isArray(parsed.users)
        ? parsed.users.map((user) => normalizeUser(user))
        : cloneDefaultUsers();

      const fallbackUserId = normalizedUsers[0]?.id ?? "0001";

      this.applyStore({
        users: normalizedUsers,
        menu: parsed.menu.map((item) => normalizeMenuItem(item)),
        orders: parsed.orders.map((order) => ({
          ...order,
          userId: normalizeUserId(order.userId ?? fallbackUserId),
          items: order.items.map((orderItem) => {
            // 回溯舊版 store.json 的巢狀 item 格式
            if ("item" in orderItem) {
              const old = orderItem as { item: Partial<MenuItem>; qty: number };
              const normalized = normalizeMenuItem(old.item);
              return {
                menuItemId: normalized.id,
                menuItemName: normalized.name,
                menuItemPrice: normalized.price,
                menuItemCategory: normalized.category,
                menuItemDescription: normalized.description,
                menuItemImageUrl: normalized.image_url,
                menuItemVersion: normalized.version,
                qty: old.qty,
              } as OrderItem;
            }
            return orderItem as OrderItem;
          }),
          status: order.status === "submitted" ? "submitted" : "pending",
          submittedAt:
            order.status === "submitted" ? order.submittedAt : undefined,
        })),
        userIdCounter: parsed.userIdCounter ?? 0,
        menuIdCounter: parsed.menuIdCounter ?? 0,
        orderIdCounter: parsed.orderIdCounter ?? 0,
      });
    } catch (error) {
      console.warn("[store] load failed, fallback to initial store", error);
      const initialStore = this.createInitialStore();
      this.applyStore(initialStore);
      await this.saveStore(initialStore);
    }
  }

  getMenu(): ReadonlyArray<MenuItem> {
    return this.menu.filter((mi) => mi.isCurrentVersion);
  }

  async getMenuItemVersions(
    logicalId: number,
  ): Promise<MenuItemVersionHistory[]> {
    return this.menu
      .filter((mi) => mi.logicalId === logicalId)
      .sort((a, b) => b.version - a.version)
      .map((mi) => ({
        version: mi.version,
        id: mi.id,
        name: mi.name,
        price: mi.price,
        category: mi.category,
        description: mi.description,
        image_url: mi.image_url,
        changeReason: mi.changeReason,
        createdBy: mi.createdBy,
        createdAt: mi.createdAt,
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
    const maxLogicalId = this.menu.reduce(
      (max, mi) => Math.max(max, mi.logicalId),
      0,
    );
    const entityId = crypto.randomUUID();
    const now = new Date().toISOString();

    const newMenuItem: MenuItem = {
      id: ++this.menuIdCounter,
      entityId,
      logicalId: maxLogicalId + 1,
      version: 1,
      name: input.name,
      price: input.price,
      category: input.category,
      description: input.description,
      image_url: input.image_url,
      isCurrentVersion: true,
      changeReason: undefined,
      createdBy: input.createdBy,
      createdAt: now,
    };

    this.menu.push(newMenuItem);
    await this.persist();

    return newMenuItem;
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
    const current = this.menu.find(
      (mi) => mi.logicalId === menuId && mi.isCurrentVersion,
    );
    if (!current) return null;

    // 標記為非當前
    current.isCurrentVersion = false;

    // 建立新版本
    const now = new Date().toISOString();
    const newVersion: MenuItem = {
      id: ++this.menuIdCounter,
      entityId: current.entityId,
      logicalId: current.logicalId,
      version: current.version + 1,
      name: patch.name ?? current.name,
      price: patch.price ?? current.price,
      category: patch.category ?? current.category,
      description: patch.description ?? current.description,
      image_url: patch.image_url ?? current.image_url,
      isCurrentVersion: true,
      changeReason: patch.reason,
      createdBy: patch.createdBy,
      createdAt: now,
    };

    this.menu.push(newVersion);
    await this.persist();

    return newVersion;
  }

  async deleteMenuItem(menuId: number): Promise<MenuItem | null> {
    // 刪除所有版本
    const removed = this.menu.find(
      (mi) => mi.logicalId === menuId && mi.isCurrentVersion,
    );
    if (!removed) return null;

    this.menu = this.menu.filter((mi) => mi.logicalId !== menuId);
    await this.persist();

    return removed;
  }

  getOrders(): ReadonlyArray<Order> {
    return this.orders;
  }

  getCurrentOrderByUserId(userId: string): Order | undefined {
    const pendingOrders = this.orders.filter(
      (order) => order.userId === userId && order.status === "pending",
    );

    if (pendingOrders.length === 0) {
      return undefined;
    }

    return pendingOrders.reduce((latest, current) =>
      current.id > latest.id ? current : latest,
    );
  }

  getOrderHistoryByUserId(userId: string): ReadonlyArray<Order> {
    return this.orders
      .filter(
        (order) => order.userId === userId && order.status === "submitted",
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getOrderById(orderId: number): Order | undefined {
    return this.orders.find((order) => order.id === orderId);
  }

  async createOrder(input: { userId: string }): Promise<Order> {
    const existingOrder = this.getCurrentOrderByUserId(input.userId);
    if (existingOrder) {
      return existingOrder;
    }

    const newOrder: Order = {
      id: ++this.orderIdCounter,
      userId: input.userId,
      items: [],
      total: 0,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.orders.push(newOrder);
    await this.persist();

    return newOrder;
  }

  async updateOrderItem(
    orderId: number,
    input: {
      userId: string;
      logicalId: number;
      qty: number;
    },
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
    const order = this.orders.find((targetOrder) => targetOrder.id === orderId);
    if (!order) {
      return { ok: false, code: "ORDER_NOT_FOUND" };
    }

    if (order.userId !== input.userId) {
      return { ok: false, code: "ORDER_NOT_OWNED" };
    }

    if (order.status !== "pending") {
      return { ok: false, code: "ORDER_NOT_EDITABLE" };
    }

    // 確認該 logicalId 有當前版本
    const currentVersionId = findCurrentVersionId(this.menu, input.logicalId);
    if (!currentVersionId) {
      return { ok: false, code: "MENU_ITEM_NOT_FOUND" };
    }

    // 找訂單中已有的同一 logicalId 項目（可能指向舊版本）
    const existingIdx = order.items.findIndex((oi) => {
      const inMenu = this.menu.find((mi) => mi.id === oi.menuItemId);
      return inMenu?.logicalId === input.logicalId;
    });

    if (existingIdx !== -1) {
      if (input.qty === 0) {
        order.items.splice(existingIdx, 1);
      } else {
        // 更新數量並指向最新版本
        order.items[existingIdx] = buildOrderItem(
          this.menu,
          input.logicalId,
          input.qty,
        );
      }
    } else if (input.qty > 0) {
      order.items.push(buildOrderItem(this.menu, input.logicalId, input.qty));
    }

    // 確保所有 items 的資訊都是最新的
    order.items = order.items.map((oi) => enrichOrderItem(this.menu, oi));

    order.total = calculateOrderTotal(order.items);
    await this.persist();

    return { ok: true, order };
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
    const order = this.orders.find((targetOrder) => targetOrder.id === orderId);
    if (!order) {
      return { ok: false, code: "ORDER_NOT_FOUND" };
    }

    if (order.userId !== input.userId) {
      return { ok: false, code: "ORDER_NOT_OWNED" };
    }

    if (order.status !== "pending") {
      return { ok: false, code: "ORDER_NOT_EDITABLE" };
    }

    if (order.items.length === 0) {
      return { ok: false, code: "EMPTY_ORDER" };
    }

    // ── 驗證所有項目是否仍為當前版本 ─────────────────────────────
    const outdatedItems: Array<{ logicalId: number; name: string }> = [];
    for (const oi of order.items) {
      const version = this.menu.find((mi) => mi.id === oi.menuItemId);
      if (version && !version.isCurrentVersion) {
        outdatedItems.push({
          logicalId: version.logicalId,
          name: version.name,
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
    // 確保所有 items 資訊為最新
    order.items = order.items.map((oi) => enrichOrderItem(this.menu, oi));

    order.total = calculateOrderTotal(order.items);

    order.status = "submitted";
    order.submittedAt = new Date().toISOString();
    await this.persist();

    return { ok: true, order };
  }

  private createInitialStore(): DataStore {
    return {
      users: cloneDefaultUsers(),
      menu: cloneDefaultMenu(),
      orders: [],
      userIdCounter: defaultUsers.length,
      menuIdCounter: defaultMenu.length,
      orderIdCounter: 0,
    };
  }

  private applyStore(store: DataStore): void {
    this.users = store.users;
    this.menu = store.menu;
    this.orders = store.orders;

    const maxUserId = this.users.reduce((max, user) => {
      const asNumber = Number.parseInt(user.id, 10);
      return Number.isFinite(asNumber) ? Math.max(max, asNumber) : max;
    }, 0);

    const maxMenuId = this.menu.reduce(
      (max, item) => Math.max(max, item.id),
      0,
    );
    const maxOrderId = this.orders.reduce(
      (max, order) => Math.max(max, order.id),
      0,
    );

    this.userIdCounter = Math.max(store.userIdCounter || 0, maxUserId);
    this.menuIdCounter = Math.max(store.menuIdCounter || 0, maxMenuId);
    this.orderIdCounter = Math.max(store.orderIdCounter || 0, maxOrderId);
  }

  private buildStoreSnapshot(): DataStore {
    return {
      users: this.users,
      menu: this.menu,
      orders: this.orders,
      userIdCounter: this.userIdCounter,
      menuIdCounter: this.menuIdCounter,
      orderIdCounter: this.orderIdCounter,
    };
  }

  private async saveStore(snapshot: DataStore): Promise<void> {
    await mkdir("./data", { recursive: true });
    const tmpPath = `${this.dataFilePath}.tmp`;
    await Bun.write(tmpPath, JSON.stringify(snapshot, null, 2));
    await rename(tmpPath, this.dataFilePath);
  }

  private async persist(): Promise<void> {
    const snapshot = this.buildStoreSnapshot();

    this.persistQueue = this.persistQueue.then(async () => {
      await this.saveStore(snapshot);
    });

    await this.persistQueue;
  }
}
