/**
 * `pnpm sembrar` — deja una base lista para los tests de integración.
 *
 * Esos 204 tests hacen `fetch` contra un servidor HTTP y se autentican como un
 * analista de verdad. Nunca corrieron en CI porque faltaba lo tercero: un
 * usuario con contraseña.
 *
 * Parecía imposible, y no lo era. El alta pide dirección verificada —una
 * defensa deliberada, para que nadie se dé de alta como una dirección de la
 * lista blanca que todavía no se registró— pero eso gobierna la PROVISIÓN, no
 * la creación de la cuenta. La cuenta se crea igual; lo que no se crea es el
 * perfil que la ata a una aseguradora.
 *
 * Así que el camino es el mismo que usa un admin cuando da de alta a alguien:
 * crear la cuenta, y después escribir el perfil. Ni se debilita el alta ni se
 * inventa un atajo — se hace lo que ya hace el producto.
 *
 * (Ese camino estaba roto: la ruta del panel hacía UPDATE sobre una fila que no
 * existía y tocaba cero. Se arregló al escribir esto.)
 *
 * **No corre contra producción.** Exige que la cadena NO sea la de producción,
 * y se planta si lo es. Sembrar un usuario con contraseña conocida en la base
 * donde viven denuncias reales es exactamente lo que no hay que hacer.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const destino = process.env.SEED_DATABASE_URL?.trim() ?? process.env.STAGING_DATABASE_URL?.trim();
const produccion = process.env.DATABASE_URL?.trim();

if (!destino) {
  console.error("Falta SEED_DATABASE_URL (o STAGING_DATABASE_URL).");
  process.exit(2);
}
if (produccion && destino === produccion) {
  console.error("✗ Esa es la cadena de PRODUCCIÓN.");
  console.error("  Este script crea un usuario con contraseña conocida. En la base donde");
  console.error("  viven denuncias reales, eso es una puerta abierta con la llave puesta.");
  process.exit(2);
}

// La capa de datos y Better Auth leen del entorno; se apuntan al destino antes
// de importarlos.
process.env.DATABASE_URL = destino;
process.env.DATABASE_URL_APP = destino;
process.env.BETTER_AUTH_SECRET ??= "sembrado-".padEnd(40, "x");

const CORREO = process.env.INTEGRATION_TEST_EMAIL ?? "lucia@seguros-del-sur.com.ar";
const CLAVE = process.env.INTEGRATION_TEST_PASSWORD ?? "Analyst123!";
const INQUILINO = "10000000-0000-0000-0000-000000000001";

const { Pool, neonConfig } = await import("@neondatabase/serverless");
neonConfig.webSocketConstructor = globalThis.WebSocket as never;
const pool = new Pool({ connectionString: destino });
const cx = await pool.connect();

console.log("═".repeat(66));
console.log("SEMBRADO — una base con qué correr los tests de integración");
console.log("═".repeat(66));

try {
  // ── El inquilino ───────────────────────────────────────────────────────────
  await cx.query(
    `insert into tenants (id, name, created_at)
     values ($1, 'Seguros del Sur S.A.', now() - interval '30 days')
     on conflict (id) do nothing`,
    [INQUILINO]
  );
  console.log(`\n▸ Inquilino\n   ✓ Seguros del Sur S.A.`);

  // ── El usuario ─────────────────────────────────────────────────────────────
  console.log(`\n▸ Usuario de prueba`);
  const { rows: yaEsta } = await cx.query(`select id from "user" where email = $1`, [CORREO]);

  let id: string;
  if (yaEsta.length > 0) {
    id = yaEsta[0].id;
    console.log(`   · la cuenta ya existía (${id.slice(0, 8)})`);
  } else {
    const { auth } = await import("@/lib/auth");
    const r = await auth.api.signUpEmail({
      body: { name: "Lucía Fernández", email: CORREO, password: CLAVE },
      headers: new Headers(),
    });
    id = r.user.id;
    console.log(`   ✓ cuenta creada (${id.slice(0, 8)})`);
  }

  // El perfil, que es lo que el alta NO crea para quien no está en la lista.
  await cx.query(
    `insert into users (id, tenant_id, full_name, role)
     values ($1, $2, 'Lucía Fernández', 'analyst')
     on conflict (id) do update set tenant_id = excluded.tenant_id, role = excluded.role`,
    [id, INQUILINO]
  );
  const { rows: perfil } = await cx.query(
    `select tenant_id::text as t, role from users where id = $1`,
    [id]
  );
  if (perfil.length === 0) throw new Error("el perfil no quedó");
  console.log(`   ✓ perfil: ${perfil[0].role} en ${perfil[0].t.slice(0, 8)}`);

  // ── Un caso, para que los listados tengan qué devolver ─────────────────────
  const { rows: casos } = await cx.query(
    `select count(*)::int as n from cases where tenant_id = $1`,
    [INQUILINO]
  );
  if (casos[0].n === 0) {
    await cx.query(
      `insert into cases (tenant_id, policyholder_name, policy_number, claim_type, status, channel)
       values ($1, 'Roberto Paz', 'POL-4471-A', 'choque', 'recibido', 'email_sim')`,
      [INQUILINO]
    );
    console.log(`\n▸ Datos\n   ✓ un caso de ejemplo`);
  } else {
    console.log(`\n▸ Datos\n   · ya había ${casos[0].n} caso(s)`);
  }

  console.log(`\n${"─".repeat(66)}`);
  console.log("✓ Listo. Los tests de integración pueden correr contra esta base.");
  console.log(`  Usuario: ${CORREO}`);
} finally {
  cx.release();
  await pool.end();
}
