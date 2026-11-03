/**
 * Las pantallas de la app no desbordan en el teléfono (440 px de ancho).
 *
 * jsdom no aplica la hoja de estilos ni mide nada: estas son guardas sobre el
 * código fuente para que nadie saque, sin darse cuenta, lo que evita el scroll
 * al costado: la tabla apilada, el renglón que se parte de la barra de
 * herramientas, el margen que se achica y el panel de filtros que se ancla.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Normaliza el fin de línea: el árbol de trabajo puede traer CRLF y el CI no. */
const leer = (ruta: string) => readFileSync(ruta, "utf8").replaceAll("\r\n", "\n");
const css = leer("src/app/globals.css");
const bloqueDelTelefono = css.slice(css.indexOf("@media (width < 48rem) {\n  /* La lista"), css.indexOf("/* El panel de filtros"));

const CASES = leer("src/app/(app)/bandeja/components/CasesTable.tsx");
const USUARIOS = leer("src/app/(app)/admin/users/AdminUsersClient.tsx");
const ALTAS = leer("src/app/(app)/admin/altas/page.tsx");

describe("la tabla apilada", () => {
  it("la hoja de estilos la apila por debajo de md: filas flex que se parten y cabecera sólo para lector de pantalla", () => {
    expect(bloqueDelTelefono).toContain(".tabla-apilada > tbody > tr {");
    expect(bloqueDelTelefono).toMatch(/\.tabla-apilada > tbody > tr \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
    expect(bloqueDelTelefono).toMatch(/\.tabla-apilada > thead \{[^}]*clip-path: inset\(50%\);/);
  });

  it("no oculta la cabecera con display:none: el lector de pantalla pierde los rótulos", () => {
    expect(bloqueDelTelefono).not.toMatch(/\.tabla-apilada > thead \{[^}]*display: none/);
  });

  it("anula el ancho mínimo en línea que pone CasesTable", () => {
    expect(bloqueDelTelefono).toMatch(/\.tabla-apilada,\s*\.tabla-apilada > tbody \{[^}]*min-width: 0 !important;/);
  });

  it("sólo toca a los hijos directos: la tabla de catálogo anidada en Altas no se apila", () => {
    expect(css).not.toMatch(/\.tabla-apilada\s+(td|tr|th|thead|tbody)\b/);
  });

  it("las celdas que piden renglón entero y la fila de «cargando» o «vacío» ocupan el ancho", () => {
    expect(bloqueDelTelefono).toMatch(/td\[data-entera\],\s*\.tabla-apilada > tbody > tr > td\[colspan\] \{ flex-basis: 100%; \}/);
  });

  it("CasesTable la usa y marca cada celda con su columna", () => {
    expect(CASES).toMatch(/className="tabla-apilada [^"]*"/);
    expect(CASES).toContain("data-c={c.id}");
  });

  it("los usuarios y las altas la usan, y sus celdas piden renglón entero", () => {
    for (const fuente of [USUARIOS, ALTAS]) {
      expect(fuente.match(/<table className="tabla-apilada /g)).toHaveLength(1);
      expect(fuente).toContain("<td data-entera ");
    }
  });

  it("la tabla de catálogo de Altas, anidada, queda sin apilar", () => {
    expect(ALTAS.match(/tabla-apilada/g)).toHaveLength(1);
    expect(ALTAS).toContain('<table className="mt-1 w-full text-left tabular-nums">');
  });
});

describe("la barra de herramientas y la paginación de la Bandeja", () => {
  const dashboard = leer("src/app/(app)/bandeja/DashboardClient.tsx");

  it("los controles se parten en renglones en vez de salirse", () => {
    expect(dashboard).toContain('className="flex flex-wrap items-center gap-2 max-sm:w-full sm:flex-shrink-0"');
  });

  it("la paginación se parte", () => {
    expect(dashboard).toContain('className="flex flex-wrap items-center gap-x-3 gap-y-1"');
    expect(dashboard).toContain('className="flex flex-wrap items-center gap-1"');
  });

  it("el buscador ocupa el renglón entero en el teléfono y conserva su ancho en escritorio", () => {
    expect(leer("src/app/(app)/bandeja/components/CampoDeBusqueda.tsx")).toContain(
      'className="relative max-sm:basis-full sm:w-56 sm:flex-shrink-0"'
    );
  });
});

describe("el panel de filtros", () => {
  it("se ancla al borde de abajo con margen parejo por debajo de sm", () => {
    expect(leer("src/app/(app)/bandeja/components/PanelDeFiltros.tsx")).toMatch(/className="panel-de-filtros /);
    expect(css).toMatch(
      /@media \(width < 40rem\) \{\s*\.panel-de-filtros \{[^}]*position: fixed;[^}]*inset-inline: 0\.75rem;[^}]*env\(safe-area-inset-bottom\)/
    );
  });
});

describe("el panel de filtros y el asistente flotante", () => {
  it("en el teléfono la hoja queda por encima de los lanzadores, que comparten su esquina de abajo", () => {
    const enElTelefono = css.slice(css.indexOf("@media (width < 40rem)"));
    const zDelPanel = Number(/\.panel-de-filtros \{[^}]*z-index: (\d+);/.exec(enElTelefono)?.[1]);
    const asistente = leer("src/app/(app)/_components/AsistenteFlotante.tsx");
    const zDelAsistente = [...asistente.matchAll(/"fixed [^"]*\bz-(\d+)\b/g)].map((m) => Number(m[1]));

    expect(zDelAsistente).toHaveLength(3);
    expect(zDelPanel).toBeGreaterThan(Math.max(...zDelAsistente));
  });
});

describe("los márgenes de las pantallas", () => {
  const PANTALLAS = [
    "src/app/(app)/bandeja/page.tsx",
    "src/app/(app)/bandeja/loading.tsx",
    "src/app/(app)/agenda/page.tsx",
    "src/app/(app)/agenda/loading.tsx",
    "src/app/(app)/loading.tsx",
    "src/app/(app)/metricas/page.tsx",
    "src/app/(app)/configuracion/page.tsx",
    "src/app/(app)/admin/facturacion/page.tsx",
    "src/app/(app)/admin/users/page.tsx",
    "src/app/(app)/admin/altas/page.tsx",
  ];

  it.each(PANTALLAS)("%s achica el margen lateral en el teléfono", (ruta) => {
    const fuente = leer(ruta);
    expect(fuente).toMatch(/\bpx-4\b[^"]*\bsm:px-6\b/);
    expect(fuente).not.toMatch(/className="px-6 py-8/);
  });

  it("los títulos de la Bandeja y la Agenda son más chicos en el teléfono", () => {
    for (const ruta of ["src/app/(app)/bandeja/page.tsx", "src/app/(app)/agenda/page.tsx"]) {
      expect(leer(ruta)).toContain("text-[22px] sm:text-[26px]");
    }
  });
});

describe("las tablas anchas de Métricas", () => {
  it("cada una scrollea adentro de su tarjeta y no arrastra a la página", () => {
    const tarjetas = leer("src/app/(app)/metricas/page.tsx").match(/className="overflow-x-auto rounded-lg border/g);
    expect(tarjetas?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("Configuración", () => {
  it("el campo y su control se apilan en el teléfono", () => {
    expect(leer("src/app/(app)/configuracion/page.tsx")).toMatch(/flex-col[^"]*sm:flex-row/);
  });
});

describe("el aviso de los usuarios", () => {
  it("no es más ancho que la pantalla", () => {
    expect(USUARIOS).toContain("max-w-[calc(100%-2rem)]");
  });
});

describe("la papelera de cada tarjeta", () => {
  it("se ve siempre en la tarjeta: en CasesTable nace transparente y al tacto nada la revela", () => {
    expect(CASES).toMatch(/className="[^"]*\bopacity-0\b[^"]*"\s+aria-label=\{t\("bandeja\.delete"\)\}/);
    expect(bloqueDelTelefono).toContain('.tabla-apilada > tbody > tr > td[data-c="row-delete"] > button { opacity: 1; }');
  });

  it("la fila le deja lugar a la derecha para que no tape el texto de la tarjeta", () => {
    expect(bloqueDelTelefono).toMatch(
      /\.tabla-apilada > tbody > tr:has\(> td\[data-c="row-delete"\]\) \{ padding-right: 2\.5rem; \}/
    );
  });
});

describe("los avisos fijos y la zona segura", () => {
  it("el de los usuarios se ancla a la esquina respetando la zona segura de abajo y de la derecha", () => {
    expect(USUARIOS).toContain(
      "fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))]"
    );
    expect(USUARIOS).not.toContain("fixed bottom-4 right-4");
  });
});
