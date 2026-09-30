/**
 * /desvios (B22): la guarda de rol, un enlace al caso por fila y la paginación.
 *
 * `listarDesvios` se prueba aparte; acá se prueba lo que la página hace con lo
 * que devuelve y a quién se lo deja ver.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

const m = vi.hoisted(() => ({
  listar: vi.fn(),
  sesion: vi.fn(),
  fila: vi.fn(),
  idioma: vi.fn(),
  redirect: vi.fn((destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: m.redirect, unstable_rethrow: vi.fn() }));
vi.mock("@/data/scope", () => ({ enTenantVarias: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: m.sesion }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRow: m.fila }));
vi.mock("@/lib/i18n/locale", () => ({ resolveAccountLocale: m.idioma }));
vi.mock("@/server/desvios/listar", async (original) => ({
  ...(await original<typeof import("@/server/desvios/listar")>()),
  listarDesvios: m.listar,
}));

import DesviosPage from "@/app/(app)/desvios/page";
import type { Desvio } from "@/server/desvios/listar";

const CASO = "0a1b2c3d-0000-4000-8000-000000000001";

const desvio = (extra: Partial<Desvio> = {}): Desvio => ({
  caseId: CASO,
  numero: "CM-0001",
  titular: "Ana Pérez",
  tipo: "choque",
  regla: "plazo_vencido",
  ancla: "2026-09-29T15:00:00.000Z",
  detectadoEn: "2026-09-30T03:00:00.000Z",
  datos: [],
  ...extra,
});

const pagina = (data: Desvio[], meta: Partial<{ total: number; page: number; per_page: number; pages: number }> = {}) => ({
  data,
  meta: { total: data.length, page: 1, per_page: 25, pages: data.length ? 1 : 0, ...meta },
});

async function dibujar(params: Record<string, string> = {}) {
  render(await DesviosPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.sesion.mockResolvedValue({ user: { id: "u1" } });
  m.fila.mockResolvedValue({ tenant_id: "t1", role: "admin" });
  m.listar.mockResolvedValue(pagina([]));
  m.idioma.mockResolvedValue("es-AR");
});

describe("/desvios — quién entra", () => {
  it("sin sesión va al login y no toca la base", async () => {
    m.sesion.mockResolvedValue(null);
    await expect(dibujar()).rejects.toThrow("REDIRECT:/login");
    expect(m.listar).not.toHaveBeenCalled();
  });

  it("con sesión pero sin fila de usuario va a /pendiente", async () => {
    m.fila.mockResolvedValue(null);
    await expect(dibujar()).rejects.toThrow("REDIRECT:/pendiente");
    expect(m.listar).not.toHaveBeenCalled();
  });

  it.each(["analyst", "viewer", "rol_que_no_existe"])("%s vuelve a la bandeja sin ver nada", async (role) => {
    m.fila.mockResolvedValue({ tenant_id: "t1", role });
    await expect(dibujar()).rejects.toThrow("REDIRECT:/bandeja");
    expect(m.listar).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "specialist"])("%s entra, con su inquilino y su rol", async (role) => {
    m.fila.mockResolvedValue({ tenant_id: "t1", role });
    await dibujar();
    expect(m.listar).toHaveBeenCalledWith({ tenantId: "t1" }, role, { page: 1, per_page: 25 });
    expect(screen.getByRole("heading", { level: 1, name: "Desvíos" })).toBeInTheDocument();
  });
});

describe("/desvios — la lista", () => {
  it("sin desvíos dice que no hay y no dibuja paginación", async () => {
    await dibujar();
    expect(screen.getByText("La revisión no encontró desvíos.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("cada fila es un enlace al caso, con el titular, el número y la regla", async () => {
    m.listar.mockResolvedValue(pagina([desvio()]));
    await dibujar();

    const enlace = screen.getByRole("link", { name: /Ana Pérez/ });
    expect(enlace).toHaveAttribute("href", `/casos/${CASO}`);
    expect(enlace).toHaveTextContent("CM-0001");
    expect(enlace).toHaveTextContent("Plazo vencido");
    expect(enlace).toHaveTextContent("El plazo del caso pasó y el caso sigue abierto.");
  });

  it("dos desvíos del mismo caso son dos filas que abren el mismo caso", async () => {
    m.listar.mockResolvedValue(
      pagina([desvio(), desvio({ regla: "plan_sin_terminar", ancla: "2026-09-28T10:00:00.000Z" })])
    );
    await dibujar();

    const enlaces = screen.getAllByRole("link");
    expect(enlaces).toHaveLength(2);
    for (const e of enlaces) expect(e).toHaveAttribute("href", `/casos/${CASO}`);
  });

  it("el plazo de la regla entra en el detalle", async () => {
    m.listar.mockResolvedValue(
      pagina([
        desvio({ regla: "derivacion_sin_respuesta" }),
        desvio({ regla: "doc_sin_recibir", caseId: "0a1b2c3d-0000-4000-8000-000000000002", datos: ["parte_amistoso"] }),
      ])
    );
    await dibujar();

    expect(screen.getByText("Se derivó al equipo hace más de 24 h y nadie tomó el caso.")).toBeInTheDocument();
    expect(screen.getByText(/Se pidió hace más de 72 h y no llegó\./)).toBeInTheDocument();
  });

  it("los documentos pendientes se dicen con su etiqueta", async () => {
    m.listar.mockResolvedValue(pagina([desvio({ regla: "doc_sin_recibir", datos: ["parte_amistoso"] })]));
    await dibujar();
    expect(screen.getByRole("link")).toHaveTextContent("Parte amistoso de accidente");
  });

  it("un documento se dice con la etiqueta que le da el tipo de reclamo del caso", async () => {
    m.listar.mockResolvedValue(
      pagina([
        desvio({ regla: "doc_sin_recibir", tipo: "granizo", datos: ["fotos_danos"] }),
        desvio({ regla: "doc_sin_recibir", tipo: "cristales", datos: ["fotos_danos"], caseId: "0a1b2c3d-0000-4000-8000-000000000002" }),
      ])
    );
    await dibujar();

    const [granizo, cristales] = screen.getAllByRole("link");
    expect(granizo).toHaveTextContent("Fotos de los daños por granizo");
    expect(cristales).toHaveTextContent("Fotos del vidrio dañado");
  });

  it("en una cuenta en inglés el documento se dice en inglés, como en la pantalla del caso", async () => {
    m.idioma.mockResolvedValue("en-US");
    m.listar.mockResolvedValue(pagina([desvio({ regla: "doc_sin_recibir", tipo: "granizo", datos: ["fotos_danos"] })]));
    await dibujar();

    expect(screen.getByRole("link")).toHaveTextContent("Documents not received");
    expect(screen.getByRole("link")).toHaveTextContent("Damage photos");
    expect(screen.getByRole("link")).not.toHaveTextContent("Fotos");
  });

  it("el plazo vencido se dice con su nombre, no con la clave", async () => {
    m.listar.mockResolvedValue(pagina([desvio({ regla: "plazo_vencido", datos: ["art56"] })]));
    await dibujar();

    expect(screen.getByRole("link")).toHaveTextContent("Pronunciamiento del asegurador (art. 56)");
    expect(screen.getByRole("link")).not.toHaveTextContent("art56");
  });

  it("un plazo propio de la aseguradora, que no está en el diccionario, se dice sin guiones", async () => {
    m.listar.mockResolvedValue(pagina([desvio({ regla: "plazo_vencido", datos: ["visita_al_taller"] })]));
    await dibujar();
    expect(screen.getByRole("link")).toHaveTextContent("visita al taller");
  });

  it("los pasos del plan que quedaron sin hacer se dicen con su título, y uno propio sin guiones", async () => {
    m.listar.mockResolvedValue(
      pagina([desvio({ regla: "plan_sin_terminar", datos: ["revisar_documentacion", "llamar_al_perito"] })])
    );
    await dibujar();

    const enlace = screen.getByRole("link");
    expect(enlace).toHaveTextContent("Revisar la documentación recibida, llamar al perito.");
    expect(enlace).not.toHaveTextContent("revisar_documentacion");
  });

  it("el estado en que cerró se dice con su nombre", async () => {
    m.listar.mockResolvedValue(pagina([desvio({ regla: "cierre_sin_listo", datos: ["cerrado"] })]));
    await dibujar();
    expect(screen.getByRole("link")).toHaveTextContent("Cerró sin pasar nunca por «listo».");
    expect(screen.getByRole("link")).not.toHaveTextContent(" cerrado.");
  });

  it("un titular sin nombre se ve como vacío, no como «null»", async () => {
    m.listar.mockResolvedValue(pagina([desvio({ titular: null })]));
    await dibujar();
    const enlace = screen.getByRole("link");
    expect(within(enlace).getByLabelText("Sin dato")).toBeInTheDocument();
    expect(enlace).not.toHaveTextContent("null");
  });

  it("una regla que ya no existe se muestra con su nombre en vez de romper la pantalla", async () => {
    m.listar.mockResolvedValue(pagina([desvio({ regla: "regla_vieja" })]));
    await dibujar();
    expect(screen.getByRole("link")).toHaveTextContent("regla_vieja");
  });

  it("el titular que llega tapado se muestra tapado", async () => {
    m.fila.mockResolvedValue({ tenant_id: "t1", role: "owner" });
    m.listar.mockResolvedValue(pagina([desvio({ titular: "[oculto]" })]));
    await dibujar();
    expect(screen.getByRole("link")).toHaveTextContent("[oculto]");
    expect(screen.getByRole("link")).not.toHaveTextContent("Ana Pérez");
  });
});

describe("/desvios — la paginación", () => {
  it("?page= y ?per_page= llegan a la consulta", async () => {
    await dibujar({ page: "2", per_page: "10" });
    expect(m.listar).toHaveBeenCalledWith({ tenantId: "t1" }, "admin", { page: 2, per_page: 10 });
  });

  it("una página que no se entiende es la primera, no un error", async () => {
    await dibujar({ page: "abc" });
    expect(m.listar).toHaveBeenCalledWith({ tenantId: "t1" }, "admin", {});
  });

  it("en la primera página hay «Siguiente» y no «Anterior»", async () => {
    m.listar.mockResolvedValue(pagina([desvio()], { total: 60, pages: 3 }));
    await dibujar();

    expect(screen.queryByRole("link", { name: "Anterior" })).toBeNull();
    expect(screen.getByRole("link", { name: "Siguiente" })).toHaveAttribute("href", "/desvios?page=2&per_page=25");
    expect(screen.getByText("1–25 de 60")).toBeInTheDocument();
  });

  it("en el medio hay las dos, y en la última sólo «Anterior»", async () => {
    m.listar.mockResolvedValue(pagina([desvio()], { total: 60, page: 2, pages: 3 }));
    await dibujar({ page: "2" });
    expect(screen.getByRole("link", { name: "Anterior" })).toHaveAttribute("href", "/desvios?page=1&per_page=25");
    expect(screen.getByRole("link", { name: "Siguiente" })).toHaveAttribute("href", "/desvios?page=3&per_page=25");

    document.body.innerHTML = "";
    m.listar.mockResolvedValue(pagina([desvio()], { total: 60, page: 3, pages: 3 }));
    await dibujar({ page: "3" });
    expect(screen.getByRole("link", { name: "Anterior" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Siguiente" })).toBeNull();
    expect(screen.getByText("51–60 de 60")).toBeInTheDocument();
  });
});
