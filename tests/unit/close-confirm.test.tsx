/**
 * Unit tests for CloseConfirmDialog.
 *
 * AC15: Typed confirmation validation:
 *   - Confirm button is disabled until user types the exact case number.
 *   - Confirm button enables when typed value matches caseNumber.
 *   - Calls PATCH on confirm.
 *   - Shows FSM error on 409 response.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloseConfirmDialog } from "../../src/app/(app)/casos/[id]/components/CloseConfirmDialog";

const CASE_ID = "00000000-0000-0000-0000-000000000001";
const CASE_NUMBER = "SIN-ABCD-1234";

const defaultProps = {
  caseId: CASE_ID,
  caseNumber: CASE_NUMBER,
  onClose: vi.fn(),
  onSuccess: vi.fn(),
  onError: vi.fn(),
};

function renderDialog(overrides = {}) {
  return render(<CloseConfirmDialog {...defaultProps} {...overrides} />);
}

describe("CloseConfirmDialog — typed confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fetch globally
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the dialog with title", () => {
    renderDialog();
    expect(
      screen.getByRole("dialog")
    ).toBeInTheDocument();
    expect(screen.getByText(/cerrar siniestro/i)).toBeInTheDocument();
  });

  it("renders the description text", () => {
    renderDialog();
    expect(
      screen.getByText(/esta acción no puede deshacerse/i)
    ).toBeInTheDocument();
  });

  it("shows the case number in the label", () => {
    renderDialog();
    expect(screen.getByText(CASE_NUMBER)).toBeInTheDocument();
  });

  it("confirm button is disabled when input is empty", () => {
    renderDialog();
    const button = screen.getByTestId("close-confirm-button");
    expect(button).toBeDisabled();
  });

  it("confirm button is disabled when input is wrong", async () => {
    renderDialog();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "SIN-WRONG-1234");
    const button = screen.getByTestId("close-confirm-button");
    expect(button).toBeDisabled();
  });

  it("confirm button enables when input matches case number exactly", async () => {
    renderDialog();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, CASE_NUMBER);
    const button = screen.getByTestId("close-confirm-button");
    expect(button).not.toBeDisabled();
  });

  it("partial match does not enable button", async () => {
    renderDialog();
    const input = screen.getByRole("textbox");
    // Type only part of the case number
    await userEvent.type(input, "SIN-ABCD");
    const button = screen.getByTestId("close-confirm-button");
    expect(button).toBeDisabled();
  });

  it("calls PATCH /api/cases/:id on confirm", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    renderDialog();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, CASE_NUMBER);

    const button = screen.getByTestId("close-confirm-button");
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/cases/${CASE_ID}`,
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });
  });

  it("calls onSuccess when fetch returns ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    renderDialog();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, CASE_NUMBER);

    fireEvent.click(screen.getByTestId("close-confirm-button"));

    await waitFor(() => {
      expect(defaultProps.onSuccess).toHaveBeenCalledOnce();
    });
  });

  it("calls onError with FSM message on 409 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    vi.stubGlobal("fetch", mockFetch);

    renderDialog();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, CASE_NUMBER);

    fireEvent.click(screen.getByTestId("close-confirm-button"));

    await waitFor(() => {
      expect(defaultProps.onError).toHaveBeenCalledWith(
        "Transición de estado no válida."
      );
    });
  });

  it("calls onError with generic message on non-409 error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", mockFetch);

    renderDialog();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, CASE_NUMBER);

    fireEvent.click(screen.getByTestId("close-confirm-button"));

    await waitFor(() => {
      expect(defaultProps.onError).toHaveBeenCalledOnce();
    });
  });

  it("calls onClose when Cancel button is clicked", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /cancelar/i }));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  it("has a reason selector with correct options", () => {
    renderDialog();
    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();
    // Should have at least the 4 defined reasons
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThanOrEqual(4);
  });

  it("is accessible — dialog role + aria-modal", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  });
});
