/**
 * /preparando: qué se muestra según el estado de la base.
 *
 * Lista redirige a la configuración; `creando` reciente espera y se refresca
 * sola cada 5 s; `fallida` o `creando` vencida ofrecen reintentar; borrada dice
 * que se dio de baja. Apagada la bandera, la pantalla no tiene nada que mostrar.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  fila: vi.fn(),
  olvidar: vi.fn(),
  refresh: vi.fn(),
  reintentar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({
  filaDeUsuario: h.fila,
  olvidarFilaDeUsuario: h.olvidar,
}));
vi.mock("@/lib/i18n/locale", () => ({
  resolveAccountLocale: async (l?: string | null) => (l === "en-US" ? "en-US" : "es-AR"),
}));
vi.mock("@/app/login/actions", () => ({ signOut: vi.fn() }));
vi.mock("@/app/preparando/actions", () => ({ reintentarMiBase: h.reintentar }));

import PreparandoPage from "@/app/preparando/page";

const MIN = 60_000;
const hace = (minutos: number) => new Date(Date.now() - minutos * MIN);
const fila = (base: string | null, baseDesde: Date | null = hace(1), locale: string | null = "es-AR") => ({
  id: "u-1",
  tenant_id: "t-1",
  role: "owner",
  locale,
  base,
  baseDesde,
});

async function pintar() {
  return render(await PreparandoPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BASE_POR_CLIENTE = "1";
  h.sesion.mockResolvedValue({ user: { id: "u-1", email: "ana@example.com" } });
  h.fila.mockResolvedValue(fila("creando"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("antes de mostrar nada", () => {
  it("sin sesión va a /login", async () => {
    h.sesion.mockResolvedValue(null);

    await expect(pintar()).rejects.toThrow("REDIRECT:/login");
  });

  it("apagada la bandera va a /bandeja", async () => {
    delete process.env.BASE_POR_CLIENTE;

    await expect(pintar()).rejects.toThrow("REDIRECT:/bandeja");
    expect(h.fila).not.toHaveBeenCalled();
  });

  it("sin fila de users va a /pendiente", async () => {
    h.fila.mockResolvedValue(null);

    await expect(pintar()).rejects.toThrow("REDIRECT:/pendiente");
  });

  it("lee la fila sin la copia en memoria", async () => {
    await pintar();

    expect(h.olvidar).toHaveBeenCalledWith("u-1");
    expect(h.olvidar.mock.invocationCallOrder[0]).toBeLessThan(h.fila.mock.invocationCallOrder[0]);
  });

  it("si la base no responde, tira", async () => {
    h.fila.mockRejectedValue(new Error("timeout"));

    await expect(pintar()).rejects.toThrow("timeout");
  });
});

describe("lista", () => {
  it("redirige a la configuración con ?primeros=1", async () => {
    h.fila.mockResolvedValue(fila("lista", hace(600)));

    await expect(pintar()).rejects.toThrow("REDIRECT:/configuracion?primeros=1");
  });
});

describe("esperando", () => {
  it.each([
    ["creando reciente", fila("creando", hace(2))],
    ["sin fila de base y recién creada", fila(null, hace(2))],
  ])("%s: avisa y no ofrece reintentar", async (_caso, f) => {
    h.fila.mockResolvedValue(f);
    const { container } = await pintar();

    expect(screen.getByRole("heading", { name: "Estamos preparando tu espacio" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/se actualiza sola/);
    // El único botón es «Cerrar sesión».
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeInTheDocument();
  });

  it("se refresca cada 5 segundos mientras espera", async () => {
    vi.useFakeTimers();
    await pintar();

    expect(h.refresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(h.refresh).toHaveBeenCalledTimes(3);
  });

  it("al salir de la pantalla deja de refrescar", async () => {
    vi.useFakeTimers();
    const { unmount } = await pintar();
    unmount();

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("en inglés si la cuenta lo pide", async () => {
    h.fila.mockResolvedValue(fila("creando", hace(1), "en-US"));
    await pintar();

    expect(screen.getByRole("heading", { name: "We are preparing your workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("reintentable", () => {
  it.each([
    ["fallida", fila("fallida", hace(1))],
    ["creando desde hace más de 15 minutos", fila("creando", hace(20))],
    ["sin fila de base desde hace más de 15 minutos", fila(null, hace(20))],
  ])("%s: ofrece reintentar", async (_caso, f) => {
    h.fila.mockResolvedValue(f);
    await pintar();

    expect(screen.getByRole("heading", { name: "Tu espacio no terminó de prepararse" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("el formulario no lleva ningún campo: el inquilino sale de la sesión", async () => {
    h.fila.mockResolvedValue(fila("fallida"));
    const { container } = await pintar();

    const form = screen.getByRole("button", { name: "Reintentar" }).closest("form")!;
    expect(form.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(container.querySelector("input[name=tenantId], input[name=tenant_id]")).toBeNull();
  });

  it("en inglés si la cuenta lo pide", async () => {
    h.fila.mockResolvedValue(fila("fallida", hace(1), "en-US"));
    await pintar();

    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("sigue refrescando: así ve arrancar el intento nuevo", async () => {
    vi.useFakeTimers();
    h.fila.mockResolvedValue(fila("fallida"));
    await pintar();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("borrada", () => {
  it("dice que se dio de baja, no ofrece reintentar y no refresca", async () => {
    vi.useFakeTimers();
    h.fila.mockResolvedValue(fila("borrada", hace(600)));
    await pintar();

    expect(screen.getByRole("heading", { name: "Este espacio se dio de baja" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
