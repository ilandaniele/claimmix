-- =============================================================================
-- ClaimMix — Development seed data
-- =============================================================================
-- Run with: supabase db reset --local (resets + runs migrations + this seed)
-- Or manually: psql <connection> -f supabase/seed.sql
--
-- HUMAN STEP REQUIRED for auth.users:
--   Supabase does not allow inserting into auth.users via SQL from the client.
--   Use the Supabase Auth Admin API or the dashboard to create users, then
--   run supabase/seed-auth.sql (below) to link them to public.users.
--
--   For local dev with `supabase start`, you CAN insert directly into auth.users.
--   This seed file includes those inserts for local dev only.
-- =============================================================================

-- Guard: only run this seed in local/dev environments.
-- In production, apply migrations via `supabase db push` and create users manually.

-- =============================================================================
-- 1. Tenant
-- =============================================================================
INSERT INTO public.tenants (id, name, created_at)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  'Seguros del Sur S.A.',
  now() - INTERVAL '30 days'
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 2. Auth users (local dev only — insert into auth schema)
-- =============================================================================
-- Analyst 1: Lucía Ramallo (analyst)
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES (
  '20000000-0000-0000-0000-000000000001',
  'lucia@seguros-del-sur.com.ar',
  crypt('Analyst123!', gen_salt('bf', 12)),
  now(),
  now() - INTERVAL '20 days',
  now() - INTERVAL '20 days',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Lucía Ramallo"}'
)
ON CONFLICT (id) DO NOTHING;

-- Analyst 2: Carlos Medina (admin)
INSERT INTO auth.users (
  id, email, encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  'carlos@seguros-del-sur.com.ar',
  crypt('Admin456!', gen_salt('bf', 12)),
  now(),
  now() - INTERVAL '25 days',
  now() - INTERVAL '25 days',
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Carlos Medina"}'
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 3. Public users (link auth.users to tenants)
-- =============================================================================
INSERT INTO public.users (id, tenant_id, full_name, role, created_at)
VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Lucía Ramallo',
    'analyst',
    now() - INTERVAL '20 days'
  ),
  (
    '20000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    'Carlos Medina',
    'admin',
    now() - INTERVAL '25 days'
  )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 4. Cases — 20 realistic Argentine insurance scenarios
--    Mix: 5 choque, 5 robo, 5 granizo, 5 incendio
--    Statuses: 4 procesando, 4 listo, 4 esperando, 4 escalado, 4 cerrado
-- =============================================================================

INSERT INTO public.cases (
  id, tenant_id, policy_number, policyholder_name, claim_type,
  status, confidence_min, assigned_to, channel, created_at, updated_at, closed_at
) VALUES

-- CHOQUE 1 — listo, assigned to Lucía
(
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-001',
  'Juan García',
  'choque', 'listo', 0.89,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '7 days',
  now() - INTERVAL '6 days 23 hours',
  NULL
),

-- CHOQUE 2 — procesando, unassigned
(
  '30000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-002',
  'María López',
  'choque', 'procesando', NULL,
  NULL,
  'email_sim',
  now() - INTERVAL '1 hour',
  NULL,
  NULL
),

-- CHOQUE 3 — escalado (low confidence), assigned to Carlos
(
  '30000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-003',
  'Roberto Fernández',
  'choque', 'escalado', 0.52,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '5 days',
  now() - INTERVAL '4 days 20 hours',
  NULL
),

-- CHOQUE 4 — cerrado
(
  '30000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-004',
  'Marta Sánchez',
  'choque', 'cerrado', 0.91,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '8 days',
  now() - INTERVAL '3 days',
  now() - INTERVAL '3 days'
),

-- CHOQUE 5 — esperando (parte_amistoso faltante)
(
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-005',
  'Andrés Romero',
  'choque', 'esperando', 0.74,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '4 days',
  now() - INTERVAL '3 days 22 hours',
  NULL
),

-- ROBO 1 — listo, high confidence
(
  '30000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-006',
  'Silvina Torres',
  'robo', 'listo', 0.93,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '6 days',
  now() - INTERVAL '5 days 23 hours',
  NULL
),

