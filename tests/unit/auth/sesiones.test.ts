/**
 * `cerrarSesiones` borra las sesiones de un usuario y cuenta cuántas eran.
 *
 * Tira ante un error: la ruta de admin audita lo que devuelve, y un fallo que
 * se tragara como «0 sesiones» quedaría anotado como un éxito.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({ mockDb: { delete: vi.fn() } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: mockDb, tables: {} }));

import { cerrarSesiones } from "@/lib/auth/sesiones";
import { sessions } from "@/lib/db/schema";

function borrado(resultado: () => Promise<unknown[]>) {
  const tablas: unknown[] = [];
  mockDb.delete.mockImplementation((tabla: unknown) => {
    tablas.push(tabla);
    return { where: vi.fn().mockReturnValue({ returning: vi.fn().mockImplementation(resultado) }) };
  });
  return tablas;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cerrarSesiones", () => {
  it("borra de la tabla de sesiones y devuelve cuántas borró", async () => {
    const tablas = borrado(() => Promise.resolve([{ id: "s-1" }, { id: "s-2" }, { id: "s-3" }]));

    await expect(cerrarSesiones("user-001")).resolves.toBe(3);

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(tablas[0]).toBe(sessions);
  });

  it("sin sesiones abiertas devuelve cero", async () => {
    borrado(() => Promise.resolve([]));

    await expect(cerrarSesiones("user-001")).resolves.toBe(0);
  });

  it("si el borrado falla, propaga el error", async () => {
    const caida = new Error("se cayó la base");
    borrado(() => Promise.reject(caida));

    await expect(cerrarSesiones("user-001")).rejects.toBe(caida);
  });
});
