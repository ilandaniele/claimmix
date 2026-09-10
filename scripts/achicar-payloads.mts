/**
 * `pnpm achicar-payloads` — saca de `claim_messages.raw_payload` el cuerpo que
 * ya está guardado decodificado al lado.
 *
 * El arreglo hacia adelante vive en `payload-sin-duplicados.ts` y corre en cada
 * correo nuevo. Esto es para las filas que ya están escritas.
 *
 * ── Qué hace exactamente ────────────────────────────────────────────────────
 *
 * Cada parte `text/plain` y `text/html` del payload de Gmail trae su `body.data`
 * en base64url: el mismo cuerpo que la fila ya tiene, decodificado, en
 * `body_text` y `body_html`. Se saca ese `data` y nada más. La estructura MIME,
 * los encabezados, los ids, las etiquetas, el `snippet` y el `attachmentId` de
 * cada adjunto quedan enteros.
 *
 * ── Medido en producción antes de escribir esto ─────────────────────────────
 *
 *   claim_messages          13 MB con 430 filas
 *   raw_payload de gmail   6,3 MB con 396 filas   (18 kB por correo)
 *
 * Sobre una muestra de 60, el payload queda en el 21 % de lo que pesaba.
 *
 * ── Es irreversible, y por eso es dry run ───────────────────────────────────
 *
 * La copia en base64 no se puede reconstruir byte a byte desde `body_text`: el
 * salto de línea, el juego de caracteres y el relleno del base64 no vuelven
 * iguales. Lo que se conserva es el CONTENIDO, en su columna, que es lo que
 * cualquiera va a leer.
 *
 * Sin `--apply` no escribe nada: cuenta cuánto se ahorraría y muestra un
 * ejemplo. Con `--apply`, escribe.
 *
 * Uso:
 *   pnpm achicar-payloads                        # cuenta, no toca nada
 *   pnpm achicar-payloads --env STAGING_DATABASE_URL
 *   pnpm achicar-payloads --apply                # escribe
 */

import { connect } from "./lib/db-driver.mjs";
import { leerDeEnvLocal } from "./lib/env-local.mjs";

const APPLY = process.argv.includes("--apply");
const envIdx = process.argv.indexOf("--env");
const VAR = envIdx !== -1 ? process.argv[envIdx + 1]! : "DATABASE_URL";

/** De a cuántas filas por vuelta. Cada una es un UPDATE por id. */
const LOTE = 100;

const YA_DECODIFICADAS = new Set(["text/plain", "text/html"]);

interface Parte {
  mimeType?: string | null;
  body?: Record<string, unknown> | null;
  parts?: Parte[] | null;
  [k: string]: unknown;
}

function limpiarParte(parte: Parte): Parte {
  const mime = parte.mimeType ?? "";
  const hijas = parte.parts?.map(limpiarParte);
  const cuerpo =
    parte.body && YA_DECODIFICADAS.has(mime)
      ? Object.fromEntries(Object.entries(parte.body).filter(([c]) => c !== "data"))
      : parte.body;

  return {
    ...parte,
    ...(parte.body !== undefined ? { body: cuerpo } : {}),
    ...(hijas ? { parts: hijas } : {}),
  };
}

function limpiar(msg: unknown): unknown {
  if (!msg || typeof msg !== "object") return msg;
  const m = msg as { payload?: Parte | null };
  if (!m.payload) return msg;
  return { ...msg, payload: limpiarParte(m.payload) };
}

const cadena = leerDeEnvLocal(VAR);
if (!cadena) {
  console.error(`✖ ${VAR} no está en .env.local`);
  process.exit(1);
}
console.log(`▸ base: ${VAR}`);

const c = await connect(cadena);
const kb = (n: number) => `${Math.round(n / 1024)} kB`;

try {
  let ultimoId = "00000000-0000-0000-0000-000000000000";
  let vistos = 0;
  let tocados = 0;
  let antes = 0;
  let despues = 0;
  let ejemplo: { antes: number; despues: number } | null = null;

  for (;;) {
    const { rows } = await c.query(
      `select id, raw_payload from claim_messages
        where id > $1 and raw_payload is not null
        order by id limit ${LOTE}`,
      [ultimoId]
    );
    if (rows.length === 0) break;

    for (const fila of rows as Array<{ id: string; raw_payload: unknown }>) {
      ultimoId = fila.id;
      vistos++;

      const original = JSON.stringify(fila.raw_payload);
      const limpio = JSON.stringify(limpiar(fila.raw_payload));
      if (limpio === original) continue;

      tocados++;
      antes += original.length;
      despues += limpio.length;
      if (!ejemplo) ejemplo = { antes: original.length, despues: limpio.length };

      if (APPLY) {
        await c.query("update claim_messages set raw_payload = $2::jsonb where id = $1", [
          fila.id,
          limpio,
        ]);
      }
    }
  }

  console.log(`\nfilas con payload: ${vistos}`);
  console.log(`con cuerpo duplicado: ${tocados}`);
  if (tocados === 0) {
    console.log("\nNo hay nada que achicar: ya están todas limpias.");
    process.exit(0);
  }

  const ahorro = antes - despues;
  console.log(`\n  antes:   ${kb(antes)}`);
  console.log(`  después: ${kb(despues)}`);
  console.log(`  ahorro:  ${kb(ahorro)}  (${Math.round((ahorro * 100) / antes)} %)`);
  if (ejemplo) {
    console.log(`\n  un mensaje: ${ejemplo.antes} → ${ejemplo.despues} bytes`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nada escrito. Repetí con --apply.");
    process.exit(0);
  }

  console.log(`\n✔ ${tocados} filas achicadas.`);
  console.log("  El espacio en disco se libera con un VACUUM, que Neon corre solo.");
} finally {
  await c.end();
}
