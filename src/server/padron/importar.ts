/**
 * La importación del padrón (B16). Es la única entrada por lote: la ruta la usa
 * hoy y una API de corredores la usaría mañana sin tocar nada de esto.
 *
 * Lee lo que ya existe para los DNI y las pólizas del archivo, arma el plan
 * (`planearPadron`, puro) y, si se pidió aplicar y no hay un solo error, lo
 * escribe todo en UN lote: los clientes, las pólizas y la fila de auditoría. Un
 * lote de Neon es una transacción, así que o entra el archivo entero o no entra
 * nada. Con errores no se aplica ni una fila: una importación a medias es peor
 * que ninguna, porque nadie sabe qué falta.
 *
 * Lo que este archivo no puede evitar: entre la lectura y la escritura otra
 * importación puede haber dado de alta el mismo DNI. Ese caso hace fallar la
 * clave foránea de sus pólizas (o la clave única de las suyas) y el lote entero
 * se deshace; `procesarPadron` lo devuelve como un rechazo, no como una caída.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { normalizarDni, normalizarNumeroPoliza } from "@/core/matching/normalizar";
import { leerPadron, type ErrorDeArchivo, type ErrorDeFila } from "@/core/padron/filas";
import { planearPadron, type ClienteExistente, type Conteo, type PlanPadron, type PolizaExistente } from "@/core/padron/plan";
import { enTenantVarias, type ClienteDatos } from "@/data/scope";
import { AuditEvent, filaDeAuditoria } from "@/lib/audit/log";
import { digitsOnlyIn, policyNumberIn } from "@/lib/db/helpers";
import { auditLog, customers, policies } from "@/lib/db/schema";
import { codigoPg } from "@/server/core-sync/config";

/** Cuántos errores se devuelven: el total va aparte, para que el aviso no pese lo que el archivo. */
export const MAX_ERRORES_A_MOSTRAR = 50;

export interface ResultadoPadron {
  resumen: PlanPadron["resumen"];
  errores: ErrorDeFila[];
  erroresTotal: number;
  /** Columnas del encabezado que no se reconocieron. */
  ignoradas: string[];
  aplicado: boolean;
}

export type SalidaPadron = { ok: true; resultado: ResultadoPadron } | { ok: false; error: ErrorDeArchivo };

export interface QuienImporta {
  tenantId: string;
  userId: string;
  ip?: string | null;
  ua?: string | null;
}

type ClienteLeido = Omit<ClienteExistente, "dni"> & { dni: string | null };

/**
 * Lo que ya está: la consulta de clientes y la de pólizas, para un solo viaje.
 *
 * La búsqueda compara DNI y número normalizados, no el texto guardado: el índice
 * único es sobre el texto crudo, y un `30.123.456` o un `pol-8812-r` cargados a
 * mano seguirían siendo otro cliente u otra póliza para un `IN` exacto. Los
 * mapas salen con la clave normalizada; cada fila conserva su valor guardado
 * (`dni`, `policy_number`), que es el que el ON CONFLICT tiene que ver.
 */
async function cargarExistentes(tenantId: string, dnis: string[], numeros: string[]) {
  // El tipo va con nombre y no en línea: `check-architecture` no reconoce un genérico con paréntesis.
  const [clientes, polizas] = await enTenantVarias<[ClienteLeido[], PolizaExistente[]]>({ tenantId }, (db) => [
    db
      .select({
        id: customers.id,
        dni: customers.dni,
        full_name: customers.full_name,
        email: customers.email,
        phone: customers.phone,
        birth_date: customers.birth_date,
        address: customers.address,
      })
      .from(customers)
      .where(digitsOnlyIn(customers.dni, dnis)),
    db
      .select({
        id: policies.id,
        customer_id: policies.customer_id,
        policy_number: policies.policy_number,
        policy_type: policies.policy_type,
        status: policies.status,
        start_date: policies.start_date,
        end_date: policies.end_date,
        premium_amount: policies.premium_amount,
      })
      .from(policies)
      .where(policyNumberIn(policies.policy_number, numeros)),
  ]);
  return {
    clientes: new Map(clientes.flatMap((c) => (c.dni ? [[normalizarDni(c.dni), { ...c, dni: c.dni }] as const] : []))),
    polizas: new Map(polizas.map((p) => [normalizarNumeroPoliza(p.policy_number), p] as const)),
  };
}

