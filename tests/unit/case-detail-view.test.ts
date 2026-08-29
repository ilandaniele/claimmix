/**
 * La carga de la pantalla de detalle: en dos tandas, y sin contagiarse fallas.
 *
 * Abrir un caso costaba hasta once viajes a la base repartidos en CINCO esperas
 * encadenadas: la fila del caso, después tres relacionadas, después dos de
 * correo, después el respaldo del parser, y después el acordeón —que era otro
 * componente de servidor que consultaba solo—. Cada tanda esperaba a la
 * anterior sin necesitar nada de ella.
 *
 * Acá se afirman las dos cosas que hacen falta para que eso siga siendo cierto:
 *
 *   · Que sean DOS tandas. No alcanza con contar consultas: lo que se paga es
 *     la cantidad de esperas encadenadas, y eso sólo se ve mirando si las
 *     consultas arrancan antes de que terminen las anteriores.
 *   · Que cada consulta siga degradando SOLA. Es la razón por la que esto no es
 *     un `enTenantVarias`: un lote es una transacción, y un hipo leyendo el
 *     historial de auditoría se llevaría puesta la pantalla entera.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockEnTenant } = vi.hoisted(() => ({ mockEnTenant: vi.fn() }));

vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));

import {
  cargarDetalleDeCaso,
  ultimoParaReleer,
} from "@/server/cases/detail-view";
import {
  auditLog,
  cases,
  claimAttachments,
  claimFieldConfirmations,
  extractedFields,
  missingDocs,
  rawMessages,
} from "@/lib/db/schema";

const CTX = { tenantId: "tenant-1" };
const CASO = "caso-1";

const CASO_DE_CORREO = {
  id: CASO,
  tenant_id: "tenant-1",
  status: "listo",
  channel: "email",
};

/** Qué tabla se consultó, y qué se devuelve para cada una. */
type PorTabla = Map<unknown, unknown[]>;

interface Registro {
  /** `inicio:N` / `fin:N`, en el orden en que ocurrieron. */
  eventos: string[];
  /** Las tablas consultadas, en orden. */
  tablas: unknown[];
}

/**
 * Reemplaza `enTenant` anotando cuándo arranca y cuándo termina cada consulta.
 *
 * El `await Promise.resolve()` del medio es lo que permite ver las tandas: si
 * varias consultas salen juntas, todos sus `inicio` quedan antes del primer
 * `fin`. Si salen encadenadas, se alternan.
 */
function espiar(porTabla: PorTabla, fallan: Set<unknown> = new Set()): Registro {
  const reg: Registro = { eventos: [], tablas: [] };
  let n = 0;

  mockEnTenant.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) => {
    const propia = ++n;
    reg.eventos.push(`inicio:${propia}`);

    let tabla: unknown;
    const eslabon: Record<string, unknown> = {};
    Object.assign(eslabon, {
      select: () => eslabon,
      from: (t: unknown) => {
        tabla = t;
        return eslabon;
      },
      where: () => eslabon,
      orderBy: () => eslabon,
      limit: () => eslabon,
    });
    armar(eslabon);
    reg.tablas.push(tabla);

    await Promise.resolve();
    reg.eventos.push(`fin:${propia}`);

    if (fallan.has(tabla)) throw new Error("se cayó la base");
    return porTabla.get(tabla) ?? [];
  });

  return reg;
}

/** Cuántas tandas hubo: cada vez que un `fin` precede a un `inicio` se abre otra. */
function tandas(eventos: string[]): number {
  let cuenta = 0;
  let vistoUnFin = true;
  for (const e of eventos) {
    if (e.startsWith("inicio")) {
      if (vistoUnFin) {
        cuenta++;
        vistoUnFin = false;
      }
    } else {
      vistoUnFin = true;
    }
  }
  return cuenta;
}

