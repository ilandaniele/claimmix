import { DemoPublic } from "./DemoPublic";

export const metadata = {
  title: "Demo — ClaimMix",
  description: "Análisis de siniestros en tiempo real con IA. Pegá un email y ve cómo ClaimMix extrae los datos automáticamente.",
};

export default function DemoPage() {
  /*
   * `lienzo` y no un degradado propio.
   *
   * El degradado que había es `background-image`, y los overrides del modo
   * oscuro son todos `background-color`: en oscuro el fondo claro
   * sobrevivía entero mientras `.dark .text-slate-900` sí llegaba y pasaba
   * el h1 a casi blanco. Blanco sobre blanco: 1,05:1.
   *
   * Lo cobra cualquiera que abra la demo pública con el sistema en oscuro
   * —el script del tema corre en TODAS las rutas— y acá no hay botón de
   * tema para salir. Es la única pantalla pública, la que ve un prospecto
   * antes de tener cuenta.
   *
   * `.lienzo` es el mismo fondo del resto del producto y trae su par
   * oscuro. El h1 pasa a 16,5:1.
   */
  return (
    <div className="lienzo min-h-screen">
      {/* Header */}
      {/*
        `bg-white/80` era un blanco que el modo oscuro no podía alcanzar:
        Tailwind lo emite como `.bg-white\/80` y el override es
        `.dark .bg-white`, otra clase. La cabecera quedaba blanca con el
        nombre del producto en casi blanco encima. `--card-bg` ya cambia sola
        con el tema, así que la translucidez se mantiene sin `dark:`.
      */}
      <header className="border-b border-slate-200 bg-[var(--card-bg)]/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">C</span>
            </div>
            <span className="font-semibold text-slate-800 text-lg">ClaimMix</span>
          </div>
          {/* Violeta, el acento del producto: el índigo daba 3,83:1 en oscuro. */}
          <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-700">
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
