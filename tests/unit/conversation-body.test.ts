/**
 * Reading the whole conversation, not just the last thing said.
 *
 * A claimant wrote "tuve un problema con el auto anteayer", the agent asked
 * what kind of claim it was, they answered "fue un choque" — and the agent
 * then asked for the date of the accident. The date was in the first message,
 * which re-extraction was no longer reading. Asking twice is worse than not
 * asking: they answered, and it reads as though nobody looked.
 */

import { describe, it, expect } from "vitest";
// Del núcleo, y no de `@/server/worker/extract`, aunque desde ahí también se
// re-exporten. Importarlas desde el worker obliga a este archivo a cargar mil
// quinientas líneas que hablan con la base, y por eso más abajo hay dos
// `vi.mock` que nada tienen que ver con partir un texto en dos.
import { stripQuotedReply } from "@/core/email/conversation";

describe("stripQuotedReply", () => {
  it("drops the copy of our own email that a reply quotes back", () => {
    const body = [
      "Fue un choque. Venía por Av. Alem al 2300.",
      "",
      "El lun, 18 ago 2026 a las 21:31, ClaimMix <a@b.com> escribió:",
      "> Información adicional requerida",
      "> Necesitamos que nos proporciones la siguiente información:",
    ].join("\n");

    const out = stripQuotedReply(body);

    expect(out).toBe("Fue un choque. Venía por Av. Alem al 2300.");
    expect(out).not.toContain("Información adicional requerida");
  });

  it("handles the English attribution line too", () => {
    const body = "It was a crash.\n\nOn Mon, Aug 18, 2026 at 9:31 PM Someone wrote:\n> quoted";
    expect(stripQuotedReply(body)).toBe("It was a crash.");
  });

  it("handles the Outlook separator", () => {
    const body = "Fue un choque.\n\n----- Mensaje original -----\nDe: ClaimMix";
    expect(stripQuotedReply(body)).toBe("Fue un choque.");
  });

  it("drops stray quoted lines even without an attribution line", () => {
    expect(stripQuotedReply("Mi respuesta\n> algo citado\nmás texto")).toBe(
      "Mi respuesta\nmás texto"
    );
  });

  it("leaves an ordinary message untouched", () => {
    const body = "Hola, tuve un problema con el auto anteayer y quería saber cómo sigo.";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("does not eat a line that merely starts with 'on' or 'el'", () => {
    // "El auto quedó..." must survive — only the attribution form ends in
    // "escribió:" / "wrote:".
    const body = "El auto quedó abollado del lado derecho.\nOn the way home.";
    expect(stripQuotedReply(body)).toBe(body);
  });

  it("returns empty for a message that was nothing but a quote", () => {
    expect(stripQuotedReply("> sólo texto citado")).toBe("");
  });
});

// ── The conversation loader ──────────────────────────────────────────────────

// La capa de datos, corriendo contra el db que este test ya simula.
//
// Las funciones migradas piden enTenant(ctx, (db) => consulta) en vez de
// hablar con db directamente. Lo que estos tests verifican —qué tabla, qué
// filtros de negocio, qué columnas— no cambió, así que alcanza con que la
// capa les entregue el db simulado.
//
// Lo que NO se prueba acá es que el contexto de inquilino llegue a la base:
// eso no se puede simular sin mentir. Se verifica en
// tests/unit/data-scope-sin-rol.test.ts y, contra bases de verdad, en
// `pnpm capa-datos` y `pnpm tenancy`.
vi.mock("@/data/scope", async () => {
  const mod = await import("@/lib/db");
  // Se lee `mod.db` en CADA llamada, sin desestructurar.
  //
  // El mock de @/lib/db expone `db` con un getter para que los tests puedan
  // intercambiar la base simulada entre corridas. Un `const { db } = ...`
  // llama al getter una sola vez y congela ese valor: al cambiar la base, el
  // puente seguía entregando la anterior y el caso aparecía como inexistente.
  return {
    enTenant: (_ctx: unknown, armar: (d: unknown) => unknown) =>
      Promise.resolve(armar(mod.db)),
    enTenantVarias: (_ctx: unknown, armar: (d: unknown) => unknown[]) =>
      Promise.all(armar(mod.db)),
  };
});

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

import { vi, beforeEach } from "vitest";
import { loadInboundConversation } from "@/server/worker/extract";
import { db } from "@/lib/db";

function inboundRows(rows: unknown) {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }),
  });
}

