/**
 * Lo puro del asistente de «app propia» (`app/vista.ts`): qué pantalla y qué ventana toca,
 * dónde va el aviso del token y qué texto lleva cada resultado.
 */
import { describe, expect, it } from "vitest";

import {
  claveDeLaFalla,
  claveDelResultado,
  correoDeAyuda,
  lugarDelAvisoDeToken,
  NUMERO_DE_PASO,
  pantallaDe,
  pantallaDeResultado,
  pideRefrescar,
  rellenar,
  sigueEnElServidor,
  tokenGuardado,
  ventanaDe,
  ventanaDeFalla,
  ventanaDeResultado,
} from "@/app/conectar-whatsapp/app/vista";
import { esAR, enUS } from "@/lib/i18n";
import { RESULTADOS_DE_APP, RESULTADOS_DE_WABA } from "@/server/alta/waba-resultados";

const estado = (extra: Record<string, unknown> = {}) => ({ estado: "armando", falla: null, numero: null, ...extra });

describe("pantallaDe", () => {
  it.each(["P0", "P1", "P1B", "E14", "P2", "P4", "G"] as const)("%s tiene pantalla propia", (paso) => {
    expect(pantallaDe(paso)).toBe(paso);
  });

  it.each(["E3", "E4", "E5", "seguir"] as const)("%s es una ventana sobre la pantalla de seguir", (paso) => {
    expect(pantallaDe(paso)).toBe("seguir");
  });

  it("P1, P1B y E14 son el mismo paso 1 de 4", () => {
    expect([NUMERO_DE_PASO.P1, NUMERO_DE_PASO.P1B, NUMERO_DE_PASO.E14]).toEqual([1, 1, 1]);
    expect([NUMERO_DE_PASO.P2, NUMERO_DE_PASO.P3, NUMERO_DE_PASO.P4]).toEqual([2, 3, 4]);
    expect(NUMERO_DE_PASO.P0).toBeUndefined();
    expect(NUMERO_DE_PASO.G).toBeUndefined();
  });
});

describe("pantallaDeResultado", () => {
  it("un callback que cambió después de verificar vuelve a E14: la fila no cambia y la página sola no lo muestra", () => {
    expect(pantallaDeResultado("webhook_pendiente")).toBe("E14");
  });

  it.each(["listo", "esperar", "falta_codigo", "webhook_demora", "meta"] as const)("%s no cambia de pantalla", (resultado) => {
    expect(pantallaDeResultado(resultado)).toBeNull();
  });
});

describe("ventanaDeFalla", () => {
  it.each([
    ["token_vencido", { tipo: "E6" }],
    ["secreto_invalido", { tipo: "E7" }],
    ["pago_pendiente", { tipo: "E8" }],
    ["coexistencia", { tipo: "E9" }],
    ["nombre_rechazado", { tipo: "E10" }],
    ["waba_restringida", { tipo: "E12", bloqueada: false }],
    ["waba_bloqueada", { tipo: "E12", bloqueada: true }],
  ])("%s abre su ventana", (falla, ventana) => {
    expect(ventanaDeFalla(falla)).toEqual(ventana);
  });

  it("una falla sin ventana propia, o ninguna, no abre nada", () => {
    expect(ventanaDeFalla("registro")).toBeNull();
    expect(ventanaDeFalla("canje")).toBeNull();
    expect(ventanaDeFalla(null)).toBeNull();
  });
});

describe("ventanaDe", () => {
  it("E3 y E4 abren su ventana", () => {
    expect(ventanaDe("E3", estado())).toEqual({ tipo: "E3" });
    expect(ventanaDe("E4", estado())).toEqual({ tipo: "E4" });
  });

  it("E5 lleva el número que informó Meta", () => {
    expect(ventanaDe("E5", estado({ numero: "+54 9 291 555 0000" }))).toEqual({ tipo: "E5", numeroMeta: "+54 9 291 555 0000" });
    expect(ventanaDe("E5", null)).toEqual({ tipo: "E5", numeroMeta: null });
  });

  it("en P4 y G sólo abre ventana si la fila está en falla con una falla que la tiene", () => {
    expect(ventanaDe("G", estado({ estado: "falla", falla: "token_vencido" }))).toEqual({ tipo: "E6" });
    expect(ventanaDe("P4", estado({ estado: "falla", falla: "pago_pendiente" }))).toEqual({ tipo: "E8" });
    expect(ventanaDe("G", estado({ estado: "falla", falla: "registro" }))).toBeNull();
    expect(ventanaDe("G", estado({ estado: "conectada", falla: "token_vencido" }))).toBeNull();
    expect(ventanaDe("P4", null)).toBeNull();
  });

  it("las demás pantallas abren sin ventana", () => {
    for (const paso of ["P0", "P1", "P1B", "E14", "P2", "seguir"] as const) {
      expect(ventanaDe(paso, estado({ estado: "falla", falla: "token_vencido" }))).toBeNull();
    }
  });
});

