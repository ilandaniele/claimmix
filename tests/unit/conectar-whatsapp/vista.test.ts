/**
 * Qué muestra /conectar-whatsapp en cada momento (`vista.ts`): por dónde arranca según
 * lo que dice la base, a dónde pasa con lo que contesta cada acción, qué hace
 * «Reintentar» y cómo se resume para los enlaces. Todo funciones puras.
 */

import { describe, expect, it } from "vitest";

import {
  despuesDe,
  estadoDelNombre,
  reintentoDe,
  resumenDeVista,
  vistaInicial,
  type Aviso,
  type DatosDeVista,
  type EstadoDeVista,
  type NombreDeVista,
} from "@/app/conectar-whatsapp/vista";
import { FALLAS_DEL_POPUP, FALLAS_SOLO_DE_APP, PASOS_CANCELADOS, RESULTADOS_DE_WABA } from "@/server/alta/waba-resultados";

const datos = (extra: Partial<DatosDeVista> = {}): DatosDeVista => ({
  estado: null,
  falla: null,
  paso: null,
  numero: null,
  numeroDistinto: false,
  numeroMeta: null,
  conToken: true,
  ...extra,
});

const vista = (v: NombreDeVista, extra: Partial<EstadoDeVista> = {}): EstadoDeVista => ({
  vista: v,
  aviso: null,
  paso: null,
  numeroMeta: null,
  ...extra,
});

describe("vistaInicial: por dónde arranca la pantalla", () => {
  it("sin lectura (o sin la 0051) es la lista de antes de empezar", () => {
    expect(vistaInicial(null)).toEqual(vista("inicio"));
  });

  it("sin fila de WABA ni número es la lista de antes de empezar", () => {
    expect(vistaInicial(datos())).toEqual(vista("inicio"));
  });

  it.each([
    ["la WABA conectada", datos({ estado: "conectada" })],
    ["el número conectado", datos({ numero: "conectado" })],
    ["el número suspendido", datos({ numero: "suspendido" })],
    ["el número conectado por la WABA de la plataforma aunque la WABA propia diga otra cosa", datos({ estado: "falla", falla: "meta", numero: "conectado", conToken: false })],
  ])("%s es «conectado»", (_caso, d) => {
    expect(vistaInicial(d)).toEqual(vista("conectado"));
  });

  it("el número conectado con el token de su WABA propia que cayó en falla muestra la falla, no «conectado»", () => {
    expect(vistaInicial(datos({ estado: "falla", falla: "meta", numero: "conectado" }))).toEqual(vista("falla", { aviso: "meta" }));
  });

  it("un número sólo pedido no es conectado", () => {
    expect(vistaInicial(datos({ numero: "pedido" })).vista).toBe("inicio");
  });

  describe("a medias, con token", () => {
    it("falta_codigo pide el código", () => {
      expect(vistaInicial(datos({ estado: "falta_codigo" }))).toEqual(vista("codigo"));
    });

    it("falta_pin pide el PIN", () => {
      expect(vistaInicial(datos({ estado: "falta_pin" }))).toEqual(vista("pin"));
    });

    it.each(["vinculada", "suscripta"])("%s se retoma sin popup", (estado) => {
      expect(vistaInicial(datos({ estado }))).toEqual(vista("continuar"));
    });

    it.each(["vinculada", "suscripta"])("%s con otro número del que se tipeó pide aceptarlo", (estado) => {
      expect(vistaInicial(datos({ estado, numeroDistinto: true, numeroMeta: "+541100000001" }))).toEqual(
        vista("numero_distinto", { numeroMeta: "+541100000001" })
      );
    });

    it("el número distinto no pisa el pedido del código ni del PIN", () => {
      expect(vistaInicial(datos({ estado: "falta_codigo", numeroDistinto: true })).vista).toBe("codigo");
      expect(vistaInicial(datos({ estado: "falta_pin", numeroDistinto: true })).vista).toBe("pin");
    });
  });

  describe("a medias, sin token", () => {
    it.each(["falta_codigo", "falta_pin", "vinculada", "suscripta"])("%s vuelve al principio avisando que venció", (estado) => {
      expect(vistaInicial(datos({ estado, conToken: false }))).toEqual(vista("inicio", { aviso: "vencido" }));
    });
  });

  describe("cancelada", () => {
    it.each(PASOS_CANCELADOS)("lleva el paso %s", (paso) => {
      expect(vistaInicial(datos({ estado: "cancelada", paso }))).toEqual(vista("cancelada", { paso }));
    });

    it("un paso que no es de la lista es «otro»", () => {
      expect(vistaInicial(datos({ estado: "cancelada", paso: "<script>" })).paso).toBe("otro");
      expect(vistaInicial(datos({ estado: "cancelada", paso: null })).paso).toBe("otro");
    });
  });

  describe("revocada", () => {
    it("si Meta sacó la app (falla token_vencido) es una falla de token vencido", () => {
      expect(vistaInicial(datos({ estado: "revocada", falla: "token_vencido" }))).toEqual(vista("falla", { aviso: "token_vencido" }));
    });

    it("si el cliente se desconectó a propósito (sin causa) vuelve a la lista, sin avisarle que algo venció", () => {
      expect(vistaInicial(datos({ estado: "revocada", falla: null }))).toEqual(vista("inicio"));
    });

    it("una causa que no es token_vencido no se muestra", () => {
      expect(vistaInicial(datos({ estado: "revocada", falla: "<img src=x>" }))).toEqual(vista("inicio"));
    });
  });

  describe("falla", () => {
    it.each(FALLAS_DEL_POPUP)("la causa %s se conserva", (falla) => {
      expect(vistaInicial(datos({ estado: "falla", falla }))).toEqual(vista("falla", { aviso: falla }));
    });

    it.each(FALLAS_SOLO_DE_APP)("la causa %s es de la app propia: este panel no tiene texto para ella y muestra meta", (falla) => {
      expect(vistaInicial(datos({ estado: "falla", falla }))).toEqual(vista("falla", { aviso: "meta" }));
    });

    it.each([null, "", "algo_que_escribio_alguien", "<img src=x>"])("la causa %j es «meta»: nada que no esté en la lista llega a la pantalla", (falla) => {
      expect(vistaInicial(datos({ estado: "falla", falla }))).toEqual(vista("falla", { aviso: "meta" }));
    });
  });

  it("un estado que no se conoce es la lista de antes de empezar", () => {
    expect(vistaInicial(datos({ estado: "inventado" }))).toEqual(vista("inicio"));
  });
});

