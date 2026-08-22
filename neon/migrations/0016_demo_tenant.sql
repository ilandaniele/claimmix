-- Que la demo pública no pueda apagar el intake de un asegurador.
--
-- /api/demo/analyze público corre sin autenticación —así tiene que ser, es la
-- pantalla que ve un prospecto— y descontaba del MISMO tenant que produce las
-- denuncias reales. Dos topes lo frenan, y los dos eran compartidos:
--
--   · el cupo diario de tokens del tenant, que era el tenant de producción;
--   · el tope mensual en dólares, que no filtra por tenant en absoluto: suma
--     el gasto del proyecto entero.
--
-- O sea que un anónimo con IPs rotativas —que cuestan centavos— podía agotar
-- cualquiera de los dos y a partir de ahí ninguna denuncia real se extraía. No
-- caía nada: el worker anota un warn y el caso se queda esperando. Un
-- asegurado escribe, nadie contesta, y en los tableros está todo verde.
--
-- La demo pasa a tener tenant propio, con su propio cupo, y el tope mensual de
-- producción deja de contar lo que gasta la demo. Se pueden seguir quemando
-- los dólares de la demo; lo que ya no se puede es quemar los del asegurador.

INSERT INTO public.tenants (id, name)
VALUES ('20000000-0000-0000-0000-000000000002', 'Demo pública')
ON CONFLICT (id) DO NOTHING;
