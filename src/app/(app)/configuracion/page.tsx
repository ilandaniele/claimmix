/**
 * Configuración page — W7 / AC18 supplemental pages.
 *
 * Sections:
 *   1. Cuenta: analyst name, email (read-only), role badge
 *   2. Cambiar contraseña: Better Auth password form
 *   3. Umbrales de la IA: confidence threshold + monthly budget cap (read-only for non-admin)
 *   4. Info del sistema: app version, Node version (server env), region
 *
 * Server Component fetches user data; ConfiguracionClient handles the
 * password change form (requires interactivity).
 */

import { redirect } from "next/navigation";

import { getSessionContext } from "@/lib/auth/session";
import { getUserRow } from "@/lib/auth/user-row";
import { ConfiguracionClient } from "./ConfiguracionClient";
import { GmailAccountsPanel } from "./GmailAccountsPanel";
import { UserAiKeyPanel } from "./UserAiKeyPanel";
import { AlertasPanel } from "./AlertasPanel";
import { GoogleVinculo } from "./GoogleVinculo";
import { getUserGeminiKey } from "@/server/ai/provider";
import { getT } from "@/lib/i18n";
import { ETIQUETA_DE_ROL } from "@/lib/i18n/etiqueta-de-rol";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import packageJson from "../../../../package.json";
import { ADMIN_ROLES } from "@/lib/auth/require-role";
import { CoreSyncPanel } from "./CoreSyncPanel";
import { paraAdmin } from "./para-admin";

// ── Role badge ────────────────────────────────────────────────────────────────

const ROLE_STYLES: Record<string, string> = {
  analyst: "bg-blue-100 text-blue-800",
  admin: "bg-red-100 text-red-800",
};

