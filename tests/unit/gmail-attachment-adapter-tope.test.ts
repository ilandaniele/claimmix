// @vitest-environment node
/**
 * Tope por mensaje y plazo por bajada en gmail-attachment-adapter.ts: un mensaje
 * con árbol MIME hostil no puede gastar el presupuesto del poller ni hacer que
 * un adjunto desaparezca sin dejar fila.
 */

import { describe, it, expect, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";

vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "@/lib/observability/logger";
import {
  adaptGmailAttachments,
  TOPE_DE_ADJUNTOS_POR_MENSAJE,
} from "@/server/email/gmail/gmail-attachment-adapter";
import type { GmailAttachmentFetcher } from "@/server/email/gmail/gmail-attachment-adapter";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePart(opts: {
  filename?: string;
  mimeType?: string;
  data?: string;
  attachmentId?: string;
  disposition?: string;
  size?: number;
  parts?: gmail_v1.Schema$MessagePart[];
}): gmail_v1.Schema$MessagePart {
  const headers: gmail_v1.Schema$MessagePartHeader[] = [];
  if (opts.disposition) {
    headers.push({ name: "Content-Disposition", value: opts.disposition });
  }

  return {
    filename: opts.filename,
    mimeType: opts.mimeType ?? "application/octet-stream",
    headers,
    body: {
      data: opts.data,
      attachmentId: opts.attachmentId,
      size: opts.size ?? (opts.data ? Math.floor(opts.data.length * 0.75) : 0),
    },
    parts: opts.parts,
  };
}

function makeGmailMock(attachmentData?: string): GmailAttachmentFetcher {
  return {
    users: {
      messages: {
        attachments: {
          get: vi.fn().mockResolvedValue({
            data: { data: attachmentData ?? "", size: 100 },
          }),
        },
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("adaptGmailAttachments — tope y plazo", () => {
  it("no baja más de TOPE_DE_ADJUNTOS_POR_MENSAJE por mensaje y anota los que siguen", async () => {
    const parts = Array.from({ length: 45 }, (_, i) =>
      makePart({
        filename: `f${i}.pdf`,
        mimeType: "application/pdf",
        attachmentId: `a${i}`,
        size: 10,
      })
    );
    const gmail = makeGmailMock("QUJD");

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(TOPE_DE_ADJUNTOS_POR_MENSAJE).toBe(20);
    expect(gmail.users.messages.attachments.get).toHaveBeenCalledTimes(20);
    expect(result).toHaveLength(40);
    expect(result.slice(0, 20).every((r) => r.Content === "QUJD")).toBe(true);
    expect(
      result
        .slice(20)
        .every(
          (r) =>
            r.rechazoPrevio === "aggregate_size_exceeded" &&
            r.Content === "" &&
            r.ContentLength === 10
        )
    ).toBe(true);
    expect(result[39].Name).toBe("f39.pdf");
  });

  it("cada bajada lleva un plazo", async () => {
    const parts = [
      makePart({
        filename: "f0.pdf",
        mimeType: "application/pdf",
        attachmentId: "a0",
        size: 10,
      }),
    ];
    const gmail = makeGmailMock("QUJD");

    await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(gmail.users.messages.attachments.get).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a0" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("una bajada que se corta queda anotada, no desaparece", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          code: "TimeoutError",
        })
      )
      .mockResolvedValueOnce({ data: { data: "QUJD", size: 3 } });
    const gmail: GmailAttachmentFetcher = {
      users: { messages: { attachments: { get } } },
    };
    const parts = [
      makePart({
        filename: "f0.pdf",
        mimeType: "application/pdf",
        attachmentId: "a0",
        size: 10,
      }),
      makePart({
        filename: "f1.pdf",
        mimeType: "application/pdf",
        attachmentId: "a1",
        size: 10,
      }),
    ];

    const result = await adaptGmailAttachments(parts, "msg-1", gmail);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      Name: "f0.pdf",
      Content: "",
      ContentType: "application/pdf",
      ContentLength: 10,
      rechazoPrevio: "download_failed",
    });
    expect(result[1].Content).toBe("QUJD");
    // GaxiosError deja name en "Error" y pone el nombre del DOMException en code.
    expect(logger.error).toHaveBeenCalledWith(
      { code: "TimeoutError" },
      "gmail_attachment_adapter.failed_to_fetch_attachment"
    );
  });
});
