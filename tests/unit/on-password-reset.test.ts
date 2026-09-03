/**
 * Restablecer la contraseña cierra las sesiones abiertas.
 *
 * Es el motivo por el que alguien restablece: cree que le entraron. Hasta acá
 * la contraseña cambiaba y la sesión del que entró seguía viva —hasta treinta
 * días, que es lo que duran— así que el gesto que la persona hace para echar a
 * un intruso no lo echaba.
 *
 * El hook vivía escrito adentro del objeto de configuración de Better Auth, y
 * ahí no había forma de probarlo sin levantar la librería entera. Ahora es un
 * módulo, y esto es lo que se puede exigirle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockWriteAuditLog } = vi.hoisted(() => ({
  mockDb: { delete: vi.fn(), select: vi.fn(), update: vi.fn() },
  mockWriteAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({ db: mockDb, tables: {} }));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: { PASSWORD_RESET_COMPLETED: "auth.password_reset_completed" },
}));

import { onPasswordReset } from "@/lib/auth/on-password-reset";
import { authUsers, sessions } from "@/lib/db/schema";

const USER = { id: "user-001" };

/** El `delete` devuelve las filas que borró; el `select`, el perfil. */
function conBase(opciones: {
  sesionesBorradas?: unknown[];
  borrarFalla?: boolean;
  perfil?: unknown[];
  marcarFalla?: boolean;
} = {}) {
  const { sesionesBorradas = [{ id: "s-1" }, { id: "s-2" }], borrarFalla = false, perfil = [{ tenant_id: "tenant-1" }], marcarFalla = false } =
    opciones;

  const tablasBorradas: unknown[] = [];
  const marcados: { tabla: unknown; valores: unknown }[] = [];
  mockDb.update.mockImplementation((tabla: unknown) => ({
    set: vi.fn().mockImplementation((valores: unknown) => {
      marcados.push({ tabla, valores });
      return {
        where: vi.fn().mockImplementation(() =>
          marcarFalla ? Promise.reject(new Error("se cayo la base")) : Promise.resolve()
        ),
      };
    }),
  }));
  mockDb.delete.mockImplementation((tabla: unknown) => {
    tablasBorradas.push(tabla);
    return {
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() =>
          borrarFalla
            ? Promise.reject(new Error("se cayó la base"))
            : Promise.resolve(sesionesBorradas)
        ),
      }),
    };
  });

  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(perfil),
      }),
    }),
  });

  return { tablasBorradas, marcados };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
});

describe("onPasswordReset", () => {
  it("borra las sesiones del usuario", async () => {
    const { tablasBorradas } = conBase();

    await onPasswordReset(USER);

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    // Y de la tabla que corresponde: borrar de otra sería peor que no borrar.
    expect(tablasBorradas[0]).toBe(sessions);
  });

  it("anota cuántas cerró", async () => {
    // Si alguien pregunta «¿me sacaron al que me había entrado?», la respuesta
    // tiene que estar en el historial.
    conBase({ sesionesBorradas: [{ id: "a" }, { id: "b" }, { id: "c" }] });

    await onPasswordReset(USER);

    const entrada = mockWriteAuditLog.mock.calls[0][0];
    expect(entrada.event_type).toBe("auth.password_reset_completed");
    expect(entrada.payload).toEqual({ sesiones_cerradas: 3 });
    expect(entrada.tenant_id).toBe("tenant-1");
    expect(entrada.actor_id).toBe("user-001");
  });

  it("sin sesiones abiertas anota cero, no se rompe", async () => {
    conBase({ sesionesBorradas: [] });

    await onPasswordReset(USER);

    expect(mockWriteAuditLog.mock.calls[0][0].payload).toEqual({ sesiones_cerradas: 0 });
  });

  it("si el borrado falla, igual anota y no tira", async () => {
    // Que no se puedan cerrar es grave y se grita, pero no puede impedirle a la
    // persona volver a entrar con su contraseña nueva.
    const grito = vi.spyOn(console, "error").mockImplementation(() => {});
    conBase({ borrarFalla: true });

    await expect(onPasswordReset(USER)).resolves.toBeUndefined();

    expect(grito).toHaveBeenCalled();
    const linea = JSON.parse(grito.mock.calls[0][0] as string);
    expect(linea.msg).toBe("auth.reset.no_se_pudieron_cerrar_las_sesiones");
    expect(mockWriteAuditLog).toHaveBeenCalled();
    grito.mockRestore();
  });

  it("cierra ANTES de anotar: que no se pueda anotar no deja sesiones abiertas", async () => {
    conBase();
    mockWriteAuditLog.mockRejectedValue(new Error("audit caído"));

    await expect(onPasswordReset(USER)).resolves.toBeUndefined();

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it("sin fila de perfil no anota, pero igual cerró las sesiones", async () => {
    // El orden otra vez: la cuenta puede existir en Better Auth y no tener
    // perfil todavía. Eso no puede dejar viva la sesión de nadie.
    conBase({ perfil: [] });

    await onPasswordReset(USER);

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  /*
   * Terminar un restablecimiento prueba que el enlace llego a esa casilla y
   * que quien lo abrio lo uso — que es exactamente lo que `emailVerified`
   * afirma. Antes la bandera se quedaba en `false` para siempre, porque el
   * alta no pide verificar y nada mas la tocaba.
   *
   * No es cosmetico: Better Auth se niega a vincular Google a un usuario con
   * el correo sin verificar, asi que quien se dio de alta con contrasena no
   * podia usar «Continuar con Google» nunca.
   */
  it("marca el correo como verificado", async () => {
    const { marcados } = conBase();

    await onPasswordReset(USER);

    expect(marcados).toHaveLength(1);
    expect(marcados[0]!.tabla).toBe(authUsers);
    expect(marcados[0]!.valores).toEqual({ emailVerified: true });
  });

  it("si no se puede marcar, la persona igual puede volver a entrar", async () => {
    conBase({ marcarFalla: true });

    // Lo que no puede pasar es que tire: eso dejaria el restablecimiento a
    // medias y a la persona afuera con una contrasena que ya cambio.
    await expect(onPasswordReset(USER)).resolves.toBeUndefined();
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
  });
});
