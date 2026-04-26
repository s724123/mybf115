# Schema 一致性設計：Zod 與 Drizzle 多層架構

建議前置閱讀：

- [02_0_API contract truth 的重要性與實作方式.md](./02_0_API%20contract%20truth%20的重要性與實作方式.md)
- [02*1*從目前 backend.ts 補齊 Elysia route schema 的實作步驟清單.md](./02_1_從目前%20backend.ts%20補齊%20Elysia%20route%20schema%20的實作步驟清單.md)
- [03\_為什麼這個專案選 Drizzle + Neon.md](./03_為什麼這個專案選%20Drizzle%20+%20Neon.md)

---

## 1. 問題核心

目前在 V8 版本的開發過程中，發現 **Schema 定義散落在三個地方**，造成維護上的重複：

| 檔案位置              | 用途       | 定義方式               | 問題                              |
| --------------------- | ---------- | ---------------------- | --------------------------------- |
| `shared/contracts.ts` | 前後端合約 | TypeScript `interface` | 純型別，無運行時驗證              |
| `backend.ts`          | API 驗證   | Elysia `t.Object()`    | 重複定義，手動同步                |
| `db/schema.ts`        | DB 結構    | Drizzle `table()`      | DB 型別包含 `password` 等敏感欄位 |

**核心問題**：同一個資料結構需要維護三份定義，容易出現不同步的情況。

---

## 2. 錯誤的統一方式：為什麼不用 Drizzle schema 作為 Single Source？

### 技術上可行

Drizzle 提供型別推導工具：

```ts
// db/schema.ts
export const usersTable = appSchema.table("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  password: text("password").notNull(), // ⚠️ DB 層專有
});

export type DbUser = typeof usersTable.$inferSelect;
// → { id: string, email: string, name: string, password: string }
```

### 但概念上不對

**DB 層和 API 層的職責不同**：

1. **DB Schema 是儲存介質的描述**
   - 包含所有欄位（包括 `password`、`createdAt`、內部ID等）
   - 是持久化層的真相

2. **API Contract 是業務邊界**
   - 只暴露某些欄位（`SessionUser` 不含 `password`）
   - 是客戶端與伺服器的承諾

**混淆兩者會造成**：

- 安全洩漏：不小心把 `password` 暴露在 API response
- 難以演進：DB 結構改變時，強制 API 跟著改
- 混亂的責任：無法清楚區分「什麼是 DB 考量」vs「什麼是 API 考量」

---

## 3. 正確的統一方式：Zod 作為 Single Source

### 架構圖

```
┌─────────────────────────────────────────────────┐
│       shared/contracts.ts                       │
│      (API Business Layer)                       │
│                                                  │
│  ✅ sessionUserSchema = z.object({              │
│       id, email, name  (NO password)            │
│     })                                           │
│  ✅ menuItemSchema = z.object({...})            │
│  ✅ orderResponseSchema = z.object({...})       │
│                                                  │
│  export type SessionUser = z.infer<...>        │
│  export type MenuItem = z.infer<...>           │
└─────────────────────────────────────────────────┘
           ↓                           ↓
      用於 backend.ts            型別推導用
    (API 驗證、OpenAPI)         (前後端共用)
           ↓                           ↓
┌──────────────────────┐  ┌────────────────────┐
│    backend.ts        │  │  frontend/src/     │
│  (Elysia routes)     │  │  (API client)      │
│                      │  │                    │
│ app.post("/api/...", │  │ const user:        │
│   { response: {...}},│  │   SessionUser =    │
│ )                    │  │   await login()    │
└──────────────────────┘  └────────────────────┘
           ↓
     ✅ 單一真相來源
     ✅ 自動型別推導
     ✅ 運行時驗證
     ✅ OpenAPI 自動生成

─────────────────────────────────────────────────

         db/schema.ts
       (DB Storage Layer)
           ↓
    usersTable = appSchema.table({
      id, email, name, password, createdAt, ...
    })
           ↓
    type DbUser = $inferSelect
           ↓
    ✅ 用於 auth/PgAuth.ts
    ✅ 用於 store/PgStore.ts
    ✅ 只在內部邏輯層使用
```

### 三層的職責邊界

