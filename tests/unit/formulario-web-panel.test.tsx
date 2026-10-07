/**
 * El panel del formulario web dice cuántas denuncias acepta por hora y por día.
 * Esos números los pone el limitador de la ruta pública: si el texto los lleva
 * escritos a mano, el día que alguien cambie el tope la ayuda miente.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { FormularioWebPanel } from "@/app/(app)/agente/FormularioWebPanel";
import { getT, type Locale } from "@/lib/i18n";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";

const pintar = (idioma: Locale) =>
  renderToStaticMarkup(<FormularioWebPanel t={getT(idioma)} formulario={null} pendiente={false} />);

describe("FormularioWebPanel: los topes de la ayuda", () => {
  const porHora = String(RATE_LIMIT_CONFIGS.DENUNCIA_WEB_SLUG.limit);
  const porDia = String(RATE_LIMIT_CONFIGS.DENUNCIA_WEB_SLUG_DIA.limit);

  it("en es-AR nombra los topes de la configuración y no deja marcas sin rellenar", () => {
    const html = pintar("es-AR");

    expect(html).toContain(`hasta ${porHora} envíos por hora y ${porDia} por día`);
    expect(html).not.toContain("{por");
  });

  it("en en-US también", () => {
    const html = pintar("en-US");

    expect(html).toContain(`up to ${porHora} submissions per hour and ${porDia} per day`);
    expect(html).not.toContain("{por");
  });

  it("si el tope cambia, el texto lo sigue", () => {
    const config = RATE_LIMIT_CONFIGS.DENUNCIA_WEB_SLUG;
    const original = config.limit;
    try {
      (config as { limit: number }).limit = 7;
      expect(pintar("es-AR")).toContain("hasta 7 envíos por hora");
    } finally {
      (config as { limit: number }).limit = original;
    }
  });
});
