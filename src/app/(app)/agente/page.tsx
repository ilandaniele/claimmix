import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/require-admin";
import { AppError } from "@/lib/errors";
import { AgentConsoleClient } from "./AgentConsoleClient";

export default async function AgentConsolePage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") redirect("/login");
    redirect("/bandeja");
  }

  return (
    <div className="max-w-6xl px-6 py-8">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Consola del agente</h1>
      </div>
      <AgentConsoleClient />
    </div>
  );
}
