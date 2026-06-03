/**
 * Unit tests for MessagesThread component.
 *
 * AC11: Renders one message-card per message with from_addr, subject,
 *       body_text preview, and relative received_at.
 * AC12: Returns null (no messages-thread element) when messages array is empty.
 * AC13: body_text preview is at most 300 chars and ends with "…" when long.
 * AC14: Attachment count badge is visible when attachment_count > 0.
 *
 * Uses vi.stubGlobal("fetch", ...) to mock the fetch call.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { vi, beforeEach, describe, it, expect } from "vitest";
import { MessagesThread } from "../../src/app/(app)/casos/[id]/_components/MessagesThread";

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

function makeMessage(overrides: Partial<{
  id: string;
  direction: string;
  provider: string;
  subject: string | null;
  from_addr: string | null;
  body_text: string | null;
  received_at: string;
  attachment_count: number;
}> = {}) {
  return {
    id: "msg-001",
    direction: "inbound",
    provider: "gmail",
    subject: "Test subject for the email",
    from_addr: "claimant@example.com",
    body_text: "This is the body of the email message.",
    received_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    attachment_count: 0,
    ...overrides,
  };
}

const CASE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MessagesThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AC12: renders null (no messages-thread element) when messages array is empty", async () => {
    mockFetch.mockReturnValue(makeJsonResponse({ messages: [] }));

    const { container } = render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='messages-thread']")).toBeNull();
    });
  });

  it("AC11: renders 3 message-card elements for 3 messages", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [
          makeMessage({ id: "msg-001" }),
          makeMessage({ id: "msg-002", received_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }),
          makeMessage({ id: "msg-003", received_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() }),
        ],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      const cards = screen.getAllByTestId("message-card");
      expect(cards).toHaveLength(3);
    });
  });

  it("AC11: each card shows from_addr", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ from_addr: "sender@example.com" })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      expect(screen.getByText("sender@example.com")).toBeInTheDocument();
    });
  });

  it("AC11: each card shows subject", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ subject: "Reclamación por choque" })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      expect(screen.getByText("Reclamación por choque")).toBeInTheDocument();
    });
  });

  it("AC11: each card shows body_text preview", async () => {
    const bodyText = "Este es el cuerpo del email de reclamo.";
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ body_text: bodyText })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      expect(screen.getByText(bodyText)).toBeInTheDocument();
    });
  });

  it("AC11: each card shows a relative received_at", async () => {
    // 3 days ago — should render something like "hace 3 días"
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ received_at: threeDaysAgo })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      // The relative time element should contain "hace" (es-AR relative format)
      const timeEl = screen.getByRole("article").querySelector("time");
      expect(timeEl).not.toBeNull();
      expect(timeEl!.textContent).toMatch(/hace/i);
    });
  });

  it("AC13: body_text preview is at most 300 chars when body_text is long (collapsed)", async () => {
    // Message has 800-char body (simulating server returning ≤500, but we test component truncation)
    const longBody = "a".repeat(400); // server can return up to 500; component shows 300 in collapsed
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ body_text: longBody })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      const card = screen.getByTestId("message-card");
      const previewEl = card.querySelector("p");
      expect(previewEl).not.toBeNull();
      // The visible text should be at most 300 chars + "…" (301 chars total)
      const visibleText = previewEl!.textContent ?? "";
      expect(visibleText.length).toBeLessThanOrEqual(301);
      expect(visibleText).toMatch(/…$/);
    });
  });

  it("AC13: body_text preview ends with ellipsis when truncated", async () => {
    const longBody = "b".repeat(500);
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ body_text: longBody })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      const card = screen.getByTestId("message-card");
      const previewEl = card.querySelector("p");
      expect(previewEl!.textContent).toMatch(/…$/);
    });
  });

  it("AC13: short body_text is NOT truncated (no ellipsis)", async () => {
    const shortBody = "Este es un mensaje corto.";
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ body_text: shortBody })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      expect(screen.getByText(shortBody)).toBeInTheDocument();
      const card = screen.getByTestId("message-card");
      const previewEl = card.querySelector("p");
      expect(previewEl!.textContent).not.toMatch(/…$/);
    });
  });

  it("AC14: shows attachment count badge when attachment_count > 0", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ attachment_count: 2 })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      // Badge with text "2" should be visible
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  it("AC14: attachment badge is NOT shown when attachment_count is 0", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ attachment_count: 0 })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      // No badge text "0" should be present
      expect(screen.queryByText("0")).not.toBeInTheDocument();
    });
  });

  it("shows loading skeleton while fetching", () => {
    // Fetch never resolves during this assertion
    mockFetch.mockReturnValue(new Promise(() => {}));

    render(<MessagesThread caseId={CASE_ID} />);

    // During loading, aria-busy skeleton elements should be present
    const busyEls = document.querySelectorAll("[aria-busy='true']");
    expect(busyEls.length).toBeGreaterThan(0);
  });

  it("shows no messages-thread element on fetch error", async () => {
    mockFetch.mockReturnValue(makeJsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500));

    const { container } = render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='messages-thread']")).toBeNull();
    });
  });

  it("shows fallback label for null subject", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ subject: null })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      // "(sin asunto)" is the i18n fallback for null subject
      expect(screen.getByText("(sin asunto)")).toBeInTheDocument();
    });
  });

  it("shows avatar circle with first letter of from_addr", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ from_addr: "juan@example.com" })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      // Avatar shows "J" (first letter of "juan")
      expect(screen.getByText("J")).toBeInTheDocument();
    });
  });

  it("shows '?' avatar when from_addr is null", async () => {
    mockFetch.mockReturnValue(
      makeJsonResponse({
        messages: [makeMessage({ from_addr: null })],
      })
    );

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => {
      expect(screen.getByText("?")).toBeInTheDocument();
    });
  });
});
