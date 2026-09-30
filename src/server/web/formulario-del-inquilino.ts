import "server-only";

import { sql } from "drizzle-orm";

import type { ClienteDatos } from "@/data/scope";
import { formularioWeb } from "@/lib/db/schema";

export interface FormularioDelInquilino {
  slug: string;
  activo: boolean;
}

/** El formulario del inquilino (a lo sumo una fila: la política de RLS acota). */
export function consultaFormularioWeb(db: ClienteDatos) {
  return db
    .select({ slug: formularioWeb.slug, activo: formularioWeb.activo })
    .from(formularioWeb)
    .limit(1);
}

/**
 * Crea el formulario o lo enciende y apaga. El enlace se fija al crearlo y no
 * se toca después: el `slug` no está en el `set`, así que un cambio de enlace
 * no existe y ningún otro inquilino puede tomar uno que ya circuló.
 */
export function consultaGuardarFormularioWeb(
  db: ClienteDatos,
  tenantId: string,
  datos: { slug: string; activo: boolean; userId: string }
) {
  return db
    .insert(formularioWeb)
    .values({ tenant_id: tenantId, slug: datos.slug, activo: datos.activo, updated_by: datos.userId })
    .onConflictDoUpdate({
      target: formularioWeb.tenant_id,
      set: {
        activo: sql`excluded.activo`,
        updated_at: sql`now()`,
        updated_by: sql`excluded.updated_by`,
      },
    })
    .returning({ slug: formularioWeb.slug, activo: formularioWeb.activo });
}