/**
 * Del cliente que ya existe se manda sólo lo que el archivo le cambia: lo demás
 * va en null y el ON CONFLICT lo deja como esté en la base. Mandar el registro
 * entero pisaría con lo leído una edición a mano hecha entre la lectura y la
 * escritura. El nombre va siempre, porque no admite null.
 */
function soloLoQueCambia(c: ClienteExistente, e: ClienteExistente | undefined): ClienteExistente {
  if (!e) return c;
  const cambia = (k: "email" | "phone" | "birth_date" | "address") => (c[k] === e[k] ? null : c[k]);
  return {
    ...c,
    email: cambia("email"),
    phone: cambia("phone"),
    birth_date: cambia("birth_date"),
    address: cambia("address"),
  };
}

/**
 * Las escrituras del plan. Los clientes existentes entran con el `id` que ya
 * tienen y su nombre ya mezclado, así que el ON CONFLICT por (inquilino, DNI)
 * los actualiza sin cambiarles la identidad, y las pólizas apuntan a ese `id`
 * (o al nuevo) sin que ninguno salga del archivo. Una póliza que ya existe
 * con otro titular no se toca: el plan ya la rechazó y `setWhere` es el
 * cinturón por si dos importaciones se cruzan.
 *
 * Ese cinturón puede saltear pólizas, así que el conteo de pólizas de la
 * auditoría sale de lo que el upsert escribió de verdad (RETURNING dentro de la
 * misma sentencia) y no del plan. La sentencia de auditoría lo devuelve, y ese
 * es el conteo que ve quien importó.
 */
function escrituras(
  db: ClienteDatos,
  tenantId: string,
  plan: PlanPadron,
  existentes: Map<string, ClienteExistente>,
  auditoria: ReturnType<typeof filaDeAuditoria>
) {
  const consultas: unknown[] = [];
  if (plan.clientes.length) {
    consultas.push(
      db
        .insert(customers)
        .values(plan.clientes.map((c) => ({ ...soloLoQueCambia(c, existentes.get(normalizarDni(c.dni))), tenant_id: tenantId })))
        .onConflictDoUpdate({
          target: [customers.tenant_id, customers.dni],
          targetWhere: sql`dni is not null`,
          set: {
            full_name: sql`excluded.full_name`,
            email: sql`coalesce(excluded.email, ${customers.email})`,
            phone: sql`coalesce(excluded.phone, ${customers.phone})`,
            birth_date: sql`coalesce(excluded.birth_date, ${customers.birth_date})`,
            address: sql`coalesce(excluded.address, ${customers.address})`,
            updated_at: sql`now()`,
          },
        })
    );
  }

  const cuentaDeClientes = JSON.stringify(auditoria.payload);
  const conPolizas = (altas: SQL | number, cambios: SQL | number) =>
    sql`${cuentaDeClientes}::jsonb || jsonb_build_object('polizas', jsonb_build_object('altas', (${altas})::int, 'cambios', (${cambios})::int))`;
  const auditar = (payload: SQL) => ({ ...auditoria, payload });

  if (!plan.polizas.length) {
    consultas.push(db.insert(auditLog).values(auditar(conPolizas(0, 0))).returning({ payload: auditLog.payload }));
    return consultas;
  }
  const escritas = db.$with("escritas").as(
    db
      .insert(policies)
      .values(plan.polizas.map((p) => ({ ...p, tenant_id: tenantId })))
      .onConflictDoUpdate({
        target: [policies.tenant_id, policies.policy_number],
        set: {
          policy_type: sql`excluded.policy_type`,
          status: sql`excluded.status`,
          start_date: sql`excluded.start_date`,
          end_date: sql`excluded.end_date`,
          premium_amount: sql`excluded.premium_amount`,
          updated_at: sql`now()`,
        },
        setWhere: sql`${policies.customer_id} = excluded.customer_id`,
      })
      // xmax = 0: la fila se insertó; distinto de 0, el ON CONFLICT la actualizó.
      .returning({ alta: sql<boolean>`(xmax = 0)`.as("alta") })
  );
  const cuantas = (alta: boolean) =>
    sql`(select count(*) from ${escritas} where ${alta ? sql`${escritas.alta}` : sql`not ${escritas.alta}`})`;
  consultas.push(
    db
      .with(escritas)
      .insert(auditLog)
      .values(auditar(conPolizas(cuantas(true), cuantas(false))))
      .returning({ payload: auditLog.payload })
  );
  return consultas;
}

