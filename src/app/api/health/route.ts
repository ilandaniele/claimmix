/**
 * GET /api/health — is the deployment that is actually running healthy?
 *
 * Every check we had ran on a laptop. That is enough to know the code is
 * right and says nothing about whether the thing serving real claimants can
 * reach anything, which is a different question with its own way of going
 * wrong: R2 was configured locally and working in every local run for hours
 * while production silently dropped every attachment, because the credentials
 * had never been added to Vercel. Nothing failed loudly. The bucket simply was
 * not there, and the only symptom was a claimant being asked twice for a photo.
 *
 * So this runs inside the deployment and reports what it can actually reach.
 * It is the check to run after a deploy, and the one to look at first when
 * something is behaving strangely in production.
 *
 * Auth: Bearer CRON_SECRET. It reveals which dependencies exist and how they
 * are configured — not secrets, but a map of the attack surface, and there is
 * no reason for it to be public.
 *
 * `?deep=1` additionally spends money: a real upload to R2 and a real call to
 * the model. The default checks configuration and connectivity only, so it is
 * free to call often.
 */

import { NextRequest, NextResponse } from "next/server";
import { isInternalRequest } from "@/lib/security/internal-auth";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import { db, tables } from "@/lib/db";
import { gmailAccounts } from "@/lib/db/schema";

import { getWatchExpiration } from "@/server/email/gmail/poll-state";
import { enTenant } from "@/data/scope";

const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
const UNA_HORA_MS = 60 * 60 * 1000;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Status = "ok" | "degraded" | "down";

interface Check {
  name: string;
  status: Status;
  detail: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Bearer CRON_SECRET requerido." } },
      { status: 401 }
    );
  }

  const deep = req.nextUrl.searchParams.get("deep") === "1";

  const checks = await Promise.all([
    checkDatabase(),
    checkDataLayer(),
    checkSchema(),
    checkStorage(deep),
    checkModel(deep),
    checkWhatsApp(),
    checkGmail(),
    checkAgentConfig(),
    checkPresupuesto(),
  ]);

  const worst: Status = checks.some((c) => c.status === "down")
    ? "down"
    : checks.some((c) => c.status === "degraded")
      ? "degraded"
      : "ok";

  return NextResponse.json(
    {
      status: worst,
      deep,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      environment: process.env.VERCEL_ENV ?? "local",
      checked_at: new Date().toISOString(),
      checks,
    },
    // 503 so anything watching a URL notices without parsing the body.
    { status: worst === "down" ? 503 : 200 }
  );
}

/*
 * La comparación sale de `isInternalRequest`: el mismo `timingSafeEqual`
 * contra `Bearer ${CRON_SECRET}`, escrito una sola vez. Acá el secreto
 * faltante da 401 igual que un header inválido, que es lo que ya hacía.
 */
function authorized(req: NextRequest): boolean {
  return isInternalRequest(req);
}

function ok(name: string, detail: string): Check {
  return { name, status: "ok", detail };
}
function degraded(name: string, detail: string): Check {
  return { name, status: "degraded", detail };
}
function down(name: string, detail: string): Check {
  return { name, status: "down", detail };
}

function why(err: unknown): string {
  // El `||` en vez de `??` no es un descuido. Los errores del driver de Neon
  // traen `code: ""` —la propiedad existe y está vacía— y `??` sólo atrapa
  // null o undefined, así que el chequeo salía "down" con el detalle en
  // blanco: la peor forma de fallar, porque avisa sin decir de qué.
  const codigo = (err as { code?: string })?.code;
  if (codigo) return codigo;
  return err instanceof Error ? err.message.slice(0, 120) : "error desconocido";
}

/**
 * The rows from a raw query.
 *
 * `db.execute` hands back the driver's result object, not an array — and code
 * that assumed an array got an empty list, which here meant reporting every
 * migration as missing on a database where all of them were applied.
 */
async function rowsOf<T>(query: SQL): Promise<T[]> {
  // sin-inquilino: Idem: el resultado crudo del driver, no filas de una tabla.
  const result = (await db.execute(query)) as unknown;
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

// ── The checks ───────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<Check> {
  try {
    // sin-inquilino: `select 1` — no toca ninguna tabla.
    await db.execute(sql`select 1`);
    return ok("base de datos", "responde");
  } catch (err) {
    return down("base de datos", why(err));
  }
}

