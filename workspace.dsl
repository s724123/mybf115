workspace "早餐店點餐系統" "Breakfast Shop Ordering System — V9 (Better Auth + Drizzle + Neon)" {

    !docs docs
    !adrs decisions

    model {

        # ══════════════════════════════════════════════
        # People
        # ══════════════════════════════════════════════

        customer = person "顧客" "透過網頁瀏覽菜單、加入購物車、以 Google 帳號登入、建立並送出訂單的一般使用者。"

        # ══════════════════════════════════════════════
        # External Systems
        # ══════════════════════════════════════════════

        googleOAuth = softwareSystem "Google Identity Platform" "提供 OAuth 2.0 / Google Sign-In 服務，由 Better Auth 呼叫完成社交登入流程。" {
            tags "External"
        }

        neonCloud = softwareSystem "Neon (PostgreSQL Cloud)" "Serverless PostgreSQL 雲端資料庫服務，儲存 Better Auth 身份資料（bf_v9.user/session/account）與業務資料（bf_v9.menu_items/orders/order_items）。" {
            tags "External" "Database"
        }

        # ══════════════════════════════════════════════
        # Software System
        # ══════════════════════════════════════════════

        breakfastSystem = softwareSystem "早餐店點餐系統" "前後端分離的早餐店點餐平台。V9 使用 Better Auth + Google OAuth 管理身份，Drizzle ORM + Neon PostgreSQL 作為正式資料庫，同時保留 JSON file store 作為開發/教學備用。" {

            # ──────────────────────────────────────────
            # Container 1: SPA 前端
            # ──────────────────────────────────────────

            spa = container "SPA 前端" "在瀏覽器中執行的 React 應用。V9 使用 GET /api/auth/get-session 恢復 session（cookie-based，不再用 localStorage）；所有 API 請求帶 credentials:include；支援 Google Sign-In 流程。" "React 19, TypeScript, Vite 5, TailwindCSS, DaisyUI" {
                tags "Browser"
            }

            # ──────────────────────────────────────────
            # Container 2: 後端 API 伺服器
            # ──────────────────────────────────────────

            apiServer = container "後端 API 伺服器" "Bun + Elysia V9 正式入口（backend.ts）。使用 Better Auth 管理 session 與 Google OAuth；@elysia/cors 取代手動 CORS；所有 schema 集中於 shared/route-schemas.ts。根據 STORE_DRIVER 環境變數選擇 PgStore 或 JsonFileStore。" "Bun runtime, Elysia framework, TypeScript, Better Auth" {

                routeLayer = component "路由層 (backend.ts)" "V9 正式入口。掛載 cors 外掛、openapi 外掛；透過 auth.handler 代理所有 /api/auth/* 請求至 Better Auth；以 requireUser() 保護 order 相關路由；schemas 全部 import 自 shared/route-schemas.ts。" "Elysia routes"

                betterAuthModule = component "Better Auth 模組 (auth/better-auth.ts)" "建立 Better Auth 實例：drizzleAdapter 連接 Neon PostgreSQL、僅啟用 Google OAuth（禁用 email/password）。啟動時驗證 BETTER_AUTH_SECRET 存在且非預設值。提供 getCurrentUser() helper 將 session 轉換成 SessionUser。" "better-auth, drizzle-adapter"

                userMapper = component "User Mapper (auth/user-mapper.ts)" "toSessionUser()：將 Better Auth DB user（含 emailVerified / image 等欄位）投影為 contracts.ts 定義的 SessionUser（id, email, name），不對外暴露敏感欄位。" "TypeScript"

                storeFactory = component "Store 工廠 (store/index.ts)" "工廠函式 createStore()。讀取 STORE_DRIVER 環境變數：'postgres' → PgStore（Neon）；其他 → JsonFileStore（data/store.json）。回傳型別固定為 Store 介面，路由層不感知具體實作。" "TypeScript factory function"

                storeInterface = component "Store 介面 (store/Store.ts)" "V9 精簡版資料存取契約：auth 相關方法已移除（由 Better Auth 負責），userId 全面改為 string（對應 Better Auth string ID）。保留 menu CRUD、order CRUD 與 submitOrder。" "TypeScript interface"

                pgStore = component "PgStore (store/pg/PgStore.ts)" "Store 介面的 PostgreSQL 實作，使用 Drizzle ORM + Neon serverless pool。init() 檢查 DB 連線、從 data/store.json 種入初始菜單（若 DB 為空）、從 DB 重新載入資料至記憶體快取。" "TypeScript class, Drizzle ORM"

                jsonFileStore = component "JsonFileStore (store/json/JsonFileStore.ts)" "Store 介面的 JSON 檔案備用實作。含 init()、normalizeMenuItem/normalizeUser/normalizeUserId 相容舊資料、tmp+rename 原子寫入、Promise chain persist queue。預設使用者：demo@example.com / amy@example.com（password: 1234）。" "TypeScript class, Bun file API"

                dbClient = component "DB Client (db/client.ts)" "以 @neondatabase/serverless Pool 建立 WebSocket 連線，透過 drizzle() 建立 ORM 實例，同時 spread business schema 與 auth schema。啟動時若無 DATABASE_URL 即拋錯。" "@neondatabase/serverless, drizzle-orm/neon-serverless"

                bizSchema = component "Business Schema (db/schema.ts)" "Drizzle 業務資料表定義，置於 PG_SCHEMA（預設 bf_v9）namespace：menu_items（自增 PK）、orders（userId 外鍵對應 Better Auth user.id）、order_items（反正規化，含 name/price/category/description/image_url）。" "Drizzle ORM, drizzle-orm/pg-core"

                authSchema = component "Auth Schema (db/auth-schema.ts)" "Better Auth 所需資料表：user / session / account / verification，由 betterAuth drizzleAdapter 自動維護，與業務 tables 同處 Neon PostgreSQL bf_v9 schema。" "better-auth, Drizzle ORM"

                routeSchemas = component "Route Schemas (shared/route-schemas.ts)" "Zod-based API 層 schema 集中定義：request body/params schema（createMenuItemBodySchema 等）、response envelope schema（menuListResponseSchema 等）、OrderResponse 型別與 toOrderResponse() 轉換函式。" "Zod, TypeScript"

                sharedContracts = component "共用型別契約 (shared/contracts.ts)" "V9 升級為 Zod schema 驅動：menuItemSchema、userSchema（id: string，對應 Better Auth）、sessionUserSchema（SessionUser = { id, email, name }）、orderSchema（userId: string）。TypeScript 型別全部由 z.infer<> 自動推導，消除手動維護兩份型別的問題。" "Zod, TypeScript"

                openApiPlugin = component "OpenAPI 外掛" "透過 @elysiajs/openapi 輸出 Swagger UI（GET /openapi）與 JSON spec（GET /openapi/json）。排除靜態資產路由與 openapi 本身路由。" "@elysiajs/openapi"

                utilModule = component "時區工具 (util.ts)" "toTaipeiDateTime()：使用 Intl.DateTimeFormat sv-SE / Asia/Taipei 將 UTC ISO string 轉換為台北時間字串（YYYY-MM-DD HH:MM:SS 格式），供 toOrderResponse() 使用。" "TypeScript, Intl.DateTimeFormat"
            }

            # ──────────────────────────────────────────
            # Container 3: JSON 檔案資料庫（開發/備用）
            # ──────────────────────────────────────────

            fileStore = container "JSON 檔案資料庫" "data/store.json。當 STORE_DRIVER != postgres 時由 JsonFileStore 使用。儲存 users（string ID 零填補，如 '0001'）、menu（12 項含圖片與描述）、orders（userId: string）、三個自增計數器。" "data/store.json, Bun file API (local filesystem)" {
                tags "Database"
            }
        }

        # ══════════════════════════════════════════════
        # Relationships — System Context level
        # ══════════════════════════════════════════════

        customer -> spa "瀏覽菜單、以 Google 帳號登入、建立並送出訂單" "HTTPS / Browser"
        spa -> apiServer "呼叫 REST API（含 credentials:include）" "HTTP/JSON"
        apiServer -> googleOAuth "OAuth 2.0 登入流程（authorize / callback）" "HTTPS, Better Auth"
        apiServer -> neonCloud "讀寫 Better Auth session 與業務資料" "TCP/WSS, Drizzle + @neondatabase/serverless"

        # ══════════════════════════════════════════════
        # Relationships — Component level
        # ══════════════════════════════════════════════

        # 路由層 → 各模組
        routeLayer -> betterAuthModule "auth.handler 代理 /api/auth/* 請求；requireUser() 取得 session"
        routeLayer -> storeFactory "createStore({ dataFilePath }) 取得 store 實例"
        routeLayer -> routeSchemas "import 所有 Zod request/response schemas 與 toOrderResponse()"
        routeLayer -> openApiPlugin "app.use(openapi(...)) 掛載外掛"
        routeLayer -> utilModule "import toTaipeiDateTime（舊 v7 路由仍直接使用）"

        # Better Auth 模組
        betterAuthModule -> dbClient "drizzleAdapter(db) 連接資料庫"
        betterAuthModule -> authSchema "讀寫 user/session/account/verification 資料表"
        betterAuthModule -> userMapper "toSessionUser() 轉換 DB user → SessionUser"
        betterAuthModule -> googleOAuth "OAuth 2.0 authorize & callback" "HTTPS"

        # Store 工廠 → 實作
        storeFactory -> pgStore "STORE_DRIVER=postgres 時建立 PgStore 實例"
        storeFactory -> jsonFileStore "其他情況建立 JsonFileStore 實例"
        pgStore -> storeInterface "implements Store 介面"
        jsonFileStore -> storeInterface "implements Store 介面"

        # PgStore → DB
        pgStore -> dbClient "透過 Drizzle ORM 執行 SQL"
        dbClient -> bizSchema "menu_items / orders / order_items 資料表操作"
        dbClient -> neonCloud "WebSocket 連線至 Neon serverless pool" "WSS"

        # JsonFileStore → 本地檔案
        jsonFileStore -> fileStore "讀寫 data/store.json（tmp+rename 原子寫入）" "Bun file API"

        # Route Schemas → Shared Contracts
        routeSchemas -> sharedContracts "import menuItemSchema, orderSchema（複用業務 schema）"
        routeSchemas -> utilModule "import toTaipeiDateTime 供 toOrderResponse() 使用"
        spa -> sharedContracts "import type MenuItem, Order, SessionUser（compile-time）" "TypeScript"

        # Schema 關聯
        bizSchema -> authSchema "ordersTable.userId → Better Auth user.id 外鍵"
    }

    # ══════════════════════════════════════════════
    # Views
    # ══════════════════════════════════════════════

    views {

        systemContext breakfastSystem "SystemContext" "早餐店點餐系統 — System Context（C4 Level 1）" {
            include *
            autoLayout tb
        }

        container breakfastSystem "ContainerView" "早餐店點餐系統 — Container View（C4 Level 2）" {
            include *
            autoLayout lr
        }

        component apiServer "BackendComponents" "後端 API 伺服器 — Component View（C4 Level 3）" {
            include *
            autoLayout lr
        }

        styles {
            element "Person" {
                shape Person
                background #08427B
                color #ffffff
            }
            element "Software System" {
                background #1168BD
                color #ffffff
            }
            element "External" {
                background #999999
                color #ffffff
            }
            element "Container" {
                background #438DD5
                color #ffffff
            }
            element "Component" {
                background #85BBF0
                color #000000
            }
            element "Database" {
                shape Cylinder
                background #438DD5
                color #ffffff
            }
            element "Browser" {
                shape WebBrowser
            }
        }
    }
}
