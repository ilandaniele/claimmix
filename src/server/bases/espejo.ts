/**
 * El espejo de control en la base de un cliente.
 *
 * Con `BASE_POR_CLIENTE=1` la identidad vive en control (`neondb`) y cada base
 * `t_<hex>` guarda una copia de lo que sus joins de negocio necesitan: la fila del
 * inquilino, sus usuarios (`users` y el `"user"` de Better Auth) y su número de
 * WhatsApp. La copia sólo se escribe desde acá, con el rol dueño: el perfil
 * cliente le quita a `claimmix_app` la escritura en todo eso.
 *
 * Cada `espejar` hace una lectura a control y un lote a la base del cliente. El
 * lote es una transacción: o entra entero o no entra nada. No pisa
 * `COLUMNAS_DE_CONFIG` de `tenants` —esas se editan en la base del cliente— y
 * `token_cifrado` nunca sale de control: en la copia queda siempre NULL.
 *
 * `espejar` no traga ningún error: tira y decide quien lo llama (una escritura que
 * ya salió bien lo deja pendiente y sigue; el workflow que prepara la base
 * reintenta). `espejarTodas` es el barrido que levanta lo pendiente, y no tira.
 */

import "server-only";

import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { basePorCliente, nombreDeBase } from "@/data/bases";
import { db, dbDeBase } from "@/lib/db";
import { filasDe } from "@/lib/db/filas";
import { authUsers, users, whatsappNumeros } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";

import { COLUMNAS_DE_CONFIG } from "./plantilla.generated";

const HORA_MS = 60 * 60_000;

type Fila = Record<string, unknown>;

// `tenants` se nombra a mano: `pnpm arquitectura` no deja que una consulta pida todas sus columnas
// (la 0048 sumó una a mano). El test del espejo la compara con el esquema, así que no se queda atrás.
const COLUMNAS_TENANTS: readonly string[] = [
  "id",
  "name",
  "plan",
  "billing_status",
  "monthly_fee_usd",
  "included_claims",
  "overage_price_usd",
  "contact_email",
  "trial_ends_at",
  "activated_at",
  "specialist_alert_emails",
  "recordatorio_horas",
  "rangos_de_monto",
  "reglas_asignacion",
  "plazos",
  "plan_por_tipo",
  "pesos_puntaje",
  "autoalta",
  "created_at",
];

const columnasDe = (tabla: PgTable): string[] => Object.values(getTableColumns(tabla)).map((c) => c.name);

const TENANTS = sql.raw("public.tenants");
const USER = sql.raw('public."user"');
const USERS = sql.raw("public.users");
const NUMEROS = sql.raw("public.whatsapp_numeros");

const lista = (columnas: readonly string[]) => sql.join(columnas.map((c) => sql.identifier(c)), sql`, `);

const asignar = (columnas: readonly string[]) =>
  sql.join(
    columnas.map((c) => sql`${sql.identifier(c)} = excluded.${sql.identifier(c)}`),
    sql`, `,
  );

/**
 * Inserta las filas y, si ya están, las pone como en control. La fila llega entera
 * en un JSON y se vuelve registro con el tipo de la tabla de destino: ni el orden
 * de las columnas ni el tipo de cada valor se arman a mano. `noActualizar` son las
 * columnas que, si la fila ya existe, no se pisan.
 */
function subir(tabla: SQL, columnas: readonly string[], noActualizar: readonly string[], filas: Fila[]) {
  const actualizables = columnas.filter((c) => c !== "id" && !noActualizar.includes(c));
  return sql`
    insert into ${tabla} (${lista(columnas)})
    select ${lista(columnas)} from jsonb_populate_recordset(null::${tabla}, ${JSON.stringify(filas)}::jsonb)
    on conflict (id) do update set ${asignar(actualizables)}
  `;
}

/** Los ids que siguen en control, para borrar de la copia el resto. */
const idsDe = (filas: Fila[]) => JSON.stringify(filas.map((f) => f.id));

type DeControl = { tenant: Fila; users: Fila[]; auth: Fila[]; numeros: Fila[] };

/**
 * Todo lo que se espeja, en una sola lectura con el rol dueño. Los usuarios son los
 * del inquilino; el `"user"` es el de esos usuarios. Las filas de números salen sin
 * `token_cifrado`, y los dados de baja primero: si un número nuevo reemplaza a uno
 * de baja, la copia libera el lugar antes de ocuparlo (los índices únicos son
 * parciales sobre `estado <> 'baja'`).
 */