```typescript
// Layer 1: API Business Contract (shared/contracts.ts)
// ─────────────────────────────────────────────────
import { z } from "zod";

export const sessionUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  // ❌ NO password!
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

// Layer 2: API Routes (backend.ts)
// ─────────────────────────────────────────────────
import { sessionUserSchema } from "./shared/contracts.ts";

app.post(
  "/api/auth/login",
  ({ body, set }) => {
    const result = auth.login(body);
    if (!result.ok) {
      set.status = 401;
      return { error: "Invalid credentials" };
    }
    return { data: result.user }; // ✅ 自動推導為 SessionUser
  },
  {
    response: {
      200: z.object({ data: sessionUserSchema }), // ✅ 單一真相
      401: apiErrorSchema,
    },
  },
);

// Layer 3: Database Storage (db/schema.ts & auth/PgAuth.ts)
// ─────────────────────────────────────────────────
import type { DbUser } from "./db/schema.ts";

class PgAuth {
  private users: DbUser[] = []; // ✅ 含 password，用於驗證

  login(email: string, password: string): { ok: boolean; user?: SessionUser } {
    const dbUser = this.users.find((u) => u.email === email);
    if (!dbUser || !this.verifyPassword(password, dbUser.password)) {
      return { ok: false };
    }
    // ✅ 轉換：DbUser → SessionUser (移除 password)
    const safeUser: SessionUser = {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
    };
    return { ok: true, user: safeUser };
  }
}
```

---

## 4. 實作步驟（V8+ 版本）

### Step 1：遷移 shared/contracts.ts 到 Zod

```ts
// shared/contracts.ts

import { z } from "zod";

// API Business Contracts (無 password、無 DB 內部欄位)
export const sessionUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
});

export const menuItemSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  price: z.number().min(0),
  category: z.string().min(1),
  description: z.string(),
  image_url: z.string().min(1),
});

export const orderItemSchema = z.object({
  item: menuItemSchema,
  qty: z.number().min(0),
});

export const orderResponseSchema = z.object({
  id: z.number().int().positive(),
  userId: z.string().min(1),
  items: z.array(orderItemSchema),
  total: z.number().min(0),
  status: z.enum(["pending", "submitted"]),
  createdAt: z.string().datetime(),
  submittedAt: z.string().datetime().optional(),
  createdAtTaipei: z.string().min(1),
});

// Derived types (自動推導，永不過時)
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type MenuItem = z.infer<typeof menuItemSchema>;
export type OrderItem = z.infer<typeof orderItemSchema>;
export type OrderResponse = z.infer<typeof orderResponseSchema>;
```

### Step 2：更新 backend.ts

```ts
// backend.ts

import { sessionUserSchema, orderResponseSchema } from "./shared/contracts.ts";

// ✅ 改用 shared schema，而不是本地 t.Object() 定義
app.post(
  "/api/auth/login",
  ({ body, set }) => {
    const result = auth.login(body);
    if (!result.ok) {
      set.status = 401;
      return { error: "Invalid credentials" };
    }
    return { data: result.user };
  },
  {
    body: z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }),
    response: {
      200: z.object({ data: sessionUserSchema }),
      401: apiErrorResponseSchema,
    },
  },
);
```

### Step 3：Drizzle schema 保持獨立

```ts
// db/schema.ts
// 無需改變，照常定義包含 password 的完整 DB 結構

export const usersTable = appSchema.table("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  password: text("password").notNull(), // ✅ DB 層保留
});

export type DbUser = typeof usersTable.$inferSelect;
```

### Step 4：Auth 層做轉換

```ts
// auth/PgAuth.ts

import type { SessionUser } from "../shared/contracts.ts";
import type { DbUser } from "../db/schema.ts";

class PgAuth {
  login(email: string, password: string): { ok: boolean; user?: SessionUser } {
    const dbUser = this.users.find((u) => u.email === email);
    if (!dbUser) return { ok: false };

    // ✅ 轉換：DbUser → SessionUser
    const safeUser: SessionUser = {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      // ❌ password 刻意被排除
    };

    return { ok: true, user: safeUser };
  }
}
```

---

## 5. 優點總結

| 方面              | 改善前                              | 改善後                      |
| ----------------- | ----------------------------------- | --------------------------- |
| **Single Source** | 三個地方                            | 一個（shared/contracts.ts） |
| **型別推導**      | 手動                                | 自動（z.infer）             |
| **運行時驗證**    | 有（t.Object），但分散              | 有（Zod），且集中           |
| **安全性**        | password 可能洩漏                   | 明確分層，無洩漏風險        |
| **API 演進**      | 改 contracts.ts 要同步改 backend.ts | 自動同步                    |
| **OpenAPI 生成**  | Elysia 推導 t.Object                | Zod schema 直接用           |

