/**
 * «Eliminar» en /admin/users: el botón aparece sólo en la fila de quien ya está
 * dado de baja, pide confirmación nombrando a la persona y borra con
 * DELETE /api/admin/users/:id/cuenta. Los textos llegan por prop desde el
 * servidor (el diccionario del cliente no los tiene).
 *
 * Qué se puede borrar de verdad lo decide el servidor
 * (tests/unit/api/admin-users-eliminar.test.ts); acá, que la pantalla muestre el
 * botón donde corresponde y haga lo que la respuesta indica.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminUsersClient, type TextosEliminar } from "@/app/(app)/admin/users/AdminUsersClient";

const TEXTOS: TextosEliminar = {
  boton: "Eliminar",
  confirmar: "¿Eliminar a {nombre}? No se puede deshacer.",
  hecho: "Cuenta eliminada.",
  error: "No se pudo eliminar la cuenta.",
};

const BAJA = "2026-10-01T00:00:00.000Z";
const USUARIOS = [
  { id: "u-1", full_name: "Yo Admin", email: "yo@example.com", role: "admin", created_at: BAJA, dado_de_baja_en: null },
  { id: "u-2", full_name: "Ana Activa", email: "ana@example.com", role: "analyst", created_at: BAJA, dado_de_baja_en: null },
  { id: "u-3", full_name: "Beto Baja", email: "beto@example.com", role: "analyst", created_at: BAJA, dado_de_baja_en: BAJA },
  { id: "u-4", full_name: "Olga Owner", email: "olga@example.com", role: "owner", created_at: BAJA, dado_de_baja_en: BAJA },
];

const respuesta = (status: number, cuerpo: object = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => cuerpo,
});

const h = {
  /** Cada DELETE: la URL y el método. */
  borrados: [] as Array<{ url: string; method?: string }>,
  /** Lo que contesta el DELETE. */
  borrado: () => respuesta(200, { eliminado: "u-3" }) as unknown,
};

function simularFetch() {
  h.borrados = [];
  h.borrado = () => respuesta(200, { eliminado: "u-3" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        h.borrados.push({ url, method: init.method });
        return h.borrado();
      }
      return respuesta(200, { users: USUARIOS });
    })
  );
}

async function abrir(rol = "admin") {
  const user = userEvent.setup();
  render(
    <AdminUsersClient
      initialUsers={USUARIOS as never}
      currentUserId="u-1"
      currentUserRole={rol}
      emailAyuda="Ayuda"
      textosEliminar={TEXTOS}
      topeDelLote={5}
    />
  );
  await waitFor(() => expect(screen.getByText("Beto Baja")).toBeInTheDocument());
  return user;
}

const botonDe = (nombre: string) => screen.queryByRole("button", { name: `Eliminar ${nombre}` });

let confirmar: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  simularFetch();
  confirmar = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dónde aparece «Eliminar»", () => {
  it("sólo en la fila de quien ya está dado de baja", async () => {
    await abrir();

    expect(botonDe("Beto Baja")).toBeInTheDocument();
    expect(botonDe("Ana Activa")).toBeNull();
  });

  it("no en la fila propia", async () => {
    await abrir();

    expect(botonDe("Yo Admin")).toBeNull();
  });

  it("un admin no ve el botón en un owner; un owner sí", async () => {
    await abrir("admin");
    expect(botonDe("Olga Owner")).toBeNull();
  });

  it("un owner sí lo ve en otro owner dado de baja", async () => {
    await abrir("owner");
    expect(botonDe("Olga Owner")).toBeInTheDocument();
  });

  it("el rótulo del botón nombra a la persona, para los lectores de pantalla", async () => {
    await abrir();

    expect(screen.getByRole("button", { name: "Eliminar Beto Baja" })).toHaveTextContent("Eliminar");
  });
});

describe("eliminar", () => {
  it("pide confirmación nombrando a la persona; si se cancela no manda nada", async () => {
    confirmar.mockReturnValue(false);
    const user = await abrir();

    await user.click(botonDe("Beto Baja")!);

    expect(confirmar).toHaveBeenCalledWith("¿Eliminar a Beto Baja? No se puede deshacer.");
    expect(h.borrados).toEqual([]);
    expect(screen.getByText("Beto Baja")).toBeInTheDocument();
  });

  it("confirmado, manda DELETE a /cuenta, saca la fila y avisa", async () => {
    const user = await abrir();

    await user.click(botonDe("Beto Baja")!);

    await waitFor(() => expect(screen.queryByText("Beto Baja")).toBeNull());
    expect(h.borrados).toEqual([{ url: "/api/admin/users/u-3/cuenta", method: "DELETE" }]);
    expect(screen.getByText("Cuenta eliminada.")).toBeInTheDocument();
    expect(screen.getByText("Ana Activa")).toBeInTheDocument();
  });

  it("un 404 (ya no estaba) también saca la fila", async () => {
    h.borrado = () => respuesta(404, { error: { code: "NOT_FOUND", message: "no existe" } });
    const user = await abrir();

    await user.click(botonDe("Beto Baja")!);

    await waitFor(() => expect(screen.queryByText("Beto Baja")).toBeNull());
  });

  it("un 409 muestra el motivo del servidor y deja la fila", async () => {
    h.borrado = () => respuesta(409, { error: { code: "CONFLICT", message: "Sólo se puede eliminar a quien ya está dado de baja." } });
    const user = await abrir();

    await user.click(botonDe("Beto Baja")!);

    expect(await screen.findByText("Sólo se puede eliminar a quien ya está dado de baja.")).toBeInTheDocument();
    expect(screen.getByText("Beto Baja")).toBeInTheDocument();
    expect(screen.queryByText("Cuenta eliminada.")).toBeNull();
  });

  it("una falla de red muestra el texto de error y deja la fila", async () => {
    h.borrado = () => {
      throw new Error("sin red");
    };
    const user = await abrir();

    await user.click(botonDe("Beto Baja")!);

    expect(await screen.findByText("No se pudo eliminar la cuenta.")).toBeInTheDocument();
    expect(screen.getByText("Beto Baja")).toBeInTheDocument();
  });
});

describe("mientras se elimina", () => {
  // «Habilitando…» es de habilitar: el botón vecino queda quieto, no cambia de rótulo.
  it("el botón Habilitar de la fila queda deshabilitado pero no dice «Habilitando...»", async () => {
    let soltar: (r: unknown) => void = () => {};
    h.borrado = () => new Promise((resolver) => (soltar = resolver));
    const user = await abrir();
    const fila = screen.getByText("Beto Baja").closest("tr")!;

    await user.click(botonDe("Beto Baja")!);

    await waitFor(() => expect(botonDe("Beto Baja")).toBeDisabled());
    const habilitar = within(fila).getByRole("button", { name: "Habilitar" });
    expect(habilitar).toBeDisabled();
    expect(within(fila).queryByText("Habilitando...")).toBeNull();

    soltar(respuesta(200, { eliminado: "u-3" }));
    await waitFor(() => expect(screen.queryByText("Beto Baja")).toBeNull());
  });

  it("no toca los botones de las otras filas", async () => {
    h.borrado = () => new Promise(() => {});
    const user = await abrir("owner");

    await user.click(botonDe("Beto Baja")!);

    await waitFor(() => expect(botonDe("Beto Baja")).toBeDisabled());
    expect(botonDe("Olga Owner")).toBeEnabled();
  });
});
