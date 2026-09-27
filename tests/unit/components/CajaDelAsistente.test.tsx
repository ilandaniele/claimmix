/**
 * CajaDelAsistente — chips de sugerencia, historial acotado a 5 y el aviso de
 * resumen con IA. `AsistenteFlotante` se prueba aparte: acá se prueba la caja
 * sola, como vive en `/asistente`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { CajaDelAsistente } from "../../../src/app/(app)/asistente/_components/CajaDelAsistente";

let pathname = "/asistente";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

describe("CajaDelAsistente", () => {
  beforeEach(() => {
    pathname = "/asistente";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("con textareaRef externo, enfoca el textarea al montar (panel flotante)", async () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<CajaDelAsistente textareaRef={ref} />);
    // Diferido un frame (ver comentario en el componente): no es sincrónico.
    await waitFor(() => expect(document.activeElement).toBe(ref.current));
  });

  it("sin textareaRef externo (/asistente), no se autoenfoca", async () => {
    render(<CajaDelAsistente />);
    await new Promise((r) => requestAnimationFrame(r));
    expect(screen.getByLabelText("Tu pregunta")).not.toHaveFocus();
  });

  it("sin historial, muestra los chips de sugerencia", () => {
    render(<CajaDelAsistente />);
    expect(screen.getByText("¿Cuántos casos hubo este mes?")).toBeInTheDocument();
    expect(screen.getByText("¿Cuántos WhatsApps entraron hoy?")).toBeInTheDocument();
    expect(screen.getByText("¿Cuántos reclamos hubo en los últimos 30 días?")).toBeInTheDocument();
    expect(screen.getByText("Buscá el caso de…")).toBeInTheDocument();
  });

  it("el chip de conteo pregunta y envía solo", async () => {
    const mockFetch = mockFetchOk({ texto: "Hubo 9 casos.", herramienta: "contar_casos", casos: [] });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("¿Cuántos casos hubo este mes?"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/asistente",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ pregunta: "¿Cuántos casos hubo este mes?" }),
        })
      );
    });
    expect(await screen.findByText("Hubo 9 casos.")).toBeInTheDocument();
  });

  it("el chip de buscar caso llena el textarea y no envía", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("Buscá el caso de…"));

    const textarea = screen.getByLabelText("Tu pregunta") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Buscá el caso de ");
    expect(textarea).toHaveFocus();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fuera de /casos/[id] no ofrece «Resumí este caso»", () => {
    pathname = "/bandeja";
    render(<CajaDelAsistente />);
    expect(screen.queryByText("Resumí este caso")).toBeNull();
  });

  it("en /casos/[id] ofrece «Resumí este caso» y pregunta por su número", async () => {
    pathname = "/casos/00000000-0000-0000-0000-0000a1a1a1a1";
    const mockFetch = mockFetchOk({ texto: "Resumen.", herramienta: "buscar_caso", casos: [] });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("Resumí este caso"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/asistente",
        expect.objectContaining({
          body: JSON.stringify({ pregunta: "¿Qué pasó con el caso SIN-A1A1-A1A1?" }),
        })
      );
    });
  });

  it("con un solo caso encontrado, avisa que el resumen es de IA", async () => {
    const mockFetch = mockFetchOk({
      texto: "Caso de Roberto Paz.",
      herramienta: "buscar_caso",
      casos: [
        {
          id: "c1",
          etiqueta: "Roberto Paz",
          numero: "SIN-AAAA-1111",
          creado: "2026-09-01T00:00:00.000Z",
          estado: "escalado",
        },
      ],
    });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("¿Cuántos casos hubo este mes?"));

    expect(await screen.findByText("Roberto Paz")).toBeInTheDocument();
    expect(
      screen.getByText("Resumen generado con IA a partir del caso. Verificalo en el caso antes de actuar.")
    ).toBeInTheDocument();
  });

  it("con más de un caso, no muestra el aviso de resumen de IA", async () => {
    const dosCasos = {
      texto: "Encontré 2 casos parecidos. Elegí uno de la lista para verlo.",
      herramienta: "buscar_caso",
      casos: [
        { id: "c1", etiqueta: "Roberto Paz", numero: "SIN-AAAA-1111", creado: "2026-09-01T00:00:00.000Z", estado: "escalado" },
        { id: "c2", etiqueta: "Roberto Paz Jr.", numero: "SIN-BBBB-2222", creado: "2026-09-02T00:00:00.000Z", estado: "listo" },
      ],
    };
    vi.stubGlobal("fetch", mockFetchOk(dosCasos));
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("¿Cuántos casos hubo este mes?"));

    expect(await screen.findByText("Roberto Paz Jr.")).toBeInTheDocument();
    expect(
      screen.queryByText("Resumen generado con IA a partir del caso. Verificalo en el caso antes de actuar.")
    ).toBeNull();
  });

  it("con historial, no genera el warning de anidamiento inválido de DOM", async () => {
    // El `<div>` ancla de scroll iba directo adentro del `<ul>` (sólo admite
    // `<li>`); React avisa ese error por consola en vez de tirar una excepción.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockFetch = mockFetchOk({ texto: "Hubo 9 casos.", herramienta: "contar_casos", casos: [] });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("¿Cuántos casos hubo este mes?"));
    await screen.findByText("Hubo 9 casos.");

    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("validateDOMNesting"));
    errorSpy.mockRestore();
  });

  it("guarda sólo las últimas 5 preguntas", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    const textarea = screen.getByLabelText("Tu pregunta");
    const enviar = screen.getByTestId("asistente-submit");

    for (let n = 1; n <= 6; n++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ texto: `Respuesta ${n}`, herramienta: "ninguna", casos: [] }),
      });
      await user.clear(textarea);
      await user.type(textarea, `Pregunta ${n}`);
      await user.click(enviar);
      await screen.findByText(`Respuesta ${n}`);
    }

    expect(screen.queryByText("Respuesta 1")).toBeNull();
    expect(screen.getByText("Respuesta 2")).toBeInTheDocument();
    expect(screen.getByText("Respuesta 6")).toBeInTheDocument();
  });

  it("un 429 muestra el aviso de demasiadas preguntas", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("¿Cuántos casos hubo este mes?"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Demasiadas preguntas seguidas. Esperá un momento y volvé a intentar."
    );
  });
});
