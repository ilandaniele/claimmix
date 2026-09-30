/**
 * CajaDelAsistente — chips de sugerencia, historial acotado a 5 y el aviso de
 * resumen con IA, y el modo de un caso (B12): pregunta con `caseId`, hilo
 * guardado que vuelve al abrir el caso y un historial por pantalla.
 * `AsistenteFlotante` se prueba aparte: acá se prueba la caja sola, como vive
 * en `/asistente`.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { CajaDelAsistente } from "../../../src/app/(app)/asistente/_components/CajaDelAsistente";

const CASO = "00000000-0000-0000-0000-0000a1a1a1a1";
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

  it("no se autoenfoca al montar: el foco lo decide el panel flotante, no la caja", async () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<CajaDelAsistente textareaRef={ref} />);
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

  it("en /casos/[id] ofrece «Resumí este caso» y pregunta por su número, con el caso", async () => {
    pathname = `/casos/${CASO}`;
    const mockFetch = mockFetchOk({ texto: "Resumen.", herramienta: "pregunta_caso", casos: [] });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("Resumí este caso"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/asistente",
        expect.objectContaining({
          body: JSON.stringify({ pregunta: "¿Qué pasó con el caso SIN-A1A1-A1A1?", caseId: CASO }),
        })
      );
    });
  });

  it("en un caso, las preguntas del textarea también van con el caseId", async () => {
    pathname = `/casos/${CASO}`;
    const mockFetch = mockFetchOk({ texto: "Falta el DNI.", herramienta: "pregunta_caso", casos: [] });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.type(screen.getByLabelText("Tu pregunta"), "¿Qué falta?");
    await user.click(screen.getByTestId("asistente-submit"));

    expect(await screen.findByText("Falta el DNI.")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/asistente",
      expect.objectContaining({ body: JSON.stringify({ pregunta: "¿Qué falta?", caseId: CASO }) })
    );
  });

  it("en un caso no ofrece las preguntas generales: mandarlas con el caseId las contestaría mal", () => {
    pathname = `/casos/${CASO}`;
    render(<CajaDelAsistente />);

    expect(screen.queryByText("¿Cuántos casos hubo este mes?")).toBeNull();
    expect(screen.queryByText("Buscá el caso de…")).toBeNull();
    expect(screen.getByPlaceholderText(/Preguntá sobre este caso/)).toBeInTheDocument();
  });

  it("al abrir el caso pide el hilo guardado y lo muestra", async () => {
    pathname = `/casos/${CASO}`;
    const mockFetch = mockFetchOk({
      turnos: [
        { rol: "user", texto: "¿Qué falta?" },
        { rol: "assistant", texto: "Falta el DNI, según el denunciante." },
      ],
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<CajaDelAsistente />);

    expect(await screen.findByText("Falta el DNI, según el denunciante.")).toBeInTheDocument();
    expect(screen.getByText("¿Qué falta?")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(`/api/asistente?caseId=${CASO}`);
  });

  it("pide el hilo una sola vez por caso, aunque la caja se vuelva a dibujar", async () => {
    pathname = `/casos/${CASO}`;
    const mockFetch = mockFetchOk({ turnos: [] });
    vi.stubGlobal("fetch", mockFetch);

    const { rerender } = render(<CajaDelAsistente />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    rerender(<CajaDelAsistente />);
    rerender(<CajaDelAsistente />);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("si el hilo no se puede pedir, la caja abre igual y se puede preguntar", async () => {
    pathname = `/casos/${CASO}`;
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("sin red"));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ texto: "Respuesta.", herramienta: "pregunta_caso", casos: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("Resumí este caso"));

    expect(await screen.findByText("Respuesta.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("un turno suelto o mal formado del hilo no se muestra", async () => {
    pathname = `/casos/${CASO}`;
    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        turnos: [
          { rol: "assistant", texto: "Suelto." },
          { rol: "user", texto: "Otra." },
        ],
      })
    );

    render(<CajaDelAsistente />);
    await waitFor(() => expect(screen.getByTestId("asistente-chips")).toBeInTheDocument());

    expect(screen.queryByText("Suelto.")).toBeNull();
  });

  it("una respuesta sin leer muestra la frase del diccionario y no el aviso de IA", async () => {
    pathname = `/casos/${CASO}`;
    vi.stubGlobal(
      "fetch",
      mockFetchOk({ texto: "texto del servidor", herramienta: "pregunta_caso", casos: [], sinLeer: "cupo" })
    );
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("Resumí este caso"));

    expect(await screen.findByText("Sin leer: se llegó al tope de lecturas por hoy.")).toBeInTheDocument();
    expect(screen.queryByText("texto del servidor")).toBeNull();
    expect(
      screen.queryByText("Respuesta generada con IA a partir del caso. Verificala en el caso antes de actuar.")
    ).toBeNull();
  });

  it("una respuesta sobre un caso avisa que es de IA", async () => {
    pathname = `/casos/${CASO}`;
    vi.stubGlobal("fetch", mockFetchOk({ texto: "Falta el DNI.", herramienta: "pregunta_caso", casos: [] }));
    const user = userEvent.setup();

    render(<CajaDelAsistente />);
    await user.click(screen.getByText("Resumí este caso"));

    expect(
      await screen.findByText("Respuesta generada con IA a partir del caso. Verificala en el caso antes de actuar.")
    ).toBeInTheDocument();
  });

  it("cada pantalla lleva su historial: lo hablado en un caso no aparece en otro", async () => {
    pathname = `/casos/${CASO}`;
    vi.stubGlobal("fetch", mockFetchOk({ texto: "Del primer caso.", herramienta: "pregunta_caso", casos: [] }));
    const user = userEvent.setup();

    const { rerender } = render(<CajaDelAsistente />);
    await user.click(screen.getByText("Resumí este caso"));
    await screen.findByText("Del primer caso.");

    pathname = "/casos/00000000-0000-0000-0000-0000b2b2b2b2";
    vi.stubGlobal("fetch", mockFetchOk({ turnos: [] }));
    rerender(<CajaDelAsistente />);

    expect(screen.queryByText("Del primer caso.")).toBeNull();

    pathname = `/casos/${CASO}`;
    rerender(<CajaDelAsistente />);
    expect(screen.getByText("Del primer caso.")).toBeInTheDocument();
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
