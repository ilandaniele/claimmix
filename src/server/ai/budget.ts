/**
 * AI budget guard — enforces monthly cost ceiling and daily per-user/tenant caps.
 *
 * LLM10: Monthly $200 project cap enforced in code. Blocks once exceeded;
 * fails open (does not block) if the usage counter itself can't be read.
 * Spec:
 *   - Per-user: 2M tokens/day (AI_USER_DAILY_TOKEN_CAP env)
 *   - Per-tenant: 5M tokens/day (AI_TENANT_DAILY_TOKEN_CAP env)
 *   - Sin usuario (mail, WhatsApp, formulario): 60 % del inquilino por omisión
 *     (AI_ANONIMO_DAILY_TOKEN_CAP env)
 *   - Monthly project cap: $200 (MONTHLY_BUDGET_USD env, default 200; 0 frena la IA de los
 *     clientes a propósito, la demo tiene su propio tope en DEMO_MONTHLY_BUDGET_USD)
 *   - Pruebas del alta automática: ver `checkBudget`. Un cupo diario de
 *     llamadas que se reserva antes de llamar, un techo mensual por prueba
 *     (AI_PRUEBA_MONTHLY_USD_POR_INQUILINO, 1) y un pozo compartido por todas
 *     (AI_PRUEBAS_MONTHLY_BUDGET_USD, 30).
 *
 * AC10 (budget guard): Returns { exceeded: true, reason } when any cap is hit.
 *
 * Queries ai_usage through enTenant/enTenantVarias (no service-role client).
 * Con BASE_POR_CLIENTE=1 cada gasto se anota además en control (`recordUsage`),
 * que es de donde sale el tope del proyecto; los topes por inquilino siguen
 * leyendo su propia base.
 *
 * Token cost model: Gemini/Vertex pricing (see MODEL_COSTS below). The
 * gpt-4o(-mini) entries are legacy — kept only to price ai_usage rows
 * written before the OpenAI-to-Gemini migration.
 */

