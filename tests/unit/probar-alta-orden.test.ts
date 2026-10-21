import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * `scripts/probar-alta.mts` copia `destinoDelEnlace` de `src/app/alta/correo/actions.ts`
 * (`"use server"` no deja exportarla). Si la acción cambia de orden o de destino y la
 * copia no, la prueba diría «el alta anda» sobre un camino que ya no existe.
 */
const leer = (ruta: string) => readFileSync(resolve(process.cwd(), ruta), "utf8").replace(/\r\n/g, "\n");

const sinComentarios = (fuente: string) => fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Desde la firma hasta la llave que cierra al mismo nivel de sangría.
const cuerpoDe = (fuente: string, firma: string, cierre: string) => {
  const i = fuente.indexOf(firma);
  expect(i).toBeGreaterThan(-1);
  const j = fuente.indexOf(cierre, i);
  expect(j).toBeGreaterThan(i);
  return sinComentarios(fuente.slice(i, j));
};

const ACCION = cuerpoDe(leer("src/app/alta/correo/actions.ts"), "async function destinoDelEnlace(", "\n}\n");
const COPIA = cuerpoDe(leer("scripts/probar-alta.mts"), "async function recorrerElEnlace(", "\n  }\n");

// El aviso al operador es un `after()` de Next: la copia lo cambia por el hallazgo con la misma condición.
const EQUIVALENTE: Record<string, string> = { llegoAlAviso: "avisarSiLlegoAlTope" };

const LLAMADAS =
  /\b(abrirToken|altaAbierta|clientIpFromHeaders|topePorIp|enAlta|signUpEmail|findUserById|marcarCorreoVerificado|tomarCupoDeAlta|crearInquilino|soltarCupoDeAlta|signInEmail|conError|SIN_ESPACIO|avisarSiLlegoAlTope|llegoAlAviso|prepararEspacio)\b/g;

const enOrden = (cuerpo: string) => [...cuerpo.matchAll(LLAMADAS)].map(([nombre]) => EQUIVALENTE[nombre] ?? nombre);

describe("probar-alta: la copia de destinoDelEnlace", () => {
  it("la acción y la copia hacen las mismas llamadas en el mismo orden", () => {
    const original = enOrden(ACCION);
    expect(original.length).toBeGreaterThan(10);
    expect(enOrden(COPIA)).toEqual(original);
  });

  it("el cierre del alta se mira antes del tope por red", () => {
    const orden = enOrden(COPIA);
    expect(orden.indexOf("altaAbierta")).toBeGreaterThan(orden.indexOf("abrirToken"));
    expect(orden.indexOf("altaAbierta")).toBeLessThan(orden.indexOf("topePorIp"));
  });

  it("el correo se verifica antes de pedir el cupo y el cupo se pide antes de crear el inquilino", () => {
    const orden = enOrden(COPIA);
    expect(orden.indexOf("marcarCorreoVerificado")).toBeLessThan(orden.indexOf("tomarCupoDeAlta"));
    expect(orden.indexOf("tomarCupoDeAlta")).toBeLessThan(orden.indexOf("crearInquilino"));
    expect(orden.indexOf("crearInquilino")).toBeLessThan(orden.indexOf("signInEmail"));
  });

  it.each([
    '"/alta/correo"',
    '"/login?error=registro_cerrado"',
    '"/login?aviso=ya_tenes_cuenta"',
    '"/login"',
    '"USER_ALREADY_EXISTS"',
    '"/bandeja?bienvenida=1"',
    'conMotivo(enlace, "intentos")',
    'conMotivo(enlace, "falla")',
    'cupo.ventana === 0 ? "falla" : "intentos"',
    "headers: new Headers()",
    "headers: headerStore",
    "ip: ipValida(ip)",
  ])("el destino o la condición %s está en la acción y en la copia", (fragmento) => {
    const accion = leer("src/app/alta/correo/actions.ts");
    const script = leer("scripts/probar-alta.mts");
    expect(accion).toContain(fragmento);
    expect(script).toContain(fragmento);
  });

  it("la copia suelta el cupo en las mismas condiciones que la acción", () => {
    const condicion = 'alta === null || (alta.resultado !== "ok" && alta.resultado !== "ok_numero_en_revision")';
    expect(ACCION).toContain(condicion);
    expect(COPIA).toContain(condicion);
  });
});

describe("probar-alta: lo que el script no hace", () => {
  const script = leer("scripts/probar-alta.mts");
  const codigo = sinComentarios(script);

  it("no importa nada de src/ antes de preparar el entorno", () => {
    expect(codigo).not.toMatch(/^import .* from "@\//m);
    expect(codigo).not.toMatch(/^import .* from "\.\.\/src\//m);
  });

  it("no lee variables de entorno por un nombre armado en tiempo de ejecución", () => {
    expect(codigo).not.toMatch(/process\.env\[/);
  });

  it("sólo imprime por formatear(), el resumen o un rechazo", () => {
    const impresiones = [...codigo.matchAll(/console\.(?:log|error|warn|info)\(([^\n]*)\)/g)].map(([, arg]) => arg);
    expect(impresiones.length).toBeGreaterThan(0);
    for (const arg of impresiones) {
      expect(arg).toMatch(/^(?:formatear\(|`alta: resultado=\$\{resultado\} corrida=\$\{corrida\}`|`✖ \$\{mensaje\}`)/);
    }
  });

  it("barre siempre: el barrido está en el finally de la prueba", () => {
    const i = codigo.indexOf("async function probarTodo()");
    const cuerpo = codigo.slice(i);
    expect(cuerpo).toMatch(/finally \{\s*try \{\s*if \(candado !== null\) anotar\(\(await barrerBajoCandado\(pool, candado, corrida\)\)\.hallazgo\);/);
  });

  it("limpia lo que dejó una corrida cortada antes de empezar, con el candado en la mano", () => {
    const cuerpo = codigo.slice(codigo.indexOf("async function probarTodo()"));
    const candado = cuerpo.indexOf('tomarCandado(pool, "180s")');
    const previo = cuerpo.indexOf("await barrer(c, null)");
    const migracion = cuerpo.indexOf("margenDelTope(");
    expect(candado).toBeGreaterThan(-1);
    expect(previo).toBeGreaterThan(candado);
    expect(migracion).toBeGreaterThan(previo);
  });

  it("rechaza con 2 antes de conectar si la URL no es la de QA", () => {
    const rechazo = codigo.indexOf("if (!esUrlDeQa(url)) rechazar(");
    expect(rechazo).toBeGreaterThan(-1);
    expect(rechazo).toBeLessThan(codigo.indexOf("new Pool("));
    expect(codigo).toMatch(/function rechazar\(mensaje: string\): never \{\s*console\.error\(`✖ \$\{mensaje\}`\);\s*process\.exit\(2\);/);
  });

  it("las dos cadenas de la base pasan por la lista blanca de QA", () => {
    expect(codigo).toContain('motivoDeVetoDeBases("qa", cadena)');
    expect(codigo).toContain('["QA_DATABASE_URL", dueno]');
    expect(codigo).toContain('["QA_DATABASE_URL_APP", app]');
  });
});
