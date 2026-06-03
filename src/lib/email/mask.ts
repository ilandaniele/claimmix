/**
 * Email address masking helper.
 *
 * Masks an email address so only the first character of the local part
 * and the domain are visible. Examples:
 *   "gmail@claimmix.com"  → "g***@claimmix.com"
 *   "a@example.com"       → "a***@example.com"
 *   "hi@b.io"             → "h***@b.io"
 *
 * Returns null if the input is null or not a valid email shape.
 * NEVER logs the unmasked address.
 */

/**
 * Mask an email address: show first char of local part + *** + @ + domain.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;

  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0) return null; // no '@' or '@' is the first char

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex); // includes '@'

  if (local.length === 0) return null;

  // Always show exactly one char + '***' regardless of local part length.
  return `${local[0]}***${domain}`;
}
