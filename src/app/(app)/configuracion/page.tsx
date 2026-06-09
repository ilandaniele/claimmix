/**
 * Configuración page — W7 / AC18 supplemental pages.
 *
 * Sections:
 *   1. Cuenta: analyst name, email (read-only), role badge
 *   2. Cambiar contraseña: form that calls Supabase updateUser
 *   3. Umbrales de IA: confidence threshold + monthly budget cap (read-only for non-admin)
 *   4. Información del sistema: app version, Node version (server env), region
 *
 * Server Component fetches user data; ConfiguracionClient handles the
 * password change form (requires interactivity).
 */

import { createServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { ConfiguracionClient } from "./ConfiguracionClient";
import { GmailStatusSection } from "./GmailStatusSection";
import { GmailAccountsPanel } from "./GmailAccountsPanel";
import { AgentTrainingPanel } from "./AgentTrainingPanel";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import packageJson from "../../../../package.json";

// ── Role badge ────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  analyst: "Analista",
  admin: "Administrador",
};

const ROLE_STYLES: Record<string, string> = {
  analyst: "bg-blue-100 text-blue-800",
  admin: "bg-red-100 text-red-800",
};

function RoleBadge({ role }: { role: string }) {
  const label = ROLE_LABELS[role] ?? role;
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

export default async function ConfiguracionPage() {
  const locale = await getServerLocale();
  const t = getT(locale);
  const supabase = await createServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (!user || authErr) {
    redirect("/login");
  }

  // Fetch public.users row for full_name + role
   
  const { data: userRow } = await (supabase as any)
    .from("users")
    .select("full_name, role")
    .eq("id", user.id)
    .single();

  const fullName: string = userRow?.full_name ?? user?.email ?? "Analista";
  const role: string = userRow?.role ?? "analyst";
  const email: string = user.email ?? "—";
  const isAdmin = role === "admin";

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
        <h1 className="text-xl font-semibold text-slate-900">Configuración</h1>
        <p className="mt-1 text-sm text-slate-500">
          Preferencias de cuenta y parámetros del sistema
        </p>
      </div>

      <div className="space-y-6">
        {/* ── Cuenta ────────────────────────────────────────────────────────── */}
        <Section title="Cuenta">
          <div className="divide-y divide-slate-50">
            <Field label="Nombre">
              <span className="font-medium">{fullName}</span>
            </Field>
            <Field label="Correo electrónico">
              <span className="text-slate-600">{email}</span>
            </Field>
            <Field label="Rol">
              <RoleBadge role={role} />
            </Field>
          </div>
        </Section>

        {/* ── Cambiar contraseña ────────────────────────────────────────────── */}
        <Section title="Cambiar contraseña">
          <ConfiguracionClient />
        </Section>

        {/* ── Umbrales de IA ────────────────────────────────────────────────── */}
        <Section title="Umbrales de IA">
          <div className="divide-y divide-slate-50">
            <Field label="Umbral de confianza">
              {isAdmin ? (
                <span className="font-mono text-sm font-medium text-slate-800">
                  {confidenceThreshold.toFixed(2)}
                  <span className="ml-2 text-xs text-slate-400">
                    (ajustable vía variable CONFIDENCE_THRESHOLD)
                  </span>
                </span>
              ) : (
                <span className="font-mono text-sm text-slate-700">
                  {confidenceThreshold.toFixed(2)}
                </span>
              )}
            </Field>
            <Field label="Cap mensual de IA">
              {isAdmin ? (
                <span className="font-mono text-sm font-medium text-slate-800">
                  USD {monthlyBudgetCap}
                  <span className="ml-2 text-xs text-slate-400">
                    (configurado en el plan de despliegue)
                  </span>
                </span>
              ) : (
                <span className="font-mono text-sm text-slate-700">
                  USD {monthlyBudgetCap}
                </span>
              )}
            </Field>
          </div>
          {!isAdmin && (
            <p className="mt-3 text-xs text-slate-400">
              Solo los administradores pueden modificar los umbrales de IA.
            </p>
          )}
        </Section>

        {/* ── Bandeja de entrada Gmail (admin only) ────────────────────────── */}
        {isAdmin && (
          <Section title={t("gmail.accounts.title")}>
            <GmailAccountsPanel />
          </Section>
        )}

        {isAdmin && (
          <Section title={t("gmail.status.title")}>
            <GmailStatusSection />
          </Section>
        )}

        {isAdmin && (
          <Section title={t("configuracion.agentTraining.title")}>
            <AgentTrainingPanel />
          </Section>
        )}

        {/* ── Información del sistema ───────────────────────────────────────── */}
        <Section title="Información del sistema">
          <div className="divide-y divide-slate-50">
            <Field label="Versión de la app">
              <span className="font-mono text-xs text-slate-700">
                v{appVersion}
              </span>
            </Field>
            <Field label="Versión de Node.js">
              <span className="font-mono text-xs text-slate-700">
                {nodeVersion}
              </span>
            </Field>
            <Field label="Región de despliegue">
              <span className="font-mono text-xs text-slate-700">{region}</span>
            </Field>
          </div>
        </Section>
      </div>
    </div>
  );
}
