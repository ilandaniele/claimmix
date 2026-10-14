/**
 * Server Actions del alta con la WABA propia: el popup de Meta (Embedded Signup) y el
 * asistente de la app que crea el propio cliente (`appPropia.*`).
 *
 * Una action es un POST que cualquiera puede armar a mano, así que cada una pide
 * `requireRole` por su cuenta: que la pantalla no muestre el botón no es una guarda.
 * Sólo pasa quien es owner o admin de un espacio del alta automática. Qué vía rige (las
 * banderas `ALTA_WABA_PROPIA` y `ALTA_APP_PROPIA`, o el origen de la fila que ya existe)
 * lo decide cada función del servidor con `activaPara`, y soltar lo que ya se tiene
 * (`cancelacionDeWabaPropia`, `cancelarAppPropia`, `desconectarWabaPropia`) no mira ninguna.
 * Quién pide (espacio, usuario, IP, idioma) sale de la sesión y de los headers, nunca del cuerpo.
 *
 * A diferencia de las de /configuracion, éstas devuelven un valor y no redirigen: el
 * popup de Meta vive en el navegador y la pantalla sigue ahí. El valor es siempre
 * una lista cerrada (`ResultadoDeApp`), nunca texto que venga del pedido ni de Graph.
 * Ninguna devuelve un token, un secreto, un PIN ni una prueba de firma; lo único
 * parecido que vuelve es la marca del webhook (`verifyToken`), que el cliente pega en su app.
 *
 * El código del popup vale 30 segundos y una sola vez, y lo que el navegador cuenta del
 * popup es una pista. Por eso `conectarWabaPropia` pide el sello que dejó
 * `iniciarWabaPropia` (de esta sesión, de hace menos de diez minutos y con el número
 * al azar de la cookie `cm_waba`, que se gasta al usarla): un pedido armado a mano no
 * llega a Graph.
 */

"use server";

import { randomBytes } from "node:crypto";

import { cookies, headers } from "next/headers";

import { ipValida } from "@/lib/audit/log";
import { ADMIN_ROLES, requireRole } from "@/lib/auth/require-role";
import { AppError } from "@/lib/errors";
import { ID_DE_META, ID_DE_USUARIO_DE_META } from "@/lib/meta-ids";
import { nombreDelError } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { clientIpFromHeaders, liberarCupo, rateLimit, RATE_LIMIT_CONFIGS, topePorIp } from "@/lib/rate-limit/index";
import { categoriaDePerfil } from "@/lib/whatsapp-categorias";
import { sellar, abrir } from "@/server/alta/sellado";
import {
  cancelarDeApp,
  credencialesDeApp,
  estadoDeApp,
  iniciarApp,
  nombreDeApp,
  reintentarDeApp,
  tokenDeApp,
  webhookDeApp,
  type DatosDelWebhook,
  type EstadoDeApp,
  type RespuestaDeToken,
} from "@/server/alta/app-propia";
import type { QuienPide } from "@/server/alta/pasos-del-numero";
import {
  aceptarNumero,
  cancelarWaba,
  codigoWaba,
  desconectarWaba,
  iniciarWaba,
  pinWaba,
  vincularWaba,
  type SetupDeMeta,
} from "@/server/alta/waba-propia";
import { faltantesDeAppPropia } from "@/server/alta/waba-propia-activa";
import type { ResultadoDeApp } from "@/server/alta/waba-resultados";
import { versionDeGraph } from "@/server/whatsapp/cloud-api";
import { appDeMeta } from "@/server/whatsapp/embedded-signup";

const COOKIE = "cm_waba";
const INFO_DEL_SELLO = "waba-propia";
const DURACION_MS = 10 * 60_000;
const EVENTO = /^[A-Z_]{1,60}$/;
const MAX_CODIGO = 1024;
const MAX_NOMBRE = 60;
const MAX_WEB = 200;

export interface Resultado {
  resultado: ResultadoDeApp;
}