import "server-only";
import { and, eq, gte, isNull, ne, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { after } from "next/server.js";
import { diaArgentino, medianocheHaceDias } from "@/core/fecha/dia-argentino";
import { inicioDelMes } from "@/core/fecha/inicio-del-mes";
import { resolveDefaultTenantId } from "@/lib/auth/provision";
import {
  enPrueba,
  llamadasDiariasDePrueba,
  pruebaVencida,
  topeDiarioDelPlan,
} from "@/lib/billing/plans";
import { db, tables } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import { liberarCupo, rateLimit, resolveProvider } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { topeAnonimo, topeDecimal, topeEntero, topeMensualDelProyecto } from "@/lib/topes";
import { inquilinoDeLaPlataforma } from "@/server/whatsapp/numeros";
import { CENTINELA, basePorCliente, esUuid } from "@/data/bases";
import {
  enControl,
  enTenant,
  enTenantVarias,
  type ClienteDatos,
  type TenantContext,
} from "@/data/scope";

const MODEL_COSTS: Record<string, { input: number; output: number; audio?: number }> = {
  "gpt-4o-mini": { input: 0.00000015, output: 0.00000060 },
  "gpt-4o":      { input: 0.0000025,  output: 0.00001 },
  // Gemini por Vertex, precio de lista por token. El tope mensual existía y no
  // servía para nada: la extracción registraba cost_usd = 0 con el comentario
  // "free tier", que fue cierto mientras corría por AI Studio. Al pasar a
  // Vertex postpago dejó de serlo, y nada avisó — un tope de USD contra una
  // suma que siempre da cero no salta nunca.
  //
  // Es una estimación, no la factura. Su trabajo es que el tope deje de ser
  // decorativo; para conciliar plata está la consola de Google.
  //
  // El audio de entrada se cobra más caro que el texto: una nota de voz
  // cobrada como texto dejaría el tope corto por un factor de tres. En
  // Gemini 3 cuesta lo mismo que el texto. Precios fuera de `global`.
  "gemini-3.5-flash":      { input: 0.00000165, output: 0.0000099 },
  "gemini-3.8-flash":      { input: 0.00000165, output: 0.00000825 },
  "gemini-2.5-flash":      { input: 0.0000003,  output: 0.0000025, audio: 0.000001 },
  "gemini-2.5-flash-lite": { input: 0.0000001,  output: 0.0000004, audio: 0.0000003 },
  "gemini-2.5-pro":        { input: 0.00000125, output: 0.00001 },
};

/**
 * Precio por token del modelo, tolerando los nombres que devuelve Vertex.
 *
 * Un modelo afinado llega como `projects/…/locations/…/models/1234567890` y no
 * va a coincidir con ninguna clave. Cobra como su modelo base, que es lo que
 * hace Google, así que la aproximación correcta es "flash" y no "gratis".
 */
function ratesFor(model?: string): { input: number; output: number; audio?: number } {
  const name = (model ?? "").toLowerCase();
  if (MODEL_COSTS[name]) return MODEL_COSTS[name]!;
  for (const [key, rates] of Object.entries(MODEL_COSTS)) {
    if (key.startsWith("gemini") && name.includes(key)) return rates;
  }
  if (name.includes("gemini") || name.startsWith("projects/")) {
    return MODEL_COSTS["gemini-3.8-flash"]!;
  }
  return MODEL_COSTS["gpt-4o-mini"]!;
}

/**
 * Compute estimated cost for a given token usage.
 * Pass model to get per-model pricing; unknown names fall back to a base rate
 * rather than to zero — see ratesFor.
 *
 * `audioTokens` are the part of `promptTokens` that Gemini reports with
 * modality AUDIO; they are priced at the audio rate instead of the text one.
 */
export function computeCostUsd(
  promptTokens: number,
  completionTokens: number,
  model?: string,
  audioTokens = 0
): number {
  const rates = ratesFor(model);
  const audio = Math.min(Math.max(0, audioTokens), promptTokens);
  return (
    (promptTokens - audio) * rates.input +
    audio * (rates.audio ?? rates.input) +
    completionTokens * rates.output
  );
}

/*
 * Acá vivía `estimateVertexTuningCostUsd`. Se saca: cero llamadores, y adentro
 * fijaba a mano tres supuestos —1000 tokens por ejemplo, 3 epochs, USD 0,008
 * por cada mil tokens de entrenamiento— que nadie validó nunca contra la
 * factura de Vertex.
 *
 * Una función así no es neutra por no usarse: el día que alguien la encuentre
 * va a creer que esos números salieron de algún lado. Si hace falta estimar el
 * costo de un entrenamiento, que se escriba con precios medidos.
 */

/** Qué tope cortó. `reason` es el texto para una persona; esto, para decidir qué hacer. */
export type MotivoDelTope =
  | "mensual"
  | "inquilino"
  | "anonimo"
  | "persona"
  | "prueba_vencida"
  | "suspendido"
  | "prueba_diaria"
  | "prueba_mensual"
  | "pozo_de_pruebas"
  | "sin_dato";

/** Lo reservado del cupo diario de una prueba: `soltarReserva` lo devuelve si al final no se llama al modelo. */
export interface ReservaDePrueba {
  clave: string;
  ventanas: number[];
}

export interface BudgetCheckResult {
  /** True if any cap (monthly or daily) has been exceeded. */
  exceeded: boolean;
  reason?: string;
  motivo?: MotivoDelTope;
  /** Sólo una prueba que pasó: lo que quedó reservado de su cupo diario. */
  reserva?: ReservaDePrueba;
}

/**
 * El tenant de la demo pública, si está configurado.
 *
 * Deliberadamente sin fallback al tenant de producción. Que la demo se caiga
 * porque falta una variable es un problema de la demo; que la demo comparta
 * presupuesto con las denuncias reales es un problema del asegurado.
 */
export function getDemoTenantId(): string | null {
  return process.env.DEMO_TENANT_ID?.trim() || null;
}

/**
 * El techo de la demo pública, que es plata que se puede perder.
 *
 * Separado de checkBudget a propósito: acá el peor caso es que la demo deje de
 * andar hasta mañana, y eso es aceptable. Allá el peor caso es que un
 * asegurador se quede sin intake, y no lo es. Nadie autenticado pasa por acá.
 */
export async function checkDemoBudget(): Promise<BudgetCheckResult> {
  const demoTenantId = getDemoTenantId();
  if (!demoTenantId) {
    return { exceeded: true, reason: "La demo no tiene tenant propio configurado." };
  }
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: demoTenantId };

  const dailyTokenCap = topeDecimal("AI_DEMO_DAILY_TOKEN_CAP");
  const monthlyCapUsd = topeDecimal("DEMO_MONTHLY_BUDGET_USD");

  const ahora = new Date();
  const dayStart = new Date(medianocheHaceDias(1, ahora));
  const monthStart = inicioDelMes(ahora);

  try {
    const [day] = await enTenant(tenantCtx, (db) =>
      db
        .select({
          tokens: sql<number>`coalesce(sum(${tables.aiUsage.prompt_tokens} + ${tables.aiUsage.completion_tokens}), 0)::float8`,
        })
        .from(tables.aiUsage)
        .where(
          and(
            gte(tables.aiUsage.created_at, dayStart.toISOString())
          )
        )
    );

    if ((day?.tokens ?? 0) >= dailyTokenCap) {
      return { exceeded: true, reason: "La demo alcanzó su cupo diario." };
    }

    const [month] = await enTenant(tenantCtx, (db) =>
      db
        .select({ usd: sql<number>`coalesce(sum(${tables.aiUsage.cost_usd}), 0)::float8` })
        .from(tables.aiUsage)
        .where(
          and(
            gte(tables.aiUsage.created_at, monthStart.toISOString())
          )
        )
    );

    if ((month?.usd ?? 0) >= monthlyCapUsd) {
      return { exceeded: true, reason: "La demo alcanzó su cupo mensual." };
    }

    return { exceeded: false };
  } catch (e) {
    /*
     * Acá sí, cerrado.
     *
     * Es la única diferencia de criterio con checkBudget, y es a propósito: si
     * no se puede saber cuánto lleva gastado un endpoint anónimo, seguir
     * gastando es la decisión cara. La demo se apaga un rato; nadie que esté
     * denunciando un siniestro se entera.
     */
    logger.error({ detalle: (e as { code?: string })?.code }, "budget.demo_check_error");
    return { exceeded: true, reason: "No se pudo verificar el cupo de la demo." };
  }
}

