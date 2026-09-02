/**
 * Unit tests for SimulateModal component.
 *
 * Tests:
 *   - Renders scenario dropdown with all 20 scenarios
 *   - Renders mode switch (scenario / custom)
 *   - Shows custom text area and type selector in custom mode
 *   - Calls onClose when "Cancelar" is clicked
 *   - Calls fetch and onSuccess when submitted with valid scenario
 *   - Shows rate limit error (429) as error message
 *   - Shows generic error on network failure
 *   - Disables submit button while submitting
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { SimulateModal } from "../../src/app/(app)/bandeja/components/SimulateModal";
import { SCENARIOS } from "../../src/server/intake/scenarios";
import { esAR } from "../../src/lib/i18n/es-AR";

/*
 * Los textos salen del diccionario, no escritos a mano.
 *
 * Escritos a mano el test comprueba dos cosas a la vez y no distingue cual
 * fallo: que el modal use la clave correcta, y que esa clave diga exactamente
 * lo que alguien tipeo aca alguna vez. Lo segundo no es una invariante — el
 * dia que se corrige un «Espere» por un «Espera», el test se pone rojo sin que
 * se haya roto nada.
 *
 * Sin `LocaleProvider` alrededor, `useT` cae al valor por defecto del
 * contexto, que es es-AR; por eso alcanza con este diccionario.
 */

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock crypto.randomUUID for toast IDs
vi.stubGlobal("crypto", {
  randomUUID: () => "test-uuid-1234",
});

describe("SimulateModal", () => {
  const defaultProps = {
    scenarios: SCENARIOS,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders modal title", () => {
    render(<SimulateModal {...defaultProps} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(esAR["simulate.title"])).toBeInTheDocument();
  });

  it("renders all scenarios in the dropdown", () => {
    render(<SimulateModal {...defaultProps} />);
    const select = screen.getByLabelText(esAR["simulate.escenarioLabel"]);
    const options = select.querySelectorAll("option");
    expect(options).toHaveLength(SCENARIOS.length);
  });

  it("shows first scenario selected by default", () => {
    render(<SimulateModal {...defaultProps} />);
    const select = screen.getByLabelText(esAR["simulate.escenarioLabel"]) as HTMLSelectElement;
    expect(select.value).toBe(SCENARIOS[0]!.id);
  });

  it("calls onClose when Cancelar button is clicked", async () => {
    const user = userEvent.setup();
    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByText(esAR["simulate.cancel"]));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  it("switches to custom mode when text personalizado tab is clicked", async () => {
    const user = userEvent.setup();
    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByText(esAR["simulate.modoTexto"]));
    expect(screen.getByLabelText(esAR["simulate.textoLabel"])).toBeInTheDocument();
    expect(screen.getByLabelText(esAR["simulate.scenario"])).toBeInTheDocument();
  });

  it("submits scenario mode with correct body", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ case_id: "uuid-123", status: "procesando" }),
    });

    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByTestId("simulate-submit"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/intake/simulate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ scenario_id: SCENARIOS[0]!.id }),
        })
      );
    });
    expect(defaultProps.onSuccess).toHaveBeenCalledWith(esAR["simulate.procesando"]);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("submits custom mode with raw_text and case_type", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ case_id: "uuid-456", status: "procesando" }),
    });

    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByText(esAR["simulate.modoTexto"]));
    await user.type(screen.getByLabelText(esAR["simulate.textoLabel"]), "Mi auto fue chocado");
    await user.click(screen.getByTestId("simulate-submit"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/intake/simulate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            raw_text: "Mi auto fue chocado",
            case_type: "choque",
          }),
        })
      );
    });
  });

  it("calls onError with rate-limit message on 429", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    });

    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByTestId("simulate-submit"));

    await waitFor(() => {
      expect(defaultProps.onError).toHaveBeenCalledWith(esAR["simulate.demasiadas"]);
    });
  });

  it("calls onError with server error message on 500", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "Error interno del servidor." } }),
    });

    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByTestId("simulate-submit"));

    await waitFor(() => {
      expect(defaultProps.onError).toHaveBeenCalledWith("Error interno del servidor.");
    });
  });

  it("calls onError with fallback message on network failure", async () => {
    const user = userEvent.setup();
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByTestId("simulate-submit"));

    await waitFor(() => {
      expect(defaultProps.onError).toHaveBeenCalledWith(
        "Error al simular el siniestro. Intentá de nuevo."
      );
    });
  });

  it("disables submit button while submitting", async () => {
    const user = userEvent.setup();
    // Simulate slow fetch
    let resolveFetch!: (value: unknown) => void;
    mockFetch.mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));

    render(<SimulateModal {...defaultProps} />);
    const submitBtn = screen.getByTestId("simulate-submit");

    await user.click(submitBtn);
    expect(submitBtn).toBeDisabled();
    expect(submitBtn).toHaveTextContent("Simulando...");

    // Resolve the fetch to clean up
    resolveFetch({ ok: true, status: 202, json: async () => ({}) });
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
  });

  it("validates empty custom text and shows error", async () => {
    const user = userEvent.setup();
    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByText(esAR["simulate.modoTexto"]));
    // Don't type anything — submit with empty text
    await user.click(screen.getByTestId("simulate-submit"));

    expect(defaultProps.onError).toHaveBeenCalledWith("Ingresá el texto del siniestro.");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
