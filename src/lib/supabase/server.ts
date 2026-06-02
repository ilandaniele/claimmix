/**
 * Supabase server client — for use in Server Components, Route Handlers,
 * and Server Actions.
 *
 * Creates a per-request client that reads/writes cookies via the Next.js
 * `cookies()` API (async in Next.js 15+/16).
 *
 * IMPORTANT: Always `await createServerClient()` — forgetting the await returns
 * a Promise and every `.from()` / `.auth.*` call on it throws at runtime.
 *
 * AC2: Server-side Supabase client available for Server Components + Route Handlers.
 */

import { createServerClient as createSupabaseServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/supabase/types";

/**
 * Create a Supabase client scoped to the current request's session.
 * Uses the user's auth cookies to build a JWT-authenticated client.
 * RLS policies are enforced automatically based on the authenticated user.
 *
 * @returns Supabase client authenticated as the current user.
 */
export async function createServerClient() {
  // cookies() is async in Next.js 15+ / 16 — must await.
  const cookieStore = await cookies();

  return createSupabaseServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2])
            );
          } catch {
            // cookies().set() is only allowed in Server Actions and Route Handlers.
            // In Server Components (RSC), reads are fine but writes silently fail here.
            // This is expected — the session is refreshed in proxy.ts before the RSC runs.
          }
        },
      },
    }
  );
}
