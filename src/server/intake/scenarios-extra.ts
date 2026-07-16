/**
 * Extra simulation scenarios — variety pack for the weak claim types.
 *
 * Why this file exists: the base SCENARIOS list only had 10 distinct texts per
 * weak type (cristales / rc / robo_contenido / accidente_personal). Training
 * examples are de-duplicated by content hash when the fine-tuning JSONL is
 * built, so re-running the same 10 scenarios can never produce more than 10
 * unique examples per class — the dataset stayed unbalanced no matter how many
 * cases were simulated.
 *
 * These 40 add genuinely different signal, not paraphrases:
 *   - Geography beyond CABA/GBA (Córdoba, Rosario, Mendoza, Neuquén, Salta,
 *     Tucumán, Mar del Plata, Bahía Blanca, Corrientes, Ushuaia).
 *   - Register: formal letters, terse WhatsApp-style notes, all-lowercase,
 *     typos, elderly/rambling, third-party reporting on behalf of the insured.
 *   - Completeness: some carry every field, others deliberately omit the plate,
 *     the date or the police report so the agent must flag missing info.
 *
 * Kept separate from scenarios.ts purely for readability (that file is already
 * ~2.7k lines); they are concatenated into SCENARIOS there.
 */

import type { SimulationScenario } from "./scenarios";

