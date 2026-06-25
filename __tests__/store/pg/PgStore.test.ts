import { describe, test, expect, beforeEach, mock } from "bun:test";

// ─── Mock 管理 ─────────────────────────────────────────────────────────────────
// 模擬 db 模組（db/client.ts），取代實際資料庫連線。
//
// 原理：Drizzle 的 query builder 在鏈式呼叫時不執行 SQL，
// 只在最終 await 時才觸發執行。我們用一個惰性 QueryBuilder，
// 所有中間方法（.where(), .limit(), .innerJoin() 等）都回傳新的
// QueryBuilder，而回應只在 .then() 被呼叫時消耗一次。

const mockState = { responses: [] as unknown[], index: 0 };

function resetMock(...responses: unknown[]) {
  mockState.responses = responses;
  mockState.index = 0;
}

/** 建立一個惰性 QueryBuilder Proxy */
function qb(): any {
  let consumed = false;

  function consume() {
    if (!consumed) {
      consumed = true;
      const r = mockState.responses[mockState.index];
      mockState.index++;
      return r ?? [];
    }
    return [];
  }

  return {
    // ── thenable 介面：await 時觸發 ──────────────────────────────────────
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(consume()).then(onFulfilled, onRejected),
    catch: (onRejected: any) => Promise.resolve(consume()).catch(onRejected),
    finally: (onFinally: any) => Promise.resolve(consume()).finally(onFinally),

    // ── 鏈式方法：全部回傳新的 QueryBuilder ──────────────────────────────
    from: () => qb(),
    where: () => qb(),
    limit: () => qb(),
    innerJoin: () => qb(),
    orderBy: () => qb(),
    values: () => qb(),
    set: () => ({ where: () => qb() }),
  };
}

function createMockDb() {
  return {
    select: () => ({ from: () => qb() }),
    insert: () => qb(),
    update: () => qb(),
    delete: () => qb(),
    execute: () => qb(),
  };
}

// 在 import PgStore 前攔截 db/client.ts
mock.module("../../../db/client.ts", () => ({ db: createMockDb() }));

const { PgStore } = await import("../../../store/pg/PgStore.ts");

