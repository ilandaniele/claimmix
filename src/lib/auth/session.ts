import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { auth } from "./index";

/**
 * Memoized per-request session lookup (React cache). Returns null when there
 * is no valid session. This is the single replacement for the ~25 former
 * supabase.auth.getUser() call sites.
 */
export const getSessionContext = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export type SessionContext = Awaited<ReturnType<typeof getSessionContext>>;
