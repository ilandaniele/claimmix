/**
 * `node scripts/mirar-salud.mjs` — preguntarle a producción cómo está.
 *
 * Hasta ahora `/api/health` sólo se consultaba después de un deploy, desde
 * `pnpm smoke` y el pen test. Entre dos deploys, nadie. Y lo que este endpoint
 * sabe ver se rompe SOLO, sin que nadie suba código: el token de WhatsApp
 * vence, Meta le baja la calidad al número, el aviso de push de Gmail se cae al
 * reconectar la casilla, el presupuesto mensual de IA se acaba.
 *
 * Un martes se rompe y se descubre en el deploy siguiente, que puede ser el
 * jueves. Mientras tanto el webhook contesta 200, el agente decide qué
 * responder, y cada envío falla.
 *
 * Corre en el job `salud` de `barrer-trabados.yml`, que ya pasa seguido y ya
 * tiene la llave. Sin `?deep=1`: la versión de fondo sube un archivo a R2 y le
 * habla al modelo, y hacer eso noventa y seis veces por día se comería el mismo
 * presupuesto que el chequeo vigila.
 */
import { interpretarSalud } from "./lib/salud.mjs";

const BASE = (process.env.URL || "https://claimmix.vercel.app").replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET;

if (!SECRET) {
  console.log("::error::Falta el secreto CRON_SECRET del repositorio.");
  process.exitCode = 1;
}

/** Tres intentos: la red de un runner se corta sola, igual que en el barrido. */
async function consultar() {
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const res = await fetch(`${BASE}/api/health`, {
        headers: { Authorization: `Bearer ${SECRET}` },
        // La ruta declara maxDuration 60 y en frío se toma varios segundos: un
        // plazo más corto convertiría un arranque en frío en un rojo.
        signal: AbortSignal.timeout(70_000),
      });

      const texto = await res.text();
      let cuerpo = null;
      try {
        cuerpo = JSON.parse(texto);
      } catch {
        cuerpo = null;
      }

      if (res.status === 200 || res.status === 503 || res.status === 401) {
        return { codigo: res.status, cuerpo };
      }
      console.log(`intento ${intento}: HTTP ${res.status}`);
    } catch (err) {
      console.log(`intento ${intento}: ${err instanceof Error ? err.message : "error de red"}`);
    }
    if (intento < 3) await new Promise((r) => setTimeout(r, 10_000));
  }
  return { codigo: 0, cuerpo: null };
}

if (SECRET) {
  const { codigo, cuerpo } = await consultar();
  const lectura = interpretarSalud(codigo, cuerpo);

  for (const l of lectura.lineas) console.log(l);
  console.log(`\nsalud: ${lectura.estado}`);

  // `::warning::` y no `::error::` para lo degradado: anda, con una pata coja.
  // Ponerlo rojo cada quince minutos es la forma más rápida de que nadie mire
  // este workflow, que es justo el problema que vino a resolver.
  for (const a of lectura.avisos) console.log(`::warning::salud degradada — ${a}`);
  for (const e of lectura.errores) console.log(`::error::${e}`);

  // `exitCode` y no `exit()`: cortar con sockets abiertos revienta Node en
  // Windows con un assert de libuv.
  process.exitCode = lectura.errores.length > 0 ? 1 : 0;
}
