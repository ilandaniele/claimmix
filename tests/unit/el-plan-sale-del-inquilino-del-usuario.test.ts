/**
 * El plan de la sesión sale de un join contra `tenants` en la misma consulta
 * que la fila de `users`. Los mocks de cadena no miran contra qué columna se
 * hace el join: si apuntara a otra, el usuario no encontraría su inquilino y
 * todo Pro quedaría afuera de lo que pagó, con la suite en verde. Acá drizzle
 * arma la consulta de verdad sobre un driver que no conecta, y se lee el SQL.
 */
import { describe, it, expect, vi } from "vitest";

const { enviadas } = vi.hoisted(() => ({ enviadas: [] as string[] }));

vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return {
    db: drizzle(async (sql) => {
      enviadas.push(sql);
      return { rows: [["u-1", "t-1", "admin", "Ana", "es-AR", "profesional"]] };
    }),
  };
});

import { filaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";

describe("filaDeUsuario", () => {
  it("trae el plan del inquilino del usuario, en un solo viaje", async () => {
    const fila = await filaDeUsuario("u-1");

    expect(enviadas).toHaveLength(1);
    expect(enviadas[0]).toContain(
      'inner join "tenants" on "tenants"."id" = "users"."tenant_id"'
    );
    expect(fila?.plan).toBe("profesional");
  });
});