---

## 6. 額外考量：與 Elysia 整合

Elysia 自身支援 Zod schemas：

```ts
import { Elysia, t } from "elysia";

const app = new Elysia();

// ✅ Elysia 可直接用 Zod schemas
app.post("/api/orders", handler, {
  body: orderCreateSchema, // ← Zod schema
  response: {
    200: z.object({ data: orderResponseSchema }),
    400: apiErrorSchema,
  },
});
```

也可混用 Elysia `t` 和 Zod，但建議統一用 Zod 以保持 single source of truth。

---

## 7. 遷移時間表

| 版本                                   | 任務                                               | 優先度 | 狀態    |
| -------------------------------------- | -------------------------------------------------- | ------ | ------- |
| V8（feat/v8-clean-drizzle-neon）       | 補齊 Elysia schema，固定 API contract              | 🔴 高  | ✅ 完成 |
| V8-v2（feat/v8-clean-drizzle-neon-v2） | 遷移 contracts.ts 至 Zod，移除 backend.ts 重複定義 | 🟡 中  | ✅ 完成 |
| V9                                     | 整合 Better Auth，搭配 Zod 架構                    | 🟢 低  | ⏳ 待做 |

---

## 8. 相關討論紀錄

**決策時間**：2026-04-26

**討論過程**：

- Q: Drizzle schema 可以作為 Single Source 嗎？
- A: 技術可行，但概念不對。Drizzle schema 是 DB 層（包含 password），API contract 是業務邊界（不含 password），兩者職責不同。
- 結論：採用 Zod 作為 API Business Contract Single Source，Drizzle 保持 DB 層獨立地位，兩層各司其職。

---

## 9. 相關檔案

- `shared/contracts.ts` — API 業務層定義（✅ 已遷移至 Zod，`feat/v8-clean-drizzle-neon-v2`）
- `backend.ts` — API 路由定義（✅ 已改用 shared Zod schemas，`feat/v8-clean-drizzle-neon-v2`）
- `db/schema.ts` — DB 結構定義（保持獨立，Drizzle table 定義）
- `auth/PgAuth.ts` — 認證層（負責 DbUser → SessionUser 轉換）
- `store/PgStore.ts` — 資料層（使用 DbUser、DbMenuItem 等 Drizzle 推導型別）

---

## 10. 實際實作紀錄（feat/v8-clean-drizzle-neon-v2）

**實作日期**：2026-04-26  
**分支**：`feat/v8-clean-drizzle-neon-v2`（從 `feat/v8-clean-drizzle-neon` 切出）  
**異動檔案**：只動了 `shared/contracts.ts` 與 `backend.ts` 兩個檔案

### 10.1 shared/contracts.ts 的改造

**Before（V1，TypeScript interface）**：

```ts
export interface MenuItem {
  id: number;
  name: string;
  price: number;
  category: string;
  description: string;
  image_url: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}
// ... 其他 interfaces
```

**After（V2，Zod schema + derived type）**：

```ts
import { z } from "zod";

export const menuItemSchema = z.object({
  id: z.number().int().min(1),
  name: z.string().min(1),
  price: z.number().min(0),
  category: z.string().min(1),
  description: z.string(),
  image_url: z.string().min(1),
});

export const sessionUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(3),
  name: z.string().min(1),
  // 注意：password 不在 API 業務層
});

// 型別自動推導，不需要手動維護兩份
export type MenuItem = z.infer<typeof menuItemSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
```

### 10.2 backend.ts 的改造

**Before（V1）**：`backend.ts` 本地定義 8 個業務 schema，完全重複 `contracts.ts`

```ts
// backend.ts 本地定義（重複）
const safeUserSchema = t.Object({
  // ← 重複 SessionUser
  id: t.String({ minLength: 1 }),
  email: t.String({ minLength: 3 }),
  name: t.String({ minLength: 1 }),
});

const menuItemSchema = t.Object({
  // ← 重複 MenuItem
  id: t.Number({ minimum: 1 }),
  name: t.String({ minLength: 1 }),
  price: t.Number({ minimum: 0 }),
  // ...
});
// 還有 orderItemSchema、orderResponseSchema ... 共 8 個
```

**After（V2）**：`backend.ts` 只定義 7 個 envelope 結構（包裝層），業務型別直接 import