const TODO: PorTabla = new Map<unknown, unknown[]>([
  [cases, [CASO_DE_CORREO]],
  [extractedFields, [{ id: "ef-1", field_key: "full_name" }]],
  [missingDocs, [{ id: "md-1", doc_key: "foto" }]],
  [auditLog, [{ id: 1, event_type: "case.created" }]],
  [
    claimFieldConfirmations,
    [
      {
        id: "c-1",
        field_key: "full_name",
        proposed_value: "Juan",
        conflict_with_value: null,
        confidence: "0.90",
        status: "pending",
        resolved_at: null,
      },
    ],
  ],
  [
    claimAttachments,
    [
      {
        id: "a-1",
        filename: "foto.jpg",
        content_type: "image/jpeg",
        size_bytes: 100,
        external_url: null,
        uploaded_at: "2026-08-01T10:00:00Z",
      },
    ],
  ],
  [
    rawMessages,
    [
      {
        subject: "Siniestro",
        body: "Choqué",
        from_addr: "asegurado@ejemplo.com",
        received_at: "2026-08-01T10:00:00Z",
      },
    ],
  ],
]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cargarDetalleDeCaso — las esperas", () => {
  it("son dos tandas: la fila del caso, y después todo lo demás junto", async () => {
    const reg = espiar(TODO);

    await cargarDetalleDeCaso(CTX, CASO);

    // Lo que se paga no es la cantidad de consultas sino la de esperas.
    expect(tandas(reg.eventos)).toBe(2);
    // La primera es sola: hace falta saber si el caso existe —y de qué canal
    // es— antes de decidir qué más pedir.
    expect(reg.eventos[0]).toBe("inicio:1");
    expect(reg.eventos[1]).toBe("fin:1");
  });

  it("la segunda tanda pide las seis juntas", async () => {
    const reg = espiar(TODO);

    await cargarDetalleDeCaso(CTX, CASO);

    expect(reg.tablas).toEqual([
      cases,
      extractedFields,
      missingDocs,
      auditLog,
      claimFieldConfirmations,
      claimAttachments,
      rawMessages,
    ]);
  });

  it("un caso de WhatsApp no paga las confirmaciones ni los adjuntos", async () => {
    const porTabla = new Map(TODO);
    porTabla.set(cases, [{ ...CASO_DE_CORREO, channel: "whatsapp" }]);
    const reg = espiar(porTabla);

    await cargarDetalleDeCaso(CTX, CASO);

    // Esas dos tablas no tienen filas para un caso de WhatsApp: pedirlas sería
    // pagar dos consultas para recibir vacío.
    expect(reg.tablas).not.toContain(claimFieldConfirmations);
    expect(reg.tablas).not.toContain(claimAttachments);
    expect(tandas(reg.eventos)).toBe(2);
  });

  it("pero SÍ trae los mensajes de un caso de WhatsApp", async () => {
    /*
     * `raw_messages` la escribe también la ingesta real de WhatsApp —
     * `intake-agent.ts`, justo después de escribir el hilo—. El acordeón del
     * texto original se muestra para todos los canales, así que condicionar los
     * mensajes al correo dejaría un caso de WhatsApp diciendo «sin texto
     * original» sobre uno que sí lo tiene.
     */
    const porTabla = new Map(TODO);
    porTabla.set(cases, [{ ...CASO_DE_CORREO, channel: "whatsapp" }]);
    const reg = espiar(porTabla);

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(reg.tablas).toContain(rawMessages);
    expect(res!.messages).toHaveLength(1);
    expect(res!.messages[0].body).toBe("Choqué");
  });

  it("si el caso no existe, no pide nada más", async () => {
    const porTabla = new Map(TODO);
    porTabla.set(cases, []);
    const reg = espiar(porTabla);

    expect(await cargarDetalleDeCaso(CTX, CASO)).toBeNull();
    expect(reg.tablas).toEqual([cases]);
  });
});

