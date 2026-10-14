/**
 * `reenviarPedido` (P8): el lote de lectura, el lote de escritura con bloqueo
 * optimista, el mensaje y la auditoría.
 *
 * `decidirReenvio` y `clavesAbiertas` van sin mockear: son puras y ya tienen su
 * propio test en `tests/unit/reenvio-del-pedido.test.ts`. Acá importa que esta
 * función las obedezca — un solo lote de lectura, ningún envío cuando el
 * UPDATE no pegó, y la auditoría exacta que deja.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  enTenantMock,
  enTenantVariasMock,
  mockSend,
  mockMessengerFor,
  mockWriteAuditLog,
  mockEstadoDePlantilla,
  mockQuedaCupo,
  mockCredenciales,
} = vi.hoisted(() => ({
  enTenantMock: vi.fn(),
  enTenantVariasMock: vi.fn(),
  mockSend: vi.fn(),
  mockMessengerFor: vi.fn(),
  mockWriteAuditLog: vi.fn(),
  mockEstadoDePlantilla: vi.fn(),
  mockQuedaCupo: vi.fn(),
  mockCredenciales: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/data/scope", async () => {
  const { puenteSobreLibDb } = await import("../../../mocks/puente-de-alcance");
  const puente = await puenteSobreLibDb();
  enTenantMock.mockImplementation(puente.enTenant);
  enTenantVariasMock.mockImplementation(puente.enTenantVarias);
  return { enTenant: enTenantMock, enTenantVarias: enTenantVariasMock };
});

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), $count: vi.fn() },
  tables: {},
}));

vi.mock("@/server/confirmations/messenger", () => ({
  messengerFor: mockMessengerFor,
}));

vi.mock("@/server/whatsapp/cloud-api", () => ({
  estadoDePlantilla: mockEstadoDePlantilla,
  quedaCupoDePlantilla: mockQuedaCupo,
}));

vi.mock("@/server/whatsapp/numeros", () => ({
  credencialesWhatsApp: mockCredenciales,
}));

vi.mock("@/lib/audit/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/log")>()),
  AuditEvent: {
    CASE_CLOSED: "case.closed",
    CASE_CLOSED_ABANDONED: "claim.closed_abandoned",
    CASE_STATUS_CHANGED: "case.status_changed",
    CLAIM_REQUEST_RESENT: "claim.request_resent",
  },
  writeAuditLog: mockWriteAuditLog,
}));

import { db } from "@/lib/db";
import { reenviarPedido } from "@/server/confirmations/reenvio";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const LEIDO = "2026-09-01T00:00:00.000Z";
const CRED = {
  accessToken: "test-token",
  phoneNumberId: "123456",
  wabaId: "654321",
  tenantId: TENANT_ID,
  autoalta: false,
  enPrueba: false,
  vencida: false,
};

const CTX = {
  user: { id: USER_ID },
  userRow: { id: USER_ID, tenant_id: TENANT_ID, role: "analyst", plan: "profesional" },
};

/** Las 8 filas de `consultasDelReenvio`, en orden, para un info_faltante con algo pendiente. */
function filasBase(
  o: Partial<{
    status: string;
    channel: string;
    assignedTo: string | null;
    ultimoCierre: string;
    closedAt: string | null;
    cierreEn: string;
    ultimoEntrante: string;
  }> = {}
) {
  return [
    [{
      id: CASE_ID,
      status: o.status ?? "info_faltante",
      channel: o.channel ?? "email",
      assigned_to: o.assignedTo ?? null,
      updated_at: LEIDO,
      closed_at: o.closedAt ?? (o.ultimoCierre ? "2026-09-20T00:00:00.000Z" : null),
    }],
    [{ from_addr: "juan@x.com", received_at: o.ultimoEntrante ?? "2026-09-25T00:00:00.000Z" }],
    [],
    [{ asked_keys: ["full_name"], created_at: "2026-09-01T00:00:00.000Z" }],
    [],
    [],
    [],
    o.ultimoCierre
      ? [{ event_type: o.ultimoCierre, created_at: o.cierreEn ?? "2026-09-20T00:00:00.000Z" }]
      : [],
  ];
}

