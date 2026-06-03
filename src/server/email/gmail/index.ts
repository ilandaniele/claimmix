/**
 * EmailProvider factory for ClaimMix — Gmail provider.
 *
 * Mirrors the same factory pattern as src/server/email/postmark/index.ts.
 * Callers use getEmailProvider() — do not import GmailSender directly from outside
 * src/server/email/gmail/.
 *
 * Supports DI for tests via setEmailProvider() / resetEmailProvider().
 *
 * W1 (interface widening): Factory only. Actual GmailSender lazy-init (reading
 * GMAIL_* env vars) is added in W2 when GmailSender is implemented.
 * Until then, getEmailProvider() throws if no provider has been injected via
 * setEmailProvider() — safe because dispatch.ts is not exercised until W2+W5.
 *
 * AC9:  This factory supports name='gmail' once GmailSender is registered.
 * AC12: dispatch.ts imports only from here — no direct googleapis imports outside gmail/.
 */

import "server-only";
import type { EmailProvider } from "../provider";

let _provider: EmailProvider | null = null;

/**
 * Returns the configured EmailProvider singleton.
 *
 * Throws if no provider has been set via setEmailProvider().
 * GmailSender auto-init (reading GMAIL_* env vars) will be wired here in W2.
 */
export function getEmailProvider(): EmailProvider {
  if (!_provider) {
    throw new Error(
      "EmailProvider not initialized — call setEmailProvider() first or check GMAIL_* env vars"
    );
  }
  return _provider;
}

/**
 * Override the provider — for unit tests that inject a mock.
 */
export function setEmailProvider(p: EmailProvider): void {
  _provider = p;
}

/**
 * Reset the provider singleton — call in afterEach/afterAll in tests.
 */
export function resetEmailProvider(): void {
  _provider = null;
}
