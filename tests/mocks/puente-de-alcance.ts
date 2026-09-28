/**
 * El puente de alcance de los tests: `enTenant`/`enTenantVarias` sin RLS.
 *
 * Los tests unitarios mockean `@/lib/db` con cadenas encadenadas, y el `db`
 * real cambia por un getter; por eso `obtenerDb` se lee EN CADA llamada y no
 * al armar el puente. Es más permisivo que el módulo real a propósito —no pasa
 * por `exigirConsulta`— y `src/data/scope.ts` lo dice; lo que pasa por acá es
 * la lógica del caso, no la guarda de tenencia (esa la prueban los tests
 * `data-scope-*` contra el módulo de verdad).
 */
export type PuenteDeAlcance = {
  enTenant: (_ctx: unknown, armar: (db: unknown) => unknown) => Promise<unknown>;
  enTenantVarias: (_ctx: unknown, armar: (db: unknown) => unknown[]) => Promise<unknown[]>;
};

export function puenteDeAlcance(obtenerDb: () => unknown): PuenteDeAlcance {
  return {
    enTenant: (_ctx, armar) => Promise.resolve(armar(obtenerDb())),
    enTenantVarias: (_ctx, armar) => Promise.all(armar(obtenerDb())),
  };
}

/** La forma hoisted: para `vi.mock("@/data/scope", …)`, lee `db` de `@/lib/db` (mockeado o no) en cada llamada. */
export async function puenteSobreLibDb(): Promise<PuenteDeAlcance> {
  const mod = await import("@/lib/db");
  return puenteDeAlcance(() => mod.db);
}
