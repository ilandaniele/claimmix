"use client";

import { createAuthClient } from "better-auth/react";

/*
 * Sin `adminClient()`: sólo agregaba los tipos de `/api/auth/admin/*`, que el
 * servidor ya no monta a propósito. Ver `src/lib/auth/index.ts`.
 */
export const authClient = createAuthClient();
