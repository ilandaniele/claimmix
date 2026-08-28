import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";

import { db } from "@/lib/db";
import { accounts, authUsers, sessions, verifications } from "@/lib/db/schema";

import { provisionUserProfile } from "./provision";

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
    onPasswordReset: async ({ user }) => {
      const { writeAuditLog, AuditEvent } = await import("@/lib/audit/log");
      const { db } = await import("@/lib/db");
      const { users } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      try {
        // sin-inquilino: se AVERIGUA de quién es la cuenta, igual que en el login.
        const [perfil] = await db
          .select({ tenant_id: users.tenant_id })
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1);
        if (!perfil) return;
        await writeAuditLog({
          tenant_id: perfil.tenant_id,
          actor_id: user.id,
          event_type: AuditEvent.PASSWORD_RESET_COMPLETED,
          target_type: "user",
          target_id: user.id,
          payload: {},
        });
      } catch {
        // Que no se pueda anotar no puede impedirle a alguien volver a entrar.
      }
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
    // Signed cookie cache: avoids a Neon round-trip on every getSession call.
    cookieCache: { enabled: true, maxAge: 300 },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await provisionUserProfile(user);
        },
      },
    },
  },
  // nextCookies must stay last so Set-Cookie works from Server Actions.
  plugins: [admin({ adminRoles: ["admin"] }), nextCookies()],
});

export type Auth = typeof auth;
