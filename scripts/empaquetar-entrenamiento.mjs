/**
 * empaquetar-entrenamiento.mjs — la base del agente, como datos.
 *
 *   node scripts/empaquetar-entrenamiento.mjs              # escribe src/core/agente/entrenamiento-base.generated.ts
 *   node scripts/empaquetar-entrenamiento.mjs --comprobar  # sale 1 si el archivo difiere; sólo lee
 *
 * Por qué existe: la política del agente vive en `entrenamiento/base/<paso>/NN-<slug>.md`,
 * pero Turbopack de Next 16 no trae `?raw`, el ensayo corre con tsx en el mismo proceso y
 * Vercel no empaqueta los .md. Las secciones se empaquetan acá en un módulo de TypeScript
 * sin imports, y el CI comprueba que no se haya quedado atrás: un .md editado sin volver
 * a empaquetar es un agente que sigue con la política vieja.
 *
 * Cada .md abre con `---`, sigue con líneas `clave: valor` (se parten en el PRIMER `: `,
 * porque un título puede tener dos puntos) y cierra con `---`. El cuerpo es el texto exacto
 * que viene después, menos un solo LF final. Sin dependencia YAML: es un parser a mano.
 *
 * El archivo es determinista: sin fechas, finales de línea normalizados a LF y las cadenas
 * con JSON.stringify, que es una cadena válida de TypeScript.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = path.join(RAIZ, "entrenamiento/base");
const DESTINO = path.join(RAIZ, "src/core/agente/entrenamiento-base.generated.ts");

const COMPROBAR = process.argv.includes("--comprobar");

const PASOS = ["extraccion", "decidir", "redactar"];
const MODOS = ["prompt", "sombra"];
const DECISIONES = ["gravedad", "derivar", "pedir", "responder"];
const OBLIGATORIAS = ["id", "paso", "modo", "titulo_es", "titulo_en"];
const CLAVES = [...OBLIGATORIAS, "decision"];

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const aLf = (texto) => texto.split(CRLF).join(LF);

function fallar(mensaje) {
  console.error(`✖ ${mensaje}`);
  process.exit(1);
}

/** Front matter y cuerpo de un .md, ya con LF. Cualquier desvío del formato frena todo. */
function partir(ruta, crudo) {
  const texto = aLf(crudo);
  if (!texto.startsWith(`---${LF}`)) fallar(`${ruta}: tiene que abrir con una línea ---`);

  const cierre = texto.indexOf(`${LF}---${LF}`, 3);
  if (cierre === -1) fallar(`${ruta}: el front matter no cierra con una línea ---`);

  const meta = {};
  for (const linea of texto.slice(4, cierre).split(LF)) {
    const i = linea.indexOf(": ");
    if (i === -1) fallar(`${ruta}: la línea «${linea}» no es «clave: valor»`);
    const clave = linea.slice(0, i);
    const valor = linea.slice(i + 2);
    if (!CLAVES.includes(clave)) fallar(`${ruta}: la clave «${clave}» no existe`);
    if (clave in meta) fallar(`${ruta}: la clave «${clave}» está repetida`);
    if (valor.trim() === "") fallar(`${ruta}: la clave «${clave}» no tiene valor`);
    meta[clave] = valor;
  }

  const resto = texto.slice(cierre + 5);
  const cuerpo = resto.endsWith(LF) ? resto.slice(0, -1) : resto;
  if (cuerpo.trim() === "") fallar(`${ruta}: el cuerpo está vacío`);

  return { meta, cuerpo };
}