/** `db.select` devuelve, en orden de llamada, una fila de este array. */
function configurarLecturas(filas: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = filas[i++] ?? [];
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return chain;
  });
}

function configurarEscritura(updateRows: unknown[]) {
  const returningFn = vi.fn().mockResolvedValue(updateRows);
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: returningFn }) }),
  } as any);
  vi.mocked(db.insert).mockReturnValue({ select: vi.fn().mockResolvedValue(undefined) } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMessengerFor.mockReturnValue({ send: mockSend });
  mockSend.mockResolvedValue(undefined);
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockCredenciales.mockResolvedValue(CRED);
  mockQuedaCupo.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reenviarPedido", () => {
  it("caso inexistente: un solo lote de lectura, no manda ni audita", async () => {
    configurarLecturas([[], [], [], [], [], [], [], []]);

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: false, motivo: "no_encontrado" });
    expect(enTenantVariasMock).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("un lote de lectura de 8 sentencias", async () => {
    configurarLecturas(filasBase());
    configurarEscritura([{ id: CASE_ID }]);

    await reenviarPedido(CTX as never, CASE_ID, false);

    const armarLectura = enTenantVariasMock.mock.calls[0]![1] as (d: unknown) => unknown[];
    expect(armarLectura(db)).toHaveLength(8);
  });

  it("reabrir pedido por alguien que no puede cambiar el estado, no_encontrado y ni un update", async () => {
    configurarLecturas(filasBase({ status: "cerrado", assignedTo: "otro-analista", ultimoCierre: "claim.closed_abandoned" }));

    const r = await reenviarPedido(CTX as never, CASE_ID, true);

    expect(r).toEqual({ ok: false, motivo: "no_encontrado" });
    expect(enTenantVariasMock).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("el update en cero filas da motivo estado y no manda nada", async () => {
    configurarLecturas(filasBase());
    configurarEscritura([]);

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: false, motivo: "estado" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("info_faltante: un update sin reabrir, manda el mensaje y audita claim.request_resent", async () => {
    configurarLecturas(filasBase());
    configurarEscritura([{ id: CASE_ID }]);

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: true, claves: ["full_name"], reabierto: false });
    expect(db.insert).not.toHaveBeenCalled();

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: CASE_ID,
        tenantId: TENANT_ID,
        to: "juan@x.com",
        template: "missing_information_request",
        data: expect.objectContaining({ missingFields: ["full_name"], isFollowUp: true }),
      })
    );

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_id: USER_ID,
        event_type: "claim.request_resent",
        target_type: "case",
        target_id: CASE_ID,
        payload: { claves: ["full_name"], reabierto: false },
      })
    );
  });

  it("cerrado por abandono con reabrir: el lote de escritura lleva el update y la auditoría de reapertura", async () => {
    configurarLecturas(filasBase({ status: "cerrado", ultimoCierre: "claim.closed_abandoned", assignedTo: USER_ID }));
    configurarEscritura([{ id: CASE_ID }]);

    const r = await reenviarPedido(CTX as never, CASE_ID, true);

    expect(r).toEqual({ ok: true, claves: ["full_name"], reabierto: true });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);

    const armarEscritura = enTenantVariasMock.mock.calls[1]![1] as (d: unknown) => unknown[];
    expect(armarEscritura(db)).toHaveLength(2);

    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "claim.request_resent", payload: { claves: ["full_name"], reabierto: true } })
    );
  });

  it("P8-01: un abandono viejo no reabre un caso que después cerró una persona", async () => {
    // El caso se reabrió por abandono, y luego lo cerró una persona: `closed_at`
    // quedó más nuevo que la única fila `claim.closed_abandoned` de la auditoría.
    configurarLecturas(
      filasBase({
        status: "cerrado",
        assignedTo: USER_ID,
        ultimoCierre: "claim.closed_abandoned",
        closedAt: "2026-09-24T00:00:00.000Z",
        cierreEn: "2026-09-10T00:00:00.000Z",
      })
    );

    const r = await reenviarPedido(CTX as never, CASE_ID, true);

    expect(r).toEqual({ ok: false, motivo: "cierre_no_es_abandono" });
    expect(db.update).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });
});

