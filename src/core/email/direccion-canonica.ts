/**
 * La dirección como se cuenta, no como se escribe.
 *
 * `ana+1@x.com` y `ana+2@x.com` son la misma bandeja, y en Gmail también lo son
 * una casilla con y sin puntos, o con `googlemail.com` en vez de `gmail.com`.
 * Todo tope por destinatario (el correo del sistema, el formulario web) tiene
 * que contar sobre esto y no sobre lo escrito: si no, cada alias estrena su
 * propio cupo.
 */

/** Gmail entrega estos dominios en la misma bandeja, con o sin puntos en la parte local. */
const DOMINIOS_DE_GMAIL: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

/**
 * Sin espacios, en minúsculas y sin el `+etiqueta`. En Gmail también sin los
 * puntos, y `googlemail.com` es `gmail.com`. No valida que sea una dirección:
 * eso lo hace quien llama. Null si no queda parte local.
 */
export function direccionCanonica(correo: string): string | null {
  const limpio = correo.trim().toLowerCase();
  const arroba = limpio.lastIndexOf("@");
  if (arroba < 1) return null;
  const dominio = limpio.slice(arroba + 1);
  const deGmail = DOMINIOS_DE_GMAIL.has(dominio);
  const etiquetada = limpio.slice(0, arroba).split("+")[0];
  const local = deGmail ? etiquetada.replaceAll(".", "") : etiquetada;
  return local ? `${local}@${deGmail ? "gmail.com" : dominio}` : null;
}
