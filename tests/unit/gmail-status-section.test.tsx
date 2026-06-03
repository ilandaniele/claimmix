/**
 * Unit tests for GmailStatusSection component.
 *
 * AC3: Connected → green pill "Conectado" + relative last_polled_at.
 * AC4: Error     → red pill "Error" + last_error shown below.
 * AC5: Not configured → gray pill "Sin configurar".
 * AC6: HTTP 403 → component returns null (nothing rendered).
 */

import { render, screen, waitFor } from "@testing-library/react";
import { vi, beforeEach, describe, it, expect } from "vitest";
import { GmailStatusSection } from "../../src/app/(app)/configuracion/GmailStatusSection";

// ── Mock fetch globally ────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeJsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GmailStatusSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC3: shows green pill 'Conectado' when is_connected=true", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        email_address: "g***@claimmix.com",
        last_polled_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        is_connected: true,
        last_error: null,
      })
    );

    render(<GmailStatusSection />);

    await waitFor(() => {
      const pill = screen.getByRole("status");
      expect(pill).toHaveTextContent("Conectado");
      expect(pill.className).toContain("bg-green-100");
      expect(pill.className).toContain("text-green-700");
    });
  });

  it("AC3: shows relative last_polled_at timestamp when connected", async () => {
    // 5 minutes ago
    const polledAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockFetch.mockReturnValue(
      makeJsonResponse({
        email_address: "g***@claimmix.com",
        last_polled_at: polledAt,
        is_connected: true,
        last_error: null,
      })
    );

    render(<GmailStatusSection />);

    await waitFor(() => {
      // The relative time element should be in the document
      expect(screen.getByText(/hace/i)).toBeInTheDocument();
    });
  });

  it("AC4: shows red pill 'Error' when last_error is set", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        email_address: "g***@claimmix.com",
        last_polled_at: "2026-06-01T00:00:00Z",
        is_connected: false,
        last_error: "invalid_grant",
      })
    );

    render(<GmailStatusSection />);

    await waitFor(() => {
      const pill = screen.getByRole("status");
      expect(pill).toHaveTextContent("Error");
      expect(pill.className).toContain("bg-red-100");
      expect(pill.className).toContain("text-red-700");
    });
  });

  it("AC4: shows last_error message below the pill when error is set", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        email_address: null,
        last_polled_at: "2026-06-01T00:00:00Z",
        is_connected: false,
        last_error: "invalid_grant",
      })
    );

    render(<GmailStatusSection />);

    await waitFor(() => {
      expect(screen.getByText("invalid_grant")).toBeInTheDocument();
    });
  });

  it("AC4: truncates last_error to 100 chars with ellipsis", async () => {
    const longError = "a".repeat(150);
    mockFetch.mockReturnValue(
      makeJsonResponse({
        email_address: null,
        last_polled_at: null,
        is_connected: false,
        last_error: longError,
      })
    );

    render(<GmailStatusSection />);

    await waitFor(() => {
      const errorEl = screen.getByText(/a+…/);
      expect(errorEl.textContent!.length).toBeLessThanOrEqual(102); // 100 chars + "…"
    });
  });

  it("AC5: shows gray pill 'Sin configurar' when last_polled_at=null and last_error=null", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        email_address: null,
        last_polled_at: null,
        is_connected: false,
        last_error: null,
      })
    );

    render(<GmailStatusSection />);

    await waitFor(() => {
      const pill = screen.getByRole("status");
      expect(pill).toHaveTextContent("Sin configurar");
      expect(pill.className).toContain("bg-slate-100");
      expect(pill.className).toContain("text-slate-600");
    });
  });

  it("AC6: renders nothing when API returns 403", async () => {
    mockFetch.mockReturnValue(makeJsonResponse({ error: { code: "FORBIDDEN_ROLE" } }, 403));

    const { container } = render(<GmailStatusSection />);

    await waitFor(() => {
      // After the fetch resolves (403), the component should render null.
      // The container will have no meaningful child content.
      expect(container.firstChild).toBeNull();
    });
  });

  it("renders nothing when API returns a network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const { container } = render(<GmailStatusSection />);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("shows loading skeleton initially", () => {
    // Fetch never resolves during this test
    mockFetch.mockReturnValue(new Promise(() => {}));

    render(<GmailStatusSection />);

    // During loading, the skeleton element with aria-busy should be present
    const busyEl = document.querySelector("[aria-busy='true']");
    expect(busyEl).not.toBeNull();
  });
});
