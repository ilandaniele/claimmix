import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * `scripts/probar-alta.mts` llama a `crearCuentaDelEnlace` y a `crearEspacio`, que
 * son los de la acción: no los copia. Lo que sí tiene que acordar con ellos son los
 * destinos que espera y el orden de los dos pasos. Si un módulo cambia de destino y
 * el script no, la prueba diría «el alta anda» sobre un camino que ya no existe.
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

const SCRIPT = leer("scripts/probar-alta.mts");
const CODIGO = sinComentarios(SCRIPT);
const CUENTA = leer("src/server/alta/cuenta-del-enlace.ts");
const ESPACIO = leer("src/server/alta/crear-espacio.ts");

describe("probar-alta: los dos pasos con los módulos de verdad", () => {
  it("importa las funciones de la aplicación y no copia ninguna de sus llamadas", () => {
    expect(CODIGO).toContain('await import("@/server/alta/cuenta-del-enlace")');
    expect(CODIGO).toContain('await import("@/server/alta/crear-espacio")');
    for (const copiada of [
      "signUpEmail",
      "signInEmail",
      "marcarCorreoVerificado",
      "abrirToken",
      "crearInquilino(",
      "soltarCupoDeAlta",
      "prepararEspacio",
      "altaAbierta(token",
    ]) {
      expect(CODIGO).not.toContain(copiada);
    }
  });

  it("apaga la consola antes de importar lo que escribe en el logger", () => {
    const apagar = CODIGO.indexOf("  atajarLaConsola();");
    expect(apagar).toBeGreaterThan(-1);
    expect(apagar).toBeLessThan(CODIGO.indexOf('await import("@/server/alta/cuenta-del-enlace")'));
    expect(apagar).toBeLessThan(CODIGO.indexOf('await import("@/server/alta/crear-espacio")'));
    expect(CODIGO).toMatch(/function atajarLaConsola\(\): void \{[\s\S]*?console\.error = nada;[\s\S]*?console\.warn = nada;/);
  });

  it("nunca llama a avisarSiLlegoAlTope: after() no corre fuera de un pedido de Next", () => {
    expect(CODIGO).not.toContain("avisarSiLlegoAlTope");
    expect(CODIGO).not.toMatch(/from "next\//);
  });

  it("el primer paso espera /alta, que es lo que devuelve el enlace cuando anduvo todo", () => {
    expect(SCRIPT).toContain('const DESTINO_DEL_ENLACE = "/alta";');
    expect(sinComentarios(CUENTA)).toMatch(/\n {2}return "\/alta";\n\}/);
  });

  it("abrirlo otra vez espera «ya tenés cuenta», que se importa de la acción y no se copia", () => {
    expect(CUENTA).toContain('export const YA_TENES_CUENTA = "/login?aviso=ya_tenes_cuenta";');
    expect(CODIGO).toContain('const { crearCuentaDelEnlace, YA_TENES_CUENTA } = await import("@/server/alta/cuenta-del-enlace")');
    expect(CODIGO).not.toContain('"/login?aviso=ya_tenes_cuenta"');
  });

  it("el segundo paso espera /bandeja?bienvenida=1, que es lo que devuelve crearEspacio sin base por cliente", () => {
    expect(SCRIPT).toContain('const DESTINO_DE_ALTA = "/bandeja?bienvenida=1";');
    expect(ESPACIO).toContain('prepararEspacio(alta, "/bandeja?bienvenida=1")');
    expect(CODIGO).toContain('process.env.BASE_POR_CLIENTE = "0"');
  });

  it("el enlace crea la cuenta antes de pedir el espacio, y abrirlo otra vez es lo último", () => {
    const alta = cuerpoDe(SCRIPT, "async function altaEnDosPasos(", "\n  }\n");
    const enlace = alta.indexOf("recorrerElEnlace(enlace, claveAleatoria(), ip)");
    const cuenta = alta.indexOf('comprobarCuenta(c, letra, "enlace_ok")');
    const espacio = alta.indexOf("pedirElEspacio(userId, letra)");
    const completo = alta.indexOf("comprobarAlta(c, userId, alta.tenantId, letra)");
    const otraVez = alta.lastIndexOf("recorrerElEnlace(enlace, claveAleatoria(), ip)");
    expect(enlace).toBeGreaterThan(-1);
    expect(cuenta).toBeGreaterThan(enlace);
    expect(espacio).toBeGreaterThan(cuenta);
    expect(completo).toBeGreaterThan(espacio);
    expect(otraVez).toBeGreaterThan(completo);
  });

  it("cuenta lo que gasta cada paso desde antes del primero", () => {
    const alta = cuerpoDe(SCRIPT, "async function altaEnDosPasos(", "\n  }\n");
    expect(alta.indexOf("const antes = await leerCupos(c, ip)")).toBeGreaterThan(-1);
    expect(alta.indexOf("CUPOS_ESPERADOS.enlace)")).toBeGreaterThan(-1);
    expect(alta.indexOf("CUPOS_ESPERADOS.enlace)")).toBeLessThan(alta.indexOf("CUPOS_ESPERADOS.espacio)"));
    expect(alta.indexOf("CUPOS_ESPERADOS.espacio)")).toBeLessThan(alta.indexOf("CUPOS_ESPERADOS.enlaceOtraVez)"));
  });

  it("el pedido del espacio dice que viene a dar de alta su empresa, con los términos aceptados y sin número automático", () => {
    const pedido = cuerpoDe(SCRIPT, "const pedirElEspacio = ", "\n    });\n");
    expect(pedido).toContain("empresa: empresaDe(corrida, l)");
    expect(pedido).toContain("whatsapp: numeroDe(corrida, l)");
    expect(pedido).toContain("terminos: true");
    expect(pedido).toContain("numeroAutomatico: false");
    expect(pedido).toContain("ip: ipDe(corrida, l)");
  });

  it("el enlace se recorre con la IP de la prueba, como lo ve la acción: por la cabecera de la red", () => {
    const enlace = cuerpoDe(SCRIPT, "const recorrerElEnlace = ", "\n    });\n");
    expect(enlace).toContain('headerStore: new Headers({ "x-vercel-forwarded-for": ipDeOrigen })');
    expect(enlace).toContain("clave: password");
    expect(enlace).toContain("repetida: password");
  });

  it("el enlace de antes de separar los pasos lleva la empresa y el número, y el script espera sólo la cuenta", () => {
    const viejo = cuerpoDe(SCRIPT, "async function enlaceConFormaVieja(", "\n  }\n");
    expect(viejo).toContain("empresa: empresaDe(corrida, \"v\")");
    expect(viejo).toContain("numero: numeroDe(corrida, \"v\")");
    expect(viejo).toContain('comprobarCuenta(c, "v", "enlace_viejo_ok")');
  });

  it("la cuenta del enlace se comprueba sin espacio, sin perfil y sin número", () => {
    const cuenta = cuerpoDe(SCRIPT, "async function comprobarCuenta(", "\n  }\n");
    expect(cuenta).toContain('fallas.push("enlace_creo_espacio")');
    expect(cuenta).toContain('fallas.push("correo_sin_verificar")');
    expect(cuenta).toContain('fallas.push("sin_sesion")');
  });

  it("con el cupo de la red lleno, el pedido del espacio vuelve a /alta con «intentos» y no crea el perfil", () => {
    const tope = cuerpoDe(SCRIPT, "async function topePorRed(", "\n  }\n");
    expect(tope).toContain('conError("intentos")');
    expect(tope).toContain('"alta:ip": tope + 1');
    expect(tope.indexOf("recorrerElEnlace(")).toBeLessThan(tope.indexOf("tomarCupoDeAlta(ip)"));
    expect(tope.indexOf("tomarCupoDeAlta(ip)")).toBeLessThan(tope.indexOf("pedirElEspacio(userId"));
  });

  it("con el cupo lleno, «falla» es el contador que no contestó: crearInquilino no corrió y no hay otra causa", () => {
    const tope = cuerpoDe(SCRIPT, "async function topePorRed(", "\n  }\n");
    expect(tope).toMatch(/if \(r\.destino === conError\("falla"\)\) return anotar\("contador_sin_respuesta"\);/);
    expect(tope.indexOf('conError("falla")')).toBeGreaterThan(tope.indexOf("pedirElEspacio(userId"));
    expect(tope.indexOf('conError("falla")')).toBeLessThan(tope.indexOf('conError("intentos")'));
  });

  it("un destino que no se esperaba pasa por destinoInesperado: sólo una falla tragada con la base caída es inconclusa", () => {
    expect(CODIGO).toContain("codigoDeDestinoInesperado,");
    // La única llamada es la que mira la base aparte, no la que usa un valor supuesto.
    expect(CODIGO.match(/codigoDeDestinoInesperado\(/g)).toHaveLength(1);
    expect(CODIGO).toContain("codigoDeDestinoInesperado(destino, await baseContesta())");
    expect(CODIGO).toMatch(/async function baseContesta\(\): Promise<boolean> \{[\s\S]*?comoApp\("select 1"\);[\s\S]*?return true;[\s\S]*?return false;/);
    // El espacio, el primer enlace, abrirlo otra vez, el cupo devuelto, el enlace del tope y el enlace viejo.
    expect(CODIGO.match(/destinoInesperado\(/g)).toHaveLength(7);

    // Los únicos «destino_inesperado» a mano son los que no vienen de un destino de los módulos.
    const aMano = [...CODIGO.matchAll(/^.*"destino_inesperado".*$/gm)].map(([linea]) => linea.trim());
    expect(aMano).toEqual([
      'return r.destino === DESTINO_DE_ALTA ? null : "destino_inesperado";',
      'if (id === null) fallas.push("destino_inesperado");',
      'anotar(falla ?? "destino_inesperado");',
    ]);
  });
});

describe("probar-alta: lo que el script no hace", () => {
  it("no importa nada de src/ antes de preparar el entorno", () => {
    expect(CODIGO).not.toMatch(/^import .* from "@\//m);
    expect(CODIGO).not.toMatch(/^import .* from "\.\.\/src\//m);
  });

  it("no lee variables de entorno por un nombre armado en tiempo de ejecución", () => {
    expect(CODIGO).not.toMatch(/process\.env\[/);
  });

  it("sólo imprime por formatear(), el resumen o un rechazo", () => {
    const impresiones = [...CODIGO.matchAll(/console\.(?:log|error|warn|info)\(([^\n]*)\)/g)].map(([, arg]) => arg);
    expect(impresiones.length).toBeGreaterThan(0);
    for (const arg of impresiones) {
      expect(arg).toMatch(/^(?:formatear\(|`alta: resultado=\$\{resultado\} corrida=\$\{corrida\}`|`✖ \$\{mensaje\}`)/);
    }
  });

  it("barre siempre: el barrido está en el finally de la prueba", () => {
    const cuerpo = CODIGO.slice(CODIGO.indexOf("async function probarTodo()"));
    expect(cuerpo).toMatch(/finally \{\s*try \{\s*if \(candado !== null\) anotar\(\(await barrerBajoCandado\(pool, candado, corrida\)\)\.hallazgo\);/);
  });

  it("limpia lo que dejó una corrida cortada antes de empezar, con el candado en la mano", () => {
    const cuerpo = CODIGO.slice(CODIGO.indexOf("async function probarTodo()"));
    const candado = cuerpo.indexOf('tomarCandado(pool, "180s")');
    const previo = cuerpo.indexOf("await barrer(c, null)");
    const margen = cuerpo.indexOf("anotar(margen);");
    expect(candado).toBeGreaterThan(-1);
    expect(previo).toBeGreaterThan(candado);
    expect(margen).toBeGreaterThan(previo);
  });

  it("rechaza con 2 antes de conectar si la URL no es la de QA", () => {
    const rechazo = CODIGO.indexOf("if (!esUrlDeQa(url)) rechazar(");
    expect(rechazo).toBeGreaterThan(-1);
    expect(rechazo).toBeLessThan(CODIGO.indexOf("new Pool("));
    expect(CODIGO).toMatch(/function rechazar\(mensaje: string\): never \{\s*console\.error\(`✖ \$\{mensaje\}`\);\s*process\.exit\(2\);/);
  });

  it("las dos cadenas de la base pasan por la lista blanca de QA", () => {
    expect(CODIGO).toContain('motivoDeVetoDeBases("qa", cadena)');
    expect(CODIGO).toContain('["QA_DATABASE_URL", dueno]');
    expect(CODIGO).toContain('["QA_DATABASE_URL_APP", app]');
  });
});
