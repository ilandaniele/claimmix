import { sql } from "drizzle-orm";

import type { ClienteDatos } from "@/data/scope";
import { coreSyncSettings } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";

// Sin WHERE tenant_id: la fila la elige RLS, y hay una sola por inquilino
// porque tenant_id es la clave primaria.

/** La fila que usa `getCoreSyncClient`. Suelta, para meterla en un lote. */
export function consultaDeLaConfig(db: ClienteDatos) {
  return db
    .select({
      enabled: coreSyncSettings.enabled,
      webhook_url: coreSyncSettings.webhook_url,
      signing_secret_enc: coreSyncSettings.signing_secret_enc,
    })
    .from(coreSyncSettings);
}

/** Lo que ve /configuracion: si hay secreto y clave, nunca cuáles son. */
export function vistaDeLaConfig(db: ClienteDatos) {
  return db
    .select({
      webhook_url: coreSyncSettings.webhook_url,
      enabled: coreSyncSettings.enabled,
      api_key_prefix: coreSyncSettings.api_key_prefix,
      updated_at: coreSyncSettings.updated_at,
      tiene_secreto: sql<boolean>`${coreSyncSettings.signing_secret_enc} is not null`,
      tiene_clave: sql<boolean>`${coreSyncSettings.api_key_hash} is not null`,
    })
    .from(coreSyncSettings);
}

export type VistaDeLaConfig = Awaited<ReturnType<typeof vistaDeLaConfig>>[number];

/** El código de Postgres de un error. Drizzle envuelve el del driver, así que puede venir en `cause`. */
export function codigoPg(e: unknown): string | undefined {
  const error = e as { code?: string; cause?: { code?: string } } | null;
  return error?.code ?? error?.cause?.code;
}

/** La 0036 se aplica a mano y el código puede llegar antes: falta la tabla (42P01) o una columna (42703). */
export function esFaltaDe0036(e: unknown): boolean {
  const codigo = codigoPg(e);
  return codigo === "42P01" || codigo === "42703";
}

/** La 0040 sólo agrega columnas: sin ella, una consulta que las toca da 42703. Va en el `.catch` de esa consulta. */
export function faltaLa0040(e: unknown): never {
  if (codigoPg(e) === "42703") throw new AppError("MIGRACION_PENDIENTE", "Falta aplicar la migración 0040.");
  throw e;
}