describe("despuesDe: la vista que sigue a lo que contestó una acción", () => {
  const enAbrir = vista("abrir");
  const enInicio = vista("inicio");

  it("listo: falta el clic que abre el popup", () => {
    expect(despuesDe("listo", enInicio)).toEqual(vista("abrir"));
  });

  it("conectado", () => {
    expect(despuesDe("conectado", enAbrir)).toEqual(vista("conectado"));
  });

  it("desconectado vuelve a la lista del principio, sin aviso", () => {
    expect(despuesDe("desconectado", vista("conectado"))).toEqual(vista("inicio"));
  });

  describe("cancelado", () => {
    it("conserva el paso que ya sabía el panel", () => {
      expect(despuesDe("cancelado", vista("esperando", { paso: "phone_number_setup" }))).toEqual(vista("cancelada", { paso: "phone_number_setup" }));
    });

    it("sin paso, «otro»", () => {
      expect(despuesDe("cancelado", vista("esperando"))).toEqual(vista("cancelada", { paso: "otro" }));
    });
  });

  describe("numero_distinto", () => {
    it("usa el número que informó Meta", () => {
      expect(despuesDe("numero_distinto", vista("esperando"), "+541100000001")).toEqual(vista("numero_distinto", { numeroMeta: "+541100000001" }));
    });

    it("sin número nuevo, conserva el que ya había", () => {
      expect(despuesDe("numero_distinto", vista("numero_distinto", { numeroMeta: "+5491100000000" }))).toEqual(
        vista("numero_distinto", { numeroMeta: "+5491100000000" })
      );
    });
  });

  it.each([
    ["falta_codigo", "codigo", null],
    ["codigo_enviado", "codigo", "codigo_enviado"],
    ["codigo_incorrecto", "codigo", "codigo_incorrecto"],
    ["falta_pin", "pin", null],
    ["pin_incorrecto", "pin", "pin_incorrecto"],
  ] as const)("%s lleva al diálogo %s", (resultado, esperada, aviso) => {
    expect(despuesDe(resultado, enAbrir)).toEqual(vista(esperada, { aviso }));
  });

  it.each(["abrir", "esperando", "continuar", "codigo", "pin", "falla", "conectado"] as const)(
    "un código vencido se arregla empezando de nuevo, esté donde esté (%s)",
    (donde) => {
      expect(despuesDe("vencido", vista(donde))).toEqual(vista("inicio", { aviso: "vencido" }));
    }
  );

  describe("el resto son avisos", () => {
    const avisos = RESULTADOS_DE_WABA.filter(
      (r) => !["listo", "conectado", "desconectado", "cancelado", "numero_distinto", "falta_codigo", "codigo_enviado", "codigo_incorrecto", "falta_pin", "pin_incorrecto", "vencido"].includes(r)
    );

    it("hay resultados que cubrir", () => {
      expect(avisos.length).toBeGreaterThan(5);
    });

    it.each(avisos)("%s en la lista del principio se queda ahí", (resultado) => {
      expect(despuesDe(resultado, enInicio)).toEqual(vista("inicio", { aviso: resultado as Aviso }));
    });

    it.each(avisos)("%s después del popup es una falla", (resultado) => {
      for (const donde of ["abrir", "esperando", "continuar", "codigo", "pin"] as const) {
        expect(despuesDe(resultado, vista(donde))).toEqual(vista("falla", { aviso: resultado as Aviso }));
      }
    });
  });

  it("todo resultado de la lista da una vista conocida", () => {
    const conocidas: NombreDeVista[] = ["inicio", "abrir", "esperando", "continuar", "numero_distinto", "codigo", "pin", "conectado", "cancelada", "falla"];
    for (const resultado of RESULTADOS_DE_WABA) {
      expect(conocidas, resultado).toContain(despuesDe(resultado, enAbrir).vista);
    }
  });
});