/**
 * Check if AI budget is available for the current tenant.
 *
 * Checks:
 *   1. Monthly project-level cost cap ($200 by default), excluding the public
 *      demo — see the comment inside.
 *   2. Per-tenant daily token cap
 *   3. Daily token cap of the calls with no user (only when userId is absent)
 *   4. Per-user daily token cap (if userId provided)
 *
 *
 * Un espacio de alta automática (`autoalta`) en prueba tiene además, en este
 * orden: la prueba vencida o el espacio suspendido, el techo mensual de la
 * prueba, el pozo de todas las pruebas y, al final, la reserva del cupo diario
 * de llamadas. Los demás inquilinos no pasan por nada de eso.
 *
 * Un error del contador deja pasar a la plataforma —el inquilino por omisión y
 * la demo— y frena a cualquier otro inquilino con motivo `sin_dato`.
 *
 * @param tenantId - Tenant whose budget to check.
 * @param userId   - Optional user ID for per-user cap.
 * @param opciones - `llamadas`: cuántas llamadas al modelo va a hacer quien
 *                   pregunta. Sólo las pruebas las reservan. Con 0 no se
 *                   reserva nada: es para mirar el estado (un indicador) sin
 *                   gastar el cupo, y la prueba se frena por los demás topes.
 *                   Quien reserva y después no llama al modelo devuelve la
 *                   `reserva` con `soltarReserva`.
 */
