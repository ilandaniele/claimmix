/**
 * Supabase browser client — for use in Client Components only.
 *
 * Uses createBrowserClient from @supabase/ssr which reads/writes cookies
 * automatically via the browser's document.cookie API.
 *
 * A singleton is created so multiple Client Components share the same instance
 * and avoid re-authenticating on each render.
 *
 * AC2: NEXT_PUBLIC_SUPABASE_URL must pass URL validation on startup.
 * Validation happens at the module level so the app fails fast if the var is
 * missing or malformed before any Supabase call is made.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Fail fast at module load time if env vars are missing.
// This runs in the browser bundle — NEXT_PUBLIC_* vars are inlined by the
// Next.js compiler, so they are always present when set at build time.
if (!supabaseUrl) {
  throw new Error(
    "[ClaimMix] NEXT_PUBLIC_SUPABASE_URL is not set. " +
      "Set it in .env.local (development) or Vercel env vars (production)."
  );
}

if (!supabaseAnonKey) {
  throw new Error(
    "[ClaimMix] NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. " +
      "Set it in .env.local (development) or Vercel env vars (production)."
  );
}

// Validate URL format (fails if placeholder or malformed value is set).
try {
  new URL(supabaseUrl);
} catch {
  throw new Error(
    `[ClaimMix] NEXT_PUBLIC_SUPABASE_URL is not a valid URL: "${supabaseUrl}". ` +
      "Expected format: https://<project-ref>.supabase.co"
  );
}

/**
 * Singleton browser Supabase client.
 * Import and use this in 'use client' components.
 *
 * @example
 * import { supabaseBrowser } from '@/lib/supabase/browser';
 * const { data } = await supabaseBrowser.auth.getUser();
 */
export const supabaseBrowser = createBrowserClient<Database>(
  supabaseUrl,
  supabaseAnonKey
);