/**
 * ¿La capa de datos puede consultar, con el rol restringido?
 *
 * `checkDatabase` de arriba usa el `db` del módulo, que entra con el rol dueño.
 * Que ése responda no dice nada sobre el que la aplicación usa de verdad: son
 * dos conexiones distintas, con dos credenciales distintas, y desde que la capa
 * existe **todas las consultas del producto pasan por la segunda**.
 *
 * El agujero que esto tapa es concreto. `DATABASE_URL_APP` vive en Vercel
 * marcada como sensible, así que su valor no se puede leer de vuelta ni
 * comparar con el que uno cree haber puesto: `vercel env pull` devuelve
 * `"[SENSITIVE]"`. Un carácter de más al pegarla no se descubre en ningún lado
 * — ni en la CI, que usa su propio secreto — hasta que un analista abre la
 * bandeja y no hay nada.
 *
 * Consulta con un inquilino que no existe, a propósito: el objetivo es que la
 * conexión y el contexto funcionen, no leer datos de nadie. Cero filas es el
 * resultado correcto.
 */
async function checkDataLayer(): Promise<Check> {
  try {
    await enTenant({ tenantId: "00000000-0000-0000-0000-000000000000" }, (dbApp) =>
      dbApp.select({ id: tables.cases.id }).from(tables.cases).limit(1)
    );
    return ok("capa de datos", "el rol restringido consulta y RLS responde");
  } catch (err) {
    const detalle = why(err);
    // Se mira el mensaje crudo y no `why(err)`: cuando el error trae código,
    // `why` devuelve el código y el texto que distingue una contraseña vieja
    // de cualquier otro fallo se pierde.
    const crudo = err instanceof Error ? err.message : String(err);
    if (/password authentication failed/i.test(crudo)) {
      return down("capa de datos", "DATABASE_URL_APP no autentica — contraseña vieja o mal pegada");
    }
    if (/falta DATABASE_URL_APP/i.test(crudo)) {
      return down("capa de datos", "falta DATABASE_URL_APP en el entorno");
    }
    return down("capa de datos", detalle);
  }
}

/**
 * Are the migrations actually applied to the database this deployment talks to?
 *
 * Deploys do not run migrations, so code that expects a column can ship days
 * before the column exists. The failure is quiet and specific: one feature
 * stops working while everything else looks fine.
 *
 * There IS a ledger now (schema_migrations), and this deliberately does not
 * read it. A ledger row says a migration was recorded, not that it ran:
 * `--baseline` writes rows without executing anything. That is not a theory —
 * 0010 sat in the ledger green for two days while `tenants` still had three
 * columns, tenant creation failed and /api/admin/billing answered 500. Asking
 * the schema is the only question whose answer cannot be a claim.
 *
 * The list is not every column: it is one from each migration whose absence
 * breaks something, INCLUDING the ones off the hot path. 0010 went unnoticed
 * precisely because billing is not what a claim arriving touches.
 */
