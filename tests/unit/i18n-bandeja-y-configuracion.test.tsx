/**
 * G30: la bandeja y el shell (Toast, TopBar, DashboardClient, CasesTable)
 * pasan sus textos fijos a i18n. Sigue el patrón de i18n-panel-fraude.test.tsx.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { esAR } from "@/lib/i18n/es-AR";
import { enUS } from "@/lib/i18n/en-US";
import { getT } from "@/lib/i18n";
import { ETIQUETA_DE_ROL } from "@/lib/i18n/etiqueta-de-rol";
import { ToastContainer } from "@/app/(app)/bandeja/components/Toast";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

describe("i18n de la bandeja y el shell", () => {
  it("es-AR conserva el texto de hoy", () => {
    expect(esAR["toast.cerrar"]).toBe("Cerrar notificación");
    expect(esAR["toast.region"]).toBe("Notificaciones");
    expect(esAR["configuracion.subtitle"]).toBe(
      "Preferencias de cuenta y parámetros del sistema"
    );
    expect(esAR["configuracion.soloAdmins"]).toBe(
      "Solo los administradores pueden modificar los umbrales de IA."
    );
  });

  it("en-US no deja pasar el texto en español", () => {
    for (const key of [
      "toast.cerrar",
      "toast.region",
      "configuracion.title",
      "configuracion.subtitle",
      "configuracion.cuenta",
      "configuracion.umbrales",
      "configuracion.umbralConfianza",
      "configuracion.umbralAyuda",
      "configuracion.capMensual",
      "configuracion.capAyuda",
      "configuracion.soloAdmins",
      "configuracion.miClave",
      "configuracion.sistema",
      "configuracion.version",
      "configuracion.node",
      "configuracion.region",
    ] as const) {
      expect(enUS[key], `en-US le falta '${key}'`).toBeTruthy();
      expect(enUS[key]).not.toBe(esAR[key]);
    }
  });

  it("ETIQUETA_DE_ROL resuelve en los dos idiomas", () => {
    const tEs = getT("es-AR");
    expect(tEs(ETIQUETA_DE_ROL.owner)).toBe("Owner");
    expect(tEs(ETIQUETA_DE_ROL.admin)).toBe("Administrador");
    expect(tEs(ETIQUETA_DE_ROL.specialist)).toBe("Especialista");
    expect(tEs(ETIQUETA_DE_ROL.viewer)).toBe("Visor");
    expect(tEs(ETIQUETA_DE_ROL.analyst)).toBe("Analista");

    const tEn = getT("en-US");
    expect(tEn(ETIQUETA_DE_ROL.specialist)).toBe("Specialist");
    expect(tEn(ETIQUETA_DE_ROL.viewer)).toBe("Viewer");
  });

  it("ToastContainer traduce cierre y región", () => {
    const toasts = [{ id: "1", message: "x" }];
    const { rerender } = render(
      <LocaleProvider locale="en-US">
        <ToastContainer toasts={toasts} onDismiss={() => {}} />
      </LocaleProvider>
    );
    expect(screen.getByLabelText("Notifications")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close notification" })).toBeTruthy();

    rerender(
      <LocaleProvider locale="es-AR">
        <ToastContainer toasts={toasts} onDismiss={() => {}} />
      </LocaleProvider>
    );
    expect(screen.getByLabelText("Notificaciones")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cerrar notificación" })).toBeTruthy();
  });

  describe("sin literales en español", () => {
    it("Toast.tsx", () => {
      const src = readFileSync("src/app/(app)/bandeja/components/Toast.tsx", "utf8");
      expect(src).not.toContain("Cerrar notificación");
      expect(src).not.toContain("Notificaciones");
    });

    it("TopBar.tsx", () => {
      const src = readFileSync("src/app/(app)/_components/TopBar.tsx", "utf8");
      expect(src).not.toContain("Especialista");
      expect(src).not.toContain("Visor");
      expect(src).not.toContain("Cerrar sesión");
    });

    it("DashboardClient.tsx", () => {
      const src = readFileSync("src/app/(app)/bandeja/DashboardClient.tsx", "utf8");
      expect(src).not.toContain("} siniestros.");
    });

    it("CasesTable.tsx", () => {
      const src = readFileSync("src/app/(app)/bandeja/components/CasesTable.tsx", "utf8");
      expect(src).not.toContain("`Siniestro ${");
    });

    it("configuracion/page.tsx", () => {
      const src = readFileSync("src/app/(app)/configuracion/page.tsx", "utf8");
      for (const literal of [
        "Preferencias de cuenta",
        "Umbrales de IA",
        "Umbral de confianza",
        "Cap mensual de IA",
        "Mi clave de IA",
        "Información del sistema",
        "Versión de la app",
        "Región de despliegue",
        "Solo los administradores",
        "ROLE_LABELS",
      ]) {
        expect(src).not.toContain(literal);
      }
    });
  });
});
