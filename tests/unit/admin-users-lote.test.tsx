/**
 * El diálogo de invitar, ahora en lote: varias filas de nombre y correo, un solo rol, y un POST
 * por fila contra la ruta de siempre.
 *
 * Se prueba el comportamiento de la pantalla con `fetch` simulado: el orden y la
 * serialidad de los pedidos, qué hace cada respuesta (ok, 422, 429, red) y que
 * mientras envía el diálogo no se cierra. El contrato del servidor y el cupo en sí
 * los cubren `admin-users-invitacion.test.ts` y `tope-de-invitaciones.test.ts`.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminUsersClient } from "@/app/(app)/admin/users/AdminUsersClient";

interface Pedido {
  body: { full_name: string; email: string; role: string };
}

const ok = () => ({ ok: true, status: 202, json: async () => ({}) });
const fallo = (status: number, message: string, headers: Record<string, string> = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({ error: { message } }),
});

/** Una respuesta que el test suelta a mano, para ver qué pasa mientras el pedido sigue en vuelo. */
function pendiente() {
  let soltar!: (r: ReturnType<typeof ok>) => void;
  const promesa = new Promise<ReturnType<typeof ok>>((resolve) => (soltar = resolve));
  return { promesa, soltar };
}

const h = {
  posts: [] as Pedido[],
  listas: 0,
  /** Una por POST, en orden; si se acaban, ok. */
  respuestas: [] as Array<() => unknown>,
};

function simularFetch() {
  h.posts = [];
  h.listas = 0;
  h.respuestas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        h.posts.push({ body: JSON.parse(String(init.body)) });
        return (h.respuestas.shift() ?? ok)();
      }
      h.listas++;
      return { ok: true, status: 200, json: async () => ({ users: [] }) };
    })
  );
}

function abrir(topeDelLote = 5) {
  render(
    <AdminUsersClient
      initialUsers={[]}
      currentUserId="u-1"
      currentUserRole="admin"
      emailAyuda="Ayuda del correo"
      topeDelLote={topeDelLote}
    />
  );
  return userEvent.setup();
}

const abrirDialogo = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "+ Invitar usuario" }));

const dialogo = () => screen.getByRole("dialog", { name: "Invitar usuario" });
const enviar = () => within(dialogo()).getByRole("button", { name: "Invitar" });
const nombres = () => within(dialogo()).getAllByLabelText("Nombre completo") as HTMLInputElement[];
const correos = () => within(dialogo()).getAllByLabelText("Correo electrónico") as HTMLInputElement[];

/** Llena la fila `i` (empezando en 0). */
async function llenar(user: ReturnType<typeof userEvent.setup>, i: number, nombre: string, correo: string) {
  await user.type(nombres()[i]!, nombre);
  await user.type(correos()[i]!, correo);
}

async function agregarFilas(user: ReturnType<typeof userEvent.setup>, cuantas: number) {
  for (let i = 0; i < cuantas; i++) {
    await user.click(within(dialogo()).getByRole("button", { name: /Agregar otra persona/ }));
  }
}

beforeEach(simularFetch);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("el diálogo en lote", () => {
  it("arranca con una fila, el foco en su correo y sin botón de quitarla", async () => {
    const user = abrir();
    await abrirDialogo(user);

    expect(nombres()).toHaveLength(1);
    expect(document.activeElement).toBe(correos()[0]);
    expect(within(dialogo()).queryByRole("button", { name: /Quitar fila/ })).toBeNull();
    expect(within(dialogo()).getByText("Ayuda del correo")).toBeTruthy();
    expect(correos()[0]!.getAttribute("aria-describedby")).toBe("email-ayuda");
  });

  it("agrega filas hasta el tope del día y ahí deshabilita «Agregar»", async () => {
    const user = abrir(3);
    await abrirDialogo(user);
    const agregar = within(dialogo()).getByRole("button", { name: /Agregar otra persona/ });

    await user.click(agregar);
    expect(nombres()).toHaveLength(2);
    expect(agregar).toBeEnabled();

    await user.click(agregar);
    expect(nombres()).toHaveLength(3);
    expect(agregar).toBeDisabled();
  });

  it("quita una fila por su posición y conserva lo escrito en las demás", async () => {
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 2);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@example.com");
    await llenar(user, 2, "Carla Sosa", "carla@example.com");

    await user.click(within(dialogo()).getByRole("button", { name: "Quitar fila 2" }));

    expect(nombres().map((n) => n.value)).toEqual(["Ana Paz", "Carla Sosa"]);
    expect(correos().map((c) => c.value)).toEqual(["ana@example.com", "carla@example.com"]);
  });

  it("manda un POST por fila, en orden, con el mismo rol, y termina con un toast y un solo cierre", async () => {
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 2);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@example.com");
    await llenar(user, 2, "Carla Sosa", "carla@example.com");
    await user.selectOptions(within(dialogo()).getByLabelText("Rol"), "specialist");
    const listasAntes = h.listas;

    await user.click(enviar());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.posts.map((p) => p.body)).toEqual([
      { full_name: "Ana Paz", email: "ana@example.com", role: "specialist" },
      { full_name: "Beto Gil", email: "beto@example.com", role: "specialist" },
      { full_name: "Carla Sosa", email: "carla@example.com", role: "specialist" },
    ]);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe(
      "Invitaciones enviadas: 3. Rechazadas: 0. Sin cupo hoy: 0."
    );
    // Una sola recarga de la lista para todo el lote, no una por fila.
    expect(h.listas - listasAntes).toBe(1);
  });

  it("con una sola persona sigue diciendo lo de siempre", async () => {
    const user = abrir();
    await abrirDialogo(user);
    await llenar(user, 0, "Ana Paz", "ana@example.com");

    await user.click(enviar());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Invitación enviada. La persona aparece en la lista cuando la acepte.");
  });

  it("los pedidos van de a uno: el siguiente no sale hasta que vuelve el anterior", async () => {
    const primera = pendiente();
    h.respuestas = [() => primera.promesa];
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 1);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@example.com");

    await user.click(enviar());
    await waitFor(() => expect(h.posts).toHaveLength(1));
    // Se le da tiempo de sobra a un segundo pedido que no debería salir.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(h.posts).toHaveLength(1);

    await act(async () => primera.soltar(ok()));
    await waitFor(() => expect(h.posts).toHaveLength(2));
  });
});

