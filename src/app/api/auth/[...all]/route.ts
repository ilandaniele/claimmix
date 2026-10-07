/**
 * Los endpoints de Better Auth, con techo de intentos.
 *
 * El límite ya existía —`RATE_LIMIT_CONFIGS.AUTH_SIGN_IN`, cinco intentos cada
 * diez segundos— pero sólo lo aplicaba `src/app/login/actions.ts`, que es la
 * Server Action del formulario. O sea: estaba en el camino que recorre una
 * persona, y no en el que recorre alguien que quiere adivinar una contraseña.
 *
 * Un atacante no completa un formulario. Postea acá. Medido antes de escribir
 * esto: ocho intentos fallidos seguidos contra `/api/auth/sign-in/email`, ocho
 * 401, ningún 429.
 *
 * El requisito estaba escrito (AC3), la configuración estaba escrita, y había
 * un test de integración que lo comprobaba. Nadie lo notó porque ese test
 * llevaba meses salteado en CI.
 *
 * **Qué se limita y qué no.** Sólo lo que consume un secreto: entrar y pedir el
 * enlace de restablecimiento. Leer la sesión pasa en cada carga de página y
 * ponerle techo sería romper la aplicación para el que la usa bien. Cambiar la
 * contraseña también gasta un secreto (la actual) y va por usuario;
 * `/verify-password` y `/sign-up/email` no existen para esta app.
 *
 * **Por qué por IP + dirección.** Sólo por IP, una oficina entera detrás de un
 * NAT comparte el cupo y se traba sola. Sólo por dirección, el atacante rota
 * direcciones y no lo frena nada. Juntos, cada combinación tiene su cuenta.
 */
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse, type NextRequest } from "next/server";

import { err } from "@/lib/api/respond";
import { auth } from "@/lib/auth";
import {
  RATE_LIMIT_CONFIGS,
  getClientIp,
  rateLimit,
  topePorIp,
} from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";

const handler = toNextJsHandler(auth);

/**
 * Las operaciones que gastan algo, y por eso llevan techo.
 *
 * `sign-in` gasta un secreto. `request-password-reset` gasta algo distinto y
 * igual de real: manda un mail a una direccion que elige quien llama, desde una
 * casilla en la que esa persona confia.
 */
const CON_TECHO = ["/sign-in", "/request-password-reset"];

/*
 * Lo que la app no usa por HTTP.
 *
 * `/verify-password` es un oráculo de contraseña. `/sign-up/email` dejaría que
 * un tercero registre una dirección permitida que todavía no tiene cuenta y
 * elija la contraseña: el alta pública es `/registro` y la de un admin es
 * `/api/admin/users`, que llaman a `auth.api.signUpEmail` desde el servidor, sin
 * pasar por acá. Además contestaba distinto según la lista permitida (400 o
 * 200), que es el padrón de empleados de la aseguradora.
 */
const SIN_SALIDA = ["/verify-password", "/sign-up/email"];
const CAMBIO_DE_CLAVE = "/change-password";

/**
 * La dirección que viene en el cuerpo, si la hay.
 *
 * Se lee sobre un clon: el cuerpo de un Request se consume una sola vez, y el
 * que tiene que leerlo de verdad es Better Auth.
 */
async function direccionDelCuerpo(req: NextRequest): Promise<string> {
  try {
    const cuerpo = (await req.clone().json()) as { email?: unknown };
    return typeof cuerpo.email === "string" ? cuerpo.email.trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * La vuelta del SSO es un GET que consume trabajo: valida un token contra el
 * IdP y crea o vincula una cuenta. Leer la sesión, que también es un GET, sigue
 * sin techo. Va por IP sola, con el mismo cupo que el resto de los intentos de
 * autenticación: el arranque (`sso-inquilino/sign-in`) ya cae en `CON_TECHO`.
 *
 * Es una navegación del navegador, no una llamada de API: el rechazo es un
 * redirect a /login, no un JSON que la persona vería crudo.
 */
const RUTA_DE_VUELTA_DEL_SSO = "/sso-inquilino/callback";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  if (url.pathname.endsWith(RUTA_DE_VUELTA_DEL_SSO)) {
    const porIp = await topePorIp(getClientIp(req));
    if (!porIp.allowed) {
      const esperar = Math.max(1, Math.ceil((porIp.resetAt - Date.now()) / 1000));
      return NextResponse.redirect(new URL("/login?error=sso_fallo", url), {
        headers: { "Retry-After": String(esperar) },
      });
    }
  }
  return handler.GET(req);
}

function sinCupo(resetAt: number): NextResponse {
  const esperar = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  // El formato de error del resto de la API, no el de Better Auth: quien
  // consume estos endpoints ya sabe leer `{ error: { code } }`, y tener
  // dos formas de decir "no" en la misma aplicación es una trampa para el
  // que escribe el cliente.
  return NextResponse.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "Demasiados intentos. Probá de nuevo en un momento.",
      },
    },
    {
      status: 429,
      // Sin esto, un cliente que reintenta no sabe cuánto esperar y vuelve
      // enseguida — que para el servidor es lo mismo que el ataque.
      headers: { "Retry-After": String(esperar) },
    }
  );
}

export async function POST(req: NextRequest) {
  const ruta = new URL(req.url).pathname;

  if (SIN_SALIDA.some((p) => ruta.endsWith(p))) return err("NOT_FOUND");

  if (ruta.endsWith(CAMBIO_DE_CLAVE)) {
    const sesion = await auth.api.getSession({ headers: req.headers });
    if (sesion) {
      const cupo = await rateLimit(
        claveDeCupo("user", sesion.user.id, "change-password"),
        RATE_LIMIT_CONFIGS.AUTH_CAMBIO_CLAVE
      );
      if (!cupo.allowed) return sinCupo(cupo.resetAt);
    }
    return handler.POST(req);
  }

  if (CON_TECHO.some((p) => ruta.includes(p))) {
    const ip = getClientIp(req);
    const direccion = await direccionDelCuerpo(req);
    const reset = ruta.includes("request-password-reset");
    const clave = claveDeCupo(reset ? "auth:reset" : "auth:in", ip, direccion);
    const config = reset ? RATE_LIMIT_CONFIGS.AUTH_RESET : RATE_LIMIT_CONFIGS.AUTH_SIGN_IN;

    /*
     * Dos cupos, porque son dos ataques distintos.
     *
     * El de arriba es por (IP, dirección): frena a quien prueba contraseñas
     * contra UNA cuenta. Pero con sólo ese, alguien que tenga una lista de diez
     * mil direcciones tiene cinco intentos en cada una y ninguno en total —
     * cincuenta mil pruebas desde una sola IP sin tocar el techo. Es el ataque
     * más común contra un login: no adivinar la contraseña de una persona sino
     * probar una contraseña conocida contra mucha gente.
     *
     * El de abajo es por IP sola, con un número más alto: una oficina entera
     * detrás de un NAT tiene que poder entrar, y el que recorre una lista no.
     */
    // La clave la arma `topePorIp`, compartida con los Server Actions: dos
    // formas de escribir `auth:ip:…` serían dos cupos distintos.
    const porIp = await topePorIp(ip);

    const permitido = await rateLimit(clave, config);
    if (!permitido.allowed || !porIp.allowed) {
      return sinCupo((!porIp.allowed ? porIp : permitido).resetAt);
    }
  }

  return handler.POST(req);
}
