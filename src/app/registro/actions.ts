/**
 * Server Action for account creation — /registro page.
 *
 * El alta no pide contraseña ni deja sesión. Crea la cuenta con una contraseña
 * al azar que nadie conoce y manda el enlace de restablecimiento al correo: la
 * persona elige la suya desde ahí, y recién entonces `onPasswordReset` verifica
 * el correo y le da el perfil (`provisionUserProfile`, en el inquilino por
 * omisión y con rol "analyst"). Nadie entra sin haber abierto ese enlace.
 *
 * Todos los finales terminan en el mismo aviso: una dirección nueva, una que ya
 * tenía cuenta y una que no está habilitada no se distinguen desde afuera. Ni
 * por la respuesta ni por cuánto tarda: todo lo que depende de la dirección
 * (la lista, el hash, el mail) corre en `after`, con la respuesta ya enviada.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { randomBytes } from "node:crypto";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { auth } from "@/lib/auth";
import { inquilinoDeAltaNueva } from "@/lib/auth/alta-nueva";
import { resolveDefaultTenantId } from "@/lib/auth/provision";
import {
  RATE_LIMIT_CONFIGS,
  clientIpFromHeaders,
  rateLimit,
  topePorIp,
} from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { SignUpSchema } from "@/lib/schemas/auth";
import { logger } from "@/lib/observability/logger";

type SignUpState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

const DESTINO = "/login?aviso=revisa_tu_correo";

export async function signUp(
  _prev: SignUpState,
  formData: FormData
): Promise<SignUpState> {
  // ── 1. Validate input ──────────────────────────────────────────────────────
  const parsed = SignUpSchema.safeParse({
    full_name: formData.get("full_name"),
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { full_name, email } = parsed.data;

  // ── 2. Rate limiting (por IP, y el mismo techo por IP sola que el login) ───
  const headerStore = await headers();
  // La misma resolución que la ruta HTTP: prefiere `x-vercel-forwarded-for`,
  // que es la única cabecera que no puede escribir quien llama.
  const ip = clientIpFromHeaders(headerStore);
  const ua = headerStore.get("user-agent") ?? null;

  const rl = await rateLimit(claveDeCupo("auth:up", ip), RATE_LIMIT_CONFIGS.AUTH_SIGN_UP);
  const porIp = await topePorIp(ip);
  if (!rl.allowed || !porIp.allowed) {
    const cual = !porIp.allowed ? porIp : rl;
    return { error: `Demasiados intentos. Intente en ${cual.retryAfterSeconds} segundos.` };
  }

  // ── 3. Preconditions ───────────────────────────────────────────────────────
  if (!resolveDefaultTenantId()) {
    return { error: "El registro no está habilitado. Contactá al administrador." };
  }

  /*
   * Desde acá nada depende de la dirección que llegó. Si una no habilitada
   * saliera enseguida y una habilitada pagara el hash y el envío del mail
   * (cientos de milisegundos), medir lo que tarda bastaría para leer el padrón
   * de empleados de la aseguradora: la misma enumeración que el aviso neutro
   * evita en la respuesta. Por eso la lista, el alta y el mail corren después.
   */
  after(() =>
    crearCuentaYMandarEnlace({ full_name, email, ip, ua, headerStore }).catch((e) => {
      // Ya se contestó «revisá tu correo»: sin esta línea, una falla de la base
      // en la lista o en el cupo no deja rastro ni mail.
      logger.error({ detalle: e instanceof Error ? e.name : "unknown" }, "registro.alta_no_terminada");
    })
  );

  redirect(DESTINO);
}

async function crearCuentaYMandarEnlace(input: {
  full_name: string;
  email: string;
  ip: string;
  ua: string | null;
  headerStore: Headers;
}): Promise<void> {
  const { full_name, email, ip, ua, headerStore } = input;

  /*
   * El cupo del mail es el mismo de `/recuperar` (`auth:reset`, por IP y
   * correo), y se descuenta SIEMPRE, antes de mirar la lista. Si sólo lo
   * gastaran las habilitadas, `/api/auth/request-password-reset` —que descuenta
   * de la misma clave y contesta 429— diría desde afuera cuáles lo están: el
   * padrón que el aviso neutro oculta.
   */
  const cupoReset = await rateLimit(claveDeCupo("auth:reset", ip, email), RATE_LIMIT_CONFIGS.AUTH_RESET);

  /*
   * La lista de quién puede registrarse, mirada ANTES de llamar a Better Auth.
   *
   * Una dirección que no está en la lista, o cuyo dominio exige SSO, termina en
   * el mismo aviso que una permitida: si contestaran distinto, alcanzaría con
   * probar direcciones para leer el padrón de empleados de la aseguradora. Es
   * lo que `registro-no-enumera.test.ts` existe para proteger.
   */
  const tenantId = await inquilinoDeAltaNueva(email);
  if (!tenantId) return;

  // ── 4. Create the auth user ────────────────────────────────────────────────
  let userId: string | null = null;
  try {
    const result = await auth.api.signUpEmail({
      // Sin cookies: el alta ya no abre sesión. La contraseña no la sabe nadie.
      body: { name: full_name, email, password: randomBytes(32).toString("hex") },
      headers: new Headers(),
    });
    userId = result.user.id;
  } catch (e) {
    const code = e instanceof APIError ? e.body?.code : undefined;
    const yaExiste =
      e instanceof APIError &&
      (code === "USER_ALREADY_EXISTS" || /already/i.test(e.body?.message ?? ""));
    // Que ya exista una cuenta no se dice: sigue por el mismo camino que un alta.
    // Cualquier otra falla sólo se anota: un error que vieran únicamente las
    // direcciones habilitadas delataría la lista.
    if (!yaExiste) {
      logger.error(
        { detalle: code ?? (e instanceof Error ? e.name : "unknown") },
        "registro.auth_api_signupemail"
      );
      return;
    }
  }

  /*
   * Con `autoSignIn: false` Better Auth contesta igual —con un usuario de
   * mentira y un id al azar— cuando el correo ya tenía cuenta. Que la cuenta
   * esté en la base es lo único que dice que se creó, y sólo entonces se audita.
   *
   * Sin `actor_id`: es una FK a `users`, y la cuenta todavía no tiene perfil.
   */
  if (userId) {
    try {
      const { internalAdapter } = await auth.$context;
      if (await internalAdapter.findUserById(userId)) {
        await writeAuditLog({
          tenant_id: tenantId,
          actor_id: null,
          event_type: AuditEvent.AUTH_SIGN_UP,
          target_type: "user",
          target_id: userId,
          payload: { role: "analyst", self_registered: true },
          ip,
          ua,
        });
      }
    } catch {
      logger.error({ user_id: userId }, "registro.auditoria");
    }
  }

  // ── 5. El enlace para elegir la contraseña ─────────────────────────────────
  if (cupoReset.allowed) {
    try {
      await auth.api.requestPasswordReset({
        body: { email, redirectTo: "/restablecer" },
        headers: headerStore,
      });
    } catch (e) {
      // Sólo se anota: si fallara a la vista, delataría qué correos tienen cuenta.
      logger.error(
        { detalle: e instanceof Error ? e.name : "unknown" },
        "registro.enlace_no_enviado"
      );
    }
  } else {
    logger.warn({}, "registro.enlace_sin_cupo");
  }
}
