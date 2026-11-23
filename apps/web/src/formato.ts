/**
 * Formato de cifras para la pantalla.
 *
 * Modulo aparte de `api.ts` por dos razones. La primera es que son funciones
 * puras y no tienen nada que ver con hablar con el servidor. La segunda es
 * practica: `api.ts` lee `import.meta.env`, que solo existe dentro de Vite, asi
 * que cualquier cosa que viva ahi no se puede probar con `node --test`. Y esto
 * hay que probarlo, porque las once copias que habia antes se diferenciaban
 * justo en los casos limite.
 */

/**
 * Dolares en forma compacta. La UNICA de la app.
 *
 * Habia once copias de esto, una por pantalla, con seis comportamientos
 * distintos: mil quinientos millones salian como "$1.50B", "$1.5B" o
 * "$1500.00M" segun donde se mirase. Y la de Bridges no tenia rama por debajo
 * de mil, asi que 500 dolares se pintaban "$1K" y 100 dolares "$0K".
 *
 * La escalera de decimales es fija, que es lo que exige DESIGN.md para que dos
 * cifras de la misma columna midan lo mismo: miles de millones con dos,
 * millones y miles con uno, y por debajo de mil sin decimales, porque ahi los
 * centimos no deciden nada.
 *
 * El umbral se mira sobre el VALOR ABSOLUTO. Mirandolo con signo, un -2.500.000
 * no llegaba a la rama de los millones y salia como "$-2500000".
 */
export function usd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/**
 * Dolares al centimo, para lo que el usuario ha APUNTADO el.
 *
 * Un cobro de 1.234,56 no se redondea a "$1.2K": es una cantidad concreta que
 * el usuario escribio y tiene que poder cuadrar con su extracto. Por eso esto
 * existe aparte y no es un parametro del de arriba: son dos intenciones
 * distintas, no dos ajustes de la misma.
 */
export function usdExact(v: number | null, decimals = 2): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${v < 0 ? '-' : ''}$${s}`;
}
