/**
 * Lo que hace el gancho de restablecer, ahora que las sesiones no son suyas.
 *
 * Cerrar las sesiones abiertas era el motivo del gancho: quien restablece cree
 * que le entraron. Hoy las cierra Better Auth (`revokeSessionsOnPasswordReset`)
 * antes de guardar la contraseña nueva, y si no puede, el restablecimiento
 * falla entero. Al gancho le queda marcar el correo y anotar, y acá se exige
 * que NO vuelva a tocar las sesiones por su cuenta: dos que borran son dos que
 * se pueden desincronizar, y el que borraba a mano se tragaba el error.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockWriteAuditLog, mockProvision, mockRemitente, mockCerrarSesiones } = vi.hoisted(() => ({
  mockDb: { delete: vi.fn(), select: vi.fn(), update: vi.fn(), insert: vi.fn() },
  mockWriteAuditLog: vi.fn(),
  mockProvision: vi.fn(),
  mockRemitente: vi.fn(),
  mockCerrarSesiones: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({ db: mockDb, tables: {} }));

vi.mock("@/lib/auth/provision", () => ({ provisionUserProfile: mockProvision }));

// Guardia: si el módulo volviera a cerrar sesiones por su cuenta, estos tests lo verían.
vi.mock("@/lib/auth/sesiones", () => ({ cerrarSesiones: mockCerrarSesiones }));

vi.mock("@/server/notify/remitente-sistema", () => ({ remitenteDelSistema: mockRemitente }));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: { PASSWORD_RESET_COMPLETED: "auth.password_reset_completed" },
}));

import { marcarCorreoVerificado, onPasswordReset } from "@/lib/auth/on-password-reset";
import { authUsers } from "@/lib/db/schema";

const USER = { id: "user-001", email: "ana@example.com", name: "Ana Pérez" };

/** El `select` devuelve el perfil; el `update`, la marca del correo. */
function conBase(opciones: { perfil?: unknown[]; marcarFalla?: boolean } = {}) {
  const { perfil = [{ tenant_id: "tenant-1" }], marcarFalla = false } = opciones;

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

  const buscar = (filas: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(filas),
      }),
    }),
  });
  mockDb.select.mockReturnValue(buscar(perfil));

  return { marcados };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockProvision.mockResolvedValue(undefined);
  // Por omisión hay remitente del sistema: es lo que habilita marcar el correo.
  mockRemitente.mockReturnValue({ correo: "sistema@example.com", refreshToken: "test-refresh-key" });
});

describe("onPasswordReset", () => {
  it("no toca las sesiones: las cerró Better Auth antes de guardar la contraseña", async () => {
    conBase();

    await onPasswordReset(USER);

    expect(mockCerrarSesiones).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("anota el cambio en el inquilino de la persona", async () => {
    // Si alguien pregunta «¿me sacaron al que me había entrado?», la respuesta
    // tiene que estar en el historial.
    conBase();

    await onPasswordReset(USER);

    const entrada = mockWriteAuditLog.mock.calls[0][0];
    expect(entrada.event_type).toBe("auth.password_reset_completed");
    expect(entrada.payload).toEqual({ sesiones_cerradas: "todas" });
    expect(entrada.tenant_id).toBe("tenant-1");
    expect(entrada.actor_id).toBe("user-001");
  });

  it("si no se puede anotar, no tira", async () => {
    conBase();
    mockWriteAuditLog.mockRejectedValue(new Error("audit caído"));

    await expect(onPasswordReset(USER)).resolves.toBeUndefined();
  });

  it("sin fila de perfil no anota", async () => {
    // La cuenta puede existir en Better Auth y no tener perfil todavía.
    conBase({ perfil: [] });

    await onPasswordReset(USER);

    expect(mockWriteAuditLog).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  /*
   * Restablecer prueba la casilla, no que la persona pueda estar en algún
   * espacio. El perfil nunca sale de acá: antes caía en el inquilino por
   * omisión (producción, con casos reales); ahora lo crea `/alta`, y sólo a
   * quien eligió él mismo su espacio. `provision` está simulado como guardia:
   * si el módulo volviera a importarlo, estos tests lo verían.
   */
  describe("restablecer nunca da perfil", () => {
    it("sin perfil: no crea nada y no anota", async () => {
      conBase({ perfil: [] });

      await onPasswordReset(USER);

      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockProvision).not.toHaveBeenCalled();
      expect(mockWriteAuditLog).not.toHaveBeenCalled();
    });

    it("con perfil anota el cambio, sin marca de perfil creado", async () => {
      conBase();

      await onPasswordReset(USER);

      expect(mockProvision).not.toHaveBeenCalled();
      expect(mockWriteAuditLog.mock.calls[0][0].payload).toEqual({ sesiones_cerradas: "todas" });
    });

    it("sin correo en el usuario tampoco intenta nada", async () => {
      conBase({ perfil: [] });

      await onPasswordReset({ id: "user-001" });

      expect(mockProvision).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
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

  it("sin remitente del sistema no marca nada, pero lo demás sigue igual", async () => {
    // Sin él el enlace pudo salir por la casilla de una aseguradora, que quien
    // la administra puede leer: abrirlo no prueba que la casilla sea de la persona.
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRemitente.mockReturnValue(null);
    const { marcados } = conBase();

    await onPasswordReset(USER);

    expect(marcados).toHaveLength(0);
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    const lineas = aviso.mock.calls.map((c) => String(c[0]));
    expect(lineas.some((l) => l.includes("auth.reset.correo_sin_verificar_por_falta_de_remitente"))).toBe(true);
    aviso.mockRestore();
  });

  it("marcarCorreoVerificado solo toca la tabla de Better Auth y solo con remitente", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { marcados } = conBase();

    await marcarCorreoVerificado("user-001");
    expect(marcados).toHaveLength(1);

    mockRemitente.mockReturnValue(null);
    await marcarCorreoVerificado("user-001");
    expect(marcados).toHaveLength(1);
    aviso.mockRestore();
  });

  it("si no se puede marcar, la persona igual puede volver a entrar", async () => {
    conBase({ marcarFalla: true });

    // Lo que no puede pasar es que tire: eso dejaria el restablecimiento a
    // medias y a la persona afuera con una contrasena que ya cambio.
    await expect(onPasswordReset(USER)).resolves.toBeUndefined();
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
  });
});
