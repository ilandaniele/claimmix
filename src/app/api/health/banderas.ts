/**
 * Las banderas, los modos y los topes que rigen en este ambiente.
 *
 * Es lo que el dueño mira para saber si dev, QA y prd están igualados, y lo que
 * compara la paridad automática. Sale en `/api/health` con el Bearer, aparte de
 * `checks`: el smoke imprime el `detail` de cada chequeo en los logs públicos de
 * Actions, y esto no tiene que llegar ahí.
 *
 * Lo que sale es un booleano, un número o un modo de una lista cerrada. Los
 * secretos, las direcciones y los textos libres salen sólo como cargada sí o no,
 * nunca el valor. `null` en un tope quiere decir que rige el valor por omisión
 * del código (sin poner, vacío, basura o fuera del rango del lector);
 * `"desconocido"` en un modo, que el valor escrito no es uno que el código reconozca.
 *
 * Es una lista explícita, una clave por variable: no recorre el entorno, así una
 * variable nueva no se filtra sola. Los rangos de los topes copian los de cada
 * `entero(...)` del código, y un test los ata hasta que el ítem 13 los comparta.
 */

import "server-only";

import { leerModo, type ModoDeBorrado } from "@/core/retencion";
import { enteroDe } from "@/lib/entero";
import { readCap } from "@/server/ai/tope-mensual";

type Entorno = Readonly<Record<string, string | undefined>>;

const cargada = (v: string | undefined): boolean => Boolean(v?.trim());

/** El tope decimal escrito, o null si rige el valor por omisión. */
function tope(v: string | undefined): number | null {
  const n = readCap(v, Number.NaN);
  return Number.isNaN(n) ? null : n;
}

/** Sin poner es `apagado`; un valor que `leerModo` no reconoce es `desconocido`. */
function modoDeBorrado(v: string | undefined): ModoDeBorrado | "desconocido" {
  const t = v?.trim().toLowerCase();
  if (!t) return "apagado";
  const m = leerModo(t);
  return m === t ? m : "desconocido";
}

function transporte(v: string | undefined): "vertex" | "ai-studio" | "desconocido" {
  const t = v?.trim().toLowerCase();
  if (!t || t === "ai-studio") return "ai-studio";
  return t === "vertex" ? "vertex" : "desconocido";
}

