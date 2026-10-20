/**
 * Crear el espacio de quien se dio de alta sola.
 *
 * Es la ÚNICA operación de cliente que crea algo fuera de un inquilino que ya
 * existe, y lo hace con una sola llamada a `claimmix_crear_inquilino` (0048): la
 * función revisa que el mail esté verificado, que no haya perfil, que los datos
 * valgan y que no se haya pasado el tope de 24 h, y escribe el inquilino, el
 * perfil de dueño, el número de WhatsApp y la auditoría en una transacción. El
 * rol de la app no puede insertar en `tenants` por su cuenta.
 *
 * El tope se cuenta en la base, sobre filas reales y con un candado, y no acá:
 * dos altas a la vez no se lo saltean y no hace falta un contador aparte.
 *
 * Con una base por cliente, antes de llamar a la función la misma sentencia mira
 * los topes del plan (cuántas bases, cuántos MB): pasados, el alta se cierra sin
 * crear nada.
 *
 * Nunca recibe el inquilino de un pedido: el id lo inventa esta función.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { enControl } from "@/data/scope";
import { diasDePrueba } from "@/lib/billing/plans";
import { filasDe } from "@/lib/db/filas";
import { topeEntero } from "@/lib/topes";
import { codigoPg } from "@/server/core-sync/config";

export type ResultadoDeAlta =
  | "ok"
  | "ok_numero_en_revision"
  | "no_verificado"
  | "ya_tiene_espacio"
  | "datos_invalidos"
  | "alta_cerrada";

export interface AltaCreada {
  resultado: ResultadoDeAlta;
  /** El espacio que se creó (o se intentó crear): de ahí sale la base que hay que preparar. */
  tenantId: string;
  /** Las altas automáticas de las últimas 24 h, contada ésta si salió bien. Null si la base no lo dijo. */
  creadas24h: number | null;
  tope: number | null;
}

/** Cuántos espacios por día. 0 cierra el alta; la base lo acota a 500. */
export function topeGlobalDelDia(): number {
  return topeEntero("ALTA_TOPE_GLOBAL_DIA");
}

/** Cuántas bases de cliente puede haber. 0 no pone tope. */
export function topeDeBases(): number {
  return topeEntero("ALTA_TOPE_BASES");
}

/** Cuántos MB puede pesar el proyecto entero. 0 no pone tope. */
export function topeDeMb(): number {
  return topeEntero("ALTA_TOPE_MB");
}

/**
 * 42883 y 42P01: la 0048 todavía no está aplicada (no hay función ni tabla), y
 * 42703 una columna que ella agrega. El alta queda cerrada hasta que se aplique.
 * 23505: dos altas pisándose en un índice único; el texto para la persona es el
 * mismo de «cerrada» y no cuenta nada de lo que hay en la base.
 */
const CODIGOS_DE_ALTA_CERRADA = new Set(["42883", "42P01", "42703", "23505"]);

const RESULTADOS = new Set<ResultadoDeAlta>([
  "ok",
  "ok_numero_en_revision",
  "no_verificado",
  "ya_tiene_espacio",
  "datos_invalidos",
  "alta_cerrada",
]);

function numeroOnull(valor: unknown): number | null {
  const n = Number(valor);
  return valor === null || valor === undefined || !Number.isFinite(n) ? null : n;
}

/** El jsonb que devuelve la función. Un resultado que no conocemos lanza: cerrar en silencio escondería un cambio de la función. */
function leerResultado(filas: unknown): Omit<AltaCreada, "tenantId"> {
  const crudo = filasDe<{ r?: unknown }>(filas)[0]?.r;
  const r = (typeof crudo === "string" ? JSON.parse(crudo) : crudo) as Record<string, unknown> | null | undefined;
  const resultado = r?.resultado;
  if (typeof resultado !== "string" || !RESULTADOS.has(resultado as ResultadoDeAlta)) {
    throw new Error("claimmix_crear_inquilino devolvió un resultado que no se reconoce");
  }
  return {
    resultado: resultado as ResultadoDeAlta,
    creadas24h: numeroOnull(r?.creadas_24h),
    tope: numeroOnull(r?.tope),
  };
}

export async function crearInquilino(datos: {
  userId: string;
  empresa: string;
  numero: string;
  /** Una IP válida o null: el tipo `inet` rechaza lo demás y no hay que dejar que eso tire el alta. */
  ip: string | null;
}): Promise<AltaCreada> {
  const nuevoId = randomUUID();
  try {
    // alta: el inquilino todavía no existe. El contexto es el id nuevo, y la función se niega a crear otro.
    // Los topes de bases y de MB van en la misma sentencia: con 0 no cuentan y el catálogo ni se mira.
    const topeBases = topeDeBases();
    const topeMb = topeDeMb();
    const filas = await enControl({ tenantId: nuevoId }, (db) =>
      db.execute(sql`
        select case
          when ${topeBases}::int > 0
            and (select count(*) from pg_database where datname ~ '^t_[0-9a-f]{32}$') >= ${topeBases}::int
            then jsonb_build_object('resultado', 'alta_cerrada')
          when ${topeMb}::int > 0
            and (select sum(pg_database_size(oid)) from pg_database
                 where not datistemplate and has_database_privilege(oid, 'CONNECT')) / 1048576 >= ${topeMb}::int
            then jsonb_build_object('resultado', 'alta_cerrada')
          else public.claimmix_crear_inquilino(
            ${nuevoId}::uuid, ${datos.userId}::uuid, ${datos.empresa}::text, ${datos.numero}::text,
            ${diasDePrueba()}::int, ${topeGlobalDelDia()}::int, ${datos.ip}::inet
          )
        end as r
      `)
    );
    return { ...leerResultado(filas), tenantId: nuevoId };
  } catch (e) {
    const codigo = codigoPg(e);
    if (codigo !== undefined && CODIGOS_DE_ALTA_CERRADA.has(codigo)) {
      return { resultado: "alta_cerrada", tenantId: nuevoId, creadas24h: null, tope: null };
    }
    throw e;
  }
}
