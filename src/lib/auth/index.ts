import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";

import { db } from "@/lib/db";
import { accounts, authUsers, sessions, verifications } from "@/lib/db/schema";

import { resolveBaseURL } from "./base-url";
import { provisionUserProfile } from "./provision";
import { caminoDeAlta } from "./alta-nueva";
import { ssoInquilino } from "./sso-inquilino";
import { revisarSesionNueva } from "@/server/sso/exigir";

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

/** Una hora. Ver el comentario en `resetPasswordTokenExpiresIn`. */
const RESET_DURA_SEGUNDOS = 60 * 60;

/** Treinta días desde el ingreso, sin renovación: ver usuarios.ts. */
const SESION_DURA_SEGUNDOS = 60 * 60 * 24 * 30;

/**
 * El secreto de sesión, o nada.
 *
 * `secret: process.env.BETTER_AUTH_SECRET` sin más era un fallo abierto: si la
 * variable falta o queda vacía, better-auth NO rompe — usa un secreto de
 * relleno que está publicado en su propio código y escribe un aviso por
 * consola, que en un deploy verde no lee nadie.
 *
 * Con ese secreto conocido se firman cookies de sesión válidas, incluida la
 * caché de sesión de 60 s. Y el inquilino sale de la sesión, así que la capa de
 * datos la sirve obedientemente: RLS no ve un ataque, ve un inquilino.
 * Suplantación completa, cualquier usuario, cualquier aseguradora.
 *
 * ── Por qué NO se comprueba al cargar el módulo ─────────────────────────────
 *
 * Ahí fue el primer intento y rompió el build: `next build` importa este módulo
 * para juntar la configuración de las rutas, y en esa etapa la variable no está
 * —es sensible en Vercel—. El deploy falló con «Failed to collect page data
 * for /api/admin/gmail-accounts/callback», que no se parece en nada al
 * problema que describe.
 *
 * Es un requisito de EJECUCIÓN, no de compilación. Se exige en
 * `instrumentation.ts`, que Next llama una vez por arranque del servidor y no
 * durante el build: sin secreto, la instancia no atiende un solo pedido.
 */
