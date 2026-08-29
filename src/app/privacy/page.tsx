import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Política de Privacidad — ClaimMix",
  description: "Política de privacidad y uso de datos de ClaimMix",
};

export default function PrivacyPage() {
  const lastUpdated = "14 de junio de 2026";

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-3xl px-6 py-16">
        {/* Header */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-slate-900">Política de Privacidad</h1>
          <p className="mt-2 text-sm text-slate-500">Última actualización: {lastUpdated}</p>
        </div>

        <div className="prose prose-slate max-w-none space-y-8 text-sm leading-relaxed text-slate-700">

          {/* 1 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">1. Quiénes somos</h2>
            <p>
              ClaimMix es una plataforma de gestión de siniestros de seguros (FNOL — First Notice of Loss)
              que permite a aseguradoras y ajustadores recibir, clasificar y procesar reclamos de manera
              automatizada. El responsable del tratamiento de datos es ClaimMix y puede contactarnos en{" "}
              <a href="mailto:ilan.daniele@gmail.com" className="text-blue-600 hover:underline">
                ilan.daniele@gmail.com
              </a>
              .
            </p>
          </section>

          {/* 2 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">2. Datos que recopilamos</h2>
            <p>Recopilamos únicamente los datos necesarios para operar el servicio:</p>
            <ul className="ml-5 mt-2 list-disc space-y-1">
              <li>
                <strong>Datos de cuenta:</strong> nombre, correo electrónico y contraseña (almacenada
                con hash bcrypt).
              </li>
              <li>
                <strong>Datos de siniestros:</strong> correos electrónicos de clientes, documentos
                adjuntos, campos extraídos (número de póliza, tipo de siniestro, fecha, etc.) y
                mensajes de comunicación.
              </li>
              <li>
                <strong>Datos de conexión Gmail:</strong> cuando conecta una cuenta de Gmail, almacenamos
                el token de actualización OAuth 2.0 cifrado con AES-256-GCM. No almacenamos su
                contraseña de Google.
              </li>
              <li>
                <strong>Datos de uso:</strong> registros de auditoría internos (acciones
                realizadas, marca de tiempo, ID del usuario de la aseguradora que
                las realizó, y la dirección IP y el navegador desde los que se
                hicieron) para trazabilidad operativa. Estos registros son sobre
                los usuarios del sistema —el personal de la aseguradora—, no
                sobre las personas que reportan un siniestro.
              </li>
            </ul>
          </section>

          {/* 3 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">3. Uso de la API de Gmail</h2>
            <p>
              ClaimMix solicita acceso a la API de Gmail exclusivamente para las siguientes
              finalidades operativas:
            </p>
            <ul className="ml-5 mt-2 list-disc space-y-1">
              <li>
                <strong>Lectura de correos entrantes</strong> (<code>gmail.readonly</code>): para
                detectar nuevos reclamos enviados por asegurados al buzón corporativo configurado.
              </li>
              <li>
                <strong>Modificación de estado</strong> (<code>gmail.modify</code>): para marcar
                correos como leídos una vez procesados, evitando duplicados.
              </li>
              <li>
                <strong>Envío de correos</strong> (<code>gmail.send</code>): para enviar respuestas
                automáticas de confirmación de recepción al asegurado.
              </li>
            </ul>
            <p className="mt-3">
              Los datos obtenidos de Gmail <strong>no se usan para publicidad</strong>, no se
              transfieren a terceros salvo los proveedores de infraestructura descritos en la sección 5,
              y no se usan para entrenar modelos de IA generales. El uso de ClaimMix de la información
              recibida de las APIs de Google cumple con la{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Política de datos de usuario de los servicios de API de Google
              </a>
              , incluidos los requisitos de uso limitado.
            </p>
          </section>

          {/* 4 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">4. Base legal del tratamiento</h2>
            <p>
              El tratamiento de datos se basa en la ejecución del contrato de servicio con la
              organización que utiliza ClaimMix (art. 6.1.b RGPD / ley aplicable) y en el
              interés legítimo de operar un servicio seguro y auditable (art. 6.1.f RGPD).
            </p>
          </section>

          {/* 5 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">5. Proveedores y transferencias</h2>
            <p>Compartimos datos únicamente con los siguientes proveedores de infraestructura:</p>
            <ul className="ml-5 mt-2 list-disc space-y-1">
              <li>
                <strong>Vercel</strong> (alojamiento de la aplicación) — Estados Unidos.
              </li>
              <li>
                <strong>Neon</strong> (base de datos PostgreSQL) — Estados Unidos.
              </li>
              <li>
                <strong>OpenAI / Google Gemini</strong> (extracción de campos con IA) — el texto
                del correo es enviado para análisis; no se almacena por el proveedor de IA más
                allá de la solicitud.
              </li>
            </ul>
            <p className="mt-2">
              Todos los proveedores operan bajo acuerdos de procesamiento de datos compatibles con
              las regulaciones aplicables.
            </p>
          </section>

          {/* 6 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">6. Retención de datos</h2>
            <p>
              Los datos de siniestros se conservan durante el período activo del contrato de servicio
              y hasta 5 años después de su cierre, salvo obligación legal que exija un plazo distinto.
              Los tokens de Gmail se eliminan inmediatamente cuando el usuario desconecta la cuenta.
            </p>
          </section>

          {/* 7 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">7. Seguridad</h2>
            <p>
              Aplicamos medidas técnicas y organizativas para proteger sus datos:
            </p>
            <ul className="ml-5 mt-2 list-disc space-y-1">
              <li>Cifrado AES-256-GCM para tokens OAuth y claves de API almacenadas.</li>
              <li>Contraseñas almacenadas con hash bcrypt (factor 12).</li>
              <li>Comunicaciones cifradas con TLS 1.2+.</li>
              <li>Control de acceso por roles (admin / analyst) con auditoría de acciones.</li>
              <li>Rate limiting en todos los endpoints de la API.</li>
            </ul>
          </section>

          {/* 8 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">8. Sus derechos</h2>
            <p>
              Usted tiene derecho a acceder, rectificar, suprimir, portar y oponerse al tratamiento
              de sus datos personales. Para ejercerlos, escriba a{" "}
              <a href="mailto:ilan.daniele@gmail.com" className="text-blue-600 hover:underline">
                ilan.daniele@gmail.com
              </a>
              . Responderemos en un plazo máximo de 30 días.
            </p>
          </section>

          {/* 9 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">9. Cambios en esta política</h2>
            <p>
              Podemos actualizar esta política periódicamente. Notificaremos los cambios materiales
              por correo electrónico o mediante un aviso destacado en la plataforma. La fecha de la
              última actualización aparece al inicio de este documento.
            </p>
          </section>

          {/* 10 */}
          <section>
            <h2 className="text-lg font-semibold text-slate-900">10. Contacto</h2>
            <p>
              Para consultas sobre esta política o el tratamiento de sus datos:{" "}
              <a href="mailto:ilan.daniele@gmail.com" className="text-blue-600 hover:underline">
                ilan.daniele@gmail.com
              </a>
            </p>
          </section>
        </div>

        <div className="mt-16 border-t border-slate-100 pt-6 text-center text-xs text-slate-400">
          © {new Date().getFullYear()} ClaimMix — Todos los derechos reservados
        </div>
      </div>
    </div>
  );
}
