/**
 * The Content-Security-Policy, finally attached to something.
 *
 * `src/lib/security/csp.ts` has built a strict policy since the beginning, and
 * `app/layout.tsx` reads a nonce "injected by proxy.ts" — from a proxy.ts that
 * did not exist. So the nonce was always undefined and no CSP header ever left
 * the building. Checked against production: five security headers present, this
 * one absent. It is the only defence against cross-site scripting in a product
 * whose pages display text that arrived by email from strangers.
 *
 * This is `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention, and
 * a file called middleware.ts here would simply never run.
 *
 * The policy goes on the REQUEST headers as well as the response, and that is
 * not redundant. Next reads it off the request to discover the nonce and stamp
 * it onto its own inline bootstrap scripts. Set it only on the response and
 * every page breaks: the policy forbids inline scripts, and Next's own are
 * inline and unnonced.
 */

import { NextResponse, type NextRequest } from "next/server";

import { buildCsp, generateNonce } from "@/lib/security/csp";

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-csp-nonce", nonce);
  // Read by Next to nonce its own inline scripts. Without this, strict CSP
  // blocks the framework's bootstrap and the page renders blank.
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set("Content-Security-Policy", csp);
  // The layout reads the nonce from here to pass to any <Script> of ours.
  response.headers.set("x-csp-nonce", nonce);

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything a browser renders, and nothing else.
     *
     * API routes are excluded because a CSP governs how a document may load
     * resources, and a JSON response is not a document — adding the header
     * there costs a nonce per request and protects nothing.
     *
     * Static assets and image optimisation are excluded for the same reason,
     * and prefetches because Next fires them constantly and each one would
     * generate a nonce that is never used.
     */
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
