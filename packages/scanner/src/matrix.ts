import type { FundingKind, MarketSnapshot } from '@defi/core';
import { toHourly, precioDeReferencia } from '@defi/core';

/**
 * Matriz de funding: un simbolo por fila, un venue por columna.
 *
 * Es la vista de "screener": no calcula costes ni profundidad, solo compara
 * tasas entre los venues que el usuario elige. El diferencial y los papeles de
 * largo y corto se calculan SOLO entre esos venues, asi que quitar uno cambia
 * el resultado, que es justo lo que se quiere poder ver.
 *
 * Todo va en tasa HORARIA para que venues con ventanas distintas (Paradex a
 * 8 h, el resto a 1 h) sean comparables. La escala de la pantalla (bps a 1 h,
 * a 8 h, APR) es solo una multiplicacion y la hace el cliente.
 */

export interface MatrixCell {
  /** Tasa por hora, ya normalizada. */
  readonly hourlyRate: number;
  /** Precio medio, que es lo que permite ver si dos venues hablan del mismo activo. */
  readonly mid: number;
  /** El numero tal cual lo publica el venue. */
  readonly nativeRate: number;
  readonly intervalHours: number;
  /** Vigente o prevista: dydx publica la del proximo periodo. */
  readonly kind: FundingKind;
  readonly volume24hUsd: number | null;
  readonly openInterestUsd: number | null;
}

/**
 * A partir de que desajuste de precio se deja de creer que dos venues hablan
 * del mismo activo.
 *
 * Entre venues de verdad el mismo activo cotiza a menos de un 1 % de
 * diferencia; esta aplicacion existe justamente porque el funding SI diverge y
 * el precio NO. Un factor de 1,5 no lo produce ningun mercado: lo produce un
 * ticker que significa dos cosas.
 */
const DESAJUSTE_MAXIMO = 1.5;

export interface MatrixRow {
  readonly symbol: string;
  /** Solo los venues elegidos que listan el simbolo. */
  readonly cells: Readonly<Record<string, MatrixCell>>;
  /** Venue con el funding mas bajo: ahi va el largo. null si no hay cruce. */
  readonly longVenue: string | null;
  /** Venue con el funding mas alto: ahi va el corto, que es el que cobra. */
  readonly shortVenue: string | null;
  /**
   * Funding del corto menos funding del largo, por hora. Es un diferencial
   * BRUTO: sin fees ni slippage, que es lo que da la vista de APR neto.
   * null si el simbolo esta en menos de dos de los venues elegidos.
   */
  readonly spreadHourly: number | null;
  /**
   * Venues apartados de la comparacion porque su precio dice que ese ticker es
   * otro activo. Vacio casi siempre; se ensena para que el hueco no parezca un
   * fallo.
   */
  readonly conflicts: readonly string[];
}

/**
 * Aparta los venues cuyo precio no cuadra con el del resto.
 *
 * Con venues de acciones al lado de los de cripto, un ticker puede significar
 * dos cosas: CAT es Caterpillar a 807 dolares en QFEX y un memecoin a
 * 0,0000020 en Aster; BB es BlackBerry y BounceBit; PURR es el memecoin de
 * Hyperliquid y otra cosa en QFEX. Comparar sus funding no da una oportunidad,
 * da un numero sin significado.
 *
 * Con tres venues o mas manda el grupo MAYORITARIO de precios y se apartan los
 * que se salgan. Con SOLO DOS no hay forma de saber cual de los dos es el
 * bueno, asi que si no cuadran se apartan los dos y el simbolo desaparece de la
 * comparacion. Y con un empate, por ejemplo cuatro venues repartidos dos y dos,
 * tampoco: se aparta el simbolo entero. Mejor ninguna senal que una inventada.
 */
