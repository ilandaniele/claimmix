/**
 * Constant-time string comparison for secrets (webhook bearers, verify tokens).
 *
 * String `===` short-circuits on the first differing byte, which leaks secret
 * prefixes through response-timing differences. `crypto.timingSafeEqual`
 * requires equal-length buffers, so we hash both sides first — this also makes
 * the comparison length-independent (no early return on length mismatch).
 */

import { createHash, timingSafeEqual } from "crypto";

export function timingSafeStringEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
