/**
 * El nombre que el canal ya entrega, cuando es el nombre de una persona.
 *
 * Los dos canales lo traen y los dos lo tiraban: por mail el `From` dice
 * `Ilan Daniele <ilan.daniele@gmail.com>` y se guardaba entero sin mirarlo; por
 * WhatsApp el `profile.name` se parsea en `cloud-api` y muere en `ingest`. Un
 * caso real recibió un mail que le pedía «Nombre completo» teniendo el nombre en
 * el sobre.
 *
 * El juicio vive una sola vez porque lo usan los dos canales. Escrito dos veces
 * —una por canal— es el defecto que ya documenta `mensajes/respuesta-pendiente`:
 * así se llega a dos productos con la misma cara.
 *
 * Lo que NO es: un nombre visible lo configura quien escribe y no lo verifica
 * nadie. Sirve para saludar y para no volver a preguntar; no para darlo por
 * cierto. Un nombre basura aceptado es peor que ninguno —saluda mal, entra al
 * prompt del redactor y puede inventar un conflicto contra el padrón—, así que
 * ante la duda se descarta.
 */

/** Marcas de equipo: lo que un teléfono se pone a sí mismo de nombre. */
const APARATO = /\b(iphone|ipad|galaxy|samsung|xiaomi|motorola|android|celu(?:lar)?)\b/i;

/**
 * Razón social o buzón funcional: escribe una empresa, no una persona.
 *
 * El corte de la derecha es `(?!\w)` y no `\b`: una razón social termina en
 * punto —«Transportes del Sur S.R.L.»— y ahí `\b` no encuentra borde, así que
 * la abreviatura se escapaba justo en la forma en que se escribe de verdad.
 */
const NO_ES_UNA_PERSONA =
  /(?<!\w)(s\.?a\.?s?|s\.?r\.?l\.?|srl|ltda|ltd|inc|seguros|aseguradora|transportes|estudio|grupo|soporte|ventas|contacto|info|admin|no.?reply|noreply|notificaciones|newsletter|mailer|daemon)(?!\w)/i;

/** Un domicilio no es un nombre, por más que venga en el lugar del nombre. */
const DOMICILIO = /(?<!\w)(av\.?|avda\.?|calle|ruta|km|piso|depto\.?|dpto\.?)(?!\w)/i;

/** Lo que escribe una prueba, no un asegurado: `pnpm knock` manda uno de éstos. */
const ROL = /\b(asegurado|cliente|titular|usuario|prueba|test|demo|productor)\b/i;

/**
 * El nombre visible de un encabezado `From`, o null si no hay ninguno.
 *
 * Espejo de `bareAddress`: lo que va ANTES de los ángulos, sin comillas. Un
 * sobre sin nombre —la dirección pelada, como la mandaba el ensayo— no tiene
 * nombre visible y devuelve null, no la dirección.
 */
export function nombreVisibleDelSobre(from?: string | null): string | null {
  const crudo = from?.trim();
  if (!crudo) return null;

  const angulos = crudo.indexOf("<");
  if (angulos < 0) return null;

  const visible = crudo.slice(0, angulos).trim().replace(/^["']|["']$/g, "").trim();
  if (!visible) return null;

  // El mismo texto de la dirección puesto de nombre no agrega nada.
  const direccion = /<([^>]*)>/.exec(crudo)?.[1]?.trim().toLowerCase() ?? "";
  const parteIzquierda = direccion.split("@")[0] ?? "";
  const plano = visible.toLowerCase();
  if (plano === direccion || plano === parteIzquierda) return null;

  return visible;
}

/**
 * El nombre visible, si es el nombre de una persona.
 *
 * Las reglas de descarte tienen la misma forma que las de `phoneFromSender`:
 * antes de guardar un dato como si fuera de alguien, comprobar que tenga la
 * forma de ese dato.
 */
export function nombreDePersona(visible?: string | null): string | null {
  const texto = visible?.trim().replace(/\s+/g, " ");
  if (!texto) return null;

  // Una dirección, un teléfono o un domicilio con altura: todos traen algo que
  // un nombre no tiene.
  if (texto.includes("@") || /\d/.test(texto)) return null;

  const palabras = texto.split(" ").filter(Boolean);
  // Un solo token es un alias («soporte», «ilan»); más de cuatro ya no es un
  // nombre sino una frase.
  if (palabras.length < 2 || palabras.length > 4) return null;

  if (APARATO.test(texto)) return null;
  if (NO_ES_UNA_PERSONA.test(texto)) return null;
  if (DOMICILIO.test(texto)) return null;
  if (ROL.test(texto)) return null;

  // Que sean letras: un nombre no lleva signos de puntuación más allá del
  // apóstrofo y el guion de los apellidos compuestos.
  if (!/^[\p{L}][\p{L}\s.'’-]*$/u.test(texto)) return null;

  return texto;
}
