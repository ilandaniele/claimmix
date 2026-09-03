import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { db } from "@/lib/db";
import { accounts, authUsers, sessions, verifications } from "@/lib/db/schema";

import { provisionUserProfile } from "./provision";
import { altaHabilitada } from "./registro-permitido";

function resolveBaseURL(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

/** Una hora. Ver el comentario en `resetPasswordTokenExpiresIn`. */
const RESET_DURA_SEGUNDOS = 60 * 60;

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
  },
  emailAndPassword: {
    enabled: true,
    // Parity with the previous Neon setup (admin.createUser email_confirm: true).
    requireEmailVerification: false,

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
     * El mail sale por la casilla de la aseguradora de esa persona.
     *
     * Nunca lanza y nunca registra el enlace: ver src/server/notify/password-reset.ts.
     */
    sendResetPassword: async ({ user, url }) => {
      const { sendPasswordResetEmail } = await import(
        "@/server/notify/password-reset"
      );
      await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        userId: user.id,
        url,
        duraMinutos: Math.round(RESET_DURA_SEGUNDOS / 60),
      });
    },

    /*
     * Que quede asentado que la contraseña cambió por este camino.
     *
     * Sin esto, en el registro no se distingue una recuperación de un cambio
     * hecho por un admin, y son cosas distintas cuando alguien pregunta qué
     * pasó con una cuenta.
     */
    /*
     * Cierra todas las sesiones abiertas y deja asentado el cambio.
     *
     * Vive en su propio módulo para poder probarlo: lo que hace —echar al que
     * hubiera entrado, anotar cuántas sesiones cerró, no romperse si algo de
     * eso falla— es exactamente lo que hay que poder ejercer.
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
            accessType: "offline",
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
  },
  session: {
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
         * Devolver `false` aborta la creacion. La pantalla de registro ademas
         * comprueba antes, para poder decir algo entendible en vez del error
         * generico que sale de aca.
         */
        before: async (user) => {
          const email = typeof user.email === "string" ? user.email : "";
          if (altaHabilitada(email)) return;
          console.warn(
            JSON.stringify({
              level: "warn",
              service: "claimmix",
              msg: "auth.registro.rechazado",
              dominio: email.slice(email.lastIndexOf("@") + 1) || "(sin dominio)",
              motivo: "fuera_de_signup_allowed_emails",
            })
          );
          return false;
        },
        after: async (user) => {
          await provisionUserProfile(user);
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
   * `nextCookies` va último para que `Set-Cookie` funcione desde los Server
   * Actions.
   */
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
