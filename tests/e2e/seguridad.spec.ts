/**
 * La superficie de seguridad, contra un servidor de verdad.
 *
 * Los tests unitarios prueban funciones y el pen test recorre producción. Esto
 * es lo del medio: contra el servidor que se está por desplegar, y por eso
 * atrapa lo que rompe un cambio ANTES de que llegue.
 *
 * Cubre tres cosas que ninguna otra capa mira:
 *
 *   · las rutas que publica el motor de flujos, que aparecieron con la
 *     ejecución durable y no viven en `src/app/api` — el recorrido automático
 *     del pen test no las ve
 *   · la política de contenido con su nonce por pedido, que la inyecta el proxy
 *     y que un cambio en su matcher desactiva en silencio
 *   · que la pantalla pública sea lo único público
 */
import { test, expect } from "@playwright/test";

/** Las cabeceras que tienen que venir en toda respuesta. */
const CABECERAS = [
  "content-security-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
];

test.describe("el motor de flujos no acepta trabajo de afuera", () => {
  // Superficie nueva: la ejecución durable publica estas rutas, y por ellas se
  // encolan los pasos. Si alguien de afuera pudiera invocarlas, podría hacer
  // correr al agente sobre casos de cualquier aseguradora, gastar el
  // presupuesto de IA, y hacerle escribir a quien quiera.
  const RUTAS = ["/.well-known/workflow/v1/flow", "/.well-known/workflow/v1/step"];

  for (const ruta of RUTAS) {
    test(`${ruta} rechaza una invocación anónima`, async ({ request }) => {
      const res = await request.post(ruta, {
        // Un cuerpo con forma de invocación real. Con `{}` un 400 sólo diría
        // que valida el esquema, no que pida credenciales.
        data: {
          workflowId:
            "workflow//./src/workflows/intake-simulado//procesarCasoSimulado",
          args: [
            { caseId: "x", tenantId: "x", userId: "x", caseCreatedAt: null },
          ],
        },
        failOnStatusCode: false,
        maxRedirects: 0,
      });

      // Cualquier cosa menos un 2xx. Un 400 vale: significa que ni siquiera
      // llegó a mirar qué le pidieron.
      expect(res.status(), `${ruta} respondió ${res.status()}`).toBeGreaterThanOrEqual(300);
    });
  }

  test("no existe una ruta de flujos que liste lo que hay", async ({ request }) => {
    // Enumerar los flujos registrados le diría a un atacante exactamente qué
    // invocar, con qué nombre y con qué forma de argumentos.
    for (const ruta of [
      "/.well-known/workflow/v1",
      "/.well-known/workflow/v1/manifest.json",
      "/.well-known/workflow/v1/config.json",
    ]) {
      const res = await request.get(ruta, { failOnStatusCode: false, maxRedirects: 0 });
      if (res.status() === 200) {
        const cuerpo = await res.text();
        expect(cuerpo, `${ruta} enumera flujos`).not.toContain("procesarCasoSimulado");
      }
    }
  });
});

test.describe("las cabeceras de seguridad", () => {
  test("vienen en una página", async ({ request }) => {
    const res = await request.get("/login");
    const cabeceras = res.headers();
    for (const c of CABECERAS) {
      expect(cabeceras[c], `falta ${c}`).toBeTruthy();
    }
  });

  test("la política de contenido lleva un nonce distinto en cada pedido", async ({
    request,
  }) => {
    // El nonce lo inyecta el proxy por pedido. Un nonce fijo —o ninguno— hace
    // que la política deje de servir contra inyección de scripts, y no se nota
    // desde afuera: la cabecera sigue estando.
    const nonces = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await request.get("/login", { headers: { "cache-control": "no-cache" } });
      const csp = res.headers()["content-security-policy"] ?? "";
      const m = /'nonce-([^']+)'/.exec(csp);
      expect(m, "la CSP no lleva nonce").toBeTruthy();
      nonces.add(m![1]);
    }
    expect(nonces.size, "el nonce se repite entre pedidos").toBeGreaterThan(1);
  });

  test("no permite que la incrusten en un iframe", async ({ request }) => {
    // Sin esto, un sitio ajeno puede montar la aplicación en un marco invisible
    // y hacer que un analista con sesión abierta haga clics que no ve.
    const res = await request.get("/login");
    expect(res.headers()["x-frame-options"]?.toUpperCase()).toBe("DENY");
  });

  test("no ofrece CORS a un origen cualquiera", async ({ request }) => {
    const res = await request.get("/api/cases", {
      headers: { origin: "https://sitio-de-un-atacante.example" },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const permitido = res.headers()["access-control-allow-origin"];
    expect(permitido === undefined || permitido === "").toBeTruthy();
  });
});