export interface Inicio extends Resultado {
  /** Sólo con `listo`: lo que el navegador le pasa de vuelta a `conectarWabaPropia`. */
  inicio?: string;
  appId?: string;
  configId?: string;
  version?: string;
  setup?: SetupDeMeta;
}

export interface Vinculo extends Resultado {
  /** Sólo con `numero_distinto`: el número que informó Meta, para que la persona lo confirme. */
  numeroMeta?: string;
}

/**
 * Quién pide, o por qué no puede. Lo que tire `hacer` se anota por nombre y vuelve
 * como `meta`: la pantalla nunca ve un error de servidor.
 */
async function conQuien<T extends object>(hacer: (quien: QuienPide) => Promise<T>): Promise<T | Resultado> {
  let quien: QuienPide;
  try {
    const { userRow } = await requireRole(...ADMIN_ROLES);
    if (userRow.autoalta !== true) return { resultado: "revision" };
    quien = {
      tenantId: userRow.tenant_id,
      userId: userRow.id,
      ip: ipValida(clientIpFromHeaders(await headers())),
      idioma: userRow.locale === "en-US" ? "en-US" : "es-AR",
    };
  } catch (e) {
    return { resultado: e instanceof AppError && e.code === "MISSING_SESSION" ? "vencido" : "revision" };
  }
  try {
    return await hacer(quien);
  } catch (e) {
    logger.error({ error: nombreDelError(e) }, "conectar_whatsapp.waba_accion_fallo");
    return { resultado: "meta" };
  }
}

/** Un texto con límite de largo, o null: lo que llega a una action puede ser cualquier cosa. */
function texto(valor: unknown, max: number): string | null {
  return typeof valor === "string" && valor.length <= max ? valor : null;
}

/** Una pista opcional del popup: ausente es undefined, y con un tipo o un largo raro es null. */
function pista(valor: unknown, max: number): string | undefined | null {
  return valor === undefined || valor === null ? undefined : texto(valor, max);
}

/** Un sitio web https, o null. Meta lo muestra en el perfil: un esquema raro no pasa. */
function webValida(valor: unknown): string | null {
  const t = texto(valor, MAX_WEB)?.trim();
  if (!t) return null;
  try {
    return new URL(t).protocol === "https:" ? t : null;
  } catch {
    return null;
  }
}

/** Todos los accesos por IP comparten un tope: el del login ya tiene su ventana y su clave. */
async function ipConLugar(quien: QuienPide): Promise<boolean> {
  return (await topePorIp(quien.ip ?? "sin-ip")).allowed;
}

let avisadaLaConfigDeApp = false;

/** La vía de la app propia está pedida pero le falta configuración: se anota una vez por proceso, con los nombres y nunca los valores. */
function avisarSiFaltaLaConfigDeApp(): void {
  if (avisadaLaConfigDeApp || process.env.ALTA_APP_PROPIA !== "1") return;
  const faltan = faltantesDeAppPropia();
  if (faltan.length === 0) return;
  avisadaLaConfigDeApp = true;
  logger.error({ faltan }, "alta.app_propia_sin_config");
}

/** El tope por hora de las acciones del asistente que llaman a Graph con las claves del cliente. */
async function appConLugar(quien: QuienPide): Promise<boolean> {
  avisarSiFaltaLaConfigDeApp();
  return (await rateLimit(claveDeCupo("wa:app", quien.tenantId), RATE_LIMIT_CONFIGS.APP_PROPIA)).allowed;
}

/**
 * Abre el alta: mira que haya lugar esta semana, arma lo que el popup precarga y deja el
 * sello que `conectarWabaPropia` va a pedir. El número al azar del sello va también en
 * una cookie del navegador, que la acción siguiente gasta.
 */