describe("ventanaDeResultado", () => {
  it("elegir_numero lleva la lista, y sin lista va vacía", () => {
    expect(ventanaDeResultado("elegir_numero", { numeros: [{ id: "1", display: "+54 9 291 555 0000" }] })).toEqual({
      tipo: "E2",
      numeros: [{ id: "1", display: "+54 9 291 555 0000" }],
    });
    expect(ventanaDeResultado("elegir_numero")).toEqual({ tipo: "E2", numeros: [] });
  });

  it.each([
    ["falta_codigo", { tipo: "E3" }],
    ["falta_pin", { tipo: "E4" }],
    ["coexistencia", { tipo: "E9" }],
    ["esperar", { tipo: "E11" }],
    ["pago_pendiente", { tipo: "E8" }],
    ["nombre_rechazado", { tipo: "E10" }],
    ["waba_restringida", { tipo: "E12", bloqueada: false }],
    ["waba_bloqueada", { tipo: "E12", bloqueada: true }],
  ] as const)("%s abre su ventana", (resultado, ventana) => {
    expect(ventanaDeResultado(resultado)).toEqual(ventana);
  });

  it("numero_distinto lleva el número de Meta, o null", () => {
    expect(ventanaDeResultado("numero_distinto", { numeroMeta: "+54 9 11 5555 0000" })).toEqual({ tipo: "E5", numeroMeta: "+54 9 11 5555 0000" });
    expect(ventanaDeResultado("numero_distinto")).toEqual({ tipo: "E5", numeroMeta: null });
  });

  it("token_vencido no abre ventana por sí solo: depende de la pantalla", () => {
    expect(ventanaDeResultado("token_vencido")).toBeNull();
  });

  it("un resultado de texto o de la pantalla siguiente no abre ventana", () => {
    for (const r of ["codigo_incorrecto", "pin_incorrecto", "waba_no_asignada", "listo", "conectado", "token_temporal"] as const) {
      expect(ventanaDeResultado(r)).toBeNull();
    }
  });
});

describe("sigueEnElServidor y pideRefrescar", () => {
  it.each(["listo", "conectado", "transicion", "ya_conectado", "desconectado", "cancelado"] as const)("%s cambia lo que lee la página", (r) => {
    expect(sigueEnElServidor(r)).toBe(true);
    expect(pideRefrescar(r, null)).toBe(true);
  });

  it("un resultado de texto no cambia nada ni pide refrescar", () => {
    expect(sigueEnElServidor("codigo_incorrecto")).toBe(false);
    expect(pideRefrescar("codigo_incorrecto", null)).toBe(false);
  });

  it("elegir número (E2) y esperar (E11) no refrescan; las demás ventanas sí", () => {
    expect(pideRefrescar("elegir_numero", { tipo: "E2", numeros: [] })).toBe(false);
    expect(pideRefrescar("esperar", { tipo: "E11" })).toBe(false);
    expect(pideRefrescar("falta_codigo", { tipo: "E3" })).toBe(true);
    expect(pideRefrescar("numero_distinto", { tipo: "E5", numeroMeta: null })).toBe(true);
    expect(pideRefrescar("waba_bloqueada", { tipo: "E12", bloqueada: true })).toBe(true);
  });
});

describe("lugarDelAvisoDeToken", () => {
  it("la WABA sin asignar va junto al bloque 2", () => {
    expect(lugarDelAvisoDeToken("waba_no_asignada")).toBe("bloque2");
  });

  it("el formato y la validez de la WABA van junto a su campo", () => {
    expect(lugarDelAvisoDeToken("waba_formato")).toBe("waba");
    expect(lugarDelAvisoDeToken("waba_invalida")).toBe("waba");
  });

  it("lo demás es del token: bloque 3", () => {
    for (const r of ["token_formato", "token_temporal", "token_de_otra_app", "falta_permiso", "permisos_de_mas", "meta"] as const) {
      expect(lugarDelAvisoDeToken(r)).toBe("bloque3");
    }
  });
});

describe("tokenGuardado", () => {
  it("vacía el campo cuando el servidor ya guardó el token", () => {
    for (const r of ["listo", "conectado", "transicion", "ya_conectado", "falta_codigo", "falta_pin", "numero_distinto"] as const) {
      expect(tokenGuardado(r), r).toBe(true);
    }
  });

  it("lo deja cuando el servidor lo rechazó, para que la persona lo corrija", () => {
    for (const r of ["token_formato", "token_temporal", "token_de_otra_app", "falta_permiso", "waba_no_asignada", "waba_formato", "elegir_numero", "meta"] as const) {
      expect(tokenGuardado(r), r).toBe(false);
    }
  });
});

