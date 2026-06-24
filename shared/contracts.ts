import { z } from "zod";

// ─── API Business Schemas（Single Source of Truth）──────────────────────────
// 這裡是前後端共用的業務型別定義。
// 型別（TypeScript type）由 Zod schema 自動推導，不需要手動維護兩份。

// ─── Role schemas（第1事實：角色是使用者的客觀屬性）────────────────────────
// 角色定義反映早餐店的組織結構，屬於業務領域的客觀事實。
// 就像「菜單項目有價格」一樣，「使用者有角色」是不依賴技術實作的事實。
export const roleSchema = z.enum([
  "customer", // 顧客：查看菜單、下單、查看自己的訂單
  "staff", // 店員：協助顧客操作、查看所有訂單
  "chef", // 廚師：查看待處理訂單
  "owner", // 店長/老闆：管理菜單、查看所有訂單
  "admin", // 系統管理員：完整控制權
]);

export const menuItemSchema = z.object({
  id: z.number().int().min(1), // PK（每個版本獨立的 auto-increment ID）
  entityId: z.string().uuid(), // 內部穩定關聯用 UUID
  logicalId: z.number().int().min(1), // 跨版本穩定的邏輯 ID
  version: z.number().int().min(1),
  name: z.string().min(1),
  price: z.number().min(0),
  category: z.string().min(1),
  description: z.string(),
  image_url: z.string().min(1),
  isCurrentVersion: z.boolean(),
  changeReason: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
});

// ─── Menu Item Version History（菜單項目版本歷史）───────────────────────────
export const menuItemVersionHistorySchema = z.object({
  version: z.number().int().min(1),
  id: z.number().int().min(1), // 版本 PK
  name: z.string().min(1),
  price: z.number().min(0),
  category: z.string().min(1),
  description: z.string(),
  image_url: z.string().min(1),
  changeReason: z.string().optional(),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
});

// ─── User schemas（業務層）──────────────────────────────────────────────────
// userSchema：完整使用者資料（業務/資料層使用，不對外暴露）
// sessionUserSchema：API 回傳的最小安全投影（不含 password 等敏感欄位）
// 注意：V9 使用 Better Auth，userSchema 由 Better Auth DB 負責儲存。
//       sessionUserSchema 為 auth session 對外的唯一輸出格式。

export const userSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(3),
  name: z.string().min(1),
  password: z.string().min(1),
  // 預留個資欄位（V9+ 實作使用者 profile 時使用）
  birthday: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
});

export const sessionUserSchema = userSchema
  .pick({
    id: true,
    email: true,
    name: true,
  })
  .extend({
    // 角色屬於 sessionUserSchema 而非 userSchema：
    // 使用者「有角色」是業務事實，API contract 必須包含此資訊。
    roles: z.array(roleSchema).default([]),
  });

export const orderItemSchema = z.object({
  menuItemId: z.number().int().min(1), // FK 指向 menu_items.id（特定版本）
  logicalId: z.number().int().min(1), // 跨版本穩定 ID（前端 cart key 用）
  menuItemName: z.string(),
  menuItemPrice: z.number(),
  menuItemCategory: z.string(),
  menuItemDescription: z.string(),
  menuItemImageUrl: z.string(),
  menuItemVersion: z.number().int().min(1),
  qty: z.number().min(0),
});

export const orderSchema = z.object({
  id: z.number().int().min(1),
  userId: z.string().min(1),
  items: z.array(orderItemSchema),
  total: z.number().min(0),
  status: z.enum(["pending", "submitted"]),
  createdAt: z.string().min(1),
  submittedAt: z.string().min(1).optional(),
});

// ─── Derived TypeScript Types（自動推導，永不過時）───────────────────────────
export type MenuItem = z.infer<typeof menuItemSchema>;
export type MenuItemVersionHistory = z.infer<
  typeof menuItemVersionHistorySchema
>;
export type User = z.infer<typeof userSchema>;
export type Role = z.infer<typeof roleSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type OrderItem = z.infer<typeof orderItemSchema>;
export type Order = z.infer<typeof orderSchema>;

export interface ApiDataResponse<T> {
  data: T;
}
