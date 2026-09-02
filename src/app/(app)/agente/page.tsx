import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/require-admin";
import { AppError } from "@/lib/errors";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { AgentConsoleClient } from "./AgentConsoleClient";

export default async function AgentConsolePage() {
  let role = "admin";
  try {
    const { userRow } = await requireAdmin();
    role = userRow.role;
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") redirect("/login");
    redirect("/bandeja");
  }

  const t = getT(await getServerLocale());

  return (
    <div className="max-w-6xl px-6 py-8">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t("consola.titulo")}
        </h1>
      </div>
      <AgentConsoleClient role={role} />
    </div>
  );
}