export async function iniciarWabaPropia(entrada: { nombre?: unknown; web?: unknown; categoria?: unknown }): Promise<Inicio> {
  return conQuien<Inicio>(async (quien) => {
    const nombre = texto(entrada?.nombre, MAX_NOMBRE)?.trim();
    if (!nombre) return { resultado: "meta" };
    if (!(await ipConLugar(quien))) return { resultado: "esperar" };
    const app = appDeMeta();
    if (!app) return { resultado: "apagado" };

    const web = entrada.web ? webValida(entrada.web) : null;
    if (entrada.web && !web) return { resultado: "meta" };

    // Un rubro que no esté en la lista de Meta se descarta: `iniciarWaba` pone el inicial.
    const categoria = categoriaDePerfil(entrada.categoria);

    const iniciado = await iniciarWaba(quien, { nombre, ...(web ? { web } : {}), ...(categoria ? { categoria } : {}) });
    if (iniciado.resultado !== "listo" || !("setup" in iniciado)) return { resultado: iniciado.resultado };

    const nonce = randomBytes(32).toString("hex");
    (await cookies()).set(COOKIE, nonce, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: DURACION_MS / 1000,
    });
    const inicio = sellar(INFO_DEL_SELLO, { t: quien.tenantId, u: quien.userId, n: nonce, exp: Date.now() + DURACION_MS });
    return { resultado: "listo", inicio, appId: app.appId, configId: app.configId, version: versionDeGraph(), setup: iniciado.setup };
  });
}

/** ¿El sello es de esta persona, de hace menos de diez minutos y del mismo navegador que lo pidió? */
function selloVale(inicio: unknown, quien: QuienPide, nonce: string | undefined): boolean {
  const s = abrir(INFO_DEL_SELLO, typeof inicio === "string" ? inicio : undefined) as
    | { t?: unknown; u?: unknown; n?: unknown; exp?: unknown }
    | null;
  if (!s || typeof s !== "object") return false;
  return (
    s.t === quien.tenantId &&
    s.u === quien.userId &&
    typeof s.exp === "number" &&
    s.exp > Date.now() &&
    typeof s.n === "string" &&
    !!nonce &&
    s.n === nonce
  );
}

/**
 * El popup terminó: acá llega el código y lo que el navegador cuenta. Los ids que no
 * tienen forma de id de Meta cortan antes de tocar Graph.
 */
export async function conectarWabaPropia(entrada: {
  inicio?: unknown;
  code?: unknown;
  evento?: unknown;
  wabaId?: unknown;
  phoneNumberId?: unknown;
  userId?: unknown;
}): Promise<Vinculo> {
  return conQuien<Vinculo>(async (quien) => {
    if (!(await ipConLugar(quien))) return { resultado: "esperar" };

    // El sello se gasta lo valide o no: un solo intento por apertura del popup.
    const almacenDeCookies = await cookies();
    const nonce = almacenDeCookies.get(COOKIE)?.value;
    almacenDeCookies.delete({ name: COOKIE, path: "/" });
    if (!selloVale(entrada?.inicio, quien, nonce)) return { resultado: "vencido" };

    const code = texto(entrada.code, MAX_CODIGO);
    if (!code) return { resultado: "meta" };
    const evento = pista(entrada.evento, 60);
    const wabaId = pista(entrada.wabaId, 20);
    const phoneNumberId = pista(entrada.phoneNumberId, 20);
    const userId = pista(entrada.userId, 30);
    if (evento === null || wabaId === null || phoneNumberId === null || userId === null) return { resultado: "meta" };
    if (evento !== undefined && !EVENTO.test(evento)) return { resultado: "meta" };
    if ([wabaId, phoneNumberId].some((id) => id !== undefined && !ID_DE_META.test(id))) return { resultado: "meta" };
    if (userId !== undefined && !ID_DE_USUARIO_DE_META.test(userId)) return { resultado: "meta" };

    return vincularWaba(quien, { code, evento, wabaId, phoneNumberId, userId });
  });
}

/** La persona confirma que el número que Meta informó es el suyo. */
export async function aceptarNumeroDeMeta(): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => {
    if (!(await ipConLugar(quien))) return { resultado: "esperar" };
    return { resultado: await aceptarNumero(quien) };
  });
}

