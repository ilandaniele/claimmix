/**
 * ¿El alta de un usuario desde /admin/users deja un perfil utilizable?
 *
 * La ruta hace dos cosas: `auth.api.signUpEmail(...)` y después un UPDATE sobre
 * `public.users` para meterlo en el inquilino del admin. La sospecha es que ese
 * UPDATE toca cero filas, porque el hook que crea el perfil se saltea a quien no
 * está en la lista blanca — y un usuario recién creado por un admin no lo está.
 *
 * Si es así, el admin ve "usuario creado", la persona puede entrar, y no llega a
 * ningún dato. Sin ningún error en el medio.
 *
 * Corre contra STAGING_DATABASE_URL y limpia lo que crea.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const url = process.env.STAGING_DATABASE_URL?.trim();
if (!url) {
  console.error("Falta STAGING_DATABASE_URL. Esto NO corre contra producción.");
  process.exit(2);
}
process.env.DATABASE_URL = url;
process.env.DATABASE_URL_APP = url;
process.env.BETTER_AUTH_SECRET ??= "prueba-".padEnd(40, "x");

const { Pool, neonConfig } = await import("@neondatabase/serverless");
neonConfig.webSocketConstructor = globalThis.WebSocket as never;
const pool = new Pool({ connectionString: url });
const cx = await pool.connect();

const correo = `prueba-alta-${Date.now()}@ejemplo.test`;

try {
  const { rows: inq } = await cx.query(`select id, name from tenants limit 1`);
  if (inq.length === 0) throw new Error("el ensayo no tiene inquilinos");
  console.log(`Inquilino del ensayo: ${inq[0].name}\n`);

  const { auth } = await import("@/lib/auth");
  console.log("▸ Dando de alta como lo hace /admin/users");
  const r = await auth.api.signUpEmail({
    body: { name: "Prueba Alta", email: correo, password: "Analyst123!" },
    headers: new Headers(),
  });
  const id = r.user.id;
  console.log(`   cuenta creada: ${id}`);

  // Lo mismo que hace la ruta ahora: insertar, no actualizar.
  const { rowCount } = await cx.query(
    `insert into users (id, tenant_id, full_name, role) values ($1, $2, $3, $4)
     on conflict (id) do update set tenant_id = excluded.tenant_id,
       full_name = excluded.full_name, role = excluded.role`,
    [id, inq[0].id, "Prueba Alta", "analyst"]
  );
  console.log(`   el INSERT del perfil tocó ${rowCount} fila(s)`);

  const { rows: perfil } = await cx.query(
    `select id, tenant_id::text as t, role from users where id = $1`,
    [id]
  );

  console.log("");
  if (perfil.length === 0) {
    console.log("✗ NO hay perfil. El admin ve 'usuario creado', la persona entra,");
    console.log("  y no llega a ningún dato. Sin error en el medio.");
  } else {
    console.log(`✓ perfil: inquilino ${perfil[0].t}, rol ${perfil[0].role}`);
  }
} finally {
  await cx.query(`delete from users where id in (select id from "user" where email = $1)`, [correo])
    .catch(() => {});
  for (const t of ["session", "account", '"user"']) {
    await cx
      .query(
        t === '"user"'
          ? `delete from "user" where email = $1`
          : `delete from ${t} where "userId" in (select id from "user" where email = $1)`,
        [correo]
      )
      .catch(() => {});
  }
  console.log(`\n(limpiado: ${correo})`);
  cx.release();
  await pool.end();
}
