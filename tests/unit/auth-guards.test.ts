/**
 * Las dos guardas que deciden quién puede hacer qué.
 *
 * Estaban **excluidas de la cobertura** con el motivo "se prueban
 * transitivamente por los tests de rutas". No era cierto: esos tests simulan
 * `requireRole` y `requireAdmin`, así que lo que se probaba era el mock. La
 * lógica de las guardas —quién entra, quién no, y qué se devuelve— no la
 * miraba nadie, y la exclusión hacía que eso no se notara.
 *
 * Hay un caso que este archivo cuida especialmente. Estas funciones devolvían
 * un handle de base junto con la identidad, y era el del rol dueño de las
 * tablas: diecinueve rutas hacían `const { db } = await requireRole()` y
 * consultaban por afuera de RLS sin que nadie lo viera. Salió del contrato, y
 * el último test de acá abajo está para que no vuelva.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockSession, mockSelect } = vi.hoisted(() => ({
  mockSession: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSessionContext: mockSession }));
vi.mock("@/lib/db", () => ({ db: { select: mockSelect } }));
vi.mock("@/lib/db/schema", () => ({
  users: { id: "id", tenant_id: "tenant_id", role: "role" },
}));

import { requireRole, ADMIN_ROLES, CASE_EDITOR_ROLES } from "@/lib/auth/require-role";
import { requireAdmin } from "@/lib/auth/require-admin";
import { AppError } from "@/lib/errors";

const USUARIO = { id: "u-1", email: "lucia@seguros.com.ar" };
const FILA = { id: "u-1", tenant_id: "aaaaaaaa-0000-0000-0000-00000000000a", role: "analyst" };

/** La cadena de drizzle, devolviendo la fila que se le pase. */
function conFila(fila: unknown | null) {
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(fila ? [fila] : []) }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.mockResolvedValue({ user: USUARIO });
  conFila(FILA);
});

describe("requireRole", () => {
  it("deja pasar a quien tiene uno de los roles pedidos", async () => {
    const ctx = await requireRole("analyst", "admin");

    expect(ctx.user.id).toBe("u-1");
    expect(ctx.userRow.tenant_id).toBe(FILA.tenant_id);
    expect(ctx.userRow.role).toBe("analyst");
  });

  it("rechaza sin sesión", async () => {
    mockSession.mockResolvedValue(null);

    await expect(requireRole("analyst")).rejects.toThrow(AppError);
    await expect(requireRole("analyst")).rejects.toMatchObject({
      code: "MISSING_SESSION",
    });
  });

  it("rechaza una sesión sin usuario", async () => {
    // Pasa cuando la cookie existe pero venció: `getSessionContext` devuelve
    // un objeto, y sólo mirar que no sea null dejaría entrar a nadie.
    mockSession.mockResolvedValue({ user: null });

    await expect(requireRole("analyst")).rejects.toMatchObject({
      code: "MISSING_SESSION",
    });
  });

  it("rechaza a un usuario con sesión válida pero sin fila en la base", async () => {
    // Es el usuario que se dio de alta y todavía nadie asignó a una
    // aseguradora. Tiene sesión de verdad; lo que no tiene es inquilino. Si
    // esto devolviera un contexto, sería uno con `tenant_id` indefinido.
    conFila(null);

    await expect(requireRole("analyst")).rejects.toMatchObject({
      code: "MISSING_SESSION",
    });
  });

  it("rechaza a quien tiene sesión pero no el rol", async () => {
    conFila({ ...FILA, role: "viewer" });

    await expect(requireRole("admin", "owner")).rejects.toMatchObject({
      code: "FORBIDDEN_ROLE",
    });
  });

  it("distingue no tener sesión de no tener permiso", async () => {
    // No es cosmético: uno manda al login y el otro no. Devolver 401 a quien
    // ya entró lo saca de la sesión; devolver 403 a quien no entró le esconde
    // el motivo real.
    mockSession.mockResolvedValue(null);
    const sinSesion = await requireRole("admin").catch((e: AppError) => e.code);

    mockSession.mockResolvedValue({ user: USUARIO });
    conFila({ ...FILA, role: "viewer" });
    const sinPermiso = await requireRole("admin").catch((e: AppError) => e.code);

    expect(sinSesion).toBe("MISSING_SESSION");
    expect(sinPermiso).toBe("FORBIDDEN_ROLE");
  });

  it("acepta el email ausente sin romper", async () => {
    mockSession.mockResolvedValue({ user: { id: "u-1" } });

    const ctx = await requireRole("analyst");

    expect(ctx.user.email).toBeUndefined();
    expect(ctx.userRow.id).toBe("u-1");
  });
});

describe("requireAdmin", () => {
  it("deja pasar a admin", async () => {
    conFila({ ...FILA, role: "admin" });
    await expect(requireAdmin()).resolves.toMatchObject({
      userRow: { role: "admin" },
    });
  });

  it("deja pasar a owner", async () => {
    // `owner` es superconjunto de `admin`, no un rol paralelo. Si esto se
    // rompiera, el dueño de la cuenta quedaría afuera de su propio panel.
    conFila({ ...FILA, role: "owner" });
    await expect(requireAdmin()).resolves.toMatchObject({
      userRow: { role: "owner" },
    });
  });

  it("rechaza a analyst, specialist y viewer", async () => {
    for (const rol of ["analyst", "specialist", "viewer"]) {
      conFila({ ...FILA, role: rol });
      await expect(requireAdmin(), rol).rejects.toMatchObject({
        code: "FORBIDDEN_ROLE",
      });
    }
  });

  it("rechaza sin sesión", async () => {
    mockSession.mockResolvedValue(null);
    await expect(requireAdmin()).rejects.toMatchObject({ code: "MISSING_SESSION" });
  });
});

describe("los roles declarados", () => {
  it("ADMIN_ROLES es exactamente owner y admin", () => {
    expect([...ADMIN_ROLES].sort()).toEqual(["admin", "owner"]);
  });

  it("CASE_EDITOR_ROLES incluye a todos menos viewer", () => {
    // `viewer` afuera es el punto de la lista. Que alguien lo agregue "para
    // que pueda corregir un dato" convierte el rol de sólo lectura en uno de
    // escritura sin que cambie su nombre.
    expect(CASE_EDITOR_ROLES).not.toContain("viewer");
    expect([...CASE_EDITOR_ROLES].sort()).toEqual([
      "admin",
      "analyst",
      "owner",
      "specialist",
    ]);
  });
});

describe("lo que las guardas NO devuelven", () => {
  it("no reparten un handle de base", async () => {
    const ctx = await requireRole("analyst");
    const ctxAdmin = await requireAdmin().catch(() => null);

    // Éste es el test de regresión que importa. Devolvían `db`, y era el del
    // rol dueño de las tablas — al que RLS no le aplica. Diecinueve rutas
    // consultaban por ahí: la consulta anda, devuelve filas, y las filas son
    // de todas las aseguradoras. Ningún error, ninguna señal.
    //
    // Si alguien lo vuelve a agregar "para no tener que importar la capa",
    // esto se pone en rojo.
    expect(ctx).not.toHaveProperty("db");
    expect(Object.keys(ctx).sort()).toEqual(["user", "userRow"]);
    if (ctxAdmin) expect(ctxAdmin).not.toHaveProperty("db");
  });
});
