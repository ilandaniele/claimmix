/**
 * Drizzle `db` mock factory for unit/integration tests.
 *
 * Usage:
 *   vi.mock("@/lib/db", () => ({ db: makeMockDb(), tables: mockTables }));
 *
 * Then inside a test:
 *   vi.mocked(db.insert).mockReturnValue(makeChain(undefined));
 *   vi.mocked(db.select).mockReturnValue(makeChain([{ id: "x" }]));
 */

import { vi } from "vitest";

/**
 * Creates a thenable chain object that resolves to `returnValue`.
 * Supports: .from(), .where(), .orderBy(), .limit(), .leftJoin(),
 *           .innerJoin(), .set(), .values(), .returning()
 */
export function makeChain<T>(returnValue: T) {
  const chain: Record<string, unknown> & PromiseLike<T> = {
    then: (
      resolve?: ((v: T) => unknown) | null,
      reject?: ((e: unknown) => unknown) | null
    ) => Promise.resolve(returnValue).then(resolve, reject),
    catch: (fn?: ((e: unknown) => unknown) | null) =>
      Promise.resolve(returnValue).catch(fn ?? undefined),
    finally: (fn?: (() => void) | null) =>
      Promise.resolve(returnValue).finally(fn ?? undefined),
  } as unknown as Record<string, unknown> & PromiseLike<T>;

  const chainMethods = [
    "from",
    "where",
    "orderBy",
    "limit",
    "leftJoin",
    "innerJoin",
    "rightJoin",
    "fullJoin",
    "set",
    "values",
    "returning",
    "groupBy",
    "having",
    "offset",
    "for",
  ];
  for (const method of chainMethods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  return chain;
}

/** Convenience: chain that resolves to an empty array. */
export const emptyChain = () => makeChain<unknown[]>([]);

/**
 * Creates a mock `db` object. All builder methods return chainable mocks that
 * resolve to `[]` by default. Override per-test with `vi.mocked(db.X).mockReturnValue(...)`.
 */
export function makeMockDb() {
  const db = {
    select: vi.fn().mockReturnValue(emptyChain()),
    insert: vi.fn().mockReturnValue(makeChain<{ rowCount: number }>({ rowCount: 1 })),
    update: vi.fn().mockReturnValue(makeChain<{ rowCount: number }>({ rowCount: 1 })),
    delete: vi.fn().mockReturnValue(makeChain<{ rowCount: number }>({ rowCount: 0 })),
  };
  return db;
}

/** Stub tables object (Drizzle schema tables — just a no-op placeholder). */
export const mockTables = {};

/**
 * Call this in a `beforeEach` to reset all mocks on the db returned by `makeMockDb`.
 * This is NOT needed when using `vi.clearAllMocks()` globally.
 */
export function resetMockDb(db: ReturnType<typeof makeMockDb>) {
  db.select.mockReset().mockReturnValue(emptyChain());
  db.insert.mockReset().mockReturnValue(makeChain({ rowCount: 1 }));
  db.update.mockReset().mockReturnValue(makeChain({ rowCount: 1 }));
  db.delete.mockReset().mockReturnValue(makeChain({ rowCount: 0 }));
}