async function leerDeControl(tenantId: string): Promise<DeControl> {
  // sin-inquilino: control entero para el rol dueño; el id viene de quien espeja.
  const filas = filasDe<{ espejo?: unknown }>(
    await db.execute(sql`
      select jsonb_build_object(
        'tenant', (select to_jsonb(t) from public.tenants t where t.id = ${tenantId}::uuid),
        'users', coalesce((
          select jsonb_agg(to_jsonb(u) order by u.created_at, u.id)
          from public.users u where u.tenant_id = ${tenantId}::uuid
        ), '[]'::jsonb),
        'auth', coalesce((
          select jsonb_agg(to_jsonb(a) order by a.created_at, a.id)
          from public."user" a
          where a.id in (select m.id from public.users m where m.tenant_id = ${tenantId}::uuid)
        ), '[]'::jsonb),
        'numeros', coalesce((
          select jsonb_agg(to_jsonb(n) - 'token_cifrado' order by (n.estado <> 'baja'), n.creado_en, n.id)
          from public.whatsapp_numeros n where n.tenant_id = ${tenantId}::uuid
        ), '[]'::jsonb)
      ) as espejo
    `),
  );
  // El driver devuelve el JSON ya leído; si algún día llega como texto, también anda.
  const crudo = filas[0]?.espejo;
  const leido = (typeof crudo === "string" ? JSON.parse(crudo) : crudo) as Partial<DeControl> | null | undefined;
  if (!leido?.tenant) {
    throw new Error("[bases] el inquilino no está en control: no hay nada que espejar.");
  }
  return {
    tenant: leido.tenant,
    users: leido.users ?? [],
    auth: leido.auth ?? [],
    // Aunque la lectura ya lo saca, el token no viaja a la copia por ningún camino.
    numeros: (leido.numeros ?? []).map((n) =>
      Object.fromEntries(Object.entries(n).filter(([columna]) => columna !== "token_cifrado")),
    ),
  };
}

/**
 * Deja la base del cliente como control para ese inquilino. Con la bandera apagada
 * no hace nada. Si algo falla, tira.
 *
 * Primero se borra lo que ya no está en control, hijos antes que padres, y después
 * se sube lo que sí, padres antes que hijos. Así un correo o un número que control
 * reutiliza con otro id no choca contra la fila vieja de la copia. Nada de esto
 * toca `cases` ni el resto del negocio: las claves foráneas de los usuarios que se
 * van son `ON DELETE SET NULL`, igual que en control.
 */
export async function espejar(tenantId: string): Promise<void> {
  if (!basePorCliente()) return;
  const nombre = nombreDeBase(tenantId);
  const { tenant, users: usuarios, auth, numeros } = await leerDeControl(tenantId);

  const base = dbDeBase(nombre);
  await base.batch([
    base.execute(sql`
      with fuera as (
        delete from ${USERS}
        where tenant_id = ${tenantId}::uuid
          and id not in (select jsonb_array_elements_text(${idsDe(usuarios)}::jsonb)::uuid)
        returning id
      )
      delete from ${USER} where id in (select id from fuera)
    `),
    base.execute(sql`
      delete from ${NUMEROS}
      where tenant_id = ${tenantId}::uuid
        and id not in (select jsonb_array_elements_text(${idsDe(numeros)}::jsonb)::uuid)
    `),
    base.execute(subir(TENANTS, COLUMNAS_TENANTS, COLUMNAS_DE_CONFIG, [tenant])),
    base.execute(subir(USER, columnasDe(authUsers), [], auth)),
    base.execute(subir(USERS, columnasDe(users), [], usuarios)),
    base.execute(subir(NUMEROS, columnasDe(whatsappNumeros), [], numeros)),
  ]);
}

/**
 * Espeja las bases `lista` hasta `hasta` (epoch en ms). Nunca tira: cuenta las que
 * salieron bien y las que fallaron, y las que no alcanzó a recorrer quedan para la
 * próxima corrida. Empieza cada hora por otra base, para que la falta de tiempo no
 * deje siempre afuera a las mismas.
 */
export async function espejarTodas(hasta: number): Promise<{ ok: number; fallas: number }> {
  if (!basePorCliente()) return { ok: 0, fallas: 0 };

  let ids: string[];
  try {
    // sin-inquilino: tenant_bases es de control y sólo la lee el rol dueño.
    const filas = await db.execute(sql`
      select tenant_id from public.tenant_bases
      where estado = 'lista'
      order by hashtext(tenant_id::text), tenant_id
    `);
    ids = filasDe<{ tenant_id: string }>(filas).map((f) => f.tenant_id);
  } catch (e) {
    logger.warn({ detalle: codigoPg(e) }, "bases.espejo_sin_lista");
    return { ok: 0, fallas: 1 };
  }

  const desde = ids.length > 0 ? Math.floor(Date.now() / HORA_MS) % ids.length : 0;
  let ok = 0;
  let fallas = 0;
  for (const tenantId of [...ids.slice(desde), ...ids.slice(0, desde)]) {
    if (Date.now() >= hasta) break;
    try {
      await espejar(tenantId);
      ok++;
    } catch (e) {
      fallas++;
      // El mensaje del error lleva las filas (correos incluidos): sólo el código.
      logger.warn({ tenantId, detalle: codigoPg(e) }, "bases.espejo_barrido_fallo");
    }
  }
  return { ok, fallas };
}
