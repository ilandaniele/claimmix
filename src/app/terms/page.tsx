import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Términos del Servicio — ClaimMix",
  description: "Condiciones de uso del servicio ClaimMix",
};

/**
 * Términos del servicio.
 *
 * Existe por dos motivos, y el segundo es el que lo hizo urgente: una app que
 * pide permisos de Gmail no se puede publicar sin una URL de términos y otra de
 * política de privacidad, públicas y alcanzables. Mientras la app está en estado
 * de prueba, Google vence el permiso de la casilla a los siete días — o sea que
 * sin esta página el correo se corta solo cada semana.
 *
 * Es un texto base, honesto sobre lo que el servicio hace y no hace. No
 * reemplaza la revisión de alguien que sepa de contratos.
 */
export default function TermsPage() {
  const lastUpdated = "24 de agosto de 2026";

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-slate-900">Términos del Servicio</h1>
          <p className="mt-2 text-sm text-slate-500">Última actualización: {lastUpdated}</p>
        </div>

        <div className="prose prose-slate max-w-none space-y-8 text-sm leading-relaxed text-slate-700">
          <section>
            <h2 className="text-lg font-semibold text-slate-900">1. Qué es ClaimMix</h2>
            <p className="mt-2">
              ClaimMix es un servicio de recepción y análisis de denuncias de siniestros para
              compañías de seguros y productores. Recibe mensajes por correo electrónico y por
              WhatsApp, extrae los datos de la denuncia con ayuda de inteligencia artificial y
              los presenta ordenados a un analista, que es quien decide.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">2. Quién puede usarlo</h2>
            <p className="mt-2">
              El servicio se presta a organizaciones que contratan una cuenta. El acceso es
              nominal: cada persona usa su propia credencial y no debe compartirla. La
              organización es responsable de dar de alta y de baja a su gente.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">3. Qué NO es</h2>
            <p className="mt-2">
              ClaimMix no decide coberturas, no aprueba ni rechaza siniestros y no reemplaza el
              criterio de un analista, un perito o un profesional matriculado. Lo que el sistema
              produce es una lectura automática de lo que la persona escribió: puede equivocarse,
              y por eso todo caso queda a la vista de una persona antes de tener consecuencias.
            </p>
            <p className="mt-2">
              Ninguna respuesta automática constituye reconocimiento de cobertura, aceptación de
              un siniestro ni compromiso de pago.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">4. Datos de los asegurados</h2>
            <p className="mt-2">
              Los datos personales que entran al sistema pertenecen a los asegurados y son
              tratados por cuenta de la organización que contrata el servicio, según la{" "}
              <a href="/privacy" className="text-indigo-600 underline">
                Política de Privacidad
              </a>
              . Cada organización ve únicamente sus propias denuncias.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">5. Uso aceptable</h2>
            <p className="mt-2">
              No está permitido usar el servicio para cargar datos obtenidos ilegítimamente,
              intentar acceder a información de otra organización, ni interferir con su
              funcionamiento. El incumplimiento habilita la suspensión de la cuenta.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">6. Disponibilidad</h2>
            <p className="mt-2">
              El servicio se ofrece tal como está. Se trabaja para que esté disponible de forma
              continua, pero depende de proveedores de terceros —correo, mensajería, infraestructura
              en la nube y modelos de lenguaje— y puede haber interrupciones. Los siniestros
              recibidos durante una interrupción se procesan cuando el servicio se restablece.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">7. Responsabilidad</h2>
            <p className="mt-2">
              Las decisiones sobre un siniestro son de la organización que contrata el servicio.
              ClaimMix no responde por decisiones tomadas a partir de una lectura automática sin
              la revisión humana que el propio sistema prevé.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">8. Cambios</h2>
            <p className="mt-2">
              Estos términos pueden actualizarse. La fecha de la última actualización figura al
              principio de esta página, y los cambios relevantes se avisan por correo a la
              organización.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-slate-900">9. Contacto</h2>
            <p className="mt-2">
              Por cualquier consulta sobre estos términos:{" "}
              <a href="mailto:veltra.claimmix@gmail.com" className="text-indigo-600 underline">
                veltra.claimmix@gmail.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
