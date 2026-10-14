/**
 * Las direcciones que operan el producto (`ADMIN_EMAILS`), normalizadas.
 *
 * Vive aparte de `require-operator.ts` porque ese archivo arrastra la sesión
 * (`next/headers`) y quien sólo necesita saber a quién avisar —el envío de
 * WhatsApp, el flujo durable del intake— no puede cargarla.
 */
export function operatorEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
