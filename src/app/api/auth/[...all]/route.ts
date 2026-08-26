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
 * **Qué se limita y qué no.** Sólo lo que consume un secreto: entrar y darse de
 * alta. Leer la sesión pasa en cada carga de página y ponerle techo sería
 * romper la aplicación para el que la usa bien.
 *
 * **Por qué por IP + dirección.** Sólo por IP, una oficina entera detrás de un
 * NAT comparte el cupo y se traba sola. Sólo por dirección, el atacante rota
 * direcciones y no lo frena nada. Juntos, cada combinación tiene su cuenta.
 */
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { rateLimit, getClientIp, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";

const handler = toNextJsHandler(auth);

/** Las operaciones que gastan un secreto, y por eso llevan techo. */
const CON_TECHO = ["/sign-in", "/sign-up"];

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

export const { GET } = handler;

export async function POST(req: NextRequest) {
  const ruta = new URL(req.url).pathname;

  if (CON_TECHO.some((p) => ruta.includes(p))) {
    const ip = getClientIp(req);
    const direccion = await direccionDelCuerpo(req);
    const clave = `auth:${ruta.includes("sign-up") ? "up" : "in"}:${ip}:${direccion}`;
    const config = ruta.includes("sign-up")
      ? RATE_LIMIT_CONFIGS.AUTH_SIGN_UP
      : RATE_LIMIT_CONFIGS.AUTH_SIGN_IN;

    const permitido = await rateLimit(clave, config);
    if (!permitido.allowed) {
      const esperar = Math.max(1, Math.ceil((permitido.resetAt - Date.now()) / 1000));
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
  }

  return handler.POST(req);
}
