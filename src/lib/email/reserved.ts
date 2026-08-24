/**
 * Las direcciones a las que este sistema le escribe de mentira.
 *
 * Los asegurados inventados usan dominios `example.*`, reservados por la IANA
 * justamente para esto: no existen, no le pertenecen a nadie y nunca van a
 * pertenecerle. El despachador se niega a entregarles de verdad, compone la
 * respuesta igual y la guarda como `skipped_simulated`, así que una simulación
 * ejercita el flujo entero sin que salga un mail.
 *
 * La comparación tiene que hacerse sobre la dirección y no sobre el encabezado.
 * Estaba escrita como `/@example\.(com|org|net)$/` contra el campo `to` crudo, y
 * eso funciona mientras la dirección venga pelada — que es como la manda el
 * ensayo, y no como la manda un cliente de correo. Un `From` real trae nombre
 * visible:
 *
 *     Asegurado de prueba <timbre.123@example.com>
 *
 * Esa cadena termina en `>`, la expresión no coincidía, y el mail salía. Lo
 * encontró `pnpm knock` en su primera corrida, depositando en la casilla un
 * mensaje con la forma que tiene un mail de verdad — que es exactamente lo que
 * ninguna prueba anterior hacía.
 */

/**
 * La dirección que hay adentro de un encabezado.
 *
 * `Nombre <a@b.com>` → `a@b.com`. Sin ángulos, se devuelve lo que haya, sin
 * espacios. No pretende ser un parser de RFC 5322: alcanza con quedarse con lo
 * de adentro de los ángulos, que es donde todos los clientes ponen la
 * dirección.
 */
export function bareAddress(value: string | null | undefined): string {
  if (!value) return "";
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim().toLowerCase();
}

/**
 * ¿Es una dirección reservada, a la que no se le entrega nunca?
 *
 * `example.com`, `example.org`, `example.net` y cualquier subdominio suyo.
 */
export function isReservedTestAddress(value: string | null | undefined): boolean {
  const address = bareAddress(value);
  if (!address) return false;
  return /@(?:[a-z0-9-]+\.)*example\.(com|org|net)$/.test(address);
}