describe("reintentoDe: qué hace «Reintentar»", () => {
  it.each(["meta", "esperar", "suscripcion", "registro", "webhook"] as const)("%s sigue desde el servidor", (aviso) => {
    expect(reintentoDe(aviso)).toBe("servidor");
  });

  it.each(["canje", "token_invalido", "token_vencido", "coexistencia", "sin_numero", "de_la_plataforma", "vencido", "sdk_bloqueado"] as const)(
    "%s abre el popup otra vez",
    (aviso) => {
      expect(reintentoDe(aviso)).toBe("popup");
    }
  );

  it.each(["numero_ocupado", "cupo", "revision", "apagado", "nombre_rechazado", "codigo_enviado", "codigo_incorrecto", "pin_incorrecto"] as const)(
    "%s no se reintenta: se resuelve por mail o en su diálogo",
    (aviso) => {
      expect(reintentoDe(aviso)).toBeNull();
    }
  );
});

describe("resumenDeVista: lo que dicen los enlaces de /preparando y /configuracion", () => {
  it.each([
    ["inicio", "nuevo"],
    ["abrir", "nuevo"],
    ["esperando", "enCurso"],
    ["continuar", "enCurso"],
    ["numero_distinto", "enCurso"],
    ["codigo", "enCurso"],
    ["pin", "enCurso"],
    ["cancelada", "enCurso"],
    ["falla", "falla"],
    ["conectado", "conectado"],
  ] as const)("%s es %s", (v, esperado) => {
    expect(resumenDeVista(v)).toBe(esperado);
  });
});

describe("estadoDelNombre: cómo le cuenta Meta el nombre visible", () => {
  it.each([
    [null, null],
    ["", null],
    ["APPROVED", "aprobado"],
    ["AVAILABLE_WITHOUT_REVIEW", "aprobado"],
    ["PENDING_REVIEW", "revision"],
    ["DECLINED", "otro"],
    ["NONE", "otro"],
    ["lo-que-sea", "otro"],
  ])("%j es %j", (entrada, esperado) => {
    expect(estadoDelNombre(entrada)).toBe(esperado);
  });
});
