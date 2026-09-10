/**
 * Lo que el logger escribió, para los tests que comprueban qué NO se anota.
 *
 * Varias pruebas verifican que un log lleva el código del error y no el
 * mensaje, que puede traer datos de la persona adentro. Eso se hacía espiando
 * `console.error` a mano en cada archivo, y con `logger.warn` o `logger.info`
 * el espía apunta al método equivocado y no ve nada — un test así no falla:
 * pasa sin comprobar.
 *
 * Esto captura los cinco métodos. El contrato que se prueba es el mismo.
 */

import { vi, type MockInstance } from "vitest";

export interface LogsCapturados {
  /** Todo lo escrito, junto, para preguntarle `toContain`. */
  texto(): string;
  /** Cada línea ya parseada, para mirar un campo puntual. */
  lineas(): Array<Record<string, unknown>>;
  restaurar(): void;
}

const METODOS = ["error", "warn", "info", "log", "debug"] as const;

export function capturarLogs(): LogsCapturados {
  const escrito: string[] = [];

  const espias: MockInstance[] = METODOS.map((m) =>
    vi.spyOn(console, m).mockImplementation(((...args: unknown[]) => {
      escrito.push(args.map(String).join(" "));
    }) as never)
  );

  return {
    texto: () => escrito.join(" "),
    lineas: () =>
      escrito
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return {};
          }
        }),
    restaurar: () => espias.forEach((e) => e.mockRestore()),
  };
}
