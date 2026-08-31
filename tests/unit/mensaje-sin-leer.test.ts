/**
 * Un mensaje que llega a un caso del que el worker no vuelve a arrancar.
 *
 * El worker de correo tiene una lista corta de estados desde los que puede
 * empezar. Cuando llega un mensaje a un caso que quedó afuera de esa lista, el
 * mensaje se guarda y NO se lee, y la única huella era un `level: "info"`
 * suelto, igual a cualquier otra línea del log.
 *
 * ── Qué cubre esto HOY ───────────────────────────────────────────────────────
 *
 * El caso de `no_relevante` —alguien escribe «hola», queda clasificado como
 * no-denuncia, y después manda la denuncia de verdad— ya NO llega acá por
 * correo: `reabrirSiEraNoRelevante` devuelve el caso a `recibido` en el camino
 * de ingreso, antes de despachar. Ver `tests/unit/reabrir-no-relevante.test.ts`.
 *
 * Lo que sigue cayendo acá son los otros estados no reanudables —
 * `listo_para_core`, `enviado_a_core`, `cerrado`, `requiere_especialista`— y el
 * `no_relevante` que llegue por un camino que no sea el ingreso de correo (un
 * re-análisis a mano de un admin, un re-despacho). Para esos el mensaje sigue
 * sin leerse, y eso es deliberado: una persona es dueña de esos casos.
 *
 * Lo que NO es deliberado es que no se note. Ahora queda en `warn` y en la
 * AUDITORÍA del caso, que es donde una persona lo puede ver.
 *
 * Medido antes de escribir esto: en la base no hay todavía ningún caso con un
 * mensaje posterior a la última vez que se lo tocó. Es preventivo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/*
 * El primer caso de este archivo importa el grafo entero de
 * `runEmailExtractionWorker`. En una máquina ociosa eso son un par de segundos;
 * con el resto de la suite corriendo al lado pasa los 5 s de omisión y el test
 * falla por reloj sin que nada esté roto.
 *
 * Pasó exactamente eso: en verde sola, «Test timed out in 5000ms» dentro de la
 * suite completa. Es el mismo tratamiento que ya llevan `extract.overlay` y
 * `extract.status`, por la misma razón. Subir el tope acá y no globalmente deja
 * que un cuelgue de verdad en cualquier otro lado siga saltando rápido.
 */
vi.setConfig({ testTimeout: 30_000 });

const { mockAudit, mockSelect } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({ db: { select: mockSelect }, tables: {} }));

vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  return {
    enTenant: (_c: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar((mod as { db: unknown }).db)),
    enTenantVarias: (_c: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar((mod as { db: unknown }).db)),
  };
});

vi.mock("@/lib/db/helpers", () => ({
  firstRow: (rows: unknown[]) => rows[0] ?? null,
  ilikeAny: vi.fn(),
  countRows: vi.fn(),
}));

vi.mock("@/lib/audit/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/log")>()),
  writeAuditLog: mockAudit,
}));

const CASE = "bbbbbbbb-0000-0000-0000-000000000001";
const TENANT = "cccccccc-0000-0000-0000-000000000001";

/** El caso, en el estado que se le pase. Es el primer SELECT del worker. */
function elCasoEsta(status: string) {
  mockSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([{ id: CASE, status, tenant_id: TENANT }]),
      }),
    }),
  }));
}

async function correr() {
  const { runEmailExtractionWorker } = await import("@/server/worker/extract");
  await runEmailExtractionWorker(CASE, TENANT, null);
}

let dichos: string[];

beforeEach(() => {
  vi.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
  dichos = [];
  vi.spyOn(console, "warn").mockImplementation((...a) => {
    dichos.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("un mensaje a un caso que no se puede reabrir", () => {
  it("queda anotado en la auditoría del caso, donde una persona lo ve", async () => {
    elCasoEsta("no_relevante");

    await correr();

    const entrada = mockAudit.mock.calls.find(
      (c) => (c[0] as { event_type?: string })?.event_type === "claim.message_not_read"
    );
    expect(entrada).toBeDefined();
    expect((entrada![0] as { payload: { status: string } }).payload.status).toBe(
      "no_relevante"
    );
  });

  it("y en el log como aviso, no como una línea más", async () => {
    elCasoEsta("no_relevante");

    await correr();

    expect(dichos.join(" ")).toContain("email_worker.mensaje_sin_leer");
  });

  it("lo mismo para un caso ya listo para exportar", async () => {
    elCasoEsta("listo_para_core");

    await correr();

    expect(dichos.join(" ")).toContain("email_worker.mensaje_sin_leer");
  });

  it("pero un caso en un estado normal NO genera el aviso", async () => {
    /*
     * El control. Sin esto, un aviso que se escribiera siempre pasaría los tres
     * tests de arriba y llenaría la auditoría de todos los casos con una entrada
     * que no significa nada.
     */
    elCasoEsta("info_faltante");

    await correr();

    expect(dichos.join(" ")).not.toContain("email_worker.mensaje_sin_leer");
    const entrada = mockAudit.mock.calls.find(
      (c) => (c[0] as { event_type?: string })?.event_type === "claim.message_not_read"
    );
    expect(entrada).toBeUndefined();
  });
});
