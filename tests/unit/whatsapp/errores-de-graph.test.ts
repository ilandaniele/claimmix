/**
 * Qué códigos de Graph son un problema de la cuenta del cliente y no del mensaje.
 */

import { describe, it, expect } from "vitest";
import { TOKEN_INVALIDO, efectoDeError, motivoDeAlta, sinLaWaba, type PasoDeAlta } from "@/server/whatsapp/errores-de-graph";

describe("efectoDeError", () => {
  it("el código del token muerto es uno solo, exportado: el revisor de tokens, los eventos y la salud lo comparten", () => {
    expect(TOKEN_INVALIDO).toBe(190);
    expect(efectoDeError(TOKEN_INVALIDO)).toBe("token_vencido");
  });

  it("190 es el token que dejó de valer; 131042, el pago que falta", () => {
    expect(efectoDeError(190)).toBe("token_vencido");
    expect(efectoDeError(131042)).toBe("pago_pendiente");
  });

  it("cualquier otro código, y la falta de código, no tienen efecto sobre la cuenta", () => {
    for (const codigo of [null, 0, 4, 100, 131047, 131056, 133005, 133016, 80007]) {
      expect(efectoDeError(codigo)).toBeNull();
    }
  });
});

describe("sinLaWaba", () => {
  const viva = (wabaIds: string[]) => ({ ok: true as const, valor: { wabaIds } });

  it("un token que sigue autorizando la WABA no la perdió", () => {
    expect(sinLaWaba(viva(["111", "222"]), "222")).toBe(false);
  });

  it("un token vivo que ya no la lista sí (se sacó la app o el permiso de esa WABA)", () => {
    expect(sinLaWaba(viva(["111"]), "222")).toBe(true);
    expect(sinLaWaba(viva([]), "222")).toBe(true);
  });

  it("el 190 es un token muerto; cualquier otra falla de Graph no dice nada de la WABA", () => {
    expect(sinLaWaba({ ok: false, codigo: TOKEN_INVALIDO }, "222")).toBe(true);
    expect(sinLaWaba({ ok: false, codigo: null }, "222")).toBe(false);
    expect(sinLaWaba({ ok: false, codigo: 100 }, "222")).toBe(false);
  });
});

describe("efectoDeError con los códigos de la app propia", () => {
  it("368 es la WABA restringida por una política", () => {
    expect(efectoDeError(368)).toBe("waba_restringida");
  });

  it("131031 es, sin más contexto, la cuenta bloqueada", () => {
    expect(efectoDeError(131031)).toBe("waba_bloqueada");
  });

  it("los códigos de espera y de datos del mensaje siguen sin efecto sobre la cuenta", () => {
    for (const codigo of [17, 130429, 133008, 133009, 131026, 131051]) expect(efectoDeError(codigo)).toBeNull();
  });
});

