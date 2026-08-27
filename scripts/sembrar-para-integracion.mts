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
/*
 * Que la cadena sea una cadena, antes de dársela al driver.
 *
 * Un valor con comillas alrededor —`"postgresql://…"`— pasa desapercibido en
 * local, porque dotenv se las saca al leer el archivo. Guardado como secreto en
 * CI, en cambio, las comillas van adentro del valor, y el driver responde
 * `TypeError: Invalid URL` con una pila de quince líneas de node_modules y el
 * valor enmascarado como `***`. O sea: el mensaje no dice ni qué variable era
 * ni qué tenía de malo.
 *
 * Pasó exactamente eso al configurar los secretos del ensayo.
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

/*
 * La cuenta con rol `admin`, que es la mitad que faltaba.
 *
 * Catorce tests e2e se saltean sin ella, y no son cualquiera: son los que
 * comprueban que el login funcione y que un analista NO vea lo que ve un
 * admin. Playwright los saltea con un mensaje claro, así que no era un verde
 * mentiroso — pero catorce tests de separación de roles que nunca corren son
 * catorce tests que no existen.
 *
 * La contraseña NO tiene valor por omisión, a diferencia de la del analista.
 * Ésa arrastra `Analyst123!` desde antes y se queda por compatibilidad; poner
 * un default para la de admin sería escribir la contraseña de una cuenta
 * administradora en un repositorio público. Sin la variable, esto se planta:
 * es preferible a crear en silencio una cuenta cuya clave no coincide con la
 * que guardó CI, que se descubre como catorce tests que siguen sin correr.
 */
const ADMIN_CORREO = process.env.INTEGRATION_ADMIN_EMAIL ?? "mariela@seguros-del-sur.com.ar";
const ADMIN_CLAVE = process.env.INTEGRATION_ADMIN_PASSWORD;

/*
 * Una segunda cuenta de analista, sólo para los tests que prueban el login.
 *
 * El login tiene límite de tráfico —cinco intentos cada diez segundos por IP y
 * correo— y es una defensa que no se toca. Pero eso significa que los tests que
 * se loguean de verdad comparten cupo con todo lo demás que se loguea, y nueve
 * inicios de sesión seguidos lo agotan: los e2e fallaban con «Demasiados
 * intentos» y parecía que el login estaba roto.
 *
 * El resto de los tests ya no se loguea —reusa una sesión guardada— y estos
 * cuatro, que no pueden, tienen su propio correo y por lo tanto su propio cupo.
 * Se arregla el ensayo sin aflojarle al producto.
 */
const LOGIN_CORREO = process.env.INTEGRATION_LOGIN_EMAIL ?? "sofia@seguros-del-sur.com.ar";
const LOGIN_CLAVE = process.env.INTEGRATION_LOGIN_PASSWORD ?? CLAVE;

/*
 * Los dos casos que piden los e2e de la conversación, con id fijo.
 *
 * Fijo y no aleatorio porque el id viaja como secreto de CI: si cambiara en
 * cada sembrado, el secreto quedaría viejo y los tests volverían a saltearse.
 *
 * Uno con mensajes y otro sin ninguno, que es la distinción que prueban: que
 * la pantalla de conversación muestre lo que hay y no se rompa cuando no hay
 * nada.
 */
