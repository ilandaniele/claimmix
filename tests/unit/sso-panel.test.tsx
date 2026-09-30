// @vitest-environment node
/**
 * El panel de SSO de /configuracion (B19), armado en el servidor.
 *
 * No lleva JavaScript de cliente —el presupuesto de `pnpm peso` no lo admite—, así
 * que lo que se afirma es el HTML que sale: qué se muestra en cada etapa, que el
 * secreto nunca vuelva a la pantalla y que cada resultado tenga su texto en los
 * dos idiomas.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Las acciones llaman a la ruta de la API y a Better Auth: acá sólo se necesita que existan.
vi.mock("@/app/(app)/configuracion/sso-actions", () => ({
  guardarSso: vi.fn(),
  verificarSso: vi.fn(),
  cambiarSso: vi.fn(),
  probarSso: vi.fn(),
}));

import { SsoPanel } from "@/app/(app)/configuracion/SsoPanel";
import { RESULTADOS_SSO, type ResultadoSso } from "@/app/(app)/configuracion/sso-resultados";
import { getT, type Locale } from "@/lib/i18n";
import type { PanelSso } from "@/server/sso/panel";

const VACIO: PanelSso = {
  issuer: null,
  client_id: null,
  dominio: null,
  dominio_verificado_en: null,
  activo: false,
  exigir: false,
  tiene_secreto: false,
  registro: null,
  url_de_vuelta: "https://claimmix.example.com/api/auth/sso-inquilino/callback",
  migracion_pendiente: false,
};

const REGISTRO = { nombre: "_claimmix.empresa.com", valor: "claimmix-verificacion=AbC_123-token" };

const CON_DOMINIO: PanelSso = {
  ...VACIO,
  issuer: "https://idp.empresa.com",
  client_id: "cliente-1",
  dominio: "empresa.com",
  tiene_secreto: true,
  registro: REGISTRO,
};

const VERIFICADO: PanelSso = { ...CON_DOMINIO, dominio_verificado_en: "2026-09-29T12:00:00.000Z" };
const ACTIVO: PanelSso = { ...VERIFICADO, activo: true };
const EXIGIDO: PanelSso = { ...ACTIVO, exigir: true };

function pintar(panel: PanelSso, opciones: { locale?: Locale; resultado?: ResultadoSso | null; email?: string } = {}) {
  return renderToStaticMarkup(
    <SsoPanel
      panel={panel}
      t={getT(opciones.locale ?? "es-AR")}
      email={opciones.email ?? "admin@empresa.com"}
      resultado={opciones.resultado ?? null}
    />
  );
}

/** La etiqueta de apertura del campo `name`, tal como la ve el navegador. */
const campo = (html: string, name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

/** El botón con ese texto, con sus atributos. */
const boton = (html: string, texto: string) => html.match(new RegExp(`<button[^>]*>${texto}</button>`))?.[0] ?? "";

/** Como lo escribe React en el HTML. */
const escapado = (texto: string) =>
  texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** Apagado de verdad: el atributo, no la variante `disabled:` de Tailwind que está en la clase. */
const apagado = (html: string, texto: string) => boton(html, texto).includes('disabled=""');

describe("SsoPanel — sin configurar", () => {
  const html = pintar(VACIO);

  it("muestra el estado apagado y la dirección de vuelta que hay que registrar en el IdP", () => {
    expect(html).toContain("Apagado");
    expect(html).toContain("https://claimmix.example.com/api/auth/sso-inquilino/callback");
  });

  it("ofrece el formulario del IdP, con el secreto obligatorio porque todavía no hay uno", () => {
    expect(campo(html, "issuer")).toContain('type="url"');
    expect(campo(html, "client_id")).toContain("required");
    expect(campo(html, "dominio")).toContain("required");
    expect(campo(html, "client_secret")).toContain('type="password"');
    expect(campo(html, "client_secret")).toContain("required");
    expect(html).toContain("Todavía no hay un secreto guardado.");
  });

  it("no muestra el registro DNS, ni probar, ni exigir", () => {
    expect(html).not.toContain("_claimmix.");
    expect(html).not.toContain("Verificar dominio");
    expect(html).not.toContain("Probar con el SSO");
    expect(html).not.toContain("Exigir el SSO");
  });

  it("el botón de activar está, pero apagado: falta todo", () => {
    expect(apagado(html, "Activar el SSO")).toBe(true);
  });
});

describe("SsoPanel — dominio sin verificar", () => {
  const html = pintar(CON_DOMINIO);

  it("muestra el TXT a publicar, con su nombre y su valor, y el botón de verificar", () => {
    expect(html).toContain("_claimmix.empresa.com");
    expect(html).toContain("claimmix-verificacion=AbC_123-token");
    expect(html).toContain("Verificar dominio");
    expect(html).not.toContain("Dominio verificado");
  });

  it("todavía no se puede activar", () => {
    expect(apagado(html, "Activar el SSO")).toBe(true);
  });

  it("los datos guardados vuelven a los campos", () => {
    expect(campo(html, "issuer")).toContain('value="https://idp.empresa.com"');
    expect(campo(html, "client_id")).toContain('value="cliente-1"');
    expect(campo(html, "dominio")).toContain('value="empresa.com"');
  });
});

describe("SsoPanel — el secreto no vuelve", () => {
  it("con uno guardado, el campo va vacío y sin `required`, y el texto dice que se conserva", () => {
    const html = pintar(CON_DOMINIO);
    const secreto = campo(html, "client_secret");
    expect(secreto).not.toContain("value=");
    expect(secreto).not.toContain("required");
    expect(secreto).toContain('autoComplete="new-password"');
    expect(html).toContain("Ya hay un secreto guardado.");
  });

  it("nada del panel puede llevar un secreto: no hay campo de donde sacarlo", () => {
    const html = pintar({ ...CON_DOMINIO, client_secret_cifrado: "CIFRADO-NO-SALE" } as never);
    expect(html).not.toContain("CIFRADO-NO-SALE");
  });
});

describe("SsoPanel — dominio verificado", () => {
  const html = pintar(VERIFICADO);

  it("dice que está verificado y ya no pide el TXT", () => {
    expect(html).toContain("Dominio verificado");
    expect(html).not.toContain("claimmix-verificacion=");
    expect(html).not.toContain("Verificar dominio");
  });

  it("activar queda habilitado, y manda campo=activo valor=1", () => {
    expect(boton(html, "Activar el SSO")).not.toBe("");
    expect(apagado(html, "Activar el SSO")).toBe(false);
    expect(html).toContain('<input type="hidden" name="campo" value="activo"/>');
    expect(html).toContain('<input type="hidden" name="valor" value="1"/>');
  });

  it("probar y exigir aparecen recién con el SSO activo", () => {
    expect(html).not.toContain("Probar con el SSO");
    expect(html).not.toContain("Exigir el SSO");
  });
});

describe("SsoPanel — activo", () => {
  const html = pintar(ACTIVO);

  it("muestra que se puede entrar de las dos maneras", () => {
    expect(html).toContain("Activo: se puede entrar con el SSO o con contraseña");
  });

  it("ofrece apagar y ya no activar", () => {
    expect(html).toContain("Apagar el SSO");
    expect(html).not.toContain("Activar el SSO");
    expect(html).toContain('<input type="hidden" name="valor" value="0"/>');
  });

  it("deja lista la prueba con el correo del admin, editable", () => {
    expect(html).toContain("Probar con el SSO");
    expect(campo(html, "email")).toContain('value="admin@empresa.com"');
    expect(campo(html, "email")).toContain('type="email"');
  });

  it("ofrece exigir, que manda campo=exigir valor=1", () => {
    expect(html).toContain("Exigir el SSO");
    expect(html).toContain('<input type="hidden" name="campo" value="exigir"/>');
    expect(html).toMatch(/name="campo" value="exigir"\/><input type="hidden" name="valor" value="1"\/>/);
  });
});

describe("SsoPanel — exigido", () => {
  const html = pintar(EXIGIDO);

  it("dice que el dominio sólo entra por SSO y ofrece dejar de exigirlo", () => {
    expect(html).toContain("Activo y exigido: el dominio solo entra con el SSO");
    expect(html).toContain("Dejar de exigir el SSO");
    expect(html).toMatch(/name="campo" value="exigir"\/><input type="hidden" name="valor" value="0"\/>/);
  });
});

describe("SsoPanel — falta la 0045", () => {
  it("avisa en lugar de ofrecer un formulario que no va a guardar", () => {
    const html = pintar({ ...VACIO, migracion_pendiente: true });
    expect(html).toContain("Falta aplicar una migración de la base de datos");
    expect(html).not.toContain("<form");
  });
});

describe("SsoPanel — resultado de la última acción", () => {
  it("un éxito se pinta en verde, con su texto", () => {
    const html = pintar(VACIO, { resultado: "guardado" });
    expect(html).toContain('role="status"');
    expect(html).toContain("Datos guardados. Falta verificar el dominio.");
    expect(html).toContain("text-green-800");
  });

  it("un rechazo se pinta en rojo, con su texto", () => {
    const html = pintar(VACIO, { resultado: "dominioPublico" });
    expect(html).toContain("gmail.com");
    expect(html).toContain("text-red-800");
  });

  it("«exigido sin cerrar» no es un éxito: hay algo para hacer", () => {
    expect(pintar(EXIGIDO, { resultado: "exigidoSinCerrar" })).toContain("text-red-800");
  });

  it("sin resultado, no hay aviso", () => {
    expect(pintar(VACIO)).not.toContain('role="status"');
  });

  it.each(RESULTADOS_SSO)("«%s» tiene texto en castellano y en inglés, distinto entre sí", (resultado) => {
    const es = pintar(VACIO, { resultado, locale: "es-AR" });
    const en = pintar(VACIO, { resultado, locale: "en-US" });
    const claveEs = getT("es-AR")(`configuracion.sso.r.${resultado}`);
    const claveEn = getT("en-US")(`configuracion.sso.r.${resultado}`);
    expect(claveEs).toBeTruthy();
    expect(claveEn).toBeTruthy();
    expect(claveEs).not.toBe(claveEn);
    expect(es).toContain(escapado(claveEs));
    expect(en).toContain(escapado(claveEn));
  });
});

describe("SsoPanel — en inglés", () => {
  it("traduce los rótulos, los pasos y el registro DNS", () => {
    const html = pintar(CON_DOMINIO, { locale: "en-US" });
    expect(html).toContain("Off");
    expect(html).toContain("Redirect URI to register in your provider");
    expect(html).toContain("Provider issuer");
    expect(html).toContain("Verify domain");
    expect(html).toContain("Record name");
    expect(html).toContain("_claimmix.empresa.com");
    expect(html).not.toContain("Verificar dominio");
  });

  it("en el panel activo, prueba y exigir en inglés", () => {
    const html = pintar(ACTIVO, { locale: "en-US" });
    expect(html).toContain("Test with SSO");
    expect(html).toContain("Require SSO");
    expect(html).toContain("Turn SSO off");
  });
});

describe("SsoPanel — lo que viene de la base no se interpreta", () => {
  it("el dominio y el issuer con comillas y etiquetas salen escapados", () => {
    const html = pintar({
      ...CON_DOMINIO,
      issuer: '"><script>alert(1)</script>',
      dominio: '"><img src=x onerror=alert(1)>',
    });
    // React agrega su propio <script> para reenviar formularios: lo que no puede haber es el del dato.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
