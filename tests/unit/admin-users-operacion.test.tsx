/**
 * /admin/users en el espacio de la casa: el aviso «Este es el equipo de Veltra (operación)…» con el
 * enlace a Altas, y el rótulo «Operación» en las cuentas que operan.
 *
 * Los dos se ven SÓLO si el espacio es el de la casa (`resolveDefaultTenantId`, nunca un id a mano) Y
 * quien mira es operador según `esOperadorDe`, la misma regla de la barra lateral: dirección verificada,
 * en `ADMIN_EMAILS` y espacio de la casa. Un cliente no ve ni uno ni otro, ni siquiera con una dirección
 * de `ADMIN_EMAILS` que alguien agregó para probar. La regla en sí se prueba en su propio test; acá se
 * prueba que la pantalla la usa y que a un cliente no le llega nada de esto.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: vi.fn(),
  casa: vi.fn(),
  locale: vi.fn(),
  filas: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/rebotar-si-no-entra", () => ({
  rebotarSiNoEntra: (e: unknown) => {
    throw e;
  },
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: h.admin }));
vi.mock("@/lib/auth/provision", () => ({ resolveDefaultTenantId: h.casa }));
// La consulta ya trae su propio test; acá las filas son las que devolvería.
vi.mock("@/data/scope", () => ({ enTenant: async () => h.filas }));
vi.mock("@/server/alta/tope-de-invitaciones", () => ({ topeDeInvitacionesDelDia: () => 5 }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: h.locale }));

import AdminUsersPage from "@/app/(app)/admin/users/page";
import { AdminUsersClient } from "@/app/(app)/admin/users/AdminUsersClient";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";

const CASA = "11111111-1111-4111-8111-111111111111";
const CLIENTE = "22222222-2222-4222-8222-222222222222";
const ALTA = "2026-10-01T00:00:00.000Z";

const OPERADOR = "operador@example.com";

const fila = (id: string, nombre: string, email: string, cambios: Record<string, unknown> = {}) => ({
  id,
  full_name: nombre,
  role: "admin",
  created_at: ALTA,
  dado_de_baja_en: null,
  email,
  emailVerified: true,
  ...cambios,
});

/** Quien mira la pantalla y el espacio en el que está: `requireAdmin` ya validó el rol. */
function entrar(email: string, tenantId: string, emailVerified = true) {
  h.admin.mockResolvedValue({
    user: { id: "u-yo", email, emailVerified },
    userRow: { id: "u-yo", tenant_id: tenantId, role: "admin" },
  });
}

/** El cliente vuelve a pedir la lista al montar: contesta las mismas filas que trajo el servidor. */
function simularFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ users: h.filas }) }))
  );
}

async function pintar(locale: "es-AR" | "en-US" = "es-AR") {
  h.locale.mockResolvedValue(locale);
  const vista = render(await AdminUsersPage());
  await waitFor(() => expect(screen.getByText(String(h.filas[0].full_name))).toBeInTheDocument());
  return vista;
}

