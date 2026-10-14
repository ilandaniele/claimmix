/**
 * Los ids de Meta que guarda la base, definidos una sola vez: el ancho de cada uno es el
 * de su CHECK en la 0049 y la 0051, y `tests/unit/meta-ids.test.ts` lo compara con el SQL.
 * Sin imports: lo usan también los módulos del navegador.
 */

/** Negocio, WABA y número de teléfono: dígitos, de 6 a 20. */
export const ID_DE_META = /^\d{6,20}$/;

/** La persona de Facebook (`fb_user_id`, `user_id` del pedido de borrado): dígitos, de 1 a 30. */
export const ID_DE_USUARIO_DE_META = /^\d{1,30}$/;