describe("loadInboundConversation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads every inbound message, not only the newest", async () => {
    // WhatsApp writes to raw_messages as well as claim_messages, so it silently
    // took the raw path — one message, no context. A photo arrived on a nearly
    // complete crash report, the extractor read "[Imagen adjunta sin texto]"
    // alone, decided it was not a claim, and killed the case.
    inboundRows([
      {
        id: "m1",
        provider_message_id: "wamid.1",
        body_text: "Choqué en Bahía Blanca, soy Martín Sosa",
        subject: "WhatsApp",
        from_addr: "5491100000000",
        received_at: "2026-08-19T23:09:44Z",
      },
      {
        id: "m2",
        provider_message_id: "wamid.2",
        body_text: "[Imagen adjunta sin texto]",
        subject: "WhatsApp",
        from_addr: "5491100000000",
        received_at: "2026-08-19T23:17:19Z",
      },
    ]);

    const out = await loadInboundConversation("case-1", { tenantId: "tenant-1" });

    expect(out?.body).toContain("Choqué en Bahía Blanca");
    expect(out?.body).toContain("[Imagen adjunta sin texto]");
    // Identity comes from the newest message: it is the one being answered.
    expect(out?.claimMessageId).toBe("m2");
    expect(out?.latestText).toBe("[Imagen adjunta sin texto]");
  });

  it("returns null when the case has no inbound messages", async () => {
    inboundRows([]);
    expect(await loadInboundConversation("case-1", { tenantId: "tenant-1" })).toBeNull();
  });

  it("returns null rather than guessing when the read gives back nonsense", async () => {
    inboundRows({ notAnArray: true });
    expect(await loadInboundConversation("case-1", { tenantId: "tenant-1" })).toBeNull();
  });
});

// ── Dates in the rendered conversation ───────────────────────────────────────

import { buildConversationBody } from "@/core/email/conversation";

describe("buildConversationBody — when each message was sent", () => {
  // "Choqué ayer" was read as the 18th on the day it arrived and, two days
  // later, as the 19th. Nothing new had been said about the date; the whole
  // conversation is simply re-read on every reply, and with no dates in it the
  // model anchored "ayer" on whatever day the re-run happened. The accident
  // moved without anyone touching it.
  const msg = (body: string, at: string | null) => ({ body_text: body, received_at: at });

  it("stamps every message with the day it arrived — ACÁ, no en UTC", () => {
    /*
     * `2026-08-19T00:22:43Z` son las 21:22 del 18 en Buenos Aires.
     *
     * Este test decía `2026-08-19`, que es el día UTC, y está escrito justamente
     * para que el modelo pueda resolver la palabra «ayer». Con el sello corrido
     * un día, un mensaje mandado a las 21:22 del 18 diciendo «choqué ayer» lo
     * llevaba a calcular el 18 en vez del 17: la fecha del siniestro, mal por un
     * día, para todo mensaje entre las 21 y las 24.
     *
     * Que la expectativa vieja estuviera escrita acá no la hacía correcta.
     * Hacía que el defecto tuviera un test que lo defendía.
     */
    const out = buildConversationBody([
      msg("Choqué ayer en Bahía Blanca.", "2026-08-19T00:22:43Z"),
      msg("[Imagen adjunta sin texto]", "2026-08-20T19:17:00Z"),
    ]);

    expect(out).toContain("recibido el 2026-08-18");
    // El segundo llegó a las 16:17 de acá: el mismo día en las dos zonas.
    expect(out).toContain("recibido el 2026-08-20");
    expect(out).toContain("Choqué ayer en Bahía Blanca.");
  });

  it("stamps a lone message too — it is the one most likely to say 'ayer'", () => {
    const out = buildConversationBody([msg("Choqué ayer.", "2026-08-19T00:22:43Z")]);

    // 00:22 UTC del 19 son las 21:22 del 18 acá, que es el día que el modelo
    // tiene que usar para resolver «ayer».
    expect(out).toBe("[Mensaje — recibido el 2026-08-18]\nChoqué ayer.");
  });

  it("keeps the numbering that tells the model what came first", () => {
    const out = buildConversationBody([
      msg("Primero", "2026-08-19T00:00:00Z"),
      msg("Después", "2026-08-20T00:00:00Z"),
    ]);

    expect(out.indexOf("Mensaje 1 de 2")).toBeLessThan(out.indexOf("Mensaje 2 de 2"));
  });

  it("says nothing rather than guessing when the timestamp is missing", () => {
    // An invented date is worse than none: the model would anchor on it.
    expect(buildConversationBody([msg("Choqué ayer.", null)])).toBe("Choqué ayer.");
    expect(buildConversationBody([msg("Choqué ayer.", "not a date")])).toBe("Choqué ayer.");
  });

  it("still drops quoted replies before stamping", () => {
    const out = buildConversationBody([
      msg("Fue un choque.\n> texto citado", "2026-08-19T00:00:00Z"),
    ]);

    expect(out).not.toContain("texto citado");
    expect(out).toContain("Fue un choque.");
  });

  it("returns empty when nothing survives the cleaning", () => {
    expect(buildConversationBody([msg("> sólo cita", "2026-08-19T00:00:00Z")])).toBe("");
  });
});
