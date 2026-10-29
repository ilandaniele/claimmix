// @vitest-environment node
/**
 * /agente?tab=: la pestaña que abre la consola cuando llegás desde «Primeros pasos».
 *
 * Tres tramos: qué pestaña sale de la dirección (`tabDeLaUrl`, que sólo acepta una de
 * la lista), que la página se la pase a la consola, y que la consola la abra. Sin
 * `?tab=` o con algo raro todo sigue como antes: arranca en «modelos».
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  // Los paneles hacen `fetch` al montarse y traen medio grafo del cliente: acá se prueba la elección de pestaña.
  panel: (nombre: string) => ({ [nombre]: () => <div>{`panel:${nombre}`}</div> }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/db", () => ({ db: {}, tables: {} }));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: async () => "es-AR" }));
vi.mock("@/data/bases", () => ({ basePorCliente: () => false }));
vi.mock("@/data/scope", () => ({
  enTenant: async () => [],
  enControl: async () => [],
  enTenantVarias: async () => [[], []],
}));
vi.mock("@/server/cases/ramos-del-inquilino", () => ({ consultaRamosDelInquilino: () => [] }));
vi.mock("@/server/web/formulario-del-inquilino", () => ({ consultaFormularioWeb: () => [] }));

vi.mock("@/app/(app)/configuracion/AiProviderPanel", () => h.panel("AiProviderPanel"));
vi.mock("@/app/(app)/configuracion/PromptRulesPanel", () => h.panel("PromptRulesPanel"));
vi.mock("@/app/(app)/agente/CustomFieldsPanel", () => h.panel("CustomFieldsPanel"));
vi.mock("@/app/(app)/agente/TrainingExamplesPanel", () => h.panel("TrainingExamplesPanel"));
vi.mock("@/app/(app)/agente/FineTuneJobsPanel", () => h.panel("FineTuneJobsPanel"));
vi.mock("@/app/(app)/agente/AgentExportPanel", () => h.panel("AgentExportPanel"));
vi.mock("@/app/(app)/agente/ProviderUsagePanel", () => h.panel("ProviderUsagePanel"));
vi.mock("@/app/(app)/agente/BatchSimulatePanel", () => h.panel("BatchSimulatePanel"));
vi.mock("@/app/(app)/agente/TrabajoPanel", () => h.panel("TrabajoPanel"));

import { AgentConsoleClient } from "@/app/(app)/agente/AgentConsoleClient";
import AgentConsolePage from "@/app/(app)/agente/page";
import { TABS, tabDeLaUrl } from "@/app/(app)/agente/pestanas-de-la-consola";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const IDS = TABS.map(({ id }) => id);

beforeEach(() => {
  h.requireAdmin.mockResolvedValue({ user: { id: "u-1" }, userRow: { role: "admin", tenant_id: TENANT_ID } });
});

describe("tabDeLaUrl", () => {
  it("«formulario» es una de las pestañas, que es a la que apunta «Primeros pasos»", () => {
    expect(IDS).toContain("formulario");
  });

  it.each(IDS)("%s es una pestaña", (id) => {
    expect(tabDeLaUrl(id)).toBe(id);
  });

  it.each([undefined, "", "raro", "FORMULARIO", " formulario", "formulario ", "constructor", "__proto__", "toString", "../admin", "<script>"])(
    "%j no es ninguna: queda la de siempre",
    (valor) => {
      expect(tabDeLaUrl(valor)).toBeUndefined();
    }
  );

  it("con la pestaña repetida en la dirección no elige ninguna, ni siquiera si todas valen", () => {
    expect(tabDeLaUrl(["formulario", "campos"])).toBeUndefined();
    expect(tabDeLaUrl(["formulario"])).toBeUndefined();
    expect(tabDeLaUrl([])).toBeUndefined();
  });
});

describe("/agente se la pasa a la consola", () => {
  type Nodo = { type?: unknown; props?: { children?: Nodo | Nodo[]; tabInicial?: string } };
  const consola = (nodo: Nodo | Nodo[] | undefined): Nodo | undefined => {
    if (!nodo) return undefined;
    if (Array.isArray(nodo)) return nodo.map((n) => consola(n)).find(Boolean);
    return nodo.type === AgentConsoleClient ? nodo : consola(nodo.props?.children);
  };
  const tabInicialDe = async (tab?: string | string[]) => {
    const pagina = await AgentConsolePage({ searchParams: Promise.resolve(tab === undefined ? {} : { tab }) });
    const nodo = consola(pagina as Nodo);
    expect(nodo, "la consola está en la página").toBeDefined();
    return nodo!.props!.tabInicial;
  };

  it("con ?tab=formulario, la consola arranca en el formulario", async () => {
    expect(await tabInicialDe("formulario")).toBe("formulario");
  });

  it("sin ?tab= no hay pestaña pedida y la consola decide", async () => {
    expect(await tabInicialDe()).toBeUndefined();
  });

  it.each(["raro", "", "constructor", ["formulario", "campos"]])("con ?tab=%j tampoco", async (tab) => {
    expect(await tabInicialDe(tab)).toBeUndefined();
  });
});

describe("la consola abre la pestaña pedida", () => {
  const montar = (tabInicial?: (typeof IDS)[number]) =>
    renderToStaticMarkup(
      <LocaleProvider locale="es-AR">
        <AgentConsoleClient
          role="owner"
          tabInicial={tabInicial}
          ramos={<div>RamosPanel</div>}
          formulario={<div>FormularioWebPanel</div>}
          base={<div>BasePanel</div>}
        />
      </LocaleProvider>
    );
  const seleccionadas = (html: string) => [...html.matchAll(/id="pestana-(\w+)"[^>]*aria-selected="true"/g)].map((m) => m[1]);

  it("con tabInicial=formulario, está seleccionada la del formulario y se ve su panel", () => {
    const html = montar("formulario");

    expect(seleccionadas(html)).toEqual(["formulario"]);
    expect(html).toContain("FormularioWebPanel");
    expect(html).not.toContain("panel:AiProviderPanel");
    expect(html).toContain('aria-labelledby="pestana-formulario"');
  });

  it("sin tabInicial arranca en «modelos», como antes", () => {
    const html = montar();

    expect(seleccionadas(html)).toEqual(["modelos"]);
    expect(html).toContain("panel:AiProviderPanel");
    expect(html).not.toContain("FormularioWebPanel");
  });

  it.each(IDS)("con tabInicial=%s hay una sola pestaña seleccionada y es esa", (id) => {
    expect(seleccionadas(montar(id))).toEqual([id]);
  });
});