const cuenta = ({ altas, cambios }: Conteo) => ({ altas, cambios });

/** El conteo de pólizas que la base devolvió en la fila de auditoría. */
function polizasEscritas(auditoria: unknown, plan: PlanPadron): PlanPadron["resumen"]["polizas"] {
  const payload = (auditoria as { payload?: { polizas?: Conteo } }[] | undefined)?.[0]?.payload;
  return { ...plan.resumen.polizas, ...payload?.polizas };
}

/**
 * Vista previa (`aplicar` falso) o importación. La vista previa y la
 * importación corren el mismo plan sobre el mismo archivo: lo que se vio es lo
 * que se aplica, salvo que el padrón haya cambiado en el medio.
 */
export async function procesarPadron(quien: QuienImporta, texto: string, aplicar: boolean): Promise<SalidaPadron> {
  const lectura = leerPadron(texto);
  if (!lectura.ok) return lectura;

  const { tenantId } = quien;
  const existentes = await cargarExistentes(
    tenantId,
    [...new Set(lectura.filas.map((f) => f.dni))],
    [...new Set(lectura.filas.flatMap((f) => (f.poliza ? [f.poliza.numero] : [])))]
  );
  const plan = planearPadron(lectura.filas, existentes, randomUUID);

  const errores = [...lectura.errores, ...plan.errores].sort((a, b) => a.fila - b.fila);
  const hayQueEscribir = plan.clientes.length + plan.polizas.length > 0;
  const aplicado = aplicar && errores.length === 0 && hayQueEscribir;

  let polizas = plan.resumen.polizas;
  if (aplicado) {
    const auditoria = filaDeAuditoria({
      tenant_id: tenantId,
      actor_id: quien.userId,
      event_type: AuditEvent.PADRON_IMPORTADO,
      target_type: "padron",
      // Sólo cuántos: nunca DNI, nombres ni números de póliza. Las pólizas las cuenta la base al escribir.
      payload: { clientes: cuenta(plan.resumen.clientes) },
      ip: quien.ip,
      ua: quien.ua,
    });
    try {
      const salidas = await enTenantVarias<unknown[]>({ tenantId }, (db) =>
        escrituras(db, tenantId, plan, existentes.clientes, auditoria)
      );
      polizas = polizasEscritas(salidas.at(-1), plan);
    } catch (e) {
      // 23503 (un cliente de este archivo ya no es el de la base) o 23505 (la póliza ya la dio de alta otro): el lote se deshizo entero.
      const codigo = codigoPg(e);
      if (codigo === "23503" || codigo === "23505") return { ok: false, error: "cruce_de_importaciones" };
      throw e;
    }
  }

  return {
    ok: true,
    resultado: {
      resumen: { ...plan.resumen, polizas },
      errores: errores.slice(0, MAX_ERRORES_A_MOSTRAR),
      erroresTotal: errores.length,
      ignoradas: lectura.ignoradas,
      aplicado,
    },
  };
}
