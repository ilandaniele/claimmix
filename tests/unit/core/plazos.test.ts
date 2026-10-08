/**
 * Los plazos de la Ley 17.418 y los propios de la aseguradora (B10).
 *
 * El servidor corre en UTC y el negocio en Buenos Aires: todo vencimiento cae
 * al final del día ARGENTINO, contado en días corridos.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DIAS_POR_VENCER,
  PLAZOS_LEGALES,
  PlazosSchema,
  diasAlVencimiento,
  diasHastaLaDenuncia,
  estadoDelVencimiento,
  finDelDia,
  limitesDelFiltro,
  proximoVencimiento,
  vencimientoDeRecibido,
  type PlazoPropio,
} from "@/core/case/plazos";

const SIN_PLAZOS: PlazoPropio[] = [];
const fijar = (hacia: "listo_para_core" | "en_liquidacion", ahora: string, plazos = SIN_PLAZOS, tipo: string | null = "choque") =>
  proximoVencimiento({ hacia, tipo, ahora: new Date(ahora), plazos });

describe("art. 56: treinta días corridos desde listo_para_core", () => {
  it("vence al final del día argentino, no del UTC", () => {
    // 12:00 ART del 29/09 más 30 días: el 29/10, hasta las 23:59:59.999 ART
    expect(fijar("listo_para_core", "2026-09-29T15:00:00Z")).toEqual({
      accion: "fijar",
      vence: "2026-10-30T02:59:59.999Z",
      plazo: "art56",
    });
  });

  it("a las 22:00 ART todavía es el mismo día argentino aunque el UTC ya cambió", () => {
    expect(fijar("listo_para_core", "2026-09-30T01:00:00Z")).toMatchObject({ vence: "2026-10-30T02:59:59.999Z" });
  });

  it("cruza mes, año y el 29/02/2028", () => {
    expect(fijar("listo_para_core", "2026-09-15T15:00:00Z")).toMatchObject({ vence: "2026-10-16T02:59:59.999Z" });
    expect(fijar("listo_para_core", "2026-12-15T15:00:00Z")).toMatchObject({ vence: "2027-01-15T02:59:59.999Z" });
    // 30/01/2028 más 30 días es el 29/02 de un año bisiesto
    expect(fijar("listo_para_core", "2028-01-30T15:00:00Z")).toMatchObject({ vence: "2028-03-01T02:59:59.999Z" });
  });

  it("los datos de la ley son los del texto", () => {
    expect(PLAZOS_LEGALES.art46.dias).toBe(3);
    expect(PLAZOS_LEGALES.art56.dias).toBe(30);
  });
});

describe("plazos propios de la aseguradora", () => {
  const propios: PlazoPropio[] = [
    { clave: "rapido", titulo: "Respuesta rápida", dias: 10, ancla: "listo_para_core" },
    { clave: "solo_robo", titulo: "Robos", dias: 5, ancla: "listo_para_core", tipos: ["robo"] },
    { clave: "pago", titulo: "Pago", dias: 15, ancla: "en_liquidacion" },
    { clave: "entrada", titulo: "Primera respuesta", dias: 2, ancla: "recibido", tipos: ["choque"] },
  ];

  it("gana el más corto de la misma ancla, ley incluida", () => {
    expect(fijar("listo_para_core", "2026-09-29T15:00:00Z", propios)).toMatchObject({ plazo: "rapido" });
    expect(fijar("listo_para_core", "2026-09-29T15:00:00Z", propios, "robo")).toMatchObject({ plazo: "solo_robo" });
  });

  it("un plazo con tipos sólo aplica a ese claim_type", () => {
    expect(fijar("listo_para_core", "2026-09-29T15:00:00Z", [propios[1]!], "choque")).toMatchObject({ plazo: "art56" });
    expect(fijar("listo_para_core", "2026-09-29T15:00:00Z", [propios[1]!], null)).toMatchObject({ plazo: "art56" });
  });

  it("uno propio más largo que el art. 56 no lo reemplaza", () => {
    const largo: PlazoPropio[] = [{ clave: "largo", titulo: "Largo", dias: 60, ancla: "listo_para_core" }];
    expect(fijar("listo_para_core", "2026-09-29T15:00:00Z", largo)).toMatchObject({ plazo: "art56" });
  });

  it("en_liquidacion fija el propio, y sin uno limpia porque el art. 56 ya se cumplió", () => {
    expect(fijar("en_liquidacion", "2026-09-29T15:00:00Z", propios)).toMatchObject({ plazo: "pago", vence: "2026-10-15T02:59:59.999Z" });
    expect(fijar("en_liquidacion", "2026-09-29T15:00:00Z")).toEqual({ accion: "limpiar" });
  });

  it("el ancla recibido cuenta desde que se creó el caso", () => {
    expect(vencimientoDeRecibido({ creadoEn: new Date("2026-09-29T15:00:00Z"), tipo: "choque", plazos: propios })).toEqual({
      vence: "2026-10-02T02:59:59.999Z",
      plazo: "entrada",
    });
    expect(vencimientoDeRecibido({ creadoEn: new Date("2026-09-29T15:00:00Z"), tipo: "robo", plazos: propios })).toBeNull();
  });
});

describe("qué le pasa al vencimiento al entrar a cada estado", () => {
  const ahora = new Date("2026-09-29T15:00:00Z");
  const alEntrarA = (hacia: Parameters<typeof proximoVencimiento>[0]["hacia"]) =>
    proximoVencimiento({ hacia, tipo: "choque", ahora, plazos: SIN_PLAZOS });

  it("pagado, rechazado y cerrado lo limpian", () => {
    for (const h of ["pagado", "rechazado", "cerrado"] as const) expect(alEntrarA(h)).toEqual({ accion: "limpiar" });
  });

  it("un estado que no es ancla lo deja como está", () => {
    for (const h of ["recibido", "info_faltante", "confirmacion_pendiente", "requiere_especialista", "enviado_a_core", "error_core"] as const) {
      expect(alEntrarA(h)).toEqual({ accion: "mantener" });
    }
  });
});

describe("PlazosSchema", () => {
  const base = { clave: "uno", titulo: "Uno", dias: 5, ancla: "recibido" as const };

  it("acepta la forma completa y rechaza claves repetidas o reservadas", () => {
    expect(PlazosSchema.safeParse([base]).success).toBe(true);
    expect(PlazosSchema.safeParse([base, base]).success).toBe(false);
    expect(PlazosSchema.safeParse([{ ...base, clave: "art56" }]).success).toBe(false);
  });

  it("rechaza días fuera de 1 a 365, anclas y claves desconocidas", () => {
    expect(PlazosSchema.safeParse([{ ...base, dias: 0 }]).success).toBe(false);
    expect(PlazosSchema.safeParse([{ ...base, dias: 366 }]).success).toBe(false);
    expect(PlazosSchema.safeParse([{ ...base, ancla: "cerrado" }]).success).toBe(false);
    expect(PlazosSchema.safeParse([{ ...base, otro: 1 }]).success).toBe(false);
  });
});

describe("estadoDelVencimiento y limitesDelFiltro", () => {
  const ahora = new Date("2026-09-29T15:00:00Z");

  it("sin fecha no hay estado", () => {
    expect(estadoDelVencimiento(null, ahora)).toBeNull();
    expect(estadoDelVencimiento("no es una fecha", ahora)).toBeNull();
  });

  it("vencido, por vencer y en plazo", () => {
    expect(estadoDelVencimiento("2026-09-29T14:59:59.999Z", ahora)).toBe("vencido");
    expect(estadoDelVencimiento(ahora, ahora)).toBe("por_vencer");
    expect(estadoDelVencimiento(new Date(ahora.getTime() + DIAS_POR_VENCER * 86_400_000), ahora)).toBe("en_plazo");
  });

  it("acepta el formato con el que Postgres devuelve un timestamptz", () => {
    expect(estadoDelVencimiento("2026-10-29 02:59:59.999+00", ahora)).toBe("en_plazo");
  });

  it("sobre mil fechas, el estado y el filtro dicen lo mismo", () => {
    const { hasta: finVencidos } = limitesDelFiltro("vencidos", ahora);
    const { desde, hasta } = limitesDelFiltro("por_vencer", ahora);
    let semilla = 12345;
    const azar = () => (semilla = (semilla * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 1000; i++) {
      const vence = new Date(ahora.getTime() + Math.round((azar() * 20 - 10) * 86_400_000));
      const t = vence.getTime();
      const estado = estadoDelVencimiento(vence, ahora);
      expect(estado === "vencido").toBe(t < Date.parse(finVencidos));
      expect(estado === "por_vencer").toBe(t >= Date.parse(desde!) && t < Date.parse(hasta));
    }
    // los bordes exactos, que el azar casi nunca toca
    for (const t of [ahora.getTime() - 1, ahora.getTime(), Date.parse(hasta) - 1, Date.parse(hasta)]) {
      const estado = estadoDelVencimiento(new Date(t), ahora);
      expect(estado === "vencido").toBe(t < Date.parse(finVencidos));
      expect(estado === "por_vencer").toBe(t >= Date.parse(desde!) && t < Date.parse(hasta));
    }
  });
});

describe("diasAlVencimiento", () => {
  const ahora = new Date("2026-09-29T15:00:00Z");

  it("sin fecha que sirva no hay días", () => {
    expect(diasAlVencimiento(null, ahora)).toBeNull();
    expect(diasAlVencimiento("no es una fecha", ahora)).toBeNull();
  });

  it("0 es vence hoy, aunque falten horas", () => {
    expect(diasAlVencimiento("2026-09-30T02:59:59.999Z", ahora)).toBe(0);
  });

  it("cuenta días enteros hacia adelante y hacia atrás", () => {
    expect(diasAlVencimiento("2026-10-02T02:59:59.999Z", ahora)).toBe(2);
    expect(diasAlVencimiento("2026-09-29T14:59:59.999Z", ahora)).toBe(-1);
    expect(diasAlVencimiento(new Date("2026-09-25T15:00:00Z"), ahora)).toBe(-4);
  });

  it("es coherente con el estado: negativo si y sólo si está vencido", () => {
    for (const vence of ["2026-09-28T00:00:00Z", "2026-09-29T14:59:59.999Z", "2026-09-29T15:00:00Z", "2026-10-30T00:00:00Z"]) {
      expect((diasAlVencimiento(vence, ahora) as number) < 0).toBe(estadoDelVencimiento(vence, ahora) === "vencido");
    }
  });
});

describe("diasHastaLaDenuncia (art. 46)", () => {
  it("con el hecho el 01/09 y la denuncia el 04/09 son 3 días y no supera el art. 46", () => {
    expect(diasHastaLaDenuncia("2026-09-01", "2026-09-04T15:00:00Z")).toEqual({ dias: 3, superaArt46: false });
  });

  it("con la denuncia el 05/09 son 4 días y supera el art. 46", () => {
    expect(diasHastaLaDenuncia("2026-09-01", "2026-09-05T15:00:00Z")).toEqual({ dias: 4, superaArt46: true });
  });

  it("cuenta el día argentino: las 22:00 del 04/09 todavía son 04/09", () => {
    expect(diasHastaLaDenuncia("2026-09-01", "2026-09-05T01:00:00Z")).toEqual({ dias: 3, superaArt46: false });
  });

  it("acepta AAAA-MM-DD y dd/mm/aaaa", () => {
    expect(diasHastaLaDenuncia("01/09/2026", "2026-09-02T15:00:00Z")).toEqual({ dias: 1, superaArt46: false });
    expect(diasHastaLaDenuncia("2026-09-01", new Date("2026-09-02T15:00:00Z"))).toEqual({ dias: 1, superaArt46: false });
  });

  it("una fecha inválida, ausente o posterior a la denuncia da null", () => {
    expect(diasHastaLaDenuncia("ayer", "2026-09-04T15:00:00Z")).toBeNull();
    expect(diasHastaLaDenuncia("31/02/2026", "2026-09-04T15:00:00Z")).toBeNull();
    expect(diasHastaLaDenuncia(null, "2026-09-04T15:00:00Z")).toBeNull();
    expect(diasHastaLaDenuncia("2026-09-01", null)).toBeNull();
    expect(diasHastaLaDenuncia("2026-09-10", "2026-09-04T15:00:00Z")).toBeNull();
  });

  it("es una señal para la ficha: no la lee nada más de src/", () => {
    // La FSM, el puntaje, la asignación, la bandeja y los prompts no pueden depender de ella.
    const lectores = (readdirSync("src", { recursive: true, encoding: "utf8" }) as string[])
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => f.replaceAll("\\", "/"))
      .filter((f) => readFileSync(join("src", f), "utf8").includes("diasHastaLaDenuncia"))
      .sort();
    expect(lectores).toEqual(["app/(app)/casos/[id]/page.tsx", "core/case/plazos.ts"]);
  });
});

describe("finDelDia", () => {
  it("es el último milisegundo del día argentino", () => {
    expect(finDelDia(new Date("2026-09-29T15:00:00Z"), 0)).toBe("2026-09-30T02:59:59.999Z");
  });
});