export function exigirSecretoDeSesion(): void {
  if (process.env.BETTER_AUTH_SECRET?.trim()) return;
  throw new Error(
    "Falta BETTER_AUTH_SECRET. Sin él, better-auth firma las sesiones con un " +
      "secreto de relleno que está publicado en su código: cualquiera puede " +
      "fabricar una cookie válida para cualquier usuario de cualquier inquilino."
  );
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: authUsers,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: resolveBaseURL(),
  advanced: {
    // The whole schema uses uuid FKs onto users.id (cases.assigned_to,
    // audit_log.actor_id, ...). Better Auth's default 32-char ids would break
    // them, so generate proper UUIDs.
    database: { generateId: () => crypto.randomUUID() },

    /*
     * Lo que Better Auth manda a segundo plano —hoy, el mail con el enlace de
     * recuperación— corre después de contestar.
     *
     * Esperarlo adentro del pedido hacía que `/request-password-reset` tardara
     * lo que tarda Gmail sólo cuando la dirección existe: la respuesta fija
     * («si ese correo existe, te llega un enlace») no confirmaba nada y el
     * reloj sí. `after()` lo deja en vuelo y Vercel espera a que termine antes
     * de congelar la función. Fuera de un pedido de Next (tests, scripts)
     * `after()` tira: la promesa ya está en marcha y Better Auth le colgó su
     * propio catch, así que alcanza con dejarla.
     */
    backgroundTasks: {
      handler: (tarea) => {
        try {
          after(tarea);
        } catch {
          // Fuera de un pedido: la tarea ya está en vuelo.
        }
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    // Parity with the previous Neon setup (admin.createUser email_confirm: true).
    requireEmailVerification: false,

    /*
     * El alta no deja sesión: nadie entra sin pasar por el correo.
     *
     * El alta pública (`/registro`) crea la cuenta con una contraseña que nadie
     * conoce, y quien la quiere usar la elige desde el enlace que le llega por
     * mail. Con `autoSignIn` prendido, `signUpEmail` abriría la sesión de un
     * correo que nadie probó que fuera suyo.
     */
    autoSignIn: false,

    /*
     * Cuánto dura el enlace de recuperación: una hora, dicho a propósito.
     *
     * Better Auth ya usa una hora por omisión, así que esta línea no cambia el
     * comportamiento — cambia quién lo decide. Un enlace de recuperación es la
     * credencial mientras dura: que su vencimiento dependa del valor por
     * omisión de una dependencia significa que una actualización lo puede
     * alargar sin que nadie lo revise.
     */
    resetPasswordTokenExpiresIn: RESET_DURA_SEGUNDOS,

    /*
     * Restablecer echa a quien estuviera adentro.
     *
     * Es el motivo por el que alguien restablece: cree que le entraron. Better
     * Auth borra todas las sesiones del usuario antes de guardar la contraseña
     * nueva, y si no puede borrarlas el restablecimiento falla, en vez de
     * seguir con el intruso vivo. Antes lo hacía `onPasswordReset` a mano,
     * después de guardar, y se tragaba el error.
     *
     * Se puede borrar TODO sin dejar a nadie afuera de su propia cuenta: este
     * flujo no loguea después de restablecer, `/restablecer` manda a entrar
     * con la contraseña nueva.
     */
    revokeSessionsOnPasswordReset: true,

    /*
     * El mail sale por la casilla de la aseguradora de esa persona, después de
     * contestar (ver `advanced.backgroundTasks`).
     *
     * Nunca lanza y nunca registra el enlace: ver src/server/notify/password-reset.ts.
     */
    sendResetPassword: async ({ user, url }, request) => {
      const { sendPasswordResetEmail } = await import(
        "@/server/notify/password-reset"
      );
      await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        userId: user.id,
        url,
        duraMinutos: Math.round(RESET_DURA_SEGUNDOS / 60),
        request,
      });
    },

    /*
     * Lo que `revokeSessionsOnPasswordReset` no cubre: marcar el correo como
     * verificado y dejar asentado que la contraseña cambió por este camino,
     * que no es lo mismo que un cambio hecho por un admin cuando alguien
     * pregunta qué pasó con una cuenta. Vive en su propio módulo para poder
     * probarlo; corre después de que las sesiones ya se borraron.
     */
    onPasswordReset: async ({ user }) => {
      const { onPasswordReset } = await import("@/lib/auth/on-password-reset");
      await onPasswordReset(user);
    },
  },
  socialProviders:
    googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            prompt: "select_account",
          },
        }
      : {},
  account: {
    accountLinking: {
      // Users created via email/password must be able to "Continuar con Google"
      // with the same address: Google verifies the email, so linking the OAuth
      // account onto the existing user is safe. Without this, Better Auth
      // rejects the Google sign-in for an email that already has a credential
      // account instead of linking it.
      enabled: true,
      trustedProviders: ["google"],
    },
    /*
     * Los tokens de Google no los usa nadie: el proveedor existe para entrar con
     * «Continuar con Google» y nada más. Sin `accessType: "offline"` Google no
     * emite refresh tokens, y lo que sí guarda Better Auth (el access token
     * corto y el id token) va cifrado con el secreto de auth. Las filas ya
     * guardadas en texto plano se reescriben cifradas la próxima vez que esa
     * persona entra con Google.
     */
    encryptOAuthTokens: true,
  },
  user: {
    /*
     * Google es proveedor de confianza para enlazar, y Better Auth no mira
     * `email_verified` del perfil cuando confía. Sin la marca, no entra.
     */
    validateUserInfo({ source }) {
      if (source.oauth?.providerId !== "google") return;
      if (source.oauth.profile?.email_verified !== true) return { error: "email_no_verificado" };
    },
  },
  session: {
    /*
     * Sin esto Better Auth renueva la sesión en cada uso, y una sesión activa
     * —o una cookie robada— no vence nunca. Treinta días desde el ingreso es lo
     * que el resto del código ya da por hecho (ver `usuarios.ts`); pasado ese
     * momento la persona vuelve a entrar.
     */
    expiresIn: SESION_DURA_SEGUNDOS,
    disableSessionRefresh: true,

    /*
     * Caché de sesión en cookie firmada: evita un viaje a Neon en cada
     * `getSession`. El número es el techo de cuánto sobrevive una sesión que ya
     * se revocó, así que no es una preferencia de rendimiento.
     *
     * Estaba en 300 segundos. Desde que cambiar o restablecer la contraseña
     * cierra las otras sesiones —que es el gesto con el que alguien echa a
     * quien le entró— esos cinco minutos son cinco minutos en los que el
     * intruso sigue adentro después de que lo echaron.
     *
     * Sesenta segundos conservan casi todo el ahorro: una persona trabajando
     * hace muchos pedidos por minuto, así que el viaje a la base se sigue
     * pagando una vez por minuto y no una por pedido. Y acota la ventana a algo
     * que se le puede decir a la persona en la pantalla, que es lo que dice el
     * mensaje de Configuración.
     *
     * Bajarlo a cero sería lo más seguro y significa un viaje a Neon por
     * pedido, en todas las pantallas. Si alguna vez hace falta esa garantía, el
     * camino no es este número: es invalidar el caché al revocar.
     */
    cookieCache: { enabled: true, maxAge: 60 },
  },
  /*
   * El limitador propio de Better Auth cuenta en memoria, por instancia: en
   * serverless cada instancia lleva su cuenta y el techo no es uno. Lo que
   * gasta un secreto o manda un mail —entrar, pedir el enlace, usarlo— tiene
   * su techo en Postgres en `src/app/api/auth/[...all]/route.ts`, y acá se le
   * pide a la librería que no lo cuente dos veces. El resto de sus rutas sigue
   * con sus reglas por omisión, en memoria: llevarlas a Postgres sumaba una
   * escritura por cada pedido a `/api/auth/*`, con la ruta elegida por quien
   * llama.
   */
  rateLimit: {
    customRules: {
      "/sign-in/*": false,
      "/request-password-reset": false,
      "/reset-password": false,
    },
  },
  databaseHooks: {
    user: {
      create: {
        /*
         * La puerta del registro, y esta es la unica que hay.
         *
         * Va aca y no en el Server Action de `/registro` porque ese formulario
         * NO es el unico camino publico para crear una cuenta: la primera
         * entrada por Google tambien crea el usuario, sin pasar por ninguna
         * pantalla nuestra. Cerrar solo el formulario habria dejado la puerta
         * de al lado abierta — y esa es la que menos se mira.
         *
         * `caminoDeAlta` lanza si el alta no entra por ninguna puerta. Lanza
         * (422) y no devuelve `false`: con `autoSignIn: false`, un `false` o un
         * 403 en `signUpEmail` se vuelven un usuario de mentira con 200, y la
         * vuelta de Google se queda sin saber por que no hubo cuenta. Un 422
         * llega como error, y el callback manda a `/login?error=<codigo>`.
         *
         * Con «Exigir SSO» en el dominio tampoco se crea: el gancho de sesion
         * le negaria la sesion a la cuenta recien hecha y quedaria a medias.
         */
        before: async (user, context) => {
          await caminoDeAlta(typeof user.email === "string" ? user.email : "", context);
        },
        after: async (user) => {
          await provisionUserProfile(user);
        },
      },
    },
    session: {
      create: {
        /*
         * Toda sesión nueva pasa por acá, entre por contraseña, por Google o por
         * el SSO de una aseguradora. Es el único punto que ve a las tres: frenar
         * sólo el formulario de contraseña dejaría abierta la puerta de Google.
         *
         * «Exigir SSO» se aplica acá y no en cada ruta de ingreso. Ver
         * `src/server/sso/exigir.ts`, que además cuida que un ingreso por SSO
         * caiga en la aseguradora del `state` y en ninguna otra.
         */
        before: async (session, context) => {
          await revisarSesionNueva(session.userId, context?.path);
        },
      },
    },
  },
  /*
   * Sin el plugin `admin` de Better Auth, y esto es una decisión de seguridad.
   *
   * Montaba quince endpoints bajo `/api/auth/admin/*` —list-users, get-user,
   * set-role, ban-user, remove-user, set-user-password, revoke-user-sessions
   * y, sobre todo, impersonate-user— servidos por el catch-all de
   * `/api/auth/[...all]`. NINGUNO conoce el concepto de inquilino: `list-users`
   * devuelve el padrón de TODAS las aseguradoras, e `impersonate-user` emite
   * una sesión válida a nombre de cualquier usuario de cualquiera de ellas,
   * salteándose entera la capa `enTenant`/RLS que es la única pared del
   * producto.
   *
   * Y decidía el permiso contra `user.role` de la tabla de Better Auth, que es
   * OTRA columna distinta de `users.role`, la que usa toda la aplicación. Dos
   * modelos de rol en paralelo que nadie mantiene sincronizados: el día que
   * alguien los "alinee" para que dejen de discrepar, cada admin de aseguradora
   * pasa a ser admin global.
   *
   * La aplicación no llamaba a ninguno. La gestión de usuarios vive en
   * `/api/admin/users`, que sí está acotada al inquilino y audita lo que hace.
   * Quince puertas que no abría nadie y por las que se salía del edificio.
   *
   * Si algún día hace falta banear o suplantar, va por una ruta propia bajo
   * `/api/admin/`, con el inquilino en la mano y su fila de auditoría.
   *
   * `ssoInquilino` es nuestro, no el de Better Auth: ver `sso-inquilino.ts`.
   *
   * `nextCookies` va último para que `Set-Cookie` funcione desde los Server
   * Actions.
   */
  plugins: [ssoInquilino(), nextCookies()],
});

export type Auth = typeof auth;
