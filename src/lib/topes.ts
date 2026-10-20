/**
 * El registro único de los topes que se leen del entorno.
 *
 * Cada tope tiene acá su nombre, su valor por omisión y, si es entero, su
 * rango. El código que decide con un tope y `/api/health`, que muestra qué
 * tope rige en cada ambiente, leen de esta lista: el rango no se copia en dos
 * lugares.
 *
 * Todo se lee al llamar, nada al cargar el módulo, y sin base ni `server-only`:
 * lo importan los guardias, los lectores del tablero y los tests.
 *
 * Un entero que no es un entero escrito con dígitos, o cae fuera de [min, max],
 * toma la omisión: una variable vacía, mal escrita o con un cero de más nunca
 * vuelve "sin límite" un tope que cuesta plata.
 */

import { enteroDe } from "@/lib/entero";

export type EntornoDeTopes = Readonly<Record<string, string | undefined>>;

/**
 * En el orden de `/api/health`. La omisión de `AI_PILOTO_DAILY_TOKEN_CAP` es la
 * misma que `TOPE_DIARIO_TOKENS.piloto`: no se importa `plans.ts`, que importa
 * este archivo, y un test las ata.
 */
export const TOPES_ENTEROS = [
  { nombre: "ALTA_TOPE_GLOBAL_DIA", omision: 20, min: 0, max: 500 },
  { nombre: "ALTA_TOPE_BASES", omision: 0, min: 0, max: 500 },
  { nombre: "ALTA_TOPE_MB", omision: 0, min: 0, max: 500 },
  { nombre: "ALTA_TOPE_IP_DIA", omision: 3, min: 1, max: 100 },
  { nombre: "ALTA_PRUEBA_DIAS", omision: 30, min: 1, max: 90 },
  { nombre: "AI_PILOTO_DAILY_TOKEN_CAP", omision: 500_000, min: 1, max: Number.MAX_SAFE_INTEGER },
  { nombre: "AI_PRUEBA_MONTHLY_USD_POR_INQUILINO", omision: 1, min: 0, max: 100_000 },
  { nombre: "AI_PRUEBAS_MONTHLY_BUDGET_USD", omision: 30, min: 0, max: 1_000_000 },
  { nombre: "ALTA_NUMEROS_MAXIMOS_WABA", omision: 2, min: 1, max: 1000 },
  { nombre: "ALTA_TOPE_NUMEROS_DIA", omision: 2, min: 0, max: 50 },
  { nombre: "ALTA_TOPE_CODIGOS_INQUILINO_DIA", omision: 3, min: 0, max: 20 },
  { nombre: "ALTA_TOPE_CODIGOS_IP_DIA", omision: 5, min: 0, max: 50 },
  { nombre: "ALTA_TOPE_CODIGOS_DIA", omision: 10, min: 0, max: 500 },
  { nombre: "ALTA_TOPE_VERIFICACIONES_HORA", omision: 5, min: 0, max: 20 },
  { nombre: "ALTA_TOPE_CORREOS_DIA", omision: 50, min: 1, max: 10_000 },
  { nombre: "ALTA_TOPE_POR_DESTINATARIO_DIA", omision: 3, min: 1, max: 100 },
  { nombre: "ALTA_TOPE_CORREO_POR_IP_DIA", omision: 10, min: 1, max: 1000 },
  { nombre: "ALTA_TOPE_INVITACIONES_DIA", omision: 20, min: 1, max: 1000 },
  { nombre: "ALTA_TOPE_WABAS_SEMANA", omision: 10, min: 0, max: 1000 },
  { nombre: "ALTA_TOPE_PLANTILLAS_PRUEBA_DIA", omision: 3, min: 0, max: 1000 },
] as const;

export type TopeEntero = (typeof TOPES_ENTEROS)[number]["nombre"];

/** El entero escrito, o null si no es un entero con dígitos dentro del rango y rige la omisión. */
export function topeEnteroEscrito(nombre: TopeEntero, env: EntornoDeTopes = process.env): number | null {
  const { min, max } = TOPES_ENTEROS.find((t) => t.nombre === nombre)!;
  return enteroDe(env[nombre], min, max);
}

