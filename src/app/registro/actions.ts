/**
 * Server Actions de /registro: el primer paso del alta, que crea sólo la cuenta.
 * El espacio de la empresa se pide después, en /alta.
 *
 * - Google manda a la persona a Google y, al volver, a /alta.
 * - El correo sólo manda un enlace sellado con el nombre y la dirección. La cuenta
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
import { topeEntero } from "@/lib/topes";
import { DURACION_DEL_TOKEN_MS, sellarToken } from "@/server/alta/token-de-registro";
import { verificarTurnstile } from "@/server/alta/turnstile";
import { correoDeEnlace, correoYaTenesCuenta } from "@/server/notify/correos-de-alta";
import { enviarCorreoDelSistema } from "@/server/notify/remitente-sistema";
import { dominioExigeSsoEnAlgunInquilino } from "@/server/sso/usuarios";

const AVISO_NEUTRO = "/login?aviso=revisa_tu_correo";
const ERROR_DE_GOOGLE = "/login?error=google_signin_failed";

const conError = (e: "datos" | "intentos" | "terminos") => `/registro?e=${e}`;

const DIA_MS = 24 * 60 * 60_000;

/** Los términos son de los dos caminos; el nombre y el correo, sólo del segundo. */
const aceptoLosTerminos = (formData: FormData) => formData.get("terminos") === "on";

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
  locale: Locale;
  ip: string;
}): Promise<void> {
  const { email, nombre, locale, ip } = input;
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
    const enlace = `${base}/alta/correo?t=${sellarToken({ e: email, nombre, locale })}`;
    correo = correoDeEnlace(t, "activar", enlace, DURACION_DEL_TOKEN_MS / 60_000);
  }

  // Los cupos del mail (global y por destinatario) los toma el remitente del sistema.
  const resultado = await enviarCorreoDelSistema({ to: email, ...correo }, { tipo: "alta", ip });
  if (!resultado.enviado) logger.warn({ motivo: resultado.motivo }, "registro.correo_no_salio");
}

/** La ruta a la que sigue el pedido por correo. Nunca redirige: de eso se ocupa quien la llama, fuera de todo try/catch. */
async function destinoDelCorreo(formData: FormData): Promise<string> {
  const cuenta = SignUpSchema.safeParse({
    full_name: formData.get("full_name"),
    email: formData.get("email"),
  });
  if (!cuenta.success || !aceptoLosTerminos(formData)) return conError("datos");

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
    limit: topeEntero("ALTA_TOPE_CORREO_POR_IP_DIA"),
    windowMs: DIA_MS,
    fallaCerrada: true,
  });
  if (!delDia.allowed) return conError("intentos");

  const locale = await getServerLocale();
  const { email, full_name } = cuenta.data;
  after(() =>
    mandarElCorreo({ email, nombre: full_name, locale, ip }).catch((e) => {
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
  // Con Google no hay nombre ni correo que revisar: lo único que puede faltar son los términos.
  if (!aceptoLosTerminos(formData)) return conError("terminos");

  const headerStore = await headers();
  const porIp = await topePorIp(clientIpFromHeaders(headerStore));
  if (!porIp.allowed) return conError("intentos");

  try {
    const resultado = await auth.api.signInSocial({
      body: {
        provider: "google",
        // Con la cuenta hecha, la persona dice en /alta qué vino a hacer.
        callbackURL: "/alta",
        newUserCallbackURL: "/alta",
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
