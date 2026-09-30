/**
 * El primer mail que sale a quien completó el formulario web.
 *
 * La dirección la escribió quien llenó el formulario y nada prueba que sea
 * suya: el primer mail a esa casilla dice cómo salir del paso si no fue ella.
 * Va agregado por el mensajero, no lo redacta el modelo: sin esta frase el
 * mail no se manda.
 */

export const SI_NO_FUISTE_VOS = "Si no fuiste vos, ignorá este mensaje.";
