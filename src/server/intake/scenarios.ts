/**
 * 20 realistic Argentine insurance claim scenarios for intake simulation.
 *
 * Distribution:
 *   5 × choque (street accidents in Buenos Aires)
 *   5 × robo   (vehicle theft, with and without police report)
 *   5 × granizo (hail damage events in AMBA region)
 *   5 × incendio (fire damage)
 *
 * Each scenario has:
 *   id:               unique identifier (choque-01 … incendio-05)
 *   case_type:        "choque" | "robo" | "granizo" | "incendio"
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
