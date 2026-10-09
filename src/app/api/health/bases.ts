/**
 * ¿Las bases de los clientes están al día con el código?
 *
 * Ningún deploy migra nada: las bases `t_<hex>` se migran a mano, una por una. Entre
 * que sale el código nuevo y que alguien corre `migrar-bases.mjs` hay una ventana en
 * la que las columnas que el código espera no existen, y la falla es la de siempre:
 * una pantalla rota con el resto en verde. Esto la hace visible. Con `?deep=1` y
 * `BASE_POR_CLIENTE=1`, `/api/health` suma `bases` y el job de post-deploy de prd
 * falla si `desfase` es true.
 *
 * Una sola consulta del dueño a control: `tenant_bases` lleva la versión en que quedó
 * cada base, y `schema_migrations` la de control. Ni se conecta a cada base ni cambia
 * el chequeo de esquema de `route.ts`, que mira sólo control.
 *
 * Deja el HTTP en 200 (el 503 es sólo para `down`); lo que cambia es el estado, que
 * pasa a `degraded` con desfase o con una base que lleva demasiado en `creando`.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { filasDe } from "@/lib/db/filas";
import { errorCode } from "@/lib/observability/error-code";
import { MINUTOS_PARA_REINTENTAR } from "@/server/bases/espera";
import { VERSION_ESPERADA } from "@/server/bases/plantilla.generated";

import type { ChequeoDeTrabajo } from "./trabajo";

export interface InformeDeBases {
  /** Filas de `tenant_bases`, en cualquier estado. */
  total: number;
  lista: number;
  creando: number;
  fallida: number;
  borrada: number;
  /** `creando` que pasó el plazo del reintento: el flujo murió a mitad de camino. */
  creandoViejas: number;
  /** Mínima y máxima versión entre las bases `lista`; null si no hay ninguna. */
  versionMin: number | null;
  versionMax: number | null;
  versionEsperada: number;
  /** La última versión asentada en control; null si el registro está vacío. */
  versionControl: number | null;
  /** Inquilinos sin fila en `tenant_bases`: el alta cayó antes de registrar su base. */
  sinTerminar: number;
  /** Alguna base `lista`, o control, quedó atrás de lo que el código espera. */
  desfase: boolean;
}

const NOMBRE = "bases por cliente";

const chequeo = (status: ChequeoDeTrabajo["status"], detail: string): ChequeoDeTrabajo => ({
  name: NOMBRE,
  status,
  detail,
});

const numero = (valor: unknown): number | null => {
  if (valor === null || valor === undefined) return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
};

/**
 * Lo que dicen control y `tenant_bases`, y qué hacer con eso. Nunca tira: si no
 * pudo medir, el chequeo lo dice y `bases` queda en null (no se inventa un desfase).
 */
export async function medirBases(): Promise<{ bases: InformeDeBases | null; chequeo: ChequeoDeTrabajo }> {
  try {
    // sin-inquilino: tenant_bases, tenants y schema_migrations son de control y las lee el rol dueño; el informe mira a todos los inquilinos.
    const filas = await db.execute(sql`
      select
        count(*)::int as total,
        (count(*) filter (where b.estado = 'lista'))::int as lista,
        (count(*) filter (where b.estado = 'creando'))::int as creando,
        (count(*) filter (where b.estado = 'fallida'))::int as fallida,
        (count(*) filter (where b.estado = 'borrada'))::int as borrada,
        (count(*) filter (
          where b.estado = 'creando'
            and coalesce(b.tomada_at, b.creada_at) < now() - make_interval(mins => ${MINUTOS_PARA_REINTENTAR}::int)
        ))::int as creando_viejas,
        (min(b.version_migracion) filter (where b.estado = 'lista'))::int as version_min,
        (max(b.version_migracion) filter (where b.estado = 'lista'))::int as version_max,
        (select max(m.version::int) from public.schema_migrations m)::int as version_control,
        (select count(*) from public.tenants t
          where not exists (select 1 from public.tenant_bases x where x.tenant_id = t.id))::int as sin_terminar
      from public.tenant_bases b
    `);
    const f = filasDe<Record<string, unknown>>(filas)[0] ?? {};

    const versionMin = numero(f.version_min);
    const versionControl = numero(f.version_control);
    const bases: InformeDeBases = {
      total: numero(f.total) ?? 0,
      lista: numero(f.lista) ?? 0,
      creando: numero(f.creando) ?? 0,
      fallida: numero(f.fallida) ?? 0,
      borrada: numero(f.borrada) ?? 0,
      creandoViejas: numero(f.creando_viejas) ?? 0,
      versionMin,
      versionMax: numero(f.version_max),
      versionEsperada: VERSION_ESPERADA,
      versionControl,
      sinTerminar: numero(f.sin_terminar) ?? 0,
      // Un registro vacío en control no prueba que esté al día: cuenta como atrasado.
      desfase:
        (versionMin !== null && versionMin < VERSION_ESPERADA) ||
        versionControl === null ||
        versionControl < VERSION_ESPERADA,
    };

    const problemas: string[] = [];
    if (bases.desfase) {
      const atrasadas = [
        versionControl === null || versionControl < VERSION_ESPERADA
          ? `control en ${versionControl ?? "ninguna"}`
          : null,
        versionMin !== null && versionMin < VERSION_ESPERADA ? `bases desde la ${versionMin}` : null,
      ].filter(Boolean);
      problemas.push(`desfase de migraciones (el código espera la ${VERSION_ESPERADA}): ${atrasadas.join(", ")}`);
    }
    if (bases.creandoViejas > 0) {
      problemas.push(`${bases.creandoViejas} base(s) en «creando» hace más de ${MINUTOS_PARA_REINTENTAR} min`);
    }
    if (problemas.length > 0) return { bases, chequeo: chequeo("degraded", problemas.join("; ")) };

    return { bases, chequeo: chequeo("ok", `${bases.lista} lista(s), migraciones al día (${VERSION_ESPERADA})`) };
  } catch (err) {
    return { bases: null, chequeo: chequeo("degraded", `no se pudo medir (${errorCode(err)})`) };
  }
}
