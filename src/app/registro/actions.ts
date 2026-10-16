/**
 * Server Actions de /registro.
 *
 * Los dos caminos empiezan sin escribir ninguna cuenta:
 *
 * - Google guarda lo que escribió la persona en la cookie sellada `cm_alta` y la
 *   manda a Google; al volver, /alta crea el espacio.
 * - El correo sólo manda un enlace sellado con todo lo que hace falta. La cuenta
 *   se crea cuando la persona vuelve de ese enlace (/alta/correo). Quien tipea
 *   direcciones ajenas no deja filas en la base: sólo cupos del limitador.
 *
 * `signUp` termina siempre en el mismo aviso: una dirección nueva, una que ya
 * tenía cuenta y una que no está habilitada no se distinguen desde afuera. Ni por
 * la respuesta ni por cuánto tarda: todo lo que depende de la dirección (la base,
 * la lista, el mail) corre en `after`, con la respuesta ya enviada. Por eso
 * tampoco llama nunca a `signUpEmail`.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { auth } from "@/lib/auth";
import { resolveBaseURL } from "@/lib/auth/base-url";
import { altaAbierta } from "@/lib/auth/registro-permitido";
import { isOperatorEmail } from "@/lib/auth/require-operator";
import { db } from "@/lib/db";
import { authUsers } from "@/lib/db/schema";
import { entero } from "@/lib/entero";
import { getT, type Locale } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { logger } from "@/lib/observability/logger";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import {
  RATE_LIMIT_CONFIGS,
  clientIpFromHeaders,
  rateLimit,
  topePorIp,
} from "@/lib/rate-limit/index";
import { SignUpSchema } from "@/lib/schemas/auth";
import { PARAMETRO_DE_VUELTA, ponerCookieDeAlta } from "@/server/alta/cookie";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { DURACION_DEL_TOKEN_MS, sellarToken } from "@/server/alta/token-de-registro";
import { verificarTurnstile } from "@/server/alta/turnstile";
import { faltaElNueveArgentino, normalizarE164, validarEmpresa, type ErrorDeAlta } from "@/server/alta/validar";
import { correoDeEnlace, correoYaTenesCuenta } from "@/server/notify/correos-de-alta";
import { enviarCorreoDelSistema } from "@/server/notify/remitente-sistema";
import { dominioExigeSsoEnAlgunInquilino } from "@/server/sso/usuarios";

const AVISO_NEUTRO = "/login?aviso=revisa_tu_correo";
const ERROR_DE_GOOGLE = "/login?error=google_signin_failed";

const conError = (e: Extract<ErrorDeAlta, "datos" | "intentos" | "celular">) => `/registro?e=${e}`;

const DIA_MS = 24 * 60 * 60_000;

/**
 * Lo que piden los dos caminos: la empresa, su WhatsApp y los términos aceptados. Con el número
 * automático prendido, un +54 sin el 9 de los celulares no se acepta y se dice por qué.
 */
function datosDeLaEmpresa(
  formData: FormData,
): { empresa: string; numero: string } | { error: "datos" | "celular" } {
  const empresa = validarEmpresa(formData.get("empresa"));
  const numero = normalizarE164(formData.get("whatsapp"));
  if (!empresa.ok || numero === null || formData.get("terminos") !== "on") return { error: "datos" };
  if (numeroAutomatico() && faltaElNueveArgentino(numero)) return { error: "celular" };
  return { empresa: empresa.empresa, numero };
}

async function existeCuenta(email: string): Promise<boolean> {
  // sin-inquilino: la tabla de usuarios de Better Auth no tiene columna de
  // inquilino, y se pregunta justamente si ese correo ya tiene cuenta.
  const [fila] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)).limit(1);
  return fila !== undefined;
}

/**
 * Lo que depende de la dirección, ya con la respuesta enviada. A quien ya tiene
 * cuenta se le avisa a ella; a una nueva se le manda el enlace, siempre que el
 * alta esté abierta para su dirección. Sin cuenta ni enlace no sale nada.
 */
async function mandarElCorreo(input: {
  email: string;
  nombre: string;
  empresa: string;
  numero: string;
  locale: Locale;
  ip: string;
}): Promise<void> {
  const { email, nombre, empresa, numero, locale, ip } = input;
  const t = getT(locale);
  const base = resolveBaseURL();

  let correo;
  if (await existeCuenta(email)) {
    correo = correoYaTenesCuenta(t, `${base}/login`, `${base}/recuperar`);
  } else {
    // Cerrada la puerta, una dirección de operación o un dominio con SSO: el mismo silencio.
    if (!altaAbierta(email) || isOperatorEmail(email) || (await dominioExigeSsoEnAlgunInquilino(email))) {
      return;
    }
    const enlace = `${base}/alta/correo?t=${sellarToken({ e: email, empresa, numero, nombre, locale })}`;
    correo = correoDeEnlace(t, "activar", enlace, DURACION_DEL_TOKEN_MS / 60_000);
  }

  // Los cupos del mail (global y por destinatario) los toma el remitente del sistema.
  const resultado = await enviarCorreoDelSistema({ to: email, ...correo }, { tipo: "alta", ip });
  if (!resultado.enviado) logger.warn({ motivo: resultado.motivo }, "registro.correo_no_salio");
}

