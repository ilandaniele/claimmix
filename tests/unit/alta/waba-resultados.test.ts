/**
 * Lo que /conectar-whatsapp le cuenta a la persona (`@/server/alta/waba-resultados`):
 * una lista cerrada de resultados, los pasos que se pueden cancelar y qué panel le
 * toca a cada espacio. Sin imports de servidor: es puro.
 */

import { describe, expect, it } from "vitest";

import {
  FALLAS_DEL_POPUP,
  FALLAS_DE_WABA,
  FALLAS_SOLO_DE_APP,
  PASOS_CANCELADOS,
  RESULTADOS_DE_APP,
  RESULTADOS_DE_WABA,
  VERSION_DEL_ANEXO,
  esResultadoDeApp,
  esResultadoDeWaba,
  metodoDelNumero,
  pasoCancelado,
} from "@/server/alta/waba-resultados";

describe("esResultadoDeWaba", () => {
  it.each(RESULTADOS_DE_WABA)("%s es un resultado", (r) => {
    expect(esResultadoDeWaba(r)).toBe(true);
  });

  it.each([["revision "], ["REVISION"], ["codigo_invalido"], ["pedi_primero"], [""], [null], [undefined], [7], [{}], [["meta"]]])(
    "%j no es un resultado",
    (valor) => {
      expect(esResultadoDeWaba(valor)).toBe(false);
    }
  );

  it("no hay dos iguales", () => {
    expect(new Set(RESULTADOS_DE_WABA).size).toBe(RESULTADOS_DE_WABA.length);
  });
});

describe("FALLAS_DE_WABA", () => {
  it("son las causas que acepta la función de la 0051, ni una más", () => {
    expect([...FALLAS_DE_WABA].sort()).toEqual(
      [
        "canje",
        "coexistencia",
        "nombre_rechazado",
        "pago_pendiente",
        "registro",
        "secreto_invalido",
        "sin_numero",
        "suscripcion",
        "token_invalido",
        "token_vencido",
        "waba_bloqueada",
        "waba_restringida",
        "webhook",
      ]
    );
  });
});

describe("pasoCancelado", () => {
  it.each(PASOS_CANCELADOS)("%s pasa tal cual", (paso) => {
    expect(pasoCancelado(paso)).toBe(paso);
  });

  it("pasa a minúscula lo que el SDK manda en mayúscula", () => {
    expect(pasoCancelado("PHONE_NUMBER_VERIFICATION")).toBe("phone_number_verification");
    expect(pasoCancelado("Permissions")).toBe("permissions");
  });

  it.each([["paso_inventado"], ["phone_number_setup; drop table"], [" permissions"], [""], [null], [undefined], [42], [{ paso: "permissions" }]])(
    "%j es «otro»",
    (valor) => {
      expect(pasoCancelado(valor)).toBe("otro");
    }
  );

  it("la lista termina en «otro», que es el que cae lo desconocido", () => {
    expect(PASOS_CANCELADOS.at(-1)).toBe("otro");
  });
});

