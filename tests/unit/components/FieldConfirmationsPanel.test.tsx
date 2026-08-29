/**
 * El panel donde el analista confirma o rechaza lo que leyó el agente.
 *
 * No tenía ningún test. Y tenía el otro extremo de un bug real: cuando el
 * agente no proponía valor, la pantalla mostraba «—» y ofrecía igual el botón
 * de confirmar. Al apretarlo mandaba `value: null`, el servidor marcaba la fila
 * como confirmada y después contestaba 400; el analista veía un error, volvía a
 * apretar, y la segunda vez fallaba de nuevo porque la fila ya no estaba
 * pendiente.
 *
 * El servidor ahora corta antes de escribir. Acá se cubre la otra mitad: no
 * ofrecer una acción que no se puede completar.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Sin mock de i18n a propósito: los botones se buscan por el texto que ve una
// persona. Si mañana alguien cambia «Confirmar» por otra cosa, este test tiene
// que enterarse.
import { FieldConfirmationsPanel } from "@/app/(app)/casos/[id]/_components/FieldConfirmationsPanel";

const BASE = {
  id: "conf-1",
  field_key: "full_name",
  conflict_with_value: null,
  confidence: 0.9,
  status: "pending" as const,
  resolved_at: null,
};

function botonConfirmar() {
  return screen.getByRole("button", { name: /^confirmar$/i });
}

function botonRechazar() {
  return screen.getByRole("button", { name: /^rechazar$/i });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FieldConfirmationsPanel", () => {
  it("con valor propuesto, confirmar está habilitado y manda ese valor", async () => {
    render(
      <FieldConfirmationsPanel
        caseId="caso-1"
        initialConfirmations={[{ ...BASE, proposed_value: "Juan Pérez" }]}
      />
    );

    expect(botonConfirmar()).not.toBeDisabled();

    await userEvent.click(botonConfirmar());

    const [, opciones] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(opciones?.body))).toEqual({
      field_key: "full_name",
      value: "Juan Pérez",
      action: "confirm",
    });
  });

  it.each([
    ["nulo", null],
    ["vacío", ""],
  ])("sin valor propuesto (%s) no se puede confirmar", async (_c, propuesto) => {
    render(
      <FieldConfirmationsPanel
        caseId="caso-1"
        initialConfirmations={[{ ...BASE, proposed_value: propuesto }]}
      />
    );

    expect(botonConfirmar()).toBeDisabled();

    // Y que no sea sólo cosmético: apretarlo no tiene que mandar nada.
    await userEvent.click(botonConfirmar());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sin valor propuesto, rechazar sigue disponible: es la salida", async () => {
    render(
      <FieldConfirmationsPanel
        caseId="caso-1"
        initialConfirmations={[{ ...BASE, proposed_value: null }]}
      />
    );

    expect(botonRechazar()).not.toBeDisabled();

    await userEvent.click(botonRechazar());

    const [, opciones] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(opciones?.body))).toEqual({
      field_key: "full_name",
      value: null,
      action: "reject",
    });
  });

  it("una confirmación ya resuelta no ofrece botones", () => {
    render(
      <FieldConfirmationsPanel
        caseId="caso-1"
        initialConfirmations={[
          { ...BASE, proposed_value: "Juan Pérez", status: "confirmed" },
        ]}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("si el servidor rechaza, se muestra su mensaje y la fila sigue pendiente", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "No hay un valor para confirmar." } }),
    } as never);

    render(
      <FieldConfirmationsPanel
        caseId="caso-1"
        initialConfirmations={[{ ...BASE, proposed_value: "Juan Pérez" }]}
      />
    );

    await userEvent.click(botonConfirmar());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "No hay un valor para confirmar."
    );
    // No se hace la actualización optimista: el botón sigue ahí.
    expect(botonConfirmar()).toBeTruthy();
  });
});
