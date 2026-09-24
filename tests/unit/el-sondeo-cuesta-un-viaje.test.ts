/**
 * El sondeo de la bandeja cuesta un viaje, no tres.
 *
 * `GET /api/cases` se sondea cada 5 a 30 segundos por pestaña abierta — es la
 * ruta que más corre del producto. Antes de esta rama, cada sondeo hacía TRES
 * idas a la base antes de llegar al listado: `requireRole` leía `users`,
 * `getUserRow` volvía a leer la MISMA fila, y `rateLimit` escribía el contador
 * aunque el pedido en sí no escribiera nada. Fallar acá es la regresión — el
 * sondeo volvió a costar tres viajes.
 *
 * Se cuenta en vez de medir latencia porque el p95 mide viajes de red: es
 * ruidoso al 2 % de corrida a corrida en esta máquina, y el arnés de
 * `pnpm load` ni siquiera pasa por la ruta HTTP — mide la consulta sola, no el
 * costo de la guarda que la antecede. Contar llamadas a la base simulada no
 * tiene ese ruido: o se llamó, o no.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockDb, mockGetSessionContext, mockEnTenantVarias } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), execute: vi.fn() },
  mockGetSessionContext: vi.fn(),
  mockEnTenantVarias: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({ db: mockDb, tables: {} }));

vi.mock("@/lib/auth/session", () => ({
  getSessionContext: mockGetSessionContext,
}));

// El viaje que hace `listCases`: conteo y datos van en un solo lote
// (`enTenantVarias`), así que contar las llamadas a este mock es contar el
// viaje real, no dos por separado.
vi.mock("@/data/scope", () => ({
  enTenant: vi.fn(),
  enTenantVarias: (...args: unknown[]) => mockEnTenantVarias(...args),
}));

// ── Imports (después de los mocks) ────────────────────────────────────────────

import { NextRequest } from "next/server";
import { olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { limpiarCreditos } from "@/lib/rate-limit/credito-local";

// ── Ayudas ────────────────────────────────────────────────────────────────────

const USER_ID = "user-uuid-001";
const TENANT_ID = "tenant-uuid-001";
const SAVED_ENV = { ...process.env };

function pedir(): NextRequest {
  return new NextRequest("http://localhost/api/cases", { method: "GET" });
}

function conSesion() {
  mockGetSessionContext.mockResolvedValue({
    user: { id: USER_ID, email: "test@example.com" },
  });
}

/** La fila de `users` que arma `filaDeUsuario` en cada cache miss. */
function conFilaDeUsuario() {
  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([
      { id: USER_ID, tenant_id: TENANT_ID, role: "admin", full_name: "Ana", locale: "es-AR", plan: "piloto" },
    ]),
  });
}

/** Lo que devuelve la escritura del contador: el total después de sumar el lote. */
function hits(n: number) {
  mockDb.execute.mockResolvedValueOnce({ rows: [{ hits: n }] });
}

function conListadoVacio() {
  mockEnTenantVarias.mockResolvedValue([[{ n: 0 }], []]);
}

/** Cuántas veces se tocó la base simulada, sumando las tres superficies. */
function viajesTocados(): number {
  return (
    mockDb.select.mock.calls.length +
    mockDb.execute.mock.calls.length +
    mockEnTenantVarias.mock.calls.length
  );
}

/** Un sondeo de la bandeja: llama a GET y devuelve cuántos viajes le costó. */
async function sondear(): Promise<number> {
  const antes = viajesTocados();
  const { GET } = await import("@/app/api/cases/route");
  const response = await GET(pedir() as never);
  // Un 500 no puede pasar por "barato": si la ruta revienta antes de tocar
  // todo lo que debería, el conteo miente a favor del test.
  expect(response.status).toBe(200);
  return viajesTocados() - antes;
}

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.execute.mockReset();
  mockEnTenantVarias.mockReset();
  mockGetSessionContext.mockReset();
  // Bajo vitest, NODE_ENV=test resuelve el limitador a memoria salvo que se
  // fuerce: acá se cuenta el camino de Postgres, que es el que la reserva de
  // a lotes existe para aliviar.
  process.env.RATE_LIMIT_PROVIDER = "postgres";
  // La fila de `users` y el crédito de rate-limit son mapas de proceso: sin
  // vaciarlos acá, el orden en que corren los describes cambia el resultado.
  olvidarFilaDeUsuario();
  limpiarCreditos();
  conSesion();
  conFilaDeUsuario();
  conListadoVacio();
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("el segundo sondeo consecutivo es más barato que el primero", () => {
  it("el primero paga tres viajes, el segundo uno solo", async () => {
    hits(5); // primera reserva del lote: carga cinco cupos de una sola escritura

    /*
     * Desglose del primer sondeo (tres viajes):
     *   1. `filaDeUsuario` — select de `users`, caché fría.
     *   2. `rateLimit` — insert…on conflict de `credito-local`, todavía sin
     *      lote reservado para esta clave.
     *   3. `listCases` — `enTenantVarias`, conteo y listado en un solo lote.
     */
    const primero = await sondear();
    expect(primero).toBe(3);

    /*
     * El segundo sondeo, misma sesión y misma instancia caliente:
     *   - la fila de `users` sigue en caché (TTL de 30 s sin vencer),
     *   - el lote de cinco créditos todavía tiene cuatro sin usar,
     *   así que el único viaje que queda es el real: el listado.
     */
    const segundo = await sondear();
    expect(segundo).toBe(1);
  });
});

describe("vaciar la caché de la fila de usuario la vuelve a cobrar", () => {
  it("después de olvidarFilaDeUsuario, el siguiente sondeo paga la fila otra vez", async () => {
    hits(5);
    await sondear(); // entibia la caché de la fila y reserva el lote de créditos

    olvidarFilaDeUsuario();

    /*
     * El lote de rate-limit no se tocó — sólo se vació la fila de usuario —
     * así que vuelve el viaje de `filaDeUsuario` pero NO el de la escritura
     * del contador: 1) select de `users` de nuevo, 2) `listCases`.
     */
    const tercero = await sondear();
    expect(tercero).toBe(2);
  });
});