function RoleBadge({ role, label }: { role: string; label: string }) {
  const styles = ROLE_STYLES[role] ?? "bg-slate-100 text-slate-800";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}
    >
      {label}
    </span>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-1.5">
      <span className="w-44 flex-none text-xs text-slate-500">{label}</span>
      <div className="text-sm text-slate-800">{children}</div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function ConfiguracionPage({
  searchParams,
}: {
  searchParams: Promise<{ vinculo?: string }>;
}) {
  const { vinculo } = await searchParams;
  const locale = await getAccountLocale();
  const t = getT(locale);

  const session = await getSessionContext();
  if (!session?.user) redirect("/login");

  // Deduplicada con la del layout: ver lib/auth/user-row.ts.
  const userRow = await getUserRow(session.user.id);

  const fullName: string = userRow?.full_name ?? session.user.email ?? t("layout.nombreFallback");
  const role: string = userRow?.role ?? "analyst";
  // Quién ve los detalles de infraestructura de más abajo.
  const esAdmin = (ADMIN_ROLES as string[]).includes(role);
  const email: string = session.user.email ?? "—";

  const [userHasGeminiKey, admin] = await Promise.all([
    getUserGeminiKey(session.user.id).then(Boolean, () => false),
    esAdmin && userRow ? paraAdmin(userRow.tenant_id) : null,
  ]);

  // AI thresholds — read from env with documented defaults
  const confidenceThreshold = Number(
    process.env.CONFIDENCE_THRESHOLD ?? "0.70"
  );
  const monthlyBudgetCap = 200; // $200/month — hardcoded default per spec

  // System info
  const appVersion = packageJson.version;
  const nodeVersion = process.version; // e.g. "v22.0.0"
  const region = process.env.VERCEL_REGION ?? "local";

  return (
    <div className="px-6 py-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-slate-900">{t("configuracion.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("configuracion.subtitle")}</p>
      </div>

      <div className="space-y-6">
        {/* ── Cuenta ────────────────────────────────────────────────────────── */}
        <Section title={t("configuracion.cuenta")}>
          <div className="divide-y divide-slate-50">
            <Field label={t("usuarios.col.nombre")}>
              <span className="font-medium">{fullName}</span>
            </Field>
            <Field label={t("field.email")}>
              <span className="text-slate-600">{email}</span>
            </Field>
            <Field label={t("usuarios.col.rol")}>
              <RoleBadge role={role} label={ETIQUETA_DE_ROL[role] ? t(ETIQUETA_DE_ROL[role]) : role} />
            </Field>
          </div>
        </Section>

        {/* ── Cambiar contraseña ────────────────────────────────────────────── */}
        <Section title={t("password.boton")}>
          <ConfiguracionClient />
        </Section>

        {/* ── Umbrales de la IA ─────────────────────────────────────────────── */}
        <Section title={t("google.titulo")}>
          <GoogleVinculo aviso={vinculo} />
        </Section>

        <Section title={t("configuracion.umbrales")}>
          <div className="divide-y divide-slate-50">
            <Field label={t("configuracion.umbralConfianza")}>
              {esAdmin ? (
                <span className="font-mono text-sm font-medium text-slate-800">
                  {confidenceThreshold.toFixed(2)}
                  <span className="ml-2 text-xs text-slate-500">
                    {t("configuracion.umbralAyuda")}
                  </span>
                </span>
              ) : (
                <span className="font-mono text-sm text-slate-700">
                  {confidenceThreshold.toFixed(2)}
                </span>
              )}
            </Field>
            <Field label={t("configuracion.capMensual")}>
              {esAdmin ? (
                <span className="font-mono text-sm font-medium text-slate-800">
                  USD {monthlyBudgetCap}
                  <span className="ml-2 text-xs text-slate-500">
                    {t("configuracion.capAyuda")}
                  </span>
                </span>
              ) : (
                <span className="font-mono text-sm text-slate-700">
                  USD {monthlyBudgetCap}
                </span>
              )}
            </Field>
          </div>
          {!esAdmin && (
            <p className="mt-3 text-xs text-slate-500">
              {t("configuracion.soloAdmins")}
            </p>
          )}
        </Section>

        {/* ── Modelo de IA (admin only) ─────────────────────────────────────── */}

        {/* ── Mi API Key de Gemini (todos los usuarios) ─────────────────────── */}
        <Section title={t("configuracion.miClave")}>
          <UserAiKeyPanel initialHasKey={userHasGeminiKey} />
        </Section>

        {/* ── Bandeja de entrada Gmail (todos los usuarios) ───────────────── */}
        <Section title={t("gmail.accounts.title")}>
          <GmailAccountsPanel />
        </Section>

        {/* ── Avisos de casos urgentes (E10, sólo admin) ────────────────────── */}
        {admin && (
          <Section title={t("configuracion.alertas.titulo")}>
            <AlertasPanel inicial={admin.alertas} horasIniciales={admin.recordatorioHoras} />
          </Section>
        )}

        {/* ── Entrega al sistema central (B5, sólo admin) ───────────────────── */}
        {admin && admin.core !== undefined && (
          <Section title={t("configuracion.core.titulo")}>
            <CoreSyncPanel inicial={admin.core} migracionPendiente={admin.migracionPendiente} />
          </Section>
        )}

        {/* ── Consola de entrenamiento del agente (reglas) ──────────────────── */}

        {/* ── Info del sistema ───────────────────────────────────────────────── */}
        <Section title={t("configuracion.sistema")}>
          <div className="divide-y divide-slate-50">
            <Field label={t("configuracion.version")}>
              <span className="font-mono text-xs text-slate-700">
                v{appVersion}
              </span>
            </Field>
            {/*
              * La versión de Node y la región, sólo para quien administra.
              *
              * A un analista no le sirven para nada, y a alguien de afuera que
              * consiguió una sesión le sirven bastante: la versión exacta del
              * runtime dice qué vulnerabilidades conocidas aplican, y la región
              * dice dónde está lo que hay que atacar. Es la sección
              * «Infrastructure Details» del manual, y la regla es la misma que
              * el resto del producto ya sigue: mostrar lo que la persona
              * necesita para su trabajo.
              *
              * La versión de la app queda para todos: sirve para reportar un
              * problema y no dice nada del servidor.
              */}
            {esAdmin && (
              <>
                <Field label={t("configuracion.node")}>
                  <span className="font-mono text-xs text-slate-700">
                    {nodeVersion}
                  </span>
                </Field>
                <Field label={t("configuracion.region")}>
                  <span className="font-mono text-xs text-slate-700">{region}</span>
                </Field>
              </>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