-- ROBO 2 — procesando
(
  '30000000-0000-0000-0000-000000000007',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-007',
  'Pablo Martínez',
  'robo', 'procesando', NULL,
  NULL,
  'email_sim',
  now() - INTERVAL '2 hours',
  NULL,
  NULL
),

-- ROBO 3 — esperando (denuncia_policial faltante)
(
  '30000000-0000-0000-0000-000000000008',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-008',
  'Ana González',
  'robo', 'esperando', 0.77,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '3 days',
  now() - INTERVAL '2 days 18 hours',
  NULL
),

-- ROBO 4 — escalado
(
  '30000000-0000-0000-0000-000000000009',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-009',
  'Diego Herrera',
  'robo', 'escalado', 0.42,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '4 days',
  now() - INTERVAL '3 days 15 hours',
  NULL
),

-- ROBO 5 — cerrado
(
  '30000000-0000-0000-0000-000000000010',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-010',
  'Laura Díaz',
  'robo', 'cerrado', 0.85,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '7 days',
  now() - INTERVAL '2 days',
  now() - INTERVAL '2 days'
),

-- GRANIZO 1 — procesando
(
  '30000000-0000-0000-0000-000000000011',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-011',
  'Eduardo Muñoz',
  'granizo', 'procesando', NULL,
  NULL,
  'email_sim',
  now() - INTERVAL '3 hours',
  NULL,
  NULL
),

-- GRANIZO 2 — listo
(
  '30000000-0000-0000-0000-000000000012',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-012',
  'Natalia Pérez',
  'granizo', 'listo', 0.97,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '5 days',
  now() - INTERVAL '4 days 22 hours',
  NULL
),

-- GRANIZO 3 — esperando (foto_oblea_vtv faltante)
(
  '30000000-0000-0000-0000-000000000013',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-013',
  'Hernán Castro',
  'granizo', 'esperando', 0.71,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '2 days',
  now() - INTERVAL '1 day 20 hours',
  NULL
),

-- GRANIZO 4 — escalado
(
  '30000000-0000-0000-0000-000000000014',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-014',
  'Verónica Silva',
  'granizo', 'escalado', 0.48,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '3 days',
  now() - INTERVAL '2 days 12 hours',
  NULL
),

-- GRANIZO 5 — cerrado
(
  '30000000-0000-0000-0000-000000000015',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-015',
  'Marcelo Acosta',
  'granizo', 'cerrado', 0.88,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '8 days',
  now() - INTERVAL '4 days',
  now() - INTERVAL '4 days'
),

-- INCENDIO 1 — procesando
(
  '30000000-0000-0000-0000-000000000016',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-016',
  'Graciela Ríos',
  'incendio', 'procesando', NULL,
  NULL,
  'email_sim',
  now() - INTERVAL '30 minutes',
  NULL,
  NULL
),

-- INCENDIO 2 — listo
(
  '30000000-0000-0000-0000-000000000017',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-017',
  'Fernando Blanco',
  'incendio', 'listo', 0.82,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '6 days',
  now() - INTERVAL '5 days 20 hours',
  NULL
),

-- INCENDIO 3 — esperando (informe_bomberos faltante)
(
  '30000000-0000-0000-0000-000000000018',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-018',
  'Claudia Morales',
  'incendio', 'esperando', 0.73,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '3 days',
  now() - INTERVAL '2 days 15 hours',
  NULL
),

-- INCENDIO 4 — escalado
(
  '30000000-0000-0000-0000-000000000019',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-019',
  'Gustavo Vega',
  'incendio', 'escalado', 0.61,
  '20000000-0000-0000-0000-000000000002',
  'email_sim',
  now() - INTERVAL '4 days',
  now() - INTERVAL '3 days 18 hours',
  NULL
),

-- INCENDIO 5 — cerrado
(
  '30000000-0000-0000-0000-000000000020',
  '10000000-0000-0000-0000-000000000001',
  'POL-2024-020',
  'Patricia Leiva',
  'incendio', 'cerrado', 0.95,
  '20000000-0000-0000-0000-000000000001',
  'email_sim',
  now() - INTERVAL '7 days',
  now() - INTERVAL '1 day',
  now() - INTERVAL '1 day'
)

ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 5. Raw messages — realistic es-AR claim narratives
-- =============================================================================
INSERT INTO public.raw_messages (id, case_id, tenant_id, channel, from_addr, subject, body, received_at)
VALUES