describe("las respuestas del servidor", () => {
  it("un 400 marca su fila con el mensaje del servidor y el lote sigue: no tocó el cupo", async () => {
    h.respuestas = [ok, () => fallo(400, "Correo inválido."), ok];
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 2);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@example.com");
    await llenar(user, 2, "Carla Sosa", "carla@example.com");

    await user.click(enviar());

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(h.posts).toHaveLength(3);
    // El diálogo sigue abierto con la única fila que falló, y con lo que se escribió en ella.
    expect(dialogo()).toBeTruthy();
    expect(nombres().map((n) => n.value)).toEqual(["Beto Gil"]);
    expect(correos().map((c) => c.value)).toEqual(["beto@example.com"]);
    expect(within(dialogo()).getByRole("alert").textContent).toBe("Correo inválido.");
    expect(screen.getByRole("status").textContent).toBe(
      "Invitaciones enviadas: 2. Rechazadas: 1. Sin cupo hoy: 0."
    );
  });

  it("un 422 de dominio marca su fila y corta el lote: el servidor ya lo contó contra el cupo del día", async () => {
    h.respuestas = [ok, () => fallo(422, "Sólo podés invitar a gente de tu empresa.")];
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 2);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@otra.com");
    await llenar(user, 2, "Carla Sosa", "carla@example.com");

    await user.click(enviar());

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    // La tercera ni salió: seguir sería gastar una invitación por cada fila rechazada.
    expect(h.posts).toHaveLength(2);
    expect(nombres().map((n) => n.value)).toEqual(["Beto Gil", "Carla Sosa"]);
    expect(correos().map((c) => c.value)).toEqual(["beto@otra.com", "carla@example.com"]);
    const avisos = within(dialogo()).getAllByRole("alert");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.textContent).toBe("Sólo podés invitar a gente de tu empresa.");
    expect(screen.getByRole("status").textContent).toBe(
      "Invitaciones enviadas: 1. Rechazadas: 1. Sin cupo hoy: 0."
    );
  });

  it("una prueba con cinco direcciones ajenas gasta una sola invitación del día, no las cinco", async () => {
    h.respuestas = Array.from({ length: 5 }, () => () => fallo(422, "Sólo podés invitar a gente de tu empresa."));
    const user = abrir(5);
    await abrirDialogo(user);
    await agregarFilas(user, 4);
    for (let i = 0; i < 5; i++) await llenar(user, i, `Colega ${i}`, `colega${i}@gmail.com`);

    await user.click(enviar());

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(h.posts).toHaveLength(1);
    expect(nombres()).toHaveLength(5);
  });

  it("el primer 429 corta el lote: las que faltan quedan «sin cupo» y no se reintenta", async () => {
    h.respuestas = [ok, () => fallo(429, "Demasiados pedidos.", { "Retry-After": "43200" })];
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 3);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@example.com");
    await llenar(user, 2, "Carla Sosa", "carla@example.com");
    await llenar(user, 3, "Dani Roca", "dani@example.com");

    await user.click(enviar());

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    // El segundo pedido recibió el 429; el tercero y el cuarto ni salieron.
    expect(h.posts).toHaveLength(2);
    expect(nombres().map((n) => n.value)).toEqual(["Beto Gil", "Carla Sosa", "Dani Roca"]);
    const avisos = within(dialogo()).getAllByRole("alert");
    expect(avisos).toHaveLength(3);
    for (const aviso of avisos) expect(aviso.textContent).toBe("Se agotaron las invitaciones del día. Probá de nuevo más tarde.");
    expect(screen.getByRole("status").textContent).toBe(
      "Invitaciones enviadas: 1. Rechazadas: 0. Sin cupo hoy: 3."
    );
  });

  it("un 429 de pocos segundos (contador caído) no se pinta como «sin cupo hoy»: usa el mensaje del servidor", async () => {
    h.respuestas = [ok, () => fallo(429, "Demasiadas solicitudes. Esperá un momento.", { "Retry-After": "60" })];
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 2);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@example.com");
    await llenar(user, 2, "Carla Sosa", "carla@example.com");

    await user.click(enviar());

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    // Sigue cortando: el tercero ni salió.
    expect(h.posts).toHaveLength(2);
    expect(nombres().map((n) => n.value)).toEqual(["Beto Gil", "Carla Sosa"]);
    const avisos = within(dialogo()).getAllByRole("alert");
    expect(avisos).toHaveLength(2);
    for (const aviso of avisos) expect(aviso.textContent).toBe("Demasiadas solicitudes. Esperá un momento.");
    expect(screen.getByRole("status").textContent).toBe(
      "Invitaciones enviadas: 1. Rechazadas: 2. Sin cupo hoy: 0."
    );
  });

  it("un error de red corta el lote sin reintentar", async () => {
    h.respuestas = [
      () => {
        throw new TypeError("fake-red-caida");
      },
    ];
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 1);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@example.com");

    await user.click(enviar());

    await waitFor(() => expect(within(dialogo()).getByRole("alert")).toBeTruthy());
    expect(h.posts).toHaveLength(1);
    expect(within(dialogo()).getByRole("alert").textContent).toBe("Error de red. Intentá de nuevo.");
    expect(nombres()).toHaveLength(2);
  });

  it("un error que no habla de la fila (403, 502) corta el lote en vez de repetirse en cada una", async () => {
    h.respuestas = [() => fallo(502, "No se pudo enviar el correo.")];
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 1);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@example.com");

    await user.click(enviar());

    await waitFor(() => expect(within(dialogo()).getByRole("alert")).toBeTruthy());
    expect(h.posts).toHaveLength(1);
  });

  it("un correo repetido en otra fila no se invita dos veces", async () => {
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 1);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Ana de nuevo", "ANA@example.com");

    await user.click(enviar());

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(h.posts).toHaveLength(1);
    expect(within(dialogo()).getByRole("alert").textContent).toBe(
      "Correo repetido: ya está en otra fila o ya se invitó."
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Invitaciones enviadas: 1. Rechazadas: 1. Sin cupo hoy: 0."
    );
  });

  it("al reenviar un lote partido, lo que ya se aceptó no vuelve a salir", async () => {
    h.respuestas = [ok, () => fallo(422, "Dominio no permitido.")];
    const user = abrir();
    await abrirDialogo(user);
    await agregarFilas(user, 1);
    await llenar(user, 0, "Ana Paz", "ana@example.com");
    await llenar(user, 1, "Beto Gil", "beto@otra.com");
    await user.click(enviar());
    await waitFor(() => expect(h.posts).toHaveLength(2));
    await waitFor(() => expect(enviar()).toBeEnabled());

    // Se arregla la fila 2 y se agrega otra con la dirección que ya se había invitado.
    await user.clear(correos()[0]!);
    await user.type(correos()[0]!, "beto@example.com");
    await agregarFilas(user, 1);
    await llenar(user, 1, "Ana otra vez", "ana@example.com");
    await user.click(enviar());

    await waitFor(() => expect(h.posts).toHaveLength(3));
    expect(h.posts[2]!.body.email).toBe("beto@example.com");
  });
});

