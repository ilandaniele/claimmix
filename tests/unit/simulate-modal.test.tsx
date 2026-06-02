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
    expect(screen.getByText("Simular nuevo siniestro")).toBeInTheDocument();
  });

  it("renders all 20 scenarios in the dropdown", () => {
    render(<SimulateModal {...defaultProps} />);
    const select = screen.getByLabelText("Escenario");
    const options = select.querySelectorAll("option");
    expect(options).toHaveLength(20);
  });

  it("shows first scenario selected by default", () => {
    render(<SimulateModal {...defaultProps} />);
    const select = screen.getByLabelText("Escenario") as HTMLSelectElement;
    expect(select.value).toBe(SCENARIOS[0]!.id);
  });

  it("calls onClose when Cancelar button is clicked", async () => {
    const user = userEvent.setup();
    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByText("Cancelar"));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  it("switches to custom mode when text personalizado tab is clicked", async () => {
    const user = userEvent.setup();
    render(<SimulateModal {...defaultProps} />);
    await user.click(screen.getByText("Texto personalizado"));
    expect(screen.getByLabelText("Texto del siniestro")).toBeInTheDocument();
    expect(screen.getByLabelText("Tipo de siniestro")).toBeInTheDocument();
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
    expect(defaultProps.onSuccess).toHaveBeenCalledWith("Procesando siniestro...");
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
    await user.click(screen.getByText("Texto personalizado"));
    await user.type(screen.getByLabelText("Texto del siniestro"), "Mi auto fue chocado");
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
      expect(defaultProps.onError).toHaveBeenCalledWith(
        "Demasiadas simulaciones. Espere un momento."
      );
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
    await user.click(screen.getByText("Texto personalizado"));
    // Don't type anything — submit with empty text
    await user.click(screen.getByTestId("simulate-submit"));

    expect(defaultProps.onError).toHaveBeenCalledWith("Ingresá el texto del siniestro.");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
