/**
 * /preparando: qué se muestra según el estado de la base.
 *
 * Lista redirige (a la bandeja si ya hay WhatsApp y Gmail, y si no a los primeros
 * pasos); `creando` reciente espera y se refresca sola cada 5 s; `fallida` o
 * `creando` vencida ofrecen reintentar; borrada dice que se dio de baja. Apagada
 * la bandera, la pantalla no tiene nada que mostrar. Con el número por código
 * prendido, quien espera o puede reintentar conecta su WhatsApp ahí mismo.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  fila: vi.fn(),
  olvidar: vi.fn(),
  refresh: vi.fn(),
  reintentar: vi.fn(),
  pasos: vi.fn(),
  porConectar: vi.fn(),
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
vi.mock("@/app/(app)/configuracion/numero-actions", () => ({
  pedirCodigoDelNumero: vi.fn(),
  verificarCodigoDelNumero: vi.fn(),
}));
vi.mock("@/server/alta/numero-automatico", () => ({ numeroPorConectar: h.porConectar }));
vi.mock("@/server/alta/pasos-hechos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/alta/pasos-hechos")>()),
  pasosHechos: h.pasos,
}));

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
const deAutoalta = <T extends object>(f: T) => ({ ...f, autoalta: true });

async function pintar(wa?: string | string[]) {
  return render(await PreparandoPage({ searchParams: Promise.resolve(wa === undefined ? {} : { wa }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BASE_POR_CLIENTE = "1";
  delete process.env.ALTA_NUMERO_AUTOMATICO;
  h.sesion.mockResolvedValue({ user: { id: "u-1", email: "ana@example.com" } });
  h.fila.mockResolvedValue(fila("creando"));
  h.pasos.mockResolvedValue({ whatsapp: false, gmail: false });
  h.porConectar.mockResolvedValue(true);
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
  beforeEach(() => {
    h.fila.mockResolvedValue(fila("lista", hace(600)));
  });

  it("sin nada conectado va a los primeros pasos", async () => {
    await expect(pintar()).rejects.toThrow("REDIRECT:/configuracion?primeros=1");
    expect(h.pasos).toHaveBeenCalledWith("t-1");
  });

  it.each([
    ["sólo el WhatsApp", { whatsapp: true, gmail: false }],
    ["sólo Gmail", { whatsapp: false, gmail: true }],
  ])("con %s conectado sigue yendo a los primeros pasos", async (_caso, pasos) => {
    h.pasos.mockResolvedValue(pasos);

    await expect(pintar()).rejects.toThrow("REDIRECT:/configuracion?primeros=1");
  });

  it("con el WhatsApp y Gmail conectados va a la bandeja de bienvenida", async () => {
    h.pasos.mockResolvedValue({ whatsapp: true, gmail: true });

    await expect(pintar()).rejects.toThrow("REDIRECT:/bandeja?bienvenida=1");
  });

  it("conserva lo que dijo el último paso del número, si es de la lista", async () => {
    await expect(pintar("conectado")).rejects.toThrow("REDIRECT:/configuracion?primeros=1&wa=conectado");
  });

  it.each(["otra_cosa", "<b>", ["conectado"]])("descarta un ?wa= que no es de la lista: %j", async (wa) => {
    await expect(pintar(wa)).rejects.toThrow(/^REDIRECT:\/configuracion\?primeros=1$/);
  });

  it("no mira el número por conectar ni pinta nada", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
    h.fila.mockResolvedValue(deAutoalta(fila("lista", hace(600))));

    await expect(pintar()).rejects.toThrow("REDIRECT:/configuracion?primeros=1");
    expect(h.porConectar).not.toHaveBeenCalled();
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

describe("el WhatsApp mientras la base se arma", () => {
  const CODIGO = "input[name=codigo]";
  const INTRO = "Mientras preparamos tu espacio, conectá tu WhatsApp.";

  beforeEach(() => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";
  });

  describe.each([
    ["esperando", fila("creando", hace(2))],
    ["reintentable", fila("fallida", hace(1))],
  ])("%s", (_vista, base) => {
    beforeEach(() => {
      h.fila.mockResolvedValue(deAutoalta(base));
    });

    it("con el número por conectar pinta el panel con su frase", async () => {
      const { container } = await pintar();

      expect(h.porConectar).toHaveBeenCalledWith("t-1");
      expect(screen.getByText(INTRO)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Por SMS" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Por llamada" })).toBeInTheDocument();
      expect(container.querySelector(CODIGO)).not.toBeNull();
    });

    it("el aviso de la acción sale del ?wa= y los formularios siguen", async () => {
      const { container } = await pintar("codigo_enviado");

      expect(screen.getByText(/Te mandamos el código/)).toBeInTheDocument();
      expect(container.querySelector(CODIGO)).not.toBeNull();
    });

    it("con el número ya conectado, sólo el aviso: ni formularios ni frase", async () => {
      h.porConectar.mockResolvedValue(false);
      const { container } = await pintar("conectado");

      expect(screen.getByText("Listo: tu WhatsApp quedó conectado.")).toBeInTheDocument();
      expect(screen.queryByText(INTRO)).toBeNull();
      expect(container.querySelector(CODIGO)).toBeNull();
    });

    it("con el número ya conectado y sin aviso, no pinta nada del número", async () => {
      h.porConectar.mockResolvedValue(false);
      const { container } = await pintar();

      expect(screen.queryByText(INTRO)).toBeNull();
      expect(screen.queryByRole("button", { name: "Por SMS" })).toBeNull();
      expect(container.querySelector(CODIGO)).toBeNull();
    });

    it("un ?wa= que no es de la lista no pinta nada", async () => {
      h.porConectar.mockResolvedValue(false);
      await pintar("<script>");

      expect(screen.queryByText("<script>")).toBeNull();
      expect(screen.queryByText(INTRO)).toBeNull();
    });

    it("en inglés si la cuenta lo pide", async () => {
      h.fila.mockResolvedValue(deAutoalta({ ...base, locale: "en-US" }));
      await pintar();

      expect(screen.getByText("While we set up your workspace, connect your WhatsApp.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "By SMS" })).toBeInTheDocument();
    });

    it("sigue refrescando", async () => {
      vi.useFakeTimers();
      await pintar();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    it("apagada la bandera del número no consulta ni pinta nada", async () => {
      delete process.env.ALTA_NUMERO_AUTOMATICO;
      await pintar("conectado");

      expect(h.porConectar).not.toHaveBeenCalled();
      expect(screen.queryByText(INTRO)).toBeNull();
      expect(screen.queryByRole("button", { name: "Por SMS" })).toBeNull();
    });

    it.each(["analyst", "specialist", "viewer"])("un %s no consulta ni pinta nada del número", async (role) => {
      h.fila.mockResolvedValue(deAutoalta({ ...base, role }));
      await pintar("conectado");

      expect(h.porConectar).not.toHaveBeenCalled();
      expect(screen.queryByText(INTRO)).toBeNull();
      expect(screen.queryByText("Listo: tu WhatsApp quedó conectado.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Por SMS" })).toBeNull();
    });

    it("un admin (no sólo el dueño) sí ve el panel", async () => {
      h.fila.mockResolvedValue(deAutoalta({ ...base, role: "admin" }));
      await pintar();

      expect(h.porConectar).toHaveBeenCalledWith("t-1");
      expect(screen.getByText(INTRO)).toBeInTheDocument();
    });

    it.each([false, null, undefined])("un espacio con autoalta %s no consulta ni pinta nada", async (autoalta) => {
      h.fila.mockResolvedValue({ ...base, autoalta });
      await pintar("conectado");

      expect(h.porConectar).not.toHaveBeenCalled();
      expect(screen.queryByText(INTRO)).toBeNull();
      expect(screen.queryByRole("button", { name: "Por SMS" })).toBeNull();
    });
  });

  it("en la espera, la frase va después del aviso de espera", async () => {
    h.fila.mockResolvedValue(deAutoalta(fila("creando", hace(2))));
    const { container } = await pintar();

    const texto = container.textContent ?? "";
    expect(texto.indexOf("se actualiza sola")).toBeLessThan(texto.indexOf("Mientras preparamos"));
  });

  it("el formulario de reintentar sigue sin campos aunque haya panel", async () => {
    h.fila.mockResolvedValue(deAutoalta(fila("fallida")));
    await pintar();

    const form = screen.getByRole("button", { name: "Reintentar" }).closest("form")!;
    expect(form.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });

  it("una base dada de baja no consulta ni pinta nada del número", async () => {
    h.fila.mockResolvedValue(deAutoalta(fila("borrada", hace(600))));
    await pintar("conectado");

    expect(h.porConectar).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Por SMS" })).toBeNull();
  });
});
