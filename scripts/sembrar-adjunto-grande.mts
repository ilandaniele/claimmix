/**
 * `pnpm sembrar-adjunto [--limpiar]` — deja un adjunto de 8 MiB listo para el
 * e2e de streaming (`tests/e2e/adjunto-de-8mb.spec.ts`).
 *
 * El archivo se genera acá, no vive en el repo: 8 MiB de ceros pesarían lo
 * mismo en cada clonado y al test no le importa el contenido, sólo el
 * tamaño y que llegue en más de un trozo.
 *
 * **No corre contra producción.** Mismas guardas que
 * `sembrar-para-integracion.mts` —falta la cadena, no es una URL, es la misma
 * que `DATABASE_URL`— más una cuarta propia de este script: se planta si el
 * host de destino es el de producción, aunque nadie haya exportado
 * `DATABASE_URL` con esa cadena. Subir un archivo de 8 MiB a la base donde
 * viven denuncias reales es exactamente lo que no hay que hacer.
 */
import * as dotenv from "dotenv";
import { HOST_DE_PRODUCCION, hostDe } from "../tests/e2e/base-de-ensayo";
dotenv.config({ path: ".env.local" });

const destino = process.env.SEED_DATABASE_URL?.trim() ?? process.env.STAGING_DATABASE_URL?.trim();
const produccion = process.env.DATABASE_URL?.trim();

if (!destino) {
  console.error("Falta SEED_DATABASE_URL (o STAGING_DATABASE_URL).");
  process.exit(2);
}

/*
 * Que la cadena sea una cadena, antes de dársela al driver.
 *
 * Mismo motivo que en `sembrar-para-integracion.mts`: un valor con comillas
 * alrededor pasa desapercibido en local —dotenv se las saca al leer el
 * archivo— pero guardado como secreto de CI viajan adentro del valor.
 */
try {
  new URL(destino.replace(/^postgres(ql)?:/, "https:"));
} catch {
  const comillas = /^["']|["']$/.test(destino);
  console.error("✗ La cadena de conexión no es una URL válida.");
  if (comillas) {
    console.error("  Tiene comillas alrededor. En `.env.local` dotenv se las saca sola,");
    console.error("  pero guardada como secreto viajan adentro del valor.");
  }
  console.error(`  Empieza con: ${destino.slice(0, 16)}…`);
  process.exit(2);
}

if (produccion && destino === produccion) {
  console.error("✗ Esa es la cadena de PRODUCCIÓN.");
  console.error("  Este script sube un adjunto de 8 MiB. En la base donde viven");
  console.error("  denuncias reales, eso no tiene por qué estar.");
  process.exit(2);
}

// Nunca la cadena entera, siempre el host.
const host = hostDe(destino);
if (!host) {
  console.error("✗ La cadena de destino no es una URL válida.");
  process.exit(2);
}
if (host.includes(HOST_DE_PRODUCCION)) {
  console.error(`✗ ${host} es la base de PRODUCCIÓN. Los e2e no corren ahí.`);
  process.exit(2);
}

// La capa de datos lee del entorno; se apunta al destino antes de importarla.
process.env.DATABASE_URL = destino;
process.env.DATABASE_URL_APP = destino;

const { uploadAttachment, deleteAttachment } = await import("@/server/storage/claim-attachments-bucket");
const { Pool, neonConfig } = await import("@neondatabase/serverless");
neonConfig.webSocketConstructor = globalThis.WebSocket as never;

// Mismos ids que `sembrar-para-integracion.mts:75,136`: el tenant y el caso
// con mensajes que ya siembra `pnpm sembrar`.
const INQUILINO = "10000000-0000-0000-0000-000000000001";
const CASO = "e2e00000-0000-4000-8000-000000000001";
const ADJUNTO = "e2e00000-0000-4000-8000-0000000000f8";
const TAMANO = 8 * 1024 * 1024;

const LIMPIAR = process.argv.includes("--limpiar");

const pool = new Pool({ connectionString: destino });
const cx = await pool.connect();

try {
  const { rows } = await cx.query(
    `select storage_path from claim_attachments where id = $1`,
    [ADJUNTO]
  );
  const previo: string | null = rows[0]?.storage_path ?? null;

  if (LIMPIAR) {
    if (previo) await deleteAttachment(previo);
    await cx.query(`delete from claim_attachments where id = $1`, [ADJUNTO]);
    console.log(previo ? `✓ adjunto borrado: ${ADJUNTO}` : `· no había nada que borrar (${ADJUNTO})`);
  } else {
    // Un objeto de la corrida anterior, si quedó — la clave cambia en cada
    // corrida (`e2e-pdf-<timestamp>`), así que sembrar de nuevo no lo pisa solo.
    if (previo) await deleteAttachment(previo);

    // Un header que un visor reconoce, determinístico, sin depender de nada.
    const data = Buffer.alloc(TAMANO, 0);
    data.write("%PDF-1.4\n", 0, "latin1");
    data.write("\n%%EOF\n", TAMANO - 7, "latin1");

    const subido = await uploadAttachment({
      tenantId: INQUILINO,
      caseId: CASO,
      messageId: `e2e-pdf-${Date.now()}`,
      filename: "ocho-megas.pdf",
      contentType: "application/pdf",
      data,
    });
    if ("error" in subido) {
      console.error(`✗ ${subido.error}`);
      process.exitCode = 1;
    } else {
      await cx.query(
        `insert into claim_attachments
           (id, tenant_id, case_id, file_name, content_type, size_bytes, storage_path, rejected_reason)
         values ($1, $2, $3, 'ocho-megas.pdf', 'application/pdf', $4, $5, null)
         on conflict (id) do update set
           storage_path = excluded.storage_path,
           size_bytes = excluded.size_bytes,
           content_type = excluded.content_type,
           rejected_reason = null`,
        [ADJUNTO, INQUILINO, CASO, TAMANO, subido.storagePath]
      );
      console.log(`adjunto sembrado: ${ADJUNTO} (${TAMANO} bytes) en ${host}`);
    }
  }
} finally {
  cx.release();
  await pool.end();
}
