/**
 * El panel de casillas Gmail: cuando Google retiró el permiso (`invalid_grant`)
 * la casilla se ve vencida y ofrece reconectar; cualquier otro error sigue
 * siendo «Con error», sin enlace.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GmailAccountsPanel } from "@/app/(app)/configuracion/GmailAccountsPanel";
import type { Locale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

function casilla(lastError: string | null, lastConnectedAt: string | null = "2026-10-01T12:00:00.000Z") {
  return {
    id: "c1",
    email: "casilla@example.com",
    enabled: true,
    last_connected_at: lastConnectedAt,
    last_error: lastError,
    created_at: "2026-09-01T12:00:00.000Z",
  };
}

async function mostrar(accounts: ReturnType<typeof casilla>[], locale: Locale = "es-AR") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accounts }) }));
  render(
    <LocaleProvider locale={locale}>
      <GmailAccountsPanel />
    </LocaleProvider>
  );
  await screen.findByText("casilla@example.com");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GmailAccountsPanel: casilla vencida", () => {
  it("con invalid_grant dice que está vencida y ofrece reconectar", async () => {
    await mostrar([casilla("invalid_grant")]);

    expect(screen.getByText("Vencida: Google retiró el permiso y no entra correo")).toBeTruthy();
    expect(screen.queryByText("Conectada")).toBeNull();
    expect(screen.getByRole("link", { name: "Reconectar" }).getAttribute("href")).toBe(
      "/api/admin/gmail-accounts/connect"
    );
  });

  it("con otro error sigue diciendo «Con error» y no ofrece reconectar", async () => {
    await mostrar([casilla("history_list_failed: Error")]);

    expect(screen.getByText("Con error")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Reconectar" })).toBeNull();
  });

  it("sin error y con conexión dice «Conectada»", async () => {
    await mostrar([casilla(null)]);

    expect(screen.getByText("Conectada")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Reconectar" })).toBeNull();
  });

  it("en inglés la vencida y el enlace van traducidos", async () => {
    await mostrar([casilla("invalid_grant")], "en-US");

    expect(screen.getByText("Expired: Google revoked access and no mail comes in")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reconnect" })).toBeTruthy();
  });
});