const filaDe = (nombre: string) => screen.getByText(nombre).closest("tr") as HTMLElement;
const aviso = () => screen.queryByRole("note");

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", OPERADOR);
  h.casa.mockReturnValue(CASA);
  h.filas = [
    fila("u-yo", "Yo Operador", OPERADOR, { role: "owner" }),
    fila("u-2", "Ana Analista", "ana@example.com", { role: "analyst" }),
    fila("u-3", "Otro Operador", "Operador@Example.com"),
    fila("u-4", "Sin Verificar", OPERADOR, { emailVerified: false }),
  ];
  simularFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("el espacio de la casa, visto por quien opera", () => {
  it("avisa que es el equipo de Veltra y manda a Altas, con el enlace dentro de la frase", async () => {
    entrar(OPERADOR, CASA);

    await pintar();

    const nota = screen.getByRole("note");
    expect(nota).toHaveTextContent("Este es el equipo de Veltra (operación). Los equipos de cada cliente están en Altas.");
    expect(within(nota).getByRole("link", { name: "Altas" })).toHaveAttribute("href", "/admin/altas");
  });

  it("rotula «Operación» en las cuentas que operan, y sólo en ésas", async () => {
    entrar(OPERADOR, CASA);

    await pintar();

    expect(within(filaDe("Yo Operador")).getByText("Operación")).toBeInTheDocument();
    expect(within(filaDe("Otro Operador")).getByText("Operación")).toBeInTheDocument();
    expect(within(filaDe("Ana Analista")).queryByText("Operación")).toBeNull();
  });

  it("una cuenta con la dirección del operador pero sin verificar no se rotula: es la regla de esOperadorDe", async () => {
    entrar(OPERADOR, CASA);

    await pintar();

    expect(within(filaDe("Sin Verificar")).queryByText("Operación")).toBeNull();
  });

  it("una cuenta de operador dada de baja no se rotula: ya no entra, y lo que explica la fila es la baja", async () => {
    entrar(OPERADOR, CASA);
    h.filas = [...h.filas, fila("u-5", "Operador De Baja", OPERADOR, { dado_de_baja_en: ALTA })];

    await pintar();

    expect(within(filaDe("Operador De Baja")).getByText("De baja")).toBeInTheDocument();
    expect(within(filaDe("Operador De Baja")).queryByText("Operación")).toBeNull();
    expect(within(filaDe("Yo Operador")).getByText("Operación")).toBeInTheDocument();
  });

  it("en inglés", async () => {
    entrar(OPERADOR, CASA);

    await pintar("en-US");

    expect(screen.getByRole("note")).toHaveTextContent(
      "This is the Veltra team (operations). Each client's team is under Sign-ups."
    );
    expect(within(filaDe("Yo Operador")).getByText("Operations")).toBeInTheDocument();
  });

  it("en inglés, la cuenta de operador dada de baja tampoco se rotula", async () => {
    entrar(OPERADOR, CASA);
    h.filas = [...h.filas, fila("u-5", "Operador De Baja", OPERADOR, { dado_de_baja_en: ALTA })];

    await pintar("en-US");

    // «Eliminar» sólo sale en la fila de quien está dado de baja, y su texto llega del servidor en el idioma de la cuenta.
    expect(within(filaDe("Operador De Baja")).getByText("Delete")).toBeInTheDocument();
    expect(within(filaDe("Operador De Baja")).queryByText("Operations")).toBeNull();
  });

  it("los textos son los del diccionario, no copias en la pantalla", async () => {
    entrar(OPERADOR, CASA);

    await pintar();

    expect(esARServidor["usuarios.operacion.rotulo"]).toBe("Operación");
    expect(enUSServidor["usuarios.operacion.rotulo"]).toBe("Operations");
    expect(within(filaDe("Yo Operador")).getByText(esARServidor["usuarios.operacion.rotulo"])).toBeInTheDocument();
  });
});

describe("quien no es operador del espacio de la casa no ve nada de esto", () => {
  it("el admin de un cliente, en su espacio, no ve el aviso ni el rótulo", async () => {
    entrar("jefe@cliente.example.com", CLIENTE);
    h.filas = [fila("u-yo", "Jefa Cliente", "jefe@cliente.example.com", { role: "owner" }), fila("u-2", "Beto Analista", "beto@cliente.example.com", { role: "analyst" })];

    await pintar();

    expect(aviso()).toBeNull();
    expect(screen.queryByText("Operación")).toBeNull();
    expect(screen.queryByRole("link", { name: "Altas" })).toBeNull();
  });

  it("una dirección de ADMIN_EMAILS en el espacio de un cliente (alguien la agregó para probar) tampoco", async () => {
    entrar(OPERADOR, CLIENTE);

    await pintar();

    expect(aviso()).toBeNull();
    expect(screen.queryByText("Operación")).toBeNull();
  });

  it("un cliente tampoco ve el rótulo en la cuenta de otra persona aunque esa tenga una dirección de operador", async () => {
    entrar("jefe@cliente.example.com", CLIENTE);
    h.filas = [fila("u-yo", "Jefa Cliente", "jefe@cliente.example.com"), fila("u-2", "Persona Rara", OPERADOR)];

    await pintar();

    expect(aviso()).toBeNull();
    expect(screen.queryByText("Operación")).toBeNull();
  });

  it("en la casa pero con la dirección sin verificar no es operador: ni aviso ni rótulo", async () => {
    entrar(OPERADOR, CASA, false);

    await pintar();

    expect(aviso()).toBeNull();
    expect(screen.queryByText("Operación")).toBeNull();
  });

  it("en la casa pero sin estar en ADMIN_EMAILS tampoco", async () => {
    entrar("otra@example.com", CASA);

    await pintar();

    expect(aviso()).toBeNull();
    expect(screen.queryByText("Operación")).toBeNull();
  });

  it("sin espacio de la casa configurado falla cerrado: nadie lo ve", async () => {
    h.casa.mockReturnValue(null);
    entrar(OPERADOR, CASA);

    await pintar();

    expect(aviso()).toBeNull();
    expect(screen.queryByText("Operación")).toBeNull();
  });

  it("la casa sale de resolveDefaultTenantId: si es otro espacio, el mismo operador en CASA ya no lo ve", async () => {
    h.casa.mockReturnValue(CLIENTE);
    entrar(OPERADOR, CASA);

    await pintar();

    expect(aviso()).toBeNull();
    expect(h.casa).toHaveBeenCalled();
  });
});

