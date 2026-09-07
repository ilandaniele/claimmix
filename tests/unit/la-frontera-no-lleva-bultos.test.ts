/**
 * Nada grande cruza de un componente de servidor a uno de cliente.
 *
 * ── Qué mide, y por qué no lo medía nada ────────────────────────────────────
 *
 * Una prop que va de un componente de servidor a uno de cliente no se queda en
 * el servidor: React la serializa dentro de la carga útil RSC que viaja
 * incrustada en el HTML de la página. Es peso que baja TODO el que abre la
 * pantalla, aunque el componente que la recibe no se monte nunca.
 *
 * `pnpm peso` no lo ve. Lee los `.js` de `.next/static/chunks` y los comprime:
 * mide JavaScript. La carga útil RSC no es JavaScript, así que `/bandeja`
 * mandaba 145,9 KB de texto de denuncias en cada carga —los 163 escenarios
 * completos, para dibujar un desplegable de 163 renglones— y el chequeo de peso
 * estuvo en verde todo el tiempo. No falló: no miraba ahí.
 *
 * Que el arreglo esté hecho no cierra el agujero. La guarda tiene que ver la
 * forma del defecto y no el caso que ya arreglamos, porque el defecto vuelve
 * solo: pasar `SCENARIOS` en vez de la lista recortada es un renglón.
 *
 * ── Qué NO alcanza a ver ────────────────────────────────────────────────────
 *
 * Sólo mira props escritas como `prop={IDENTIFICADOR}`, donde el identificador
 * es algo importado. No ve `prop={armarLista()}`, ni un objeto escrito ahí
 * mismo, ni `prop={datos.campo}`, porque eso se arma en tiempo de ejecución y
 * esta prueba no ejecuta la página.
 *
 * Decirlo importa: una guarda que no dice dónde no llega se lee como si
 * llegara a todos lados. Lo que sí cubre es la forma en que este defecto
 * apareció de verdad, que es una constante de módulo pasada entera.
 *
 * Y cuando no puede medir algo —el módulo no se deja importar— falla en vez de
 * saltearlo. Un candidato que se saltea en silencio se cuenta como revisado.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * El tope, en kilobytes de JSON sin comprimir.
 *
 * Hoy el único que cruza es la lista del selector de simulación: 29,1 KB con
 * 163 escenarios. Antes de recortarla eran 145,9 KB.
 *
 * 48 deja crecer la lista sin que nadie tenga que tocar este número, y falla
 * mucho antes de volver a los 145,9. Si algún día se pasa por crecimiento
 * legítimo serían más de doscientos setenta renglones en un desplegable: ahí el
 * problema es la pantalla, no el tope.
 */
const TOPE_KB = 48;