async function checkSchema(): Promise<Check> {
  const required: Array<[string, string]> = [
    ["missing_docs", "declined_at"],
    ["outbound_messages", "asked_keys"],
    ["cases", "extraction_lease_at"],
    // 0010: sin esto no se puede dar de alta un cliente ni emitir una factura.
    ["tenants", "plan"],
    ["tenants", "monthly_fee_usd"],
  ];

  try {
    const rows = await rowsOf<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
    `);

    const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

    // 0017 crea una tabla entera; sin ella una factura cerrada se recalcula en
    // cada consulta, que es justo lo que la 0017 existe para impedir.
    const requiredTables = ["billing_invoices", "rate_limit_counters"];
    const tablesPresent = new Set(rows.map((r) => r.table_name));
    const missingTables = requiredTables.filter((t) => !tablesPresent.has(t));
    const missing = required
      .map(([t, c]) => `${t}.${c}`)
      .filter((key) => !present.has(key));

    const gaps = [...missing, ...missingTables];

    return gaps.length === 0
      ? ok("migraciones", "el esquema tiene lo que el código espera")
      : down("migraciones", `faltan: ${gaps.join(", ")}`);
  } catch (err) {
    return degraded("migraciones", `no se pudo verificar: ${why(err)}`);
  }
}

/**
 * Object storage.
 *
 * Configuration alone is not proof — the shallow check confirms the variables
 * reached this deployment, which is the failure that actually happened. `deep`
 * does the round trip that proves the credentials work and the bucket exists.
 */
async function checkStorage(deep: boolean): Promise<Check> {
  const configured = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    .filter((v) => !process.env[v]?.trim());

  if (configured.length > 0) {
    return down("almacenamiento", `sin configurar: ${configured.join(", ")}`);
  }
  if (!deep) return ok("almacenamiento", "configurado (sin probar; usá deep=1)");

  try {
    const { uploadAttachment, readAttachment, deleteAttachment } = await import(
      "@/server/storage/claim-attachments-bucket"
    );
    const data = Buffer.from(`health ${Date.now()}`);
    const uploaded = await uploadAttachment({
      tenantId: "health",
      caseId: "check",
      messageId: String(Date.now()),
      filename: "health.txt",
      contentType: "text/plain",
      data,
    });
    if ("error" in uploaded) return down("almacenamiento", `subida: ${uploaded.error}`);

    const read = await readAttachment(uploaded.storagePath);
    // Tidied up whether or not the read matched: this runs on every deploy,
    // and a bucket slowly filling with health-check scraps is our mess.
    await deleteAttachment(uploaded.storagePath);

    if (!read || !read.equals(data)) {
      return down("almacenamiento", "lo subido no volvió igual");
    }

    return ok("almacenamiento", "subida, lectura y borrado correctos");
  } catch (err) {
    return down("almacenamiento", why(err));
  }
}

/** The model. Shallow: are the credentials here. Deep: does it answer. */
async function checkModel(deep: boolean): Promise<Check> {
  const vertex = process.env.GEMINI_TRANSPORT === "vertex";
  const { modoDeCredenciales, tokenDeGcp } = await import("@/server/gcp/credenciales");
  const modo = modoDeCredenciales();
  const missing = vertex
    ? [
        !process.env.GOOGLE_CLOUD_PROJECT?.trim() && "GOOGLE_CLOUD_PROJECT",
        modo === "adc" && process.env.VERCEL && "GCP_* (OIDC) o GOOGLE_SERVICE_ACCOUNT_JSON",
      ].filter((v): v is string => !!v)
    : ["GEMINI_API_KEY"].filter((v) => !process.env[v]?.trim());

  if (missing.length > 0) {
    return down("modelo", `sin configurar: ${missing.join(", ")}`);
  }
  const credenciales = vertex ? ` · credenciales: ${modo}` : "";
  if (!deep) {
    return ok("modelo", `${vertex ? "vertex" : "ai studio"} configurado (sin probar)${credenciales}`);
  }

  try {
    if (vertex) await tokenDeGcp();
    const { callGemini } = await import("@/server/ai/gemini-extractor");
    const { text } = await callGemini(
      'Respondé exactamente {"ok": true} y nada más.',
      "ping"
    );
    return text ? ok("modelo", `responde${credenciales}`) : down("modelo", "respondió vacío");
  } catch (err) {
    return down("modelo", why(err));
  }
}

/**
 * WhatsApp.
 *
 * The access token is long-lived, not permanent, and when it lapses the
 * failure is silent from our side: the webhook keeps accepting messages, the
 * agent keeps deciding what to say, and every reply fails to send. Asking
 * Graph who we are costs nothing and catches it.
 */
async function checkWhatsApp(): Promise<Check> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneId) return degraded("whatsapp", "sin configurar");

  try {
    const version = process.env.WHATSAPP_API_VERSION?.trim() || "v21.0";
    const res = await fetch(
      `https://graph.facebook.com/${version}/${phoneId}` +
        `?fields=display_phone_number,quality_rating,messaging_limit_tier`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return down("whatsapp", `graph respondió ${res.status}`);

    const body = (await res.json()) as {
      display_phone_number?: string;
      quality_rating?: string;
      messaging_limit_tier?: string;
    };

    const number = body.display_phone_number ?? phoneId;
    const quality = body.quality_rating?.toUpperCase();

    // Meta downgrades a number quietly, by quality rating, before it ever
    // blocks it. RED means the account is one bad week from being unable to
    // reach anyone, and nothing else in the product would tell us.
    if (quality === "RED") {
      return down("whatsapp", `${number}: calidad EN ROJO, la cuenta está en riesgo`);
    }
    if (quality === "YELLOW") {
      return degraded("whatsapp", `${number}: calidad amarilla, vigilalo`);
    }

    const tier = body.messaging_limit_tier ? `, ${body.messaging_limit_tier}` : "";
    return ok("whatsapp", `${number} operativo${tier}`);
  } catch (err) {
    return down("whatsapp", why(err));
  }
}

