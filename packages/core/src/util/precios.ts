/**
 * Cual es el precio "de verdad" de un ticker cuando los venues no coinciden.
 *
 * ## El fallo que arregla
 *
 * Se usaba la mediana como referencia. Con una lista PAR y dos grupos, la
 * mediana cae en el hueco entre ellos, donde no esta ningun venue. Medido el 5
 * de octubre de 2026 con QNT, que listan cuatro venues:
 *
 *     46,44  46,50  |  252,32  252,85     mediana = 149,41
 *
 * Nadie cotiza a 149,41. Asi que los cuatro se desviaban de la referencia y los
 * cuatro se marcaban como sospechosos, cuando lo que pasa es que QNT son DOS
 * activos distintos y cada par de venues tiene razon sobre el suyo.
 *
 * Peor todavia en la matriz del screener, que cogia `precios[n/2]`, o sea el
 * primero del grupo de arriba. Con un empate a dos eso descarta el grupo de
 * abajo por el orden del array y nada mas. Ninguna de las dos mitades tenia
 * mejor derecho que la otra.
 *
 * ## Lo que se hace en su lugar
 *
 * Se agrupan los precios y manda el grupo MAS GRANDE, que es una referencia que
 * existe de verdad. Si ningun grupo tiene mayoria estricta, no hay referencia y
 * se dice: con un empate a dos no se puede saber cual de los dos QNT es el que
 * cuenta, y elegir uno seria inventarselo.
 */

/**
 * Agrupa precios que podrian ser del mismo activo.
 *
 * Dos precios van juntos si no se separan mas de `tolerancia` veces. Se recorre
 * la lista ordenada y se corta donde el salto es mayor, que con precios de un
 * mismo activo entre venues funciona: las diferencias reales de mercado son de
 * decimas de punto porcentual y los saltos entre activos distintos son de
 * multiplos.
 */
export function agruparPrecios(
  precios: readonly number[],
  tolerancia: number,
): number[][] {
  const validos = precios.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  const grupos: number[][] = [];
  let actual: number[] = [];
  for (const p of validos) {
    const ultimo = actual[actual.length - 1];
    if (ultimo === undefined || p / ultimo <= tolerancia) actual.push(p);
    else { grupos.push(actual); actual = [p]; }
  }
  if (actual.length > 0) grupos.push(actual);
  return grupos;
}

/**
 * El precio de referencia, o `null` si no hay forma de elegirlo.
 *
 * Devuelve la mediana del grupo mayoritario. Exige MAYORIA ESTRICTA sobre el
 * total: con 2 de 4 no basta, porque el otro 2 tiene exactamente el mismo
 * derecho. En ese caso devuelve null y quien llama decide, pero ya sabiendo que
 * no es que los precios bailen, es que el ticker significa dos cosas.
 */
export function precioDeReferencia(
  precios: readonly number[],
  tolerancia: number,
): { precio: number; enElGrupo: number; total: number } | null {
  const grupos = agruparPrecios(precios, tolerancia);
  if (grupos.length === 0) return null;
  const total = grupos.reduce((a, g) => a + g.length, 0);

  let mayor = grupos[0] ?? [];
  for (const g of grupos) if (g.length > mayor.length) mayor = g;
  // Empate: dos grupos del mismo tamano y ninguno manda.
  if (grupos.filter((g) => g.length === mayor.length).length > 1) return null;
  if (mayor.length * 2 <= total) return null;

  const mitad = Math.floor(mayor.length / 2);
  const a = mayor[mitad - 1];
  const b = mayor[mitad];
  const precio = mayor.length % 2 === 1
    ? b
    : a === undefined || b === undefined ? undefined : (a + b) / 2;
  if (precio === undefined || !Number.isFinite(precio) || precio <= 0) return null;
  return { precio, enElGrupo: mayor.length, total };
}
