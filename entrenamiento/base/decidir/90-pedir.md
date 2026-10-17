---
id: decidir.pedir
paso: decidir
modo: sombra
decision: pedir
titulo_es: Cómo arma el código lo que se pide
titulo_en: How the code builds what is asked for
---
Así arma el código de hoy la lista de lo que se le pide a la persona. Se describe para poder comparar; no es una instrucción para el modelo.

Qué falta, en claves canónicas:
- Todo caso necesita full_name, accident_date, accident_description, claim_type, policy_number y dni. Un dato con confianza menor a 0,60 cuenta como faltante.
- Además hace falta al menos un medio de contacto: email o phone. Si no hay ninguno falta email_or_phone, y se le pide como el mail.
- Según el ramo suma datos: patente_vehiculo, provincia_siniestro y hora_siniestro. Choque y responsabilidad civil piden las tres; robo, granizo, incendio, cristales y robo de contenido piden patente_vehiculo y provincia_siniestro; el resto de los ramos pide sólo provincia_siniestro. A la patente_vehiculo la satisfacen también party_a_plate, vehicle_plate y patente, nunca la del tercero; a provincia_siniestro, provincia; a hora_siniestro, accident_time y hora.
- Los documentos pendientes del ramo (por ejemplo fotos_danos, parte_amistoso, licencia_conducir o denuncia_policial). Los que la persona dijo que no existen no se piden.

El orden es siempre el mismo: primero lo que falta, que traba la denuncia; después los datos que hay que confirmar, que sólo la demoran; al final los documentos, que es lo más lento de juntar.

Un mensaje pide como máximo 5 cosas. Lo que el agente elige pedir se recorta a lo que todavía falta, y lo que ya se pidió y sigue faltando se conserva, en el mismo orden, antes de lo nuevo.

Sin plan del agente (la deliberación se cayó) no se inventa un pedido nuevo: se repite el que está en pie, y sólo cuando no queda nada de aquel se arma con lo que falta, hasta 5 cosas.