export const EXTRA_SCENARIOS: SimulationScenario[] = [
  // ── robo_contenido (10) ────────────────────────────────────────────────────
  {
    id: "rc-cont-v2-01",
    case_type: "robo_contenido",
    policyholder_name: "Mariela Alejandra Quiroga",
    policy_number: "POL-2025-201",
    raw_text: `Buenos días,

Les escribo para denunciar el robo del contenido de mi vehículo. El hecho ocurrió el 12/07/2025 durante la madrugada en la calle Rondeau 1450, barrio Nueva Córdoba, Córdoba Capital.

Mi Chevrolet Onix 2021, patente AD 456 KL, estaba estacionado frente a mi edificio. Al bajar a las 7 de la mañana encontré el vidrio de la puerta del acompañante roto y me faltaba una notebook Lenovo ThinkPad que había dejado en el asiento trasero, un bolso con ropa deportiva y el cargador del auto.

Hice la denuncia en la Comisaría 8va de Córdoba, número de acta 2025-8-4471. Tengo fotos del vidrio roto y del interior revuelto.

Quedo a disposición.

Mariela Quiroga
DNI 33.221.098`,
    expected_fields: {
      incident_date: "12/07/2025",
      incident_location: "Rondeau 1450, Nueva Córdoba, Córdoba",
      vehicle_plate: "AD 456 KL",
      denuncia_policial: "si",
      police_report_number: "2025-8-4471",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-cont-v2-02",
    case_type: "robo_contenido",
    policyholder_name: "Diego Hernán Sosa",
    policy_number: "POL-2025-202",
    raw_text: `hola buenas me robaron todo lo de adentro de la camioneta anoche. estaba en la puerta de casa en rosario, zona sur, calle ayacucho al 3200. me rompieron el vidrio chico de atras y se llevaron las herramientas de trabajo, una amoladora, un taladro bosch y una caja con llaves. soy plomero asi que era todo mi laburo.

la camioneta es una fiat fiorino gris patente JQR 882. fecha 14/07/2025 mas o menos a las 3 de la mañana calculo porque a las 11 de la noche estaba todo bien.

ya hice la denuncia, me dieron el numero 2025-R7-9912.

necesito saber que cubre la poliza porque sin herramientas no puedo trabajar. gracias

diego sosa`,
    expected_fields: {
      incident_date: "14/07/2025",
      incident_location: "Ayacucho al 3200, zona sur, Rosario",
      vehicle_plate: "JQR 882",
      denuncia_policial: "si",
      police_report_number: "2025-R7-9912",
    },
  },
  {
    id: "rc-cont-v2-03",
    case_type: "robo_contenido",
    policyholder_name: "Susana Beatriz Ferreyra",
    policy_number: "POL-2025-203",
    raw_text: `Estimados señores de la compañía:

Les escribo con mucha angustia porque el día sábado pasado, que fue 05/07/2025, mientras estábamos con mi marido almorzando en un restaurante de la costanera de Mar del Plata, nos rompieron el auto y nos sacaron cosas de adentro.

El auto es un Volkswagen Gol Trend del año 2018, la patente es OPQ 334. Estaba estacionado en la calle Boulevard Marítimo, cerca del casino.

Se llevaron la cartera mía que la había dejado abajo del asiento (yo se que fue un error), con documentos y una billetera, y también una tablet de mi nieto. Rompieron la ventanilla del conductor.

Fuimos a la comisaría de la zona e hicimos todo el trámite, el número que nos dieron es 2025-MDP-3387. Tengo las fotos que sacó mi marido con el celular.

Muchas gracias por su atención.

Susana Ferreyra
DNI 12.988.774`,
    expected_fields: {
      incident_date: "05/07/2025",
      incident_location: "Boulevard Marítimo, Mar del Plata",
      vehicle_plate: "OPQ 334",
      denuncia_policial: "si",
      police_report_number: "2025-MDP-3387",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-cont-v2-04",
    case_type: "robo_contenido",
    policyholder_name: "Federico Ariel Blanco",
    policy_number: "POL-2025-204",
    raw_text: `Buenas tardes,

Denuncio robo del interior de mi auto en la playa de estacionamiento del Shopping Portal Palermo, CABA, el 16/07/2025 entre las 18:00 y las 20:30 hs.

Vehículo: Peugeot 208 2023, patente AF 771 MN.

Forzaron la cerradura de la puerta del conductor (no rompieron vidrio) y sustrajeron una campera de cuero, unos anteojos de sol Ray-Ban y aproximadamente $150.000 en efectivo que estaban en la guantera.

El shopping tiene cámaras y ya solicité el video al personal de seguridad. Hice la denuncia online, número 2025-CABA-88214.

Adjunto fotos de la cerradura forzada.

Saludos,
Federico Blanco
DNI 35.667.221`,
    expected_fields: {
      incident_date: "16/07/2025",
      incident_location: "Shopping Portal Palermo, CABA",
      vehicle_plate: "AF 771 MN",
      denuncia_policial: "si",
      police_report_number: "2025-CABA-88214",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-cont-v2-05",
    case_type: "robo_contenido",
    policyholder_name: "Lucas Emanuel Ibarra",
    policy_number: "POL-2025-205",
    raw_text: `Me entraron al auto y me robaron el estéreo y dos parlantes. Fue en Neuquén capital, calle Belgrano casi Roca, el 09/07/2025 a la noche.

Renault Sandero patente MLK 210. Rompieron el vidrio de atrás del lado derecho.

Todavía no hice la denuncia policial, la voy a hacer mañana. Tengo fotos.

Lucas Ibarra`,
    expected_fields: {
      incident_date: "09/07/2025",
      incident_location: "Belgrano y Roca, Neuquén capital",
      vehicle_plate: "MLK 210",
      denuncia_policial: "no",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-cont-v2-06",
    case_type: "robo_contenido",
    policyholder_name: "Andrea Carolina Ledesma",
    policy_number: "POL-2025-206",
    raw_text: `Estimados:

Escribo en nombre de mi padre, Ramón Ledesma, titular de la póliza, ya que él no maneja bien el correo electrónico.

El día 11/07/2025 le robaron elementos del interior de su Toyota Etios patente NPQ 556, mientras estaba estacionado en la puerta del Hospital Español de Mendoza, sobre calle San Martín. Ocurrió aproximadamente entre las 10 y las 12 del mediodía.

Le sustrajeron un maletín con documentación, una campera y el equipo de mate. Rompieron el vidrio trasero.

Realizamos la denuncia en la Comisaría 4ta de Mendoza, acta 2025-MZA-1174. Tenemos fotografías del vehículo.

Cualquier cosa me escriben a mí.

Andrea Ledesma (hija)`,
    expected_fields: {
      incident_date: "11/07/2025",
      incident_location: "Hospital Español, San Martín, Mendoza",
      vehicle_plate: "NPQ 556",
      denuncia_policial: "si",
      police_report_number: "2025-MZA-1174",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-cont-v2-07",
    case_type: "robo_contenido",
    policyholder_name: "Gonzalo Matías Rivero",
    policy_number: "POL-2025-207",
    raw_text: `Buen día. Quiero reportar el robo de una silla de bebé (butaca Chicco) y un cochecito plegable que estaban en el baúl de mi vehículo.

Sucedió el 13/07/2025 en el estacionamiento del supermercado Libertad de San Miguel de Tucumán, avenida Aconquija al 1800. Estuve adentro 40 minutos.

Mi auto es un Ford EcoSport 2020, dominio AC 903 JH. Abrieron el baúl, aparentemente sin romper nada, no sé si con una llave maestra.

Denuncia realizada: 2025-TUC-5520.

Saludos cordiales,
Gonzalo Rivero
DNI 34.112.556`,
    expected_fields: {
      incident_date: "13/07/2025",
      incident_location: "Av. Aconquija 1800, San Miguel de Tucumán",
      vehicle_plate: "AC 903 JH",
      denuncia_policial: "si",
      police_report_number: "2025-TUC-5520",
    },
  },
  {
    id: "rc-cont-v2-08",
    case_type: "robo_contenido",
    policyholder_name: "Paula Romina Castro",
    policy_number: "POL-2025-208",
    raw_text: `hola! ayer me rompieron el vidrio del auto y me sacaron la mochila con la notebook del trabajo. una bronca barbara.

fue en la plata, calle 7 entre 47 y 48, el 15/07/2025 a la tarde. mi auto es un citroen c3 blanco, patente KLM 443.

la notebook es de la empresa asi que necesito el comprobante de la denuncia para presentarles. hice la denuncia, numero 2025-LP-2298.

fotos tengo un monton, las mando si me decis a donde.

paula`,
    expected_fields: {
      incident_date: "15/07/2025",
      incident_location: "Calle 7 entre 47 y 48, La Plata",
      vehicle_plate: "KLM 443",
      denuncia_policial: "si",
      police_report_number: "2025-LP-2298",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-cont-v2-09",
    case_type: "robo_contenido",
    policyholder_name: "Ricardo Osvaldo Peralta",
    policy_number: "POL-2025-209",
    raw_text: `Señores,

Informo sustracción de contenido de mi camioneta Toyota Hilux SRV 2022, patente AE 220 PQ, ocurrida el 10/07/2025 en horas de la noche en la localidad de Salta capital, barrio Tres Cerritos, calle Los Lapachos al 400, en la vía pública frente a mi domicilio.

Elementos sustraídos: una caja de herramientas completa, un compresor portátil, un GPS Garmin y la rueda de auxilio.

Ingresaron rompiendo el vidrio de la ventanilla trasera izquierda. La alarma no sonó.

Denuncia policial: Comisaría 3ra Salta, acta N° 2025-SAL-7781. Adjunto fotografías.

Atentamente,
Ricardo Peralta
DNI 20.554.887`,
    expected_fields: {
      incident_date: "10/07/2025",
      incident_location: "Los Lapachos 400, Tres Cerritos, Salta",
      vehicle_plate: "AE 220 PQ",
      denuncia_policial: "si",
      police_report_number: "2025-SAL-7781",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-cont-v2-10",
    case_type: "robo_contenido",
    policyholder_name: "Verónica Elizabeth Maidana",
    policy_number: "POL-2025-210",
    raw_text: `Buenas. Me robaron de adentro del auto un violín en su estuche y unas partituras. Sé que suena raro pero soy música y era mi instrumento de trabajo, vale bastante.

Fue el 08/07/2025 en Bahía Blanca, sobre calle Alsina al 200, cerca del teatro. Dejé el auto 20 minutos.

Auto: Nissan March, patente HTY 619. Me rompieron el vidrio del acompañante.

Denuncia hecha en la comisaría primera, número 2025-BB-4410. Tengo la factura de compra del violín si hace falta.

Verónica Maidana
DNI 31.887.220`,
    expected_fields: {
      incident_date: "08/07/2025",
      incident_location: "Alsina al 200, Bahía Blanca",
      vehicle_plate: "HTY 619",
      denuncia_policial: "si",
      police_report_number: "2025-BB-4410",
    },
  },

  // ── accidente_personal (10) ───────────────────────────────────────────────
  {
    id: "acc-pers-v2-01",
    case_type: "accidente_personal",
    policyholder_name: "Roberto Daniel Aguirre",
    policy_number: "POL-2025-211",
    raw_text: `Estimados,

Denuncio un accidente personal sufrido el 14/07/2025 aproximadamente a las 19:30 hs en la vereda de mi domicilio, calle Independencia 850, Godoy Cruz, Mendoza.

Al descender de mi vehículo (Fiat Cronos, patente AD 118 RT) pisé una baldosa floja y caí de costado. Me fracturé la muñeca derecha. Fui atendido en el Hospital Central de Mendoza, donde me enyesaron y me dieron 30 días de reposo.

Adjunto certificado médico y radiografía.

Quedo a la espera de novedades.

Roberto Aguirre
DNI 24.667.112`,
    expected_fields: {
      incident_date: "14/07/2025",
      incident_location: "Independencia 850, Godoy Cruz, Mendoza",
      vehicle_plate: "AD 118 RT",
      hay_heridos: "si",
    },
  },
  {
    id: "acc-pers-v2-02",
    case_type: "accidente_personal",
    policyholder_name: "Camila Ayelén Ojeda",
    policy_number: "POL-2025-212",
    raw_text: `hola, tuve un accidente andando en bici el 12/07/2025 a la mañana. iba por el carril bici de av. figueroa alcorta, caba, y una rama en el piso me hizo perder el control y me caí.

me lastimé la rodilla y la muñeca izquierda, fui a la guardia del hospital fernandez. me dijeron que tengo un esguince y me dieron reposo una semana.

no hubo otro vehiculo ni nadie mas involucrado, fue solo yo.

tengo el certificado de la guardia.

camila ojeda
dni 40.223.118`,
    expected_fields: {
      incident_date: "12/07/2025",
      incident_location: "Av. Figueroa Alcorta, CABA",
      hay_heridos: "si",
      tercero_involucrado: "no",
    },
  },
  {
    id: "acc-pers-v2-03",
    case_type: "accidente_personal",
    policyholder_name: "Néstor Fabián Coronel",
    policy_number: "POL-2025-213",
    raw_text: `Señores de la aseguradora:

El día 06/07/2025 sufrí un accidente de considerable gravedad. Me encontraba en la ruta 22 a la altura de Cipolletti, Río Negro, cambiando una rueda de mi camioneta Ford Ranger patente AB 550 GH, cuando un vehículo que pasó muy cerca me rozó y me hizo caer contra el guardarraíl.

Resultado: fractura de tibia y peroné en pierna izquierda, con cirugía. Estuve internado 4 días en el Hospital de Cipolletti. Actualmente en reposo absoluto por 60 días.

El vehículo que me rozó se dio a la fuga, no pude tomar la patente. Hice la denuncia policial, número 2025-CIP-2244.

Adjunto: certificado de internación, parte quirúrgico y denuncia.

Néstor Coronel
DNI 22.118.994`,
    expected_fields: {
      incident_date: "06/07/2025",
      incident_location: "Ruta 22, Cipolletti, Río Negro",
      vehicle_plate: "AB 550 GH",
      hay_heridos: "si",
      denuncia_policial: "si",
      police_report_number: "2025-CIP-2244",
    },
  },
  {
    id: "acc-pers-v2-04",
    case_type: "accidente_personal",
    policyholder_name: "Silvia Noemí Bustos",
    policy_number: "POL-2025-214",
    raw_text: `Buenas tardes. Escribo para avisar que me caí bajando del auto el otro día y me lastimé el tobillo. Fue el 16/07/2025 en Corrientes capital, en la calle Junín al 1100.

Tengo 68 años y me quedó el pie muy hinchado. Fui al sanatorio y me sacaron una placa, no hay fractura pero es un esguince grado 2. Me dieron bota ortopédica por 3 semanas.

El auto es un Chevrolet Corsa, no me acuerdo bien la patente ahora, la busco y se la paso.

No hubo otro auto ni nadie más.

Gracias.
Silvia Bustos`,
    expected_fields: {
      incident_date: "16/07/2025",
      incident_location: "Junín al 1100, Corrientes",
      hay_heridos: "si",
      tercero_involucrado: "no",
    },
  },
  {
    id: "acc-pers-v2-05",
    case_type: "accidente_personal",
    policyholder_name: "Julián Ezequiel Ramos",
    policy_number: "POL-2025-215",
    raw_text: `Denuncio accidente personal. 15/07/2025, 08:10 hs, Av. Colón al 3400, Córdoba.

Iba en mi moto Honda CB 190 patente A123BCD cuando un pozo profundo me hizo perder el control y caí. No hubo otro vehículo involucrado.

Lesiones: luxación de hombro derecho y escoriaciones varias. Atendido en Clínica Reina Fabiola. Me inmovilizaron el brazo, 21 días de reposo.

Denuncia policial: no hice, no hubo terceros.

Tengo fotos del pozo y certificado médico.

Julián Ramos
DNI 38.554.001`,
    expected_fields: {
      incident_date: "15/07/2025",
      incident_location: "Av. Colón 3400, Córdoba",
      vehicle_plate: "A123BCD",
      hay_heridos: "si",
      tercero_involucrado: "no",
      fotos_danos: "si",
    },
  },
  {
    id: "acc-pers-v2-06",
    case_type: "accidente_personal",
    policyholder_name: "Marta Isabel Godoy",
    policy_number: "POL-2025-216",
    raw_text: `Estimados,

Les informo que mi esposo, Héctor Godoy, titular de la póliza, sufrió un accidente el 09/07/2025 en Ushuaia, Tierra del Fuego, en la calle San Martín al 700.

Se resbaló con hielo en la vereda al bajar de la camioneta (Toyota SW4, patente AA 332 BC) y se golpeó la cabeza. Estuvo en observación 24 horas en el Hospital Regional de Ushuaia por traumatismo de cráneo leve. Ya está en casa, con controles.

Adjunto informe médico.

Marta Godoy (esposa)
DNI 18.229.443`,
    expected_fields: {
      incident_date: "09/07/2025",
      incident_location: "San Martín al 700, Ushuaia",
      vehicle_plate: "AA 332 BC",
      hay_heridos: "si",
    },
  },
  {
    id: "acc-pers-v2-07",
    case_type: "accidente_personal",
    policyholder_name: "Sebastián Nicolás Vera",
    policy_number: "POL-2025-217",
    raw_text: `me caí de la escalera cargando cosas al auto y me quebré el brazo. fue el 13/07/2025 en mi casa, calle mitre 2200, quilmes, buenos aires.

estaba subiendo unas cajas al techo del auto (peugeot partner patente LKJ 771) y me vine abajo. fractura de radio, me operaron el lunes en el sanatorio quilmes. 45 dias sin trabajar.

tengo todo, parte quirurgico, placas, certificados.

necesito saber si esto lo cubre la poliza de accidentes personales.

sebastian vera
dni 36.998.221`,
    expected_fields: {
      incident_date: "13/07/2025",
      incident_location: "Mitre 2200, Quilmes, Buenos Aires",
      vehicle_plate: "LKJ 771",
      hay_heridos: "si",
    },
  },
  {
    id: "acc-pers-v2-08",
    case_type: "accidente_personal",
    policyholder_name: "Florencia Belén Acuña",
    policy_number: "POL-2025-218",
    raw_text: `Buenos días,

Quiero denunciar un accidente personal ocurrido el 11/07/2025 alrededor de las 21:00 hs en la estación de servicio Shell de Ruta 8 km 60, Pilar, Buenos Aires.

Mientras cargaba combustible en mi Volkswagen Polo (patente AG 447 LM), me golpeé fuerte la cabeza contra la puerta del baúl que estaba levantada. Sufrí un corte en la frente que requirió 5 puntos de sutura en el Hospital Austral.

No hubo terceros involucrados ni daños al vehículo.

Adjunto certificado médico con los puntos.

Saludos,
Florencia Acuña
DNI 37.110.665`,
    expected_fields: {
      incident_date: "11/07/2025",
      incident_location: "Ruta 8 km 60, Pilar, Buenos Aires",
      vehicle_plate: "AG 447 LM",
      hay_heridos: "si",
      tercero_involucrado: "no",
    },
  },
  {
    id: "acc-pers-v2-09",
    case_type: "accidente_personal",
    policyholder_name: "Alberto Juan Miranda",
    policy_number: "POL-2025-219",
    raw_text: `Señores:

Comunico accidente personal grave. Fecha: 04/07/2025. Lugar: Autopista Rosario-Santa Fe, km 32.

Sufrí un desvanecimiento al volante de mi Renault Duster (patente AF 909 TR) y despisté, terminando en la banquina contra un poste. Fui trasladado en ambulancia al Hospital Cullen de Santa Fe con politraumatismos: fractura de dos costillas, contusión pulmonar y corte profundo en el brazo izquierdo. Permanecí internado 6 días, 3 de ellos en terapia intermedia.

Actualmente con 90 días de reposo indicado.

Se hizo denuncia policial (2025-SF-6612) e intervino Policía de Santa Fe. Adjunto toda la documentación médica y la denuncia.

Alberto Miranda
DNI 16.334.220`,
    expected_fields: {
      incident_date: "04/07/2025",
      incident_location: "Autopista Rosario-Santa Fe, km 32",
      vehicle_plate: "AF 909 TR",
      hay_heridos: "si",
      denuncia_policial: "si",
      police_report_number: "2025-SF-6612",
    },
  },
  {
    id: "acc-pers-v2-10",
    case_type: "accidente_personal",
    policyholder_name: "Daniela Soledad Figueroa",
    policy_number: "POL-2025-220",
    raw_text: `Hola, buenas. Un perro suelto se me cruzó cuando iba caminando hacia el auto y me mordió la pierna. Fue el 17/07/2025 en Villa Carlos Paz, Córdoba, sobre avenida San Martín.

Fui a la guardia, me lavaron la herida, me pusieron antitetánica y quedé con antibióticos. Son 3 mordeduras en la pantorrilla derecha.

El dueño del perro se hizo cargo y me dejó sus datos, pero quiero saber si mi póliza de accidentes personales cubre algo de esto.

Tengo fotos de las heridas y el certificado de la guardia.

Daniela Figueroa
DNI 39.001.774`,
    expected_fields: {
      incident_date: "17/07/2025",
      incident_location: "Av. San Martín, Villa Carlos Paz, Córdoba",
      hay_heridos: "si",
      tercero_involucrado: "si",
      fotos_danos: "si",
    },
  },

  // ── cristales (10) ────────────────────────────────────────────────────────
  {
    id: "crist-v2-01",
    case_type: "cristales",
    policyholder_name: "Martín Alejandro Duarte",
    policy_number: "POL-2025-221",
    raw_text: `Buenas tardes,

Solicito la reposición del parabrisas de mi vehículo. El 15/07/2025 circulando por la Ruta Nacional 9 a la altura de Zárate, un camión que iba delante levantó una piedra que impactó en el parabrisas y generó una fisura que se extendió unos 30 cm.

Vehículo: Chevrolet Cruze 2022, patente AD 667 NM.

No hubo otros daños ni heridos. El vidrio está fisurado pero no estalló, puedo circular con cuidado.

Adjunto fotos de la fisura.

Aguardo indicaciones sobre el taller.

Martín Duarte
DNI 33.998.221`,
    expected_fields: {
      incident_date: "15/07/2025",
      incident_location: "Ruta Nacional 9, Zárate",
      vehicle_plate: "AD 667 NM",
      hay_heridos: "no",
      fotos_danos: "si",
    },
  },
  {
    id: "crist-v2-02",
    case_type: "cristales",
    policyholder_name: "Nadia Gisele Ponce",
    policy_number: "POL-2025-222",
    raw_text: `hola! me rompieron el vidrio de la ventanilla del conductor pero no me robaron nada, creo que fue vandalismo. dejaron todo tirado adentro pero no falta nada.

fue el 16/07/2025 a la noche en villa crespo, caba, calle scalabrini ortiz al 800.

el auto es un ford fiesta patente JKL 992.

hice la denuncia igual por las dudas: 2025-CABA-91120.

necesito cambiar el vidrio urgente porque no puedo dejar el auto asi. fotos tengo.

nadia`,
    expected_fields: {
      incident_date: "16/07/2025",
      incident_location: "Scalabrini Ortiz al 800, Villa Crespo, CABA",
      vehicle_plate: "JKL 992",
      denuncia_policial: "si",
      police_report_number: "2025-CABA-91120",
      fotos_danos: "si",
    },
  },
  {
    id: "crist-v2-03",
    case_type: "cristales",
    policyholder_name: "Hugo Ernesto Villalba",
    policy_number: "POL-2025-223",
    raw_text: `Estimados:

El parabrisas de mi camión Iveco Tector (patente KRT 448) sufrió el impacto de una piedra el día 10/07/2025 en la Ruta 7, a la altura de Junín, provincia de Buenos Aires.

El impacto produjo un "ojo de gallo" de aproximadamente 4 cm en el lado del acompañante, que con el frío se está extendiendo.

Necesito saber si la cobertura contempla reparación o reposición completa, y si tienen taller habilitado en la zona de Junín o si debo trasladarme a Buenos Aires.

Sin heridos ni otros daños.

Atentamente,
Hugo Villalba
DNI 21.556.003`,
    expected_fields: {
      incident_date: "10/07/2025",
      incident_location: "Ruta 7, Junín, Buenos Aires",
      vehicle_plate: "KRT 448",
      hay_heridos: "no",
    },
  },
  {
    id: "crist-v2-04",
    case_type: "cristales",
    policyholder_name: "Carolina Andrea Vega",
    policy_number: "POL-2025-224",
    raw_text: `Buen día. Amanecí con el vidrio trasero (la luneta) del auto totalmente destruido. Vivo en Rosario, calle Mendoza al 4500, y el auto estaba en la vereda. Fue durante la noche del 14/07/2025.

Aparentemente fue una piedra o algo que tiraron, porque no falta nada adentro.

Auto: Fiat Argo, patente AE 118 KP.

Hice la denuncia: 2025-R4-3390. Mando fotos, quedó todo el vidrio hecho pedazos en el baúl.

Carolina Vega
DNI 34.667.889`,
    expected_fields: {
      incident_date: "14/07/2025",
      incident_location: "Mendoza al 4500, Rosario",
      vehicle_plate: "AE 118 KP",
      denuncia_policial: "si",
      police_report_number: "2025-R4-3390",
      fotos_danos: "si",
    },
  },
  {
    id: "crist-v2-05",
    case_type: "cristales",
    policyholder_name: "Emiliano Gastón Ruiz",
    policy_number: "POL-2025-225",
    raw_text: `Se me rajó el parabrisas solo, sin que me pegara nada. Amaneció con una fisura larga desde abajo. Me dijeron que puede pasar por el cambio brusco de temperatura, acá en Bariloche hizo -8 y después lo dejé al sol.

Fecha: 12/07/2025. Lugar: San Carlos de Bariloche, Río Negro.

Vehículo: Jeep Renegade, patente AB 990 CD.

¿Esto está cubierto? Nunca me pasó. Tengo fotos.

Emiliano Ruiz
DNI 35.220.117`,
    expected_fields: {
      incident_date: "12/07/2025",
      incident_location: "San Carlos de Bariloche, Río Negro",
      vehicle_plate: "AB 990 CD",
      fotos_danos: "si",
    },
  },
  {
    id: "crist-v2-06",
    case_type: "cristales",
    policyholder_name: "Patricia Mónica Leiva",
    policy_number: "POL-2025-226",
    raw_text: `Estimados, buenos días.

Escribo para denunciar la rotura del espejo retrovisor derecho y el vidrio de esa puerta de mi vehículo Honda Fit, patente HGF 220.

Ocurrió el 13/07/2025 en la calle Rivadavia al 1500, San Miguel de Tucumán, cuando pasó un colectivo muy cerca y me lo llevó puesto. El colectivo no se detuvo.

No hubo heridos. Solo el daño en el espejo y el vidrio de la ventanilla.

Hice la denuncia policial (2025-TUC-6640) por si aparece el responsable. Adjunto fotos.

Muchas gracias.
Patricia Leiva
DNI 26.887.334`,
    expected_fields: {
      incident_date: "13/07/2025",
      incident_location: "Rivadavia al 1500, San Miguel de Tucumán",
      vehicle_plate: "HGF 220",
      hay_heridos: "no",
      denuncia_policial: "si",
      police_report_number: "2025-TUC-6640",
      fotos_danos: "si",
    },
  },
  {
    id: "crist-v2-07",
    case_type: "cristales",
    policyholder_name: "Cristian Damián Alvez",
    policy_number: "POL-2025-227",
    raw_text: `parabrisas roto por piedra en ruta 40 cerca de malargue, mendoza. 08/07/2025.

toyota corolla patente MNB 553.

el pozo del impacto es chico pero justo en la linea de vision del conductor asi que me dijeron que hay que cambiarlo entero.

fotos adjuntas. sin heridos.

cristian alvez`,
    expected_fields: {
      incident_date: "08/07/2025",
      incident_location: "Ruta 40, Malargüe, Mendoza",
      vehicle_plate: "MNB 553",
      hay_heridos: "no",
      fotos_danos: "si",
    },
  },
  {
    id: "crist-v2-08",
    case_type: "cristales",
    policyholder_name: "Gabriela Inés Sandoval",
    policy_number: "POL-2025-228",
    raw_text: `Buenas. Les cuento que en el temporal del fin de semana pasado (05/07/2025) se me voló una chapa de la obra de al lado y me rompió el vidrio del techo corredizo del auto.

Estaba estacionado en mi cochera descubierta, en Posadas, Misiones, barrio Villa Cabello.

El auto es un Volkswagen T-Cross, patente AF 220 GH. Solo se rompió el vidrio del techo, la chapa del auto no se dañó.

Tengo fotos de la chapa que se voló y del vidrio roto. También el pronóstico del día que confirma el temporal.

¿Esto entra por cristales o por otra cobertura?

Gabriela Sandoval
DNI 32.114.556`,
    expected_fields: {
      incident_date: "05/07/2025",
      incident_location: "Villa Cabello, Posadas, Misiones",
      vehicle_plate: "AF 220 GH",
      fotos_danos: "si",
    },
  },
  {
    id: "crist-v2-09",
    case_type: "cristales",
    policyholder_name: "Leonardo Iván Barrios",
    policy_number: "POL-2025-229",
    raw_text: `Señores de la compañía:

Denuncio rotura de cristal. El día 17/07/2025, en el estacionamiento del Aeropuerto de Ezeiza (sector larga estancia), encontré el vidrio de la ventanilla trasera izquierda de mi vehículo roto al regresar de un viaje.

Vehículo: Nissan Kicks 2023, patente AG 771 BM.

No falta nada del interior. Presumo intento de robo frustrado o vandalismo. El auto estuvo estacionado desde el 10/07 al 17/07.

Solicité el video de las cámaras al estacionamiento. Denuncia policial en trámite.

Adjunto fotografías del daño.

Leonardo Barrios
DNI 33.556.998`,
    expected_fields: {
      incident_date: "17/07/2025",
      incident_location: "Aeropuerto de Ezeiza, estacionamiento",
      vehicle_plate: "AG 771 BM",
      fotos_danos: "si",
    },
  },
  {
    id: "crist-v2-10",
    case_type: "cristales",
    policyholder_name: "Rosa María Ledesma",
    policy_number: "POL-2025-230",
    raw_text: `Hola buenas tardes quisiera hacer el reclamo del parabrisas de mi auto que se rompio con una piedra en la ruta. Fue el 11 de julio de este año, iba de Santiago del Estero a Termas de Río Hondo por la ruta 9.

El auto es un Chevrolet Spin, la patente es OLK 338.

La verdad no se mucho de estos tramites, es la primera vez que uso el seguro. Me dijeron que tengo que mandar fotos, las saqué con el celular. ¿A dónde las mando? ¿Necesito hacer denuncia policial para esto?

Muchas gracias por la ayuda.
Rosa Ledesma
DNI 14.667.220`,
    expected_fields: {
      incident_date: "11/07/2025",
      incident_location: "Ruta 9, entre Santiago del Estero y Termas de Río Hondo",
      vehicle_plate: "OLK 338",
      fotos_danos: "si",
    },
  },

  // ── rc / responsabilidad civil (10) ───────────────────────────────────────
  {
    id: "rc-v2-01",
    case_type: "rc",
    policyholder_name: "Esteban Rodrigo Cabrera",
    policy_number: "POL-2025-231",
    raw_text: `Estimados,

Debo informar un siniestro con daños a terceros. El 15/07/2025 a las 14:20 hs, en Av. Rafael Núñez al 4200, Córdoba, al salir de una cochera no vi una moto que circulaba por la derecha y la impacté.

Mi vehículo: Toyota Corolla Cross, patente AF 118 MN. Daños en mi auto: mínimos, un rayón en el paragolpes.

Tercero: moto Yamaha YBR patente A778JKL, conducida por Iván Sosa (DNI 41.223.887). La moto quedó con la rueda delantera doblada y el carenado roto. El conductor sufrió golpes en la pierna y raspones, fue trasladado en ambulancia al Hospital de Urgencias pero le dieron el alta el mismo día.

Intervino policía, acta 2025-CBA-8823. Ambos hicimos la denuncia.

Adjunto fotos de ambos vehículos y los datos del tercero.

Esteban Cabrera
DNI 30.556.114`,
    expected_fields: {
      incident_date: "15/07/2025",
      incident_location: "Av. Rafael Núñez 4200, Córdoba",
      vehicle_plate: "AF 118 MN",
      tercero_involucrado: "si",
      hay_heridos: "si",
      denuncia_policial: "si",
      police_report_number: "2025-CBA-8823",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-v2-02",
    case_type: "rc",
    policyholder_name: "Analía Verónica Ferrari",
    policy_number: "POL-2025-232",
    raw_text: `Buenas tardes,

Les escribo porque ayer 16/07/2025 haciendo marcha atrás en el estacionamiento del supermercado Coto de Ramos Mejía le pegué a un auto que estaba estacionado. No había nadie adentro.

Mi auto: Peugeot 2008, patente AD 990 KR. Casi no tiene daño.

El otro auto es un Renault Clio patente FGH 224. Le hundí la puerta trasera derecha. Esperé al dueño, que se llama Marcelo Duarte (DNI 28.114.667), le dejé mis datos y le saqué fotos al daño.

No hubo heridos, no intervino policía porque fue dentro del estacionamiento privado y arreglamos de palabra que lo hago por el seguro.

Adjunto fotos y los datos de él.

Analía Ferrari
DNI 31.998.220`,
    expected_fields: {
      incident_date: "16/07/2025",
      incident_location: "Estacionamiento Coto, Ramos Mejía",
      vehicle_plate: "AD 990 KR",
      tercero_involucrado: "si",
      hay_heridos: "no",
      denuncia_policial: "no",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-v2-03",
    case_type: "rc",
    policyholder_name: "Marcos Aníbal Ferreira",
    policy_number: "POL-2025-233",
    raw_text: `le pegue a un portón de una casa haciendo maniobra. 13/07/2025, calle las heras al 900, san rafael, mendoza.

mi camioneta ford ranger patente AB 447 TY, no tiene casi nada, un rayon.

el portón del vecino quedó abollado y salido de la guía, no cierra bien. el dueño se llama omar quiroga, me dio el telefono. dice que el arreglo sale como 400 lucas.

no hubo heridos ni policia. le saque fotos al portón.

necesito saber como sigue esto por responsabilidad civil.

marcos ferreira
dni 29.887.114`,
    expected_fields: {
      incident_date: "13/07/2025",
      incident_location: "Las Heras al 900, San Rafael, Mendoza",
      vehicle_plate: "AB 447 TY",
      tercero_involucrado: "si",
      hay_heridos: "no",
      denuncia_policial: "no",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-v2-04",
    case_type: "rc",
    policyholder_name: "Valeria Noelia Ibáñez",
    policy_number: "POL-2025-234",
    raw_text: `Señores:

Denuncio siniestro con lesiones a tercero, de carácter grave.

Fecha: 10/07/2025, 07:45 hs. Lugar: Av. Vélez Sarsfield y Bv. San Juan, Córdoba capital.

Circulando con mi Volkswagen Vento (patente AE 220 LK) con el semáforo en verde, un peatón cruzó fuera de la senda peatonal y lo embestí a baja velocidad. El peatón, Carlos Molina (DNI 19.554.220, 67 años), sufrió fractura de cadera y fue trasladado en ambulancia al Hospital Córdoba, donde permanece internado y será operado.

Mi vehículo tiene el capot abollado y el faro derecho roto.

Intervino la policía y se labró acta 2025-CBA-9910. Se realizó test de alcoholemia con resultado negativo.

Estoy muy consternada por lo sucedido. Adjunto toda la documentación. Solicito me indiquen los pasos a seguir con urgencia.

Valeria Ibáñez
DNI 32.667.001`,
    expected_fields: {
      incident_date: "10/07/2025",
      incident_location: "Av. Vélez Sarsfield y Bv. San Juan, Córdoba",
      vehicle_plate: "AE 220 LK",
      tercero_involucrado: "si",
      hay_heridos: "si",
      denuncia_policial: "si",
      police_report_number: "2025-CBA-9910",
    },
  },
  {
    id: "rc-v2-05",
    case_type: "rc",
    policyholder_name: "Damián Alberto Rossi",
    policy_number: "POL-2025-235",
    raw_text: `Buen día,

Informo que el 14/07/2025 en la Av. Pellegrini al 2800 de Rosario, frené de golpe por un corte de calle y el auto de atrás no llegó a frenar y me chocó. Sin embargo, por el impacto yo me fui contra el auto de adelante y le rompí el paragolpes trasero.

O sea que yo soy tercero del de atrás, pero responsable frente al de adelante.

Mi vehículo: Citroën C4 Cactus, patente AC 118 PL. Daños adelante y atrás.

Auto de adelante (al que dañé): Fiat Cronos patente AD 554 MK, titular Sandra Coria (DNI 30.114.887). Paragolpes trasero roto y baúl con juego.

Auto de atrás: Chevrolet Onix patente AB 990 RT, titular Pedro Lima.

Ninguno tuvo heridos. Intervino policía, acta 2025-ROS-4471. Todos intercambiamos datos y hay fotos.

Quedo atento.
Damián Rossi
DNI 31.223.554`,
    expected_fields: {
      incident_date: "14/07/2025",
      incident_location: "Av. Pellegrini 2800, Rosario",
      vehicle_plate: "AC 118 PL",
      tercero_involucrado: "si",
      hay_heridos: "no",
      denuncia_policial: "si",
      police_report_number: "2025-ROS-4471",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-v2-06",
    case_type: "rc",
    policyholder_name: "Lorena Beatriz Ocampo",
    policy_number: "POL-2025-236",
    raw_text: `Hola, buenas tardes.

Ayer 17/07/2025 le rompí la vidriera a un local con el auto. Fue en La Plata, calle 12 entre 60 y 61. Estaba estacionando y en vez del freno pisé el acelerador, subí a la vereda y le pegué al vidrio del local, que es una farmacia.

Por suerte no había gente en la vereda ni adentro cerca del vidrio, así que no hubo heridos.

Mi auto: Ford Ka, patente KJH 552. Tiene el paragolpes delantero roto.

El local se llama Farmacia del Centro, el dueño es Norberto Paz. La vidriera quedó destrozada completa.

Vino la policía e hizo un acta, número 2025-LP-7789. Hay fotos de todo.

Estoy muy nerviosa, es la primera vez que me pasa algo así. ¿Qué tengo que hacer?

Lorena Ocampo
DNI 33.887.220`,
    expected_fields: {
      incident_date: "17/07/2025",
      incident_location: "Calle 12 entre 60 y 61, La Plata",
      vehicle_plate: "KJH 552",
      tercero_involucrado: "si",
      hay_heridos: "no",
      denuncia_policial: "si",
      police_report_number: "2025-LP-7789",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-v2-07",
    case_type: "rc",
    policyholder_name: "Ignacio Tomás Peña",
    policy_number: "POL-2025-237",
    raw_text: `Denuncio choque con daños a tercero.

11/07/2025, 18:00 hs, rotonda de acceso a Neuquén capital por Ruta 22.

Yo venía por la rotonda y un auto que entraba no me cedió el paso... pero según la policía la responsabilidad es mía porque él ya estaba dentro de la rotonda. Acepto que el acta me da a mí como responsable.

Mi vehículo: Volkswagen Amarok, patente AF 663 KL. Daños en el lateral izquierdo.

Tercero: Toyota Yaris patente MKL 220, titular Andrea Vidal (DNI 34.556.112). Le rompí la puerta del conductor y el guardabarros. Ella refiere dolor en el cuello pero no quiso ambulancia, se fue por sus medios a un centro médico.

Acta policial: 2025-NQN-3320.

Fotos adjuntas de ambos autos.

Ignacio Peña
DNI 35.114.998`,
    expected_fields: {
      incident_date: "11/07/2025",
      incident_location: "Rotonda Ruta 22, acceso a Neuquén capital",
      vehicle_plate: "AF 663 KL",
      tercero_involucrado: "si",
      hay_heridos: "si",
      denuncia_policial: "si",
      police_report_number: "2025-NQN-3320",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-v2-08",
    case_type: "rc",
    policyholder_name: "Claudio Ramón Ávila",
    policy_number: "POL-2025-238",
    raw_text: `Estimados:

El 09/07/2025 en la localidad de Salta capital, calle Caseros al 1200, al abrir la puerta de mi auto estacionado sin mirar, un ciclista que venía por la derecha se llevó la puerta puesta y cayó al piso.

Mi auto: Renault Kwid, patente AB 771 MK. La puerta del conductor quedó doblada.

El ciclista, Matías Ferreyra (DNI 42.118.003), sufrió fractura de clavícula y varias escoriaciones. Fue trasladado al Hospital San Bernardo, lo operaron. La bicicleta quedó con la rueda delantera destruida.

Reconozco mi responsabilidad, abrí sin mirar el espejo.

Intervino la policía: acta 2025-SAL-9902. Hay testigos y fotos.

Necesito saber cómo procede la cobertura de responsabilidad civil, tanto por las lesiones como por la bicicleta.

Claudio Ávila
DNI 27.556.114`,
    expected_fields: {
      incident_date: "09/07/2025",
      incident_location: "Caseros al 1200, Salta capital",
      vehicle_plate: "AB 771 MK",
      tercero_involucrado: "si",
      hay_heridos: "si",
      denuncia_policial: "si",
      police_report_number: "2025-SAL-9902",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-v2-09",
    case_type: "rc",
    policyholder_name: "Mónica Alejandra Ruiz Díaz",
    policy_number: "POL-2025-239",
    raw_text: `le di un golpe a un auto y me fui sin darme cuenta, despues me llamaron. resulta que en el estacionamiento del shopping de mendoza (palmares) el 12/07/2025 rocé un auto al salir y no lo senti. me dejaron una nota en el parabrisas con el telefono y las camaras me identificaron.

mi auto: chevrolet tracker patente AE 990 HK

el otro auto es un honda civic patente NHK 447, del señor gustavo rey. le raye toda la puerta y el guardabarros trasero.

ya hablé con el, le pedí disculpas, no hubo heridos ni policia. quiere que lo arregle por seguro.

le mandé fotos y tengo su numero.

monica ruiz diaz
dni 30.998.556`,
    expected_fields: {
      incident_date: "12/07/2025",
      incident_location: "Estacionamiento Shopping Palmares, Mendoza",
      vehicle_plate: "AE 990 HK",
      tercero_involucrado: "si",
      hay_heridos: "no",
      denuncia_policial: "no",
      fotos_danos: "si",
    },
  },
  {
    id: "rc-v2-10",
    case_type: "rc",
    policyholder_name: "Fernando Luis Aguilar",
    policy_number: "POL-2025-240",
    raw_text: `Buenos días,

Comunico un siniestro de responsabilidad civil ocurrido el 08/07/2025 en la Ruta Provincial 11, altura Villa Gesell.

Perdí el control por la calzada mojada y despisté, impactando contra el alambrado y el tinglado de un establecimiento rural lindero. Derribé aproximadamente 20 metros de alambrado y dañé un portón de acceso.

Mi vehículo: Ford Territory, patente AG 118 NP. Daños importantes en el frente.

El propietario del campo es Establecimiento La Amistad, contacto Juan Carlos Duarte, quien ya me pasó un presupuesto por el alambrado.

No hubo heridos, salvo golpes leves míos que no requirieron atención.

Intervino Policía Vial, acta 2025-VG-2214. Adjunto fotos del alambrado, del portón y de mi vehículo.

Atentamente,
Fernando Aguilar
DNI 28.334.771`,
    expected_fields: {
      incident_date: "08/07/2025",
      incident_location: "Ruta Provincial 11, Villa Gesell",
      vehicle_plate: "AG 118 NP",
      tercero_involucrado: "si",
      hay_heridos: "no",
      denuncia_policial: "si",
      police_report_number: "2025-VG-2214",
      fotos_danos: "si",
    },
  },
];