describe("cargarDetalleDeCaso — las fallas no se contagian", () => {
  it.each([
    ["el historial", auditLog, "audit_log"],
    ["los campos extraídos", extractedFields, "extracted_fields"],
    ["la documentación faltante", missingDocs, "missing_docs"],
    ["las confirmaciones", claimFieldConfirmations, "confirmations"],
    ["los adjuntos", claimAttachments, "attachments"],
    ["los mensajes", rawMessages, "messages"],
  ])("si falla %s, lo demás llega igual", async (_c, tabla, clave) => {
    espiar(TODO, new Set([tabla]));

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res).not.toBeNull();
    // Lo que falló, vacío.
    expect(res![clave as keyof typeof res]).toEqual([]);
    // Y todo lo demás, con datos: es lo que un solo lote se llevaría puesto.
    const otros = [
      "extracted_fields",
      "missing_docs",
      "audit_log",
      "confirmations",
      "attachments",
      "messages",
    ].filter((k) => k !== clave);
    for (const k of otros) {
      expect(res![k as keyof typeof res]).not.toEqual([]);
    }
  });

  it("una falla en lo relacionado NO convierte el caso en 404", async () => {
    // El null está reservado para «no existe o no es tuyo». Devolverlo por un
    // error de lectura le mostraría al analista que su propio caso no existe.
    espiar(TODO, new Set([auditLog, extractedFields, claimAttachments]));

    await expect(cargarDetalleDeCaso(CTX, CASO)).resolves.not.toBeNull();
  });
});

describe("cargarDetalleDeCaso — las normalizaciones de borde", () => {
  it("la confianza llega como número, no como texto", async () => {
    espiar(TODO);

    const res = await cargarDetalleDeCaso(CTX, CASO);

    // Drizzle entrega `numeric` como string; esto se normalizaba en tres
    // lugares distintos de la pantalla.
    expect(res!.confirmations[0].confidence).toBe(0.9);
  });

  it("un estado desconocido se muestra como pendiente", async () => {
    const porTabla = new Map(TODO);
    porTabla.set(claimFieldConfirmations, [
      { ...(TODO.get(claimFieldConfirmations)![0] as object), status: "vaya-a-saber" },
    ]);
    espiar(porTabla);

    const res = await cargarDetalleDeCaso(CTX, CASO);

    // Pendiente es lo único seguro: muestra el campo como sin resolver en vez
    // de darlo por bueno.
    expect(res!.confirmations[0].status).toBe("pending");
  });

  it("un adjunto sin URL sale con cadena vacía, no con null", async () => {
    espiar(TODO);

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res!.attachments[0].external_url).toBe("");
  });
});

describe("ultimoParaReleer", () => {
  it("con pocos mensajes reusa los que ya se trajeron, sin consultar de nuevo", async () => {
    const reg = espiar(TODO);
    const detalle = await cargarDetalleDeCaso(CTX, CASO);
    const consultasAntes = reg.tablas.length;

    const res = await ultimoParaReleer(CTX, CASO, detalle!);

    expect(res.body).toBe("Choqué");
    expect(res.senderEmail).toBe("asegurado@ejemplo.com");
    // Ninguna consulta nueva: es el ahorro.
    expect(reg.tablas).toHaveLength(consultasAntes);
  });

  it("con cinco mensajes vuelve a preguntar, porque puede haber más nuevos", async () => {
    // El acordeón pide los CINCO PRIMEROS. Si hay cinco, el más nuevo puede no
    // estar entre ellos, y el respaldo del parser quiere el más nuevo.
    const cinco = Array.from({ length: 5 }, (_, i) => ({
      subject: `Mensaje ${i}`,
      body: `Cuerpo ${i}`,
      from_addr: "asegurado@ejemplo.com",
      received_at: `2026-08-0${i + 1}T10:00:00Z`,
    }));
    const porTabla = new Map(TODO);
    porTabla.set(rawMessages, cinco);
    const reg = espiar(porTabla);

    const detalle = await cargarDetalleDeCaso(CTX, CASO);
    expect(detalle!.hayMasMensajes).toBe(true);

    const consultasAntes = reg.tablas.length;
    await ultimoParaReleer(CTX, CASO, detalle!);

    expect(reg.tablas.length).toBeGreaterThan(consultasAntes);
  });

  it("sin mensajes devuelve cadenas vacías, no undefined", async () => {
    const porTabla = new Map(TODO);
    porTabla.set(rawMessages, []);
    espiar(porTabla);

    const detalle = await cargarDetalleDeCaso(CTX, CASO);
    const res = await ultimoParaReleer(CTX, CASO, detalle!);

    // El parser recibe esto directo.
    expect(res).toEqual({ subject: "", body: "", senderEmail: "" });
  });
});
