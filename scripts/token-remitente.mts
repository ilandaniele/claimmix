/**
 * Saca el refresh token del remitente del sistema.
 *
 * El remitente de los mails de autenticación (`src/server/notify/remitente-sistema.ts`)
 * es una casilla Gmail propia de la plataforma, una sola para todos los
 * clientes. Su refresh token se pide una vez por ambiente, desde la máquina del
 * dueño, y queda en Vercel como `ALTA_REMITENTE_REFRESH_TOKEN`. Nunca va a la
 * base: la casilla no es una fila de `gmail_accounts`, y por eso el poller no la
 * lee.
 *
 * **El token tiene que salir del mismo cliente OAuth con el que se usa.** El
 * envío refresca con `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`, y un refresh
 * token sólo lo canjea el cliente que lo emitió. Por eso el script lee esas
 * mismas variables y no pide otras.
 *
 * Un cliente de tipo «Escritorio» acepta cualquier puerto de loopback. Uno de
 * tipo «Aplicación web» exige la dirección exacta: el puerto por omisión,
 * 53682, es el que está registrado como `http://127.0.0.1:53682/`; para otro,
 * registralo y pasalo con `--puerto`.
 *
 * Uso:  pnpm exec tsx --tsconfig tsconfig.rehearsal.json scripts/token-remitente.mts [--puerto N] [--correo casilla@example.com] [--vercel proyecto]
 *
 * Con `--vercel` el token no se imprime: va directo a ese proyecto, en
 * producción, como variable sensible, junto con `ALTA_REMITENTE_CORREO` (por eso
 * pide `--correo`). Viaja por la entrada estándar de la CLI de Vercel, no por la
 * línea de comandos. Pide `vercel` en el PATH con sesión iniciada, y lo prueba
 * antes del consentimiento. claimmix-prd no se carga así: su cliente OAuth sale
 * de su propio archivo, no de `.env.local`. Sin `--vercel`, el token se imprime.
 *
 * Sólo pide el permiso de enviar (`gmail.send`): esta casilla no lee ni borra
 * nada. El flujo es el de loopback con PKCE; el token no se escribe en ningún
 * archivo. Esto no habla con ninguna base.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

const ALCANCE = "https://www.googleapis.com/auth/gmail.send";
const ESPERA_MAXIMA_MS = 5 * 60_000;

const { values } = parseArgs({
  options: {
    puerto: { type: "string", default: "53682" },
    correo: { type: "string" },
    vercel: { type: "string" },
  },
});

const puerto = Number(values.puerto);
if (!Number.isInteger(puerto) || puerto < 0 || puerto > 65535) {
  console.error("--puerto tiene que ser un número entre 0 y 65535 (0 = uno libre).");
  process.exit(2);
}

const proyecto = values.vercel;
if (proyecto !== undefined) {
  if (!/^[a-z0-9-]+$/.test(proyecto)) {
    console.error(`--vercel ${proyecto}: el nombre no es válido.`);
    process.exit(2);
  }
  if (proyecto === "claimmix-prd") {
    console.error("claimmix-prd no se carga desde .env.local: corré sin --vercel y pegalo a mano.");
    process.exit(2);
  }
  if (!values.correo) {
    console.error("--vercel pide --correo: es la casilla que queda como ALTA_REMITENTE_CORREO.");
    process.exit(2);
  }
}

// Se lee antes del consentimiento: si después la carga no puede salir, el token canjeado se pierde.
const orgId = proyecto === undefined ? "" : leerOrgId();
function leerOrgId(): string {
  let id: string | undefined;
  try {
    id = (JSON.parse(readFileSync(".vercel/repo.json", "utf8")) as { projects?: { orgId?: string }[] }).projects?.[0]
      ?.orgId;
  } catch {
    id = undefined;
  }
  if (id && /^[\w-]+$/.test(id)) return id;
  console.error("No pude leer el orgId de .vercel/repo.json: corré `vercel link --repo` primero.");
  process.exit(2);
}

const clientId = process.env.GMAIL_CLIENT_ID?.trim();
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("Faltan GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET.");
  process.exit(2);
}
// Las funciones de abajo se declaran aparte y ahí TypeScript pierde lo que se descartó arriba.
const cliente = { id: clientId, secreto: clientSecret };

const verificador = randomBytes(32).toString("base64url");
const desafio = createHash("sha256").update(verificador).digest("base64url");
const estado = randomBytes(16).toString("base64url");

/** Espera a que Google vuelva al loopback con el código, o con un error. */
function esperarCodigo(): Promise<{ codigo: string; redirectUri: string }> {
  return new Promise((resolver, rechazar) => {
    let redirectUri = "";
    const servidor = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // El navegador pide también /favicon.ico: eso no es la vuelta de Google.
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== estado) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Estado inválido.");
        return;
      }

      const error = url.searchParams.get("error");
      const codigo = url.searchParams.get("code");
      res
        .writeHead(error || !codigo ? 400 : 200, { "content-type": "text/plain; charset=utf-8" })
        .end(error || !codigo ? "No se pudo completar." : "Listo. Volvé a la terminal.");
      clearTimeout(vencimiento);
      servidor.close();

      if (error || !codigo) rechazar(new Error(`Google respondió: ${error ?? "sin código"}`));
      else resolver({ codigo, redirectUri });
    });

    const vencimiento = setTimeout(() => {
      servidor.close();
      rechazar(new Error("Pasaron 5 minutos sin que Google vuelva."));
    }, ESPERA_MAXIMA_MS);

    servidor.listen(puerto, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/`;
      const autorizar = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      autorizar.search = new URLSearchParams({
        response_type: "code",
        client_id: cliente.id,
        redirect_uri: redirectUri,
        scope: ALCANCE,
        access_type: "offline",
        // Sin esto Google no devuelve refresh token si la cuenta ya dio permiso alguna vez.
        prompt: "consent",
        code_challenge: desafio,
        code_challenge_method: "S256",
        state: estado,
        ...(values.correo ? { login_hint: values.correo } : {}),
      }).toString();

      console.error(`Redirect URI: ${redirectUri}`);
      console.error("Abrí este enlace, entrá con la casilla del sistema y aceptá:\n");
      console.error(`${autorizar.toString()}\n`);
    });
    servidor.on("error", rechazar);
  });
}

async function canjear(codigo: string, redirectUri: string): Promise<string> {
  const respuesta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: codigo,
      client_id: cliente.id,
      client_secret: cliente.secreto,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verificador,
    }),
  });
  const cuerpo = (await respuesta.json()) as { refresh_token?: string; scope?: string; error?: string };
  if (!respuesta.ok) throw new Error(`Google rechazó el canje: ${cuerpo.error ?? respuesta.status}`);
  if (!cuerpo.refresh_token) throw new Error("Google no devolvió refresh token.");
  // El permiso que quedó es el que se usa: si trae algo más que enviar, no es la casilla que se quería.
  if (cuerpo.scope?.split(" ").some((s) => s !== ALCANCE)) {
    throw new Error(`El token trae más permisos que gmail.send: ${cuerpo.scope}`);
  }
  return cuerpo.refresh_token;
}

/** Llama a la API de Vercel con la CLI; el cuerpo va por stdin y la respuesta no se muestra. */
function vercelApi(ruta: string, motivo: string, cuerpo?: object): string {
  const separador = ruta.includes("?") ? "&" : "?";
  try {
    return execSync(
      `vercel api "${ruta}${separador}teamId=${orgId}"${cuerpo ? " -X POST --input -" : ""} --raw`,
      { input: cuerpo ? JSON.stringify(cuerpo) : "", stdio: ["pipe", "pipe", "pipe"] },
    ).toString();
  } catch (err) {
    // La CLI no repite el cuerpo del pedido en el error, así que su línea de error se puede mostrar.
    const lineas = (err as { stderr?: Buffer }).stderr?.toString().split("\n").map((l) => l.trim()).filter(Boolean);
    const linea = lineas?.find((l) => l.startsWith("Error")) ?? lineas?.at(-1);
    throw new Error(`${motivo}: ${linea?.slice(0, 200) ?? "la CLI de Vercel falló"}`);
  }
}

/** Crea o reemplaza una variable de producción del proyecto. */
function cargarEnVercel(destino: string, key: string, value: string, type: "encrypted" | "sensitive") {
  const salida = vercelApi(`/v10/projects/${destino}/env?upsert=true`, `Vercel no cargó ${key}`, {
    key,
    value,
    type,
    target: ["production"],
  });
  let respuesta: { error?: { code?: string; message?: string } };
  try {
    respuesta = JSON.parse(salida);
  } catch {
    // El mensaje de JSON.parse cita un pedazo de la respuesta, y la respuesta no se muestra.
    throw new Error(`Vercel devolvió algo que no es JSON al cargar ${key}.`);
  }
  if (respuesta.error) throw new Error(`Vercel rechazó ${key}: ${respuesta.error.code ?? respuesta.error.message}`);
}

try {
  // La CLI, la sesión y el nombre del proyecto se prueban antes de pedir el consentimiento.
  if (proyecto) vercelApi(`/v9/projects/${proyecto}`, `No pude ver el proyecto ${proyecto} en Vercel`);
  const { codigo, redirectUri } = await esperarCodigo();
  const token = await canjear(codigo, redirectUri);
  if (proyecto && values.correo) {
    cargarEnVercel(proyecto, "ALTA_REMITENTE_CORREO", values.correo, "encrypted");
    cargarEnVercel(proyecto, "ALTA_REMITENTE_REFRESH_TOKEN", token, "sensitive");
    console.error(`\n✓ ALTA_REMITENTE_CORREO y ALTA_REMITENTE_REFRESH_TOKEN cargadas en ${proyecto} (production). Las toma el próximo deploy.`);
  } else {
    console.error("\nPegalo en Vercel como ALTA_REMITENTE_REFRESH_TOKEN, junto con ALTA_REMITENTE_CORREO (la casilla con la que entraste):\n");
    console.log(token);
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : "Error desconocido"}`);
  process.exit(1);
}
