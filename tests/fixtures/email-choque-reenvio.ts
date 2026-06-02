/**
 * Anonymized fixture based on a real forwarded insurance claim email.
 *
 * Pattern: forwarded/reply thread, collision (choque), two vehicles,
 * law firm involved, missing budget + inspection docs, CBU + DNI in body.
 *
 * PII replaced with synthetic values; structure preserved for realistic parsing tests.
 */

export const EXAMPLE_CHOQUE_EMAIL_SUBJECT =
  "RV: Siniestro 91500000-2 de ZURICH ARGENTINA COMPAÑÍA DE SEGUROS S.A. - Accidente del 27/07/2025 entre MERCEDES CLA 200 URBAN dominio ABC123 y HONDA WR-V 1.5 EXL CVT dominio XY456ZW";

export const EXAMPLE_CHOQUE_EMAIL_BODY = `
Enviado desde mi iPhone

Inicio del mensaje reenviado:

De: Carlos Mendoza <carlos.mendoza.test@gmail.com>
Fecha: 30 de julio de 2025 a las 4:49:30 p. m. GMT-3
Para: "Depto. de Reclamos Extrajudiciales - Estudio Jurídico Test" <derivaciones@test-estudio.com.ar>
Asunto: Re: Siniestro 91500000-2 de ZURICH ARGENTINA COMPAÑÍA DE SEGUROS S.A. - Accidente del 27/07/2025

Hola, los puntos 1,2,4,5, y 6 ya fueron cargados en la web de Zurich que nos facilitaron, me podrías confirmar recepción de los mismos?

El punto 3, al ser un todo riesgo con franquicia del 3%, hace falta presupuesto? Estoy esperando que venga la gente del perito a revisar el vehículo.

Adjunto constancia de CBU, y el punto 7 está en trámite, me dijeron que me lo dan luego de la inspección del perito.

Espero su respuesta.
Saludos y gracias!
CM

El mié, 30 jul 2025 a las 16:20, Depto. de Reclamos Extrajudiciales (<derivaciones@test-estudio.com.ar>) escribió:

Estimado Sr. MENDOZA CARLOS,

Le enviamos el presente mensaje en representación de ZURICH ARGENTINA COMPAÑÍA DE SEGUROS S.A. para solicitarle la siguiente documentación a efectos de analizar el reclamo, deberá aportar:

1. DNI del titular del vehículo (foto del frente y dorso)
2. Cédula Verde (de ambos lados)
3. Un presupuesto con el importe detallado de cada rubro (chapa, pintura, repuestos, etc.)
4. Imágenes de las partes dañadas del vehículo y alguna en la que se observe la patente.
5. Denuncia administrativa efectuada en la Aseguradora del vehículo.
6. Certificado de Cobertura de la compañia Aseguradora donde se detalle el tipo de cobertura contratada.
7. En caso de contar con cobertura de Todo Riesgo, la liquidación efectuada por la Compañia Aseguradora o Carta de Franquicia.
8. Constancia de CBU (de entidad bancaria, no CVU) de una cuenta a nombre del titular.

Cordialmente,

Juan Rodríguez
Depto. de Reclamos Extrajudiciales
Estudio Jurídico Test

Archivo adjunto:

Banco de Galicia y Buenos Aires S.A.U
CUIT: 30-50000173-5

Constancia de Clave Bancaria (CBU)

CABA, 30 julio 2025

BANCO TEST
SUCURSAL 100
Por la presente, se deja constancia que la persona CARLOS MENDOZA con DU Nro.23456789 es titular de la
caja de ahorro en pesos N°: 400400000001 con CBU Nro: 0070068930004000000016.
Se extiende la presente solicitud para ser presentada ante quien corresponda.
`.trim();

/** Expected extraction result when parsing EXAMPLE_CHOQUE_EMAIL_BODY */
export const EXPECTED_CHOQUE_EXTRACTION = {
  is_claim: true,
  claim_type: "choque",
  severity: "medium",
  full_name: "Carlos Mendoza",
  email: "carlos.mendoza.test@gmail.com",
  accident_date: "27/07/2025",
  // CBU and DNI should be DETECTED but masked in outbound emails
  dni_in_body: "23456789",
  policy_number_hint: "91500000-2", // siniestro number as policy hint
  missing_fields: ["presupuesto", "carta_de_franquicia"], // points 3 and 7 pending
  vehicles: ["MERCEDES CLA 200 ABC123", "HONDA WR-V XY456ZW"],
};