/** Is a mailbox connected, and is its refresh token still good? */
async function checkGmail(): Promise<Check> {
  const tenantId = process.env.GMAIL_TENANT_ID?.trim();
  if (!tenantId) return degraded("gmail", "GMAIL_TENANT_ID sin configurar");

  try {
    // Through the schema rather than raw SQL: the first version of this asked
    // for `email_address` and `refresh_token`, neither of which is what the
    // columns are called, and reported "gmail no se pudo verificar" on a
    // perfectly healthy mailbox. A health check that cries wolf gets ignored,
    // which is worse than not having one.
    const rows = await enTenant({ tenantId }, (db) =>
      db
        .select({
          email: gmailAccounts.email,
          enabled: gmailAccounts.enabled,
          lastError: gmailAccounts.last_error,
          tokenEncrypted: gmailAccounts.refresh_token_encrypted,
          lastConnectedAt: gmailAccounts.last_connected_at,
        })
        .from(gmailAccounts)
        // La que trabaja, no una cualquiera.
        //
        // Esto pedía una fila del tenant sin filtrar y sin ordenar. Mientras
        // hubo una sola casilla dio igual; el día que se cambió la casilla de
        // entrada quedaron tres —dos apagadas y la que atiende— y Postgres
        // devolvió una apagada. Producción sana, salud en amarillo, y el aviso
        // apuntando a una casilla que se apagó a propósito.
        //
        // Es la falla contra la que advierte el comentario de acá arriba, dos
        // versiones después: un chequeo que grita sin motivo se deja de mirar.
        .where(and(eq(gmailAccounts.tenant_id, tenantId), eq(gmailAccounts.enabled, true)))
        .orderBy(asc(gmailAccounts.created_at))
        .limit(1)
    );

    const account = rows[0];
    if (!account) return degraded("gmail", "ninguna casilla activa");
    if (account.lastError) {
      return down("gmail", `${account.email}: ${String(account.lastError).slice(0, 80)}`);
    }

    // A row is not a working mailbox.
    //
    // This used to report "conectada" from the row's existence alone, which is
    // false comfort: the refresh token is stored encrypted, and if
    // GMAIL_TOKEN_ENCRYPTION_KEY is missing or has been rotated, the row still
    // looks perfect while nothing can read or send a single message. Trying
    // the decryption costs no network and turns a guess into a fact.
    if (!process.env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim()) {
      return down("gmail", "falta GMAIL_TOKEN_ENCRYPTION_KEY: el token no se puede descifrar");
    }

    try {
      const { decryptRefreshToken } = await import("@/server/email/gmail/accounts");
      const token = decryptRefreshToken(account.tokenEncrypted);
      if (!token) return down("gmail", `${account.email}: el token descifra vacío`);
    } catch {
      // Almost always the key changed and the stored token predates it.
      return down("gmail", `${account.email}: el token guardado no descifra con esta clave`);
    }

    // Un token legible tampoco es correo entrando rápido.
    //
    // El aviso de push (gmail.users.watch) cuelga del permiso de OAuth: al
    // reconectar la casilla, el permiso viejo se cae y el aviso con él. La fila
    // de gmail_poll_state, en cambio, se queda con el vencimiento anterior —a
    // siete días vista— así que el cron, que sólo renueva lo que ve por vencer,
    // no lo renueva. Todo se ve sano y el correo pasa a entrar por el cron en
    // vez de en segundos. Es una degradación invisible que dura una semana.
    //
    // No hay columna con la fecha de registro, pero se deduce: Gmail da siete
    // días exactos, así que el aviso se pidió en `watch_expiration - 7d`. Si la
    // casilla se conectó después de eso, el aviso es de un permiso que ya no
    // existe. Se compara con un margen de una hora para no gritar por el
    // segundo que separa la conexión del registro que la sigue.
    try {
      const expiration = await getWatchExpiration(account.email);
      if (!expiration) {
        return degraded(
          "gmail",
          `${account.email} conectada, pero sin aviso de push: el correo entra por el cron`
        );
      }
      const registrado = new Date(expiration).getTime() - SIETE_DIAS_MS;
      const conectado = account.lastConnectedAt
        ? new Date(account.lastConnectedAt).getTime()
        : 0;
      if (conectado - registrado > UNA_HORA_MS) {
        return degraded(
          "gmail",
          `${account.email} conectada, pero el aviso de push quedó del permiso anterior: ` +
            "el correo entra por el cron. Reconectá la casilla o pegale a /api/admin/setup-gmail-watch"
        );
      }
    } catch {
      // Que no se pueda leer el estado del aviso no invalida la casilla.
    }

    return ok("gmail", `${account.email} conectada, token legible, push al día`);
  } catch (err) {
    return degraded("gmail", `no se pudo verificar: ${why(err)}`);
  }
}

