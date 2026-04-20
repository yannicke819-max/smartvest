import { z } from 'zod';

export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export const Pagination = z.object({
  cursor: z.string().nullable(),
  limit: z.number().int().positive().max(200).default(50),
});
export type Pagination = z.infer<typeof Pagination>;