describe("claveDelResultado y claveDeLaFalla", () => {
  it("un resultado sin texto propio dice lo genérico de Meta", () => {
    expect(claveDelResultado("meta")).toBe("waba.r.meta");
    expect(claveDelResultado("formato")).toBe("waba.r.meta");
  });

  it("«Meta todavía no nos llamó» es de la demora del sondeo: el callback ajeno (webhook_pendiente) no lo usa", () => {
    expect(claveDelResultado("webhook_demora")).toBe("appPropia.r.webhook_demora");
    expect(claveDelResultado("webhook_pendiente")).not.toBe("appPropia.r.webhook_demora");
  });

  it("nombre inválido no dice que Meta lo rechazó: lo detecta el formato, antes de preguntarle a Meta", () => {
    const clave = claveDelResultado("nombre_invalido");
    expect(clave).toBe("appPropia.r.nombre_invalido");
    expect(esAR[clave]).not.toMatch(/Meta/);
    expect(enUS[clave]).not.toMatch(/Meta/);
  });

  it("la falla de nombre rechazado en G no repite el texto de la ventana E10", () => {
    const clave = claveDeLaFalla("nombre_rechazado");
    expect(clave).toBe("appPropia.estado.nombreRechazado");
    expect(esAR[clave]).not.toBe(esAR["appPropia.r.nombre_rechazado"]);
    expect(enUS[clave]).not.toBe(enUS["appPropia.r.nombre_rechazado"]);
  });

  it("toda clave que devuelve existe en los dos idiomas", () => {
    const todos = [...RESULTADOS_DE_WABA, ...RESULTADOS_DE_APP];
    for (const r of todos) {
      const clave = claveDelResultado(r);
      expect(esAR[clave], `falta ${clave} en es-AR`).toBeTruthy();
      expect(enUS[clave], `falta ${clave} en en-US`).toBeTruthy();
    }
    for (const falla of ["canje", "token_invalido", "suscripcion", "registro", "webhook", "coexistencia", "sin_numero", "token_vencido", "secreto_invalido", "nombre_rechazado", "pago_pendiente", "waba_restringida", "waba_bloqueada"]) {
      const clave = claveDeLaFalla(falla);
      expect(esAR[clave], `falta ${clave} en es-AR`).toBeTruthy();
      expect(enUS[clave], `falta ${clave} en en-US`).toBeTruthy();
    }
  });

  it("una falla desconocida o ninguna dice lo genérico", () => {
    expect(claveDeLaFalla("inventada")).toBe("waba.r.meta");
    expect(claveDeLaFalla(null)).toBe("waba.r.meta");
  });

  it("el secreto inválido reusa el texto de la ventana de claves", () => {
    expect(claveDeLaFalla("secreto_invalido")).toBe("appPropia.claves.nuevoTexto");
  });
});

describe("rellenar", () => {
  it("completa cada hueco, repetido o no", () => {
    expect(rellenar("{a} y {b} y {a}", { a: "uno", b: "dos" })).toBe("uno y dos y uno");
  });

  it("un hueco sin valor queda como está", () => {
    expect(rellenar("hola {nombre}", {})).toBe("hola {nombre}");
  });

  it("no toma propiedades heredadas como valor", () => {
    expect(rellenar("{constructor} {toString}", {})).toBe("{constructor} {toString}");
  });

  it("un valor con llaves no se vuelve a expandir", () => {
    expect(rellenar("{a}", { a: "{b}", b: "x" })).toBe("{b}");
  });
});

describe("correoDeAyuda", () => {
  it("saca la dirección de un mailto, sin la consulta", () => {
    expect(correoDeAyuda("mailto:ayuda@example.com?subject=Hola%20mundo&body=x")).toBe("ayuda@example.com");
  });

  it("decodifica la dirección", () => {
    expect(correoDeAyuda("mailto:ayuda%2Btest@example.com")).toBe("ayuda+test@example.com");
  });

  it("una dirección mal codificada se muestra tal cual", () => {
    expect(correoDeAyuda("mailto:ayuda%ZZ@example.com")).toBe("ayuda%ZZ@example.com");
  });

  it("sin mailto, vacío o nulo no hay dirección", () => {
    expect(correoDeAyuda(null)).toBeNull();
    expect(correoDeAyuda("https://example.com")).toBeNull();
    expect(correoDeAyuda("mailto:")).toBeNull();
  });
});
