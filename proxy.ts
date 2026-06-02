/**
 * proxy.ts — Next.js middleware for ClaimMix.
 *
 * Responsibilities:
 * 1. Generate a per-request CSP nonce (strict, no unsafe-inline on script-src).
 * 2. Inject the Content-Security-Policy header on every response.
 * 3. Refresh the Supabase Auth session (updateSession) so Server Components
 *    and Route Handlers see a valid JWT without round-tripping to the client.
 * 4. Protect routes — unauthenticated requests to /bandeja/** and /api/**
 *    (except public endpoints) are redirected or returned 401.
 *
 * NOTE: This file is named proxy.ts (not middleware.ts) per the Next.js 16 +
 * Supabase SSR pattern documented in answers.md.
 * Next.js discovers the middleware by the export name, not the filename —
 * BOTH filenames work. Using proxy.ts is the team convention for this project.
 *
 * AC16: strict nonce-based CSP, HSTS, Permissions-Policy, nosniff, referrer-policy.
 * The non-CSP security headers are also set in next.config.ts headers() for
 * defense-in-depth (Vercel CDN layer picks those up even before middleware runs).
 */

import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { buildCsp, generateNonce } from "@/lib/security/csp";

/** Public paths that do not require authentication. */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth/callback",
  "/api/admin/health",
  "/_next",
  "/favicon.ico",
];

/** API paths that require authentication but are not browser-navigable. */
const PROTECTED_API_PREFIX = "/api/";

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Refresh the Supabase Auth session cookie and update it in the response.
 * Returns the authenticated user (or null if session is missing/expired).
 */
async function refreshSession(
  request: NextRequest,
  response: NextResponse
): Promise<{ user: { id: string } | null; response: NextResponse }> {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) => {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          // Rebuild response so set-cookie headers are forwarded to the browser.
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2])
          );
        },
      },
    }
  );

  // getUser() revalidates the JWT with Supabase Auth API — safe for server-side.
  // Never use getSession() here: it trusts the client cookie without server validation.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { user, response };
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── 1. Generate per-request CSP nonce ──────────────────────────────────────
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // ── 2. Start with a pass-through response ──────────────────────────────────
  let response = NextResponse.next({ request });

  // ── 3. Inject CSP + security headers ──────────────────────────────────────
  response.headers.set("Content-Security-Policy", csp);
  // Pass nonce to Server Components via request header so layout.tsx can read it.
  response.headers.set("x-csp-nonce", nonce);

  // The following headers are also set in next.config.ts headers() for CDN-layer
  // defense-in-depth. Setting them here too ensures they appear on all responses
  // including API routes and redirects that bypass the CDN cache.
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  response.headers.set(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  // ── 4. Skip auth for public paths ─────────────────────────────────────────
  if (isPublic(pathname)) {
    return response;
  }

  // ── 5. Refresh Supabase session ───────────────────────────────────────────
  const { user, response: updatedResponse } = await refreshSession(
    request,
    response
  );
  response = updatedResponse;

  // Re-apply security headers after response rebuild (refreshSession may recreate it).
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-csp-nonce", nonce);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload"
  );
  response.headers.set(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  // ── 6. Enforce authentication ─────────────────────────────────────────────
  if (!user) {
    // API routes get a 401 JSON response.
    if (pathname.startsWith(PROTECTED_API_PREFIX)) {
      return new NextResponse(
        JSON.stringify({
          error: {
            code: "MISSING_SESSION",
            message: "Se requiere autenticación.",
          },
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Content-Security-Policy": csp,
            "X-Content-Type-Options": "nosniff",
          },
        }
      );
    }

    // Browser routes redirect to /login.
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    const redirectResponse = NextResponse.redirect(loginUrl);
    redirectResponse.headers.set("Content-Security-Policy", csp);
    redirectResponse.headers.set("X-Content-Type-Options", "nosniff");
    redirectResponse.headers.set("X-Frame-Options", "DENY");
    redirectResponse.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
    return redirectResponse;
  }

  // ── 7. Redirect authenticated users away from login ───────────────────────
  if (pathname === "/login" || pathname === "/") {
    return NextResponse.redirect(new URL("/bandeja", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static  (static assets — JS, CSS)
     * - _next/image   (image optimization)
     * - favicon.ico
     * - Static image/font extensions
     */
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)",
  ],
};
