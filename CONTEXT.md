# 早餐店點餐系統

一家早餐店的線上點餐系統，提供菜單瀏覽、購物車、訂單送出、後台管理等功能。

## Language

**MenuItem Version**:
菜單項目的某一個特定版本。每次修改（名稱、價格、分類、描述、圖片）都會建立一個新版本，舊版本完整保留以供追溯。
_Avoid_: Menu item row, menu item record

**Logical ID**:
跨版本穩定的菜單項目標識符。前端點餐時用此 ID 指定品項，不隨版本變動。
_Avoid_: menu item id, item id

**Entity ID**:
UUID 格式的內部穩定標識符，用於資料庫關聯與 FK 參考，不對外暴露。
_Avoid_: item UUID

**Current Version**:
菜單項目當前的有效版本，標記為 `isCurrentVersion = true`。每次修改時，舊版本的 `isCurrentVersion` 設為 `false`，新版本設為 `true`。
_Avoid_: latest version, active version

**Change Reason**:
每次修改菜單項目時必須填寫的原因，例如「物料成本上漲」、「更新圖片」、「季節性調價」。
_Avoid_: 不用 record 這個詞

**Change Author**:
執行菜單修改的使用者，記錄在版本的 `createdBy` 欄位中。
_Avoid_: modifier, editor

**Submit Validation**:
訂單送出時驗證所有 order_item 參考的 menu item 是否仍為當前版本。若任一項目已更新，拒絕提交並提示哪些項目已變更，確保定價透明。
_Avoid_: auto-update, silent migration
