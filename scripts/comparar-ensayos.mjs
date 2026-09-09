/**
 * `node scripts/comparar-ensayos.mjs a.json b.json` — qué falló las dos veces.
 *
 * El ensayo corre contra un modelo, no contra una función: la misma
 * conversación puede terminar distinto. El post-deploy ya reintentaba por eso,
 * y el comentario que lo justifica dice exactamente lo correcto —«una regresión
 * falla siempre, una variación casi nunca falla dos veces»— pero la
 * implementación pedía otra cosa: que la SEGUNDA corrida saliera limpia entera.
 *
 * Y eso, con medio centenar de afirmaciones que dependen del modelo, es una
 * apuesta perdida. Cada corrida tiene su propia chance de que alguna difiera;
 * exigir cero en la segunda no confirma la primera, sólo tira otro dado. El
 * resultado eran corridas rojas por diferencias distintas cada vez, que es la
 * peor forma de rojo: la que enseña a no mirar.
 *
 * Esto hace lo que decía el comentario. Intersecta las dos listas y falla sólo
 * con lo que apareció en las dos.
 *
 * Lo que difirió una sola vez no se esconde: se imprime aparte. Una variación
 * que empieza a aparecer seguido es una regresión que todavía no se decide, y
 * el que mire el reporte tiene que poder verla venir.
 */
import { readFileSync, existsSync } from "node:fs";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("Uso: node scripts/comparar-ensayos.mjs primera.json segunda.json");
  process.exit(2);
}

/** Las diferencias de una corrida, o null si el archivo no está. */
function leer(ruta) {
  if (!existsSync(ruta)) return null;
  try {
    return JSON.parse(readFileSync(ruta, "utf8"));
  } catch {
    return null;
  }
}

const primera = leer(a);
const segunda = leer(b);

/*
 * Un archivo que falta no es «cero diferencias».
 *
 * Si el ensayo se cayó antes de escribirlo —se quedó sin cupo, se cortó la red,
 * abortó Node— la ausencia significa que no sabemos nada, y darlo por bueno
 * sería la clase de verde que este archivo existe para evitar.
 */
if (primera === null || segunda === null) {
  const cuales = [primera === null && a, segunda === null && b].filter(Boolean);
  console.error(`✖ No puedo comparar: falta o está roto ${cuales.join(" y ")}.`);
  console.error("  El ensayo no llegó a escribir su reporte, así que no se sabe qué pasó.");
  process.exit(1);
}

/**
 * La identidad de una diferencia: mismo escenario, mismo turno, misma
 * comprobación.
 *
 * La comprobación y NO el motivo. `why` está escrito para leerse y lleva
 * adentro lo que el modelo contestó: «estado info_faltante, esperaba listo»,
 * «esperaba 1 respuesta(s), hubo 2». Intersecar sobre eso pedía que el modelo
 * se equivocara dos veces IGUAL, no dos veces.
 *
 * O sea que la misma afirmación rota en las dos corridas, con dos valores
 * distintos, daba dos claves y la intersección salía vacía. Verde. Y peor que
 * un falso verde cualquiera: una regresión inestable se escondía MEJOR que una
 * determinista, que es exactamente al revés de lo que uno quiere.
 *
 * `comprobacion` la pone el ensayo con datos del escenario —la clave del
 * campo, la frase esperada— nunca con la respuesta.
 */
const clave = (f) => `${f.scenario}|${f.turn}|${f.comprobacion ?? f.why}`;

/*
 * El `?? f.why` no es compatibilidad hacia atrás: los dos reportes los escribe
 * el mismo proceso en la misma corrida, así que o los dos tienen el campo o
 * ninguno. Es para que un reporte viejo a mano no se compare en silencio con
 * uno nuevo dando cero coincidencias.
 */

const enSegunda = new Set(segunda.map(clave));
const enLasDos = primera.filter((f) => enSegunda.has(clave(f)));

const soloUna = [
  ...primera.filter((f) => !enSegunda.has(clave(f))),
  ...segunda.filter((f) => !new Set(primera.map(clave)).has(clave(f))),
];

console.log("═".repeat(70));
console.log("DOS CORRIDAS DEL ENSAYO — qué falló las dos veces");
console.log("═".repeat(70));
console.log("");
console.log(`  primera corrida: ${primera.length} diferencia(s)`);
console.log(`  segunda corrida: ${segunda.length} diferencia(s)`);
console.log("");

if (soloUna.length > 0) {
  console.log(`▸ Difirió una sola vez (${soloUna.length}) — variación del modelo:`);
  for (const f of soloUna) {
    console.log(`    ${f.scenario}${f.turn ? ` turno ${f.turn}` : " (final)"}: ${f.why}`);
  }
  console.log("");
  console.log("  No rompe la corrida. Pero si una de éstas empieza a repetirse,");
  console.log("  es una regresión que todavía no se decidió: miralas.");
  console.log("");
}

console.log("─".repeat(70));
if (enLasDos.length === 0) {
  console.log("✓ Nada falló las dos veces. Lo que difirió fue el modelo, no el código.");
  process.exit(0);
}

console.log(`✗ ${enLasDos.length} diferencia(s) en LAS DOS corridas:`);
console.log("");
const porClave = new Map(segunda.map((f) => [clave(f), f]));
for (const f of enLasDos) {
  const donde = `${f.scenario}${f.turn ? ` turno ${f.turn}` : " (final)"}`;
  console.log(`  ${donde}: ${f.why}`);
  /*
   * Y la segunda vez, cuando dice otra cosa.
   *
   * Es justo el caso que esta comparación empezó a ver: la misma afirmación
   * rota con dos valores distintos. Mostrar sólo el primero haría pensar que
   * se repitió idéntica, que es la lectura contraria a la útil — dos valores
   * distintos dicen que el comportamiento no sólo cambió, además es inestable.
   */
  const otra = porClave.get(clave(f));
  if (otra && otra.why !== f.why) console.log(`  ${" ".repeat(donde.length)}  y la segunda vez: ${otra.why}`);
}
console.log("");
console.log("  Dos veces seguidas no es el modelo eligiendo distinto. Es el");
console.log("  comportamiento que cambió, o una expectativa que dejó de valer.");
process.exit(1);