/** La ruta a la que sigue el pedido por correo. Nunca redirige: de eso se ocupa quien la llama, fuera de todo try/catch. */
async function destinoDelCorreo(formData: FormData): Promise<string> {
  const empresa = datosDeLaEmpresa(formData);
  const cuenta = SignUpSchema.safeParse({
    full_name: formData.get("full_name"),
    email: formData.get("email"),
  });
  if ("error" in empresa) return conError(empresa.error);
  if (!cuenta.success) return conError("datos");

  const headerStore = await headers();
  // La misma resolución que la ruta HTTP: prefiere `x-vercel-forwarded-for`,
  // que es la única cabecera que no puede escribir quien llama.
  const ip = clientIpFromHeaders(headerStore);

  const rl = await rateLimit(claveDeCupo("auth:up", ip), RATE_LIMIT_CONFIGS.AUTH_SIGN_UP);
  const porIp = await topePorIp(ip);
  if (!rl.allowed || !porIp.allowed) return conError("intentos");

  // Un desafío no pasado termina como cualquier otro final: sin mail y sin decir por qué.
  const desafio = await verificarTurnstile(formData.get("cf-turnstile-response"), ip);
  if (!desafio.paso) {
    const { motivo, codigos } = desafio;
    // Error si la clave está mal pegada: deja a todos afuera en silencio.
    const claveRota = codigos?.some((c) => c === "invalid-input-secret" || c === "missing-input-secret");
    if (claveRota) logger.error({ motivo, codigos }, "registro.turnstile_no_paso");
    else logger.warn({ motivo, codigos }, "registro.turnstile_no_paso");
    return AVISO_NEUTRO;
  }

  /*
   * Los pedidos por día de una misma IP, con el desafío ya pasado. Cuenta el
   * pedido y no el mail: depende sólo de la IP, así que decirlo no delata nada de
   * la dirección. Sin esto, una IP con el desafío resuelto gasta el cupo de mails
   * de alta de todos a razón de `auth:up` por minuto.
   */
  const delDia = await rateLimit(claveDeCupo("alta:correo-ip", ip), {
    limit: entero("ALTA_TOPE_CORREO_POR_IP_DIA", 10, 1, 1000),
    windowMs: DIA_MS,
    fallaCerrada: true,
  });
  if (!delDia.allowed) return conError("intentos");

  const locale = await getServerLocale();
  const { email, full_name } = cuenta.data;
  after(() =>
    mandarElCorreo({ email, nombre: full_name, ...empresa, locale, ip }).catch((e) => {
      // Ya se contestó «revisá tu correo»: sin esta línea, una falla de la base
      // o del remitente no deja rastro ni mail.
      logger.error({ detalle: e instanceof Error ? e.name : "unknown" }, "registro.alta_no_terminada");
    })
  );
  return AVISO_NEUTRO;
}

export async function signUp(formData: FormData): Promise<void> {
  redirect(await destinoDelCorreo(formData));
}

/** La ruta a la que sigue el pedido con Google: la URL de Google, o el error. Nunca redirige. */
async function destinoDeGoogle(formData: FormData): Promise<string> {
  const empresa = datosDeLaEmpresa(formData);
  if ("error" in empresa) return conError(empresa.error);

  const headerStore = await headers();
  const porIp = await topePorIp(clientIpFromHeaders(headerStore));
  if (!porIp.allowed) return conError("intentos");

  try {
    const v = await ponerCookieDeAlta({ ...empresa, locale: await getServerLocale(), origen: "google" });
    // /alta toma la cookie por suya sólo si llega por este viaje (ver cookie.ts).
    const vuelta = `/alta?${PARAMETRO_DE_VUELTA}=${v}`;
    const resultado = await auth.api.signInSocial({
      body: {
        provider: "google",
        callbackURL: vuelta,
        newUserCallbackURL: vuelta,
        // Sin query propia: Better Auth le agrega el código y un parámetro repetido llega como array.
        errorCallbackURL: "/login",
      },
      headers: headerStore,
    });
    if (resultado.url) return resultado.url;
  } catch (e) {
    logger.error({ detalle: e instanceof Error ? e.message : String(e) }, "auth.google.signin_start_failed");
  }
  return ERROR_DE_GOOGLE;
}

export async function empezarAltaConGoogle(formData: FormData): Promise<void> {
  redirect(await destinoDeGoogle(formData));
}
