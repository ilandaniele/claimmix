/**
 * Negative simulation scenarios — email that is NOT an insurance claim.
 *
 * Why this file exists: the base set had only 5 `other` scenarios and all of
 * them are insurance-adjacent (renewal questions, coverage queries, payment
 * receipts). Nothing taught the agent about the traffic that actually floods a
 * real intake mailbox — marketing blasts, newsletters, order notifications,
 * phishing. With ~3 approved negative examples the model had almost no signal
 * for "reject this", which is the expensive failure mode: a promo booked as a
 * claim wastes an analyst's time and pollutes the training set.
 *
 * These are modelled on the real junk observed in the connected Gmail inbox
 * (Starbucks, Rappi, Shopify, Apple, bet365, Trustpilot review requests,
 * student-discount newsletters, collaboration invites), so the distribution
 * matches production rather than an idealised guess.
 *
 * All carry case_type "other" and must extract to is_claim = false.
 *
 * Note on the deliberately hard ones: several use claim-adjacent vocabulary on
 * purpose — "siniestro" in a insurance-marketing blast, "accidente" in a news
 * digest, "daños" in a hardware promo, a real policy number in a billing
 * receipt. Keyword matching alone should not be enough to pass.
 */

import type { SimulationScenario } from "./scenarios";

export const NEGATIVE_SCENARIOS: SimulationScenario[] = [
  {
    id: "neg-marketing-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `¡Nueva colección Dandy + Starbucks! ☕✨

Fueled by Starbucks, styled by Dandy.

Descubrí la nueva línea de tazas térmicas y vasos reutilizables. Envío gratis en compras superiores a $25.000.

COMPRAR AHORA →

Seguinos en Instagram @starbucksarg
Si no querés recibir más correos, desuscribite acá.
Starbucks Coffee Argentina S.A.`,
    expected_fields: {},
  },
  {
    id: "neg-marketing-02",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `🥤 ¡40% OFF en tus gaseosas favoritas!

Solo por hoy en Rappi. Pedí lo que quieras y recibilo en 20 minutos.

Usá el código FRESCO40 en tu próximo pedido.
Válido hasta las 23:59 hs. No acumulable con otras promociones.

Descargá la app · Términos y condiciones · Cancelar suscripción`,
    expected_fields: {},
  },
  {
    id: "neg-ecommerce-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `En el bolsillo: 1 pedido esta semana

Hola,

Resumen de tu tienda en Shopify:
- Pedidos: 1
- Ventas totales: $18.400
- Visitantes: 143

Ver panel completo →

Shopify Inc. · Podés ajustar la frecuencia de estos resúmenes en Configuración.`,
    expected_fields: {},
  },
  {
    id: "neg-ecommerce-02",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Tus compras en Apple.

Gracias por tu compra. Aquí está el recibo de tu pedido.

AppleCare+ para iPhone — $12.900/mes
Fecha: 22/07/2025
ID del pedido: MJ8821XK

Este es un correo automático, por favor no respondas.
Apple Inc. One Apple Park Way, Cupertino, CA.`,
    expected_fields: {},
  },
  {
    id: "neg-newsletter-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Gonzalo, ¡tenés descuentos acumulables para este mes! 🎓

Como estudiante registrado accedés a:
- 20% en librerías adheridas
- 2x1 en cines los miércoles
- Descuentos en indumentaria deportiva

Ver todos los beneficios →

Soy Estudiante · Recibís este correo porque te registraste en nuestra plataforma.`,
    expected_fields: {},
  },
  {
    id: "neg-newsletter-02",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Finally, an AI that Knows When Not to Overthink

This week in AI marketing:
→ The new reasoning models and when they're overkill
→ 3 prompts that cut your ad copy time in half
→ Case study: how a DTC brand scaled with automation

Read the full issue (8 min)

The AI Marketing Newsletter · Unsubscribe`,
    expected_fields: {},
  },
  {
    id: "neg-review-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `⭐⭐⭐⭐⭐ Puntuá tu experiencia con Meller

Hola, ¿cómo te fue con tu última compra?

Tu opinión ayuda a otros compradores. Te lleva menos de un minuto.

DEJAR MI RESEÑA →

Este correo fue enviado por Trustpilot en nombre de Meller.
Si no querés recibir más invitaciones, hacé clic acá.`,
    expected_fields: {},
  },
  {
    id: "neg-phishing-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Acción necesaria: Información importante sobre tu cuenta

Estimado cliente,

Hemos detectado actividad inusual en tu cuenta. Por motivos de seguridad, tu acceso ha sido temporalmente limitado.

Para restablecer tu cuenta, verificá tus datos en el siguiente enlace en las próximas 24 horas:

>> VERIFICAR MI CUENTA AHORA <<

Si no completás la verificación, tu cuenta será suspendida permanentemente.

Atentamente,
Departamento de Seguridad`,
    expected_fields: {},
  },
  {
    id: "neg-b2b-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Invitación para colaborar en Downtown | medStock

Hola,

Te invitamos a formar parte de nuestra red de proveedores en la zona de Downtown.

Beneficios de sumarte:
- Acceso a más de 300 clientes activos
- Gestión de stock centralizada
- Cobros a 15 días

Aceptar invitación →

medStock · noreply@verification.medstock.com.ar`,
    expected_fields: {},
  },
  {
    id: "neg-servicio-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Tu factura de Edenor ya está disponible

Período: julio 2025
Vencimiento: 12/08/2025
Importe: $34.782,50

Podés abonarla por débito automático, home banking o en puntos de pago habilitados.

Ver factura detallada →

Edenor S.A. · Consultas al 0800-666-4002`,
    expected_fields: {},
  },
  {
    id: "neg-personal-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Hola! Y el electro de forma particular cuanto sale? Y cuando podría agendar el turno?

Gracias!

Enviado desde mi iPhone`,
    expected_fields: {},
  },
  {
    id: "neg-rrhh-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Nuevas oportunidades laborales para vos

Basado en tu perfil, encontramos 12 búsquedas activas:

· Desarrollador Full Stack — Buenos Aires (Híbrido)
· Analista de Datos Semi Senior — Remoto
· Product Manager — CABA

Ver todas las ofertas →

Recibís este mail porque tenés alertas activas. Configurar preferencias.`,
    expected_fields: {},
  },
  {
    // Deliberately hard: insurance vocabulary ("siniestros", "cobertura") in a
    // marketing blast from an insurer. Must still be rejected — it reports no
    // incident, it is selling a product.
    id: "neg-seguro-marketing-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `¿Sabías que el 40% de los siniestros ocurren a menos de 5 km de casa?

Protegé tu auto con nuestra cobertura Todo Riesgo.

✓ Gestión de siniestros 100% online
✓ Auto de reemplazo por 15 días
✓ Cobertura de cristales sin franquicia

COTIZAR EN 2 MINUTOS →

Promoción válida hasta el 31/08/2025 para nuevas contrataciones.
Si no deseás recibir promociones, desuscribite.`,
    expected_fields: {},
  },
  {
    // Deliberately hard: carries a real-looking policy number and the word
    // "cobertura", but it is a billing receipt, not an incident report.
    id: "neg-seguro-admin-01",
    case_type: "other",
    policyholder_name: "Marcos Gutiérrez",
    policy_number: "POL-2025-118",
    raw_text: `Constancia de pago — Póliza POL-2025-118

Estimado Marcos Gutiérrez,

Confirmamos la acreditación del pago correspondiente a la cuota 6/12 de su póliza POL-2025-118.

Importe: $47.300
Medio: débito automático
Fecha de acreditación: 15/07/2025

Su cobertura continúa vigente sin interrupciones. Este comprobante no requiere respuesta.

Departamento de Cobranzas`,
    expected_fields: {},
  },
  {
    // Deliberately hard: "accidente" and "choque" appear, but as news content.
    id: "neg-noticias-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Resumen de noticias — martes 22 de julio

· Accidente múltiple en la Panamericana: demoras de hasta 2 horas
· El dólar cerró estable tras la última licitación
· Choque de trenes en Europa reaviva el debate sobre inversión ferroviaria
· Deportes: se define el campeonato este fin de semana

Leer edición completa →

Recibís este correo por tu suscripción al resumen diario.`,
    expected_fields: {},
  },
  {
    // Deliberately hard: "daños" + "cobertura" in a hardware/tech promo.
    id: "neg-tech-promo-01",
    case_type: "other",
    policyholder_name: "",
    policy_number: "",
    raw_text: `Protegé tu notebook contra daños accidentales 💻

Extendé la garantía de tu equipo por 24 meses más.

Incluye cobertura por caídas, derrames de líquidos y fallas eléctricas.
Desde $8.900 por mes.

CONTRATAR AHORA →

Oferta exclusiva para clientes registrados. Consultá términos y condiciones.`,
    expected_fields: {},
  },
];
