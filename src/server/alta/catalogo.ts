/**
 * Los topes de bases y de MB, y cómo se miden.
 *
 * Un solo texto para el alta, que se cierra con ellos, y para el aviso al operador, que avisa
 * antes de que se cierre: si cada uno midiera a su manera o leyera su tope aparte, el aviso
 * llegaría con el alta todavía abierta, o no llegaría. Las medidas son fragmentos de SQL sobre el
 * catálogo del clúster, no de una tabla de inquilino; quien los usa los pega en su propia sentencia.
 */

import { sql } from "drizzle-orm";

import { topeEntero } from "@/lib/topes";

/** Cuántas bases de cliente puede haber. 0 no pone tope. */
export function topeDeBases(): number {
  return topeEntero("ALTA_TOPE_BASES");
}

/** Cuántos MB puede pesar el proyecto entero. 0 no pone tope. */
export function topeDeMb(): number {
  return topeEntero("ALTA_TOPE_MB");
}

/** Cuántas bases de cliente hay. */
export const BASES_DE_CLIENTE = sql`(select count(*) from pg_database where datname ~ '^t_[0-9a-f]{32}$')`;

/**
 * Cuánto pesa el proyecto entero, en MB. Suma las bases a las que el rol puede conectarse (la de
 * control incluida), porque `pg_database_size` tira en las que no puede abrir.
 */
export const MB_DEL_PROYECTO = sql`(select sum(pg_database_size(oid)) from pg_database where not datistemplate and has_database_privilege(oid, 'CONNECT')) / 1048576`;
