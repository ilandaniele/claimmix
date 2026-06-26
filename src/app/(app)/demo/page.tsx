import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { DemoClient } from "./DemoClient";

export default async function DemoPage() {
  try {
    const session = await getSessionContext();
    if (!session?.user) redirect("/login");
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") redirect("/login");
    throw e;
  }

  return (
    <div className="px-6 py-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">
          Demo en vivo — Análisis de siniestros
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Pegá cualquier email de un asegurado y Gemini extrae los datos, clasifica la
          gravedad y detecta señales de fraude en segundos.
        </p>
      </div>

      <DemoClient />
    </div>
  );
}
