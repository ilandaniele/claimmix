/**
 * POST /api/denuncia/[slug] (B17): la ruta pública, sin sesión. Lo que
 * importa: el inquilino sale del enlace y no del cuerpo, un bot no crea nada,
 * y cada envío abre un caso nuevo sin colgarse de otro.
 */

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  inquilinoDelFormulario: vi.fn(),
  ingresarDenunciaWeb: vi.fn(),
  dispatchExtractionWorker: vi.fn(),
}));

vi.mock("server-only", () => ({}));
// El cupo real (`RATE_LIMIT_CONFIGS`) queda; sólo se reemplaza quien cuenta.
vi.mock("@/lib/rate-limit/index", async (original) => ({
  ...(await original<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: m.rateLimit,
  getClientIp: () => "203.0.113.7",
}));
vi.mock("@/server/web/formulario", () => ({ inquilinoDelFormulario: m.inquilinoDelFormulario }));
vi.mock("@/server/web/ingreso", () => ({ ingresarDenunciaWeb: m.ingresarDenunciaWeb }));
vi.mock("@/server/worker/despachar-extraccion", () => ({
  dispatchExtractionWorker: m.dispatchExtractionWorker,
}));

import { POST } from "@/app/api/denuncia/[slug]/route";
import { firmarToken } from "@/server/web/token";

const SLUG = "mi-aseguradora";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const CASE_ID = "20000000-0000-0000-0000-000000000002";
const DENUNCIA = {
  nombre: "Ana Pérez",
  email: "ana@ejemplo.com",
  telefono: "+54 291 555-1234",
  relato: "Me chocaron el auto ayer en la esquina de mi casa.",
};

// Un token que ya pasó la edad mínima de 4 s.
const tokenViejo = (slug = SLUG) => firmarToken(slug, Date.now() - 10_000);

const enviar = (cuerpo: unknown, slug = SLUG, extra: Record<string, string> = {}) =>
  POST(
    new NextRequest(`http://localhost/api/denuncia/${slug}`, {
      method: "POST",
      body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
      headers: { "content-type": "application/json", ...extra },
    }),
    { params: Promise.resolve({ slug }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_SECRET", "secreto-de-prueba-para-el-token-0123456789");
  m.rateLimit.mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 });
  m.inquilinoDelFormulario.mockResolvedValue({ tenantId: TENANT_ID, nombre: "Aseguradora" });
  m.ingresarDenunciaWeb.mockResolvedValue({ caseId: CASE_ID });
  m.dispatchExtractionWorker.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/denuncia/[slug]", () => {
  it("un envío bien hecho abre un caso del inquilino del enlace y despacha la extracción", async () => {
    const t = tokenViejo();
    const res = await enviar({ ...DENUNCIA, t });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recibida: true });
    expect(m.inquilinoDelFormulario).toHaveBeenCalledWith(SLUG);
    expect(m.ingresarDenunciaWeb).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      nombre: "Ana Pérez",
      email: "ana@ejemplo.com",
      telefono: "+54 291 555-1234",
      relato: DENUNCIA.relato,
      envio: t,
      ip: "203.0.113.7",
    });
    expect(m.dispatchExtractionWorker).toHaveBeenCalledWith(CASE_ID, TENANT_ID);
  });

  it("el mismo envío que ya abrió su caso (doble clic) da el mismo éxito y no despacha otra extracción", async () => {
    m.ingresarDenunciaWeb.mockResolvedValue(null);
    const res = await enviar({ ...DENUNCIA, t: tokenViejo() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recibida: true });
    expect(m.dispatchExtractionWorker).not.toHaveBeenCalled();
  });

  it("el teléfono es opcional", async () => {
    const { telefono: _sin, ...sinTelefono } = DENUNCIA;
    expect((await enviar({ ...sinTelefono, t: tokenViejo() })).status).toBe(200);
    expect(m.ingresarDenunciaWeb).toHaveBeenCalledWith(expect.objectContaining({ telefono: null }));
  });

  it("el tenant_id del cuerpo se ignora: el inquilino sale del enlace", async () => {
    await enviar({ ...DENUNCIA, t: tokenViejo(), tenant_id: "99999999-0000-0000-0000-000000000009" });
    expect(m.ingresarDenunciaWeb).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID }));
    expect(JSON.stringify(m.ingresarDenunciaWeb.mock.calls[0])).not.toContain("99999999");
  });

  it("pasado el tope por IP contesta 429 con Retry-After y no mira nada más", async () => {
    m.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 1800 });
    const res = await enviar({ ...DENUNCIA, t: tokenViejo() });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1800");
    expect(m.inquilinoDelFormulario).not.toHaveBeenCalled();
    expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
  });

  it("el tope es por IP, y de diez por hora", async () => {
    await enviar({ ...DENUNCIA, t: tokenViejo() });
    const [clave, tope] = m.rateLimit.mock.calls[0]!;
    expect(String(clave)).toContain("denuncia-web");
    expect(String(clave)).toContain("203.0.113.7");
    expect(tope).toEqual({ limit: 10, windowMs: 3_600_000 });
  });

  it("un cuerpo de más de 20 kB da 413 sin parsearlo", async () => {
    const res = await enviar("x".repeat(20_001));
    expect(res.status).toBe(413);
    expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
  });

  it("si content-length declara más de 20 kB corta antes de leer", async () => {
    const res = await enviar({ ...DENUNCIA, t: tokenViejo() }, SLUG, { "content-length": "50000" });
    expect(res.status).toBe(413);
    expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
  });

  it("el campo trampa lleno da el mismo éxito y no crea nada", async () => {
    const res = await enviar({ ...DENUNCIA, t: tokenViejo(), sitio: "http://spam.example" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recibida: true });
    expect(m.inquilinoDelFormulario).not.toHaveBeenCalled();
    expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    expect(m.dispatchExtractionWorker).not.toHaveBeenCalled();
  });

  describe("token", () => {
    it("sin token da 400", async () => {
      expect((await enviar(DENUNCIA)).status).toBe(400);
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it("un token de otro enlace da 400", async () => {
      expect((await enviar({ ...DENUNCIA, t: tokenViejo("otra-aseguradora") })).status).toBe(400);
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it("un token recién pintado (un bot que postea en el acto) da 400", async () => {
      expect((await enviar({ ...DENUNCIA, t: firmarToken(SLUG) })).status).toBe(400);
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it("un token de hace más de un día da 400", async () => {
      const viejo = firmarToken(SLUG, Date.now() - 24 * 3_600_000 - 60_000);
      expect((await enviar({ ...DENUNCIA, t: viejo })).status).toBe(400);
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it("un token de hace tres horas todavía vale: quien juntó datos no pierde su relato", async () => {
      const deHaceHoras = firmarToken(SLUG, Date.now() - 3 * 3_600_000);
      expect((await enviar({ ...DENUNCIA, t: deHaceHoras })).status).toBe(200);
    });

    it("un token con la firma cambiada da 400", async () => {
      const [hora] = tokenViejo().split(".");
      expect((await enviar({ ...DENUNCIA, t: `${hora}.${"a".repeat(64)}` })).status).toBe(400);
    });
  });

  describe("validación", () => {
    it.each([
      ["JSON roto", "{ no"],
      ["nombre corto", { ...DENUNCIA, nombre: "A" }],
      ["nombre con salto de línea", { ...DENUNCIA, nombre: "Ana\nPérez" }],
      ["nombre con marcas", { ...DENUNCIA, nombre: "Ana <b>" }],
      ["correo inválido", { ...DENUNCIA, email: "no-es-un-correo" }],
      ["dos direcciones en el correo", { ...DENUNCIA, email: "a@b.com, c@d.com" }],
      ["correo sin dominio con punto", { ...DENUNCIA, email: "ana@empresa" }],
      ["teléfono con letras", { ...DENUNCIA, telefono: "llamame" }],
      ["teléfono de más de 40 caracteres", { ...DENUNCIA, telefono: "1".repeat(41) }],
      ["relato corto", { ...DENUNCIA, relato: "choque" }],
      ["relato de más de 5000 caracteres", { ...DENUNCIA, relato: "a".repeat(5001) }],
      ["relato con caracteres de control", { ...DENUNCIA, relato: "hola\u0000 este es mi relato" }],
    ])("%s da 400", async (_caso, cuerpo) => {
      const enviado = typeof cuerpo === "string" ? cuerpo : { ...cuerpo, t: tokenViejo() };
      expect((await enviar(enviado)).status).toBe(400);
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it("un relato de 5000 caracteres con saltos de línea CRLF entra: el navegador los contó de a uno", async () => {
      // Lo que manda un `<textarea maxlength=5000>` lleno de renglones: 5000 caracteres a la vista, más de 5000 en el cuerpo.
      const escrito = `${"linea corta\n".repeat(100)}${"a".repeat(5000 - 1200)}`;
      expect(escrito).toHaveLength(5000);
      const enviadoPorElNavegador = escrito.replaceAll("\n", "\r\n");
      expect(enviadoPorElNavegador.length).toBeGreaterThan(5000);

      const res = await enviar({ ...DENUNCIA, relato: enviadoPorElNavegador, t: tokenViejo() });
      expect(res.status).toBe(200);
      const { relato } = m.ingresarDenunciaWeb.mock.calls[0]![0];
      expect(relato).not.toContain("\r");
      expect(relato).toBe(escrito);
    });

    it("el relato conserva sus saltos de línea", async () => {
      const relato = "Primera línea del relato.\nSegunda línea.\tCon tabulación.";
      expect((await enviar({ ...DENUNCIA, relato, t: tokenViejo() })).status).toBe(200);
      expect(m.ingresarDenunciaWeb).toHaveBeenCalledWith(expect.objectContaining({ relato }));
    });
  });

  it("un enlace apagado o que no existe da 404 y no crea nada", async () => {
    m.inquilinoDelFormulario.mockResolvedValue(null);
    const res = await enviar({ ...DENUNCIA, t: tokenViejo() });
    expect(res.status).toBe(404);
    expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
  });

  it("sin la 0044 contesta 503 MIGRACION_PENDIENTE, sea buscando el enlace o abriendo el caso", async () => {
    const sinTabla = Object.assign(new Error("no existe"), { code: "42P01" });

    m.inquilinoDelFormulario.mockRejectedValue(sinTabla);
    const buscando = await enviar({ ...DENUNCIA, t: tokenViejo() });
    expect(buscando.status).toBe(503);
    expect((await buscando.json()).error.code).toBe("MIGRACION_PENDIENTE");

    m.inquilinoDelFormulario.mockResolvedValue({ tenantId: TENANT_ID, nombre: "Aseguradora" });
    m.ingresarDenunciaWeb.mockRejectedValue(sinTabla);
    expect((await enviar({ ...DENUNCIA, t: tokenViejo() })).status).toBe(503);
    expect(m.dispatchExtractionWorker).not.toHaveBeenCalled();
  });

  it("un error inesperado al abrir el caso es 500 y no despacha", async () => {
    m.ingresarDenunciaWeb.mockRejectedValue(new Error("se cayó la base"));
    const res = await enviar({ ...DENUNCIA, t: tokenViejo() });
    expect(res.status).toBe(500);
    expect(m.dispatchExtractionWorker).not.toHaveBeenCalled();
  });

  describe("topes por formulario y por dirección", () => {
    it("después de la trampa y el token cuenta por formulario y por sha256 de la dirección", async () => {
      await enviar({ ...DENUNCIA, email: "  Ana@Ejemplo.com ", t: tokenViejo() });

      const claves = m.rateLimit.mock.calls.map(([clave]) => String(clave));
      expect(claves).toHaveLength(3);
      expect(claves[1]).toBe(`denuncia-slug:${SLUG}`);
      const huella = createHash("sha256").update("ana@ejemplo.com").digest("hex");
      expect(claves[2]).toBe(`denuncia-mail:${huella}`);
      // La dirección nunca entra a la tabla de cupos.
      expect(claves.join("|")).not.toContain("ana@");
      expect(m.rateLimit.mock.calls[1]![1]).toEqual({ limit: 200, windowMs: 3_600_000 });
      expect(m.rateLimit.mock.calls[2]![1]).toEqual({ limit: 3, windowMs: 3_600_000 });
    });

    it("con el tope del formulario gastado contesta 429 y no abre el caso", async () => {
      m.rateLimit
        .mockResolvedValueOnce({ allowed: true, remaining: 9, retryAfterSeconds: 0 })
        .mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
      const res = await enviar({ ...DENUNCIA, t: tokenViejo() });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it("con el tope de la dirección gastado contesta 429 y no abre el caso", async () => {
      m.rateLimit
        .mockResolvedValueOnce({ allowed: true, remaining: 9, retryAfterSeconds: 0 })
        .mockResolvedValueOnce({ allowed: true, remaining: 100, retryAfterSeconds: 0 })
        .mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 900 });
      const res = await enviar({ ...DENUNCIA, t: tokenViejo() });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("900");
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it("un envío sin token no gasta el cupo del formulario ni el de la dirección", async () => {
      await enviar(DENUNCIA);
      expect(m.rateLimit).toHaveBeenCalledTimes(1);
    });
  });

  describe("el formulario HTML de la página (sin JavaScript)", () => {
    const comoFormulario = (campos: Record<string, string>, slug = SLUG) =>
      POST(
        new NextRequest(`http://localhost/api/denuncia/${slug}`, {
          method: "POST",
          body: new URLSearchParams(campos).toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { params: Promise.resolve({ slug }) }
      );

    it("un envío bien hecho abre el caso y vuelve a la página con ?r=enviada", async () => {
      const res = await comoFormulario({ ...DENUNCIA, t: tokenViejo(), sitio: "" });

      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe(`/denuncia/${SLUG}?r=enviada`);
      expect(m.ingresarDenunciaWeb).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, email: "ana@ejemplo.com", relato: DENUNCIA.relato })
      );
    });

    it("la trampa llena vuelve con el mismo éxito y no crea nada", async () => {
      const res = await comoFormulario({ ...DENUNCIA, t: tokenViejo(), sitio: "http://spam.example" });

      expect(res.headers.get("Location")).toBe(`/denuncia/${SLUG}?r=enviada`);
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it.each([
      ["sin token", { ...DENUNCIA }, "invalida"],
      ["con el relato corto", { ...DENUNCIA, relato: "choque" }, "invalida"],
    ])("%s vuelve con ?r=%s", async (_caso, campos, resultado) => {
      const conToken = "t" in campos ? campos : { ...campos, t: tokenViejo() };
      const res = await comoFormulario(
        _caso === "sin token" ? campos : conToken
      );
      expect(res.headers.get("Location")).toBe(`/denuncia/${SLUG}?r=${resultado}`);
      expect(m.ingresarDenunciaWeb).not.toHaveBeenCalled();
    });

    it("con el tope por IP gastado vuelve con ?r=limite", async () => {
      m.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
      const res = await comoFormulario({ ...DENUNCIA, t: tokenViejo() });
      expect(res.headers.get("Location")).toBe(`/denuncia/${SLUG}?r=limite`);
    });

    it("una falla al abrir el caso vuelve con ?r=error", async () => {
      m.ingresarDenunciaWeb.mockRejectedValue(new Error("se cayó la base"));
      const res = await comoFormulario({ ...DENUNCIA, t: tokenViejo() });
      expect(res.headers.get("Location")).toBe(`/denuncia/${SLUG}?r=error`);
    });

    it("un enlace apagado vuelve a la página sin resultado (que da 404)", async () => {
      m.inquilinoDelFormulario.mockResolvedValue(null);
      const res = await comoFormulario({ ...DENUNCIA, t: tokenViejo() });
      expect(res.headers.get("Location")).toBe(`/denuncia/${SLUG}`);
    });

    it("un slug que no tiene el formato no redirige: contesta JSON y nunca arma un Location con él", async () => {
      const res = await comoFormulario({ ...DENUNCIA, t: tokenViejo("//evil.example") }, "//evil.example");
      expect(res.status).toBe(404);
      expect(res.headers.get("Location")).toBeNull();
      expect(m.rateLimit).not.toHaveBeenCalled();
    });

    it("ignora los campos que la página no tiene, tenant_id incluido", async () => {
      await comoFormulario({ ...DENUNCIA, t: tokenViejo(), tenant_id: "99999999-0000-0000-0000-000000000009" });
      expect(JSON.stringify(m.ingresarDenunciaWeb.mock.calls[0])).not.toContain("99999999");
    });
  });
});
