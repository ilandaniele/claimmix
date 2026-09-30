/**
 * El botón de envío al Core: el fallo se lee en el idioma de la cuenta, sin
 * el código crudo, y el éxito refresca la ficha, que es la que muestra el ID.
 */

import { readFileSync } from "node:fs";

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreSyncButton } from "@/app/(app)/casos/[id]/_components/CoreSyncButton";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import type { Locale } from "@/lib/i18n";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();

function mostrar(locale: Locale = "es-AR") {
  render(
    <LocaleProvider locale={locale}>
      <CoreSyncButton caseId="caso-1" currentStatus="listo_para_core" />
    </LocaleProvider>
  );
  fireEvent.click(screen.getByRole("button"));
}

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("CoreSyncButton", () => {
  it("un fallo del Core muestra el motivo en palabras", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ synced: false, errorMessage: "timeout" }) });
    mostrar();

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("El sistema central no contestó a tiempo.");
    expect(alerta).not.toHaveTextContent("timeout");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("sin red, el aviso y el botón siguen el idioma de la cuenta", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mostrar("en-US");

    expect(await screen.findByRole("alert")).toHaveTextContent("Network error. Please try again.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("el envío que sale bien refresca la ficha", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ synced: true, externalId: "EXT-1" }) });
    mostrar();

    expect(await screen.findByRole("status")).toHaveTextContent("Caso enviado al sistema central.");
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("la página del caso", () => {
  it("el envío al Core se ve en todos los canales, no sólo mail", () => {
    // Estaba adentro de `isEmailCase && (<>…</>)`: un caso de WhatsApp no veía
    // ni el botón, ni el reintento desde error_core, ni el id que devolvió el Core.
    const pagina = readFileSync("src/app/(app)/casos/[id]/page.tsx", "utf8");
    const inicio = pagina.indexOf("{isEmailCase && (");
    const fin = pagina.indexOf("</>", inicio);
    expect(inicio).toBeGreaterThan(-1);
    // Un solo `<>` adentro: el primer `</>` es el que cierra el bloque de mail.
    expect(pagina.slice(inicio, fin).split("<>")).toHaveLength(2);

    const secciones = [...pagina.matchAll(/id="core-sync"/g)].map((m) => m.index);
    expect(secciones).toHaveLength(3);
    for (const i of secciones) expect(i).toBeGreaterThan(fin);
  });
});