-- CHOQUE 1
(
  '40000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'juan.garcia@gmail.com',
  'Denuncia de siniestro - Choque - Póliza POL-2024-001',
  'Estimados señores,
Me dirijo a ustedes para informar el siniestro ocurrido el día 25 de mayo de 2024
a las 14:30 hs en la intersección de Av. Corrientes 3400 y Av. Medrano, Ciudad
Autónoma de Buenos Aires.

Mi vehículo (Toyota Corolla 2022, patente ABC 123) fue impactado por un Fiat
Cronos 2021 (patente XYZ 789) conducido por el Sr. Héctor Suárez (DNI 28.456.123)
quien circulaba por Medrano sin respetar la señal de PARE.

Los daños en mi vehículo incluyen: paragolpe delantero destruido, capot abollado y
faro izquierdo roto. El otro vehículo sufrió daños en su paragolpe trasero.

Adjunto el parte de accidente amistoso firmado por ambas partes y las fotografías
de los daños. Mi licencia de conducir número 12.345.678 tiene vigencia hasta
diciembre de 2025.

Quedo a disposición para cualquier consulta.
Juan García
DNI 32.567.890',
  now() - INTERVAL '7 days'
),

-- CHOQUE 2 (procesando — mensaje recibido hace 1 hora)
(
  '40000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'mlopez@hotmail.com',
  'Siniestro auto - colisión - María López',
  'Buenos días,
Ayer a las 19:15 hs tuve un accidente en la Ruta Nacional 9, km 47, en la localidad
de Zárate, Provincia de Buenos Aires. Mi Ford Focus 2020 (patente QRS 456) fue
golpeado por detrás por un camión de carga que no mantuvo distancia de seguridad.

El conductor del camión se retiró del lugar antes de que pudiera tomar sus datos
completos. Solo tengo la patente del camión: TUV 012. Llamé al 911 y levantaron
el acta. El número de acta policial es 2024-44567-ZAR.

Los daños son severos: toda la parte trasera del vehículo deformada, luneta rota,
y el baúl no cierra. El auto fue remolcado al taller mecánico "El Tucán" en Zárate.

Necesito orientación sobre los próximos pasos.
María López
DNI 29.876.543',
  now() - INTERVAL '1 hour'
),

-- CHOQUE 3 (escalado — información incompleta/confusa)
(
  '40000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'rfernandez@yahoo.com.ar',
  'accidente',
  'hola tube un choque no se bien donde fue creo que fue en palermo o en recoleta
el otro auto se fue. mi auto es un auto rojo. no tengo los papeles acá. porfavor
ayudenme. fue ayer o anteayer no recuerdo bien. los daños son varios.
roberto',
  now() - INTERVAL '5 days'
),

-- CHOQUE 5 (esperando — falta parte amistoso)
(
  '40000000-0000-0000-0000-000000000005',
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'aromero@gmail.com',
  'Siniestro choque - Póliza POL-2024-005',
  'Buenas tardes,
Informo siniestro ocurrido el 28/05/2024 a las 08:45 en la esquina de Rivadavia y
Nazca, CABA. Mi Chevrolet Onix 2023 (patente LMN 234) recibió un impacto lateral
de un Honda Civic 2019 (patente OPQ 567) que saltó un semáforo en rojo.

El conductor del otro vehículo, Sr. Matías Gómez, manifestó no tener el parte
amistoso consigo. Quedamos en que me lo enviaría por correo electrónico pero aún
no lo recibí. Sí cuento con fotografías de los daños y mi licencia de conducir.

Daños en mi vehículo: puerta trasera derecha abollada, espejo retrovisor roto.

¿Pueden iniciar el trámite sin el parte amistoso y agregar luego?

Andrés Romero
DNI 31.234.567',
  now() - INTERVAL '4 days'
),

