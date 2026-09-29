/**
 * Unit tests for MessagesThread component.
 *
 * AC11: Renders one message-card per message with from_addr, subject,
 *       body_text preview, and relative received_at.
 * AC12: Returns null (no messages-thread element) when messages array is empty.
 * AC13: body_text preview is at most 300 chars and ends with "…" when long.
 * AC14: Attachment count badge is visible when attachment_count > 0.
 * Conversación: lo entrante y lo saliente, cada uno con su autor, el estado
 *       de envío cuando lo saliente no llegó a la persona, y el aviso cuando
 *       se muestran sólo los últimos.
 *
 * Uses vi.stubGlobal("fetch", ...) to mock the fetch call.
 */

import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, beforeEach, describe, it, expect } from "vitest";
import { MessagesThread } from "../../src/app/(app)/casos/[id]/_components/MessagesThread";
import type { EstadoDeRespuesta } from "@/core/whatsapp/puede-responder";
import { ENCABEZADO_TRANSCRIPCION } from "@/core/adjuntos/transcripcion";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

// ── Mock fetch globally ────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock next/navigation (F: router.refresh tras un envío) ────────────────────

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: nav.refresh }),
}));

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
  estado_envio: string | null;
  attachment_count: number;
  autor: string;
  transcripcion: boolean;
}> = {}) {
  return {
    id: "msg-001",
    direction: "inbound",
    provider: "gmail",
    subject: "Test subject for the email",
    from_addr: "claimant@example.com",
    body_text: "This is the body of the email message.",
    received_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    estado_envio: null,
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

  it("bajo StrictMode (dev) igual llega a mostrar la tarjeta tras el montaje doble", async () => {
    mockFetch.mockReturnValue(makeJsonResponse({ messages: [makeMessage()] }));

    render(
      <StrictMode>
        <MessagesThread caseId={CASE_ID} />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByTestId("message-card")).toBeInTheDocument();
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

  it("el viewer ve '?' y no '[': su remitente llega como «[oculto]»", async () => {
    mockFetch.mockReturnValue(makeJsonResponse({ messages: [makeMessage({ from_addr: "[oculto]" })] }));

    render(<MessagesThread caseId={CASE_ID} />);

    await waitFor(() => expect(screen.getByText("?")).toBeInTheDocument());
    expect(screen.queryByText("[")).not.toBeInTheDocument();
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

  describe("la conversación", () => {
    const respuesta = (o: Parameters<typeof makeMessage>[0] = {}) =>
      makeMessage({
        id: "msg-out",
        direction: "outbound",
        subject: "Re: Test subject for the email",
        from_addr: "siniestros@aseguradora.com",
        body_text: "Nos falta la foto del registro.",
        estado_envio: "sent",
        received_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        ...o,
      });

    it("muestra lo entrante y lo saliente en el orden en que llegan, cada uno con su autor", async () => {
      mockFetch.mockReturnValue(makeJsonResponse({ messages: [makeMessage(), respuesta()] }));

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => {
        const cards = screen.getAllByTestId("message-card");
        expect(cards.map((c) => c.getAttribute("data-direction"))).toEqual(["inbound", "outbound"]);
        expect(within(cards[0]!).getByText("Denunciante")).toBeInTheDocument();
        expect(within(cards[1]!).getByText("Agente")).toBeInTheDocument();
      });
    });

    it("marca el mensaje que trae la transcripción de una nota de voz", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({
          messages: [makeMessage({ provider: "whatsapp", transcripcion: true }), makeMessage({ id: "msg-002" })],
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => {
        const cards = screen.getAllByTestId("message-card");
        expect(within(cards[0]!).getByText("Transcripción de audio")).toBeInTheDocument();
        expect(within(cards[1]!).queryByText("Transcripción de audio")).not.toBeInTheDocument();
      });
    });

    it("en inglés el encabezado de la transcripción sale traducido", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({
          messages: [makeMessage({ body_text: `${ENCABEZADO_TRANSCRIPCION}\nChoqué ayer.`, transcripcion: true })],
        })
      );

      render(
        <LocaleProvider locale="en-US">
          <MessagesThread caseId={CASE_ID} />
        </LocaleProvider>
      );

      await waitFor(() => expect(screen.getByText(/Voice note transcript:/)).toBeInTheDocument());
      expect(screen.queryByText(new RegExp(ENCABEZADO_TRANSCRIPCION))).not.toBeInTheDocument();
    });

    it("lo que se mandó bien no lleva etiqueta de estado", async () => {
      mockFetch.mockReturnValue(makeJsonResponse({ messages: [respuesta()] }));

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByText("Agente")).toBeInTheDocument());
      expect(screen.queryByText("No se envió")).not.toBeInTheDocument();
      expect(screen.queryByText("Simulado")).not.toBeInTheDocument();
    });

    it("avisa cuando una respuesta no se envió", async () => {
      mockFetch.mockReturnValue(makeJsonResponse({ messages: [respuesta({ estado_envio: "failed" })] }));

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByText("No se envió")).toBeInTheDocument());
    });

    it("el mail que quedó a medio mandar no se muestra como entregado", async () => {
      mockFetch.mockReturnValue(makeJsonResponse({ messages: [respuesta({ estado_envio: "queued" })] }));

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByText("Sin confirmar")).toBeInTheDocument());
    });

    it("marca como simulado el mail que no salió de verdad, sin asunto que no tiene", async () => {
      // Como llega la vista previa del mail simulado: sin asunto ni remitente.
      mockFetch.mockReturnValue(
        makeJsonResponse({
          messages: [
            respuesta({ provider: "email", subject: null, from_addr: null, estado_envio: "skipped_simulated" }),
          ],
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByText("Simulado")).toBeInTheDocument());
      expect(screen.queryByText("(sin asunto)")).not.toBeInTheDocument();
      expect(screen.getByText("A")).toBeInTheDocument();
    });

    it("lo saliente lleva la inicial del agente aunque el viewer vea el remitente oculto", async () => {
      mockFetch.mockReturnValue(makeJsonResponse({ messages: [respuesta({ from_addr: "[oculto]" })] }));

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());
      expect(screen.queryByText("[")).not.toBeInTheDocument();
    });

    it("avisa cuando se muestran sólo los últimos mensajes", async () => {
      mockFetch.mockReturnValue(makeJsonResponse({ messages: [makeMessage()], recortada: true }));

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() =>
        expect(screen.getByText("Se muestran sólo los mensajes más recientes.")).toBeInTheDocument()
      );
    });

    it("y no avisa nada cuando está entera", async () => {
      mockFetch.mockReturnValue(makeJsonResponse({ messages: [makeMessage()], recortada: false }));

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByTestId("message-card")).toBeInTheDocument());
      expect(screen.queryByText("Se muestran sólo los mensajes más recientes.")).not.toBeInTheDocument();
    });

    it("WhatsApp no muestra asunto, y lo saliente sin remitente lleva la inicial del agente", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({
          messages: [
            makeMessage({ provider: "whatsapp", subject: "WhatsApp", from_addr: "5491100000000" }),
            respuesta({ provider: "whatsapp", subject: null, from_addr: null }),
          ],
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getAllByTestId("message-card")).toHaveLength(2));
      // "WhatsApp" sólo por la píldora de canal (I), una por tarjeta: si el
      // asunto se mostrara habría una tercera aparición.
      expect(screen.getAllByText("WhatsApp")).toHaveLength(2);
      expect(screen.queryByText("(sin asunto)")).not.toBeInTheDocument();
      const [, saliente] = screen.getAllByTestId("message-card");
      expect(within(saliente!).getByText("A")).toBeInTheDocument();
    });

    it("I: la píldora de canal distingue WhatsApp de Mail", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({
          messages: [
            makeMessage({ id: "wa-1", provider: "whatsapp" }),
            makeMessage({ id: "gmail-1", provider: "gmail", received_at: new Date(Date.now() - 1000).toISOString() }),
          ],
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getAllByTestId("message-card")).toHaveLength(2));
      const [wa, mail] = screen.getAllByTestId("message-card");
      expect(within(wa!).getByText("WhatsApp")).toBeInTheDocument();
      expect(within(mail!).getByText("Mail")).toBeInTheDocument();
    });

    it("E: la plantilla de respuesta humana muestra 'Equipo' y no 'Agente'", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({ messages: [respuesta({ autor: "equipo" })] })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByText("Equipo")).toBeInTheDocument());
      expect(screen.queryByText("Agente")).not.toBeInTheDocument();
    });
  });

  describe("responder por WhatsApp (P8)", () => {
    const HABILITADA: EstadoDeRespuesta = { habilitada: true, motivo: null, vence_en: "2026-09-26T12:00:00.000Z" };

    it("habilitada: muestra la caja y manda el texto al enviar", async () => {
      const user = userEvent.setup();
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );
      mockFetch.mockReturnValueOnce(makeJsonResponse({ id: "outbound-1", estado: "sent" }));
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      const textarea = await screen.findByPlaceholderText("Escribí la respuesta para el denunciante…");
      await user.type(textarea, "Ya está resuelto.");
      await user.click(screen.getByRole("button", { name: "Enviar" }));

      await waitFor(() => expect(screen.getByText("Enviado.")).toBeInTheDocument());
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        `/api/cases/${CASE_ID}/responder`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ texto: "Ya está resuelto." }),
        })
      );
    });

    it("F: después de un envío exitoso, vuelve a pedir el hilo y refresca la ruta", async () => {
      const user = userEvent.setup();
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );
      mockFetch.mockReturnValueOnce(makeJsonResponse({ id: "outbound-1", estado: "sent" }));
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({
          messages: [makeMessage()],
          recortada: false,
          respuesta: { habilitada: false, motivo: "agente_activo", vence_en: null },
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      const textarea = await screen.findByPlaceholderText("Escribí la respuesta para el denunciante…");
      await user.type(textarea, "Ya está resuelto.");
      await user.click(screen.getByRole("button", { name: "Enviar" }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      expect(mockFetch).toHaveBeenNthCalledWith(3, `/api/cases/${CASE_ID}/messages`);
      await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
    });

    it("H: muestra hasta cuándo se puede responder cuando la ventana tiene vencimiento", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await screen.findByPlaceholderText("Escribí la respuesta para el denunciante…");
      expect(screen.getByText(/Podés responder hasta el/)).toBeInTheDocument();
    });

    it("G: 403 al enviar bloquea la caja por plan", async () => {
      const user = userEvent.setup();
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ error: { code: "PLAN_REQUERIDO", message: "Disponible con el Plan Pro." } }, 403)
      );

      render(<MessagesThread caseId={CASE_ID} />);

      const textarea = await screen.findByPlaceholderText("Escribí la respuesta para el denunciante…");
      await user.type(textarea, "Ya está resuelto.");
      await user.click(screen.getByRole("button", { name: "Enviar" }));

      await waitFor(() => expect(screen.getByText("Disponible con el Plan Pro")).toBeInTheDocument());
      expect(screen.queryByPlaceholderText("Escribí la respuesta para el denunciante…")).not.toBeInTheDocument();
    });

    it("G: 409 con motivo cierra la caja con la explicación real", async () => {
      const user = userEvent.setup();
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );
      mockFetch.mockReturnValueOnce(
        makeJsonResponse(
          {
            error: {
              code: "RESPUESTA_NO_PERMITIDA",
              message: "No se puede responder este caso por WhatsApp en este momento.",
              details: { motivo: "ventana" },
            },
          },
          409
        )
      );

      render(<MessagesThread caseId={CASE_ID} />);

      const textarea = await screen.findByPlaceholderText("Escribí la respuesta para el denunciante…");
      await user.type(textarea, "Ya está resuelto.");
      await user.click(screen.getByRole("button", { name: "Enviar" }));

      await waitFor(() =>
        expect(screen.getByText(/Pasaron más de 24 h desde el último mensaje/)).toBeInTheDocument()
      );
      expect(screen.queryByPlaceholderText("Escribí la respuesta para el denunciante…")).not.toBeInTheDocument();
    });

    it("G: un error sin motivo reconocido muestra el aviso genérico", async () => {
      const user = userEvent.setup();
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );
      mockFetch.mockReturnValueOnce(makeJsonResponse({ error: { code: "INTERNAL_ERROR", message: "Error." } }, 500));
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      const textarea = await screen.findByPlaceholderText("Escribí la respuesta para el denunciante…");
      await user.type(textarea, "Ya está resuelto.");
      await user.click(screen.getByRole("button", { name: "Enviar" }));

      await waitFor(() => expect(screen.getByText("No se pudo enviar. Probá de nuevo.")).toBeInTheDocument());
    });

    it("un 500 al enviar (ENVIO_FALLIDO) también vuelve a pedir el hilo, para que se vea la fila que quedó anotada", async () => {
      const user = userEvent.setup();
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );
      mockFetch.mockReturnValueOnce(makeJsonResponse({ error: { code: "ENVIO_FALLIDO", message: "Error." } }, 502));
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({
          messages: [
            makeMessage(),
            makeMessage({ id: "msg-out", direction: "outbound", autor: "agente", estado_envio: "failed" }),
          ],
          recortada: false,
          respuesta: HABILITADA,
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      const textarea = await screen.findByPlaceholderText("Escribí la respuesta para el denunciante…");
      await user.type(textarea, "Ya está resuelto.");
      await user.click(screen.getByRole("button", { name: "Enviar" }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      expect(mockFetch).toHaveBeenNthCalledWith(3, `/api/cases/${CASE_ID}/messages`);
      await waitFor(() => expect(screen.getByText("No se envió")).toBeInTheDocument());
    });

    it("si el refetch silencioso tras un envío exitoso falla, el hilo y el 'Enviado.' siguen a la vista", async () => {
      const user = userEvent.setup();
      mockFetch.mockReturnValueOnce(
        makeJsonResponse({ messages: [makeMessage()], recortada: false, respuesta: HABILITADA })
      );
      mockFetch.mockReturnValueOnce(makeJsonResponse({ id: "outbound-1", estado: "sent" }));
      mockFetch.mockReturnValueOnce(makeJsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500));

      render(<MessagesThread caseId={CASE_ID} />);

      const textarea = await screen.findByPlaceholderText("Escribí la respuesta para el denunciante…");
      await user.type(textarea, "Ya está resuelto.");
      await user.click(screen.getByRole("button", { name: "Enviar" }));

      await waitFor(() => expect(screen.getByText("Enviado.")).toBeInTheDocument());
      // El refetch falló pero era silencioso: sigue el hilo, no la pantalla de error genérico.
      expect(screen.getByTestId("messages-thread")).toBeInTheDocument();
      expect(screen.queryByText("Ocurrió un error inesperado. Intentá de nuevo.")).not.toBeInTheDocument();
    });

    it("sin Plan Pro: muestra el bloqueo y no la caja de texto", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({
          messages: [makeMessage()],
          recortada: false,
          respuesta: { habilitada: false, motivo: "plan", vence_en: null },
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByText("Disponible con el Plan Pro")).toBeInTheDocument());
      expect(screen.getByText("Responder por WhatsApp desde la app")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Escribí la respuesta para el denunciante…")).not.toBeInTheDocument();
    });

    it("fuera de la ventana: explica por qué, sin caja de texto", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({
          messages: [makeMessage()],
          recortada: false,
          respuesta: { habilitada: false, motivo: "ventana", vence_en: null },
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() =>
        expect(
          screen.getByText(/Pasaron más de 24 h desde el último mensaje/)
        ).toBeInTheDocument()
      );
      expect(screen.queryByPlaceholderText("Escribí la respuesta para el denunciante…")).not.toBeInTheDocument();
    });

    it("motivo rol: no muestra nada de la caja de respuesta", async () => {
      mockFetch.mockReturnValue(
        makeJsonResponse({
          messages: [makeMessage()],
          recortada: false,
          respuesta: { habilitada: false, motivo: "rol", vence_en: null },
        })
      );

      render(<MessagesThread caseId={CASE_ID} />);

      await waitFor(() => expect(screen.getByTestId("message-card")).toBeInTheDocument());
      expect(screen.queryByPlaceholderText("Escribí la respuesta para el denunciante…")).not.toBeInTheDocument();
      expect(screen.queryByText("Disponible con el Plan Pro")).not.toBeInTheDocument();
    });
  });
});

describe("la página del caso", () => {
  it("muestra la conversación para todos los canales, no sólo mail", () => {
    // Estaba detrás de `isEmailCase &&`: un caso de WhatsApp no la veía.
    const pagina = readFileSync("src/app/(app)/casos/[id]/page.tsx", "utf8");
    const hilo = "<MessagesThread caseId={caseRow.id} />";
    expect(pagina).toContain(hilo);

    const antes = pagina.slice(0, pagina.indexOf(hilo)).trimEnd();
    expect(antes).not.toMatch(/(&&|\?|:|\(|=>)$/);
  });
});
