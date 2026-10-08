/**
 * Preparar la base de un inquilino, como flujo durable.
 *
 * Crear la base, migrarla, darle permisos y copiar el espejo de control tarda
 * más de lo que aguanta una petición, y cada parte puede fallar por red. Cada
 * `"use step"` corre en su propia petición y se reintenta sola; los pasos se
 * pueden repetir sin romper nada (ver `crear-base.ts`).
 *
 * Lo único que impide que dos flujos corran sobre la misma base es el lease de
 * `tomarBase`: si lo tiene otro, o la base ya está `lista` o `borrada`, este
 * flujo termina sin hacer nada.
 *
 * Los pasos sólo importan de los módulos de bases: nada de `node:fs` ni de
 * código de la app que arrastre otras dependencias al paquete del flujo.
 */
import { nombreDeBase } from "@/data/bases";
import { crearBaseSiFalta, darPermisos, marcarBase, migrarBase, tomarBase } from "@/server/bases/crear-base";
import { espejar } from "@/server/bases/espejo";

/** Minutos de lease: cubren los reintentos de todos los pasos juntos. */
const MINUTOS_DE_LEASE = 15;

/** Alcanza para decir qué falló y no arrastra el cuerpo de la fila, que los errores de drizzle traen después de la primera línea. */
const MAX_TEXTO_DE_ERROR = 200;

async function tomar(tenantId: string): Promise<boolean> {
  "use step";

  return (await tomarBase(tenantId, MINUTOS_DE_LEASE)) !== null;
}

async function crear(tenantId: string): Promise<void> {
  "use step";

  await crearBaseSiFalta(nombreDeBase(tenantId));
}

async function migrar(tenantId: string): Promise<number> {
  "use step";

  return migrarBase(nombreDeBase(tenantId));
}

async function permisos(tenantId: string): Promise<void> {
  "use step";

  await darPermisos(nombreDeBase(tenantId));
}

async function copiarEspejo(tenantId: string): Promise<void> {
  "use step";

  await espejar(tenantId);
}

async function marcarLista(tenantId: string, version: number): Promise<void> {
  "use step";

  await marcarBase(tenantId, "lista", { version });
}

async function marcarFallida(tenantId: string, error: string): Promise<void> {
  "use step";

  await marcarBase(tenantId, "fallida", { error });
}

function textoDelError(e: unknown): string {
  const mensaje = e instanceof Error ? e.message : String(e);
  return (mensaje.split("\n")[0] ?? "").slice(0, MAX_TEXTO_DE_ERROR);
}

/**
 * El orquestador. Sólo decide el orden: este cuerpo se vuelve a ejecutar desde
 * el principio en cada retoma, así que no puede tener efectos propios.
 *
 * Un paso que agota sus reintentos llega acá como excepción; la base queda
 * `fallida` con la primera línea del error, y la persona (o el barrido) la reintenta.
 */
export async function prepararBase(tenantId: string): Promise<void> {
  "use workflow";

  if (!(await tomar(tenantId))) return;

  try {
    await crear(tenantId);
    const version = await migrar(tenantId);
    await permisos(tenantId);
    await copiarEspejo(tenantId);
    await marcarLista(tenantId, version);
  } catch (e) {
    await marcarFallida(tenantId, textoDelError(e));
  }
}