export function topeEntero(nombre: TopeEntero, env: EntornoDeTopes = process.env): number {
  const { omision } = TOPES_ENTEROS.find((t) => t.nombre === nombre)!;
  return topeEnteroEscrito(nombre, env) ?? omision;
}

/** Los topes decimales: dólares y tokens. Un cero se respeta, y apaga el gasto a propósito. */
export const TOPES_DECIMALES = [
  { nombre: "MONTHLY_BUDGET_USD", omision: 200 },
  { nombre: "AI_TENANT_DAILY_TOKEN_CAP", omision: 5_000_000 },
  /*
   * Dos millones, y el número está medido, no elegido. Era 100.000, y ese valor
   * nunca se ejerció: el extractor grababa `user_id: null`, así que el cupo
   * sumaba sobre un conjunto vacío y no cortaba nunca. Al arreglarlo el tope se
   * prende, y prenderlo en un número que nadie validó contra el uso real es la
   * forma cara de arreglarlo.
   *
   * Medido sobre 7.554 llamadas: promedio 11.771 tokens, p95 12.730, máximo
   * 34.798. Con 100.000 eran ocho extracciones por persona por día, y una tanda
   * de los 108 escenarios de `/api/admin/batch-simulate` (~1,27 millones) lo
   * reventaba de entrada. Dos millones son ~170 extracciones: por encima de
   * cualquier día de trabajo de una persona y de una tanda entera, y por debajo
   * del tope del inquilino. Sigue frenando un bucle, que es para lo que existe.
   */
  { nombre: "AI_USER_DAILY_TOKEN_CAP", omision: 2_000_000 },
  { nombre: "AI_DEMO_DAILY_TOKEN_CAP", omision: 300_000 },
  { nombre: "DEMO_MONTHLY_BUDGET_USD", omision: 10 },
] as const;

export type TopeDecimal = (typeof TOPES_DECIMALES)[number]["nombre"];

/**
 * Un tope leído del entorno, que cae al default si el valor no es un número.
 *
 * `parseInt("")` da NaN, y `total >= NaN` es false para cualquier total: una
 * variable vacía o mal escrita no relaja el tope, lo apaga entero y en
 * silencio. Es la misma forma que tenía el `cost_usd = 0` — un techo que no se
 * puede alcanzar nunca avisa de que no está.
 *
 * Un cero se respeta: apagar el gasto a propósito es una decisión válida. Lo
 * que no se acepta es basura, un negativo, o la variable vacía que deja un
 * workflow cuando el secreto que la llena no existe.
 */
export function readCap(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!raw?.trim() || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** El tope decimal escrito, o null si rige la omisión. */
export function topeDecimalEscrito(nombre: TopeDecimal, env: EntornoDeTopes = process.env): number | null {
  const n = readCap(env[nombre], Number.NaN);
  return Number.isNaN(n) ? null : n;
}

export function topeDecimal(nombre: TopeDecimal, env: EntornoDeTopes = process.env): number {
  const { omision } = TOPES_DECIMALES.find((t) => t.nombre === nombre)!;
  return readCap(env[nombre], omision);
}

/** El tope mensual de IA del proyecto entero, en USD: con 0 la IA queda frenada a propósito. */
export function topeMensualDelProyecto(env: EntornoDeTopes = process.env): number {
  return topeDecimal("MONTHLY_BUDGET_USD", env);
}

/**
 * Lo que gastan los canales sin persona —mail, WhatsApp, formulario— no puede
 * quedarse con todo el cupo del inquilino: entran sin autenticar. Sin variable,
 * el 60 % del tope del inquilino. Derivado y no fijo a propósito, así producción
 * no se frena por una variable que falta.
 */
export function topeAnonimo(env: EntornoDeTopes = process.env): number {
  return readCap(env.AI_ANONIMO_DAILY_TOKEN_CAP, Math.floor(topeDecimal("AI_TENANT_DAILY_TOKEN_CAP", env) * 0.6));
}
