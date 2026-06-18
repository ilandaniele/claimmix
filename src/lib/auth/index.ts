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
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      prompt: "select_account",
      accessType: "offline",
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