describe("metodoDelNumero", () => {
  const base = {
    wabaPropia: false,
    appPropia: false,
    numeroAutomatico: false,
    esAdmin: true,
    autoalta: true,
    idEnLaPlataforma: false,
    origen: null,
  };

  it.each([
    // Sin ser admin o sin alta automática no hay panel, prenda lo que prenda.
    ["no es admin", { esAdmin: false, wabaPropia: true, appPropia: true, numeroAutomatico: true }, null],
    ["no es de la alta automática", { autoalta: false, wabaPropia: true, appPropia: true, numeroAutomatico: true }, null],
    ["no es admin, aunque tenga una fila viva", { esAdmin: false, origen: "app_propia" }, null],
    // Todo apagado.
    ["todo apagado", {}, null],
    ["todo apagado pero con una WABA del popup ya hecha: se ve su estado", { origen: "embedded_signup" }, "propia"],
    ["todo apagado pero con una alta de la app propia en curso: se ve su estado", { origen: "app_propia" }, "app"],
    // Sólo el camino viejo.
    ["sólo el número por código", { numeroAutomatico: true }, "codigo"],
    // Sólo la WABA propia.
    ["sólo la WABA propia", { wabaPropia: true }, "propia"],
    ["WABA propia y un id a medias en la plataforma, sin el camino viejo", { wabaPropia: true, idEnLaPlataforma: true }, "propia"],
    // Sólo la app propia.
    ["sólo la app propia", { appPropia: true }, "app"],
    ["app propia y un id a medias en la plataforma, sin el camino viejo", { appPropia: true, idEnLaPlataforma: true }, "app"],
    ["app propia, con el camino viejo prendido y un id a medias: lo termina el camino viejo", { appPropia: true, numeroAutomatico: true, idEnLaPlataforma: true }, "codigo"],
    // Los dos prendidos.
    ["los dos, espacio nuevo: gana el popup y la app propia queda como enlace avanzado", { wabaPropia: true, appPropia: true }, "propia"],
    ["los dos, con una alta de la app propia en curso: sigue por la app", { wabaPropia: true, appPropia: true, origen: "app_propia" }, "app"],
    ["los dos, con una WABA del popup en curso: sigue por el popup", { wabaPropia: true, appPropia: true, origen: "embedded_signup" }, "propia"],
    // Con el camino viejo.
    ["WABA propia y camino viejo, espacio nuevo", { wabaPropia: true, numeroAutomatico: true }, "propia"],
    ["WABA propia y camino viejo, con un número a medias en la plataforma: el camino viejo lo termina", { wabaPropia: true, numeroAutomatico: true, idEnLaPlataforma: true }, "codigo"],
    ["a medias en la plataforma pero con WABA propia ya hecha", { wabaPropia: true, numeroAutomatico: true, idEnLaPlataforma: true, origen: "embedded_signup" }, "propia"],
    ["a medias en la plataforma pero con alta de la app propia ya hecha", { appPropia: true, numeroAutomatico: true, idEnLaPlataforma: true, origen: "app_propia" }, "app"],
    // La bandera se apagó con un cliente a medias: la fila decide.
    ["bandera de la WABA propia apagada con el camino viejo prendido y una WABA hecha", { numeroAutomatico: true, origen: "embedded_signup" }, "propia"],
    ["bandera de la app propia apagada con el camino viejo prendido y una alta hecha", { numeroAutomatico: true, origen: "app_propia" }, "app"],
  ] as const)("%s", (_nombre, cambios, esperado) => {
    expect(metodoDelNumero({ ...base, ...cambios })).toBe(esperado);
  });
});

describe("la vía de la app propia", () => {
  it("sus resultados son nombres de una lista cerrada, sin repetir los de la WABA propia", () => {
    expect(new Set(RESULTADOS_DE_APP).size).toBe(RESULTADOS_DE_APP.length);
    for (const r of RESULTADOS_DE_APP) expect(RESULTADOS_DE_WABA as readonly string[]).not.toContain(r);
  });

  it.each([...RESULTADOS_DE_WABA, ...RESULTADOS_DE_APP])("%s es un resultado de la app propia", (r) => {
    expect(esResultadoDeApp(r)).toBe(true);
  });

  it.each([["secreto"], ["TOKEN_VENCIDO"], [""], [null], [undefined], [7], [{}], [["listo"]]])("%j no es un resultado de la app propia", (valor) => {
    expect(esResultadoDeApp(valor)).toBe(false);
  });

  it("las fallas del popup son las de la base menos las que sólo escribe la app propia", () => {
    expect([...FALLAS_DEL_POPUP, ...FALLAS_SOLO_DE_APP].sort()).toEqual([...FALLAS_DE_WABA].sort());
    expect(FALLAS_SOLO_DE_APP).toEqual(["secreto_invalido", "waba_restringida", "waba_bloqueada", "pago_pendiente"]);
  });

  it("la versión del anexo es un año y un mes, como la acepta la base", () => {
    expect(VERSION_DEL_ANEXO).toMatch(/^[0-9]{4}-[0-9]{2}$/);
  });
});
