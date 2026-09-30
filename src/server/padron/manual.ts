/**
 * Las consultas del alta y la edición a mano de clientes y pólizas (B16).
 *
 * Sólo arman la consulta: la ruta las corre en `enTenant`, que acota todo al
 * inquilino de la sesión con RLS. Por eso ninguna filtra por `tenant_id`.
 *
 * Una póliza nueva no se inserta con `values`: las claves foráneas se validan
 * saltándose RLS, así que un `customer_id` de OTRO inquilino entraría sin
 * queja. Se inserta desde un SELECT sobre `customers`, que RLS sí acota; si el
 * cliente no es de este inquilino, el SELECT no trae nada y no se inserta nada.
 */

import "server-only";

import { eq, sql } from "drizzle-orm";
import type { z } from "zod";

import type { ClienteCambioSchema, ClienteNuevoSchema, PolizaCambioSchema, PolizaNuevaSchema } from "@/core/padron/manual";
import { soloLoPresente } from "@/core/padron/manual";
import type { ClienteDatos } from "@/data/scope";
import { digitsOnlyEquals, policyNumberEquals } from "@/lib/db/helpers";
import { customers, policies } from "@/lib/db/schema";

type ClienteNuevo = z.output<typeof ClienteNuevoSchema>;
type ClienteCambio = z.output<typeof ClienteCambioSchema>;
type PolizaNueva = z.output<typeof PolizaNuevaSchema>;
type PolizaCambio = z.output<typeof PolizaCambioSchema>;

/**
 * El índice único de DNI es sobre el texto crudo, así que un `30.123.456`
 * guardado a mano no chocaría con el `30123456` de esta alta. Si ya hay un
 * cliente con ese DNI (en cualquier forma de escribirlo), el alta se inserta con
 * el texto que esa fila guardó: el índice lo ve igual y dispara el 23505 que la
 * ruta contesta como `dni_existente`. Sin duplicado, es el DNI normalizado.
 */
const dniComoEstaGuardado = (dni: string) =>
  sql<string>`coalesce((select ${customers.dni} from ${customers} where ${digitsOnlyEquals(customers.dni, dni)} limit 1), ${dni})`;

/** Lo mismo para el número de póliza: la alta cae sobre la variante guardada y el 23505 salta. */
const numeroComoEstaGuardado = (numero: string) =>
  sql<string>`coalesce((select ${policies.policy_number} from ${policies} where ${policyNumberEquals(policies.policy_number, numero)} limit 1), ${numero})`;

export function consultaAltaCliente(db: ClienteDatos, tenantId: string, c: ClienteNuevo) {
  return db
    .insert(customers)
    .values({
      tenant_id: tenantId,
      full_name: c.nombre,
      dni: dniComoEstaGuardado(c.dni),
      email: c.email ?? null,
      phone: c.telefono ?? null,
      birth_date: c.nacimiento ?? null,
      address: c.direccion ?? null,
    })
    .returning({ id: customers.id });
}

/** Lo que cambia, con los nombres de columna; `null` si no vino nada que cambiar. */
export function cambiosDelCliente(c: ClienteCambio) {
  const set = soloLoPresente({
    full_name: c.nombre,
    email: c.email,
    phone: c.telefono,
    birth_date: c.nacimiento,
    address: c.direccion,
  });
  return Object.keys(set).length ? set : null;
}

export function consultaCambioCliente(
  db: ClienteDatos,
  id: string,
  set: NonNullable<ReturnType<typeof cambiosDelCliente>>
) {
  return db
    .update(customers)
    .set({ ...set, updated_at: sql`now()` })
    .where(eq(customers.id, id))
    .returning({ id: customers.id });
}

const nulo = <T>(tipo: string) => sql<T | null>`null::${sql.raw(tipo)}`;

/**
 * `insert … select` lleva TODAS las columnas de la tabla, en el orden de la
 * tabla: lo que la póliza no trae de esta pantalla (coberturas, condiciones)
 * va en nulo, como cuando se inserta con `values`.
 */
export function consultaAltaPoliza(db: ClienteDatos, p: PolizaNueva) {
  const c = customers;
  return db
    .insert(policies)
    .select(
      db
        .select({
          id: sql<string>`gen_random_uuid()`.as("id"),
          tenant_id: sql<string>`${c.tenant_id}`.as("tenant_id"),
          customer_id: sql<string>`${c.id}`.as("customer_id"),
          policy_number: numeroComoEstaGuardado(p.numero).as("policy_number"),
          policy_type: sql<string>`${p.ramo ?? "other"}`.as("policy_type"),
          status: sql<string>`${p.estado ?? "active"}`.as("status"),
          start_date: sql<string | null>`${p.desde ?? null}::date`.as("start_date"),
          end_date: sql<string | null>`${p.hasta ?? null}::date`.as("end_date"),
          premium_amount: sql<string | null>`${p.prima ?? null}::numeric(12,2)`.as("premium_amount"),
          created_at: sql<string>`now()`.as("created_at"),
          updated_at: nulo<string>("timestamptz").as("updated_at"),
          coberturas: nulo<never>("jsonb").as("coberturas"),
          ambito_territorial: nulo<never>("jsonb").as("ambito_territorial"),
          condiciones_path: nulo<string>("text").as("condiciones_path"),
          condiciones_leidas_en: nulo<string>("timestamptz").as("condiciones_leidas_en"),
        })
        .from(c)
        .where(eq(c.id, p.customer_id))
    )
    .returning({ id: policies.id });
}

export function cambiosDeLaPoliza(p: PolizaCambio) {
  const set = soloLoPresente({
    policy_type: p.ramo,
    status: p.estado,
    start_date: p.desde,
    end_date: p.hasta,
    premium_amount: p.prima,
  });
  return Object.keys(set).length ? set : null;
}

export function consultaCambioPoliza(
  db: ClienteDatos,
  id: string,
  set: NonNullable<ReturnType<typeof cambiosDeLaPoliza>>
) {
  return db
    .update(policies)
    .set({ ...set, updated_at: sql`now()` })
    .where(eq(policies.id, id))
    .returning({ id: policies.id });
}