export async function checkBudget(
  tenantId: string,
  userId?: string | null,
  opciones: { llamadas?: number } = {}
): Promise<BudgetCheckResult> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const llamadas = Math.max(0, Math.trunc(opciones.llamadas ?? 1));
  const monthlyCapUsd = topeMensualDelProyecto();
  const tenantDailyTokenCap = topeDecimal("AI_TENANT_DAILY_TOKEN_CAP");
  const userDailyTokenCap = topeDecimal("AI_USER_DAILY_TOKEN_CAP");
  /*
   * Lo que gastan los canales sin persona —mail, WhatsApp, formulario— no puede
   * quedarse con todo el cupo del inquilino.
   *
   * Entran sin autenticar: quien rota remitentes o direcciones gasta modelo sin
   * pasar por el cupo de ninguna persona, y con sólo el del inquilino agotaba el
   * día entero para el equipo que sí trabaja logueado (re-análisis, asistente).
   *
   * Sin variable, el 60 % del tope del inquilino: en producción, 12 M de los
   * 20 M. Derivado y no fijo a propósito, así producción no se frena por una
   * variable que falta.
   */
  const anonimoDailyTokenCap = topeAnonimo();

  // ── Los cupos: mensual del proyecto, diario del inquilino, diario sin persona y diario de la persona ──
  // Un solo `ahora` para el día, el mes y el mes del acumulador: a las 00:00 del primero, dos relojes
  // podían caer en meses distintos.
  const ahora = new Date();
  const monthStart = inicioDelMes(ahora);

  /*
   * El tope mensual es del proyecto entero, y eso es lo que se quiere: protege
   * la tarjeta. Lo que no puede hacer es contar lo que gasta la demo pública.
   *
   * Ese endpoint corre sin autenticación, y hasta ahora su gasto sumaba acá.
   * Un anónimo con IPs rotativas llegaba al tope y a partir de ahí ninguna
   * denuncia real se extraía — sin que fallara nada en voz alta: el worker
   * anota un warn y el caso se queda esperando. La demo tiene su propio tope,
   * en checkDemoBudget.
   */
  const demoTenantId = getDemoTenantId();

  const dayStart = new Date(medianocheHaceDias(1, ahora));

  /*
   * Los tres cupos se preguntan a la vez.
   *
   * Eran tres `await` en fila, cada uno esperando al anterior sin necesitarlo:
   * ninguna de las tres sumas usa el resultado de otra. Y esto corre ANTES de
   * cada llamada al modelo, o sea en el camino donde el presupuesto de la
   * corrida ya está contado.
   *
   * La primera va por fuera de `enTenant` a propósito —el tope mensual es del
   * proyecto, no de cada aseguradora— así que no puede entrar al mismo lote;
   * las otras dos sí, y son un `batch()`. Dos viajes en paralelo en lugar de
   * tres en fila.
   *
   * El ORDEN en que se evalúan no cambia: mensual, después inquilino, después
   * sin persona, después persona. Quien se pase de dos cupos a la vez recibe el
   * mismo motivo que recibía antes. Lo único que se paga de más es cuando el
   * mensual ya está agotado: ahí las dos sumas del día se piden igual y no se
   * miran. Es el caso terminal, y a cambio el camino normal —el de siempre—
   * pasa de tres latencias a una.
   */
  const mesDeIa = `${diaArgentino(ahora).slice(0, 7)}-01`;
  const [mensual, delDia] = await Promise.all([
    sumaMensualDelProyecto(monthStart, demoTenantId),
    sumasDelDia(tenantCtx, dayStart, userId, mesDeIa),
  ]);

  if (!mensual.ok || !delDia.ok) {
    // Falla abierta sólo para la plataforma: un error del contador no puede
    // frenar su intake. Un inquilino cualquiera puede ser una prueba, y de eso
    // no hay forma de enterarse si el contador no contesta.
    if (esDeLaPlataforma(tenantId)) return { exceeded: false };
    return {
      exceeded: true,
      motivo: "sin_dato",
      reason: "No se pudo verificar el presupuesto de IA.",
    };
  }

  // Sólo un espacio de alta automática tiene reglas de prueba.
  const prueba = delDia.filaDelInquilino?.autoalta === true ? delDia.filaDelInquilino : null;

  if (prueba && (prueba.billing_status === "suspended" || prueba.billing_status === "churned")) {
    return { exceeded: true, motivo: "suspendido", reason: "El espacio está suspendido." };
  }
  if (prueba && pruebaVencida(prueba, ahora)) {
    return { exceeded: true, motivo: "prueba_vencida", reason: "La prueba del espacio terminó." };
  }

  const monthlyCostUsd = mensual.total;
  if (monthlyCostUsd >= monthlyCapUsd) {
    return {
      exceeded: true,
      motivo: "mensual",
      reason: `Presupuesto mensual de IA agotado ($${monthlyCostUsd.toFixed(2)} / $${monthlyCapUsd}).`,
    };
  }

  if (delDia.inquilino >= tenantDailyTokenCap) {
    return {
      exceeded: true,
      motivo: "inquilino",
      reason: `Presupuesto diario de tokens agotado para el tenant (${delDia.inquilino.toLocaleString()} / ${tenantDailyTokenCap.toLocaleString()}).`,
    };
  }

  if (!userId && delDia.anonimo >= anonimoDailyTokenCap) {
    return {
      exceeded: true,
      motivo: "anonimo",
      reason: `Presupuesto diario de tokens agotado para los canales sin usuario (${delDia.anonimo.toLocaleString()} / ${anonimoDailyTokenCap.toLocaleString()}).`,
    };
  }

  if (userId && delDia.persona >= userDailyTokenCap) {
    return {
      exceeded: true,
      motivo: "persona",
      reason: `Presupuesto diario de tokens agotado para el usuario (${delDia.persona.toLocaleString()} / ${userDailyTokenCap.toLocaleString()}).`,
    };
  }

  if (prueba && enPrueba(prueba)) return topesDeLaPrueba(tenantId, prueba, delDia, mensual, llamadas);

  return { exceeded: false };
}

/**
 * Lo que sólo mira una prueba, con las cuentas del día y del mes ya leídas.
 *
 * La reserva va última a propósito: reservar es gastar cupo, y si otro tope iba
 * a frenar la llamada igual, el cupo del día se quemaría sin haber llamado a
 * nada. Cada motivo es un tope distinto, así que el aviso al equipo dice cuál.
 */
async function topesDeLaPrueba(
  tenantId: string,
  prueba: FilaDelInquilino,
  delDia: { pruebaUsd: number },
  mensual: { pruebas: number },
  llamadas: number
): Promise<BudgetCheckResult> {
  const techoUsd = topeEntero("AI_PRUEBA_MONTHLY_USD_POR_INQUILINO");
  if (delDia.pruebaUsd >= techoUsd) {
    return {
      exceeded: true,
      motivo: "prueba_mensual",
      reason: `Presupuesto mensual de IA de la prueba agotado ($${delDia.pruebaUsd.toFixed(2)} / $${techoUsd}).`,
    };
  }

  // Sin cifras: el pozo es la suma de todas las pruebas y `reason` llega a quien preguntó.
  if (mensual.pruebas >= topeEntero("AI_PRUEBAS_MONTHLY_BUDGET_USD")) {
    return {
      exceeded: true,
      motivo: "pozo_de_pruebas",
      reason: "Presupuesto mensual compartido de las pruebas agotado.",
    };
  }

  // Mirar no es llamar: sin llamadas a hacer no hay nada que reservar.
  if (llamadas === 0) return { exceeded: false };
  return reservarParaLaPrueba(tenantId, prueba.plan, llamadas);
}

