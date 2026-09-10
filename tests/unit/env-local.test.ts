/**
 * El archivo donde viven las credenciales, leído y escrito por un solo lugar.
 *
 * `scripts/lib/env-local.mjs` lo usan dos scripts que no perdonan un error:
 *
 *   · `migrate.mjs`, que aplica migraciones — lee de acá contra qué base;
 *   · `create-app-role.mts`, que escribe acá la contraseña recién rotada.
 *
 * Los dos armaban su propia expresión regular con el nombre que viniera de
 * `--env`, y CodeQL los marcaba en severidad alta —`js/regex-injection`—. No era
 * teórico: `--env "A|.*"` deja de buscar una variable y matchea cualquier línea,
 * así que el que migra apunta a una base que nadie nombró y el que rota escribe
 * la contraseña sobre la línea equivocada.
 *
 * Ahora no hay expresión: se recorre línea por línea y se compara el nombre.
 *
 * Este archivo existe porque esa comprobación se había hecho a mano, en un
 * script del directorio temporal que ya no está. Un módulo que escribe
 * contraseñas y cuya única verificación se borró al cerrar la sesión es
 * exactamente lo que este repo viene sacando de todos lados.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escribirEnEnvLocal, leerDeEnvLocal } from "../../scripts/lib/env-local.mjs";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

let dir: string;
let archivo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "env-local-"));
  archivo = join(dir, ".env.local");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function conContenido(texto: string): void {
  writeFileSync(archivo, texto, "utf8");
}
function loQueQuedo(): string {
  return readFileSync(archivo, "utf8");
}

describe("leerDeEnvLocal", () => {
  it("devuelve el valor de la variable que se pide", () => {
    conContenido(`A=1${LF}DATABASE_URL=postgres://x${LF}B=2${LF}`);
    expect(leerDeEnvLocal("DATABASE_URL", archivo)).toBe("postgres://x");
  });

  it("saca las comillas, que son del formato y no del valor", () => {
    conContenido(`A="con espacios"${LF}B='simples'${LF}`);
    expect(leerDeEnvLocal("A", archivo)).toBe("con espacios");
    expect(leerDeEnvLocal("B", archivo)).toBe("simples");
  });

  it("no confunde una variable con otra que empieza igual", () => {
    // `AB` antes que `A` a propósito: con una expresión mal anclada, gana la
    // primera que aparece.
    conContenido(`AB=malo${LF}A=bueno${LF}`);
    expect(leerDeEnvLocal("A", archivo)).toBe("bueno");
  });

  it("un valor con `=` adentro no se corta al primero", () => {
    // Las cadenas de Neon llevan `?sslmode=require` al final.
    conContenido(`URL=postgres://u:p@h/db?sslmode=require${LF}`);
    expect(leerDeEnvLocal("URL", archivo)).toBe("postgres://u:p@h/db?sslmode=require");
  });

  it("la variable que no está devuelve null, no una cadena vacía", () => {
    // `null` es «no está» y `""` sería «está y es vacía». Quien llama corta con
    // un mensaje en el primer caso.
    conContenido(`A=1${LF}`);
    expect(leerDeEnvLocal("NO_ESTA", archivo)).toBeNull();
  });

  it("se planta con un nombre que no es un nombre", () => {
    // La razón de existir del módulo: `--env "A|.*"` matcheaba cualquier línea.
    conContenido(`A=1${LF}`);
    expect(() => leerDeEnvLocal("A|.*", archivo)).toThrow(/no es un nombre/);
    expect(() => leerDeEnvLocal("A.*", archivo)).toThrow(/no es un nombre/);
    expect(() => leerDeEnvLocal("", archivo)).toThrow(/no es un nombre/);
  });
});

describe("escribirEnEnvLocal", () => {
  it("reemplaza el valor de la que ya está, en su lugar", () => {
    conContenido(`A=1${LF}B=2${LF}C=3${LF}`);
    escribirEnEnvLocal("B", "nuevo", archivo);
    expect(loQueQuedo()).toBe(`A=1${LF}B=nuevo${LF}C=3${LF}`);
  });

  it("agrega la que no estaba, al final", () => {
    conContenido(`A=1${LF}`);
    escribirEnEnvLocal("C", "9", archivo);
    expect(leerDeEnvLocal("C", archivo)).toBe("9");
    expect(leerDeEnvLocal("A", archivo)).toBe("1");
  });

  it("no pisa una que empieza igual", () => {
    // El error que de verdad importa acá: escribir `A` sobre la línea de
    // `DATABASE_URL_APP` deja la contraseña en la variable equivocada, y el
    // script NO imprime el valor para poder darse cuenta.
    conContenido(`AB=intacta${LF}A=vieja${LF}`);
    escribirEnEnvLocal("A", "nueva", archivo);
    expect(loQueQuedo()).toBe(`AB=intacta${LF}A=nueva${LF}`);
  });

  it("con el archivo vacío escribe igual", () => {
    conContenido("");
    escribirEnEnvLocal("A", "1", archivo);
    expect(leerDeEnvLocal("A", archivo)).toBe("1");
  });

  it("conserva el final de línea del archivo", () => {
    // En Windows `.env.local` suele estar en CRLF. Mezclar los dos deja un
    // archivo que algunos lectores parten mal.
    conContenido(`A=1${CRLF}B=2${CRLF}`);
    escribirEnEnvLocal("B", "3", archivo);
    expect(loQueQuedo()).toBe(`A=1${CRLF}B=3${CRLF}`);
    expect(loQueQuedo()).not.toContain(`3${LF}${LF}`);
  });

  it("no toca los comentarios ni las líneas en blanco", () => {
    conContenido(`# la base${LF}${LF}A=1${LF}`);
    escribirEnEnvLocal("A", "2", archivo);
    expect(loQueQuedo()).toBe(`# la base${LF}${LF}A=2${LF}`);
  });

  it("se planta con un nombre que no es un nombre, sin escribir nada", () => {
    conContenido(`A=1${LF}`);
    expect(() => escribirEnEnvLocal("A|.*", "x", archivo)).toThrow(/no es un nombre/);
    expect(loQueQuedo()).toBe(`A=1${LF}`);
  });

  it("lo que escribe se puede volver a leer", () => {
    // Las dos mitades del módulo tienen que estar de acuerdo sobre el formato:
    // es la razón por la que viven juntas.
    conContenido("");
    const cadena = "postgres://claimmix_app:Abc%2F123@ep-x.neon.tech/neondb?sslmode=require";
    escribirEnEnvLocal("DATABASE_URL_APP", cadena, archivo);
    expect(leerDeEnvLocal("DATABASE_URL_APP", archivo)).toBe(cadena);
  });
});