/**
 * Cuánto queda del presupuesto mensual de IA.
 *
 * Es el único límite que, al llegar, **frena las denuncias** — `checkBudget`
 * devuelve `exceeded` y el caso se queda esperando con un warn en los
 * registros como única señal. Nadie mira los registros hasta que algo se ve
 * roto, y esto no se ve roto: se ve quieto.
 *
 * Por eso avisa antes. A partir del 80% queda en `degraded`, que es el mismo
 * estado que usa WhatsApp para «calidad amarilla, vigilalo»: sale en el
 * `smoke` de cada despliegue sin voltear el chequeo. Sólo el 100% es `down`,
 * porque ahí ya dejó de procesar.
 *
 * Importa más ahora que la decisión es quedarse en los planes gratuitos: el
 * techo dejó de ser un número lejano y pasó a ser el modo de falla más
 * probable.
 *
 * Excluye al inquilino de la demo por el mismo motivo que `checkBudget`: ese
 * endpoint corre sin autenticación y su gasto no puede frenar una denuncia
 * real.
 */
async function checkPresupuesto(): Promise<Check> {
  const tope = Number.parseFloat(process.env.MONTHLY_BUDGET_USD ?? "") || 200;
  const demo = process.env.DEMO_TENANT_ID?.trim() || null;

  try {
    const inicio = new Date();
    inicio.setDate(1);
    inicio.setHours(0, 0, 0, 0);

    // sin-inquilino: el tope es del proyecto entero, no de una aseguradora.
    const filas = await rowsOf<{ total: number }>(
      demo
        ? sql`select coalesce(sum(cost_usd), 0)::float8 as total from ai_usage
               where created_at >= ${inicio.toISOString()} and tenant_id <> ${demo}`
        : sql`select coalesce(sum(cost_usd), 0)::float8 as total from ai_usage
               where created_at >= ${inicio.toISOString()}`
    );

    const gastado = Number(filas[0]?.total ?? 0);
    const parte = tope > 0 ? gastado / tope : 0;
    const cuanto = `US$${gastado.toFixed(2)} de US$${tope.toFixed(0)} (${Math.round(parte * 100)}%)`;

    if (parte >= 1) {
      return down("presupuesto", `${cuanto} — la extracción está frenada`);
    }
    if (parte >= 0.8) {
      return degraded("presupuesto", `${cuanto} — cerca del tope, vigilalo`);
    }
    return ok("presupuesto", cuanto);
  } catch (err) {
    return degraded("presupuesto", `no se pudo consultar: ${why(err)}`);
  }
}

/**
 * Which agent behaviours are switched on in this deployment.
 *
 * Not a failure either way — both have an off switch on purpose — but a
 * deployment quietly running with deliberation disabled behaves like the old
 * decision tree, and that is worth being able to see rather than deduce from
 * the messages.
 */
function checkAgentConfig(): Check {
  const deliberation = process.env.AGENT_DELIBERATION !== "off";
  const composing = process.env.AGENT_COMPOSE_REPLIES !== "off";

  const parts = [
    `deliberación ${deliberation ? "on" : "OFF"}`,
    `redacción ${composing ? "on" : "OFF"}`,
  ];

  return deliberation && composing
    ? ok("agente", parts.join(", "))
    : degraded("agente", parts.join(", "));
}
