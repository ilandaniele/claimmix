/**
 * Dos cosas que el ensayo `goteo` mira en cada respuesta, sobre el texto
 * legible y en minúsculas.
 *
 * El 23/09 a «Fue un choque, ayer a la tarde» se le contestó «¿Fue a la tarde,
 * correcto?», y en la vuelta siguiente esa pregunta desapareció sin respuesta
 * y apareció «Más o menos a qué hora fue.». Pasaba todas las afirmaciones.
 *
 * `confirmaLoDicho` marca una confirmación que no trae nada más que lo que la
 * persona acaba de escribir sobre lo que se le pidió. `formaDePedirLaHora` dice
 * cómo se pidió la hora, para ver que sea siempre de la misma forma.
 */

// Sin acentos ni signos, y un número partido con puntos, guiones o dos puntos es
// uno solo. Es el mismo criterio que `src/core/mensajes/lo-dicho.ts`.
function plano(texto) {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/(\d)[.:\- ](?=\d)/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Las etiquetas y las palabras de la pregunta, que no son el valor.
const VACIAS = new Set([
  "nombre", "completo", "apellido", "numero", "poliza", "fecha", "hora", "lugar", "tipo",
  "siniestro", "accidente", "entonces", "entendimos", "entendemos", "entendi", "correcto",
  "confirmas", "confirmame", "confirmar", "llamas", "cual", "esto", "este", "esta", "para", "como",
  "donde", "cuando", "pero", "gracias", "hola", "queda", "tenemos", "dato", "datos", "seria",
  "verdad", "menos", "aproximada", "aproximadamente", "paso", "sucedio", "ocurrio",
  "name", "full", "your", "policy", "number", "date", "time", "place", "type", "claim", "accident",
  "that", "this", "correct", "right", "understood", "understand", "confirm", "just", "want",
  "make", "sure", "with", "what", "when", "where", "which", "have", "thanks", "thank", "hello",
  "about", "approximate", "approximately", "roughly", "happened", "then",
]);

// «Confirmame que…» confirma un valor; «¿me confirmás a qué hora fue?» pide uno.
const CONFIRMA = /\b(?:correcto|es asi|verdad|correct|right)\b|\bconfirm(?:as|ame|ar|a)?\s+(?:que|si|that|if)\b/;
// «Entendimos que fue a la tarde. ¿Correcto?»: la pregunta es la oración de antes.
const SOLO_CONFIRMA = /^(?:es |is that )?(?:correcto|asi|verdad|correct|right)$/;

/** Lo que la persona podría haber escrito: sin etiquetas ni palabras de relleno. */
function contenido(texto) {
  return plano(texto)
    .split(" ")
    .filter((p) => (/^\d+$/.test(p) ? p.length >= 3 : p.length >= 4) && !VACIAS.has(p));
}

/** Las preguntas de confirmación, y el valor de cada «entendimos "X"». */
function confirmaciones(texto) {
  const oraciones = [];
  for (const o of texto.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)) {
    if (oraciones.length > 0 && SOLO_CONFIRMA.test(plano(o))) {
      oraciones[oraciones.length - 1] += ` ${o}`;
    } else {
      oraciones.push(o);
    }
  }
  const preguntas = oraciones.filter((o) => o.includes("?") && CONFIRMA.test(plano(o)));
  // Los pisos: «• Hora aproximada: entendimos "tarde"».
  const pisos = [...texto.matchAll(/(?:entendimos|understood)\s*[«"“]([^»"”\n]+)[»"”]/g)];
  return [...preguntas, ...pisos.map((m) => m[1])];
}

/**
 * La confirmación que devuelve lo que la persona acaba de escribir, o null.
 *
 * `pedidos` son los valores que tenemos de lo que se le pidió en la vuelta
 * anterior, y sólo esos cuentan, como en el orquestador (`dichoRecien`): de un
 * valor que no se pidió la duda es de qué campo es, y un número suelto puede
 * ser el DNI, la póliza o el teléfono. Confirmarlos no es eco.
 */
export function confirmaLoDicho(texto, say, pedidos) {
  const dicho = new Set(plano(say).split(" "));
  const valores = pedidos
    .filter((v) => !/^[\d\s.\-]+$/.test(v))
    .map(contenido)
    .filter((v) => v.length > 0);
  return (
    confirmaciones(texto).find((c) => {
      const palabras = contenido(c);
      return (
        palabras.length > 0 &&
        palabras.every((p) => dicho.has(p)) &&
        valores.some((v) => v.every((p) => palabras.includes(p)))
      );
    }) ?? null
  );
}

const FRANJA = /\b(?:manana|tarde|noche|madrugada|morning|afternoon|evening|night)\b/;

/**
 * Cómo se pidió la hora en esta respuesta: `confirma-franja` («¿fue a la
 * tarde, correcto?») o `pide-hora` («más o menos a qué hora fue»). Pedirla y
 * aclarar que alcanza con una aproximada es una sola forma; un resumen con
 * «Hora aproximada: tarde» no la pide.
 */
export function formaDePedirLaHora(texto) {
  const formas = new Set();
  if (confirmaciones(texto).some((c) => FRANJA.test(plano(c)))) formas.add("confirma-franja");
  if (/\b(?:que hora|what time|hora exacta|exact time)\b/.test(plano(texto))) formas.add("pide-hora");
  return formas;
}
