/**
 * G36: el agrupado del tablero de la bandeja usa la misma partición que ya
 * usan el panel de filtros y sus contadores (`ESTADOS_DE_LA_OPCION`).
 */

import { describe, it, expect } from "vitest";
import { agruparEnColumnas } from "@/core/case/tablero";

interface Fila {
  id: string;
  status: string;
}

function fila(id: string, status: string): Fila {
  return { id, status };
}

describe("agruparEnColumnas", () => {
  it("recibido va a la columna procesando", () => {
    const { columnas, fuera } = agruparEnColumnas([fila("1", "recibido")]);
    expect(columnas.procesando).toEqual([fila("1", "recibido")]);
    expect(fuera).toBe(0);
  });

  it("requiere_especialista va a la columna escalado", () => {
    const { columnas } = agruparEnColumnas([fila("1", "requiere_especialista")]);
    expect(columnas.escalado).toEqual([fila("1", "requiere_especialista")]);
  });

  it("no_relevante no entra en ninguna columna: cuenta en fuera", () => {
    const { columnas, fuera } = agruparEnColumnas([fila("1", "no_relevante")]);
    expect(fuera).toBe(1);
    expect(Object.values(columnas).every((c) => c.length === 0)).toBe(true);
  });

  it("las seis columnas existen aunque no haya filas para todas", () => {
    const { columnas } = agruparEnColumnas([fila("1", "recibido")]);
    expect(Object.keys(columnas).sort()).toEqual(
      ["cerrado", "confirmacion_pendiente", "escalado", "esperando", "listo", "procesando"].sort()
    );
  });

  it("un caso no cae en dos columnas a la vez", () => {
    const { columnas } = agruparEnColumnas([
      fila("1", "escalado"),
      fila("2", "requiere_especialista"),
    ]);
    expect(columnas.escalado).toHaveLength(2);
    for (const clave of Object.keys(columnas) as (keyof typeof columnas)[]) {
      if (clave !== "escalado") expect(columnas[clave]).toHaveLength(0);
    }
  });
});
