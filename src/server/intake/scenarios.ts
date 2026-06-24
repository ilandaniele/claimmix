/**
 * 55 realistic Argentine insurance claim scenarios for intake simulation.
 *
 * Distribution:
 *   10 × choque   (street accidents, various provinces)
 *   10 × robo     (vehicle theft, with and without police report)
 *   10 × granizo  (hail damage events)
 *   10 × incendio (fire damage)
 *    5 × other    (no-relevante: non-claim emails)
 *    5 × other    (parcial: partial info — missing key fields)
 *    5 × other    (edge cases: forwarded threads, contradictions, complexity)
 *
 * Each scenario has:
 *   id:               unique identifier
 *   case_type:        "choque" | "robo" | "granizo" | "incendio" | "other"
 *   policyholder_name: insured person's name (PII — stored, never logged)
 *   policy_number:    policy number (PII — stored, never logged)
 *   raw_text:         realistic Argentine Spanish email body
 *   expected_fields:  fields the extractor should find (used in tests)
 *
 * AC8: Mock extractor derives confidence from keyword presence in raw_text.
 * T21: These scenarios are returned by POST /api/intake/simulate.
 */

import type { ClaimType } from "@/lib/schemas/cases";

export interface SimulationScenario {
  id: string;
  case_type: ClaimType;
  policyholder_name: string;
  policy_number: string;
  raw_text: string;
  expected_fields: Record<string, string>;
}