describe("motivoDeAlta", () => {
  const PASOS: PasoDeAlta[] = ["revisar", "waba", "numero", "registrar", "pin"];

  it("sin código no hay nada que clasificar: meta, en cualquier paso", () => {
    for (const paso of PASOS) expect(motivoDeAlta(paso, null)).toBe("meta");
  });

  describe("autenticación (190 y 102)", () => {
    it("190 con subcódigo 463 o 467 es el token vencido", () => {
      for (const paso of PASOS) {
        expect(motivoDeAlta(paso, 190, 463)).toBe("token_vencido");
        expect(motivoDeAlta(paso, 190, 467)).toBe("token_vencido");
      }
    });

    it("190 sin subcódigo, o con otro, hay que confirmarlo con la app: puede ser el appsecret_proof", () => {
      for (const paso of PASOS) {
        expect(motivoDeAlta(paso, 190)).toBe("confirmar_app");
        expect(motivoDeAlta(paso, 190, null)).toBe("confirmar_app");
        expect(motivoDeAlta(paso, 190, 460)).toBe("confirmar_app");
        expect(motivoDeAlta(paso, 190, 0)).toBe("confirmar_app");
      }
    });

    it("102 (sesión inválida) también se confirma con la app, y 463 sin el 190 no cuenta", () => {
      for (const paso of PASOS) {
        expect(motivoDeAlta(paso, 102)).toBe("confirmar_app");
        expect(motivoDeAlta(paso, 102, 463)).toBe("confirmar_app");
      }
    });

    it("el 190 manda sobre cualquier otra regla del paso", () => {
      expect(motivoDeAlta("waba", 190, 463)).toBe("token_vencido");
      expect(motivoDeAlta("revisar", 190)).toBe("confirmar_app");
    });
  });

  describe("revisar el token", () => {
    it("10, 3 y el rango 200-299 son un permiso que falta", () => {
      for (const codigo of [10, 3, 200, 250, 299]) expect(motivoDeAlta("revisar", codigo)).toBe("falta_permiso");
    });

    it("fuera de ese rango no", () => {
      for (const codigo of [9, 11, 199, 300]) expect(motivoDeAlta("revisar", codigo)).toBe("meta");
    });

    it("en los otros pasos, 10 y 3 no son un permiso: lo que no se conoce es meta", () => {
      for (const paso of ["numero", "registrar", "pin"] as const) {
        expect(motivoDeAlta(paso, 10)).toBe("meta");
        expect(motivoDeAlta(paso, 3)).toBe("meta");
      }
    });
  });

  describe("la WABA", () => {
    it("200 sobre la WABA es que el token no la tiene asignada", () => {
      expect(motivoDeAlta("waba", 200)).toBe("waba_no_asignada");
    });

    it("100 sobre la WABA es que el id no existe o no es una WABA (R34)", () => {
      expect(motivoDeAlta("waba", 100)).toBe("waba_invalida");
    });

    it("100 y 200 en otro paso no dicen nada de la WABA", () => {
      for (const paso of ["numero", "registrar", "pin"] as const) {
        expect(motivoDeAlta(paso, 100)).toBe("meta");
        expect(motivoDeAlta(paso, 200)).toBe("meta");
      }
    });

    it("200 revisando el token es un permiso que falta, no una WABA sin asignar", () => {
      expect(motivoDeAlta("revisar", 200)).toBe("falta_permiso");
    });
  });

  describe("esperar", () => {
    it.each([4, 17, 80007, 130429, 133016, 133008, 133009])("%i es cuota o ritmo: esperar, en cualquier paso", (codigo) => {
      for (const paso of PASOS) expect(motivoDeAlta(paso, codigo)).toBe("esperar");
    });

    it("133005 (el PIN no coincide) no es de espera", () => {
      expect(motivoDeAlta("pin", 133005)).not.toBe("esperar");
    });
  });

  describe("pago, restricción y bloqueo", () => {
    it("131042 es el pago pendiente, y 368 la WABA restringida, en cualquier paso", () => {
      for (const paso of PASOS) {
        expect(motivoDeAlta(paso, 131042)).toBe("pago_pendiente");
        expect(motivoDeAlta(paso, 368)).toBe("waba_restringida");
      }
    });
  });

  describe("131031 depende del paso (R27)", () => {
    it("al registrar sin PIN del cliente es que falta el PIN", () => {
      expect(motivoDeAlta("registrar", 131031)).toBe("falta_pin");
    });

    it("con el PIN que el cliente escribió es que el PIN es incorrecto", () => {
      expect(motivoDeAlta("pin", 131031)).toBe("pin_incorrecto");
    });

    it("sobre la WABA, el número o el token no dice que esté bloqueada: se confirma con la salud", () => {
      for (const paso of ["revisar", "waba", "numero"] as const) {
        expect(motivoDeAlta(paso, 131031)).toBe("confirmar_salud");
      }
    });
  });

  describe("133005, el PIN que no coincide", () => {
    it("sin PIN del cliente pide el PIN, y con él lo da por incorrecto", () => {
      expect(motivoDeAlta("registrar", 133005)).toBe("falta_pin");
      expect(motivoDeAlta("pin", 133005)).toBe("pin_incorrecto");
    });
  });

  it("un código que no se conoce es meta en cualquier paso", () => {
    for (const paso of PASOS) {
      for (const codigo of [0, 1, 2, 131047, 131056, 999999]) expect(motivoDeAlta(paso, codigo)).toBe("meta");
    }
  });
});