// ─── test helpers ──────────────────────────────────────────────────────────────

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: "test-user",
    items: [],
    total: 0,
    status: "pending",
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("PgStore.updateOrderItem()", () => {
  // ── 錯誤路徑：in-memory 檢查（不依賴 DB mock）───────────────────────────

  test("回傳 ORDER_NOT_FOUND — 訂單 ID 不存在", async () => {
    resetMock();
    const store = new PgStore();
    (store as any).orders = [];

    const result = await store.updateOrderItem(999, {
      userId: "test-user",
      logicalId: 5,
      qty: 1,
    });

    expect(result).toEqual({ ok: false, code: "ORDER_NOT_FOUND" });
  });

  test("回傳 ORDER_NOT_OWNED — 訂單不屬於該使用者", async () => {
    resetMock();
    const store = new PgStore();
    (store as any).orders = [makeOrder({ id: 1, userId: "other-user" })];

    const result = await store.updateOrderItem(1, {
      userId: "test-user",
      logicalId: 5,
      qty: 1,
    });

    expect(result).toEqual({ ok: false, code: "ORDER_NOT_OWNED" });
  });

  test("回傳 ORDER_NOT_EDITABLE — 訂單已送出", async () => {
    resetMock();
    const store = new PgStore();
    (store as any).orders = [
      makeOrder({ id: 1, userId: "test-user", status: "submitted" }),
    ];

    const result = await store.updateOrderItem(1, {
      userId: "test-user",
      logicalId: 5,
      qty: 1,
    });

    expect(result).toEqual({ ok: false, code: "ORDER_NOT_EDITABLE" });
  });

  // ── 錯誤路徑：DB 查不到 current version ─────────────────────────────────

  test("回傳 MENU_ITEM_NOT_FOUND — logicalId 無對應 current version", async () => {
    resetMock([]);
    const store = new PgStore();
    (store as any).orders = [makeOrder()];

    const result = await store.updateOrderItem(1, {
      userId: "test-user",
      logicalId: 5,
      qty: 1,
    });

    expect(result).toEqual({ ok: false, code: "MENU_ITEM_NOT_FOUND" });
  });

  // ── Happy paths ─────────────────────────────────────────────────────────
  //
  // updateOrderItem() 的 DB terminal call 順序：
  //   1. select → from → where → limit             ← 查 current version
  //   2. select → from → innerJoin → where → limit  ← 查既有 order_item
  //   3. insert / update / delete                   ← 寫入
  //   4. select → from → where → limit              ← reloadOrder 查 orders
  //   5. select → from → innerJoin → where           ← reloadOrder 查 items
  // ────────────────────────────────────────────────────────────────────────

  test("加入新品項（qty>0, 訂單中原無此 logicalId）", async () => {
    resetMock(
      // terminal 1: current version 存在
      [{ id: 10, logicalId: 5, name: "火腿蛋餅", price: 35, version: 1 }],
      // terminal 2: 訂單中無此 logicalId
      [],
      // terminal 3: INSERT（void）
      [],
      // terminal 4: reloadOrder → orders row
      [
        {
          id: 1,
          userId: "test-user",
          total: 0,
          status: "pending",
          createdAt: new Date("2025-01-01"),
          submittedAt: null,
        },
      ],
      // terminal 5: reloadOrder → items JOIN
      [
        {
          order_items: { id: 1, orderId: 1, menuItemId: 10, qty: 2 },
          menu_items: {
            id: 10,
            logicalId: 5,
            name: "火腿蛋餅",
            price: 35,
            category: "蛋餅",
            description: "好吃",
            imageUrl: "/images/ham-egg.png",
            version: 1,
          },
        },
      ],
    );

    const store = new PgStore();
    (store as any).orders = [makeOrder()];

    const result = await store.updateOrderItem(1, {
      userId: "test-user",
      logicalId: 5,
      qty: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.items).toHaveLength(1);
      expect(result.order.items[0].menuItemName).toBe("火腿蛋餅");
      expect(result.order.items[0].menuItemPrice).toBe(35);
      expect(result.order.items[0].qty).toBe(2);
    }
  });

  test("更新既有品項數量（qty>0, 訂單中已有此 logicalId）", async () => {
    resetMock(
      // terminal 1: current version（v2，已漲價）
      [{ id: 11, logicalId: 5, name: "火腿蛋餅", price: 40, version: 2 }],
      // terminal 2: 找到既有 order_item
      [{ id: 100, qty: 1 }],
      // terminal 3: UPDATE（void）
      [],
      // terminal 4: reloadOrder → orders row
      [
        {
          id: 1,
          userId: "test-user",
          total: 0,
          status: "pending",
          createdAt: new Date(),
          submittedAt: null,
        },
      ],
      // terminal 5: reloadOrder → items JOIN
      [
        {
          order_items: { id: 100, orderId: 1, menuItemId: 11, qty: 3 },
          menu_items: {
            id: 11,
            logicalId: 5,
            name: "火腿蛋餅",
            price: 40,
            category: "蛋餅",
            description: "好吃",
            imageUrl: "/images/ham-egg.png",
            version: 2,
          },
        },
      ],
    );

    const store = new PgStore();
    (store as any).orders = [makeOrder()];

    const result = await store.updateOrderItem(1, {
      userId: "test-user",
      logicalId: 5,
      qty: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.items[0].qty).toBe(3);
      expect(result.order.items[0].menuItemPrice).toBe(40);
      expect(result.order.items[0].menuItemVersion).toBe(2);
    }
  });

  test("移除品項（qty=0, 訂單中已有此 logicalId）", async () => {
    resetMock(
      // terminal 1
      [{ id: 10, logicalId: 5, name: "火腿蛋餅", price: 35, version: 1 }],
      // terminal 2: 找到既有 item
      [{ id: 100, qty: 2 }],
      // terminal 3: DELETE（void）
      [],
      // terminal 4: reloadOrder → orders row
      [
        {
          id: 1,
          userId: "test-user",
          total: 0,
          status: "pending",
          createdAt: new Date(),
          submittedAt: null,
        },
      ],
      // terminal 5: reloadOrder → 無 items
      [],
    );

    const store = new PgStore();
    (store as any).orders = [makeOrder()];

    const result = await store.updateOrderItem(1, {
      userId: "test-user",
      logicalId: 5,
      qty: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.items).toHaveLength(0);
    }
  });

  test("新品項 qty=0 且訂單中無此項目 → no-op", async () => {
    // 此路徑跳過 terminal 3（無既有 item 且 qty=0 → 不做事）
    resetMock(
      // terminal 1
      [{ id: 10, logicalId: 5, name: "火腿蛋餅", price: 35, version: 1 }],
      // terminal 2: 無既有 item
      [],
      // terminal 3: reloadOrder → orders row（index 2, not 3）
      [
        {
          id: 1,
          userId: "test-user",
          total: 0,
          status: "pending",
          createdAt: new Date(),
          submittedAt: null,
        },
      ],
      // terminal 4: reloadOrder → 無 items（index 3）
      [],
    );

    const store = new PgStore();
    (store as any).orders = [makeOrder()];

    const result = await store.updateOrderItem(1, {
      userId: "test-user",
      logicalId: 5,
      qty: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.items).toHaveLength(0);
    }
  });

  // ── 邊界情況 ────────────────────────────────────────────────────────────

  test("DB 寫入成功但 reloadOrder 找不到該訂單 → 回傳 ORDER_NOT_FOUND", async () => {
    resetMock(
      // terminal 1: current version
      [{ id: 10, logicalId: 5, name: "火腿蛋餅", price: 35, version: 1 }],
      // terminal 2: 無既有 item
      [],
      // terminal 3: INSERT（void）
      [],
      // terminal 4: reloadOrder → orders query → 空結果
      [],
    );

    const store = new PgStore();
    (store as any).orders = [makeOrder()];

    const result = await store.updateOrderItem(1, {
      userId: "test-user",
      logicalId: 5,
      qty: 1,
    });

    expect(result).toEqual({ ok: false, code: "ORDER_NOT_FOUND" });
  });
});