/** Pedir el código del número por SMS o llamada, o entregarlo. */
export async function codigoDeWabaPropia(
  entrada: { accion?: unknown; codigo?: unknown }
): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => {
    if (entrada?.accion === "SMS" || entrada?.accion === "VOICE") {
      return { resultado: await codigoWaba(quien, { accion: entrada.accion }) };
    }
    if (entrada?.accion === "verificar") {
      // El SMS lo muestra a veces con espacio en el medio («123 456»): se pega tal cual y no cuenta.
      const codigo = (texto(entrada.codigo, 32) ?? "").replace(/\s+/g, "");
      return { resultado: await codigoWaba(quien, { accion: "verificar", codigo }) };
    }
    return { resultado: "meta" };
  });
}

/** El PIN del segundo factor que el número ya tenía. */
export async function pinDeWabaPropia(entrada: { pin?: unknown }): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => ({ resultado: await pinWaba(quien, (texto(entrada?.pin, 32) ?? "").trim()) }));
}

/** «Reintentar»: retoma desde lo que la base y Meta dicen que falta, sin abrir el popup. Con el nombre de la app propia rechazado, primero mira cómo va la revisión. */
export async function reintentarWabaPropia(): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => {
    if (!(await ipConLugar(quien))) return { resultado: "esperar" };
    return { resultado: await reintentarDeApp(quien) };
  });
}

/** El popup se cerró sin terminar. El paso y el código de error vienen del navegador: se acotan adentro. */
export async function cancelacionDeWabaPropia(entrada: { paso?: unknown; codigo?: unknown }): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => {
    const codigo = typeof entrada?.codigo === "number" ? entrada.codigo : undefined;
    return { resultado: await cancelarWaba(quien, entrada?.paso, codigo) };
  });
}

/** «Cancelar» mientras se arma la app propia: se sueltan el secreto y la ruta del webhook. No mira ninguna bandera (S11). */
export async function cancelarAppPropia(): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => ({ resultado: await cancelarDeApp(quien) }));
}

/** El cliente suelta su WhatsApp: se borra el token y se da de baja el número. */
export async function desconectarWabaPropia(): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => ({ resultado: await desconectarWaba(quien) }));
}

/* ── El asistente de la app propia ────────────────────────────────────────── */

/**
 * Abre el alta con la app propia: el acuerdo que la persona aceptó, la razón social y el CUIT de su
 * empresa y, si quiere, el número que va a usar. Cada arranque que prospera crea la ruta pública de un
 * webhook, así que hay tres por día; un arranque que no prospera devuelve el suyo.
 */
export async function iniciarAppPropia(entrada: { acuerdo?: unknown; razonSocial?: unknown; cuit?: unknown; numero?: unknown }): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => {
    avisarSiFaltaLaConfigDeApp();
    const acuerdo = texto(entrada?.acuerdo, 20);
    const razonSocial = texto(entrada?.razonSocial, 120);
    const cuit = texto(entrada?.cuit, 13);
    const numero = pista(entrada?.numero, 20);
    if (acuerdo === null) return { resultado: "formato" };
    if (razonSocial === null) return { resultado: "razon_invalida" };
    if (cuit === null) return { resultado: "cuit_invalido" };
    if (numero === null) return { resultado: "numero_invalido" };
    if (!(await ipConLugar(quien))) return { resultado: "esperar" };

    const { windowMs } = RATE_LIMIT_CONFIGS.APP_PROPIA_INICIO;
    const clave = claveDeCupo("wa:app:inicio", quien.tenantId);
    const cupo = await rateLimit(clave, RATE_LIMIT_CONFIGS.APP_PROPIA_INICIO);
    const devolver = () => liberarCupo(clave, windowMs, cupo.ventana).catch(() => undefined);
    if (!cupo.allowed) {
      await devolver();
      return { resultado: "esperar" };
    }
    const iniciado = await iniciarApp(quien, { acuerdo, razonSocial, cuit, ...(numero ? { numero } : {}) });
    if (iniciado.resultado !== "listo") await devolver();
    return iniciado;
  });
}