-- ROBO 1
(
  '40000000-0000-0000-0000-000000000006',
  '30000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'storres@gmail.com',
  'Robo de vehículo - Denuncia - Póliza POL-2024-006',
  'Estimados,
Con mucho pesar les comunico el robo de mi vehículo Volkswagen Polo 2021 (patente
RST 890) ocurrido en la noche del 26 al 27 de mayo de 2024.

El vehículo estaba estacionado en la calle Scalabrini Ortiz 2100, Palermo, CABA.
Al salir de mi domicilio a las 07:30 del día 27/05 noté la ausencia del mismo.
Inmediatamente realicé la denuncia en la Comisaría 20 de CABA, número de denuncia:
2024-20-001234.

Adjunto copia escaneada de la denuncia policial y fotografías del lugar donde
estaba estacionado el vehículo. El valor de mercado actual del automóvil es de
aproximadamente $18.500.000 pesos.

Silvina Torres
DNI 27.890.123
Tel: 011-4567-8901',
  now() - INTERVAL '6 days'
),

-- ROBO 3 (esperando — falta denuncia policial)
(
  '40000000-0000-0000-0000-000000000008',
  '30000000-0000-0000-0000-000000000008',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'agonzalez@outlook.com',
  'Robo parcial de vehículo - Póliza POL-2024-008',
  'Hola,
Me robaron las ruedas y la batería de mi Renault Sandero 2020 (patente GHI 345)
que estaba en el garage del consorcio de Corrientes 5500, piso 1, CABA.
El hecho ocurrió entre el sábado 25 y el domingo 26 de mayo de 2024.

Tomé conocimiento el domingo a las 12:00 cuando fui a buscar el auto. Todavía
no pude ir a hacer la denuncia policial porque el lunes fue feriado y el martes
trabajé hasta tarde. Voy a ir esta semana.

Las fotografías del auto sin ruedas las adjunto.

Ana González
DNI 33.456.789',
  now() - INTERVAL '3 days'
),

-- GRANIZO 2
(
  '40000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000012',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'nperez@hotmail.com',
  'Daños por granizo - Póliza POL-2024-012',
  'Estimados señores,
El día 24 de mayo de 2024 se registró una tormenta de granizo en la ciudad de
Rosario, Provincia de Santa Fe, que causó graves daños en mi vehículo Peugeot
208 2022 (patente JKL 678) que se encontraba en la vía pública frente a mi
domicilio en Bv. Oroño 1200.

Los daños son extensos: capot con múltiples abolladuras, techo deformado, parabrisas
con una fisura, y espejo retrovisor izquierdo partido.

Adjunto a este correo:
1. Fotografías de todos los daños
2. Fotografía de la oblea VTV vigente (vence en octubre 2024)

Quedo a la espera de instrucciones para el peritaje.
Natalia Pérez
DNI 30.123.456',
  now() - INTERVAL '5 days'
),

-- GRANIZO 3 (esperando — falta foto_oblea_vtv)
(
  '40000000-0000-0000-0000-000000000013',
  '30000000-0000-0000-0000-000000000013',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'hcastro@gmail.com',
  'Siniestro granizo Córdoba - Póliza POL-2024-013',
  'Buenos días,
Me comunico para reportar los daños sufridos por mi Honda City 2021 (patente MNO 901)
durante la granizada del 27 de mayo en Córdoba Capital, barrio Cerro de las Rosas.

El vehículo quedó muy golpeado: capot, techo y aletas deformadas por el granizo.
El parabrisas tiene varias fisuras. Adjunto fotos de los daños.

Hernán Castro
DNI 28.901.234
Tel: 0351-456-7890',
  now() - INTERVAL '2 days'
),

-- INCENDIO 2
(
  '40000000-0000-0000-0000-000000000017',
  '30000000-0000-0000-0000-000000000017',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'fblanco@gmail.com',
  'Incendio de vehículo - Póliza POL-2024-017',
  'Estimados,
El día 26 de mayo de 2024 a las 23:15 hs se incendió mi Toyota Hilux 2020 (patente
PQR 234) mientras circulaba por la autopista Panamericana a la altura del km 25,
sentido norte, en la localidad de Del Viso, Buenos Aires.

El vehículo comenzó a humear repentinamente y detuve la marcha en la banquina.
En cuestión de minutos las llamas consumieron el motor y se extendieron hacia el
habitáculo. Los bomberos de Pilar acudieron al lugar (Cuartel 01 de Pilar,
número de intervención: 2024-PI-0892).

El vehículo quedó completamente destruido. La denuncia policial fue realizada en
la Delegación Comunal del Parque Industrial de Pilar, acta N° 2024-78923.

Adjunto: informe de bomberos, denuncia policial, fotografías del vehículo calcinado.

Fernando Blanco
DNI 26.345.678',
  now() - INTERVAL '6 days'
),

