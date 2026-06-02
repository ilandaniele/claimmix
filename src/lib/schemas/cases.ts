/**
 * Zod schemas for cases API routes.
 *
 * Validated at every API boundary — server-side only.
 */

import { z } from "zod";

/** Allowed claim types */
export const ClaimTypeSchema = z.enum([
  "choque",
  "robo",
  "granizo",
  "incendio",
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

/** Allowed case statuses */
export const CaseStatusSchema = z.enum([
  "procesando",
  "listo",
  "esperando",
  "escalado",
  "cerrado",
]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

/** Allowed sort columns — whitelist prevents SQL injection via sort param */
export const SortColumnSchema = z.enum(["created_at", "confidence_min", "status"]);
export type SortColumn = z.infer<typeof SortColumnSchema>;

/** GET /api/cases query parameters */
export const CaseQuerySchema = z.object({
  status: CaseStatusSchema.optional(),
  type: ClaimTypeSchema.optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  sort: SortColumnSchema.default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export type CaseQuery = z.infer<typeof CaseQuerySchema>;

/** PATCH /api/cases/:id request body */
export const CasePatchSchema = z
  .object({
    status: CaseStatusSchema.optional(),
    assigned_to: z.string().uuid("ID de analista inválido.").optional().nullable(),
    reason: z.string().max(500).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Se requiere al menos un campo para actualizar.",
  });

export type CasePatch = z.infer<typeof CasePatchSchema>;
