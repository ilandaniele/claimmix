import "server-only";

import { and, eq } from "drizzle-orm";

import { slugValido } from "@/core/web/formulario";
import { db } from "@/lib/db";
import { formularioWeb, tenants } from "@/lib/db/schema";

/** De qué inquilino es el formulario que está encendido en este enlace (y cómo se llama), o null. */
export async function inquilinoDelFormulario(
  slug: string
): Promise<{ tenantId: string; nombre: string } | null> {
  if (!slugValido(slug)) return null;
  // sin-inquilino: es la consulta que AVERIGUA de qué inquilino es el enlace público; sin sesión no hay contexto que pasarle a la capa de datos.
  const [fila] = await db
    .select({ tenant_id: formularioWeb.tenant_id, nombre: tenants.name })
    .from(formularioWeb)
    .innerJoin(tenants, eq(tenants.id, formularioWeb.tenant_id))
    .where(and(eq(formularioWeb.slug, slug), eq(formularioWeb.activo, true)))
    .limit(1);
  return fila ? { tenantId: fila.tenant_id, nombre: fila.nombre } : null;
}
