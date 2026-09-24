/**
 * `filaDeUsuario` cachea por proceso la fila de `users` que antes leían por
 * separado `requireRole` y `getUserRow`. Lo que importa acá es que la caché
 * es por `userId`: nunca debe devolver, para un id, la fila de otro; nunca
 * debe cachear un miss (alta o baja recientes); y expira a los 30 s.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { select: mockSelect } }));
vi.mock("@/lib/db/schema", () => ({
  users: {
    id: "id",
    tenant_id: "tenant_id",
    role: "role",
    full_name: "full_name",
    locale: "locale",
  },
  tenants: { id: "id", plan: "plan" },
}));

import {
  filaDeUsuario,
  olvidarFilaDeUsuario,
  TTL_FILA_MS,
} from "@/lib/auth/fila-de-usuario-cacheada";

const FILA_A = {
  id: "u-a",
  tenant_id: "tenant-aaaa",
  role: "analyst",
  full_name: "Ana",
  locale: "es-AR",
  plan: "piloto",
};
const FILA_B = {
  id: "u-b",
  tenant_id: "tenant-bbbb",
  role: "admin",
  full_name: "Beto",
  locale: null,
  plan: "profesional",
};

/** La cadena de drizzle, devolviendo la fila que se le pase. */
function conFila(fila: unknown | null) {
  mockSelect.mockReturnValue({
    from: () => ({
      innerJoin: () => ({
        where: () => ({ limit: () => Promise.resolve(fila ? [fila] : []) }),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  olvidarFilaDeUsuario();
  conFila(FILA_A);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("filaDeUsuario", () => {
  it("la fila de un usuario nunca se sirve para el id de otro", async () => {
    conFila(FILA_A);
    const a = await filaDeUsuario("u-a");
    expect(a?.tenant_id).toBe(FILA_A.tenant_id);
    expect(a?.plan).toBe(FILA_A.plan);

    conFila(FILA_B);
    const b = await filaDeUsuario("u-b");
    expect(b?.tenant_id).toBe(FILA_B.tenant_id);
    expect(b?.plan).toBe(FILA_B.plan);

    // u-a sigue cacheado con SU fila, aunque el mock ahora devolvería la de u-b.
    const aDeNuevo = await filaDeUsuario("u-a");
    expect(aDeNuevo?.tenant_id).toBe(FILA_A.tenant_id);
    expect(aDeNuevo?.plan).toBe(FILA_A.plan);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("a los treinta segundos vuelve a consultar", async () => {
    vi.useFakeTimers();
    conFila(FILA_A);

    await filaDeUsuario("u-a");
    expect(mockSelect).toHaveBeenCalledTimes(1);

    await filaDeUsuario("u-a");
    expect(mockSelect).toHaveBeenCalledTimes(1); // todavía dentro del TTL

    vi.advanceTimersByTime(TTL_FILA_MS);
    await filaDeUsuario("u-a");
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("olvidarFilaDeUsuario(id) fuerza una consulta nueva", async () => {
    conFila(FILA_A);
    await filaDeUsuario("u-a");
    expect(mockSelect).toHaveBeenCalledTimes(1);

    olvidarFilaDeUsuario("u-a");
    await filaDeUsuario("u-a");
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("un usuario que no existe no se cachea", async () => {
    conFila(null);

    const primera = await filaDeUsuario("fantasma");
    const segunda = await filaDeUsuario("fantasma");

    expect(primera).toBeNull();
    expect(segunda).toBeNull();
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("olvidarFilaDeUsuario() sin argumento limpia todo", async () => {
    conFila(FILA_A);
    await filaDeUsuario("u-a");
    conFila(FILA_B);
    await filaDeUsuario("u-b");
    expect(mockSelect).toHaveBeenCalledTimes(2);

    olvidarFilaDeUsuario();

    await filaDeUsuario("u-a");
    await filaDeUsuario("u-b");
    expect(mockSelect).toHaveBeenCalledTimes(4);
  });

  it("dos llamadas seguidas para el mismo id hacen UNA sola consulta", async () => {
    conFila(FILA_A);
    await filaDeUsuario("u-a");
    await filaDeUsuario("u-a");
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});
