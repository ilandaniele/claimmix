/**
 * Los avisos de la bandeja: el contenedor ya está montado antes de que llegue
 * el primero (si nace con el texto adentro, algunos lectores no lo anuncian) y
 * un error no se borra solo, para que nadie se pierda que algo falló.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastContainer, type ToastMessage } from "@/app/(app)/bandeja/components/Toast";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

const onDismiss = vi.fn();

function pintar(toasts: ToastMessage[]) {
  return render(
    <LocaleProvider locale="en-US">
      <ToastContainer toasts={toasts} onDismiss={onDismiss} />
    </LocaleProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  onDismiss.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastContainer", () => {
  it("sin avisos ya es una región viva, para que el primero se anuncie", () => {
    pintar([]);

    expect(screen.getByRole("status", { name: "Notifications" })).toBeTruthy();
  });

  it("los avisos entran dentro de esa región", () => {
    pintar([{ id: "1", message: "Case closed", type: "success" }]);

    const region = screen.getByRole("status", { name: "Notifications" });
    expect(region.textContent).toContain("Case closed");
  });

  it("un aviso común se cierra solo a los 4 segundos", () => {
    pintar([{ id: "1", message: "New case", type: "info" }]);

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(onDismiss).toHaveBeenCalledWith("1");
  });

  it("un error no se cierra solo: queda hasta que se lo cierra", () => {
    pintar([{ id: "1", message: "Delete failed", type: "error" }]);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByText("Delete failed")).toBeTruthy();
  });
});