describe("cómo está armada la pantalla", () => {
  const leer = (ruta: string) => readFileSync(join(process.cwd(), ruta), "utf8");

  it("la página decide con esOperadorDe y no con un espacio ni una dirección escritos a mano", () => {
    const fuente = leer("src/app/(app)/admin/users/page.tsx");

    expect(fuente).toContain("esOperadorDe(ctx.user, userRow.tenant_id)");
    expect(fuente).toContain("esOperadorDe(r, userRow.tenant_id)");
    expect(fuente).not.toMatch(/ADMIN_EMAILS|operatorEmails|isOperatorEmail/);
    expect(fuente).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("el cliente del navegador recibe sólo los ids a rotular: no sabe quién es operador ni lee ADMIN_EMAILS", () => {
    const fuente = leer("src/app/(app)/admin/users/AdminUsersClient.tsx");

    expect(fuente).not.toMatch(/ADMIN_EMAILS|operatorEmails|isOperatorEmail|esOperadorDe/);
  });
});

describe("AdminUsersClient con y sin la prop de operación", () => {
  const USUARIOS = [
    { id: "u-1", full_name: "Yo Admin", email: "yo@example.com", role: "admin", created_at: ALTA, dado_de_baja_en: null },
    { id: "u-2", full_name: "Ana Operadora", email: "ana@example.com", role: "analyst", created_at: ALTA, dado_de_baja_en: null },
  ];

  function abrir(operacion?: { rotulo: string; ids: string[] }) {
    return render(
      <AdminUsersClient
        initialUsers={USUARIOS as never}
        currentUserId="u-1"
        currentUserRole="admin"
        emailAyuda="Ayuda"
        textosEliminar={{ boton: "Eliminar", confirmar: "¿Eliminar a {nombre}?", hecho: "Hecho.", error: "Error." }}
        topeDelLote={5}
        operacion={operacion}
      />
    );
  }

  it("sin la prop (un cliente) no hay rótulo en ninguna fila", () => {
    abrir();

    expect(screen.queryByText("Operación")).toBeNull();
  });

  it("con la prop rotula sólo los ids que le pasaron", () => {
    abrir({ rotulo: "Operación", ids: ["u-2"] });

    expect(within(filaDe("Ana Operadora")).getByText("Operación")).toBeInTheDocument();
    expect(within(filaDe("Yo Admin")).queryByText("Operación")).toBeNull();
  });

  it("una cuenta rotulada que ya está dada de baja no lleva el rótulo", () => {
    const baja = USUARIOS.map((u) => (u.id === "u-2" ? { ...u, dado_de_baja_en: ALTA } : u));
    render(
      <AdminUsersClient
        initialUsers={baja as never}
        currentUserId="u-1"
        currentUserRole="admin"
        emailAyuda="Ayuda"
        textosEliminar={{ boton: "Eliminar", confirmar: "¿Eliminar a {nombre}?", hecho: "Hecho.", error: "Error." }}
        topeDelLote={5}
        operacion={{ rotulo: "Operación", ids: ["u-2"] }}
      />
    );

    expect(within(filaDe("Ana Operadora")).getByText("De baja")).toBeInTheDocument();
    expect(within(filaDe("Ana Operadora")).queryByText("Operación")).toBeNull();
  });

  it("al dar de baja a una cuenta rotulada el rótulo se va sin recargar, y al habilitarla vuelve", async () => {
    const user = userEvent.setup();
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () =>
          init?.method === "DELETE"
            ? { user: { dado_de_baja_en: ALTA } }
            : init?.method === "PATCH"
              ? { user: { dado_de_baja_en: null } }
              : { users: USUARIOS },
      }))
    );
    abrir({ rotulo: "Operación", ids: ["u-2"] });
    await waitFor(() => expect(within(filaDe("Ana Operadora")).getByText("Operación")).toBeInTheDocument());

    await user.click(within(filaDe("Ana Operadora")).getByRole("button", { name: "Dar de baja" }));
    await waitFor(() => expect(within(filaDe("Ana Operadora")).getByText("De baja")).toBeInTheDocument());
    expect(within(filaDe("Ana Operadora")).queryByText("Operación")).toBeNull();

    await user.click(within(filaDe("Ana Operadora")).getByRole("button", { name: "Habilitar" }));
    await waitFor(() => expect(within(filaDe("Ana Operadora")).getByText("Operación")).toBeInTheDocument());
    confirmar.mockRestore();
  });

  it("con la lista de ids vacía no rotula a nadie", () => {
    abrir({ rotulo: "Operación", ids: [] });

    expect(screen.queryByText("Operación")).toBeNull();
  });
});