function leerSecciones() {
  const sobrantes = readdirSync(BASE).filter((e) => !PASOS.includes(e));
  if (sobrantes.length > 0) {
    fallar(`entrenamiento/base solo tiene ${PASOS.join(", ")}; sobra: ${sobrantes.join(", ")}`);
  }

  const vistos = new Set();
  const secciones = [];

  for (const paso of PASOS) {
    const carpeta = path.join(BASE, paso);
    const archivos = readdirSync(carpeta).sort();

    for (const archivo of archivos) {
      const ruta = `entrenamiento/base/${paso}/${archivo}`;
      const nombre = /^\d{2}-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(archivo);
      if (!nombre) fallar(`${ruta}: el nombre tiene que ser NN-<slug>.md`);

      const { meta, cuerpo } = partir(ruta, readFileSync(path.join(carpeta, archivo), "utf8"));

      for (const clave of OBLIGATORIAS) {
        if (!(clave in meta)) fallar(`${ruta}: falta la clave «${clave}»`);
      }
      if (meta.paso !== paso) fallar(`${ruta}: paso «${meta.paso}» no coincide con la carpeta «${paso}»`);
      if (!MODOS.includes(meta.modo)) fallar(`${ruta}: modo «${meta.modo}» no es ${MODOS.join(" ni ")}`);

      const id = `${paso}.${nombre[1].replaceAll("-", "_")}`;
      if (meta.id !== id) fallar(`${ruta}: id «${meta.id}» debería ser «${id}»`);
      if (vistos.has(id)) fallar(`${ruta}: el id «${id}» está repetido`);
      vistos.add(id);

      if (meta.modo === "sombra") {
        if (!DECISIONES.includes(meta.decision ?? "")) {
          fallar(`${ruta}: una sección de sombra necesita decision: ${DECISIONES.join(" | ")}`);
        }
      } else if ("decision" in meta) {
        fallar(`${ruta}: una sección de prompt no lleva decision`);
      }

      secciones.push({
        id,
        paso,
        modo: meta.modo,
        ...("decision" in meta ? { decision: meta.decision } : {}),
        titulo: { "es-AR": meta.titulo_es, "en-US": meta.titulo_en },
        ruta,
        texto: cuerpo,
      });
    }
  }

  return secciones;
}

const cadena = (x) => JSON.stringify(x);
const unionDe = (xs) => xs.map((x) => `"${x}"`).join(" | ");

function armar(secciones) {
  const version = createHash("sha256").update(JSON.stringify(secciones)).digest("hex").slice(0, 12);

  const entradas = secciones.map((s) =>
    [
      "  {",
      `    id: ${cadena(s.id)},`,
      `    paso: ${cadena(s.paso)},`,
      `    modo: ${cadena(s.modo)},`,
      ...(s.decision ? [`    decision: ${cadena(s.decision)},`] : []),
      `    titulo: { "es-AR": ${cadena(s.titulo["es-AR"])}, "en-US": ${cadena(s.titulo["en-US"])} },`,
      `    ruta: ${cadena(s.ruta)},`,
      `    texto: ${cadena(s.texto)},`,
      "  },",
    ].join(LF),
  );

  return [
    "// Generado por scripts/empaquetar-entrenamiento.mjs (pnpm entrenamiento:empaquetar). No se edita a mano:",
    "// el CI corre `node scripts/empaquetar-entrenamiento.mjs --comprobar` y falla si queda desactualizado.",
    "// Sin imports a propósito: lo leen el servidor, el ensayo con tsx y la consola, y ninguno tiene los .md.",
    "",
    `export type PasoDelAgente = ${unionDe(PASOS)};`,
    `export type ModoDeSeccion = ${unionDe(MODOS)};`,
    `export type DecisionDeSombra = ${unionDe(DECISIONES)};`,
    `export type IdDeSeccion =${LF}${secciones.map((s) => `  | "${s.id}"`).join(LF)};`,
    "",
    "export interface SeccionDeEntrenamiento {",
    "  readonly id: IdDeSeccion;",
    "  readonly paso: PasoDelAgente;",
    "  readonly modo: ModoDeSeccion;",
    "  readonly decision?: DecisionDeSombra;",
    '  readonly titulo: { readonly "es-AR": string; readonly "en-US": string };',
    "  readonly ruta: string;",
    "  readonly texto: string;",
    "}",
    "",
    "// `texto` es el cuerpo del .md tal cual, con LF y sin el salto de línea final.",
    `export const ENTRENAMIENTO_BASE: readonly SeccionDeEntrenamiento[] = [${LF}${entradas.join(LF)}${LF}];`,
    "",
    "// sha256 de las secciones, doce caracteres: cambia con cualquier letra de la base.",
    `export const VERSION_DEL_ENTRENAMIENTO_BASE: string = ${cadena(version)};`,
    "",
  ].join(LF);
}

const secciones = leerSecciones();
const contenido = armar(secciones);

if (COMPROBAR) {
  const actual = existsSync(DESTINO) ? aLf(readFileSync(DESTINO, "utf8")) : null;
  if (actual !== contenido) {
    console.error("✖ src/core/agente/entrenamiento-base.generated.ts no coincide con entrenamiento/base.");
    console.error("  Corré `pnpm entrenamiento:empaquetar` y commiteá el resultado.");
    process.exit(1);
  }
  console.log(`✓ entrenamiento-base.generated.ts al día (${secciones.length} secciones)`);
} else {
  mkdirSync(path.dirname(DESTINO), { recursive: true });
  writeFileSync(DESTINO, contenido);
  console.log(`✓ ${secciones.length} secciones empaquetadas en src/core/agente/entrenamiento-base.generated.ts`);
}
