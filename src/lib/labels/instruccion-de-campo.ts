/**
 * Qué se le pide a la persona por cada campo: una oración, en imperativo.
 *
 * Sólo de servidor. La leen el mail de pedido de datos y el prompt de la
 * respuesta; ninguna pantalla. Vive aparte de `claim-fields.ts` para que no
 * viaje al navegador junto con las etiquetas, que sí las usan los componentes
 * de cliente.
 */

import { labelForField } from "@/lib/labels/claim-fields";

const INSTRUCCIONES: Record<string, string> = {
  full_name: "Decinos tu nombre y apellido.",
  email: "Dejanos un correo donde podamos escribirte.",
  phone: "Dejanos un teléfono donde podamos llamarte.",
  email_or_phone: "Dejanos un teléfono o un correo donde podamos ubicarte.",
  dni: "Decinos el DNI del titular de la póliza, o el CUIT si está a nombre de un consorcio o una empresa.",
  policy_number: "Decinos el número de póliza (por ejemplo POL-12345).",
  accident_date: "Decinos qué día ocurrió (por ejemplo 15/05/2026).",
  accident_location: "Decinos la dirección o la localidad donde ocurrió.",
  accident_description: "Contanos brevemente cómo ocurrió el siniestro.",
  claim_type: "Decinos qué tipo de siniestro fue: choque, robo, granizo, incendio.",
  nombre_asegurado: "Decinos el nombre y apellido del titular de la póliza.",
  dni_asegurado: "Decinos el DNI del titular de la póliza, o el CUIT si está a nombre de un consorcio o una empresa.",
  telefono_contacto: "Dejanos un teléfono donde podamos llamarte.",
  numero_poliza: "Decinos el número de póliza (por ejemplo POL-12345).",
  fecha_siniestro: "Decinos qué día ocurrió.",
  hora_siniestro: "Decinos más o menos a qué hora fue.",
  lugar_siniestro: "Decinos la dirección o la esquina donde ocurrió.",
  provincia_siniestro: "Decinos en qué provincia ocurrió.",
  patente_vehiculo: "Decinos la patente del vehículo.",
  tipo_vehiculo: "Decinos marca, modelo y patente del vehículo.",
  hay_heridos: "Decinos si alguien resultó lastimado.",
  heridos: "Decinos si alguien resultó lastimado y quién.",
  testigos: "Si hubo testigos, pasanos su nombre y teléfono.",
  partes_relacionadas: "Decinos quién más participó del hecho y sus datos.",
  numero_denuncia: "Si hiciste la denuncia, pasanos el número.",
  fotos_danos: "Mandanos fotos de los daños.",
  fotos_lugar: "Mandanos fotos del lugar del hecho.",
  foto_vidrio: "Mandanos una foto del vidrio dañado.",
  licencia_conducir: "Mandanos una foto de la licencia de quien manejaba.",
  parte_amistoso: "Mandanos el parte amistoso de accidente si lo completaron.",
  denuncia_policial: "Mandanos una foto de la denuncia policial.",
  informe_bomberos: "Mandanos el informe de bomberos.",
  certificado_medico: "Mandanos el certificado médico o el alta hospitalaria de la atención.",
  foto_oblea_vtv: "Mandanos una foto de la oblea de la VTV.",
  vtv: "Mandanos una foto de la oblea de la VTV.",
  denuncia_art: "Mandanos la denuncia que se hizo a la ART por el accidente.",
  certificado_defuncion: "Mandanos una foto o el PDF del certificado de defunción.",
  dni_beneficiario: "Mandanos una foto del DNI del beneficiario, de frente y dorso.",
  inventario_bienes: "Mandanos el listado de los bienes dañados o robados, con su valor aproximado.",
  presupuesto_reparacion: "Mandanos el presupuesto de la reparación.",
};

/**
 * La oración para pedir un campo. `override` es el nombre que le puso la
 * aseguradora: manda sobre el nuestro, y si la clave no está en la tabla la
 * oración se arma con él.
 */
export function instruccionDeCampo(fieldKey: string, override?: string | null): string {
  const conocida = INSTRUCCIONES[fieldKey];
  if (conocida) return conocida;
  const { label, kind } = labelForField(fieldKey, override);
  const verbo = override?.trim() || kind === "documento" ? "Mandanos" : "Decinos";
  return `${verbo} ${minuscula(label)}.`;
}

function minuscula(s: string): string {
  // Las siglas quedan como están: "DNI del asegurado" no puede pasar a "dNI...".
  if (s.length > 1 && s[0] === s[0].toUpperCase() && s[1] === s[1].toUpperCase()) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
