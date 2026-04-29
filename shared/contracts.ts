import { z } from "zod";

// ─── API Business Schemas（Single Source of Truth）──────────────────────────
// 這裡是前後端共用的業務型別定義。
// 型別（TypeScript type）由 Zod schema 自動推導，不需要手動維護兩份。

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
  // 注意：password 不在 API 業務層，只存在 DB 層（db/schema.ts）
});

export const orderItemSchema = z.object({
  item: menuItemSchema,
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

export const orderResponseSchema = orderSchema.extend({
  createdAtTaipei: z.string().min(1),
});

export const apiErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

// ─── Derived TypeScript Types（自動推導，永不過時）───────────────────────────
export type MenuItem = z.infer<typeof menuItemSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type User = SessionUser; // 與 SessionUser 相同（API 層不含 password）
export type OrderItem = z.infer<typeof orderItemSchema>;
export type Order = z.infer<typeof orderSchema>;
export type OrderResponse = z.infer<typeof orderResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export interface ApiDataResponse<T> {
  data: T;
}