/** La reserva del cupo diario de una prueba, con el resultado que `checkBudget` devuelve. */
async function reservarParaLaPrueba(
  tenantId: string,
  plan: string,
  llamadas: number
): Promise<BudgetCheckResult> {
  const limite = llamadasDiariasDePrueba(topeDiarioDelPlan(plan));
  const reserva = await reservarLlamadas(tenantId, limite, llamadas);
  if (reserva === "sin_dato") {
    return {
      exceeded: true,
      motivo: "sin_dato",
      reason: "No se pudo verificar el presupuesto de IA.",
    };
  }
  if (reserva === "agotado") {
    return {
      exceeded: true,
      motivo: "prueba_diaria",
      reason: `Cupo diario de llamadas de la prueba agotado (${limite}).`,
    };
  }
  return { exceeded: false, reserva };
}

/**
 * Reserva las llamadas de una prueba sin releer los topes: sólo si el inquilino
 * es una prueba, y con una única lectura, la de su fila. El worker ya leyó el
 * presupuesto con `checkBudget` antes de extraer; volver a leerlo acá sumaría
 * las consultas del día a cada mensaje de todos los inquilinos, y haría que un
 * error del contador cortara a quienes no tienen cupo que reservar.
 *
 * Si la fila no se puede leer deja pasar: sin ella no se sabe si es una prueba,
 * y la llamada al modelo depende de la misma base.
 */
export async function reservarSiEsPrueba(tenantId: string, llamadas: number): Promise<BudgetCheckResult> {
  let fila: FilaDelInquilino | undefined;
  try {
    [fila] = await enTenant({ tenantId }, (db) => consultaDelInquilino(db, tenantId));
  } catch (e) {
    logger.error({ detalle: (e as { code?: string })?.code }, "budget.fila_del_inquilino_error");
    return { exceeded: false };
  }
  if (!fila || !enPrueba(fila)) return { exceeded: false };
  return reservarParaLaPrueba(tenantId, fila.plan, llamadas);
}

const DIA_MS = 24 * 60 * 60_000;

/**
 * Reserva `llamadas` del cupo diario de la prueba, todas o ninguna.
 *
 * Cada llamada es un intento del limitador, y el limitador cuenta de forma
 * atómica: 50 mensajes a la vez no reservan más que `limite`. Si no alcanza el
 * cupo para todas, se devuelve lo contado —también el intento que Postgres
 * contó y rechazó—, para que una reserva de cuatro que no entró no deje
 * agotado un cupo del que se gastó menos.
 *
 * `fallaCerrada`: si el contador no contesta, el limitador responde "no" con
 * `ventana` 0. Sólo Postgres puede fallar, y a un rechazo suyo de verdad le
 * pone la ventana del día; en memoria el rechazo también trae 0, pero ahí no
 * hay error posible.
 */
async function reservarLlamadas(
  tenantId: string,
  limite: number,
  llamadas: number
): Promise<ReservaDePrueba | "agotado" | "sin_dato"> {
  const clave = claveDeCupo("ia:prueba", tenantId);
  const cupo = { limit: limite, windowMs: DIA_MS, fallaCerrada: true };

  const intentos = await Promise.all(Array.from({ length: llamadas }, () => rateLimit(clave, cupo)));
  if (intentos.every((i) => i.allowed)) return { clave, ventanas: intentos.map((i) => i.ventana) };

  await Promise.all(intentos.map((i) => liberarCupo(clave, DIA_MS, i.ventana)));
  const fallo = resolveProvider() === "postgres" && intentos.some((i) => !i.allowed && i.ventana === 0);
  return fallo ? "sin_dato" : "agotado";
}

/**
 * Devuelve lo que `checkBudget` reservó cuando quien preguntó termina sin llamar
 * al modelo (otro tope local lo frenó antes). Sin reserva no hace nada, y nunca
 * lanza: se llama en caminos que ya están rechazando.
 */
export async function soltarReserva(reserva: ReservaDePrueba | undefined): Promise<void> {
  if (!reserva) return;
  try {
    await Promise.all(reserva.ventanas.map((v) => liberarCupo(reserva.clave, DIA_MS, v)));
  } catch (e) {
    logger.warn({ detalle: (e as { code?: string })?.code }, "budget.reserva_no_devuelta");
  }
}

/**
 * Los inquilinos cuyo intake no puede frenar un error del contador: el de la
 * plataforma (el del .env, que es el del ensayo y el del timbre) y el de la
 * demo, que tiene su propio tope en `checkDemoBudget`.
 */
function esDeLaPlataforma(tenantId: string): boolean {
  return [inquilinoDeLaPlataforma(), resolveDefaultTenantId(), getDemoTenantId()].includes(tenantId);
}

