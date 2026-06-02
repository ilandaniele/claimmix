/**
 * Customer detail page — Server Component.
 *
 * Shows customer personal info, list of policies, and list of cases.
 * All data is RLS-scoped to the authenticated user's tenant.
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 * IDOR: getCaseDetail uses user-scoped Supabase client (RLS-enforced) — wrong tenant returns 404.
 */

import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { StatusBadge } from "@/app/(app)/bandeja/components/StatusBadge";
import { SeverityBadge } from "@/app/(app)/bandeja/components/SeverityBadge";
import { formatDate, formatAge } from "@/lib/utils";
import Link from "next/link";
import type { CaseStatus } from "@/lib/schemas/cases";

interface CustomerDetailPageProps {
  params: Promise<{ id: string }>;
}

interface Policy {
  id: string;
  policy_number: string;
  policy_type: string;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
}

interface CustomerCase {
  id: string;
  created_at: string;
  status: string;
  severity: string | null;
  claim_type: string;
}

interface Customer {
  id: string;
  full_name: string;
  dni: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
}

const POLICY_TYPE_LABELS: Record<string, string> = {
  auto: "Automóvil",
  home: "Hogar",
  life: "Vida",
  business: "Empresa",
  other: "Otro",
};

const POLICY_STATUS_CLASSES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  expired: "bg-slate-100 text-slate-600",
  cancelled: "bg-red-100 text-red-700",
};

const POLICY_STATUS_LABELS: Record<string, string> = {
  active: "Activa",
  expired: "Vencida",
  cancelled: "Cancelada",
};

/** Format case UUID to short SIN-XXXX-XXXX display string */
function formatCaseNumber(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

export default async function CustomerDetailPage({
  params,
}: CustomerDetailPageProps) {
  const { id } = await params;

  const supabase = await createServerClient();

  // Fetch customer (RLS-scoped — wrong tenant returns null → 404)
  const { data: customerRaw, error: customerError } = await (supabase as any)
    .from("customers")
    .select("id,full_name,dni,email,phone,created_at")
    .eq("id", id)
    .single();

  if (customerError || !customerRaw) {
    notFound();
  }

  const customer = customerRaw as Customer;

  // Fetch policies + cases in parallel
  const [{ data: policiesRaw }, { data: casesRaw }] = await Promise.all([
    (supabase as any)
      .from("policies")
      .select("id,policy_number,policy_type,status,valid_from,valid_to")
      .eq("customer_id", id)
      .order("valid_from", { ascending: false }),
    (supabase as any)
      .from("cases")
      .select("id,created_at,status,severity,claim_type")
      .eq("customer_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const policies: Policy[] = policiesRaw ?? [];
  const cases: CustomerCase[] = casesRaw ?? [];

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto">
      {/* Back button */}
      <div className="mb-4">
        <Link
          href="/clientes"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
          aria-label={t("clientes.back")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          {t("clientes.back")}
        </Link>
      </div>

      {/* Header card — personal info */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 mb-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900 mb-4">
          {customer.full_name}
        </h1>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-slate-500">{t("clientes.col.dni")}</dt>
            <dd className="mt-0.5 font-mono font-medium text-slate-900">
              {customer.dni ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("clientes.col.email")}</dt>
            <dd className="mt-0.5 text-slate-900">{customer.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("clientes.col.phone")}</dt>
            <dd className="mt-0.5 text-slate-900">{customer.phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("clientes.col.createdAt")}</dt>
            <dd className="mt-0.5 text-slate-900">
              {customer.created_at ? formatDate(customer.created_at) : "—"}
            </dd>
          </div>
        </dl>
      </div>

      {/* Two-section layout */}
      <div className="flex flex-col gap-6">
        {/* Policies */}
        <section
          aria-labelledby="policies-heading"
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2
            id="policies-heading"
            className="text-sm font-semibold text-slate-900 mb-4"
          >
            {t("clientes.detail.policies")}
            <span className="ml-2 text-slate-400 font-normal">
              ({policies.length})
            </span>
          </h2>
          {policies.length === 0 ? (
            <p className="text-sm text-slate-400">
              {t("clientes.detail.noPolicies")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full table-auto text-left"
                aria-label={t("clientes.detail.policies")}
              >
                <thead>
                  <tr>
                    {[
                      t("clientes.detail.policyNumber"),
                      t("clientes.detail.policyType"),
                      t("clientes.detail.policyStatus"),
                      t("clientes.detail.validFrom"),
                      t("clientes.detail.validTo"),
                    ].map((col) => (
                      <th
                        key={col}
                        scope="col"
                        className="border-b border-slate-200 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500 px-3 first:pl-0 last:pr-0"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {policies.map((policy) => (
                    <tr
                      key={policy.id}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="py-2.5 px-3 first:pl-0 font-mono text-sm text-slate-800">
                        {policy.policy_number}
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-700">
                        {POLICY_TYPE_LABELS[policy.policy_type] ??
                          policy.policy_type}
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            POLICY_STATUS_CLASSES[policy.status] ??
                            "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {POLICY_STATUS_LABELS[policy.status] ??
                            policy.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">
                        {policy.valid_from
                          ? formatDate(policy.valid_from)
                          : "—"}
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap last:pr-0">
                        {policy.valid_to ? formatDate(policy.valid_to) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Cases */}
        <section
          aria-labelledby="cases-heading"
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2
            id="cases-heading"
            className="text-sm font-semibold text-slate-900 mb-4"
          >
            {t("clientes.detail.cases")}
            <span className="ml-2 text-slate-400 font-normal">
              ({cases.length})
            </span>
          </h2>
          {cases.length === 0 ? (
            <p className="text-sm text-slate-400">
              {t("clientes.detail.noCases")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full table-auto text-left"
                aria-label={t("clientes.detail.cases")}
              >
                <thead>
                  <tr>
                    {[
                      t("table.col.id"),
                      "Fecha",
                      t("table.col.status"),
                      t("case.detail.severity"),
                      t("table.col.type"),
                    ].map((col) => (
                      <th
                        key={col}
                        scope="col"
                        className="border-b border-slate-200 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500 px-3 first:pl-0 last:pr-0"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="py-2.5 px-3 first:pl-0">
                        <Link
                          href={`/casos/${c.id}`}
                          className="font-mono text-xs text-blue-600 hover:underline"
                        >
                          {formatCaseNumber(c.id)}
                        </Link>
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">
                        Hace {formatAge(c.created_at)}
                      </td>
                      <td className="py-2.5 px-3">
                        <StatusBadge status={c.status as CaseStatus} />
                      </td>
                      <td className="py-2.5 px-3">
                        {c.severity ? (
                          <SeverityBadge severity={c.severity} />
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-700 capitalize last:pr-0">
                        {c.claim_type}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
