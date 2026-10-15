/**
 * ¿La persona nos dio otra póliza a mitad de la charla?
 *
 * Salió de un ensayo: daba `POL-4471-A` en el primer mensaje y después escribía
 * «póliza 4455». El agente lo tomaba sin decir nada, y el caso quedaba con un
 * número que la persona quizá no quería. Hay que preguntar cuál es, sin repetir
 * ninguno de los dos, y resolver con lo que conteste.
 *
 * Acá afuera porque la comparación es lo delicado: «4471» y «POL-4471-A» son la
 * misma póliza dicha a medias, y «4455» no es «2914455123», que es un celular.
 */

/** Sin tildes ni separadores y en mayúsculas: «pol 4471-a» es `POL4471A`. */
function compacta(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

/** Un valor que pueda ser un número de póliza: cuatro o más caracteres y algún dígito. */
function usable(s: string | null | undefined): s is string {
  if (!s) return false;
  const c = compacta(s);
  return c.length >= 4 && /\d/.test(c);
}

/**
 * Igual, o uno es sólo los dígitos del otro.
 *
 * Con cuatro dígitos como mínimo: menos que eso coincide con cualquier cosa.
 * Y tienen que ser TODOS los dígitos del más largo, no un pedazo.
 */
function mismaPoliza(a: string, b: string): boolean {
  const A = compacta(a);
  const B = compacta(b);
  if (A === B) return true;

  const [corto, largo] = A.length <= B.length ? [A, B] : [B, A];
  return /^\d{4,}$/.test(corto) && corto === largo.replace(/\D/g, "");
}

export function polizaCambiada(anterior?: string | null, nueva?: string | null): boolean {
  return usable(anterior) && usable(nueva) && !mismaPoliza(anterior, nueva);
}

function palabras(texto: string): string[] {
  return texto.split(/[\s,;:()«»"'¿?¡!]+/);
}

/** ¿El texto dice este número? Palabra por palabra: un celular no contiene la póliza. */
export function nombraLaPoliza(texto: string | null | undefined, numero: string): boolean {
  if (!texto) return false;

  return palabras(texto).some(
    (token) => /\d/.test(token) && compacta(token).length >= 4 && mismaPoliza(token, numero)
  );
}

/** Lo que puede ir entre «póliza» y el número sin cambiar de tema. */
const ENTRE_POLIZA_Y_NUMERO = new Set(["ES", "LA", "EL", "MI", "DE", "NRO", "N", "NUM", "NUMERO"]);

/**
 * Los números que el texto da como póliza: «póliza 4455», «nro de póliza: 4455».
 *
 * El extractor relee toda la conversación y puede quedarse con la primera
 * póliza aunque el mensaje de ahora diga otra. Esto mira sólo el texto. Corta
 * en la primera palabra que no sea de relleno: «póliza no es 4455» y «póliza y
 * mi celular 2914455123» no dan ningún número.
 */
export function polizasNombradas(texto: string | null | undefined): string[] {
  if (!texto) return [];

  const tokens = palabras(texto);
  return tokens.flatMap((token, i) => {
    if (compacta(token) !== "POLIZA") return [];
    for (const siguiente of tokens.slice(i + 1, i + 5)) {
      if (usable(siguiente)) return [siguiente.replace(/\.+$/, "")];
      if (!ENTRE_POLIZA_Y_NUMERO.has(compacta(siguiente))) return [];
    }
    return [];
  });
}

/**
 * Cuál de las dos eligió la persona, o `null` si no se puede saber.
 *
 * @param leida  Lo que el extractor leyó de la respuesta. Es lo que entiende la
 *               negación: «no es la 4455» nombra la nueva y no la elige.
 */
export function polizaElegida(
  texto: string | null | undefined,
  anterior: string,
  nueva: string,
  leida?: string | null
): "anterior" | "nueva" | null {
  const candidatas = [
    ["anterior", anterior],
    ["nueva", nueva]
  ] as const;
  const nombradas = candidatas.filter(([, numero]) => nombraLaPoliza(texto, numero));

  if (usable(leida)) {
    const coinciden = candidatas.filter(([, numero]) => mismaPoliza(leida, numero));
    const unica = coinciden.length === 1 ? coinciden[0] : null;
    return unica && nombradas.includes(unica) ? unica[0] : null;
  }

  // Sin lectura, sólo si nombró una de las dos y no la otra.
  return nombradas.length === 1 ? nombradas[0]![0] : null;
}