-- INCENDIO 3 (esperando — falta informe_bomberos)
(
  '40000000-0000-0000-0000-000000000018',
  '30000000-0000-0000-0000-000000000018',
  '10000000-0000-0000-0000-000000000001',
  'email_sim',
  'cmorales@yahoo.com.ar',
  'Incendio - consulta - Póliza POL-2024-018',
  'Hola,
Me llamo Claudia Morales y el 28 de mayo se incendió mi auto Volkswagen Gol 2019
(patente STU 567) en la cochera de mi edificio en Mendoza 1800, Congreso, CABA.

Fue a las 3 de la mañana, intervinieron los Bomberos Voluntarios de Villa del Parque.
Ellos me dijeron que el informe oficial puede tardar hasta 15 días hábiles en estar
disponible.

Realicé la denuncia policial en la seccional 7ma (acta 2024-07-004567).

¿Puedo iniciar el trámite sin el informe de bomberos y agregarlo después cuando
lo tenga?

Claudia Morales
DNI 34.567.890',
  now() - INTERVAL '3 days'
)

ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 6. Extracted fields — for listo and escalado cases
-- =============================================================================
INSERT INTO public.extracted_fields (
  id, case_id, tenant_id, field_key, field_value, confidence, extracted_at
) VALUES

-- CHOQUE 1 (listo — alta confianza)
('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','date','2024-05-25',0.97,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','time','14:30',0.95,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','location','Av. Corrientes 3400 y Av. Medrano, CABA',0.93,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','party_a_name','Juan García',0.98,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','party_a_plate','ABC 123',0.97,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000006','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','party_b_name','Héctor Suárez',0.92,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000007','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','party_b_plate','XYZ 789',0.96,now() - INTERVAL '6 days 23 hours'),
('50000000-0000-0000-0000-000000000008','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','declared_damage','Paragolpe delantero destruido, capot abollado, faro izquierdo roto',0.89,now() - INTERVAL '6 days 23 hours'),

-- CHOQUE 3 (escalado — baja confianza)
('50000000-0000-0000-0000-000000000020','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','date','desconocida',0.42,now() - INTERVAL '4 days 20 hours'),
('50000000-0000-0000-0000-000000000021','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','location','Palermo o Recoleta, CABA',0.35,now() - INTERVAL '4 days 20 hours'),
('50000000-0000-0000-0000-000000000022','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','party_a_name','Roberto Fernández',0.71,now() - INTERVAL '4 days 20 hours'),
('50000000-0000-0000-0000-000000000023','30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','party_a_plate','desconocida',0.52,now() - INTERVAL '4 days 20 hours'),

-- ROBO 1 (listo)
('50000000-0000-0000-0000-000000000030','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','date','2024-05-27',0.96,now() - INTERVAL '5 days 23 hours'),
('50000000-0000-0000-0000-000000000031','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','location','Scalabrini Ortiz 2100, Palermo, CABA',0.98,now() - INTERVAL '5 days 23 hours'),
('50000000-0000-0000-0000-000000000032','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','party_a_plate','RST 890',0.97,now() - INTERVAL '5 days 23 hours'),
('50000000-0000-0000-0000-000000000033','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','police_report_number','2024-20-001234',0.95,now() - INTERVAL '5 days 23 hours'),
('50000000-0000-0000-0000-000000000034','30000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','vehicle_value_ars','18500000',0.88,now() - INTERVAL '5 days 23 hours'),