/** Los .tsx del repo, incluidos los que todavía no entraron al índice. */
function archivosTsx(): string[] {
  return execSync('git ls-files --cached --others --exclude-standard "src/**/*.tsx"', {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

/**
 * `use client` al principio del archivo, salteando comentarios.
 *
 * La directiva tiene que ser lo primero del módulo, pero puede venir después
 * de un bloque de comentario: en este repo casi todos los componentes abren
 * con uno.
 */
function esDeCliente(fuente: string): boolean {
  let i = 0;
  while (i < fuente.length) {
    const c = fuente[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (fuente.startsWith("//", i)) {
      const fin = fuente.indexOf("\n", i);
      i = fin < 0 ? fuente.length : fin + 1;
      continue;
    }
    if (fuente.startsWith("/*", i)) {
      const fin = fuente.indexOf("*/", i);
      i = fin < 0 ? fuente.length : fin + 2;
      continue;
    }
    return fuente.startsWith('"use client"', i) || fuente.startsWith("'use client'", i);
  }
  return false;
}

/** Qué nombre viene de qué módulo, para poder seguirlo. */
function importaciones(fuente: string): Map<string, string> {
  const mapa = new Map<string, string>();

  const conLlaves = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = conLlaves.exec(fuente))) {
    for (const parte of m[1]!.split(",")) {
      const nombre = parte.trim().split(/\s+as\s+/).pop()?.trim();
      if (nombre) mapa.set(nombre, m[2]!);
    }
  }

  const porDefecto = /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;
  while ((m = porDefecto.exec(fuente))) mapa.set(m[1]!, m[2]!);

  return mapa;
}

/**
 * El cuerpo de cada etiqueta que abre un componente, con su nombre.
 *
 * Recorre carácter por carácter en vez de usar una expresión regular porque
 * una prop puede llevar un mayor-que adentro —una función flecha es la forma
 * más común— y ahí un `[^>]*` corta la etiqueta por la mitad y se pierde justo
 * lo que sigue.
 */
function etiquetas(fuente: string): { componente: string; cuerpo: string }[] {
  const salida: { componente: string; cuerpo: string }[] = [];
  const apertura = /<([A-Z][\w.]*)/g;
  let m: RegExpExecArray | null;

  while ((m = apertura.exec(fuente))) {
    const inicio = m.index + m[0]!.length;
    let i = inicio;
    let llaves = 0;
    let comilla: string | null = null;

    for (; i < fuente.length; i++) {
      const c = fuente[i]!;
      if (comilla) {
        if (c === comilla && fuente[i - 1] !== "\\") comilla = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        comilla = c;
        continue;
      }
      if (c === "{") {
        llaves++;
        continue;
      }
      if (c === "}") {
        llaves--;
        continue;
      }
      if (c === ">" && llaves === 0) break;
    }

    salida.push({ componente: m[1]!, cuerpo: fuente.slice(inicio, i) });
  }

  return salida;
}

interface Candidato {
  archivo: string;
  componente: string;
  prop: string;
  identificador: string;
  modulo: string;
}

/**
 * Un import relativo, resuelto contra el archivo que lo escribe.
 *
 * Sólo hace falta para saber si el destino declara `use client`, así que
 * alcanza con la extensión .tsx: un componente de cliente siempre la tiene.
 */
function resolverRelativo(desde: string, especificador: string): string | null {
  if (!especificador.startsWith(".")) return null;
  const dir = desde.split("/").slice(0, -1);
  for (const parte of especificador.split("/")) {
    if (parte === ".") continue;
    else if (parte === "..") dir.pop();
    else dir.push(parte);
  }
  return dir.join("/") + ".tsx";
}

/**
 * Las props con nombre propio que un componente de servidor le pasa a uno de
 * cliente, con el módulo del que salen.
 */
function loQueCruzaLaFrontera(): Candidato[] {
  const archivos = archivosTsx();

  const declaraCliente = new Set<string>();
  const fuentes = new Map<string, string>();
  for (const f of archivos) {
    const s = readFileSync(f, "utf8");
    fuentes.set(f, s);
    if (esDeCliente(s)) declaraCliente.add(f);
  }

  const salida: Candidato[] = [];

  for (const archivo of archivos) {
    if (declaraCliente.has(archivo)) continue;
    const fuente = fuentes.get(archivo)!;
    const imp = importaciones(fuente);

    for (const { componente, cuerpo } of etiquetas(fuente)) {
      const desdeDonde = imp.get(componente.split(".")[0]!);
      if (!desdeDonde) continue;

      const destino = resolverRelativo(archivo, desdeDonde);
      if (!destino || !declaraCliente.has(destino)) continue;

      const props = /(\w+)=\{([A-Za-z_$][\w$]*)\}/g;
      let p: RegExpExecArray | null;
      while ((p = props.exec(cuerpo))) {
        const modulo = imp.get(p[2]!);
        if (!modulo) continue;
        salida.push({ archivo, componente, prop: p[1]!, identificador: p[2]!, modulo });
      }
    }
  }

  return salida;
}

const CANDIDATOS = loQueCruzaLaFrontera();

describe("lo que cruza de servidor a cliente", () => {
  it("el detector encuentra algo", () => {
    // Una lista vacía se lee como "nada pesa" cuando lo que pasa es que no se
    // midió. Es el mismo error que `medir-peso.mjs` documenta sobre su
    // desglose por pantalla, y ya ocurrió una vez en este repo.
    expect(CANDIDATOS.length).toBeGreaterThan(0);
  });

  it.each(
    CANDIDATOS.map(
      (c) => [`${c.archivo} · ${c.componente} ${c.prop}={${c.identificador}}`, c] as const
    )
  )("%s entra en el presupuesto", async (_titulo, candidato) => {
    const ruta = candidato.modulo.startsWith("@/")
      ? "../../src/" + candidato.modulo.slice(2)
      : candidato.modulo;

    let modulo: Record<string, unknown>;
    try {
      modulo = (await import(/* @vite-ignore */ ruta)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `No se pudo importar ${candidato.modulo} para medir ${candidato.identificador}. ` +
          `Si el módulo no se puede importar desde una prueba, esta guarda no lo ` +
          `cubre y hay que decirlo en el comentario de arriba. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const valor = modulo[candidato.identificador];
    expect(valor, `${candidato.identificador} no se exporta`).toBeDefined();

    const kb = JSON.stringify(valor).length / 1024;
    expect(
      kb,
      `${candidato.identificador} pesa ${kb.toFixed(1)} kB serializado y viaja adentro ` +
        `del HTML de ${candidato.archivo} en cada carga. Mandá sólo los campos que la ` +
        `pantalla muestra.`
    ).toBeLessThan(TOPE_KB);
  });
});
