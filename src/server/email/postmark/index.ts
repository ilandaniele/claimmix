/**
 * EmailProvider factory for ClaimMix.
 *
 * Provides a singleton instance of the EmailProvider (PostmarkSender by default).
 * Callers use getEmailProvider() — do not import PostmarkSender directly from outside
 * src/server/email/postmark/.
 *
 * Supports DI for tests via setEmailProvider() / resetEmailProvider().
 *
 * IC8: Factory reads EMAIL_PROVIDER env var (default: 'postmark').
 * AC12: Provider isolation — dispatch.ts and confirmations/orchestrate.ts import
 *       only from this file, never from 'postmark' or 'resend' directly.
 */

import "server-only";
import { PostmarkSender } from "./postmark-sender";
import type { EmailProvider } from "../provider";

let _provider: EmailProvider | null = null;

/**
 * Returns the configured EmailProvider singleton.
 *
 * Currently always returns a PostmarkSender (EMAIL_PROVIDER=postmark is the only
 * supported value). Future providers can be added by extending the switch below.
 */
export function getEmailProvider(): EmailProvider {
  if (!_provider) {
    _provider = new PostmarkSender();
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