-- GRANIZO 2 (listo)
('50000000-0000-0000-0000-000000000050','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','date','2024-05-24',0.98,now() - INTERVAL '4 days 22 hours'),
('50000000-0000-0000-0000-000000000051','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','location','Bv. Oroño 1200, Rosario, Santa Fe',0.97,now() - INTERVAL '4 days 22 hours'),
('50000000-0000-0000-0000-000000000052','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','party_a_plate','JKL 678',0.99,now() - INTERVAL '4 days 22 hours'),
('50000000-0000-0000-0000-000000000053','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','declared_damage','Capot con abolladuras, techo deformado, parabrisas fisurado, espejo partido',0.97,now() - INTERVAL '4 days 22 hours'),
('50000000-0000-0000-0000-000000000054','30000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000001','vtv_expiry','2024-10',0.95,now() - INTERVAL '4 days 22 hours'),

-- INCENDIO 2 (listo)
('50000000-0000-0000-0000-000000000070','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','date','2024-05-26',0.97,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000071','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','time','23:15',0.95,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000072','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','location','Autopista Panamericana km 25, Del Viso, Buenos Aires',0.96,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000073','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','party_a_plate','PQR 234',0.98,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000074','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','fire_report_number','2024-PI-0892',0.92,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000075','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','police_report_number','2024-78923',0.91,now() - INTERVAL '5 days 20 hours'),
('50000000-0000-0000-0000-000000000076','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000001','declared_damage','Vehículo completamente destruido por incendio',0.98,now() - INTERVAL '5 days 20 hours')

ON CONFLICT (case_id, field_key) DO NOTHING;

-- =============================================================================
-- 7. Missing docs — for cases in 'esperando' status
-- =============================================================================
INSERT INTO public.missing_docs (id, case_id, tenant_id, doc_key, requested_at, satisfied_at)
VALUES

-- CHOQUE 5 esperando — falta parte_amistoso
(
  '60000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000001',
  'parte_amistoso',
  now() - INTERVAL '3 days 22 hours',
  NULL
),

-- ROBO 3 esperando — falta denuncia_policial
(
  '60000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000008',
  '10000000-0000-0000-0000-000000000001',
  'denuncia_policial',
  now() - INTERVAL '2 days 18 hours',
  NULL
),

-- GRANIZO 3 esperando — falta foto_oblea_vtv
(
  '60000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000013',
  '10000000-0000-0000-0000-000000000001',
  'foto_oblea_vtv',
  now() - INTERVAL '1 day 20 hours',
  NULL
),

-- INCENDIO 3 esperando — falta informe_bomberos
(
  '60000000-0000-0000-0000-000000000004',
  '30000000-0000-0000-0000-000000000018',
  '10000000-0000-0000-0000-000000000001',
  'informe_bomberos',
  now() - INTERVAL '2 days 15 hours',
  NULL
)

ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 8. Audit log entries — representative sample
-- =============================================================================
INSERT INTO public.audit_log (
  tenant_id, actor_id, event_type, target_type, target_id, payload, created_at
) VALUES

-- Auth success
(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'auth.success',
  'user',
  '20000000-0000-0000-0000-000000000001',
  '{"role":"analyst"}',
  now() - INTERVAL '7 days'
),

-- Case created via simulation
(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'case.created',
  'case',
  '30000000-0000-0000-0000-000000000001',
  '{"claim_type":"choque","channel":"email_sim"}',
  now() - INTERVAL '7 days'
),

-- AI extracted choque 1
(
  '10000000-0000-0000-0000-000000000001',
  NULL,
  'ai.extracted',
  'case',
  '30000000-0000-0000-0000-000000000001',
  '{"model":"gpt-4o-mini","confidence_min":0.89,"status_after":"listo"}',
  now() - INTERVAL '6 days 23 hours'
),

-- Case closed
(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'case.closed',
  'case',
  '30000000-0000-0000-0000-000000000004',
  '{"reason":"paid_out","status_before":"listo"}',
  now() - INTERVAL '3 days'
),

-- Escalated (low confidence)
(
  '10000000-0000-0000-0000-000000000001',
  NULL,
  'ai.extracted',
  'case',
  '30000000-0000-0000-0000-000000000003',
  '{"reason":"low_confidence","confidence_min":0.52,"low_confidence_fields":["date","location","party_a_plate"]}',
  now() - INTERVAL '4 days 20 hours'
);