/**
 * Lo gastado en el mes por el PROYECTO entero, sin la demo, y la parte que puso
 * el alta automática (`pruebas`, para el pozo de las pruebas).
 *
 * Fuera de `enTenant` a propósito, y el `ne(tenant_id, demo)` lo delata:
 * descontar la demo sólo tiene sentido si la suma cruza inquilinos. Acotada por
 * RLS, esta consulta convertía el tope de US$200 en US$200 POR aseguradora —
 * con cuatro gastando 199 cada una, la tarjeta paga 796 y ninguna se pasa de su
 * propia cuenta.
 *
 * Qué inquilinos son de alta automática se resuelve en una subconsulta sobre
 * `tenants`, no fila por fila de `ai_usage`: `to_jsonb` corre una vez por
 * inquilino. Es `to_jsonb(tenants.*)` y no la columna porque antes de la 0048
 * `autoalta` no existe y nombrarla tira 42703. El `QueryBuilder` arma la
 * subconsulta sin pasar por `db`.
 *
 * `extras` son otras columnas escalares para la misma consulta (el aviso de topes mide el catálogo
 * de bases al lado del gasto, en un solo viaje); vuelven por nombre en `extras`. Si la consulta
 * falla queda registrada con `evento`: el guardia de IA y el aviso de topes no comparten el suyo, o
 * una falla del catálogo se leería como una del guardia.
 */
export async function sumaMensualDelProyecto(
  desde: Date,
  demoTenantId: string | null,
  extras: Record<string, SQL<number>> = {},
  evento = "budget.monthly_check_error"
): Promise<{ ok: boolean; total: number; pruebas: number; extras: Record<string, number> }> {
  try {
    const autoaltas = new QueryBuilder()
      .select({ id: tables.tenants.id })
      .from(tables.tenants)
      .where(sql`(to_jsonb(${tables.tenants}.*) ->> 'autoalta')::boolean`)
      .as("autoaltas");

    // sin-inquilino: el tope de gasto es del proyecto entero, así que la suma
    // tiene que cruzar inquilinos. Ver el bloque de arriba.
    const [fila] = await db
      .select({
        total: sql<number>`coalesce(sum(${tables.aiUsage.cost_usd}), 0)::float8`,
        pruebas: sql<number>`coalesce(sum(${tables.aiUsage.cost_usd}) filter (where ${autoaltas.id} is not null), 0)::float8`,
        ...extras,
      })
      .from(tables.aiUsage)
      .leftJoin(autoaltas, eq(autoaltas.id, tables.aiUsage.tenant_id))
      .where(
        demoTenantId
          ? and(
              gte(tables.aiUsage.created_at, desde.toISOString()),
              ne(tables.aiUsage.tenant_id, demoTenantId)
            )
          : gte(tables.aiUsage.created_at, desde.toISOString())
      );
    // El tipo de la fila no conoce las columnas de `extras`: se leen por nombre.
    const columnas: Record<string, unknown> = fila ?? {};
    return {
      ok: true,
      total: fila?.total ?? 0,
      pruebas: fila?.pruebas ?? 0,
      extras: Object.fromEntries(Object.keys(extras).map((k) => [k, Number(columnas[k] ?? 0)])),
    };
  } catch (e) {
    logger.error({ detalle: (e as { code?: string })?.code }, evento);
    return { ok: false, total: 0, pruebas: 0, extras: {} };
  }
}

/** Lo que el lote del día lee de la fila del inquilino. */
type FilaDelInquilino = {
  plan: string;
  billing_status: string;
  trial_ends_at: string | null;
  autoalta: boolean | null;
};

/**
 * Los tokens del día: los del inquilino y, en el mismo lote, los de la persona
 * o —sin `userId`— los de las llamadas sin usuario.
 *
 * Sólo se pide la segunda que se va a mirar: mandar una consulta cuyo
 * resultado no se usa es pagar por nada, y el camino sin persona lo usan los
 * crons, el worker y el webhook.
 *
 * Con ellas viajan la fila del inquilino y lo que gastó en el mes (`mes` es el
 * primer día en hora argentina): lo que decide si es una prueba y cuánto le
 * queda. Siguen siendo un solo viaje.
 */
async function sumasDelDia(
  ctx: TenantContext,
  desde: Date,
  userId: string | null | undefined,
  mes: string
): Promise<{
  ok: boolean;
  inquilino: number;
  anonimo: number;
  persona: number;
  filaDelInquilino: FilaDelInquilino | null;
  pruebaUsd: number;
}> {
  try {
    const [[inquilino], [otra], [fila], [delMes]] = await enTenantVarias<[
      Array<{ total: number }>,
      Array<{ total: number }>,
      FilaDelInquilino[],
      Array<{ usd: number }>,
    ]>(ctx, (db) => [
      consultaTokensDelDia(db, desde),
      consultaTokensDelDia(db, desde, userId || null),
      consultaDelInquilino(db, ctx.tenantId),
      consultaDelMesDeIa(db, mes),
    ]);

    const total = otra?.total ?? 0;
    return {
      ok: true,
      inquilino: inquilino?.total ?? 0,
      anonimo: userId ? 0 : total,
      persona: userId ? total : 0,
      filaDelInquilino: fila ?? null,
      pruebaUsd: delMes?.usd ?? 0,
    };
  } catch (e) {
    logger.error({ detalle: (e as { code?: string })?.code }, "budget.daily_check_error");
    return {
      ok: false,
      inquilino: 0,
      anonimo: 0,
      persona: 0,
      filaDelInquilino: null,
      pruebaUsd: 0,
    };
  }
}

