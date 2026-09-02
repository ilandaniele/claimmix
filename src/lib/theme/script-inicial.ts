/**
 * El script que decide el tema antes del primer pintado.
 *
 * Vive acá y no escrito adentro del layout por una razón concreta: repite la
 * lógica de `ThemeContext` —la misma clave, el mismo orden de preferencias— y
 * dos copias de una regla en dos archivos distintos se separan. Acá al menos
 * comparten la constante, y hay un test que ejecuta este string de verdad y
 * comprueba que decida lo mismo que decidiría el contexto.
 *
 * Es un string y no una función porque tiene que viajar como texto adentro del
 * HTML: es lo único que corre entre que el navegador recibe la página y la
 * dibuja. Cualquier cosa que pase por React llega tarde.
 */

/** Dónde queda guardada la elección de quien apretó el botón. */
export const CLAVE_TEMA = "claimmix-theme";

/**
 * El orden es: lo que la persona eligió, y si no eligió nunca, lo que pide el
 * sistema operativo. El `try` es porque `localStorage` tira en algunos modos
 * privados, y un tema equivocado es mucho mejor que una página en blanco.
 */
export const SCRIPT_TEMA_INICIAL = `try{var t=localStorage.getItem(${JSON.stringify(
  CLAVE_TEMA
)});if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}var e=document.documentElement;if(t==="dark"){e.classList.add("dark")}else{e.classList.remove("dark")}e.style.colorScheme=t}catch(_){}`;