```ts
import {
  menuItemSchema,
  sessionUserSchema,
  orderResponseSchema,
  apiErrorResponseSchema,
} from "./shared/contracts.ts"; // ← 從 single source import

// 只定義「包裝結構」，不定義業務型別
const loginResponseSchema = z.object({
  data: sessionUserSchema, // ← 直接用，不重複定義
});

const menuItemResponseSchema = z.object({
  data: menuItemSchema, // ← 直接用，不重複定義
});
```

---

## 11. V1 vs V2 深度比較

### 11.1 程式碼量（Schema 相關）

| 指標                              | V1（feat/v8-clean-drizzle-neon）       | V2（feat/v8-clean-drizzle-neon-v2）   | 差異               |
| --------------------------------- | -------------------------------------- | ------------------------------------- | ------------------ |
| `shared/contracts.ts` schema 行數 | ~45 行（純 interface）                 | ~60 行（Zod schemas + derived types） | +15 行             |
| `backend.ts` 業務 schema 行數     | ~58 行（8 個 t.Object 業務定義）       | **0 行**（全部 import）               | -58 行             |
| `backend.ts` envelope schema 行數 | ~28 行（7 個 t.Object envelope）       | ~28 行（7 個 z.object envelope）      | 相同               |
| **Schema 相關總行數**             | **~131 行**                            | **~88 行**                            | **-43 行（-33%）** |
| **重複定義的業務型別數**          | **8 個（contracts + backend 各一份）** | **0 個**                              | **-8 個**          |

> **結論**：V2 的 schema 相關程式碼減少約 1/3，且消除所有重複。

### 11.2 心智負擔（Mental Load）

這是更重要的差異。

**V1 的心智負擔**：

```
開發者看到 backend.ts 裡的 safeUserSchema：
  → 「這跟 contracts.ts 的 SessionUser 一樣嗎？」
  → 「如果我改了 contracts.ts，要記得更新 backend.ts 嗎？」
  → 「這兩份定義有沒有已經不同步了？」
```

三個問題，每次改動都要在腦子裡跑一遍。

**V2 的心智負擔**：

```
開發者看到 backend.ts 裡的 menuItemSchema：
  → 「這從 shared/contracts.ts import，就是 single source」
  → 改 contracts.ts 的 menuItemSchema，這裡自動更新
  → TypeScript 會告訴我哪裡壞掉了
```

零問題，TypeScript compiler 接管同步責任。

### 11.3 維護場景對比

**情境：MenuItem 新增 `available: boolean` 欄位**

| 步驟         | V1 需要做                                        | V2 需要做                           |
| ------------ | ------------------------------------------------ | ----------------------------------- |
| 1            | 改 `contracts.ts` interface                      | 改 `contracts.ts` Zod schema        |
| 2            | ⚠️ 手動改 `backend.ts` menuItemSchema            | ✅ 不需要（自動同步）               |
| 3            | 記住 frontend 也用同一份                         | 前端 `import { MenuItem }` 自動更新 |
| **出錯風險** | 忘記改 backend.ts → 型別不一致、OpenAPI 文件錯誤 | 無                                  |

**情境：發現 SessionUser 欄位有錯誤**

| 步驟 | V1 | V2 |
|------|----|----||
| 找問題 | 要看 contracts.ts 和 backend.ts 兩份定義，確認哪份才對 | 看 contracts.ts 一份就夠 |
| 修復 | 改兩個地方 | 改一個地方 |
| 驗證 | 要確保兩份同步 | TypeScript 自動驗證 |

### 11.4 技術可行性驗證

這次實作確認了以下技術事實（2026-04-26 驗證）：

| 驗證項目                        | 結果                                    |
| ------------------------------- | --------------------------------------- |
| Elysia 1.4.28 接受 Zod 4 schema | ✅ 支援（Standard Schema V1 介面）      |
| Zod 4 實作 `~standard` 介面     | ✅ 已確認                               |
| OpenAPI 文件仍然正確生成        | ✅ `/openapi` 端點正常                  |
| 運行時驗證（缺欄位回錯誤）      | ✅ 正確觸發 validation error            |
| `STORE_DRIVER=json` smoke test  | ✅ login、menu、validation error 全通過 |
| DB/Auth 層完全不動              | ✅ 零改動                               |

### 11.5 一句話結論

> **V1 的 contracts.ts 是「型別的聲明」，只有 TypeScript 讀它。**  
> **V2 的 contracts.ts 是「型別與規則的唯一真相」，TypeScript 和運行時都讀它。**
>
> 心智負擔的根源是「人腦需要記住多份定義之間的同步關係」。V2 把這個責任還給 compiler 和 runtime，不再靠人腦記憶。
