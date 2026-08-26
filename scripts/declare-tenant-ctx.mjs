/**
 * `pnpm ctx <archivo>` — declarar `tenantCtx` en las funciones que lo usan.
 *
 * El codemod que migra los filtros sabe declarar el contexto cuando el inquilino
 * viene de un `const tenantId = ...`. En `src/server` casi nunca es así: llega
 * como **parámetro** de la función, y ahí no hay declaración a la que engancharse.
 *
 * Esto completa ese caso. Por cada uso de `tenantCtx` sin declarar, busca hacia
 * arriba la función que lo contiene, mira cómo se llama su parámetro de
 * inquilino, y declara el contexto en la primera línea del cuerpo.
 *
 * No adivina el nombre: lo lee de la firma. Si la firma no tiene un parámetro
 * que parezca un inquilino, lo reporta en vez de inventar uno.
 */
import { readFileSync, writeFileSync } from "node:fs";

const archivo = process.argv[2];
if (!archivo) {
  console.error("Falta el archivo. Uso: pnpm ctx <archivo>");
  process.exit(2);
}

const s = readFileSync(archivo, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
let lineas = s.split(/\r?\n/);

/**
 * Una línea que abre una función.
 *
 * Tiene que ser una función de verdad: `function f(`, `const f = (` o
 * `const f = async (`. La primera versión aceptaba `const X = ....(` y entonces
 * `const row = firstRow(` —que está más cerca del uso— pasaba por apertura de
 * función. La búsqueda paraba ahí y nunca llegaba a la firma real, así que el
 * parámetro del inquilino no aparecía por ningún lado.
 */
const ABRE_FN =
  /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/;
/**
 * El parámetro del inquilino, tal como aparece en la firma.
 *
 * Sirve tanto si está en su propia línea —el estilo de las firmas largas— como
 * inline: `function f(db: Db, tenantId: string)`. La primera versión sólo miraba
 * el principio de la línea y no encontraba ninguno en `src/server`, donde casi
 * todas las firmas entran en un renglón.
 */
const PARAM = /(?:^\s*|[(,]\s*)(tenantId|tenant_id)\s*[?:]/;

const sinDeclarar = [];
const pendientes = [];

for (let i = 0; i < lineas.length; i++) {
  if (!/\btenantCtx\b/.test(lineas[i])) continue;
  if (/const tenantCtx\b/.test(lineas[i])) continue;
  sinDeclarar.push(i);
}

for (const uso of sinDeclarar) {
  // La función que lo contiene: hacia arriba, la primera línea que abre una.
  let abre = -1;
  for (let k = uso; k >= 0; k--) {
    if (ABRE_FN.test(lineas[k])) {
      abre = k;
      break;
    }
  }
  if (abre === -1) {
    pendientes.push({ linea: uso + 1, motivo: "no encuentro la función que lo contiene" });
    continue;
  }

  // El cuerpo empieza en la primera línea que cierra la firma con `{`.
  let cuerpo = -1;
  for (let k = abre; k < Math.min(lineas.length, abre + 25); k++) {
    if (/\{\s*$/.test(lineas[k])) {
      cuerpo = k;
      break;
    }
  }
  if (cuerpo === -1) {
    pendientes.push({ linea: uso + 1, motivo: "no encuentro dónde empieza el cuerpo" });
    continue;
  }

  // ¿Ya está declarado en esta función?
  if (lineas.slice(cuerpo, uso).some((l) => /const tenantCtx\b/.test(l))) continue;

  // Cómo se llama el parámetro del inquilino, leído de la firma.
  let nombre = null;
  for (let k = abre; k <= cuerpo; k++) {
    const m = lineas[k].match(PARAM);
    if (m) {
      nombre = m[1];
      break;
    }
  }
  if (!nombre) {
    pendientes.push({
      linea: uso + 1,
      motivo: "la firma no tiene un parámetro de inquilino: declarar a mano",
    });
    continue;
  }

  const sangria = lineas[cuerpo].match(/^\s*/)[0] + "  ";
  const decl =
    nombre === "tenantId"
      ? `${sangria}const tenantCtx: TenantContext = { tenantId };`
      : `${sangria}const tenantCtx: TenantContext = { tenantId: ${nombre} };`;
  lineas.splice(
    cuerpo + 1,
    0,
    `${sangria}// Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.`,
    decl
  );
  // Los índices de todo lo que está más abajo se corrieron dos líneas.
  for (let k = 0; k < sinDeclarar.length; k++) {
    if (sinDeclarar[k] > cuerpo) sinDeclarar[k] += 2;
  }
}

writeFileSync(archivo, lineas.join(nl), "utf8");

console.log(archivo);
if (pendientes.length) {
  console.log(`   ${pendientes.length} para mirar a mano:`);
  for (const p of pendientes) console.log(`      L${p.linea}: ${p.motivo}`);
} else {
  console.log("   ✓ todos los contextos declarados");
}