test.describe("lo público es sólo lo público", () => {
  test("la pantalla de demostración abre sin sesión", async ({ page }) => {
    // Es pública a propósito: es la que se le muestra a un prospecto. Que deje
    // de abrir es una falla de negocio, no de seguridad, y por eso está acá:
    // el mismo cambio que cierra una puerta puede cerrar ésta.
    const res = await page.goto("/demo");
    expect(res?.status()).toBe(200);
  });

  test("la demostración no filtra datos de una aseguradora real", async ({ page }) => {
    await page.goto("/demo");
    const texto = (await page.textContent("body")) ?? "";

    // Corre sobre un inquilino de demostración. Si apareciera el nombre de la
    // aseguradora que está en producción, la pantalla pública estaría leyendo
    // de donde no debe.
    expect(texto).not.toContain("Seguros del Sur");
  });

  test("una ruta privada manda al login, no a la pantalla", async ({ request }) => {
    const res = await request.get("/bandeja", { maxRedirects: 0, failOnStatusCode: false });
    expect([301, 302, 307, 308]).toContain(res.status());
    expect(res.headers()["location"] ?? "").toContain("/login");
  });
});

test.describe("lo que un error cuenta de más", () => {
  test("un id inválido no devuelve el stack", async ({ request }) => {
    const res = await request.get("/api/cases/no-es-un-uuid", {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const cuerpo = await res.text();

    // Un stack expone rutas del servidor, versiones de paquetes y a veces la
    // consulta entera. Cada una de esas cosas acorta el camino del que busca.
    expect(cuerpo).not.toContain("node_modules");
    expect(cuerpo).not.toContain("at async");
    expect(cuerpo).not.toMatch(/[A-Z]:\\\\Users|\/var\/task/);
  });

  test("la salud no enumera la configuración a un anónimo", async ({ request }) => {
    const res = await request.get("/api/health", { failOnStatusCode: false });
    const cuerpo = await res.text();

    // Con token responde el detalle completo. Sin token, saber qué integraciones
    // hay configuradas ya es información: dice por dónde buscar.
    expect(res.status()).toBe(401);
    expect(cuerpo).not.toContain("checks");
    expect(cuerpo).not.toContain("whatsapp");
  });
});

/**
 * Que el límite de tráfico exista de verdad.
 *
 * Se prueba sobre una ruta pública, porque es la única que un anónimo puede
 * golpear — y por eso es la que hay que limitar. Sin límite, la pantalla de
 * demostración es una forma gratuita de gastarle el presupuesto de IA a la
 * empresa.
 */
test.describe("el límite de tráfico", () => {
  test("la ruta pública de análisis no acepta un aluvión", async ({ request }) => {
    const disparos: Promise<{ status: number }>[] = [];
    for (let i = 0; i < 25; i++) {
      disparos.push(
        request
          .post("/api/demo/public-analyze", {
            data: { text: `prueba de límite ${i}` },
            failOnStatusCode: false,
            maxRedirects: 0,
          })
          .then((r) => ({ status: r.status() }))
      );
    }
    const respuestas = await Promise.all(disparos);
    const limitadas = respuestas.filter((r) => r.status === 429).length;

    // No se exige un número exacto: el umbral es configurable y cambiarlo no
    // debería romper el test. Lo que se exige es que EXISTA un techo.
    expect(
      limitadas,
      `25 pedidos seguidos y ninguno fue limitado (${respuestas.map((r) => r.status).join(",")})`
    ).toBeGreaterThan(0);
  });
});