export const SCENARIOS: SimulationScenario[] = [
  // ── CHOQUE ──────────────────────────────────────────────────────────────────

  {
    id: "choque-01",
    case_type: "choque",
    policyholder_name: "Martín Ezequiel Rodríguez",
    policy_number: "POL-2024-001",
    raw_text: `Estimados señores de la aseguradora:

Me dirijo a ustedes para comunicarles que el día 15/03/2024, aproximadamente a las 09:30 hs, sufrí un accidente de tránsito en la Avenida Corrientes al 2400, esquina con Billinghurst, en el barrio de Balvanera, Ciudad Autónoma de Buenos Aires.

Mi vehículo, un Ford Focus 2020, patente ABC 123, chocó con un Volkswagen Gol, patente XY 456 BC, conducido por el Sr. Roberto Fernández DNI 28.456.789, domiciliado en Av. Rivadavia 3200.

Los daños en mi vehículo son: abolladuras en el paragolpes delantero, capot deformado, faro izquierdo roto y radiador con pérdida de refrigerante. Estimo los daños en aproximadamente $450.000 pesos.

Adjunto el parte amistoso de accidente firmado por ambas partes, copia de mi licencia de conducir y fotos de los daños tomadas en el lugar del siniestro.

Quedo a su disposición para cualquier información adicional.
Saludos cordiales,
Martín Rodríguez
Teléfono: 11-4523-6789`,
    expected_fields: {
      incident_date: "15/03/2024",
      incident_location: "Avenida Corrientes al 2400",
      party_a_plate: "ABC 123",
      party_b_plate: "XY 456 BC",
      parte_amistoso: "si",
      fotos_danos: "si",
      licencia_conducir: "si",
    },
  },

  {
    id: "choque-02",
    case_type: "choque",
    policyholder_name: "Valentina Lucía Herrera",
    policy_number: "POL-2024-002",
    raw_text: `Buenos días,

El pasado 22/04/2024 a las 18:45 sufrí un choque en la intersección de la calle Honduras y Thames, Palermo, CABA.

Conducía mi Chevrolet Onix 2022 patente DEF 456 cuando un Renault Sandero patente GH 789 IJ invadió mi carril y colisionó con el lateral derecho de mi auto. El conductor del otro vehículo es Juan Carlos Méndez.

Daños visibles: abolladura profunda en puerta delantera derecha, espejo retrovisor destruido y rayones en el faldón lateral.

Tengo la licencia de conducir vigente. Completamos el parte amistoso en el lugar. No pude tomar fotos porque no tenía batería en el celular.

Atentamente,
Valentina Herrera`,
    expected_fields: {
      incident_date: "22/04/2024",
      incident_location: "calle Honduras y Thames",
      party_a_plate: "DEF 456",
      party_b_plate: "GH 789 IJ",
      parte_amistoso: "si",
      fotos_danos: "no",
      licencia_conducir: "si",
    },
  },

  {
    id: "choque-03",
    case_type: "choque",
    policyholder_name: "Carlos Alberto Gómez",
    policy_number: "POL-2024-003",
    raw_text: `A quien corresponda:

Soy titular de la póliza 0000-0003. El 08/05/2024 a las 07:15 hs, en el cruce de 9 de Julio y Diagonal Norte, sufrí un siniestro. Un colectivo de la línea 160 patente MNO 789 no respetó el semáforo en rojo e impactó contra el lateral de mi Toyota Corolla patente PQ 012 RS.

Los daños son cuantiosos: puerta trasera derecha completamente destruida, estribo doblado, ventanilla rota con vidrios en el interior del habitáculo. Hay riesgo de que la carrocería tenga daño estructural.

Tengo fotos de los daños y del semáforo. También tengo testigos del accidente. Mi licencia de conducir está al día. Por razones de tiempo no pude completar el parte amistoso en el lugar — el conductor del colectivo tampoco quería firmarlo.

Carlos Gómez
DNI 31.234.567`,
    expected_fields: {
      incident_date: "08/05/2024",
      incident_location: "9 de Julio y Diagonal Norte",
      party_a_plate: "PQ 012 RS",
      party_b_plate: "MNO 789",
      parte_amistoso: "no",
      fotos_danos: "si",
      licencia_conducir: "si",
    },
  },

  {
    id: "choque-04",
    case_type: "choque",
    policyholder_name: "Luciana Beatriz Suárez",
    policy_number: "POL-2024-004",
    raw_text: `Hola, buenos días.

Les escribo para reportar un accidente ocurrido ayer 2024-06-10 a las 22:00 aprox, en la Avenida Santa Fe 3800, Palermo.

Mi auto Honda City 2021 patente STU 321 fue embestido por detrás por un Peugeot 208 patente VW 654 XY, cuyo conductor (Diego Marcelo Castro) no frenó a tiempo en el semáforo.

Daños: paragolpes trasero destrozado, portaequipaje deformado, luces traseras rotas. El golpe fue bastante fuerte, hay que revisar el chasis.

Adjunto: parte amistoso firmado, fotos del accidente tomadas con el celular, y copia de mi registro de conducir.

Gracias,
Luciana Suárez`,
    expected_fields: {
      incident_date: "2024-06-10",
      incident_location: "Avenida Santa Fe 3800",
      party_a_plate: "STU 321",
      party_b_plate: "VW 654 XY",
      parte_amistoso: "si",
      fotos_danos: "si",
      licencia_conducir: "si",
    },
  },

  {
    id: "choque-05",
    case_type: "choque",
    policyholder_name: "Federico Manuel Torres",
    policy_number: "POL-2024-005",
    raw_text: `Estimados,

Informo siniestro ocurrido el 14/07/2024 en Avenida Rivadavia y Boyacá, Flores, a las 14:20 hs.

Vehículo propio: Fiat Palio 2019, patente ZAB 111. Otro vehículo: Citroën Berlingo patente CD 222 EF, conductor Sr. Tomás Aguirre.

El Berlingo cruzó en doble mano y chocó de frente contra mi auto. Daños severos en la parte delantera: paragolpes, capot, faros, radiador y airbags activados.

No completamos parte amistoso porque el otro conductor se negó. Sí cuento con fotos. No tengo copia de mi licencia a mano pero está vigente.

Federico Torres`,
    expected_fields: {
      incident_date: "14/07/2024",
      incident_location: "Avenida Rivadavia y Boyacá",
      party_a_plate: "ZAB 111",
      party_b_plate: "CD 222 EF",
      parte_amistoso: "no",
      fotos_danos: "si",
      licencia_conducir: "si",
    },
  },

  {
    id: "choque-06",
    case_type: "choque",
    policyholder_name: "Nadia Soledad Vega",
    policy_number: "POL-2024-021",
    raw_text: `Estimados señores:

Les informo un siniestro ocurrido el 03/08/2024 a las 11:10 hs en la intersección de Bv. San Juan y Deán Funes, ciudad de Córdoba.

Conducía mi Volkswagen Virtus 2023 patente LMN 345 cuando un Renault Kangoo patente OP 678 QR, conducido por el Sr. Ariel Domingo Paz, no respetó la señal de PARE e impactó contra el lateral izquierdo de mi rodado.

Como consecuencia del choque resultaron heridas dos personas: yo misma (contusión en el hombro derecho, fui atendida en el Hospital de Urgencias de Córdoba) y mi acompañante Romina Castro, quien sufrió un traumatismo en la rodilla.

Se labró un acta policial con número 2024-CBA-11204. Completamos el parte amistoso de accidente. Cuento con fotos de los daños y del lugar. Mi licencia está vigente.

Nadia Vega
DNI 37.654.321
Tel: 351-4789-0123`,
    expected_fields: {
      incident_date: "03/08/2024",
      incident_location: "Bv. San Juan y Deán Funes, Córdoba",
      party_a_plate: "LMN 345",
      party_b_plate: "OP 678 QR",
      parte_amistoso: "si",
      fotos_danos: "si",
      licencia_conducir: "si",
      heridos: "si",
      acta_policial: "2024-CBA-11204",
    },
  },

  {
    id: "choque-07",
    case_type: "choque",
    policyholder_name: "Rodrigo Ezequiel Mansilla",
    policy_number: "POL-2024-022",
    raw_text: `Buenos días:

El 19/09/2024 a las 21:45 hs sufrí un siniestro en la calle Entre Ríos 1800, Rosario, Santa Fe. Un vehículo que no pude identificar chocó contra el lateral trasero izquierdo de mi Toyota Etios 2020 patente RST 901 y se dio a la fuga sin detenerse.

Se trata de un choque y fuga. No pude ver la patente del otro vehículo. Hay testigos en el lugar — la señora Graciela Oviedo, que vive en Entre Ríos 1812, presenció el impacto y está dispuesta a declarar.

Radicé la denuncia por fuga ante la Comisaría 6° de Rosario, expediente número 2024-ROS-4455. Cuento con fotos de los daños. Mi licencia está al día.

Rodrigo Mansilla
DNI 40.123.987`,
    expected_fields: {
      incident_date: "19/09/2024",
      incident_location: "calle Entre Ríos 1800, Rosario",
      party_a_plate: "RST 901",
      parte_amistoso: "no",
      fotos_danos: "si",
      licencia_conducir: "si",
      denuncia_policial: "si",
      police_report_number: "2024-ROS-4455",
      testigos: "si",
    },
  },

  {
    id: "choque-08",
    case_type: "choque",
    policyholder_name: "Florencia Jimena Cabrera",
    policy_number: "POL-2024-023",
    raw_text: `Hola,

Escribo para denunciar un siniestro en estacionamiento privado ocurrido el 28/10/2024 aproximadamente a las 16:00 hs en el supermercado Carrefour de calle Colón 350, Mendoza capital.

Dejé mi Nissan Versa 2021 patente UVW 234 estacionado en el playón del supermercado. Cuando regresé encontré que el paragolpes trasero y la luneta habían sido golpeados. No había ningún vehículo ni nota en el lugar.

Pedí las imágenes de las cámaras de seguridad al encargado del supermercado, que me dijo que iba a consultarlo con la gerencia pero que no podía comprometerse a nada. Saqué fotos de los daños en el lugar. Tengo mi licencia vigente. No hay parte amistoso ni datos del otro conductor.

Florencia Cabrera
DNI 38.765.432`,
    expected_fields: {
      incident_date: "28/10/2024",
      incident_location: "Carrefour Colón 350, Mendoza",
      party_a_plate: "UVW 234",
      parte_amistoso: "no",
      fotos_danos: "si",
      licencia_conducir: "si",
    },
  },

  {
    id: "choque-09",
    case_type: "choque",
    policyholder_name: "Maximiliano Hernán Quiroga",
    policy_number: "POL-2024-024",
    raw_text: `A quien corresponda:

El 12/11/2024 a las 07:30 hs ocurrió un accidente de tránsito sobre la Ruta Nacional 40 a la altura del km 1.120, en las afueras de San Carlos de Bariloche, Neuquén.

Mi vehículo, un Ford Ranger 2022 patente XYZ 567, fue embestido lateralmente por un camión frigorífico Mercedes Benz Actros patente AB 890 CD, que perdió el control en una curva mojada. Los daños en mi vehículo son severos: toda la trayectoria del lateral izquierdo destruida, ruedas dobladas, estribo arrancado.

No completamos parte amistoso porque el conductor del camión alegó no poder moverse hasta que llegara la empresa de transportes. Cuento con fotos del lugar y de los daños tomadas desde el celular. La policía de caminos labró el acta de accidente: número 2024-RN40-078.

Mi licencia está vigente.

Maximiliano Quiroga
DNI 29.876.543`,
    expected_fields: {
      incident_date: "12/11/2024",
      incident_location: "Ruta Nacional 40 km 1.120, Bariloche",
      party_a_plate: "XYZ 567",
      party_b_plate: "AB 890 CD",
      parte_amistoso: "no",
      fotos_danos: "si",
      licencia_conducir: "si",
      acta_policial: "2024-RN40-078",
    },
  },

  {
    id: "choque-10",
    case_type: "choque",
    policyholder_name: "Susana Patricia Molina",
    policy_number: "POL-2024-025",
    raw_text: `Estimados:

El día 25/11/2024 a las 15:20 hs ocurrió un accidente de tránsito en la calle Laprida 900 esquina San Martín, San Miguel de Tucumán.

Mi auto, un Chevrolet Cruze 2020 patente BCA 678, fue golpeado por un Volkswagen Polo patente DE 901 FG cuando salía de un estacionamiento en batería. El conductor es el Sr. Eduardo Nieva. No quisimos completar el parte amistoso porque discutimos sobre la responsabilidad.

Sin embargo, hay tres testigos que presenciaron la maniobra: el kiosquero de la esquina (Laprida 902), una señora que estaba esperando el colectivo y un repartidor de delivery. No pude tomar sus datos en el momento pero puedo volver al lugar.

Tengo fotos de los daños y del lugar. Licencia al día.

Susana Molina
DNI 34.234.567`,
    expected_fields: {
      incident_date: "25/11/2024",
      incident_location: "calle Laprida 900, Tucumán",
      party_a_plate: "BCA 678",
      party_b_plate: "DE 901 FG",
      parte_amistoso: "no",
      fotos_danos: "si",
      licencia_conducir: "si",
      testigos: "si",
    },
  },

  // ── ROBO ────────────────────────────────────────────────────────────────────

  {
    id: "robo-01",
    case_type: "robo",
    policyholder_name: "Alejandro Sebastián Morales",
    policy_number: "POL-2024-006",
    raw_text: `Buenos días,

Les comunico que el día 03/08/2024 entre las 02:00 y las 07:30 hs me sustrajeron el vehículo de la vía pública. El automóvil, un Volkswagen Vento 2022 patente GHI 456, estaba estacionado en la calle Charcas 1200, Recoleta, CABA.

Al salir de casa por la mañana noté que el vehículo no estaba. Radicamos la denuncia policial ante la Comisaría 13° de la CABA bajo el número de denuncia 2024-CABA-00834.

Adjunto fotos del lugar donde estaba estacionado el vehículo.

Alejandro Morales
DNI 35.123.456`,
    expected_fields: {
      incident_date: "03/08/2024",
      incident_location: "calle Charcas 1200",
      vehicle_plate: "GHI 456",
      denuncia_policial: "si",
      police_report_number: "2024-CABA-00834",
      fotos_lugar: "si",
    },
  },

  {
    id: "robo-02",
    case_type: "robo",
    policyholder_name: "María Josefina Ramírez",
    policy_number: "POL-2024-007",
    raw_text: `A quien corresponda:

El 18/09/2024 me robaron el auto. Era un Renault Clio 2020 patente JKL 789, color rojo, que tenía estacionado en el estacionamiento del Shopping Unicenter, Martínez, Buenos Aires.

Cuando salí del shopping a las 20:30 el auto ya no estaba. Hice la denuncia ante la Comisaría de Martínez, número de expediente 789/2024.

Lamentablemente no tengo fotos del lugar porque el estacionamiento es cubierto.

Por favor contáctenme al 11-5678-9012 para coordinar.

María Ramírez`,
    expected_fields: {
      incident_date: "18/09/2024",
      vehicle_plate: "JKL 789",
      denuncia_policial: "si",
      police_report_number: "789/2024",
      fotos_lugar: "no",
    },
  },

  {
    id: "robo-03",
    case_type: "robo",
    policyholder_name: "Diego Ernesto Villalobos",
    policy_number: "POL-2024-008",
    raw_text: `Hola,

Informo robo de vehículo. Mi Ford Ranger 2021 patente MNO 012, color gris, fue sustraída el 25/10/2024 de noche (calculo entre las 23:00 y las 06:00 del día siguiente).

Estaba estacionada en Av. Libertador 5600, Núñez. Por la mañana ya no estaba.

Fui a radicar la denuncia pero la comisaría me dijo que tenía que esperar 72 hs. Todavía no la tengo. Voy a ir hoy.

Tengo fotos del lugar donde estaba el auto.

Diego Villalobos`,
    expected_fields: {
      incident_date: "25/10/2024",
      incident_location: "Av. Libertador 5600",
      vehicle_plate: "MNO 012",
      denuncia_policial: "no",
      fotos_lugar: "si",
    },
  },

  {
    id: "robo-04",
    case_type: "robo",
    policyholder_name: "Silvana Andrea Bogado",
    policy_number: "POL-2024-009",
    raw_text: `Estimados señores:

Me robaron el Toyota Corolla patente PQR 345 el día 2024-11-05. Estaba en la Avenida Cabildo 3500, Belgrano, a las 08:15 hs. Dos sujetos con arma me interceptaron cuando bajaba del vehículo (robo a mano armada).

Radicé la denuncia policial de forma inmediata. Número de denuncia: n° 2024-12345-DPTO. Adjunto comprobante de la denuncia y fotos del lugar del hecho tomadas por la policía.

Silvana Bogado
DNI 39.876.543`,
    expected_fields: {
      incident_date: "2024-11-05",
      incident_location: "Avenida Cabildo 3500",
      vehicle_plate: "PQR 345",
      denuncia_policial: "si",
      police_report_number: "2024-12345-DPTO",
      fotos_lugar: "si",
    },
  },

  {
    id: "robo-05",
    case_type: "robo",
    policyholder_name: "Roberto Guillermo Acosta",
    policy_number: "POL-2024-010",
    raw_text: `Buenos días,

El 12/12/2024 descubrí que mi Chevrolet Cruze 2019 patente STU 678, color negro, ya no estaba en la cochera de mi edificio (Avenida Callao 1400, CABA). Lo habían retirado durante la madrugada forzando la reja.

Hice la denuncia policial ante la Comisaría 9° de Buenos Aires, denuncia número 3421/2024.

Tengo fotos de la reja forzada y de la cochera vacía.

Roberto Acosta`,
    expected_fields: {
      incident_date: "12/12/2024",
      incident_location: "Avenida Callao 1400",
      vehicle_plate: "STU 678",
      denuncia_policial: "si",
      police_report_number: "3421/2024",
      fotos_lugar: "si",
    },
  },

  {
    id: "robo-06",
    case_type: "robo",
    policyholder_name: "Ignacio Ariel Benítez",
    policy_number: "POL-2024-026",
    raw_text: `Buenos días,

El día 07/01/2025 a las 19:40 hs fui víctima de un robo a mano armada en motocicleta en la calle Mitre 2300, Mar del Plata, Buenos Aires.

Dos sujetos en una moto me interceptaron cuando llegaba a mi domicilio. Me apuntaron con un arma de fuego y me sustrajeron mi Volkswagen Amarok 2021 patente FGH 012 junto con el celular y la billetera.

Radicé denuncia de inmediato en la Comisaría 4° de Mar del Plata, expediente 2025-MDP-00123. Los uniformes también documentaron el hecho. Adjunto el número de denuncia y fotos del lugar del robo.

No tengo fotos del vehículo porque me lo llevaron, pero puedo aportar fotos de la Vtv y el cédula verde.

Ignacio Benítez
DNI 36.987.654`,
    expected_fields: {
      incident_date: "07/01/2025",
      incident_location: "calle Mitre 2300, Mar del Plata",
      vehicle_plate: "FGH 012",
      denuncia_policial: "si",
      police_report_number: "2025-MDP-00123",
      fotos_lugar: "si",
    },
  },

  {
    id: "robo-07",
    case_type: "robo",
    policyholder_name: "Carolina Beatriz Sosa",
    policy_number: "POL-2024-027",
    raw_text: `A quien corresponda:

El 15/02/2025 sufrí el robo de mi vehículo en el estacionamiento subterráneo del edificio Catalinas Norte, Av. Leandro N. Alem 815, microcentro porteño.

Mi auto, un Peugeot 3008 2022 patente IJK 345, estaba en el piso menos dos desde las 08:00 hs. Cuando fui a retirarlo a las 18:30 ya no estaba. Las cámaras del estacionamiento están bajo custodia del consorcio.

Radicé la denuncia policial ese mismo día en la Comisaría 1° Federal, expediente 2025-FED-00789. No tengo fotos del lugar porque el estacionamiento subterráneo no tiene buena iluminación y el administrador no me dejó ingresar a sacar fotos.

Carolina Sosa
DNI 41.234.567`,
    expected_fields: {
      incident_date: "15/02/2025",
      incident_location: "Av. Leandro N. Alem 815, CABA",
      vehicle_plate: "IJK 345",
      denuncia_policial: "si",
      police_report_number: "2025-FED-00789",
      fotos_lugar: "no",
    },
  },

  {
    id: "robo-08",
    case_type: "robo",
    policyholder_name: "Walter Osvaldo Peralta",
    policy_number: "POL-2024-028",
    raw_text: `Estimados señores:

El 22/03/2025 entre la noche y la madrugada le sustrajeron el convertidor catalítico a mi Toyota Hilux 2020 patente LMN 678, que estaba estacionada en la calle Belgrano 3400, Villa Crespo, CABA.

Descubrí el robo a las 07:00 hs cuando intenté arrancar el vehículo y escuché el ruido característico del escape sin catalizador. Llamé al mecánico que lo confirmó.

El vehículo no fue robado en su totalidad — solo la parte del catalizador. Radicé la denuncia en la Comisaría 34° de CABA, denuncia número 2025-CABA-00567. Tengo fotos del daño debajo del vehículo.

Walter Peralta
DNI 32.765.432`,
    expected_fields: {
      incident_date: "22/03/2025",
      incident_location: "calle Belgrano 3400, Villa Crespo",
      vehicle_plate: "LMN 678",
      denuncia_policial: "si",
      police_report_number: "2025-CABA-00567",
      fotos_lugar: "si",
    },
  },

  {
    id: "robo-09",
    case_type: "robo",
    policyholder_name: "Verónica Eugenia Romero",
    policy_number: "POL-2024-029",
    raw_text: `Hola,

Me contacto para reportar el robo de mi vehículo. El hecho ocurrió el 10/04/2025 aproximadamente entre las 02:00 y 06:30 hs en la calle San Martín 780, Rawson, Gran Buenos Aires.

Mi auto es un Ford Ka+ 2019 patente NOP 901, color gris metalizado. Cuando salí a las 07:00 ya no estaba.

Todavía no fui a hacer la denuncia policial porque tuve que llevar a mis hijos al colegio y luego trabajar, pero pienso ir esta tarde. Tengo fotos del lugar donde estaba el auto tomadas con el celular.

Verónica Romero
Tel: 11-7890-1234`,
    expected_fields: {
      incident_date: "10/04/2025",
      incident_location: "calle San Martín 780, Rawson",
      vehicle_plate: "NOP 901",
      denuncia_policial: "no",
      fotos_lugar: "si",
    },
  },

  {
    id: "robo-10",
    case_type: "robo",
    policyholder_name: "Héctor Luis Giordano",
    policy_number: "POL-2024-030",
    raw_text: `Estimados:

El 05/05/2025 a las 23:15 hs intentaron robarme el auto en el garaje de mi casa en Godoy Cruz, Mendoza. Unos individuos rompieron la reja lateral de acceso al garaje y forzaron la puerta del conductor de mi Renault Duster 2020 patente QRS 234.

No lograron llevárselo porque activé la alarma y salí a ver qué pasaba — al verme, los sujetos huyeron a pie. El auto no fue robado pero tiene daños: puerta del conductor forzada, cerradura destruida y parte del tablero removido.

Radicé la denuncia de tentativa de robo en la Comisaría 21° de Mendoza, expediente 2025-MDZ-00890. Tengo fotos de la reja rota, la puerta forzada y el tablero.

Héctor Giordano
DNI 28.345.678`,
    expected_fields: {
      incident_date: "05/05/2025",
      incident_location: "Godoy Cruz, Mendoza",
      vehicle_plate: "QRS 234",
      denuncia_policial: "si",
      police_report_number: "2025-MDZ-00890",
      fotos_lugar: "si",
    },
  },

  // ── GRANIZO ─────────────────────────────────────────────────────────────────

  {
    id: "granizo-01",
    case_type: "granizo",
    policyholder_name: "Gabriela Inés Martínez",
    policy_number: "POL-2024-011",
    raw_text: `A quien corresponda:

El 15/01/2024 una tormenta de granizo severa afectó la zona de San Isidro, Buenos Aires. Mi vehículo, un Nissan Kicks 2023 patente VWX 901, que estaba estacionado en la calle Belgrano 450, sufrió daños extensivos.

El granizo era del tamaño de pelotas de golf. El capot, techo y maletero presentan cientos de abolladuras. Los vidrios de las ventanillas laterales traseras también resultaron quebrados.

Adjunto fotos de los daños tomadas el mismo día. Tengo la oblea VTV vigente y adjunto foto de la misma.

Gabriela Martínez`,
    expected_fields: {
      incident_date: "15/01/2024",
      incident_location: "calle Belgrano 450",
      vehicle_plate: "VWX 901",
      foto_oblea_vtv: "si",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-02",
    case_type: "granizo",
    policyholder_name: "Hernán Fabio Castro",
    policy_number: "POL-2024-012",
    raw_text: `Hola,

Granizo del 23/02/2024 dañó mi auto. Tenía el Volkswagen Polo patente YZA 234 en la calle, en Quilmes Centro, y la tormenta lo destruyó.

Capot lleno de abolladuras, techo igual, espejo retrovisor arrancado. Tuve que sacar el auto con grúa.

Adjunto fotos de los destrozos. Con respecto a la VTV, la tengo pero no adjunté foto. La puedo mandar después.

Hernán Castro`,
    expected_fields: {
      incident_date: "23/02/2024",
      vehicle_plate: "YZA 234",
      foto_oblea_vtv: "no",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-03",
    case_type: "granizo",
    policyholder_name: "Ana Clara Peralta",
    policy_number: "POL-2024-013",
    raw_text: `Estimados:

Informo daños por granizo del 2024-03-10. Mi vehículo Honda Civic patente BCD 567, color azul, estaba estacionado en la Avenida Rivadavia 9200, Liniers, durante la granizada que azotó el AMBA.

Daños: capot con más de 80 abolladuras, techo igual, paragolpes delantero rajado por el impacto de los granizos. Calculo que requiere reparación de chapa y pintura completa.

Adjunto foto de la oblea VTV que está al día (vence en octubre 2024), y más de 30 fotos de los daños tomadas desde distintos ángulos.

Ana Peralta
DNI 33.456.789`,
    expected_fields: {
      incident_date: "2024-03-10",
      incident_location: "Avenida Rivadavia 9200",
      vehicle_plate: "BCD 567",
      foto_oblea_vtv: "si",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-04",
    case_type: "granizo",
    policyholder_name: "Marcos Alejandro Ríos",
    policy_number: "POL-2024-014",
    raw_text: `Buenos días,

El 05/04/2024 la zona de Pilar, Buenos Aires, sufrió una tormenta de granizo intensa. Mi Peugeot 208 patente EFG 890, que estaba en la Avenida del Trabajo 1200, resultó muy dañado.

El techo parece una colcha de granizo, literalmente. Hay más de 200 abolladuras. El capot igual. También se rompió el parabrisas por los impactos.

No pude sacar fotos ese día porque fue de noche. Al otro día saqué fotos. Las adjunto.

No me acuerdo si la VTV la tengo al día. Voy a verificar y la mando.

Marcos Ríos`,
    expected_fields: {
      incident_date: "05/04/2024",
      incident_location: "Avenida del Trabajo 1200",
      vehicle_plate: "EFG 890",
      foto_oblea_vtv: "no",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-05",
    case_type: "granizo",
    policyholder_name: "Cecilia Florencia Álvarez",
    policy_number: "POL-2024-015",
    raw_text: `A la aseguradora:

Siniestro por granizo, 2024-05-20. Zona: Haedo, Gran Buenos Aires. Mi Toyota Yaris patente HIJ 123 estaba en la calle Rivadavia 500.

Daños por granizo: capot, techo, maletero con abolladuras, luneta trasera rajada.

Adjunto foto de la oblea de la verificación técnica vehicular (VTV) vigente y fotos de los daños al vehículo.

Cecilia Álvarez`,
    expected_fields: {
      incident_date: "2024-05-20",
      vehicle_plate: "HIJ 123",
      foto_oblea_vtv: "si",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-06",
    case_type: "granizo",
    policyholder_name: "Adrián Marcelo Fontana",
    policy_number: "POL-2024-031",
    raw_text: `Estimados señores:

El 18/06/2025 una granizada severa afectó el predio del Automóvil Club en Córdoba, calle Dean Funes 600. En ese momento había aproximadamente 40 vehículos estacionados en el patio exterior del local, entre los cuales se encontraba mi Fiat Argo 2022 patente TUV 456.

El granizo duró aproximadamente 20 minutos y según informó el personal del local, hay daños en la mayoría de los vehículos del sector. Otros vecinos del predio también están presentando siniestros.

Mi vehículo presenta abolladuras en capot, techo y ambos laterales. El parabrisas tiene una fisura. Adjunto fotos de los daños y foto de la oblea VTV vigente (vence en noviembre 2025).

Adrián Fontana
DNI 30.987.654`,
    expected_fields: {
      incident_date: "18/06/2025",
      incident_location: "calle Dean Funes 600, Córdoba",
      vehicle_plate: "TUV 456",
      foto_oblea_vtv: "si",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-07",
    case_type: "granizo",
    policyholder_name: "Lorena Paola Gutiérrez",
    policy_number: "POL-2024-032",
    raw_text: `Buenos días:

El 02/07/2025 granizó muy fuerte en Rosario. Mi auto, un Volkswagen Gol 2018 patente WXY 789, estaba en la calle San Lorenzo 1500, Rosario, Santa Fe.

Daños: capot con abolladuras importantes, techo algo mejor pero también dañado. El paragolpes delantero tiene una grieta.

Lamentablemente mi VTV venció en marzo de 2025 y todavía no la he renovado — el turno está pedido para el mes que viene. Sé que puede ser un inconveniente. Adjunto fotos de los daños eso sí.

Lorena Gutiérrez
Tel: 341-5678-9012`,
    expected_fields: {
      incident_date: "02/07/2025",
      incident_location: "calle San Lorenzo 1500, Rosario",
      vehicle_plate: "WXY 789",
      foto_oblea_vtv: "no",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-08",
    case_type: "granizo",
    policyholder_name: "Sebastián Eduardo Núñez",
    policy_number: "POL-2024-033",
    raw_text: `A quien corresponda:

El 10/08/2025 una tormenta de granizo golpeó la localidad de Godoy Cruz, Mendoza. Mi vehículo Toyota Etios 2019 patente ZAB 012, color blanco, estaba estacionado en la vía pública frente a mi domicilio en calle Belgrano 890.

Los daños se limitan exclusivamente al parabrisas delantero, que quedó fisurado en varios puntos y tiene una gran estrella en el sector del conductor. El resto del vehículo está aparentemente sin daños.

Tengo foto de la VTV vigente y varias fotos del parabrisas dañado tomadas desde adentro y afuera del vehículo.

Sebastián Núñez
DNI 43.456.789`,
    expected_fields: {
      incident_date: "10/08/2025",
      incident_location: "calle Belgrano 890, Godoy Cruz",
      vehicle_plate: "ZAB 012",
      foto_oblea_vtv: "si",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-09",
    case_type: "granizo",
    policyholder_name: "Natalia Inés Cáceres",
    policy_number: "POL-2024-034",
    raw_text: `Hola,

Les escribo porque el 20/04/2025 hubo una tormenta de granizo en Neuquén capital y el auto me quedó muy dañado. El hecho ocurrió mientras yo estaba de vacaciones y el vehículo estaba a cargo de mi hermana.

Mi Chevrolet Onix 2021 patente CDE 345 quedó con abolladuras severas en todo el capot y el techo. También se rompió el espejo retrovisor izquierdo.

Me entero recién ahora, 25 días después, porque mi hermana recién me lo dijo. Sé que hubo demora en reportar el siniestro y me disculpo por eso. Tengo fotos que sacó mi hermana el mismo día y foto de la VTV.

Natalia Cáceres
DNI 38.123.456`,
    expected_fields: {
      incident_date: "20/04/2025",
      incident_location: "Neuquén capital",
      vehicle_plate: "CDE 345",
      foto_oblea_vtv: "si",
      fotos_danos: "si",
    },
  },

  {
    id: "granizo-10",
    case_type: "granizo",
    policyholder_name: "José Ramón Villanueva",
    policy_number: "POL-2024-035",
    raw_text: `Estimados señores de la aseguradora:

El 12/09/2025 la provincia de Mendoza sufrió una granizada histórica. Mi vehículo, un Toyota Hilux 2023 patente EFG 678, estaba estacionado en la calle Paso de los Andes 400, Maipú, Mendoza.

Lamento comunicarles que los daños son de tal magnitud que estimo que la unidad podría ser pérdida total. El capot está completamente destruido, el techo hundido en varios puntos, los cuatro vidrios laterales rotos y el parabrisas delantero partido en dos. Adjunto peritaje preliminar del taller que lo tasó en $15.800.000.

Tengo foto de la VTV vigente (vence en febrero 2026), 47 fotos de los daños, y el informe meteorológico del Servicio Meteorológico Nacional que certifica la granizada.

José Villanueva
DNI 25.678.901`,
    expected_fields: {
      incident_date: "12/09/2025",
      incident_location: "calle Paso de los Andes 400, Maipú",
      vehicle_plate: "EFG 678",
      foto_oblea_vtv: "si",
      fotos_danos: "si",
    },
  },

  // ── INCENDIO ─────────────────────────────────────────────────────────────────

  {
    id: "incendio-01",
    case_type: "incendio",
    policyholder_name: "Pablo Ignacio Ferreyra",
    policy_number: "POL-2024-016",
    raw_text: `Estimados:

El 10/06/2024 a las 03:45 hs se incendió mi vehículo Renault Logan 2018 patente KLM 456, que estaba estacionado en el garaje de mi propiedad en calle Sarmiento 780, San Miguel, Buenos Aires.

Las llamas se originaron en el sector del motor (falla eléctrica según los bomberos) y consumieron el vehículo totalmente. El incendio también dañó parte de la estructura del garaje.

Concurrieron bomberos voluntarios de San Miguel que labraron el informe de bomberos. Número de informe: INC-2024-0089. También radicé denuncia policial en la Comisaría de San Miguel.

Adjunto fotos del vehículo calcinado y del garaje.

Pablo Ferreyra`,
    expected_fields: {
      incident_date: "10/06/2024",
      incident_location: "calle Sarmiento 780",
      vehicle_plate: "KLM 456",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "si",
    },
  },

  {
    id: "incendio-02",
    case_type: "incendio",
    policyholder_name: "Romina Celeste Giménez",
    policy_number: "POL-2024-017",
    raw_text: `Buenos días,

Les informo que el 22/07/2024 se incendió mi auto en el estacionamiento del Hospital Alemán, Av. Pueyrredón 1640, CABA, alrededor de las 11:30 hs.

El vehículo es un Ford Ecosport 2020, patente NOP 789, color negro. El incendio fue parcial — afectó el compartimiento del motor y el habitáculo delantero.

Vinieron los bomberos del Cuartel Central y me entregaron el informe de bomberos. Hice la denuncia policial en la Seccional 16°.

Tengo fotos del siniestro. No tengo fotos del interior porque el auto fue precintado por los bomberos.

Romina Giménez`,
    expected_fields: {
      incident_date: "22/07/2024",
      incident_location: "Av. Pueyrredón 1640",
      vehicle_plate: "NOP 789",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "si",
    },
  },

  {
    id: "incendio-03",
    case_type: "incendio",
    policyholder_name: "Gustavo Raúl Benítez",
    policy_number: "POL-2024-018",
    raw_text: `Hola,

El 2024-08-15 a las 14:00 hs se prendió fuego mi Volkswagen Amarok patente QRS 012 en la Ruta 8 km 45, a la altura de José C. Paz.

El vehículo quedó totalmente destruido. Los bomberos de la zona tardaron mucho en llegar. No sé si hay informe de bomberos — me dijeron que lo podría retirar después. Tampoco hice denuncia policial todavía.

Adjunto fotos que tomé desde el costado de la ruta mientras ardía y después.

Gustavo Benítez`,
    expected_fields: {
      incident_date: "2024-08-15",
      vehicle_plate: "QRS 012",
      informe_bomberos: "no",
      fotos_danos: "si",
      denuncia_policial: "no",
    },
  },

  {
    id: "incendio-04",
    case_type: "incendio",
    policyholder_name: "Marina Gabriela López",
    policy_number: "POL-2024-019",
    raw_text: `A quien corresponda:

El 30/09/2024 a las 22:15 hs se produjo un incendio en el parking subterráneo del edificio donde vivo (Avenida Del Libertador 2000, Vicente López). El fuego afectó mi Chevrolet Tracker 2022 patente TUV 345 y otros dos vehículos.

Se presentaron los bomberos de Vicente López que labraron el acta de incendio. Tengo el certificado de bomberos.

Radicamos denuncia policial en la Comisaría Vicente López junto con los otros afectados. Número de denuncia colectiva: 2024-VL-0567.

Tengo fotos del estado del vehículo y del lugar.

Marina López
DNI 42.567.890`,
    expected_fields: {
      incident_date: "30/09/2024",
      incident_location: "Avenida Del Libertador 2000",
      vehicle_plate: "TUV 345",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "si",
    },
  },

  {
    id: "incendio-05",
    case_type: "incendio",
    policyholder_name: "Eduardo Nicolás Pereyra",
    policy_number: "POL-2024-020",
    raw_text: `Estimados señores,

Soy Eduardo Pereyra, titular de la póliza número POL-2024-020. El 2024-10-18 se incendió mi vehículo Fiat Toro 2021 patente WXY 678 en el campo de mi propiedad, Ruta Provincial 41 km 12, General Belgrano, Buenos Aires.

El incendio fue causado por material combustible que se acumuló en el escape. El auto quedó completamente quemado.

Llamé a bomberos voluntarios de General Belgrano pero tardaron mucho y cuando llegaron ya no había nada que hacer. Me dijeron que no hacen informe en estos casos.

Hice la denuncia policial en la Comisaría de General Belgrano para que quede registrado. Número: 2024-GB-112.

Tengo fotos del vehículo destruido y del lugar.

Eduardo Pereyra`,
    expected_fields: {
      incident_date: "2024-10-18",
      vehicle_plate: "WXY 678",
      informe_bomberos: "no",
      fotos_danos: "si",
      denuncia_policial: "si",
    },
  },

  {
    id: "incendio-06",
    case_type: "incendio",
    policyholder_name: "Claudia Alejandra Bravo",
    policy_number: "POL-2024-036",
    raw_text: `Estimados señores:

El 14/11/2024 a las 10:20 hs mi vehículo Nissan Frontier 2022 patente HIJ 901, se incendió espontáneamente en la Autopista Richieri km 18, sentido Ezeiza, mientras circulaba normalmente.

Estaba manejando a velocidad normal cuando de repente el tablero encendió varias luces de alarma y comencé a ver humo saliendo del capot. Detuve el vehículo en la banquina, descendí de inmediato y segundos después el compartimiento del motor estaba en llamas.

Llamé a los bomberos del aeropuerto de Ezeiza que llegaron en 15 minutos. Emitieron el informe de bomberos número INC-2024-RICHI-0034. También intervino la policía vial, que labró el acta de siniestro vial número SVP-2024-4521.

El vehículo quedó con daños totales en el compartimiento del motor y habitáculo delantero. Tengo fotos.

Claudia Bravo
DNI 36.456.789`,
    expected_fields: {
      incident_date: "14/11/2024",
      incident_location: "Autopista Richieri km 18",
      vehicle_plate: "HIJ 901",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "si",
    },
  },

  {
    id: "incendio-07",
    case_type: "incendio",
    policyholder_name: "Lucas Damián Orieta",
    policy_number: "POL-2024-037",
    raw_text: `Buenos días:

El 03/12/2024 a las 08:45 hs se incendió mi motocicleta Honda CB 300R 2021 patente JKL 234, que estaba estacionada en la cochera de mi trabajo en Av. Córdoba 4500, CABA.

El origen del incendio fue eléctrico, según me indicó el técnico del taller que la revisó posteriormente. El incendio consumió el cableado por completo, el tablero y parte del asiento. No ardió completamente pero los daños son muy importantes.

Los bomberos de la Ciudad intervinieron y labraron el informe número INC-2024-CABA-2234. No hubo denuncia policial porque no hay terceros involucrados.

Tengo fotos de la moto quemada. La patente que figura en la póliza es la correcta.

Lucas Orieta
DNI 44.123.456`,
    expected_fields: {
      incident_date: "03/12/2024",
      incident_location: "Av. Córdoba 4500, CABA",
      vehicle_plate: "JKL 234",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "no",
    },
  },

  {
    id: "incendio-08",
    case_type: "incendio",
    policyholder_name: "Patricia Viviana Orozco",
    policy_number: "POL-2024-038",
    raw_text: `A quien corresponda:

El 20/01/2025 a las 06:00 hs aproximadamente, mi vehículo Renault Kangoo 2019 patente MNO 567, sufrió daños por explosión de gas en la calle Reconquista 1200, San Nicolás, CABA.

El vehículo estaba estacionado frente al edificio donde vivo. Según informó el departamento de gas de Metrogas que intervino en el lugar, una fuga en la red subterránea generó una acumulación de gas que se inflamó e impactó contra varios vehículos de la cuadra. El mío fue el más afectado: los cuatro vidrios rotos, puerta trasera izquierda deformada por la onda expansiva, capot levantado.

Los bomberos del Cuartel Central de la Ciudad labraron el informe INC-2025-CABA-0089. También intervino la policía y Metrogas. Tengo el acta policial 2025-CABA-00234.

Adjunto fotos de los daños y el certificado de bomberos.

Patricia Orozco
DNI 37.234.567`,
    expected_fields: {
      incident_date: "20/01/2025",
      incident_location: "calle Reconquista 1200, CABA",
      vehicle_plate: "MNO 567",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "si",
    },
  },

  {
    id: "incendio-09",
    case_type: "incendio",
    policyholder_name: "Guillermo Ernesto Salas",
    policy_number: "POL-2024-039",
    raw_text: `Estimados señores de la aseguradora:

El 08/02/2025 a las 02:30 hs encontré mi Peugeot 308 2020 patente PQR 890 incendiado en la calle Reconquista 3200, Caballito, CABA. El vehículo fue quemado intencionalmente — hay testigos que vieron a dos sujetos encender el fuego y escapar corriendo.

Radicé denuncia policial de inmediato por incendio intencional (presunto delito de daño). Número de denuncia: 2025-CABA-01234. Los bomberos de la estación de Caballito atendieron el siniestro e hicieron el informe número INC-2025-CAB-0056.

La policía realizó pericias en el lugar. El vehículo quedó destruido casi en su totalidad. Adjunto fotos del vehículo calcinado y copia de la denuncia policial.

Guillermo Salas
DNI 29.345.678`,
    expected_fields: {
      incident_date: "08/02/2025",
      incident_location: "calle Reconquista 3200, Caballito",
      vehicle_plate: "PQR 890",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "si",
      police_report_number: "2025-CABA-01234",
    },
  },

  {
    id: "incendio-10",
    case_type: "incendio",
    policyholder_name: "Daniela Marcela Ruiz",
    policy_number: "POL-2024-040",
    raw_text: `Buenos días:

El 15/03/2025 a las 16:45 hs se incendió el vehículo del vecino del departamento contiguo al mío en el estacionamiento del edificio de Avenida Rivadavia 8900, Liniers. El fuego se propagó y afectó gravemente mi Toyota Corolla 2021 patente STU 123 que estaba estacionado justo al lado.

Los bomberos de Liniers intervinieron de urgencia. Me entregaron el informe de bomberos INC-2025-LIN-0123. El vehículo del vecino que inició el fuego también tiene seguro — no sé si eso cambia el procedimiento de mi siniestro.

Radicamos denuncia policial conjunta en la Comisaría 46°, acta número 2025-CABA-03456. Tengo fotos de mi vehículo dañado.

Daniela Ruiz
DNI 40.765.432`,
    expected_fields: {
      incident_date: "15/03/2025",
      incident_location: "Avenida Rivadavia 8900, Liniers",
      vehicle_plate: "STU 123",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "si",
      police_report_number: "2025-CABA-03456",
    },
  },

  // ── NO-RELEVANTE (non-claim emails) ─────────────────────────────────────────

  {
    id: "no-relevante-01",
    case_type: "other",
    policyholder_name: "Marcela Andrea Figueroa",
    policy_number: "POL-2024-041",
    raw_text: `Estimados señores:

Me comunico con ustedes para solicitar información sobre la renovación de mi póliza número POL-2024-041, que vence el próximo 30/09/2025.

Quisiera saber cuál es el precio de la cuota para el próximo período y si hay alguna promoción disponible para clientes con más de 5 años de antigüedad. También me gustaría consultar si puedo agregar cobertura adicional para cristales.

Por favor envíenme un presupuesto actualizado al correo marcela.figueroa@email.com

Muchas gracias,
Marcela Figueroa
DNI 34.567.890
Tel: 11-4567-8901`,
    expected_fields: {
      inquiry_type: "renovacion_poliza",
      policy_number: "POL-2024-041",
    },
  },

  {
    id: "no-relevante-02",
    case_type: "other",
    policyholder_name: "Tomás Ignacio Ferrara",
    policy_number: "POL-2024-042",
    raw_text: `Hola,

Quería hacer una consulta sobre las coberturas de mi seguro automotor. ¿Qué es exactamente lo que cubre la responsabilidad civil? ¿Si le pego a un auto y el otro tiene más daños que el mío, quién paga qué?

También quería saber si mi póliza cubre si el auto se daña por una inundación. Vi en las noticias que hay muchas inundaciones en Buenos Aires y no sé si estoy cubierto.

Mi número de póliza es el POL-2024-042.

Saludos,
Tomás Ferrara`,
    expected_fields: {
      inquiry_type: "consulta_cobertura",
      policy_number: "POL-2024-042",
    },
  },

  {
    id: "no-relevante-03",
    case_type: "other",
    policyholder_name: "Beatriz Emilia Sandoval",
    policy_number: "POL-2024-043",
    raw_text: `Buenos días:

Les escribo para confirmar que recibí el comprobante de pago de la cuota número 8 de mi póliza POL-2024-043, correspondiente al período julio 2025. El débito se realizó correctamente el 05/07/2025 por la suma de $48.200.

Sin embargo, en el comprobante figura un nombre diferente al mío (aparece "Beatriz E. Sandoval" en lugar de "Beatriz Emilia Sandoval"). ¿Eso puede traer algún problema en caso de siniestro?

Muchas gracias y buen día.

Beatriz Sandoval`,
    expected_fields: {
      inquiry_type: "confirmacion_pago",
      policy_number: "POL-2024-043",
    },
  },

  {
    id: "no-relevante-04",
    case_type: "other",
    policyholder_name: "Jorge Alberto Medina",
    policy_number: "POL-2024-044",
    raw_text: `A quien corresponda:

Me comunico para solicitar el cambio de domicilio asociado a mi póliza. Me mudé hace dos semanas de Av. Corrientes 4500, CABA, a mi nuevo domicilio en calle Catamarca 1200, piso 3, dpto B, Rosario, Santa Fe (CP 2000).

¿Necesito hacer algún trámite especial o con este correo alcanza? También quería saber si el cambio de provincia afecta el costo de la cobertura.

Mi póliza es la POL-2024-044.

Atentamente,
Jorge Medina
DNI 27.890.123`,
    expected_fields: {
      inquiry_type: "cambio_domicilio",
      policy_number: "POL-2024-044",
    },
  },

  {
    id: "no-relevante-05",
    case_type: "other",
    policyholder_name: "Silvia Graciela Montoya",
    policy_number: "POL-2024-045",
    raw_text: `Estimados:

Me dirijo a ustedes para expresar mi descontento con el servicio de grúa que contrataron. El pasado 12/06/2025 llamé al 0800 porque se me pinchó una rueda en la Ruta 2 km 80. Me dijeron que el servicio tardaría 45 minutos y tardó más de 3 horas. Cuando llegó el chofer de la grúa fue muy maleducado.

No tengo ningún siniestro para reportar. Solo quiero que quede registrada esta queja formal y que alguien de atención al cliente se comunique conmigo para darme una explicación.

Silvia Montoya
DNI 31.678.901
Tel: 11-3456-7890`,
    expected_fields: {
      inquiry_type: "queja_servicio",
      policy_number: "POL-2024-045",
    },
  },

  // ── PARCIAL (missing key fields) ─────────────────────────────────────────────

  {
    id: "parcial-01",
    case_type: "choque",
    policyholder_name: "Ana Lucía Domínguez",
    policy_number: "POL-2024-046",
    raw_text: `Hola, buenos días.

Les escribo porque tuve un accidente de tránsito. Fue en la Avenida General Paz a la altura de Liniers, el otro vehículo era un Ford Focus gris. Los daños en mi auto son importantes: paragolpes delantero destruido, faro roto, radiador con pérdida.

Completamos el parte amistoso en el lugar y tengo fotos de los daños. Mi licencia está vigente.

Por favor dígame qué más necesitan para procesar el reclamo.

Ana Domínguez`,
    expected_fields: {
      incident_location: "Avenida General Paz, Liniers",
      parte_amistoso: "si",
      fotos_danos: "si",
      licencia_conducir: "si",
    },
  },

  {
    id: "parcial-02",
    case_type: "robo",
    policyholder_name: "Fernando Adrián Blanco",
    policy_number: "POL-2024-047",
    raw_text: `Estimados:

Me robaron el auto. Era un Volkswagen Gol 2019, color plateado, que estaba estacionado en la vía pública en el barrio de Villa del Parque, CABA.

Lo descubrí a la mañana temprano cuando fui a buscar el auto para ir al trabajo y no estaba. Ya hice la denuncia policial, expediente 2025-CABA-05678. Tengo fotos del lugar.

¿Qué documentación necesito presentar?

Fernando Blanco
DNI 38.456.789`,
    expected_fields: {
      incident_location: "Villa del Parque, CABA",
      denuncia_policial: "si",
      police_report_number: "2025-CABA-05678",
      fotos_lugar: "si",
    },
  },

  {
    id: "parcial-03",
    case_type: "granizo",
    policyholder_name: "Karina Susana Leiva",
    policy_number: "POL-2024-048",
    raw_text: `Buenos días:

El 14/07/2025 la tormenta de granizo dañó mi auto, que estaba en la calle en Avellaneda, provincia de Buenos Aires.

El capot quedó lleno de abolladuras y también el techo. Adjunto fotos de los daños. Tengo la VTV al día, adjunto foto de la oblea.

Quedo a la espera de indicaciones para proceder.

Karina Leiva
Tel: 11-2345-6789`,
    expected_fields: {
      incident_date: "14/07/2025",
      incident_location: "Avellaneda, Buenos Aires",
      foto_oblea_vtv: "si",
      fotos_danos: "si",
    },
  },

  {
    id: "parcial-04",
    case_type: "incendio",
    policyholder_name: "Roberto Carlos Esposito",
    policy_number: "POL-2024-049",
    raw_text: `Hola:

Mi auto se incendió en el garaje de mi casa en Santa Fe capital. El vehículo es un Chevrolet Agile 2017 patente VWX 345. Los bomberos vinieron y labraron el informe de bomberos INC-2025-SF-0234.

El vehículo quedó totalmente destruido. Tengo fotos. No hice denuncia policial porque no sé si es necesario para incendios accidentales.

Roberto Esposito
DNI 33.678.901`,
    expected_fields: {
      vehicle_plate: "VWX 345",
      incident_location: "Santa Fe capital",
      informe_bomberos: "si",
      fotos_danos: "si",
      denuncia_policial: "no",
    },
  },

  {
    id: "parcial-05",
    case_type: "choque",
    policyholder_name: "Marcelo Fabián Ríos",
    policy_number: "POL-2024-050",
    raw_text: `Estimados señores:

Tuve un accidente. El otro auto me chocó por detrás mientras estaba frenado en un semáforo. Los daños son bastante importantes en la parte trasera. Completamos el parte amistoso.

Avísenme cómo proceder.

Gracias,
Marcelo`,
    expected_fields: {
      parte_amistoso: "si",
    },
  },

  // ── EDGE CASES ───────────────────────────────────────────────────────────────

  {
    id: "edge-01",
    case_type: "choque",
    policyholder_name: "Verónica Alejandra Ponce",
    policy_number: "POL-2024-051",
    raw_text: `---------- Forwarded message ----------
From: Verónica Ponce <vponce@email.com>
To: siniestros@aseguradora.com.ar
Date: Mon, 03 Feb 2025 09:14:22 -0300
Subject: Reenvío: URGENTE - Siniestro de choque

---------- Forwarded message ----------
From: Verónica Ponce <vponce@email.com>
To: info@aseguradora.com.ar
Date: Fri, 31 Jan 2025 17:42:05 -0300
Subject: URGENTE - Siniestro de choque

Estimados:

Les informo un accidente ocurrido el 30/01/2025 a las 14:00 hs en la Av. San Martín 1500, Villa Luro, CABA.

Mi Renault Stepway 2022 patente YZA 678 fue impactado por un Citroën C3 patente BC 012 DE conducido por la Sra. Marcela Torres. Los daños son en la parte trasera izquierda.

Adjunto parte amistoso y fotos. Mi licencia está vigente.

Verónica Ponce
DNI 39.012.345

PD: Les reenvío este correo porque el anterior lo mandé a la dirección equivocada y nunca tuve respuesta.`,
    expected_fields: {
      incident_date: "30/01/2025",
      incident_location: "Av. San Martín 1500, Villa Luro",
      party_a_plate: "YZA 678",
      party_b_plate: "BC 012 DE",
      parte_amistoso: "si",
      fotos_danos: "si",
      licencia_conducir: "si",
    },
  },

  {
    id: "edge-02",
    case_type: "robo",
    policyholder_name: "Eugenio Rafael Tello",
    policy_number: "POL-2024-052",
    raw_text: `Estimados:

Me robaron el vehículo. El robo ocurrió el 15/03/2025 según me doy cuenta yo, pero según la cámara de seguridad del edificio del frente que pude ver, el vehículo ya no estaba desde el 14/03/2025 a las 23:30 hs. La denuncia la hice el 16/03/2025.

Mi Fiat Cronos 2023 patente CD 345 EF, color gris oscuro, estaba estacionado en Av. Corrientes 5400, Almagro, CABA.

Radicé la denuncia el 16/03/2025, número 2025-CABA-07890. Tengo fotos del lugar sacadas el 15/03/2025 a las 08:00 cuando noté la ausencia.

Eugenio Tello
DNI 32.901.234`,
    expected_fields: {
      incident_date: "14/03/2025",
      incident_location: "Av. Corrientes 5400, Almagro",
      vehicle_plate: "CD 345 EF",
      denuncia_policial: "si",
      police_report_number: "2025-CABA-07890",
      fotos_lugar: "si",
    },
  },

  {
    id: "edge-03",
    case_type: "choque",
    policyholder_name: "Horacio Damián Peña",
    policy_number: "POL-2024-053",
    raw_text: `A quien corresponda:

El 22/04/2025 a las 08:30 hs ocurrió un accidente de tránsito múltiple en el acceso norte de la Ruta 9, a la altura del peaje de Zárate, Buenos Aires.

Estaban involucrados tres vehículos: mi Volkswagen Amarok 2020 patente EF 678 GH, un Fiat Doblò patente IJ 901 KL conducido por Carlos Paz DNI 30.123.456, y un semirremolque Scania patente MN 234 OP con acoplado patente QR 567 ST, cuyo conductor es Pedro Morales de la empresa Transporte Atlántico S.A.

Mi vehículo fue impactado primero por el Doblò y luego empujado contra el semirremolque. Tengo daños en ambas partes del auto: delantera y trasera. El Doblò también tiene daños. El camión solo tiene rayones menores.

La gendarmería nacional labró el acta de tránsito 2025-GN-1145. No se hizo parte amistoso por la complejidad del accidente. Cuento con fotos y hay cámaras de peaje que registraron el impacto.

Horacio Peña
DNI 36.234.567`,
    expected_fields: {
      incident_date: "22/04/2025",
      incident_location: "Ruta 9 peaje Zárate",
      party_a_plate: "EF 678 GH",
      parte_amistoso: "no",
      fotos_danos: "si",
      acta_policial: "2025-GN-1145",
    },
  },

  {
    id: "edge-04",
    case_type: "choque",
    policyholder_name: "Miriam Stella Ortega",
    policy_number: "POL-2024-054",
    raw_text: `Estimados señores:

El 10/05/2025 a las 19:15 hs ocurrió un accidente en la Avenida Callao y Córdoba, CABA, que involucra daños personales, materiales propios y responsabilidad civil frente a terceros.

Mi Honda HR-V 2021 patente UV 012 WX fue embestida por un Renault Logan patente YZ 345 AB. Como consecuencia:

1. DAÑOS EN MI VEHÍCULO: paragolpes delantero destruido, faro izquierdo roto, capot abollado.
2. LESIONES: yo sufrí un esguince cervical y fui atendida en el SAME. Mi acompañante Gustavo Leal, DNI 41.234.567, sufrió fractura de clavícula y está internado en el Hospital Ramos Mejía.
3. DAÑOS A TERCEROS: el Logan al frenar impactó también contra un Volkswagen Gol patente CD 678 EF estacionado en la esquina, cuyos daños también podrían reclamarse.

Completamos parte amistoso con el conductor del Logan (Sr. Ariel Romero, DNI 33.456.789). La policía labró el acta 2025-CABA-08901. Cuento con fotos de todo y hay testigos.

Miriam Ortega
DNI 35.789.012`,
    expected_fields: {
      incident_date: "10/05/2025",
      incident_location: "Avenida Callao y Córdoba, CABA",
      party_a_plate: "UV 012 WX",
      party_b_plate: "YZ 345 AB",
      parte_amistoso: "si",
      fotos_danos: "si",
      heridos: "si",
      acta_policial: "2025-CABA-08901",
    },
  },

  {
    id: "edge-05",
    case_type: "robo",
    policyholder_name: "Leandro Patricio Salinas",
    policy_number: "POL-2024-055",
    raw_text: `Buenos días:

Les escribo respecto a un hecho ocurrido el 28/06/2025 en el que mi vehículo, un Toyota SW4 2022 patente GH 901 IJ, sufrió daños que inicialmente no parecían consistentes con un intento de robo pero que el mecánico sospecha que sí lo son.

Encontré el auto el 28/06/2025 a las 07:30 con la cerradura de la puerta del conductor dañada y el volante con el cableado expuesto, como si hubieran intentado puentearlo. Sin embargo, el auto no fue movido ni desaparecieron objetos del interior.

El mecánico que lo revisó dice que el daño en el sistema de arranque es consistente con una tentativa de robo. Sin embargo, yo no vi nada ni nadie me avisó de nada raro. No hay testigos conocidos.

Hice una denuncia preventiva en la comisaría del barrio (Palermo, CABA), expediente 2025-CABA-09234, aunque el policía me dijo que no sabe si clasificarlo como robo consumado, tentativa o daño.

¿Cómo clasifican ustedes este hecho? Tengo fotos del daño en la cerradura y el cableado.

Leandro Salinas
DNI 37.456.789`,
    expected_fields: {
      incident_date: "28/06/2025",
      incident_location: "Palermo, CABA",
      vehicle_plate: "GH 901 IJ",
      denuncia_policial: "si",
      police_report_number: "2025-CABA-09234",
      fotos_lugar: "si",
    },
  },
];

/** Lookup map for O(1) access by scenario ID. */
export const SCENARIOS_BY_ID: ReadonlyMap<string, SimulationScenario> = new Map(
  SCENARIOS.map((s) => [s.id, s])
);

/**
 * Get a scenario by ID.
 * @returns The scenario, or undefined if not found.
 */
export function getScenarioById(id: string): SimulationScenario | undefined {
  return SCENARIOS_BY_ID.get(id);
}

/**
 * Get a random scenario for a given claim type.
 */
export function getRandomScenario(claimType?: ClaimType): SimulationScenario {
  const pool = claimType
    ? SCENARIOS.filter((s) => s.case_type === claimType)
    : SCENARIOS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
