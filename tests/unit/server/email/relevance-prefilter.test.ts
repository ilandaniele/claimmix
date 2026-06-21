import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { classifyInboundEmailForIntake } from "@/server/email/relevance-prefilter";

describe("classifyInboundEmailForIntake", () => {
  it("skips empty Meta for Business notifications", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "Meta for Business <notification@facebookmail.com>",
        subject: "Meta for Business notification",
        bodyText: "",
        bodyHtml: "",
      })
    ).toMatchObject({
      action: "skip",
      category: "automated_non_claim",
    });
  });

  it("allows messages with claim signals even from automated-looking senders", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "notificaciones@example.com",
        subject: "Nuevo siniestro por choque",
        bodyText: "El asegurado informa una poliza y patente.",
        bodyHtml: "",
      })
    ).toEqual({ action: "allow" });
  });

  it("allows ordinary thin messages instead of dropping ambiguous mail", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "cliente@example.com",
        subject: "Consulta",
        bodyText: "Hola",
        bodyHtml: "",
      })
    ).toEqual({ action: "allow" });
  });

  it("skips bulk mail with no claim signal", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "news@example.com",
        subject: "Monthly update",
        bodyText: "Product newsletter",
        bodyHtml: "",
        headers: [{ name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.com>" }],
      })
    ).toMatchObject({
      action: "skip",
      category: "bulk_non_claim",
    });
  });
});
