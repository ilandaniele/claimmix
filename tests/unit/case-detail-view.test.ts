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
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

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
  policies,
  rawMessages,
  users,
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
  /** Las columnas pedidas en cada consulta, alineadas con `tablas`. */
  columnas: Array<Record<string, unknown> | undefined>;
}

/**
 * Reemplaza `enTenant` anotando cuándo arranca y cuándo termina cada consulta.
 *
 * El `await Promise.resolve()` del medio es lo que permite ver las tandas: si
 * varias consultas salen juntas, todos sus `inicio` quedan antes del primer
 * `fin`. Si salen encadenadas, se alternan.
 */
function espiar(porTabla: PorTabla, fallan: Set<unknown> = new Set()): Registro {
  const reg: Registro = { eventos: [], tablas: [], columnas: [] };
  let n = 0;

  mockEnTenant.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) => {
    const propia = ++n;
    reg.eventos.push(`inicio:${propia}`);

    let tabla: unknown;
    let columnas: Record<string, unknown> | undefined;
    const eslabon: Record<string, unknown> = {};
    Object.assign(eslabon, {
      select: (cols?: Record<string, unknown>) => {
        columnas = cols;
        return eslabon;
      },
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
    reg.columnas.push(columnas);

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
        rejected_reason: null,
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

  it("un caso de WhatsApp SÍ paga los adjuntos", async () => {
    /*
     * Las confirmaciones no existen para WhatsApp: pedirlas sería pagar una
     * consulta para recibir vacío.
     *
     * Los adjuntos sí. Condicionarlos al correo dejaba a un caso de WhatsApp
     * sin ninguna fila en pantalla, incluida la que queda cuando un archivo
     * pasa el tope de 10 MB —sin `storage_path` y con `rejected_reason`—, que
     * se escribe justamente para que se vea que el asegurado mandó algo y no
     * entró.
     */
    const porTabla = new Map(TODO);
    porTabla.set(cases, [{ ...CASO_DE_CORREO, channel: "whatsapp" }]);
    const reg = espiar(porTabla);

    await cargarDetalleDeCaso(CTX, CASO);

    expect(reg.tablas).not.toContain(claimFieldConfirmations);
    expect(reg.tablas).toContain(claimAttachments);
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

  it("el select de los adjuntos trae el motivo del rechazo", async () => {
    // Sin esta columna la fila rechazada llega a la pantalla idéntica a una
    // guardada: insignia, nombre y tamaño. Es peor que la fila ausente, porque
    // antes faltaba información y así hay información falsa.
    const reg = espiar(TODO);

    await cargarDetalleDeCaso(CTX, CASO);

    const cual = reg.tablas.indexOf(claimAttachments);
    expect(Object.keys(reg.columnas[cual] ?? {})).toContain("rejected_reason");
  });

  it("marca como duplicado al que repite el hash de uno anterior, y el hash no sale", async () => {
    const fila = (id: string, content_hash: string | null) => ({
      id,
      filename: `${id}.jpg`,
      content_type: "image/jpeg",
      size_bytes: 100,
      external_url: null,
      uploaded_at: "2026-08-01T10:00:00Z",
      rejected_reason: null,
      storage_path: `t/${id}`,
      matched_doc_key: null,
      resumen: id === "a-1" ? "Foto del frente." : null,
      util: id === "a-3" ? false : null,
      content_hash,
    });
    const reg = espiar(
      new Map(TODO).set(claimAttachments, [
        fila("a-1", "h1"),
        fila("a-2", "h1"),
        fila("a-3", "h2"),
        fila("a-4", null),
        fila("a-5", null),
      ])
    );

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res!.attachments.map((a) => a.duplicado)).toEqual([false, true, false, false, false]);
    expect(res!.attachments[0].resumen).toBe("Foto del frente.");
    expect(res!.attachments[2].util).toBe(false);
    for (const a of res!.attachments) {
      expect(a).not.toHaveProperty("content_hash");
      expect(a).not.toHaveProperty("storage_path");
      expect(a).not.toHaveProperty("datos");
      expect(a).not.toHaveProperty("metadatos");
    }
    // Todo sale de la misma consulta de siempre: no hay una segunda para el hash.
    expect(reg.tablas.filter((t) => t === claimAttachments)).toHaveLength(1);
    const cual = reg.tablas.indexOf(claimAttachments);
    expect(Object.keys(reg.columnas[cual] ?? {})).not.toContain("datos");
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

describe("cargarDetalleDeCaso — el nombre de quien tiene el caso", () => {
  it("sin asignado, no pide el nombre", async () => {
    const reg = espiar(TODO);

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(reg.tablas).not.toContain(users);
    expect(res!.asignado_nombre).toBeNull();
  });

  it("con asignado, la tanda pide una consulta más y trae el nombre", async () => {
    const porTabla = new Map(TODO);
    porTabla.set(cases, [{ ...CASO_DE_CORREO, assigned_to: "user-1" }]);
    porTabla.set(users, [{ n: "Ana Analista" }]);
    const reg = espiar(porTabla);

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(reg.tablas).toContain(users);
    expect(res!.asignado_nombre).toBe("Ana Analista");
  });

  it("si falla la consulta del nombre, da null y no tumba la pantalla", async () => {
    const porTabla = new Map(TODO);
    porTabla.set(cases, [{ ...CASO_DE_CORREO, assigned_to: "user-1" }]);
    espiar(porTabla, new Set([users]));

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res).not.toBeNull();
    expect(res!.asignado_nombre).toBeNull();
  });
});

describe("cargarDetalleDeCaso — cobertura y presupuesto (B6, B21, B23)", () => {
  const MONTO = { minimo: 1_500_000, maximo: 4_000_000, moneda: "ARS", origen: "tabla" };
  const POLIZA = {
    status: "active",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    coberturas: [
      { codigo: "danio_parcial", suma_asegurada: 10_000_000, franquicia: 100_000 },
      { codigo: "danio_total", suma_asegurada: 10_000_000, franquicia: null },
    ],
    ambito_territorial: { tipo: "nacional", provincias: [] },
    condiciones_path: "t/polizas/p/condiciones.pdf",
    condiciones_leidas_en: "2026-09-01T12:00:00Z",
    patentes: null,
  };
  const conPoliza = (
    poliza: Record<string, unknown> = POLIZA,
    campos: unknown[] = [{ id: "ef-1", field_key: "accident_date", field_value: "2026-03-10" }]
  ) =>
    new Map(TODO)
      .set(cases, [{ ...CASO_DE_CORREO, policy_id: "pol-1", claim_type: "choque", monto_estimado: MONTO }])
      .set(extractedFields, campos)
      .set(policies, [poliza]);

  it("sin póliza en el caso no la pide, y el panel lo dice", async () => {
    const reg = espiar(TODO);

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(reg.tablas).not.toContain(policies);
    expect(res!.cobertura).toEqual({
      resultado: { veredicto: "dudoso", motivos: ["sin_coberturas_cargadas"] },
      condiciones: "sin_poliza",
      monto: null,
    });
  });

  it("con póliza, la pide en la misma tanda y coteja con la fecha del siniestro", async () => {
    const reg = espiar(conPoliza());

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(tandas(reg.eventos)).toBe(2);
    expect(reg.tablas.filter((t) => t === policies)).toHaveLength(1);
    expect(res!.cobertura).toEqual({
      resultado: { veredicto: "cubre", motivos: [] },
      condiciones: "leidas",
      monto: MONTO,
    });
  });

  // El mismo fragmento que el matcher: una sola subconsulta de patentes.
  it("las patentes salen de una subconsulta atada a la póliza, no de un join", async () => {
    const reg = espiar(conPoliza());

    await cargarDetalleDeCaso(CTX, CASO);

    const cols = reg.columnas[reg.tablas.indexOf(policies)] ?? {};
    expect(new PgDialect().sqlToQuery(cols.patentes as SQL).sql).toBe(
      '(select array_agg("insured_assets"."plate") from "insured_assets" where "insured_assets"."policy_id" = "policies"."id")'
    );
  });

  it("un siniestro anterior a la vigencia no cubre, aunque hoy la póliza esté vigente", async () => {
    espiar(conPoliza({ ...POLIZA, start_date: "2026-04-01" }));

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res!.cobertura!.resultado).toEqual({ veredicto: "no_cubre", motivos: ["fuera_de_vigencia"] });
  });

  it("una fecha que no se lee no tapa otra clave que sí tiene una", async () => {
    espiar(
      conPoliza({ ...POLIZA, start_date: "2026-04-01" }, [
        { id: "ef-1", field_key: "accident_date", field_value: "ayer a la tarde" },
        { id: "ef-2", field_key: "incident_date", field_value: "2026-03-10" },
      ])
    );

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res!.cobertura!.resultado).toEqual({ veredicto: "no_cubre", motivos: ["fuera_de_vigencia"] });
  });

  it("el PDF subido y sin leer no inventa coberturas", async () => {
    espiar(conPoliza({ ...POLIZA, coberturas: null, condiciones_leidas_en: null }));

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res!.cobertura!.condiciones).toBe("sin_leer");
    expect(res!.cobertura!.resultado).toEqual({ veredicto: "dudoso", motivos: ["sin_coberturas_cargadas"] });
  });

  it("si la póliza no se pudo leer no hay panel, y el caso se ve igual", async () => {
    espiar(conPoliza(), new Set([policies]));

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res).not.toBeNull();
    expect(res!.cobertura).toBeNull();
    expect(res!.extracted_fields).not.toEqual([]);
  });

  it("ofrece leer como presupuesto sólo un documento disponible, no descartado, que lo parece", async () => {
    const fila = (id: string, filename: string, content_type: string, extra: Record<string, unknown> = {}) => ({
      id,
      filename,
      content_type,
      size_bytes: 100,
      external_url: null,
      uploaded_at: "2026-08-01T10:00:00Z",
      rejected_reason: null,
      storage_path: `t/${id}`,
      matched_doc_key: null,
      resumen: null,
      util: null,
      content_hash: null,
      tipo: null,
      descarte: null,
      lectura_presupuesto: null,
      ...extra,
    });
    const lectura = { leida_en: "2026-09-01T12:00:00Z", items: [], total: 1, moneda: "ARS", alertas: [] };
    const reg = espiar(
      new Map(TODO).set(claimAttachments, [
        fila("a-1", "presupuesto.pdf", "application/pdf", { lectura_presupuesto: lectura }),
        fila("a-2", "frente.jpg", "image/jpeg"),
        fila("a-3", "doc.pdf", "application/pdf", { tipo: "presupuesto" }),
        fila("a-4", "presupuesto.pdf", "application/pdf", { rejected_reason: "too_large", storage_path: null }),
        // La ruta no lee uno descartado ni una imagen que el modelo no mira.
        fila("a-5", "presupuesto.pdf", "application/pdf", { descarte: "duplicado" }),
        fila("a-6", "presupuesto.gif", "image/gif"),
        fila("a-7", "presupuesto.jpg", "image/jpeg"),
      ])
    );

    const res = await cargarDetalleDeCaso(CTX, CASO);

    expect(res!.attachments.map((a) => a.esPresupuesto)).toEqual([true, false, true, false, false, false, true]);
    expect(res!.attachments[0].lectura_presupuesto).toEqual(lectura);
    for (const a of res!.attachments) {
      expect(a).not.toHaveProperty("tipo");
      expect(a).not.toHaveProperty("descarte");
    }
    // Del `datos` del documento sólo viaja el tipo, y dentro de la consulta.
    const cual = reg.tablas.indexOf(claimAttachments);
    expect(Object.keys(reg.columnas[cual] ?? {})).toEqual(expect.arrayContaining(["tipo", "lectura_presupuesto"]));
    expect(Object.keys(reg.columnas[cual] ?? {})).not.toContain("datos");
  });
});
