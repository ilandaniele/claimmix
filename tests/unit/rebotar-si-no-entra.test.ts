/**
 * Qué hace una pantalla de /admin o /agente cuando su guarda tira.
 *
 * «Facturación» y «Administración» llevaban a la bandeja de siniestros porque
 * cada pantalla mandaba a `/bandeja` ante CUALQUIER error de la guarda, y la
 * guarda lee la base: un corte de Neon se veía igual que «no tenés permiso».
 * Sólo lo que es un «no» rebota; una falla se vuelve a tirar para que la muestre
 * `(app)/error.tsx` con su botón de reintentar.
 *
 * Usa el `next/navigation` de verdad: lo que importa es que el redirect y el
 * `unstable_rethrow` de Next se entiendan entre sí, y un mock lo daría por hecho.
 */

import { describe, expect, it } from "vitest";
import { redirect } from "next/navigation";

import { rebotarSiNoEntra } from "@/lib/auth/rebotar-si-no-entra";
import { AppError } from "@/lib/errors";

// `redirect()` tira un error con `digest: "NEXT_REDIRECT;<tipo>;<url>;<estado>;"`.
function adonde(accion: () => never): string {
  try {
    accion();
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2];
    throw e;
  }
  throw new Error("no tiró");
}

describe("rebotarSiNoEntra", () => {
  it("sin sesión, al login", () => {
    expect(adonde(() => rebotarSiNoEntra(new AppError("MISSING_SESSION")))).toBe("/login");
  });

  it("con sesión y sin el rol (o sin ser operador), a la bandeja", () => {
    expect(adonde(() => rebotarSiNoEntra(new AppError("FORBIDDEN_ROLE")))).toBe("/bandeja");
  });

  it("una falla de la base no rebota: se vuelve a tirar tal cual", () => {
    const falla = new Error("fetch failed");
    expect(() => rebotarSiNoEntra(falla)).toThrow(falla);
  });

  it("un error de la app que no es de acceso tampoco rebota", () => {
    const otro = new AppError("PLAN_REQUERIDO");
    expect(() => rebotarSiNoEntra(otro)).toThrow(otro);
  });

  it("lo que no es un Error se vuelve a tirar igual", () => {
    expect(() => rebotarSiNoEntra("boom")).toThrow("boom");
  });

  it("un redirect de Next que ya venía en camino sigue su camino, no se convierte en otra cosa", () => {
    let yaTirado: unknown;
    try {
      redirect("/pendiente");
    } catch (e) {
      yaTirado = e;
    }
    expect(() => rebotarSiNoEntra(yaTirado)).toThrow(yaTirado as Error);
    expect(adonde(() => rebotarSiNoEntra(yaTirado))).toBe("/pendiente");
  });
});
