/**
 * `pnpm padron` — clientes y pólizas, para poder mirar /clientes con gente adentro.
 *
 * `pnpm sembrar` deja lo que necesitan los tests de integración: cuentas y unos
 * casos. El padrón quedaba vacío, y una pantalla que nadie miró nunca con datos
 * adentro acumula defectos sin que nada falle. Cuando se sembró por primera vez
 * aparecieron seis de una: las vigencias corridas un día, la columna «Fecha» que
 * dibujaba una antigüedad, los tipos de siniestro crudos, el conteo que copiaba
 * el largo de la página, un uuid inválido que tiraba la pantalla, y un chip que
 * no se oscurecía. Ninguno lo agarraba un test.
 *
 * **No corre contra producción.** Exige una cadena de ensayo y se planta si es
 * la misma que `DATABASE_URL`, igual que `pnpm sembrar`. Sembrar clientes
 * inventados en la tabla donde viven los datos personales de gente real no es
 * un accidente que se pueda deshacer con un `delete`.
 *
 * Los ids son fijos, así que correrlo dos veces actualiza los mismos catorce en
 * vez de dejar veintiocho. Por lo mismo se borran todos de una:
 *
 *     delete from customers where id like 'c11e0000-0000-4000-8000-0000000000%';
 */
import * as dotenv from "dotenv";
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
 * Es la misma comprobación que hace `sembrar-para-integracion.mts`, y está por
 * la misma razón: un valor con comillas alrededor pasa desapercibido en local
 * —dotenv se las saca al leer el archivo— pero guardado como secreto en CI las
 * comillas viajan adentro del valor, y el driver contesta `TypeError: Invalid
 * URL` con quince líneas de node_modules y el valor enmascarado como `***`.
 */