function sinConflictos(
  todas: Record<string, MatrixCell>,
  venues: readonly string[],
): { cells: Record<string, MatrixCell>; enConflicto: string[] } {
  const presentes = venues.filter((v) => todas[v] !== undefined);
  if (presentes.length < 2) return { cells: todas, enConflicto: [] };

  const precios = presentes.map((v) => todas[v]!.mid).filter((p) => p > 0);
  if (precios.length < 2) return { cells: todas, enConflicto: [] };

  // La referencia es el grupo MAYORITARIO, no la mediana. Con QNT en cuatro
  // venues, dos a 252 y dos a 46,5, la mediana caia en 149 y `precios[n/2]`
  // se quedaba con el grupo de arriba solo por el orden del array. Ninguna de
  // las dos mitades tenia mejor derecho, asi que ahora no gana ninguna.
  const referencia = precioDeReferencia(precios, DESAJUSTE_MAXIMO);
  if (referencia === null) {
    // Sin mayoria no hay con que comparar: el ticker significa dos cosas y no
    // se puede saber cual cuenta. Fuera los dos, como con dos venues.
    return { cells: {}, enConflicto: [...presentes] };
  }

  const fuera = presentes.filter((v) => {
    const mid = todas[v]!.mid;
    if (mid <= 0) return false;
    const factor = mid / referencia.precio;
    return factor > DESAJUSTE_MAXIMO || factor < 1 / DESAJUSTE_MAXIMO;
  });
  if (fuera.length === 0) return { cells: todas, enConflicto: [] };

  // Dos venues que no cuadran: ninguno es la referencia del otro.
  const enConflicto = presentes.length === 2 ? [...presentes] : fuera;
  const cells: Record<string, MatrixCell> = {};
  for (const v of presentes) if (!enConflicto.includes(v)) cells[v] = todas[v]!;
  return { cells, enConflicto };
}

/**
 * Construye la matriz para los venues elegidos.
 *
 * Solo entran los simbolos que listan al menos `minVenues` de ellos: con uno
 * solo no hay nada que comparar. Ordenada de mayor a menor diferencial.
 *
 * **`anchor` cambia la pregunta.** Sin el, se busca el mejor cruce entre los
 * venues elegidos. Con el, se busca el mejor cruce en el que UNA DE LAS DOS
 * PATAS este en ese venue, mirando a todos los demas como posible contraparte.
 * Es lo que se quiere cuando ya operas en un sitio: no "donde esta la mejor
 * oportunidad del mundo" sino "cual es la mejor que puedo montar desde aqui".
 */
export function fundingMatrix(
  snapshots: ReadonlyMap<string, ReadonlyMap<string, MarketSnapshot>>,
  venues: readonly string[],
  minVenues = 2,
  anchor: string | null = null,
): MatrixRow[] {
  const elegidos = new Set(venues);
  const porSimbolo = new Map<string, Record<string, MatrixCell>>();

  // Se recorre en el orden de `venues` y no en el del mapa: asi el desempate
  // entre dos tasas identicas es estable y no depende de que venue respondio
  // antes en el ciclo.
  for (const venue of venues) {
    if (!elegidos.has(venue)) continue;
    const snaps = snapshots.get(venue);
    if (snaps === undefined) continue;
    for (const [symbol, s] of snaps) {
      // Sin funding no hay celda: ver `instrument` en MarketSnapshot.
      if (s.instrument === 'swap') continue;
      const celdas = porSimbolo.get(symbol) ?? {};
      celdas[venue] = {
        hourlyRate: toHourly(s.funding),
        mid: s.mid,
        nativeRate: s.funding.rate,
        intervalHours: s.funding.intervalHours,
        kind: s.funding.kind,
        volume24hUsd: s.volume24hUsd,
        openInterestUsd: s.openInterestUsd,
      };
      porSimbolo.set(symbol, celdas);
    }
  }

  const filas: MatrixRow[] = [];
  for (const [symbol, todas] of porSimbolo) {
    const { cells, enConflicto } = sinConflictos(todas, venues);
    const entradas = venues
      .filter((v) => cells[v] !== undefined)
      .map((v) => [v, cells[v]!.hourlyRate] as const);
    if (entradas.length < minVenues) continue;

    // Sin ancla, el mejor cruce entre todos. Con ancla, el mejor cruce que
    // pase por ella: o bien el ancla va larga contra el que mas paga, o bien
    // va corta contra el que menos.
    const ancla = anchor === null ? undefined : entradas.find((e) => e[0] === anchor);
    if (anchor !== null && ancla === undefined) continue;

    let largo = entradas[0]!;
    let corto = entradas[0]!;
    for (const e of entradas) {
      if (e[1] < largo[1]) largo = e;
      if (e[1] > corto[1]) corto = e;
    }

    if (ancla !== undefined) {
      const comoLargo = corto[1] - ancla[1];
      const comoCorto = ancla[1] - largo[1];
      if (comoLargo >= comoCorto) largo = ancla;
      else corto = ancla;
    }

    const spread = corto[1] - largo[1];
    filas.push({
      symbol,
      cells,
      conflicts: enConflicto,
      // Con todas las tasas iguales no hay cruce que hacer: se dice que el
      // diferencial es cero, pero no se senala un largo ni un corto.
      longVenue: spread > 0 ? largo[0] : null,
      shortVenue: spread > 0 ? corto[0] : null,
      spreadHourly: spread,
    });
  }

  filas.sort((a, b) => (b.spreadHourly ?? -1) - (a.spreadHourly ?? -1));
  return filas;
}
