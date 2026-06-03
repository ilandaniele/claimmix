/**
 * EmailProvider factory for ClaimMix — Gmail provider.
 *
 * Callers use getEmailProvider() — do not import GmailSender directly from outside
 * src/server/email/gmail/.
 *
 * Supports DI for tests via setEmailProvider() / resetEmailProvider().
 *
 * W2 (GmailSender): getEmailProvider() now lazy-inits GmailSender when no provider
 * has been injected via setEmailProvider(). This reads GMAIL_* env vars on first call.
 *
 * AC9:  This factory returns a provider with name='gmail'.
 * AC12: dispatch.ts imports only from here — no direct googleapis imports outside gmail/.
 */

import "server-only";
import type { EmailProvider } from "../provider";
import { GmailSender } from "./gmail-sender";

let _provider: EmailProvider | null = null;

/**
 * Returns the configured EmailProvider singleton.
 *
 * On first call (when no provider has been set via setEmailProvider()), lazy-inits
 * GmailSender which reads GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 * from the environment. Throws if any of those vars are missing.
 */
export function getEmailProvider(): EmailProvider {
  if (!_provider) {
    _provider = new GmailSender();
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
