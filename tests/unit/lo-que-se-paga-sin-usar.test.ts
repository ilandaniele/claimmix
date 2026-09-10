/**
 * Dos costos que se pagaban sin usarse.
 *
 * Uno en cada mensaje que entra (un segundo y dos décimas de sueño esperando a
 * nadie) y otro en cada arranque en frío (688 ms de `googleapis` en una ruta que
 * no manda mails).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const THROTTLE = readFileSync("src/server/intake/simulation-throttle.ts", "utf8");
const DISPATCH = readFileSync("src/server/email/dispatch.ts", "utf8");

describe("el respiro entre extracciones", () => {
  it("va sólo si hubo de quién separarse", () => {
    /*
     * Corría SIEMPRE, incluso con `blockers = 0` y el bucle sin dar una vuelta:
     * 1,2 s de sueño en cada mail que entra, esperando a nadie. En una casilla
     * tranquila —casi todo el tiempo— era el único efecto de esta función.
     */
    expect(THROTTLE).toContain("if (hubo && minGapMs > 0)");
  });

  it("y `hubo` se marca en las dos formas de contender", () => {
    // Entrar con cola ya formada, y que aparezca mientras esperábamos. Mirar
    // sólo una de las dos deja la mitad de los casos sin respiro.
    const fn = THROTTLE.slice(
      THROTTLE.indexOf("export async function waitForEmailExtractionTurn"),
      THROTTLE.indexOf("timedOut: false, blockers: 0 }")
    );
    expect(fn).toContain("let hubo = blockers >= maxConcurrent");
    expect(fn).toContain("hubo = true;");
  });
});

describe("googleapis en la ruta caliente", () => {
  it("no se importa arriba del archivo", () => {
    /*
     * La cadena era toda estática: webhooks/whatsapp → intake-agent →
     * worker/extract → confirmations/messenger → email/dispatch →
     * gmail/gmail-sender → googleapis. Un WhatsApp de texto pagaba 688 ms de
     * import antes de atender, sin tocar Gmail en ningún momento.
     */
    expect(DISPATCH).not.toMatch(/^import \{ GmailSender \}/m);
    expect(DISPATCH).toMatch(/^import type \{ GmailSender as/m);
  });

  it("y se carga recién cuando hay casilla y se va a usar", () => {
    const i = DISPATCH.indexOf('await import("./gmail/gmail-sender")');
    const j = DISPATCH.indexOf("if (!gmailAccount)");
    expect(i).toBeGreaterThan(-1);
    // Después del control de que hay casilla: antes sería pagarlo igual.
    expect(i).toBeGreaterThan(j);
  });
});