describe("mientras envía", () => {
  it("no se puede cerrar ni con Escape ni con Cancelar, y se apaga todo lo que se edita", async () => {
    const lenta = pendiente();
    h.respuestas = [() => lenta.promesa];
    const user = abrir();
    await abrirDialogo(user);
    await llenar(user, 0, "Ana Paz", "ana@example.com");

    await user.click(enviar());
    await waitFor(() => expect(h.posts).toHaveLength(1));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialogo()).toBeTruthy();
    expect(within(dialogo()).getByRole("button", { name: "Cancelar" })).toBeDisabled();
    expect(within(dialogo()).getByRole("button", { name: /Agregar otra persona/ })).toBeDisabled();
    expect(within(dialogo()).getByLabelText("Rol")).toBeDisabled();
    expect(nombres()[0]).toBeDisabled();
    expect(correos()[0]).toBeDisabled();
    expect(within(dialogo()).getByRole("button", { name: "Invitando..." })).toBeDisabled();

    await act(async () => lenta.soltar(ok()));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("apretar «Invitar» dos veces no manda el lote dos veces", async () => {
    const lenta = pendiente();
    h.respuestas = [() => lenta.promesa];
    const user = abrir();
    await abrirDialogo(user);
    await llenar(user, 0, "Ana Paz", "ana@example.com");

    const form = enviar().closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(h.posts).toHaveLength(1));
    await act(async () => lenta.soltar(ok()));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.posts).toHaveLength(1);
  });

  it("fuera de un envío, Escape y Cancelar cierran sin mandar nada", async () => {
    const user = abrir();
    await abrirDialogo(user);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await abrirDialogo(user);
    await user.click(within(dialogo()).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.posts).toHaveLength(0);
  });
});
