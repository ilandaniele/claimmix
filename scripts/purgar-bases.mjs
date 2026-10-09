/**
 * purgar-bases.mjs — borrar las bases de clientes que ya no se usan.
 *
 *   node scripts/purgar-bases.mjs --env prd                              # lista las candidatas, con su tamaño
 *   node scripts/purgar-bases.mjs --env prd --tenant <uuid> --apply      # borra esa base
 *   node scripts/purgar-bases.mjs --env prd --tenant <a> --tenant <b> --apply
 *
 * Una base es candidata si su fila de tenant_bases está `fallida` o `borrada`, o si
 * el inquilino está sin servicio (`suspended` o `churned`, como `SIN_SERVICIO` de
 * src/lib/billing/plans.ts). Ser candidata no autoriza nada: con `--apply` sólo se
 * toca lo que se pida con `--tenant`, y el uuid tiene que estar en la lista.
 *
 * Borrar es `DROP DATABASE … WITH (FORCE)`: corta las conexiones abiertas y no se
 * deshace. Después la fila queda `borrada`. Se puede repetir sobre una base que
 * ya no está. Se niega si otro proceso tiene la base tomada (lease vigente de
 * tenant_bases) y si la conexión no es TCP: `DROP DATABASE` no corre dentro de
 * una transacción, y el camino HTTPS de Neon las envuelve todas.
 *
 * Las cadenas vienen de `entorno-de-bases.mjs`: prd sólo de `.env.prd.local`.
 */
import { connect } from "./lib/db-driver.mjs";
import { cadenasDelEntorno, nombreDeBaseDe, UUID } from "./lib/entorno-de-bases.mjs";

const AMBIENTE = (() => {
  const i = process.argv.indexOf("--env");
  return i === -1 ? null : (process.argv[i + 1] ?? "");
})();
const APLICAR = process.argv.includes("--apply");
const PEDIDOS = process.argv.flatMap((a, i) => (a === "--tenant" ? [process.argv[i + 1] ?? ""] : []));

function parar(mensaje) {
  console.error(`✖ ${mensaje}`);
  process.exit(1);
}

for (const id of PEDIDOS) {
  if (!UUID.test(id)) parar(`--tenant espera un uuid en minúscula (recibí "${id}")`);
}
if (APLICAR && PEDIDOS.length === 0) parar("--apply necesita al menos un --tenant: no se borra nada que no se haya nombrado.");

let dueno;
try {
  ({ dueno } = cadenasDelEntorno(AMBIENTE));
} catch (e) {
  parar(e.message);
}

const mb = (bytes) => `${(Number(bytes) / 1048576).toFixed(1)} MB`;

const c = await connect(dueno);
try {
  const { rows: hayTabla } = await c.query(`select to_regclass('public.tenant_bases') as t`);
  if (hayTabla[0].t == null) parar("control no tiene tenant_bases: la 0050 no está aplicada.");

  const { rows: candidatas } = await c.query(`
    select b.tenant_id::text as tenant_id, b.estado, t.billing_status,
           d.oid is not null as existe,
           coalesce(pg_database_size(d.oid), 0) as bytes,
           coalesce(b.tomada_at > now() - interval '15 minutes', false) as tomada
    from public.tenant_bases b
    left join public.tenants t on t.id = b.tenant_id
    left join pg_database d on d.datname = 't_' || replace(b.tenant_id::text, '-', '')
    where b.estado in ('fallida', 'borrada') or t.billing_status in ('suspended', 'churned')
    order by b.creada_at
  `);

  console.log(`▸ ${AMBIENTE}: ${candidatas.length} candidata(s)`);
  for (const f of candidatas) {
    const motivo = f.estado === "lista" || f.estado === "creando" ? `${f.billing_status} (sin servicio)` : f.estado;
    console.log(`   ${nombreDeBaseDe(f.tenant_id)}  ${motivo}  ${f.existe ? mb(f.bytes) : "no existe"}${f.tomada ? "  TOMADA" : ""}`);
  }

  if (!APLICAR) {
    console.log("\nNada borrado. Para borrar: --tenant <uuid> --apply");
    process.exit(0);
  }

  if (c.kind !== "tcp") parar("DROP DATABASE necesita la conexión TCP (puerto 5432), y ahora va por HTTPS.");

  let fallas = 0;
  for (const id of PEDIDOS) {
    const fila = candidatas.find((f) => f.tenant_id === id);
    if (!fila) {
      fallas++;
      console.error(`✖ ${id} no es candidata: su fila no está fallida ni borrada y el inquilino no está sin servicio.`);
      continue;
    }
    if (fila.tomada) {
      fallas++;
      console.error(`✖ ${id} está tomada por otro proceso (lease vigente): esperá a que termine.`);
      continue;
    }
    const base = nombreDeBaseDe(id);
    try {
      await c.query(`DROP DATABASE IF EXISTS "${base}" WITH (FORCE)`);
      await c.query(
        `update public.tenant_bases set estado = 'borrada', tomada_at = null, ultimo_error = null where tenant_id = $1::uuid`,
        [id],
      );
      console.log(`✔ ${base} borrada (${fila.existe ? mb(fila.bytes) : "ya no existía"})`);
    } catch (e) {
      fallas++;
      console.error(`✖ ${base}: ${e.message.split("\n")[0]}`);
    }
  }
  if (fallas > 0) process.exitCode = 1;
} finally {
  await c.end();
}
