/**
 * Supabase service-role client — for server-side privileged operations only.
 *
 * WARNING: This client bypasses Row Level Security (RLS).
 * Use ONLY in:
 *   - AI extraction worker (writes extracted_fields, audit_log as system actor)
 *   - Admin-only routes (POST /api/admin/users)
 *   - Background jobs
 *
 * NEVER:
 *   - Export or import this in Client Components or client-side bundles.
 *   - Use it for user-facing data reads — use createServerClient() instead.
 *   - Pass the service role key to the frontend or include in NEXT_PUBLIC_* vars.
 *
 * The 'server-only' import prevents this module from being bundled in client JS.
 * Any attempt to import it in a Client Component throws a build-time error.
 *
 * AC2: service-role client only instantiable server-side.
 */

import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceRoleKey) {
  // Log at module load time so the misconfiguration is obvious in server logs.
  // Do not throw here — some environments (CI build without prod secrets) may
  // legitimately not have the service role key. Routes that use this client
  // will fail with a clear error when they try to call Supabase.
  console.warn(
    "[ClaimMix] SUPABASE_SERVICE_ROLE_KEY is not set. " +
      "The service-role client will not be able to make authenticated requests. " +
      "Set this in Vercel env vars (server-only, never NEXT_PUBLIC_*)."
  );
}

/**
 * Supabase admin client with the service role key.
 * Bypasses RLS — use with extreme care.
 *
 * Creating a fresh instance per usage (rather than a module-level singleton)
 * ensures the client always uses the current env var value (useful in tests
 * where env vars may be overridden between test cases).
 */
export function createServiceClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        // Service role clients should not persist sessions or auto-refresh.
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