/**
 * La fila del inquilino, con el `id` explícito: hasta la 0048 `tenants` no tiene
 * RLS y sin el `where` devolvería a todos. `autoalta` va por `to_jsonb`, como en
 * `sumaMensualDelProyecto`.
 */
function consultaDelInquilino(db: ClienteDatos, tenantId: string) {
  return db
    .select({
      plan: tables.tenants.plan,
      billing_status: tables.tenants.billing_status,
      trial_ends_at: tables.tenants.trial_ends_at,
      autoalta: sql<boolean | null>`(to_jsonb(${tables.tenants}.*) ->> 'autoalta')::boolean`,
    })
    .from(tables.tenants)
    .where(eq(tables.tenants.id, tenantId));
}

/** Lo gastado este mes por el inquilino, del acumulador mensual (la RLS lo acota). */
function consultaDelMesDeIa(db: ClienteDatos, mes: string) {
  return db
    .select({ usd: sql<number>`coalesce(sum(${tables.aiUsageMensual.cost_usd}), 0)::float8` })
    .from(tables.aiUsageMensual)
    .where(eq(tables.aiUsageMensual.mes, mes));
}

/**
 * La consulta sola, para poder mandarla en un lote. Ver `sumasDelDia`.
 *
 * `usuario`: sin pasar, todo el inquilino; `null`, sólo lo que no tiene usuario;
 * un id, sólo esa persona.
 */
function consultaTokensDelDia(db: ClienteDatos, desde: Date, usuario?: string | null) {
  return db
    .select({
      total: sql<number>`coalesce(sum(${tables.aiUsage.prompt_tokens} + ${tables.aiUsage.completion_tokens}), 0)::float8`,
    })
    .from(tables.aiUsage)
    .where(
      and(
        gte(tables.aiUsage.created_at, desde.toISOString()),
        usuario === undefined
          ? undefined
          : usuario === null
            ? isNull(tables.aiUsage.user_id)
            : eq(tables.aiUsage.user_id, usuario)
      )
    );
}

/**
 * Record AI usage after a successful extraction.
 * Does NOT throw — usage recording failure is non-fatal.
 *
 * @param tenantId         - Tenant ID.
 * @param userId           - User who triggered the extraction (nullable for system events).
 * @param model            - Model used (e.g. "gpt-4o-mini").
 * @param promptTokens     - Prompt token count.
 * @param completionTokens - Completion token count.
 * @param costUsd          - Computed cost in USD.
 * @param caseId           - Caso de la llamada, para el costo por caso. Null si no es de ninguno.
 */
export async function recordUsage(
  tenantId: string,
  userId: string | null,
  model: string,
  promptTokens: number,
  completionTokens: number,
  costUsd: number,
  caseId: string | null = null
): Promise<void> {
  const fila: FilaDeGasto = {
    tenant_id: tenantId,
    model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cost_usd: costUsd.toFixed(4),
    // La demo manda "demo": un no-uuid da 22P02 y el reintento sólo saca user_id, la fila se perdería.
    case_id: caseId && esUuid(caseId) ? caseId : null,
  };

  await anotarEnElInquilino(tenantId, userId, fila);
  // El centinela ya vive en control: copiarlo ahí sería anotarlo dos veces.
  if (basePorCliente() && tenantId !== CENTINELA) await copiarEnControl(tenantId, userId, fila);
}

type FilaDeGasto = {
  tenant_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: string;
  case_id: string | null;
};

/**
 * La copia del gasto en control, para el tope del proyecto.
 *
 * `sumaMensualDelProyecto` lee con el dueño, que sólo ve control: con una base
 * por inquilino, un gasto anotado únicamente en la del inquilino no entra en el
 * tope global. El trigger de la 0046 mantiene `ai_usage_mensual` en control.
 *
 * Va en `after()`, así que no suma latencia a la llamada. Fuera de un pedido —un
 * script, una prueba— `after()` tira, y ahí se espera como antes. No tira nunca:
 * si falla, el gasto sigue anotado en la base del inquilino y queda dicho.
 */
async function copiarEnControl(
  tenantId: string,
  userId: string | null,
  fila: FilaDeGasto
): Promise<void> {
  const escribir = (user_id: string | null) =>
    enControl({ tenantId }, (db) => db.insert(tables.aiUsage).values({ ...fila, user_id }));

  const copiar = async () => {
    try {
      try {
        await escribir(userId);
      } catch (e) {
        // Mismo caso que en la base del inquilino: un usuario que no sirve no
        // puede costar el gasto.
        const code = (e as { code?: string })?.code;
        if (!userId || (code !== "23503" && code !== "22P02")) throw e;
        await escribir(null);
      }
    } catch (e) {
      const name = e instanceof Error ? e.name : "UnknownError";
      logger.error({ error_name: name }, "ai.usage_control_error");
    }
  };

  try {
    after(copiar);
  } catch {
    await copiar();
  }
}

