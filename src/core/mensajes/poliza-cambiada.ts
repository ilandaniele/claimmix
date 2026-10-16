/**
 * El pedido cuando la persona nos dio otra póliza a mitad de la charla.
 *
 * No lleva ningún valor, ni el de antes ni el de ahora: AC24 prohíbe repetir
 * números en la pregunta. Tampoco dice «que nos diste antes»: el padrón también
 * llena la póliza cuando la persona no la dio. Y pide que la escriba, en vez de
 * «¿cuál es el correcto?», porque eso invita a contestar «la primera», que no se
 * puede resolver sin repetir los valores.
 *
 * Vive acá y no adentro de una plantilla porque los dos canales dicen lo mismo.
 */
export const POLIZA_CAMBIADA =
  "El número de póliza que nos pasaste ahora no coincide con el que teníamos para tu caso. ¿Nos escribís el número correcto?";
