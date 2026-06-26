import { DemoPublic } from "./DemoPublic";

export const metadata = {
  title: "Demo — ClaimMix",
  description: "Análisis de siniestros en tiempo real con IA. Pegá un email y ve cómo ClaimMix extrae los datos automáticamente.",
};

export default function DemoPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">C</span>
            </div>
            <span className="font-semibold text-slate-800 text-lg">ClaimMix</span>
          </div>
          <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700">
            Demo en vivo
          </span>
        </div>
      </header>

      {/* Hero */}
      <div className="mx-auto max-w-6xl px-6 pt-12 pb-8">
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Intake de siniestros con IA
          </h1>
          <p className="mt-3 text-lg text-slate-600 max-w-2xl mx-auto">
            Pegá cualquier email de siniestro y Gemini extrae todos los campos en segundos.
            Sin formularios, sin cargar datos manualmente.
          </p>
        </div>

        <DemoPublic />
      </div>
    </div>
  );
}
