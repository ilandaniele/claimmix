/**
 * Partir un archivo SQL en sentencias, sin romperlo.
 *
 * Hace falta porque el endpoint HTTP de Neon acepta una sentencia por pedido,
 * mientras que por TCP el archivo entero va de una. O sea que esto existe para
 * que el mismo archivo se pueda aplicar por los dos caminos.
 *
 * Partir por `;` a secas es correcto hasta que deja de serlo, y deja de serlo
 * en el primer archivo interesante: un `DO $$ ... $$` lleva puntos y comas
 * adentro del cuerpo, y una constante de texto puede llevar cualquier cosa. La
 * migración 0010 tiene las dos. Así que esto recorre el texto sabiendo dónde
 * está parado:
 *
 *   · comentario de línea      -- hasta el fin de línea
 *   · comentario de bloque     /* ... *​/, que en Postgres anida
 *   · texto entre comillas     '...', donde '' es una comilla escapada
 *   · identificador entre ""   "...", donde "" es una comilla escapada
 *   · cuerpo con comillas de   $$ ... $$  o  $tag$ ... $tag$
 *     dólar
 *
 * y sólo corta en un `;` que esté fuera de todo eso.
 *
 * No pretende ser un parser de SQL: no entiende la gramática y no le hace
 * falta. Le alcanza con saber cuándo un `;` es un separador y cuándo es un
 * carácter más adentro de algo.
 */

/**
 * @param {string} text  el archivo entero
 * @returns {string[]}   las sentencias, sin el `;` final, sin las vacías
 */
export function splitSqlStatements(text) {
  const statements = [];
  let current = "";
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);

    // ── Comentario de línea ────────────────────────────────────────────────
    if (rest.startsWith("--")) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      current += text.slice(i, stop);
      i = stop;
      continue;
    }

    // ── Comentario de bloque, que anida ────────────────────────────────────
    if (rest.startsWith("/*")) {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (text.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }

    // ── Texto o identificador entre comillas ───────────────────────────────
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0];
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === quote) {
          // Dos seguidas son una comilla escapada, no el cierre.
          if (text[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }

    // ── Cuerpo con comillas de dólar: $$ ... $$ o $tag$ ... $tag$ ──────────
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const close = text.indexOf(tag, i + tag.length);
      const j = close === -1 ? text.length : close + tag.length;
      current += text.slice(i, j);
      i = j;
      continue;
    }

    // ── Un punto y coma acá sí separa ──────────────────────────────────────
    if (rest[0] === ";") {
      statements.push(current);
      current = "";
      i++;
      continue;
    }

    current += text[i];
    i++;
  }

  statements.push(current);

  // Una "sentencia" que sólo tiene comentarios y espacios no es una sentencia:
  // mandarla al servidor da error de sintaxis. Se descartan acá y no en el
  // llamador para que el corte y la limpieza vivan en el mismo lugar.
  return statements
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && stripComments(s).trim().length > 0);
}

/** El texto sin comentarios, sólo para decidir si quedó algo ejecutable. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*--.*$/gm, "");
}