/** El ID y el secreto de la app del cliente. Nunca vuelven: la respuesta es sólo el resultado. */
export async function credencialesDeAppPropia(entrada: { appId?: unknown; secreto?: unknown }): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => {
    const appId = texto(entrada?.appId, 20);
    const secreto = texto(entrada?.secreto, 128);
    if (appId === null) return { resultado: "formato_app" };
    if (secreto === null) return { resultado: "formato_secreto" };
    if (!(await appConLugar(quien))) return { resultado: "esperar" };
    return credencialesDeApp(quien, { appId, secreto });
  });
}

/** La dirección y la marca que el cliente pega en su app, y si el callback actual de la app pide mirarlo. */
export async function webhookDeAppPropia(): Promise<{ resultado: ResultadoDeApp; webhook?: DatosDelWebhook }> {
  return conQuien<{ resultado: ResultadoDeApp; webhook?: DatosDelWebhook }>(async (quien) => {
    if (!(await appConLugar(quien))) return { resultado: "esperar" };
    return webhookDeApp(quien);
  });
}

/**
 * El token del usuario del sistema del cliente. Con el alta en curso trae el WABA ID (de ahí se saca el
 * número); con el número ya conectado (E6) sólo cambia el token y el WABA ID que llegue no se usa, así que
 * el formato lo mira el servidor según el caso y acá sólo se acota el largo.
 */
export async function tokenDeAppPropia(entrada: {
  token?: unknown;
  wabaId?: unknown;
  phoneNumberId?: unknown;
  categoria?: unknown;
}): Promise<RespuestaDeToken> {
  return conQuien<RespuestaDeToken>(async (quien) => {
    const token = texto(entrada?.token, 2048);
    const wabaId = texto(entrada?.wabaId, 20);
    const phoneNumberId = pista(entrada?.phoneNumberId, 20);
    if (token === null) return { resultado: "token_formato" };
    if (wabaId === null) return { resultado: "waba_formato" };
    if (phoneNumberId === null) return { resultado: "meta" };
    if (!(await appConLugar(quien))) return { resultado: "esperar" };
    // Un rubro que no esté en la lista de Meta se descarta, igual que al iniciar Embedded Signup: sale el inicial.
    const categoria = categoriaDePerfil(entrada?.categoria);
    return tokenDeApp(quien, { token, wabaId, ...(phoneNumberId ? { phoneNumberId } : {}), ...(categoria ? { categoria } : {}) });
  });
}

/** Un nombre visible nuevo para el número, cuando Meta rechazó el anterior. */
export async function nombreDeAppPropia(entrada: { nombre?: unknown }): Promise<Resultado> {
  return conQuien<Resultado>(async (quien) => {
    const nombre = texto(entrada?.nombre, MAX_NOMBRE);
    if (nombre === null) return { resultado: "nombre_invalido" };
    if (!(await appConLugar(quien))) return { resultado: "esperar" };
    return nombreDeApp(quien, nombre);
  });
}

/**
 * En qué ventana está el cliente. La pantalla lo consulta cada pocos segundos mientras espera, así que
 * tiene su propio tope (`ESTADO_APP`) y hace una sola lectura de la base. Pasado el tope contesta
 * `{ resultado: "esperar" }`, que se distingue de un estado porque no trae `paso`.
 */
export async function estadoDeAppPropia(): Promise<EstadoDeApp | Resultado> {
  return conQuien<EstadoDeApp | Resultado>(async (quien) => {
    const cupo = await rateLimit(claveDeCupo("wa:app:estado", quien.tenantId), RATE_LIMIT_CONFIGS.ESTADO_APP);
    if (!cupo.allowed) return { resultado: "esperar" };
    return estadoDeApp(quien);
  });
}
