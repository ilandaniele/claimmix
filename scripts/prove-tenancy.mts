/**
 * `pnpm tenancy` — probar que la base separa a las aseguradoras, no el código.
 *
 * No mira migraciones ni código: le pregunta a la base. Las migraciones dicen
 * qué se pidió; `pg_class.relforcerowsecurity` y una consulta cruzada dicen qué
 * pasa. Esa distinción no es teórica: durante meses hubo 28 políticas escritas
 * y ninguna corría.
 *
 * Prueba, en orden de importancia:
 *
 *   1. El rol con el que se conecta la app, y si tiene BYPASSRLS. Un rol con
 *      BYPASSRLS ignora toda política: es el agujero más grande y el menos
 *      visible, porque no se ve en ninguna migración.
 *   2. Cobertura: cuántas tablas con tenant_id tienen RLS, FORCE y política.
 *   3. La prueba de verdad: con el contexto de una aseguradora, ¿se pueden ver
 *      filas de otra? Y sin contexto, ¿se ve algo?
 *   4. `tenants` y la función que da de alta (0048): cada aseguradora ve y
 *      toca sólo su fila, y sólo la configuración.
 *
 * No deja nada escrito. Lo único que intenta escribir va dentro de una
 * transacción que se deshace, y lo que se prueba con el rol dueño no corre en
 * la base viva. No borra, no cambia configuración.
 *
 * **Contra qué rol.** Por omisión audita `DATABASE_URL_APP`, que es el rol con
 * el que la aplicación consulta de verdad. Auditar `DATABASE_URL` no sirve:
 * `neondb_owner` es dueño de las tablas y tiene BYPASSRLS por diseño —corre las
 * migraciones—, así que este chequeo siempre daría rojo y el rojo no querría
 * decir nada. La pregunta "¿la base separa?" es sobre el rol restringido.
 *
 * **Los inquilinos se listan con DATABASE_URL.** `tenants` tiene RLS: con el
 * rol de la app y sin contexto no devuelve ninguna fila, así que de ahí no se
 * puede sacar con qué cruzar. DATABASE_URL tiene que apuntar al mismo
 * endpoint que el rol de la app; si no, esas pruebas quedan «sin probar».
 *
 * Uso:
 *   pnpm tenancy                    contra DATABASE_URL_APP
 *   pnpm tenancy --url "postgres://..."   contra una rama o un rol distinto
 *   pnpm tenancy --esperado-abierto       sale 0 aunque NO aísle (para medir
 *                                          el estado actual sin romper el CI)
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { randomUUID } from "node:crypto";

import { Pool, neonConfig } from "@neondatabase/serverless";
import { HOST_DE_PRODUCCION, hostDe, resumenDe, taparEnElLog } from "../tests/e2e/base-de-ensayo";

// Lo que se escapa sin atrapar sale con el mensaje crudo, que puede traer la
// cadena con la contraseña: al log va sólo el resumen.
process.on("uncaughtException", (e) => {
  console.error(`\n✗ Error sin atrapar (${resumenDe(e)}).`);
  process.exit(2);
});

// Node 22+ trae WebSocket nativo. Se usa el driver WebSocket y no el HTTP
// porque hace falta una transacción de verdad para poner el contexto y leer
// dentro de ella.
neonConfig.webSocketConstructor = globalThis.WebSocket as never;

const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const url = (
  urlArg >= 0
    ? args[urlArg + 1]
    : // El rol restringido primero. Se cae a DATABASE_URL sólo para que el
      // script siga sirviendo en una base que todavía no tiene rol propio.
      (process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL)
)?.trim();
const esperadoAbierto = args.includes("--esperado-abierto");

if (!url) {
  console.error("Falta DATABASE_URL_APP (o pasá --url).");
    process.exit(2);
}
if (urlArg < 0 && process.env.DATABASE_URL_APP === undefined) {
  console.warn("⚠ Falta DATABASE_URL_APP: se prueba con DATABASE_URL, que suele ser el rol dueño.");
  console.warn("  Si el chequeo del rol falla por BYPASSRLS, la causa es ésta y no la base.");
}

const titulo = (t: string) => console.log(`\n▸ ${t}`);
const bien = (t: string) => console.log(`   ✓ ${t}`);
const mal = (t: string) => console.log(`   ✗ ${t}`);
const nota = (t: string) => console.log(`     ${t}`);

const pool = new Pool({ connectionString: url });

// El rol dueño sólo sirve si es la MISMA base: otro endpoint listaría inquilinos
// que el rol de la app no tiene. `-pooler` es el mismo endpoint por otra puerta.
const urlDueno = process.env.DATABASE_URL?.trim();
const endpointDe = (cadena: string) => hostDe(cadena).replace("-pooler", "");
const poolDueno = urlDueno && endpointDe(urlDueno) === endpointDe(url) ? new Pool({ connectionString: urlDueno }) : null;
const problemas: string[] = [];
// Separado a propósito de `problemas`: «no se pudo probar» no es lo mismo que
// «falló». Meterlos en la misma bolsa hace que el chequeo anuncie «la base no
// separa» cuando en realidad todo lo verificable pasó y lo que faltaron fueron
// datos con qué cruzar. Esa confusión es la que convierte un chequeo en ruido,
// y un chequeo que se vuelve ruido se deja de mirar.
const sinProbar: string[] = [];

try {
  const cx = await pool.connect();
  try {
    console.log("═".repeat(70));
    console.log("TENENCIA — ¿separa la base, o sólo el código?");
    console.log("═".repeat(70));

    // Una transacción con el inquilino puesto, siempre deshecha.
    const enContexto = async <T,>(tenant: string, hacer: () => Promise<T>): Promise<T> => {
      await cx.query("BEGIN");
      try {
        await cx.query("SELECT set_config('claimmix.tenant_id', $1, true)", [tenant]);
        return await hacer();
      } finally {
        await cx.query("ROLLBACK");
      }
    };

    // Lo mismo sin poner ningún inquilino.
    const sinContexto = async <T,>(hacer: () => Promise<T>): Promise<T> => {
      await cx.query("BEGIN");
      try {
        return await hacer();
      } finally {
        await cx.query("ROLLBACK");
      }
    };

    // ── 1. El rol ───────────────────────────────────────────────────────────
    titulo("El rol con el que se conecta la aplicación");
    const rol = (
      await cx.query(`
        SELECT current_user::text AS nombre, rolbypassrls, rolsuper
        FROM pg_roles WHERE rolname = current_user`)
    ).rows[0];

    if (rol.rolbypassrls || rol.rolsuper) {
      mal(`${rol.nombre} — ${rol.rolsuper ? "SUPERUSER" : "BYPASSRLS"}`);
      nota("Este rol pasa por encima de toda política de seguridad, siempre.");
      nota("Mientras la app se conecte así, el RLS es decorativo.");
      problemas.push("el rol de la aplicación saltea RLS");
    } else {
      bien(`${rol.nombre} — sin BYPASSRLS, sin SUPERUSER`);
    }

    // ── 2. Cobertura ────────────────────────────────────────────────────────
    titulo("Cobertura sobre las tablas con datos de aseguradoras");
    const cob = (
      await cx.query(`
        SELECT c.relname::text AS tabla,
               c.relrowsecurity  AS rls,
               c.relforcerowsecurity AS forzado,
               (SELECT count(*) FROM pg_policies p
                 WHERE p.schemaname='public' AND p.tablename=c.relname)::int AS politicas
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema='public' AND col.table_name=c.relname
                         AND col.column_name='tenant_id')
        ORDER BY c.relname`)
    ).rows;

    const sinRls = cob.filter((t) => !t.rls).map((t) => t.tabla);
    const sinForce = cob.filter((t) => !t.forzado).map((t) => t.tabla);
    const sinPol = cob.filter((t) => t.politicas === 0).map((t) => t.tabla);

    console.log(`   ${cob.length} tablas con tenant_id`);
    if (sinRls.length) {
      mal(`${sinRls.length} sin RLS: ${sinRls.slice(0, 4).join(", ")}${sinRls.length > 4 ? "…" : ""}`);
      problemas.push(`${sinRls.length} tablas sin RLS`);
    } else bien("todas con RLS activado");

    if (sinForce.length) {
      mal(`${sinForce.length} sin FORCE: el dueño de la tabla las ve enteras`);
      nota(sinForce.slice(0, 4).join(", ") + (sinForce.length > 4 ? "…" : ""));
      problemas.push(`${sinForce.length} tablas sin FORCE RLS`);
    } else bien("todas con FORCE RLS");

    if (sinPol.length) {
      mal(`${sinPol.length} sin política: ${sinPol.join(", ")}`);
      problemas.push(`${sinPol.length} tablas sin política`);
    } else bien("todas con política");

    // ── 2b. Las reglas globales se leen, no se tocan (0033) ─────────────────
    titulo("known_claim_patterns: una política por comando");
    const politicas = (
      await cx.query(`
        SELECT cmd::text, qual FROM pg_policies
        WHERE schemaname='public' AND tablename='known_claim_patterns' ORDER BY cmd`)
    ).rows as { cmd: string; qual: string | null }[];
    const porComando = politicas.map((r) => r.cmd);
    if (porComando.includes("ALL")) {
      mal("todavía hay una política FOR ALL: un inquilino puede borrar una regla global");
      problemas.push("known_claim_patterns con política FOR ALL");
    } else if (["DELETE", "INSERT", "SELECT", "UPDATE"].some((c) => !porComando.includes(c))) {
      mal(`faltan comandos: hay ${porComando.join(", ") || "ninguna"}`);
      problemas.push("known_claim_patterns sin las cuatro políticas");
    } else if (
      politicas.some((r) => ["UPDATE", "DELETE"].includes(r.cmd) && /IS NULL/i.test(r.qual ?? ""))
    ) {
      mal("UPDATE o DELETE alcanza filas globales");
      problemas.push("known_claim_patterns: escritura sobre lo global");
    } else bien("SELECT ve lo global; INSERT, UPDATE y DELETE sólo lo propio");

    // ── 2c. La conversación del asistente es de quien la escribió (0043) ───
    titulo("asistente_turnos: la lectura y la escritura piden usuario, no sólo inquilino");
    const turnos = (
      await cx.query(`
        SELECT cmd::text, qual, with_check FROM pg_policies
        WHERE schemaname='public' AND tablename='asistente_turnos' ORDER BY cmd`)
    ).rows as { cmd: string; qual: string | null; with_check: string | null }[];
    if (turnos.length === 0) {
      nota("La tabla todavía no existe en esta base (falta la 0043). Se salta.");
    } else {
      const pideUsuario = (cmd: string) =>
        turnos.some((r) => r.cmd === cmd && /claimmix_current_user_id/.test(`${r.qual ?? ""}${r.with_check ?? ""}`));
      const sinUsuario = ["SELECT", "INSERT"].filter((c) => !pideUsuario(c));
      if (turnos.some((r) => r.cmd === "ALL" || r.cmd === "UPDATE" || r.cmd === "DELETE")) {
        mal("hay una política que permite reescribir o borrar turnos");
        problemas.push("asistente_turnos con política de UPDATE o DELETE");
      } else if (sinUsuario.length) {
        mal(`${sinUsuario.join(" y ")} no piden usuario: otra persona del mismo inquilino leería la conversación`);
        problemas.push("asistente_turnos legible por otro usuario del inquilino");
      } else bien("SELECT e INSERT piden inquilino y usuario; no hay política de UPDATE ni DELETE");
    }

    // ── 3. La prueba de verdad ──────────────────────────────────────────────
    titulo("La prueba cruzada: dos aseguradoras, una consulta");

    async function listarInquilinos(): Promise<Array<{ id: string; name: string }> | null> {
      if (!poolDueno) return null;
      const d = await poolDueno.connect();
      try {
        const salta = (
          await d.query(`SELECT (rolbypassrls OR rolsuper) AS salta FROM pg_roles WHERE rolname = current_user`)
        ).rows[0]?.salta;
        if (!salta) return null;
        // Sin el inquilino efímero del pen test (`--pared-propia`): corre al mismo
        // tiempo contra la misma base, o quedó sin borrar, y no tiene filas en
        // ninguna tabla. Elegido como segundo, la prueba sale "no concluyente".
        return (
          await d.query(
            `SELECT id::text AS id, name FROM tenants WHERE name NOT LIKE 'pentest-pared-%' ORDER BY created_at LIMIT 2`
          )
        ).rows.map(
          (t: { id: string; name: string }) => ({ ...t, name: t.name?.replace(/[\r\n]+/g, " ") })
        );
      } finally {
        d.release();
      }
    }

    // Con qué tabla se cruza.
    //
    // `cases` es la que más significa, pero sólo sirve si dos inquilinos tienen
    // casos. En producción hay uno solo con casos, y entonces "no vi nada
    // ajeno" no prueba nada. Antes de resignarse a un "no concluyente" —o peor,
    // de escribir datos falsos en producción para que la prueba pase— se busca
    // alguna tabla que YA tenga filas de más de un inquilino.
    //
    // Esto se hace con el rol que esté probándose. Si ese rol obedece RLS y no
    // hay contexto puesto, no verá nada y el recuento dará uno: por eso la
    // búsqueda corre con el contexto de cada inquilino, más abajo.
    //
    // La lista de inquilinos, en cambio, va con el rol dueño: `tenants` tiene RLS
    // desde la 0048 y, sin contexto, el rol de la app ya no ve ni una fila.
    const inquilinos = await listarInquilinos();
    // En CI los nombres de los inquilinos se tapan en el log del job, por si el
    // ensayo se siembra algún día desde datos reales.
    taparEnElLog((inquilinos ?? []).map((t) => t.name));

    if (inquilinos === null) {
      mal("no se pudo listar los inquilinos: falta DATABASE_URL con el rol dueño, en el mismo endpoint");
      nota("Con el rol de la app, sin contexto, `tenants` no devuelve nada: no hay con qué cruzar.");
      sinProbar.push("la prueba cruzada y la de tenants: DATABASE_URL no está o apunta a otro endpoint");
    } else if (inquilinos.length < 2) {
      nota("Hay menos de dos inquilinos: no se puede cruzar nada. Se salta.");
    } else {
      const [a, b] = inquilinos;

      const cuantasDe = (tabla: string, tenant: string) =>
        enContexto(tenant, async () => {
          const r = await cx.query(
            `SELECT count(*)::int AS n FROM "${tabla}" WHERE tenant_id = $1`,
            [tenant]
          );
          return r.rows[0].n as number;
        });

      // Elegir la tabla con la que cruzar.
      //
      // `cases` es la que más significa, pero en producción hay un solo
      // inquilino con casos y entonces "no vi nada ajeno" no prueba nada. Antes
      // de resignarse a un "no concluyente" —o de escribir datos falsos en
      // producción para que la prueba pase, que sería mucho peor— se busca una
      // tabla que YA tenga filas de los dos.
      let tabla = "cases";
      let hayAjenas = await cuantasDe(tabla, b.id);

      if (hayAjenas === 0) {
        const candidatas = (
          await cx.query(`
            SELECT c.table_name::text AS t
            FROM information_schema.columns c
            JOIN information_schema.tables tb
              ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
            WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
              AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'cases'
            ORDER BY 1`)
        ).rows as Array<{ t: string }>;

        for (const { t } of candidatas) {
          try {
            const n = await cuantasDe(t, b.id);
            if (n > 0) {
              tabla = t;
              hayAjenas = n;
              nota(`\`cases\` no alcanza (el otro inquilino no tiene): se cruza con \`${t}\``);
              break;
            }
          } catch {
            // Una tabla sin permiso o con forma rara no invalida la prueba.
          }
        }
      }

      const verConContexto = (ctx: string) =>
        enContexto(ctx, async () => {
          const r = await cx.query(
            `SELECT tenant_id::text AS t, count(*)::int AS n
             FROM "${tabla}" GROUP BY tenant_id`
          );
          return r.rows as Array<{ t: string; n: number }>;
        });

      // El recuento de lo ajeno va con el contexto puesto Y filtrando por
      // dueño. El filtro no sobra: si el rol saltea RLS, la consulta sin filtro
      // devuelve todo, y el recuento informaría cientos de filas "ajenas" que
      // en realidad son las propias vistas de más — un dato falso justo en el
      // escenario que este chequeo existe para denunciar.
      const desdeA = await verConContexto(a.id);
      const ajenas = desdeA.filter((f) => f.t !== a.id);
      const propias = desdeA.find((f) => f.t === a.id)?.n ?? 0;

      console.log(`   con el contexto de "${a.name}" sobre \`${tabla}\`:`);
      nota(`propias: ${propias} fila(s)`);
      if (ajenas.length) {
        mal(`ajenas: ${ajenas.reduce((s, f) => s + f.n, 0)} fila(s) de ${ajenas.length} inquilino(s) más`);
        nota(`"${b.name}" es visible desde "${a.name}". Esto es la fuga.`);
        problemas.push("una aseguradora puede ver los datos de otra");
      } else if (hayAjenas === 0) {
        mal("no concluyente: ninguna tabla tiene filas de un segundo inquilino");
        nota("No ver nada ajeno no prueba aislamiento si no hay nada ajeno que ver.");
        sinProbar.push("la prueba cruzada: falta un segundo inquilino con datos");
      } else {
        bien(`ajenas: 0 de ${hayAjenas} que existen — la base no las entrega`);
      }

      // Sin contexto: no debería verse nada.
      await cx.query("BEGIN");
      const sinCtx = await cx.query(`SELECT count(*)::int AS n FROM "${tabla}"`);
      await cx.query("ROLLBACK");
      const n = sinCtx.rows[0].n as number;
      if (n > 0) {
        mal(`sin contexto se ven ${n} fila(s) de \`${tabla}\``);
        nota("Una consulta que olvida poner el contexto devuelve datos de todos.");
        problemas.push("sin contexto se ven casos de todos");
      } else {
        bien(`sin contexto: 0 filas — olvidarse el contexto no filtra nada`);
      }
    }

    // ── 4. tenants y la función de alta (0048) ──────────────────────────────
    //
    // Todo con el rol de la app y dentro de una transacción que se deshace.
    // Las escrituras que NO deben pasar se arman de modo que, si pasaran, no
    // toquen ninguna fila. La función se prueba hasta donde la lleva ese rol: con
    // un id distinto del contexto tira 42501, y con un usuario que no existe
    // contesta 'no_verificado' sin insertar nada. Que el rol de la app pueda
    // ejecutarla lo mira `pnpm permisos`.
    titulo("tenants: cada aseguradora ve y toca sólo lo suyo");

    if (!inquilinos?.length) {
      nota("No hay inquilinos que listar. Se salta.");
    } else {
      const [a, b] = inquilinos;

      const nSinCtx = await sinContexto(
        async () => (await cx.query(`SELECT count(*)::int AS n FROM tenants`)).rows[0].n as number
      );
      if (nSinCtx > 0) {
        mal(`sin contexto se ven ${nSinCtx} inquilino(s)`);
        problemas.push("sin contexto se ven los inquilinos");
      } else bien("sin contexto: 0 inquilinos");

      const vistos = await enContexto(a.id, async () =>
        (await cx.query(`SELECT id::text AS id FROM tenants`)).rows.map((r: { id: string }) => r.id)
      );
      if (!vistos.includes(a.id)) {
        mal("con su contexto la aplicación no ve su propio inquilino");
        problemas.push("la política de tenants deja afuera al propio inquilino");
      } else if (vistos.some((id) => id !== a.id)) {
        mal(`con su contexto se ven ${vistos.length} inquilinos, no uno`);
        problemas.push("una aseguradora ve la fila de otra en tenants");
      } else if (b) {
        bien("con su contexto: sólo la propia");
      } else {
        bien("con su contexto: la propia (hay un solo inquilino: lo ajeno no se puede demostrar)");
      }

      const LLAMADA = `SELECT public.claimmix_crear_inquilino($1::uuid, $2::uuid, 'Empresa de prueba'::text, '+5491100000000'::text, 30, $3::integer) AS r`;

      // Una sentencia, en el contexto de `tenant`, con lo que contestó la base.
      const intentar = (tenant: string, sentencia: string, params: unknown[] = []) =>
        enContexto(tenant, async () => {
          try {
            const r = await cx.query(sentencia, params);
            return { ok: true as const, filas: r.rowCount ?? 0, devuelve: r.rows as Array<Record<string, unknown>> };
          } catch (e) {
            return { ok: false as const, codigo: (e as { code?: string }).code ?? "?" };
          }
        });

      const denegado = async (que: string, motivo: string, tenant: string, sentencia: string, params: unknown[] = []) => {
        const r = await intentar(tenant, sentencia, params);
        if (!r.ok && r.codigo === "42501") bien(`${que}: denegado (42501)`);
        else {
          mal(`${que}: ${r.ok ? "la base lo dejó pasar" : `falló con ${r.codigo}, no con 42501`}`);
          problemas.push(motivo);
        }
      };

      await denegado(
        "cambiar el plan",
        "la app puede cambiar el plan de un inquilino",
        a.id,
        `UPDATE tenants SET plan = plan WHERE id = $1`,
        [a.id]
      );
      await denegado(
        "crear un inquilino con INSERT",
        "la app puede insertar en tenants",
        a.id,
        `INSERT INTO tenants (name) SELECT 'Prueba de tenencia' WHERE false`
      );

      const config = await intentar(
        a.id,
        `UPDATE tenants SET recordatorio_horas = recordatorio_horas WHERE id = $1`,
        [a.id]
      );
      if (config.ok && config.filas === 1) bien("editar su configuración: permitido");
      else {
        mal(`editar su configuración: ${config.ok ? `tocó ${config.filas} fila(s)` : `falló con ${config.codigo}`}`);
        problemas.push("la app no puede editar la configuración de su propio inquilino");
      }

      if (b) {
        const ajena = await intentar(
          a.id,
          `UPDATE tenants SET recordatorio_horas = recordatorio_horas WHERE id = $1`,
          [b.id]
        );
        if (ajena.ok && ajena.filas === 0) bien("editar la configuración de otro: 0 filas");
        else {
          mal(`editar la configuración de otro: ${ajena.ok ? `tocó ${ajena.filas} fila(s)` : `falló con ${ajena.codigo}`}`);
          problemas.push("una aseguradora puede editar la configuración de otra");
        }
      }

      // Con un id que no es el del contexto, la función se niega antes de leer nada.
      const ajeno = await intentar(a.id, LLAMADA, [randomUUID(), randomUUID(), 10]);
      const sinFuncion = !ajeno.ok && ajeno.codigo === "42883";
      if (sinFuncion) {
        mal("claimmix_crear_inquilino no existe: falta aplicar la 0048");
        problemas.push("la 0048 no está aplicada en esta base");
      } else if (!ajeno.ok && ajeno.codigo === "42501") {
        bien("la función con un id distinto del contexto: denegado (42501)");
      } else {
        mal(`la función con un id distinto del contexto: ${ajeno.ok ? "creó algo o contestó" : `falló con ${ajeno.codigo}`}`);
        problemas.push("claimmix_crear_inquilino acepta un id que no es el del contexto");
      }

      const nuevo = randomUUID();
      const sinVerificar = await intentar(nuevo, LLAMADA, [nuevo, randomUUID(), 10]);
      const resultado = sinVerificar.ok ? (sinVerificar.devuelve[0]?.r as { resultado?: string } | undefined)?.resultado : null;
      if (resultado === "no_verificado") {
        bien("la función con un usuario que no existe: 'no_verificado'");
      } else if (!sinFuncion) {
        mal("la función con un usuario que no existe no contestó 'no_verificado'");
        problemas.push("claimmix_crear_inquilino no exige un usuario verificado");
      }

      // 'alta_cerrada' necesita un usuario verificado y el rol de la app no puede
      // crearlo: va con el rol dueño, en una transacción que se deshace, y nunca
      // en la base viva. Con el tope en 0 corta antes de insertar nada.
      if (!poolDueno) {
        nota("'alta_cerrada' no se prueba: falta DATABASE_URL con el rol dueño.");
      } else if (hostDe(urlDueno ?? "").includes(HOST_DE_PRODUCCION)) {
        nota("'alta_cerrada' no se prueba en la base viva, ni siquiera con ROLLBACK: va contra QA o el ensayo.");
      } else {
        const d = await poolDueno.connect();
        try {
          const usuario = randomUUID();
          const inquilino = randomUUID();
          await d.query("BEGIN");
          try {
            await d.query(
              `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Prueba de tenencia', $2, true)`,
              [usuario, `tenencia-${usuario}@example.com`]
            );
            await d.query("SELECT set_config('claimmix.tenant_id', $1, true)", [inquilino]);
            const r = (await d.query(LLAMADA, [inquilino, usuario, 0])).rows[0].r as { resultado?: string };
            const creados = (await d.query(`SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [inquilino])).rows[0]
              .n as number;
            if (r.resultado === "alta_cerrada" && creados === 0) bien("con el tope en 0: 'alta_cerrada' y no se crea nada");
            else {
              mal(`con el tope en 0 contestó '${r.resultado}' y quedaron ${creados} inquilino(s)`);
              problemas.push("claimmix_crear_inquilino ignora el tope diario");
            }
          } catch (e) {
            if ((e as { code?: string }).code === "42883") {
              mal("claimmix_crear_inquilino no existe: falta aplicar la 0048");
              problemas.push("la 0048 no está aplicada en esta base");
            } else throw e;
          } finally {
            await d.query("ROLLBACK");
          }
        } finally {
          d.release();
        }
      }
    }
  } finally {
    cx.release();
  }
} catch (e) {
  console.error(`\n✗ no se pudo verificar (${resumenDe(e)})`);
  await pool.end();
  await poolDueno?.end();
  process.exit(2);
}

await pool.end();
await poolDueno?.end();

// ── Veredicto ───────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(70));
if (problemas.length === 0 && sinProbar.length === 0) {
  console.log("✓ La base separa a las aseguradoras por sí misma.");
  console.log("  Un WHERE olvidado deja de ser una fuga.");
  process.exit(0);
}

if (problemas.length === 0) {
  console.log("⚠ Todo lo verificable pasó, pero algo no se pudo probar:");
  for (const p of sinProbar) console.log(`   · ${p}`);
  console.log("");
  console.log("  El rol no saltea RLS, las tablas tienen FORCE y política, y sin");
  console.log("  contexto no se ve nada. Lo que falta no es una defensa: son datos");
  console.log("  con qué demostrarla.");
  console.log("");
  console.log("  Sale con 3 y no con 0: un chequeo que no probó lo que dice probar");
  console.log("  no debería pasar por verde.");
  process.exit(esperadoAbierto ? 0 : 3);
}

console.log(`✗ La base NO separa. ${problemas.length} motivo(s):`);
for (const p of problemas) console.log(`   · ${p}`);
console.log("");
console.log("  Hoy lo único que separa son los filtros escritos a mano en el");
console.log("  código. Funcionan hasta que alguien escriba una consulta sin uno.");

if (esperadoAbierto) {
  console.log("\n  (--esperado-abierto: se sale con 0 igual, esto es una medición)");
  process.exit(0);
}
process.exit(1);
