/**
 * Lo que el asegurado escribió, para un caso.
 *
 * Esta consulta estaba escrita dos veces en la pantalla de detalle —una para el
 * acordeón, otra para releer el texto con el parser cuando la extracción no
 * dejó campos— y no la probaba nada. Diferían en el orden y el tope, y las dos
 * hacían la misma cascada: `raw_messages` primero, `claim_messages` entrantes
 * como respaldo.
 *
 * Lo que se afirma acá es la cascada, que es lo que se rompe sin darse cuenta:
 * invertirla devuelve el texto recortado del hilo en vez del mensaje completo,
 * y el parser relee menos de lo que hay.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockEnTenant } = vi.hoisted(() => ({ mockEnTenant: vi.fn() }));

vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));

import {
  mensajesEntrantes,
  ultimoMensajeEntrante,
} from "@/server/cases/inbound-messages";
import { asc, desc } from "drizzle-orm";

import { claimMessages, rawMessages } from "@/lib/db/schema";

const CTX = { tenantId: "tenant-1" };
const CASO = "caso-1";

interface Consulta {
  tabla?: unknown;
  orden?: unknown;
  tope?: number;
}

/**
 * Reemplaza `enTenant` y anota qué se consultó.
 *
 * `respuestas` es una por llamada, en orden: la primera es `raw_messages`, la
 * segunda —si llega— el respaldo de `claim_messages`.
 */
function conRespuestas(...respuestas: unknown[][]) {
  const consultas: Consulta[] = [];

  mockEnTenant.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) => {
    const c: Consulta = {};
    consultas.push(c);

    const eslabon: Record<string, unknown> = {};
    Object.assign(eslabon, {
      from: (t: unknown) => {
        c.tabla = t;
        return eslabon;
      },
      where: () => eslabon,
      orderBy: (o: unknown) => {
        c.orden = o;
        return eslabon;
      },
      limit: (n: number) => {
        c.tope = n;
        return eslabon;
      },
    });

    armar({ select: () => eslabon });
    return respuestas[consultas.length - 1] ?? [];
  });

  return consultas;
}

const CRUDO = {
  subject: "Siniestro",
  body: "Choqué en Corrientes y Callao.",
  from_addr: "asegurado@ejemplo.com",
  received_at: "2026-08-01T10:00:00Z",
};

const DEL_HILO = {
  subject: "Re: Siniestro",
  body_text: "Texto del hilo",
  from_addr: "asegurado@ejemplo.com",
  received_at: "2026-08-02T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mensajesEntrantes — la cascada", () => {
  it("con mensajes crudos, no consulta el hilo", async () => {
    const consultas = conRespuestas([CRUDO]);

    const res = await mensajesEntrantes(CTX, CASO);

    expect(res).toEqual([
      {
        subject: "Siniestro",
        body: "Choqué en Corrientes y Callao.",
        from_addr: "asegurado@ejemplo.com",
        received_at: "2026-08-01T10:00:00Z",
      },
    ]);
    // Una sola consulta: el respaldo no se paga si no hace falta.
    expect(consultas).toHaveLength(1);
    expect(consultas[0].tabla).toBe(rawMessages);
  });

  it("sin mensajes crudos, cae al hilo", async () => {
    const consultas = conRespuestas([], [DEL_HILO]);

    const res = await mensajesEntrantes(CTX, CASO);

    expect(consultas).toHaveLength(2);
    expect(consultas[1].tabla).toBe(claimMessages);
    expect(res[0].body).toBe("Texto del hilo");
  });

  it("sin nada en ninguna de las dos, devuelve vacío", async () => {
    conRespuestas([], []);
    expect(await mensajesEntrantes(CTX, CASO)).toEqual([]);
  });

  it("si la consulta revienta, devuelve vacío y no tira", async () => {
    // Es una pantalla de lectura: quedarse sin el acordeón es mejor que no
    // poder abrir el caso.
    mockEnTenant.mockRejectedValue(new Error("se cayó la base"));

    await expect(mensajesEntrantes(CTX, CASO)).resolves.toEqual([]);
  });
});

describe("mensajesEntrantes — orden y tope", () => {
  it("el tope llega a la consulta", async () => {
    const consultas = conRespuestas([CRUDO]);

    await mensajesEntrantes(CTX, CASO, { tope: 5 });

    expect(consultas[0].tope).toBe(5);
  });

  it("«nuevos» ordena descendente y «viejos» ascendente", async () => {
    // Se compara contra el mismo `asc`/`desc` de drizzle: si el orden queda
    // cableado en uno solo, uno de los dos falla.
    const nuevos = conRespuestas([CRUDO]);
    await mensajesEntrantes(CTX, CASO, { orden: "nuevos" });
    expect(nuevos[0].orden).toEqual(desc(rawMessages.received_at));

    vi.clearAllMocks();
    const viejos = conRespuestas([CRUDO]);
    await mensajesEntrantes(CTX, CASO, { orden: "viejos" });
    expect(viejos[0].orden).toEqual(asc(rawMessages.received_at));
  });

  it("por omisión pide uno solo y el más nuevo", async () => {
    const consultas = conRespuestas([CRUDO]);

    await mensajesEntrantes(CTX, CASO);

    expect(consultas[0].tope).toBe(1);
    expect(consultas[0].orden).toEqual(desc(rawMessages.received_at));
  });
});

describe("ultimoMensajeEntrante", () => {
  it("devuelve el texto listo para el parser", async () => {
    conRespuestas([CRUDO]);

    expect(await ultimoMensajeEntrante(CTX, CASO)).toEqual({
      subject: "Siniestro",
      body: "Choqué en Corrientes y Callao.",
      senderEmail: "asegurado@ejemplo.com",
    });
  });

  it("sin mensajes devuelve cadenas vacías, no undefined", async () => {
    // El parser recibe esto directo: un undefined lo haría explotar.
    conRespuestas([], []);

    expect(await ultimoMensajeEntrante(CTX, CASO)).toEqual({
      subject: "",
      body: "",
      senderEmail: "",
    });
  });

  it("un mensaje con columnas nulas también sale como cadenas", async () => {
    conRespuestas([{ subject: null, body: null, from_addr: null, received_at: "x" }]);

    expect(await ultimoMensajeEntrante(CTX, CASO)).toEqual({
      subject: "",
      body: "",
      senderEmail: "",
    });
  });
});
