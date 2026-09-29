/**
 * El secreto y la clave recién creados se muestran una sola vez. Rotar o
 * revocar la clave no puede borrar un secreto que todavía no se copió, y cada
 * aviso dice qué valor muestra. La prueba fallida se lee, no sale el código.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreSyncPanel } from "@/app/(app)/configuracion/CoreSyncPanel";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import type { Locale } from "@/lib/i18n";

const fetchMock = vi.fn();

function responde(cuerpo: object) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => cuerpo });
}

function rechaza(error: object) {
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error }) });
}

function mostrar(locale: Locale = "es-AR") {
  render(
    <LocaleProvider locale={locale}>
      <CoreSyncPanel inicial={null} migracionPendiente={false} />
    </LocaleProvider>
  );
}

const pulsar = (nombre: string) => fireEvent.click(screen.getByRole("button", { name: nombre }));
const aviso = (nombre: string) => screen.queryByRole("alert", { name: nombre });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => vi.unstubAllGlobals());

describe("CoreSyncPanel", () => {
  it("rotar y revocar la clave no borran el secreto recién generado", async () => {
    mostrar();

    responde({ secreto: "secreto-1" });
    pulsar("Generar secreto");
    const secreto = await screen.findByRole("alert", { name: "Secreto de firma nuevo." });
    expect(within(secreto).getByText("secreto-1")).toBeInTheDocument();
    expect(secreto).toHaveTextContent("Secreto de firma nuevo. Copialo ahora");

    responde({ clave: "cmk_1", prefijo: "aaaa" });
    pulsar("Crear clave");
    expect(within(await screen.findByRole("alert", { name: "Clave de lectura nueva." })).getByText("cmk_1")).toBeInTheDocument();

    responde({ clave: "cmk_2", prefijo: "bbbb" });
    pulsar("Rotar clave");
    await screen.findByText("cmk_2");
    expect(within(aviso("Clave de lectura nueva.")!).getByText("cmk_2")).toBeInTheDocument();
    expect(within(aviso("Secreto de firma nuevo.")!).getByText("secreto-1")).toBeInTheDocument();

    responde({ revocada: true });
    pulsar("Revocar clave");
    await waitFor(() => expect(aviso("Clave de lectura nueva.")).toBeNull());
    expect(within(aviso("Secreto de firma nuevo.")!).getByText("secreto-1")).toBeInTheDocument();
  });

  it("la prueba fallida dice el motivo en palabras", async () => {
    mostrar();

    responde({ ok: false, motivo: "http_502" });
    pulsar("Probar envío");

    expect(await screen.findByRole("status")).toHaveTextContent(
      "La prueba no llegó: El sistema central respondió con el código HTTP 502."
    );
  });

  // El `message` del servidor está en castellano: en inglés se lee el motivo traducido.
  it.each([
    ["es-AR", "No se pudo guardar. Hacen falta la URL guardada y el secreto."],
    ["en-US", "Could not save. The saved URL and the secret are both needed."],
  ] as const)("un rechazo del servidor se lee en %s", async (locale, texto) => {
    mostrar(locale);

    rechaza({ code: "VALIDATION_FAILED", message: "Primero guardá la URL y generá el secreto.", details: { motivo: "incompleto" } });
    pulsar(locale === "es-AR" ? "Probar envío" : "Send a test");

    expect((await screen.findByRole("status")).textContent).toBe(texto);
  });

  it("sin motivo conocido, sólo el aviso genérico: nunca el mensaje crudo", async () => {
    mostrar("en-US");

    rechaza({ code: "VALIDATION_FAILED", message: "No hay nada para cambiar." });
    pulsar("Send a test");

    expect((await screen.findByRole("status")).textContent).toBe("Could not save.");
  });
});
