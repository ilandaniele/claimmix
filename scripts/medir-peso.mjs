/**
 * `pnpm peso` — cuánto JavaScript le llega al navegador.
 *
 * Lo que decide si una pestaña se pone pesada no es el tamaño en disco sino lo
 * que se descarga y se ejecuta. Cada kilobyte de JavaScript se baja, se
 * descomprime, se parsea y se queda en memoria; en un teléfono de gama media
 * eso es tiempo antes de que la pantalla responda.
 *
 * **Esto reemplaza un chequeo que no medía nada.** El job de CI imprimía
 * "Bundle size check passed" siempre, y corría `size-limit || true` — un
 * paquete que ni siquiera está instalado. O sea: un verde por cada commit,
 * durante meses, sobre un número que nadie miró.
 *
 * Mide sobre el build de verdad y comprime con gzip, que es lo que viaja.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const RAIZ = ".next/static/chunks";

/** El presupuesto, en kilobytes ya comprimidos. */
const TOPE_KB = 300;

if (!existsSync(RAIZ)) {
  console.error(`No hay build en ${RAIZ}. Corré \`pnpm build\` primero.`);
  process.exit(2);
}

/** Todos los .js debajo de un directorio, con su tamaño comprimido. */
function archivos(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...archivos(p));
    else if (p.endsWith(".js")) {
      out.push({ ruta: p.replace(/\\/g, "/"), kb: gzipSync(readFileSync(p)).length / 1024 });
    }
  }
  return out;
}

const todos = archivos(RAIZ);

// Lo compartido: lo que baja cualquiera que abra cualquier pantalla.
const compartidos = todos.filter((f) => !f.ruta.includes("/app/"));
const totalCompartido = compartidos.reduce((a, f) => a + f.kb, 0);

/*
 * No hay desglose por pantalla, y decirlo es parte del resultado.
 *
 * Turbopack emite los chunks con nombre de hash y sin carpeta por ruta, y el
 * manifiesto no los mapea. La primera versión de esto intentaba agrupar por
 * `app/<ruta>/` y salía una lista vacía — que en un reporte se lee como
 * "ninguna pantalla pesa", cuando lo que pasa es que no se midió.
 *
 * Lo que sí se puede medir es todo lo que se le manda al navegador, y ése es el
 * número que decide si una pestaña se pone pesada.
 */

console.log("═".repeat(64));
console.log("PESO — lo que baja el navegador, comprimido");
console.log("═".repeat(64));

console.log(`\n▸ Compartido por todas las pantallas`);
console.log(`   ${totalCompartido.toFixed(0)} kB de ${TOPE_KB} kB permitidos`);
for (const f of compartidos.sort((a, b) => b.kb - a.kb).slice(0, 4)) {
  console.log(`     ${f.kb.toFixed(0).padStart(5)} kB  ${f.ruta.split("/").pop()}`);
}

console.log(`\n▸ Sin desglose por pantalla`);
console.log(`   Turbopack nombra los chunks por hash y el manifiesto no los`);
console.log(`   mapea a rutas. El total de arriba es lo que se puede medir,`);
console.log(`   y es el número que decide si una pestaña se pone pesada.`);

const problemas = [];
if (totalCompartido > TOPE_KB) {
  problemas.push(
    `lo compartido pesa ${totalCompartido.toFixed(0)} kB y el tope es ${TOPE_KB}`
  );
}

console.log(`\n${"─".repeat(64)}`);
if (problemas.length === 0) {
  console.log(`✓ Dentro del presupuesto. Total del build: ${todos.reduce((a, f) => a + f.kb, 0).toFixed(0)} kB.`);
  process.exit(0);
}
console.log(`✗ ${problemas.length} por encima del presupuesto:`);
for (const p of problemas) console.log(`   · ${p}`);
console.log("");
console.log("  Un tope que se sube cada vez que alguien lo pasa no es un tope.");
console.log("  Si el peso nuevo hace falta, decilo en el commit y subilo a mano.");
process.exit(1);