const CASO_CON_MENSAJES = "e2e00000-0000-4000-8000-000000000001";
const CASO_SIN_MENSAJES = "e2e00000-0000-4000-8000-000000000002";

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

  // ── Las cuentas ────────────────────────────────────────────────────────────
  /**
   * Crea la cuenta si no está, y le escribe el perfil siempre.
   *
   * Son dos pasos porque el producto los tiene separados a propósito: el alta
   * crea la cuenta para cualquiera, y el perfil —lo que la ata a una aseguradora
   * y le da un rol— sólo lo escribe un admin. Es el mismo camino que usa el
   * panel; no se debilita el alta ni se inventa un atajo.
   */
  async function alta(correo: string, clave: string, nombre: string, rol: string) {
    const { rows: yaEsta } = await cx.query(`select id from "user" where email = $1`, [correo]);

    let id: string;
    if (yaEsta.length > 0) {
      id = yaEsta[0].id;
      console.log(`   · ${rol}: la cuenta ya existía (${id.slice(0, 8)})`);

      /*
       * Y se le pone la contraseña que pide quien sembró, aunque ya exista.
       *
       * Sin esto el sembrado no es idempotente en lo único que importa. La
       * cuenta del analista ya estaba de un sembrado anterior, así que el alta
       * la salteaba y su contraseña seguía siendo la vieja — mientras el secreto
       * de CI guardaba la nueva. El síntoma no es un error: es que los tests se
       * siguen salteando, o peor, fallan en el login y parece que el login está
       * roto.
       *
       * Es una base de ensayo y estas cuentas existen para esto. Pisar la
       * contraseña es lo correcto acá y sería inaceptable en cualquier otro lado,
       * y por eso el script se planta si la cadena es la de producción.
       */
      const { auth } = await import("@/lib/auth");
      const ctx = await auth.$context;
      await ctx.internalAdapter.updatePassword(id, await ctx.password.hash(clave));
      console.log(`   ✓ ${rol}: contraseña puesta al día`);
    } else {
      const { auth } = await import("@/lib/auth");
      const r = await auth.api.signUpEmail({
        body: { name: nombre, email: correo, password: clave },
        headers: new Headers(),
      });
      id = r.user.id;
      console.log(`   ✓ ${rol}: cuenta creada (${id.slice(0, 8)})`);
    }

    await cx.query(
      `insert into users (id, tenant_id, full_name, role)
       values ($1, $2, $3, $4)
       on conflict (id) do update set tenant_id = excluded.tenant_id, role = excluded.role`,
      [id, INQUILINO, nombre, rol]
    );
    const { rows: perfil } = await cx.query(
      `select tenant_id::text as t, role from users where id = $1`,
      [id]
    );
    if (perfil.length === 0) throw new Error(`el perfil de ${correo} no quedó`);
    console.log(`   ✓ ${rol}: perfil en ${perfil[0].t.slice(0, 8)}`);
  }

  console.log(``);
  console.log("▸ Cuentas de prueba");
  await alta(CORREO, CLAVE, "Lucía Fernández", "analyst");

  if (!ADMIN_CLAVE) {
    console.error("");
    console.error("✗ Falta INTEGRATION_ADMIN_PASSWORD.");
    console.error("  Sin ella no se crea la cuenta admin, y los catorce e2e de");
    console.error("  separación de roles se siguen salteando. No hay valor por omisión");
    console.error("  a propósito: sería la contraseña de una cuenta administradora");
    console.error("  escrita en un repositorio público.");
    process.exit(2);
  }
  await alta(ADMIN_CORREO, ADMIN_CLAVE, "Mariela Sosa", "admin");
  await alta(LOGIN_CORREO, LOGIN_CLAVE, "Sofía Bianchi", "analyst");

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

  // ── Los dos casos que piden los e2e de la conversación ─────────────────────
  //
  // Uno con mensajes y otro sin ninguno. La distinción es la que prueban: que
  // la pantalla muestre la conversación cuando la hay, y que no se rompa cuando
  // no hay nada. Un caso vacío es el estado de todo siniestro recién entrado,
  // así que es el que más se ve y el que menos se prueba.
  for (const [id, quien, poliza] of [
    [CASO_CON_MENSAJES, "Roberto Paz", "POL-4471-A"],
    [CASO_SIN_MENSAJES, "Elena Duarte", "POL-9920-C"],
  ] as const) {
    await cx.query(
      `insert into cases (id, tenant_id, policyholder_name, policy_number, claim_type, status, channel)
       values ($1, $2, $3, $4, 'choque', 'recibido', 'email')
       on conflict (id) do update set policyholder_name = excluded.policyholder_name`,
      [id, INQUILINO, quien, poliza]
    );
  }

  // El mensaje entrante del primero. `on conflict` sobre un id fijo, para que
  // sembrar dos veces no deje dos copias de la misma conversación.
  await cx.query(
    `insert into claim_messages
       (id, tenant_id, case_id, direction, status, provider, from_addr, subject, body_text, received_at)
     values ($1, $2, $3, 'inbound', 'received', 'gmail',
             'roberto.paz@example.com', 'Choque en Alem al 2300',
             'Buenas, choqué ayer a la tarde en Alem al 2300. Soy Roberto Paz.', now())
     on conflict (id) do nothing`,
    ["e2e00000-0000-4000-8000-00000000000a", INQUILINO, CASO_CON_MENSAJES]
  );

  const { rows: cuenta } = await cx.query(
    `select count(*)::int as n from claim_messages where case_id = $1`,
    [CASO_CON_MENSAJES]
  );
  console.log(``);
  // ── El estado de la casilla, para la pantalla de configuracion ─────────────
  //
  // La seccion «Bandeja de entrada Gmail» solo se dibuja si hay algo que
  // contar: sin una fila aca, la ruta devuelve el vacio y el componente no
  // pinta nada. El e2e que comprueba que un admin la ve —y que un analista NO—
  // necesita entonces que la casilla exista.
  //
  // Es una direccion `example.com`, reservada: no le pertenece a nadie y el
  // despachador se niega a escribirle.
  await cx.query(
    `insert into gmail_poll_state (id, gmail_account_email, last_polled_at, last_error)
     values ($1, 'intake.ensayo@example.com', now(), null)
     on conflict (id) do update set last_polled_at = now(), last_error = null`,
    ["e2e00000-0000-4000-8000-0000000000b0"]
  );

  console.log("▸ Casos para los e2e");
  console.log(`   ✓ con mensajes: ${CASO_CON_MENSAJES}  (${cuenta[0].n})`);
  console.log(`   ✓ sin mensajes: ${CASO_SIN_MENSAJES}`);

  console.log(`\n${"─".repeat(66)}`);
  console.log("✓ Listo. Los tests de integración pueden correr contra esta base.");
  console.log(`  Usuario: ${CORREO}`);
  console.log(`  Admin:   ${ADMIN_CORREO}`);
  console.log(``);
  console.log("  Para que los e2e de login y roles dejen de saltearse, estos ocho");
  console.log("  valores van como secretos del repositorio:");
  console.log(`    PLAYWRIGHT_TEST_EMAIL      ${CORREO}`);
  console.log("    PLAYWRIGHT_TEST_PASSWORD   (la de INTEGRATION_TEST_PASSWORD)");
  console.log(`    PLAYWRIGHT_ANALYST_EMAIL   ${LOGIN_CORREO}`);
  console.log("    PLAYWRIGHT_ANALYST_PASSWORD(la de INTEGRATION_LOGIN_PASSWORD)");
  console.log(`    PLAYWRIGHT_ADMIN_EMAIL     ${ADMIN_CORREO}`);
  console.log("    PLAYWRIGHT_ADMIN_PASSWORD  (la de INTEGRATION_ADMIN_PASSWORD)");
  console.log(`    PLAYWRIGHT_EMAIL_CASE_ID   ${CASO_CON_MENSAJES}`);
  console.log(`    PLAYWRIGHT_EMPTY_CASE_ID   ${CASO_SIN_MENSAJES}`);
} finally {
  cx.release();
  await pool.end();
}
