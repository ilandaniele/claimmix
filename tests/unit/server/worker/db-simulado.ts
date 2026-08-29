/**
 * El `db` de mentira que usan los tests del worker de extracción.
 *
 * Estaba escrito tres veces —en `extract.email.bugfix`, `extract.email.security`
 * y `extract.email.gemini-error`— con entre setenta y ciento diez líneas cada
 * uno y diferencias que eran opciones, no comportamiento: qué fila de caso, qué
 * cuerpo de mensaje, y qué se anotaba de lo que se escribía.
 *
 * ── Lo que NO se puede compartir, y por qué ─────────────────────────────────
 *
 * Las llamadas a `vi.mock(...)` de esos archivos —veinte y pico cada uno— se
 * izan por encima de los imports, así que tienen que estar escritas literalmente
 * en cada archivo. No hay forma de moverlas a un módulo: un helper importado no
 * existe todavía cuando se ejecutan. Eso queda repetido y está bien que quede.
 *
 * Lo que sí se puede es esto: el armado de la cadena de drizzle, que es una
 * función común y corriente.
 *
 * No es un `.test.ts` a propósito: vitest junta `tests/unit/**\/*.test.ts`.
 */

import { vi } from "vitest";

export interface FilaDeCasoSimulada {
  id: string;
  status: string;
  claim_type: string | null;
  tenant_id: string;
  channel: string;
  email_thread_id: string | null;
  policyholder_name: string | null;
  policy_number: string | null;
}

export interface MensajeCrudoSimulado {
  body: string;
  subject: string;
  from_addr: string;
}

export interface OpcionesDbSimulado {
  /**
   * Columnas extra a propósito: hay tests que necesitan `created_at` y otros
   * que no, y la fila del caso tiene más columnas de las que a cualquiera de
   * ellos le importan.
   */
  caso?: Partial<FilaDeCasoSimulada> & Record<string, unknown>;
  mensaje?: Partial<MensajeCrudoSimulado>;
  /** Recibe cada `.set(...)` que se escriba sobre un caso. */
  alActualizar?: (datos: Record<string, unknown>) => void;
  /** Recibe cada `.values(...)` que se inserte. */
  alInsertar?: (valores: unknown) => void;
}

export function filaDeCasoSimulada(
  cambios: Partial<FilaDeCasoSimulada> & Record<string, unknown> = {}
): FilaDeCasoSimulada & Record<string, unknown> {
  return {
    id: "case-001",
    status: "recibido",
    claim_type: "choque",
    tenant_id: "tenant-001",
    channel: "email",
    email_thread_id: "thread-001",
    policyholder_name: null,
    policy_number: null,
    ...cambios,
  };
}

/**
 * Arma el `db` simulado.
 *
 * El orden de los SELECT es carga estructural: el worker pide primero la fila
 * del caso y después el mensaje crudo, y este mock responde POR POSICIÓN. Si
 * alguien reordena las consultas del worker, esto deja de alimentarlo y los
 * tests fallan de una forma que no dice por qué. Está escrito para que se sepa.
 */
export function construirDbSimulado(opciones: OpcionesDbSimulado = {}) {
  const { caso, mensaje, alActualizar, alInsertar } = opciones;

  const filaDeCaso = filaDeCasoSimulada(caso);
  const mensajeCrudo: MensajeCrudoSimulado = {
    body: "Test body",
    subject: "Test",
    from_addr: "test@example.com",
    ...mensaje,
  };

  let nSelect = 0;

  const mockSelect = vi.fn().mockImplementation(() => {
    nSelect++;
    const idx = nSelect;

    const limitFn = vi.fn().mockImplementation(() => {
      if (idx === 1) return Promise.resolve([filaDeCaso]);
      if (idx === 2) return Promise.resolve([mensajeCrudo]);
      return Promise.resolve([]);
    });

    const orderByFn = vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(() =>
        idx === 2 ? Promise.resolve([mensajeCrudo]) : Promise.resolve([])
      ),
    });

    const whereFn = vi.fn().mockReturnValue({ limit: limitFn, orderBy: orderByFn });
    const andWhereFn = vi.fn().mockReturnValue({
      limit: limitFn,
      orderBy: orderByFn,
      where: whereFn,
    });

    return { from: vi.fn().mockReturnValue({ where: andWhereFn }) };
  });

  const mockUpdate = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation((datos: Record<string, unknown>) => {
      alActualizar?.(datos);
      /*
       * `where()` es esperable Y encadenable, y las dos cosas hacen falta.
       *
       * El arriendo de la extracción lee `.returning()` para saber si ganó la
       * fila. Un mock que sólo resolvía hacía que cada corrida pareciera haber
       * perdido la carrera: el worker no hacía nada y el fallo parecía de la
       * extracción.
       */
      return {
        where: vi.fn().mockImplementation(() => {
          const resultado: Promise<unknown> & {
            returning?: () => Promise<unknown[]>;
          } = Promise.resolve({ rowCount: 1 });
          resultado.returning = () => Promise.resolve([{ id: filaDeCaso.id }]);
          return resultado;
        }),
      };
    }),
  }));

  const mockInsert = vi.fn().mockImplementation(() => ({
    values: vi.fn().mockImplementation((valores: unknown) => {
      alInsertar?.(valores);
      return {
        onConflictDoUpdate: vi.fn().mockResolvedValue({ rowCount: 1 }),
        onConflictDoNothing: vi.fn().mockResolvedValue({ rowCount: 0 }),
        returning: vi.fn().mockResolvedValue([]),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
      };
    }),
  }));

  return {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowCount: 0 }) }),
    $count: vi.fn().mockResolvedValue(0),
  };
}

/**
 * Reemplaza los métodos del `db` mockeado por los de uno recién armado.
 *
 * Va aparte de `construirDbSimulado` porque el `db` que se pisa lo tiene que
 * importar cada archivo de test: viene del `vi.mock("@/lib/db")` de ESE archivo,
 * y desde acá no se puede alcanzar.
 */
export function instalarDbSimulado(
  db: Record<string, unknown>,
  opciones: OpcionesDbSimulado = {}
) {
  const nuevo = construirDbSimulado(opciones);
  db.select = nuevo.select;
  db.insert = nuevo.insert;
  db.update = nuevo.update;
  db.delete = nuevo.delete;
  db.$count = nuevo.$count;
  return nuevo;
}
