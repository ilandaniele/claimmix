/**
 * `GET /api/metricas/export.csv` y `GET /api/metricas?periodo=`.
 *
 * El CSV sale de las mismas filas que la vista del historial, con los doce
 * meses siempre, números crudos (no «3 h») y sin datos de personas ni de casos.
 * El período de la API es el del tablero: cualquier otro valor cae al mes.
 */

vi.mock("server-only", () => ({}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AppError } from "@/lib/errors";
import { COLUMNAS_DEL_HISTORIAL, type FilaDeHistorial } from "@/core/metricas/ciclo";
import { getT } from "@/lib/i18n";

const { mockEntrar, mockEnTenant, mockKpis, mockRequireRole } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockEnTenant: vi.fn(),
  mockKpis: vi.fn(),
  mockRequireRole: vi.fn(),
}));

vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));
vi.mock("@/server/metrics/trayecto", () => ({ consultaDeHistorial: vi.fn() }));
vi.mock("@/lib/i18n/locale", () => ({ resolveAccountLocale: vi.fn().mockResolvedValue("es-AR") }));
vi.mock("@/server/metrics/kpis", () => ({ getTenantKpis: mockKpis }));
vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: mockRequireRole,
}));

import { GET as exportar } from "@/app/api/metricas/export.csv/route";
import { GET as metricas } from "@/app/api/metricas/route";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";

const junio: FilaDeHistorial = {
  mes: "2026-06",
  reclamos: 10,
  con_listo: 6,
  mediana_horas_listo: 2.46,
  con_cierre: 3,
  mediana_horas_cierre: 40,
  sin_intervencion: 4,
  mensajes_por_caso: 5.25,
  completados: 6,
  escalados: 2,
  cerrados: 3,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-15T15:00:00Z"));
  mockEntrar.mockResolvedValue({
    ctx: { userRow: { id: "u-1", tenant_id: TENANT_ID, role: "admin", locale: "es-AR" } },
    rl: { allowed: true, remaining: 10, retryAfterSeconds: 0 },
  });
  mockEnTenant.mockResolvedValue([junio]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("GET /api/metricas/export.csv", () => {
  it("devuelve un CSV descargable que no se guarda en ninguna caché", async () => {
    const res = await exportar();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="metricas_2026-09-15.csv"');
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("trae el encabezado, los doce meses y números crudos", async () => {
    const lineas = (await (await exportar()).text()).trim().split(/\r?\n/);

    expect(lineas).toHaveLength(13);
    expect(lineas[0]!.split(",")).toHaveLength(9);
    // Junio: reclamos, completados, % sin intervención (4/10), medianas y mensajes con un decimal.
    expect(lineas.find((l) => l.startsWith("2026-06"))).toBe("2026-06,10,6,40,2.5,40,5.3,2,3");
  });

  it("el encabezado sale de las mismas columnas que la tabla del historial", async () => {
    const [encabezado] = (await (await exportar()).text()).trim().split(/\r?\n/);

    expect(encabezado).toBe(COLUMNAS_DEL_HISTORIAL.map((c) => getT("es-AR")(c)).join(","));
  });

  it("un mes sin reclamos sale con ceros y celdas vacías, no con un 0 inventado", async () => {
    const lineas = (await (await exportar()).text()).trim().split(/\r?\n/);

    expect(lineas.find((l) => l.startsWith("2026-07"))).toBe("2026-07,0,0,,,,,0,0");
  });

  it("el rango que se lee es el de los últimos doce meses argentinos", async () => {
    await exportar();

    expect(mockEnTenant).toHaveBeenCalledTimes(1);
    expect(mockEnTenant.mock.calls[0]![0]).toEqual({ tenantId: TENANT_ID });
  });

  it("con un rol que no corresponde responde el error de la puerta", async () => {
    mockEntrar.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    const res = await exportar();

    expect(res.status).toBe(403);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("pasado el cupo responde 429 y no consulta", async () => {
    mockEntrar.mockResolvedValue({
      ctx: { userRow: { id: "u-1", tenant_id: TENANT_ID, role: "admin", locale: "es-AR" } },
      rl: { allowed: false, remaining: 0, retryAfterSeconds: 30 },
    });

    const res = await exportar();

    expect(res.status).toBe(429);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("si la consulta falla responde 500 sin contar por qué", async () => {
    mockEnTenant.mockRejectedValue(new Error("connection refused a 10.0.0.1"));

    const res = await exportar();

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("10.0.0.1");
  });
});

describe("GET /api/metricas — ?periodo=", () => {
  beforeEach(() => {
    mockRequireRole.mockResolvedValue({ userRow: { tenant_id: TENANT_ID } });
    mockKpis.mockResolvedValue({ summary: {} });
  });

  const pedir = (qs = "") => metricas(new Request(`http://localhost/api/metricas${qs}`));

  it("un período del tablero llega tal cual a los KPIs", async () => {
    await pedir("?periodo=mes_pasado");

    expect(mockKpis).toHaveBeenCalledWith({ tenantId: TENANT_ID }, { periodo: "mes_pasado" });
  });

  it("sin período, o con uno que el tablero no ofrece, es el mes en curso", async () => {
    await pedir();
    await pedir("?periodo=anio_pasado");
    await pedir("?periodo=drop%20table");

    expect(mockKpis.mock.calls.map((c) => c[1])).toEqual([
      { periodo: "este_mes" },
      { periodo: "este_mes" },
      { periodo: "este_mes" },
    ]);
  });
});
