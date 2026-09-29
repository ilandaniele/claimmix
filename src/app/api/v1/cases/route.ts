/**
 * GET /api/v1/cases — los casos reales del inquilino de la clave (B5).
 *
 * Filtros: `?status=` (uno de CaseStatusSchema) y `?updated_since=` (ISO con
 * zona). Orden: el último cambio, de más viejo a más nuevo, y el id.
 *
 * Pagina por cursor, no por número de página: con OFFSET, un caso que cambia o
 * sale del filtro entre dos pedidos corre las filas y otro queda salteado. El
 * cursor es la posición (último cambio, id) de la última fila entregada; lo
 * que cambie después queda adelante, nunca atrás.
 *
 * `updated_at` se calcula en JS antes de escribir, así que una escritura lenta
 * puede confirmarse con una hora anterior a la que el Core ya leyó. Por eso
 * sólo salen los casos cuyo último cambio tiene más de dos minutos: lo que
 * confirma dentro de ese margen todavía cae adelante del cursor.
 *
 * Auth: la clave de la aseguradora (ver `../_auth.ts`), no la sesión.
 */

import { and, asc, eq, gte, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { enTenant } from "@/data/scope";
import { err } from "@/lib/api/respond";
import { cases } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { CaseStatusSchema } from "@/lib/schemas/cases";
import { camposDePagina } from "@/lib/schemas/paginacion";
import { columnasDelCaso, esCasoReal } from "@/server/core-sync/lectura";
import { autenticarClave, SIN_CACHE } from "../_auth";

export const dynamic = "force-dynamic";

const CURSOR_INVALIDO = "Cursor inválido.";

// Opaco para el Core: base64url de «último cambio|id».
const Cursor = z
  .string()
  .max(200, CURSOR_INVALIDO)
  .transform((c) => Buffer.from(c, "base64url").toString("utf8").split("|"))
  .pipe(
    z.tuple([
      z.string().datetime({ offset: true, message: CURSOR_INVALIDO }),
      z.string().uuid(CURSOR_INVALIDO),
    ])
  );

const QuerySchema = z.object({
  status: CaseStatusSchema.optional(),
  updated_since: z.string().datetime({ offset: true }).optional(),
  cursor: Cursor.optional(),
  per_page: camposDePagina.per_page,
});

// Un caso recién creado todavía no tiene `updated_at`: su último cambio es la creación.
const ultimoCambio = sql`coalesce(${cases.updated_at}, ${cases.created_at})`;

function cursorDe(fila: { case_id: string; created_at: string; updated_at: string | null }): string {
  return Buffer.from(`${fila.updated_at ?? fila.created_at}|${fila.case_id}`).toString("base64url");
}

export async function GET(request: NextRequest): Promise<Response> {
  const ctx = await autenticarClave(request);
  if (ctx instanceof Response) return ctx;

  const p = request.nextUrl.searchParams;
  const query = QuerySchema.safeParse({
    status: p.get("status") ?? undefined,
    updated_since: p.get("updated_since") ?? undefined,
    cursor: p.get("cursor") ?? undefined,
    per_page: p.get("per_page") ?? undefined,
  });
  if (!query.success) {
    return err(new AppError("VALIDATION_FAILED", query.error.issues[0]?.message), undefined, SIN_CACHE);
  }
  const { status, updated_since, cursor, per_page } = query.data;

  const where = and(
    esCasoReal,
    sql`${ultimoCambio} <= now() - interval '2 minutes'`,
    status ? eq(cases.status, status) : undefined,
    updated_since ? gte(ultimoCambio, updated_since) : undefined,
    cursor ? sql`(${ultimoCambio}, ${cases.id}) > (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)` : undefined
  );
  // Una fila de más dice si hay otra página, sin contar.
  const filas = await enTenant(ctx, (db) =>
    db
      .select(columnasDelCaso)
      .from(cases)
      .where(where)
      .orderBy(asc(ultimoCambio), asc(cases.id))
      .limit(per_page + 1)
  );
  const data = filas.slice(0, per_page);
  const ultima = data.at(-1);

  return NextResponse.json(
    {
      data,
      meta: {
        per_page,
        has_more: filas.length > per_page,
        // Sin filas nuevas vuelve el mismo cursor: el Core lo guarda y sigue desde ahí.
        next_cursor: ultima ? cursorDe(ultima) : (p.get("cursor") ?? null),
      },
    },
    { headers: SIN_CACHE }
  );
}