try {
  new URL(destino.replace(/^postgres(ql)?:/, "https:"));
} catch {
  console.error("✗ La cadena de conexión no es una URL válida.");
  if (/^["']|["']$/.test(destino)) {
    console.error("  Tiene comillas alrededor. En `.env.local` dotenv se las saca sola,");
    console.error("  pero guardada como secreto viajan adentro del valor.");
  }
  process.exit(2);
}

/*
 * La única guarda que importa, y va sobre la identidad de la cadena y no sobre
 * el nombre del endpoint.
 *
 * Mientras esto fue un script descartable comprobaba que dijera
 * `ep-damp-meadow`. Para algo que queda en el repo eso es peor que inútil: el
 * día que la base de ensayo se mude, el script deja de correr por un motivo que
 * no tiene nada que ver con la seguridad, y alguien va a borrar la línea.
 */
if (produccion && destino === produccion) {
  console.error("✗ Esa es la cadena de PRODUCCIÓN.");
  console.error("  Este script escribe clientes inventados en la tabla de datos");
  console.error("  personales. En la base donde viven los reales, no se deshace.");
  process.exit(2);
}

const INQUILINO = "10000000-0000-0000-0000-000000000001"; // Seguros del Sur S.A.
const PREFIJO = "c11e0000-0000-4000-8000-0000000000";

/**
 * Catorce personas, elegidas para que la pantalla muestre sus casos raros y no
 * sólo el feliz: hay clientes sin DNI, sin correo y sin teléfono, que es donde
 * la tabla tiene que dibujar el guión y no un hueco.
 */
const GENTE = [
  { n: "01", nombre: "Roberto Paz",         dni: "20144873", tel: "+54 9 11 5512-8834", correo: "roberto.paz@example.com" },
  { n: "02", nombre: "Elena Duarte",        dni: "27903415", tel: "+54 9 11 4478-2210", correo: "elena.duarte@example.com" },
  { n: "03", nombre: "Marcos Ibáñez",       dni: "31220987", tel: "+54 9 341 655-4120", correo: "marcos.ibanez@example.com" },
  { n: "04", nombre: "Valeria Ocampo",      dni: "29881204", tel: "+54 9 11 6033-7745", correo: "valeria.ocampo@example.com" },
  { n: "05", nombre: "Julián Ferreyra",     dni: "34550218", tel: null,                 correo: "julian.ferreyra@example.com" },
  { n: "06", nombre: "Carla Bustamante",    dni: "26107733", tel: "+54 9 351 488-9012", correo: null },
  { n: "07", nombre: "Néstor Villalba",     dni: null,       tel: "+54 9 11 3390-6621", correo: "nestor.villalba@example.com" },
  { n: "08", nombre: "Silvina Mendieta",    dni: "30442891", tel: "+54 9 223 570-1188", correo: "silvina.mendieta@example.com" },
  { n: "09", nombre: "Gonzalo Arrieta",     dni: "25776340", tel: "+54 9 11 2244-9906", correo: "gonzalo.arrieta@example.com" },
  { n: "10", nombre: "Paula Quiroga",       dni: "33018562", tel: "+54 9 261 419-3377", correo: "paula.quiroga@example.com" },
  { n: "11", nombre: "Hernán Cardozo",      dni: "28660175", tel: "+54 9 11 7781-4453", correo: "hernan.cardozo@example.com" },
  { n: "12", nombre: "Mariana Leiva",       dni: "32195408", tel: null,                 correo: null },
  { n: "13", nombre: "Alejandro Sarmiento", dni: "24338719", tel: "+54 9 11 5008-2264", correo: "alejandro.sarmiento@example.com" },
  { n: "14", nombre: "Rocío Benítez",       dni: "35772093", tel: "+54 9 381 622-8140", correo: "rocio.benitez@example.com" },
] as const;

/** Una póliza por cliente, con los tres estados que la pantalla sabe pintar. */
const POLIZAS = [
  { n: "01", numero: "POL-4471-A", tipo: "auto",     estado: "active" },
  { n: "02", numero: "POL-9920-C", tipo: "auto",     estado: "active" },
  { n: "03", numero: "POL-1183-B", tipo: "home",     estado: "active" },
  { n: "04", numero: "POL-7752-D", tipo: "auto",     estado: "expired" },
  { n: "05", numero: "POL-3308-A", tipo: "life",     estado: "active" },
  { n: "06", numero: "POL-6614-F", tipo: "business", estado: "cancelled" },
  { n: "07", numero: "POL-2290-E", tipo: "auto",     estado: "active" },
  { n: "08", numero: "POL-8845-B", tipo: "home",     estado: "active" },
  { n: "09", numero: "POL-5527-C", tipo: "auto",     estado: "expired" },
  { n: "10", numero: "POL-1096-A", tipo: "auto",     estado: "active" },
  { n: "11", numero: "POL-4403-G", tipo: "other",    estado: "active" },
  { n: "12", numero: "POL-7719-D", tipo: "home",     estado: "active" },
  { n: "13", numero: "POL-3362-A", tipo: "auto",     estado: "active" },
  { n: "14", numero: "POL-9074-B", tipo: "life",     estado: "active" },
] as const;

const { Pool, neonConfig } = await import("@neondatabase/serverless");
neonConfig.webSocketConstructor = globalThis.WebSocket as never;
const pool = new Pool({ connectionString: destino });
const cx = await pool.connect();

console.log("═".repeat(66));
console.log("PADRÓN DE ENSAYO — clientes para mirar /clientes");
console.log(`base: ${destino.match(/ep-[a-z-]+-[a-z0-9]+/)?.[0]}`);
console.log("═".repeat(66));

try {
  await cx.query(
    `insert into tenants (id, name, created_at)
     values ($1, 'Seguros del Sur S.A.', now() - interval '30 days')
     on conflict (id) do nothing`,
    [INQUILINO]
  );

  for (const [i, p] of GENTE.entries()) {
    // Las altas escalonadas hacia atrás, para que la columna «Alta» no sea
    // catorce veces hoy.
    const dias = (GENTE.length - i) * 9 + 3;
    await cx.query(
      `insert into customers (id, tenant_id, full_name, dni, email, phone, address, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() - ($8 || ' days')::interval)
       on conflict (id) do update set
         full_name = excluded.full_name,
         dni       = excluded.dni,
         email     = excluded.email,
         phone     = excluded.phone,
         address   = excluded.address`,
      [
        `${PREFIJO}${p.n}`,
        INQUILINO,
        p.nombre,
        p.dni,
        p.correo,
        p.tel,
        p.dni ? `Av. Siempreviva ${1000 + i * 137}, CABA` : null,
        String(dias),
      ]
    );
  }
  console.log(`\n▸ Clientes\n   ✓ ${GENTE.length} en Seguros del Sur S.A.`);

  for (const [i, po] of POLIZAS.entries()) {
    /*
     * La vigencia tiene que decir lo mismo que el estado.
     *
     * Acá iba `now() - 35 days` para las catorce, sin mirar el estado, así que
     * las diez pólizas «activas» vencían hace más de un mes. Datos que se
     * contradicen solos no sirven para mirar una pantalla: uno no sabe si lo
     * que ve mal es el producto o el sembrado. Y es peor que inútil cuando la
     * pantalla y el agente calculan la vigencia distinto —la pantalla pinta
     * `status` pelado y `agent-tools` mira además `end_date`—, porque el
     * desacuerdo entre los dos queda tapado por el desacuerdo del dato consigo
     * mismo.
     *
     * Activa vence en el futuro; vencida y cancelada, en el pasado.
     */
    const finVigencia =
      po.estado === "active" ? "now() + interval '330 days'" : "now() - interval '35 days'";
    await cx.query(
      `insert into policies (id, tenant_id, customer_id, policy_number, policy_type, status,
                             start_date, end_date, premium_amount)
       values ($1, $2, $3, $4, $5, $6,
               (now() - interval '400 days')::date, (${finVigencia})::date, $7)
       on conflict (id) do update set
         policy_number = excluded.policy_number,
         policy_type   = excluded.policy_type,
         status        = excluded.status,
         end_date      = excluded.end_date`,
      [
        `901c0400-0000-4000-8000-0000000000${po.n}`,
        INQUILINO,
        `${PREFIJO}${po.n}`,
        po.numero,
        po.tipo,
        po.estado,
        (48000 + i * 7350).toFixed(2),
      ]
    );
  }
  console.log(`▸ Pólizas\n   ✓ ${POLIZAS.length} (activas, vencidas y canceladas)`);

  /*
   * Y los dos casos que ya existen quedan atados a su cliente.
   *
   * La pantalla de detalle lista los siniestros de la persona; sin esto la
   * sección está siempre vacía y no se ve para qué existe.
   */
  const atados = await cx.query(
    `update cases set customer_id = $1, policy_id = $2
     where id = 'e2e00000-0000-4000-8000-000000000001' and tenant_id = $3`,
    [`${PREFIJO}01`, "901c0400-0000-4000-8000-000000000001", INQUILINO]
  );
  const atados2 = await cx.query(
    `update cases set customer_id = $1, policy_id = $2
     where id = 'e2e00000-0000-4000-8000-000000000002' and tenant_id = $3`,
    [`${PREFIJO}02`, "901c0400-0000-4000-8000-000000000002", INQUILINO]
  );
  console.log(
    `▸ Siniestros\n   ✓ ${(atados.rowCount ?? 0) + (atados2.rowCount ?? 0)} atados a su cliente`
  );

  /*
   * Dos siniestros más para Roberto Paz, con los tipos que rompían la pantalla.
   *
   * `rc` y `robo_contenido` son los dos que se leían mal cuando la celda
   * dibujaba la clave pelada («Rc», «Robo_contenido»), y `null` es el que
   * dejaba la celda literalmente en blanco. Van en ids propios y no encima de
   * los casos e2e, que tienen tests que dependen de lo que dicen.
   */
  for (const [sufijo, tipo, estado] of [
    ["a1", "rc", "listo"],
    ["a2", null, "esperando"],
  ] as const) {
    await cx.query(
      `insert into cases (id, tenant_id, customer_id, policy_id, policyholder_name,
                          policy_number, claim_type, status, channel, created_at)
       values ($1, $2, $3, $4, 'Roberto Paz', 'POL-4471-A', $5, $6, 'email',
               now() - interval '3 days')
       on conflict (id) do update set claim_type = excluded.claim_type,
                                      status     = excluded.status`,
      [
        `ca50e000-0000-4000-8000-0000000000${sufijo === "a1" ? "a1" : "a2"}`,
        INQUILINO,
        `${PREFIJO}01`,
        "901c0400-0000-4000-8000-000000000001",
        tipo,
        estado,
      ]
    );
  }
  console.log(`▸ Tipos raros\n   ✓ un 'rc' y uno sin tipo, para Roberto Paz`);

  const { rows } = await cx.query(
    `select count(*)::int as n from customers where tenant_id = $1`,
    [INQUILINO]
  );
  console.log(`\n${"─".repeat(66)}`);
  console.log(`✓ El padrón de ensayo tiene ${rows[0].n} clientes.`);
  console.log(`  Para borrarlos: delete from customers where id like '${PREFIJO}%';`);
} finally {
  cx.release();
  await pool.end();
}
