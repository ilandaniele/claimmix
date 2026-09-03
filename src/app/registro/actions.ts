/**
 * Server Action for account creation — /registro page.
 *
 * Creates a Better Auth user (email+password) via auth.api.signUpEmail. The
 * databaseHooks user.create.after hook (provisionUserProfile) creates the
 * public.users profile row in the default tenant with the "analyst" role —
 * same provisioning rule as first-time Google sign-in. Admins can promote
 * accounts later from /admin/users.
 *
 * signUpEmail auto-signs the user in (nextCookies sets the session cookie),
 * so no separate sign-in call is needed.
 *
 * NOTE: redirect() must NOT be wrapped in try/catch — it throws a special
 * Next.js internal error to trigger the redirect.
 */

"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { auth } from "@/lib/auth";
import { resolveDefaultTenantId } from "@/lib/auth/provision";
import {
  permitidosConfigurados,
  puedeRegistrarse,
} from "@/lib/auth/registro-permitido";
import {
  RATE_LIMIT_CONFIGS,
  clientIpFromHeaders,
  rateLimit,
} from "@/lib/rate-limit/index";
import { SignUpSchema } from "@/lib/schemas/auth";

type SignUpState = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function signUp(
  _prev: SignUpState,
  formData: FormData
): Promise<SignUpState> {
  // ── 1. Validate input ──────────────────────────────────────────────────────
  const parsed = SignUpSchema.safeParse({
    full_name: formData.get("full_name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { full_name, email, password } = parsed.data;

  // ── 2. Rate limiting (per IP) ──────────────────────────────────────────────
  const headerStore = await headers();
  // La misma resolución que la ruta HTTP: prefiere `x-vercel-forwarded-for`,
  // que es la única cabecera que no puede escribir quien llama.
  const ip = clientIpFromHeaders(headerStore);
  const ua = headerStore.get("user-agent") ?? null;

  const rl = await rateLimit(`signup:${ip}`, RATE_LIMIT_CONFIGS.AUTH_SIGN_UP);
  if (!rl.allowed) {
    return {
      error: `Demasiados intentos. Intente en ${rl.retryAfterSeconds} segundos.`,
    };
  }

  // ── 3. Preconditions ───────────────────────────────────────────────────────
  // The provisioning hook needs a default tenant; without it user creation
  // would fail halfway. Fail fast with the same message as before.
  const tenantId = resolveDefaultTenantId();
  if (!tenantId) {
    return { error: "El registro no está habilitado. Contactá al administrador." };
  }

  /*
   * La lista de quién puede registrarse, mirada ANTES de llamar a Better Auth.
   *
   * La puerta de verdad está en el gancho `user.create.before` —es el único
   * punto por el que pasan el formulario Y la primera entrada por Google—.
   * Esto es para no llegar hasta allá y volver con un error genérico.
   *
   * ── Va al MISMO lugar que una dirección ya tomada, y eso es el punto ───────
   *
   * La primera versión de esto devolvía «no se puede crear una cuenta con esa
   * dirección», y `registro-no-enumera.test.ts` la rechazó con razón: si una
   * dirección permitida y una que no lo está contestan distinto, alcanza con
   * probar direcciones para leer la lista. Y como la lista puede ser de
   * direcciones exactas —lo es cuando el equipo usa casillas de Gmail— eso no
   * revela «qué dominios atiende el producto» sino el padrón de empleados de
   * la aseguradora, que es justo lo que ese test existe para proteger.
   *
   * Así que las dos cosas terminan en el aviso neutro. Quien tenga que entrar
   * y no pueda, habla con un admin — que es el mismo camino que ya tenía.
   */
  if (!puedeRegistrarse(email, permitidosConfigurados())) {
    redirect("/login?aviso=usa_tu_cuenta");
  }

  // ── 4. Create the auth user (profile row provisioned by the create hook) ──
  let userId: string;
  let signedIn: boolean;
  try {
    const result = await auth.api.signUpEmail({
      body: { name: full_name, email, password },
      headers: headerStore,
    });
    userId = result.user.id;
    // token is null when auto sign-in did not happen.
    signedIn = result.token !== null;
  } catch (e) {
    if (e instanceof APIError) {
      const code = e.body?.code;
      if (code === "USER_ALREADY_EXISTS" || /already/i.test(e.body?.message ?? "")) {
        /*
         * Que ya exista una cuenta NO se dice.
         *
         * Decía «Ya existe una cuenta con ese correo», y con eso alcanzaba para
         * averiguar quién trabaja en la aseguradora: se prueban direcciones y
         * se lee la respuesta. Es la enumeración de usuarios del manual, y en
         * un producto B2B lo que revela es el padrón de empleados.
         *
         * Ahora va al mismo lugar y con el mismo aviso que un alta que se creó
         * pero no dejó sesión abierta. Las dos terminan en «entrá con tu
         * contraseña».
         *
         * Lo que esto NO arregla, y conviene que esté escrito: un alta NUEVA de
         * una dirección permitida sí deja sesión y cae en /bandeja, así que
         * llegar ahí revela que la dirección no existía. La diferencia es que
         * eso ya no es una sonda pasiva —hay que crear la cuenta de verdad, que
         * queda en auditoría— y el tope de tres altas por minuto por IP lo
         * vuelve impracticable a escala. Sacarlo del todo pide rediseñar el
         * alta para que verifique el correo antes de crear nada, que es otro
         * trabajo.
         */
        redirect("/login?aviso=usa_tu_cuenta");
      }
      console.error("[registro] auth.api.signUpEmail:", code ?? e.message);
    } else {
      console.error(
        "[registro] auth.api.signUpEmail:",
        e instanceof Error ? e.name : "unknown"
      );
    }
    return { error: "No se pudo crear la cuenta. Intentá de nuevo." };
  }

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: userId,
    event_type: AuditEvent.AUTH_SIGN_UP,
    target_type: "user",
    target_id: userId,
    payload: { role: "analyst", self_registered: true },
    ip,
    ua,
  });

  // ── 5. Redirect (session cookie already set by signUpEmail) ───────────────
  if (!signedIn) {
    // La cuenta quedó creada pero sin sesión: al login, con el MISMO aviso que
    // recibe alguien cuya dirección ya tenía cuenta. Que los dos caminos
    // terminen igual es lo que impide usar el alta para enumerar.
    redirect("/login?aviso=usa_tu_cuenta");
  }

  redirect("/bandeja");
}
