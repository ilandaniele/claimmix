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
 * Saca los comentarios RFC 5322 —`(...)`, anidados y con `\` de escape— de un
 * encabezado de dirección. Lo de adentro de unas comillas es nombre visible y
 * no abre comentarios. Un comentario sin cerrar se come hasta el final: no se
 * sabe dónde termina, y leer lo que sigue como dirección es lo que quiere quien
 * lo escribió.
 */
function sinComentarios(value: string): string {
  let salida = "";
  let anidados = 0;
  let citado = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (anidados > 0) {
      if (c === "\\") i++;
      else if (c === "(") anidados++;
      else if (c === ")" && --anidados === 0) salida += " ";
    } else if (citado) {
      salida += c;
      if (c === "\\") salida += value.charAt(++i);
      else citado = c !== '"';
    } else if (c === "(") {
      anidados = 1;
    } else {
      salida += c;
      citado = c === '"';
    }
  }
  return salida;
}

/**
 * La dirección que hay adentro de un encabezado.
 *
 * `Nombre <a@b.com>` → `a@b.com`. Sin ángulos, se devuelve lo que haya, sin
 * espacios. No pretende ser un parser de RFC 5322: alcanza con quedarse con lo
 * de adentro de los ángulos, que es donde todos los clientes ponen la
 * dirección. Lo que va entre comillas es nombre visible y no cuenta: en
 * `"<a@b.com>" <c@d.com>` la dirección es la segunda, no la del nombre. Los
 * comentarios tampoco: en `c@d.com (<a@b.com>)` la dirección es `c@d.com`. Es
 * lo que lee el servidor de correo al autenticar el From, y leer otra cosa
 * acá deja que un remitente se pegue a la dirección de otro. Unas comillas sin
 * cerrar se comen hasta el final, igual que un comentario.
 */
export function bareAddress(value: string | null | undefined): string {
  if (!value) return "";
  const limpio = sinComentarios(value);
  const sinComillas = limpio.replace(/"(?:[^"\\]|\\.)*(?:"|$)/g, " ");
  const angled = /<([^>]+)>/.exec(sinComillas);
  return (angled?.[1] ?? limpio).trim().toLowerCase();
}

/** `example.com`, `example.org`, `example.net` y cualquier subdominio suyo, sobre la dirección pelada. */
export const DOMINIO_RESERVADO = /@(?:[a-z0-9-]+\.)*example\.(com|org|net)$/;

/** ¿Es una dirección reservada, a la que no se le entrega nunca? */
export function isReservedTestAddress(value: string | null | undefined): boolean {
  const address = bareAddress(value);
  if (!address) return false;
  return DOMINIO_RESERVADO.test(address);
}

/** La dirección que nunca recibe avisos, en cualquier escritura de Gmail. */
export function vedadaParaAlertas(value: string | null | undefined): boolean {
  const a = bareAddress(value);
  const at = a.lastIndexOf("@");
  if (at < 1) return false;
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return false;
  const canonico = local.split("+")[0].replace(/\./g, "");
  // El dominio ya se validó arriba (gmail.com o su alias googlemail.com):
  // comparar sólo la parte local alcanza, y evita repetir la dirección
  // completa acá (scripts/check-personal-data.sh la marcaría).
  return canonico === "ilandaniele";
}