/** El gasto en la base del inquilino, de donde leen sus topes. No tira. */
async function anotarEnElInquilino(
  tenantId: string,
  userId: string | null,
  fila: FilaDeGasto
): Promise<void> {
  try {
    await enTenant({ tenantId }, (db) =>
      db.insert(tables.aiUsage).values({ ...fila, user_id: userId })
    );
    return;
  } catch (e) {
    const code = (e as { code?: string })?.code;

    /*
     * Un usuario que no está en `users` no puede costar el registro del gasto.
     *
     * `ai_usage.user_id` tiene clave foránea, y el `userId` que llega hasta acá
     * no siempre es una fila de `users`: el ensayo de conversaciones y las
     * simulaciones inventan uno. Con la clave foránea rota, el INSERT entero se
     * cae —23503— y se pierde el registro del gasto, que es lo único que hace
     * funcionar los TRES topes.
     *
     * Por eso el código original mandaba `null` siempre. Eso lo hacía no fallar
     * nunca, al precio de que el cupo por usuario no pudiera alcanzarse jamás:
     * arregló el síntoma tirando la función.
     *
     * Se reintenta sin usuario: se pierde la atribución de esa llamada, no el
     * gasto. Y queda dicho, porque un usuario que no existe es algo que alguien
     * debería mirar.
     */
    /*
     * 22P02 va con 23503: las dos son "el usuario que llego no sirve".
     *
     * 23503 es un uuid bien formado que no esta en `users`; 22P02 es algo que
     * ni siquiera es un uuid. En los dos casos lo que no puede pasar es que se
     * pierda el gasto, que es lo que alimenta los topes. Se reintenta sin
     * usuario: se pierde la atribucion de esa llamada, no el consumo.
     */
    if ((code === "23503" || code === "22P02") && userId) {
      logger.warn({
        detalle:
            "El usuario del gasto no existe en `users`. Se registra sin " +
            "atribuir, para no perder el consumo.",
      }, "budget.usuario_desconocido");
      try {
        await enTenant({ tenantId }, (db) =>
          db.insert(tables.aiUsage).values({ ...fila, user_id: null })
        );
        return;
      } catch (e2) {
        const n2 = e2 instanceof Error ? e2.name : "UnknownError";
        logger.error({ n2 }, "budget.exception_recording_ai_usage_sin_usuario");
        return;
      }
    }

    const name = e instanceof Error ? e.name : "UnknownError";
    logger.error({ error_name: name }, "budget.exception_recording_ai_usage");
  }
}

/**
 * El consumo de una llamada al modelo que no es la extracción.
 *
 * `recordUsage` existe desde el principio y la única que lo llamaba era la
 * extracción. Todo lo demás que habla con Gemini no dejaba rastro:
 * `deliberate` hace hasta tres llamadas por mensaje entrante, `composeReply`
 * hasta dos, y reconocer un adjunto una por archivo —ésa mandando la foto
 * entera adentro del prompt—. Contra una o dos de extracción, que eran las
 * únicas que se anotaban: `ai_usage` veía entre un cuarto y un tercio del
 * gasto.
 *
 * Los tres topes leen esa tabla, y `/api/admin/billing` calcula el costo de
 * IA y el MARGEN con ella. O sea que el techo no cortaba cuando tenía que
 * cortar, y el margen que muestra la pantalla es sistemáticamente alto.
 *
 * `null` es el default para las llamadas que dispara el webhook o el worker,
 * donde no hay ninguna persona sentada en la aplicación. El asistente (E11)
 * pasa quién preguntó, así que el cupo por usuario también lo cuenta a él.
 */
export async function registrarConsumoDelModelo(
  tenantId: string,
  model: string,
  usage: { promptTokens?: number; completionTokens?: number; audioTokens?: number } | undefined,
  userId: string | null = null,
  caseId: string | null = null
): Promise<void> {
  // `usage` puede venir incompleto —Gemini omite `usageMetadata` a veces, y
  // las pruebas que simulan el modelo devuelven `usage: {}`—. `undefined <= 0`
  // es false, así que sin normalizar acá entrarían tokens `undefined` al
  // INSERT.
  const prompt = Math.max(0, Math.trunc(usage?.promptTokens ?? 0));
  const completion = Math.max(0, Math.trunc(usage?.completionTokens ?? 0));
  if (prompt === 0 && completion === 0) return;

  await recordUsage(
    tenantId,
    userId,
    model,
    prompt,
    completion,
    computeCostUsd(prompt, completion, model, usage?.audioTokens ?? 0),
    caseId
  );
}