export function leerBanderas(env: Entorno) {
  return {
    ALTA_AUTOMATICA: env.ALTA_AUTOMATICA === "1",
    ALTA_NUMERO_AUTOMATICO: env.ALTA_NUMERO_AUTOMATICO === "1",
    BASE_POR_CLIENTE: env.BASE_POR_CLIENTE === "1",
    ALTA_WABA_PROPIA: env.ALTA_WABA_PROPIA === "1",
    ALTA_APP_PROPIA: env.ALTA_APP_PROPIA === "1",
    AGENTE_APRENDIDO_EN_CONVERSACION: env.AGENTE_APRENDIDO_EN_CONVERSACION === "1",
    AGENT_DELIBERATION: env.AGENT_DELIBERATION !== "off",
    AGENT_COMPOSE_REPLIES: env.AGENT_COMPOSE_REPLIES !== "off",
    MOCK_AI: env.MOCK_AI === "true",
    AI_MOCK: env.AI_MOCK === "true",
    VERTEX_AI_TUNING_ENABLED: env.VERTEX_AI_TUNING_ENABLED === "true",
    GEMINI_TRANSPORT: transporte(env.GEMINI_TRANSPORT),
    RETENCION_MODO: modoDeBorrado(env.RETENCION_MODO),
    PURGA_ADJUNTOS_MODO: modoDeBorrado(env.PURGA_ADJUNTOS_MODO),
    ALTA_TOPE_GLOBAL_DIA: enteroDe(env.ALTA_TOPE_GLOBAL_DIA, 0, 500),
    ALTA_TOPE_BASES: enteroDe(env.ALTA_TOPE_BASES, 0, 500),
    ALTA_TOPE_MB: enteroDe(env.ALTA_TOPE_MB, 0, 500),
    ALTA_TOPE_IP_DIA: enteroDe(env.ALTA_TOPE_IP_DIA, 1, 100),
    ALTA_PRUEBA_DIAS: enteroDe(env.ALTA_PRUEBA_DIAS, 1, 90),
    AI_PILOTO_DAILY_TOKEN_CAP: enteroDe(env.AI_PILOTO_DAILY_TOKEN_CAP, 1, Number.MAX_SAFE_INTEGER),
    AI_PRUEBA_MONTHLY_USD_POR_INQUILINO: enteroDe(env.AI_PRUEBA_MONTHLY_USD_POR_INQUILINO, 0, 100_000),
    AI_PRUEBAS_MONTHLY_BUDGET_USD: enteroDe(env.AI_PRUEBAS_MONTHLY_BUDGET_USD, 0, 1_000_000),
    ALTA_NUMEROS_MAXIMOS_WABA: enteroDe(env.ALTA_NUMEROS_MAXIMOS_WABA, 1, 1000),
    ALTA_TOPE_NUMEROS_DIA: enteroDe(env.ALTA_TOPE_NUMEROS_DIA, 0, 50),
    ALTA_TOPE_CODIGOS_INQUILINO_DIA: enteroDe(env.ALTA_TOPE_CODIGOS_INQUILINO_DIA, 0, 20),
    ALTA_TOPE_CODIGOS_IP_DIA: enteroDe(env.ALTA_TOPE_CODIGOS_IP_DIA, 0, 50),
    ALTA_TOPE_CODIGOS_DIA: enteroDe(env.ALTA_TOPE_CODIGOS_DIA, 0, 500),
    ALTA_TOPE_VERIFICACIONES_HORA: enteroDe(env.ALTA_TOPE_VERIFICACIONES_HORA, 0, 20),
    ALTA_TOPE_CORREOS_DIA: enteroDe(env.ALTA_TOPE_CORREOS_DIA, 1, 10_000),
    ALTA_TOPE_POR_DESTINATARIO_DIA: enteroDe(env.ALTA_TOPE_POR_DESTINATARIO_DIA, 1, 100),
    ALTA_TOPE_CORREO_POR_IP_DIA: enteroDe(env.ALTA_TOPE_CORREO_POR_IP_DIA, 1, 1000),
    ALTA_TOPE_INVITACIONES_DIA: enteroDe(env.ALTA_TOPE_INVITACIONES_DIA, 1, 1000),
    ALTA_TOPE_WABAS_SEMANA: enteroDe(env.ALTA_TOPE_WABAS_SEMANA, 0, 1000),
    ALTA_TOPE_PLANTILLAS_PRUEBA_DIA: enteroDe(env.ALTA_TOPE_PLANTILLAS_PRUEBA_DIA, 0, 1000),
    MONTHLY_BUDGET_USD: tope(env.MONTHLY_BUDGET_USD),
    AI_TENANT_DAILY_TOKEN_CAP: tope(env.AI_TENANT_DAILY_TOKEN_CAP),
    TURNSTILE_SITE_KEY: cargada(env.TURNSTILE_SITE_KEY),
    TURNSTILE_SECRET_KEY: cargada(env.TURNSTILE_SECRET_KEY),
    ALTA_REMITENTE_CORREO: cargada(env.ALTA_REMITENTE_CORREO),
    ALTA_REMITENTE_REFRESH_TOKEN: cargada(env.ALTA_REMITENTE_REFRESH_TOKEN),
    GMAIL_CLIENT_ID: cargada(env.GMAIL_CLIENT_ID),
    GMAIL_CLIENT_SECRET: cargada(env.GMAIL_CLIENT_SECRET),
    GMAIL_TOKEN_ENCRYPTION_KEY: cargada(env.GMAIL_TOKEN_ENCRYPTION_KEY),
    ADMIN_EMAILS: cargada(env.ADMIN_EMAILS),
    SIGNUP_ALLOWED_EMAILS: cargada(env.SIGNUP_ALLOWED_EMAILS),
    VERTEX_EXTRACTION_MODEL: cargada(env.VERTEX_EXTRACTION_MODEL),
  };
}

export type Banderas = ReturnType<typeof leerBanderas>;
