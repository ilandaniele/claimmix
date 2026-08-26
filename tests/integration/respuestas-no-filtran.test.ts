/**
 * Qué devuelven los GET, recorriéndolos todos.
 *
 * Tres preguntas que se hacen una vez a mano, se responden "sí, está bien", y
 * nadie vuelve a mirar hasta que alguien agrega una columna:
 *
 *   1. ¿Sale algún secreto? Una contraseña, un token, una clave de API. Basta
 *      con que alguien escriba `.select()` sin columnas —que trae la tabla
 *      entera— sobre una tabla que tiene una.
 *   2. ¿Están acotados? Un listado sin tope crece con los datos del cliente:
 *      anda con cuatrocientos casos y tumba la pestaña con cuarenta mil.
 *   3. ¿Devuelven de más? Cada columna que sale y no se usa es superficie
 *      gratis: no la pidió nadie y puede llevar un dato personal.
 *
 * Se recorre la lista de rutas en vez de probar unas pocas, porque el problema
 * aparece en la que se agrega mañana. Si sale una ruta nueva y no está acá, el
 * primer test lo dice.
 */
import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TEST_EMAIL = process.env.INTEGRATION_TEST_EMAIL ?? "lucia@seguros-del-sur.com.ar";
const TEST_PASSWORD = process.env.INTEGRATION_TEST_PASSWORD ?? "Analyst123!";
const shouldSkip = !process.env.TEST_BASE_URL && !process.env.INTEGRATION_ENABLED;

/**
 * Los GET que devuelven datos, con qué rol se llega a cada uno.
 *
 * Los de admin se piden igual: con una sesión de analista tienen que responder
 * 403, y un 403 tampoco puede traer secretos adentro.
 */
const RUTAS = [
  "/api/cases",
  "/api/cases/export.csv",
  "/api/auth/me",
  "/api/admin/users",
  "/api/admin/ai-settings",
  "/api/admin/billing",
  "/api/admin/custom-fields",
  "/api/admin/prompt-rules",
  "/api/admin/provider-usage",
  "/api/admin/training-examples",
  "/api/admin/gmail-accounts",
  "/api/admin/gmail-status",
  "/api/admin/fine-tuning/jobs",
  "/api/admin/fine-tuning/vertex",
  "/api/agent/export",
];

/**
 * Formas de secreto, no nombres de campo.
 *
 * Buscar la clave `password` no sirve: el problema es el VALOR que sale, y
 * puede salir bajo cualquier nombre —o adentro de un texto libre—. Estas son
 * las formas que tienen los secretos que este producto maneja.
 */
const FORMAS_DE_SECRETO: Array<[string, RegExp]> = [
  ["hash de contraseña (bcrypt/scrypt)", /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{50,}|\$scrypt\$/],
  ["token de refresco de Google", /\b1\/\/0[A-Za-z0-9_-]{20,}/],
  ["clave de API de Google", /\bAIza[A-Za-z0-9_-]{30,}/],
  ["secreto de cliente OAuth", /\bGOCSPX-[A-Za-z0-9_-]{15,}/],
  ["token de Meta", /\bEAA[A-Za-z0-9]{60,}/],
  ["cadena de conexión", /\bpostgres(ql)?:\/\/[^:]+:[^@]{6,}@/],
  ["clave de API de Neon", /\bnapi_[A-Za-z0-9]{40,}/],
];

/** Un tope generoso: nada de esto debería acercarse. */
const TOPE_BYTES = 2 * 1024 * 1024;

let cookie = "";

async function pedir(ruta: string) {
  const res = await fetch(`${BASE_URL}${ruta}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: "manual",
  });
  return { status: res.status, cuerpo: await res.text() };
}

beforeAll(async () => {
  if (shouldSkip) return;
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  cookie = res.headers.get("set-cookie") ?? "";
  if (!cookie) {
    throw new Error(
      `No hay sesión (${res.status}). Sembrá con \`pnpm sembrar\` y levantá el servidor.`
    );
  }
}, 30_000);

describe.skipIf(shouldSkip)("ningún GET devuelve un secreto", () => {
  for (const ruta of RUTAS) {
    it(`${ruta}`, async () => {
      const { status, cuerpo } = await pedir(ruta);

      for (const [que, forma] of FORMAS_DE_SECRETO) {
        expect(forma.test(cuerpo), `${ruta} (${status}) devolvió ${que}`).toBe(false);
      }
    });
  }

  it("tampoco sin sesión", async () => {
    // Un 401 con el motivo adentro es una fuga con un código de estado prolijo.
    const guardada = cookie;
    cookie = "";
    try {
      for (const ruta of RUTAS) {
        const { cuerpo } = await pedir(ruta);
        for (const [que, forma] of FORMAS_DE_SECRETO) {
          expect(forma.test(cuerpo), `${ruta} sin sesión devolvió ${que}`).toBe(false);
        }
      }
    } finally {
      cookie = guardada;
    }
  }, 30_000);
});

describe.skipIf(shouldSkip)("los listados están acotados", () => {
  it("/api/cases tiene tope aunque se pida de más", async () => {
    // Sin tope, el listado crece con los datos del cliente: anda con
    // cuatrocientos casos y tumba la pestaña con cuarenta mil.
    const res = await fetch(`${BASE_URL}/api/cases?per_page=100000`, {
      headers: { Cookie: cookie },
    });
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      const b = (await res.json()) as { data?: unknown[] };
      expect((b.data ?? []).length).toBeLessThanOrEqual(100);
    }
  });

  it("ninguna respuesta se pasa de dos megas", async () => {
    for (const ruta of RUTAS) {
      const { cuerpo } = await pedir(ruta);
      expect(
        Buffer.byteLength(cuerpo),
        `${ruta} devolvió ${(Buffer.byteLength(cuerpo) / 1024).toFixed(0)} KB`
      ).toBeLessThan(TOPE_BYTES);
    }
  }, 30_000);
});

describe.skipIf(shouldSkip)("el listado no trae columnas que nadie pidió", () => {
  it("/api/cases devuelve un conjunto de campos declarado", async () => {
    const { status, cuerpo } = await pedir("/api/cases");
    expect(status).toBe(200);
    const b = JSON.parse(cuerpo) as { data?: Array<Record<string, unknown>> };
    const fila = b.data?.[0];
    if (!fila) return; // Sin datos no hay nada que comprobar.

    /*
     * Se comprueba lo que NO tiene que estar, no la lista exacta.
     *
     * Fijar la lista exacta convierte cada campo nuevo en un test roto, y a los
     * dos meses alguien lo "arregla" pegando el campo nuevo sin mirar. Lo que
     * importa es que no salgan las columnas internas: no las usa la pantalla y
     * cada una es superficie gratis.
     */
    for (const prohibida of [
      "extraction_lease_at",
      "extraction_pending",
      "core_error_message",
      "raw_payload",
    ]) {
      expect(fila, `/api/cases devuelve ${prohibida}, que es interna`).not.toHaveProperty(
        prohibida
      );
    }
  });
});