/*
 * WHATSAPP-PLANTILLA-REABRIR: la ventana de 24 h ya cerró. `decidirConPlantilla`
 * sólo entonces le pregunta a Meta por `reabrir_denuncia`, y decide de nuevo con
 * esa respuesta.
 */
describe("reenviarPedido — WhatsApp fuera de la ventana", () => {
  it("con la plantilla aprobada, manda por plantilla y audita por_plantilla", async () => {
    mockEstadoDePlantilla.mockResolvedValue("aprobada");
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));
    configurarEscritura([{ id: CASE_ID }]);

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: true, claves: ["full_name"], reabierto: false });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ porPlantilla: true }) })
    );
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { claves: ["full_name"], reabierto: false, por_plantilla: true } })
    );
  });

  it("le pregunta a Meta con la credencial del inquilino del caso", async () => {
    mockEstadoDePlantilla.mockResolvedValue("aprobada");
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));
    configurarEscritura([{ id: CASE_ID }]);

    await reenviarPedido(CTX as never, CASE_ID, false);

    expect(mockCredenciales).toHaveBeenCalledWith(TENANT_ID);
    expect(mockEstadoDePlantilla).toHaveBeenCalledWith("reabrir_denuncia", expect.any(String), CRED);
  });

  it("sin número conectado no le pregunta a Meta: el motivo sigue siendo ventana_cerrada", async () => {
    mockCredenciales.mockResolvedValue(null);
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: false, motivo: "ventana_cerrada" });
    expect(mockEstadoDePlantilla).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("con la plantilla pendiente, no manda: el motivo es plantilla_sin_aprobar", async () => {
    mockEstadoDePlantilla.mockResolvedValue("pendiente");
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: false, motivo: "plantilla_sin_aprobar" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe("el cliente con su propia WABA", () => {
    // Las plantillas son por WABA: la de un cliente nuevo nace pendiente en Meta, y hasta que la aprueban no hay con qué abrir la conversación.
    const PROPIA = { ...CRED, accessToken: "test-own-token", phoneNumberId: "777000111", wabaId: "555000111222", autoalta: true };

    it("R5: la prueba del secreto de su app viaja con la credencial hasta la consulta de la plantilla", async () => {
      const conPrueba = { ...PROPIA, prueba: "fake-proof-0123" };
      mockCredenciales.mockResolvedValue(conPrueba);
      mockEstadoDePlantilla.mockResolvedValue("pendiente");
      configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));

      await reenviarPedido(CTX as never, CASE_ID, false);

      expect(mockEstadoDePlantilla.mock.calls[0][2]).toBe(conPrueba);
    });

    it("R5: con Embedded Signup la consulta de la plantilla va sin prueba", async () => {
      mockEstadoDePlantilla.mockResolvedValue("pendiente");
      configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));

      await reenviarPedido(CTX as never, CASE_ID, false);

      expect(mockEstadoDePlantilla.mock.calls[0][2]).not.toHaveProperty("prueba");
    });

    it("la plantilla todavía sin aprobar no sale por WhatsApp: no manda, no reabre y no deja asiento", async () => {
      mockCredenciales.mockResolvedValue(PROPIA);
      mockEstadoDePlantilla.mockResolvedValue("pendiente");
      configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));

      const r = await reenviarPedido(CTX as never, CASE_ID, false);

      expect(r).toEqual({ ok: false, motivo: "plantilla_sin_aprobar" });
      expect(mockEstadoDePlantilla).toHaveBeenCalledWith("reabrir_denuncia", expect.any(String), PROPIA);
      expect(mockSend).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(mockWriteAuditLog).not.toHaveBeenCalled();
    });

    it("el mismo espacio por mail no mira la plantilla y sigue mandando", async () => {
      mockCredenciales.mockResolvedValue(PROPIA);
      configurarLecturas(filasBase({ channel: "email" }));
      configurarEscritura([{ id: CASE_ID }]);

      const r = await reenviarPedido(CTX as never, CASE_ID, false);

      expect(r).toEqual({ ok: true, claves: ["full_name"], reabierto: false });
      expect(mockEstadoDePlantilla).not.toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("con la plantilla ya aprobada en su WABA, sale por ella", async () => {
      mockCredenciales.mockResolvedValue(PROPIA);
      mockEstadoDePlantilla.mockResolvedValue("aprobada");
      configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));
      configurarEscritura([{ id: CASE_ID }]);

      const r = await reenviarPedido(CTX as never, CASE_ID, false);

      expect(r).toEqual({ ok: true, claves: ["full_name"], reabierto: false });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ porPlantilla: true }) })
      );
    });
  });

  it("sin plantilla disponible, el motivo sigue siendo ventana_cerrada", async () => {
    mockEstadoDePlantilla.mockResolvedValue("no_disponible");
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: false, motivo: "ventana_cerrada" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("con la prueba vencida no manda ni le pregunta a Meta: el motivo es tope_de_plantillas", async () => {
    mockCredenciales.mockResolvedValue({ ...CRED, autoalta: true, enPrueba: true, vencida: true });
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: false, motivo: "tope_de_plantillas" });
    expect(mockEstadoDePlantilla).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("con la prueba en curso y lugar en el día, sigue por la plantilla", async () => {
    mockCredenciales.mockResolvedValue({ ...CRED, autoalta: true, enPrueba: true, vencida: false });
    mockEstadoDePlantilla.mockResolvedValue("aprobada");
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));
    configurarEscritura([{ id: CASE_ID }]);

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: true, claves: ["full_name"], reabierto: false });
    expect(mockQuedaCupo).toHaveBeenCalledWith(TENANT_ID);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ porPlantilla: true }) })
    );
  });

  it("con la prueba en curso y el tope del día gastado, no reabre, no manda y no audita: tope_de_plantillas", async () => {
    mockCredenciales.mockResolvedValue({ ...CRED, autoalta: true, enPrueba: true, vencida: false });
    mockEstadoDePlantilla.mockResolvedValue("aprobada");
    mockQuedaCupo.mockResolvedValue(false);
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));
    configurarEscritura([{ id: CASE_ID }]);

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: false, motivo: "tope_de_plantillas" });
    expect(db.update).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("quien ya paga no mira el cupo de las pruebas", async () => {
    mockEstadoDePlantilla.mockResolvedValue("aprobada");
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));
    configurarEscritura([{ id: CASE_ID }]);

    await reenviarPedido(CTX as never, CASE_ID, false);

    expect(mockQuedaCupo).not.toHaveBeenCalled();
  });

  it("con la ventana abierta una prueba tampoco mira el cupo: no sale plantilla", async () => {
    mockCredenciales.mockResolvedValue({ ...CRED, autoalta: true, enPrueba: true, vencida: false });
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: new Date().toISOString() }));
    configurarEscritura([{ id: CASE_ID }]);

    await reenviarPedido(CTX as never, CASE_ID, false);

    expect(mockQuedaCupo).not.toHaveBeenCalled();
  });

  it("si Meta no contesta, el motivo es plantilla_sin_respuesta, no ventana_cerrada", async () => {
    mockEstadoDePlantilla.mockResolvedValue("sin_respuesta");
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: "2020-01-01T00:00:00.000Z" }));

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: false, motivo: "plantilla_sin_respuesta" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("con la ventana abierta, no consulta la plantilla y manda sin porPlantilla", async () => {
    configurarLecturas(filasBase({ channel: "whatsapp", ultimoEntrante: new Date().toISOString() }));
    configurarEscritura([{ id: CASE_ID }]);

    const r = await reenviarPedido(CTX as never, CASE_ID, false);

    expect(r).toEqual({ ok: true, claves: ["full_name"], reabierto: false });
    expect(mockEstadoDePlantilla).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ porPlantilla: true }) })
    );
  });
});
