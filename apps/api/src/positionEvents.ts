import type { AccountSnapshot, Position, PositionSide } from '@defi/core';

/**
 * Que ha cambiado entre dos lecturas de una cuenta.
 *
 * De donde sale el dato, y que NO es. Esto compara dos fotos separadas por el
 * intervalo de sondeo, asi que dice como ha quedado la cuenta, no que ordenes
 * se han ejecutado. Si un trader abre y cierra dentro del mismo minuto, aqui
 * no aparece nada, y si aumenta en tres veces seguidas aparece UNA subida con
 * la suma. Las ejecuciones de verdad estan en `userFills` y son la fase 4;
 * mientras tanto, un aviso de aqui no puede presentarse como "ha comprado":
 * se presenta como que su posicion es mayor que antes.
 *
 * **El tamano manda, no el nocional.** El nocional se mueve solo con el
 * precio: una posicion intacta de BTC cambia de valor cada segundo. Comparar
 * nocionales convertiria cada vela en una racha de avisos. Lo que decide es
 * `sizeBase`, que solo cambia si alguien opera.
 */

export type PositionEventKind = 'opened' | 'closed' | 'increased' | 'reduced' | 'flipped';

export interface PositionEvent {
  readonly venue: string;
  readonly address: string;
  readonly symbol: string;
  /**
   * El mercado como lo nombra el venue: en Hyperliquid `xyz:NVDA` no es el
   * NVDA de `io:NVDA`, aunque los dos tengan `symbol` NVDA.
   */
  readonly market?: string;
  readonly kind: PositionEventKind;
  /** El lado DESPUES del cambio. Al cerrar, el que tenia. */
  readonly side: PositionSide;
  readonly sizeBase: number;
  readonly prevSizeBase: number;
  /** Valor en USD de la posicion resultante. Al cerrar, cero. */
  readonly notionalUsd: number;
  /** Valor en USD de lo que ha cambiado, al precio de marca del momento. */
  readonly deltaUsd: number;
  readonly markPrice: number | null;
  /** Sello de la lectura NUEVA, no del momento en que se opero. */
  readonly at: number;
}

export interface DiffOptions {
  /**
   * Movimiento minimo, en dolares, para que algo se avise.
   *
   * Se mide sobre **lo que ha cambiado**, no sobre el tamano de la posicion.
   * Un recorte de 120 dolares en una cuenta de tres millones no es una noticia
   * aunque la posicion recortada valga cien mil, y al reves: una posicion
   * nueva de cincuenta mil lo es aunque sea la mas pequena de la cuenta.
   */
  readonly minNotionalUsd?: number;
  /**
   * Cambio minimo de tamano, en tanto por uno, para contar como subida o
   * bajada. Un 1 % cubre el ruido de redondeo del venue sin tapar un cambio
   * real: quien mueve una posicion, la mueve mas que eso.
   */
  readonly minChangeRatio?: number;
}

const MINIMO_USD = 500;
const CAMBIO_MINIMO = 0.01;

/** Tamano con signo: largo positivo, corto negativo. Asi un giro se ve solo. */
const conSigno = (p: Position): number => (p.side === 'long' ? p.sizeBase : -p.sizeBase);

/**
 * Precio de marca, declarado o deducido.
 *
 * Hyperliquid no publica `markPrice` por posicion, pero si el valor y el
 * tamano, y el valor ES tamano por precio de marca: dividir devuelve el mismo
 * precio, no una estimacion. Importa tenerlo porque sin el hay que medir lo
 * que ha cambiado restando nocionales, y esa resta mezcla lo que ha operado el
 * trader con lo que se ha movido el precio.
 */
const precioDe = (p: Position): number | null =>
  p.markPrice ?? (p.sizeBase > 0 ? p.notionalUsd / p.sizeBase : null);

/**
 * Compara dos fotos de la misma cuenta.
 *
 * `prev` a null significa que es la PRIMERA lectura: devuelve lista vacia. Es
 * deliberado y es la diferencia entre un aviso y un susto. Al arrancar el
 * proceso no se sabe que habia antes, y tratar la primera foto como novedad
 * mandaria 177 avisos de "posicion abierta" por reiniciar la API.
 */
export function diffPositions(
  prev: AccountSnapshot | null,
  next: AccountSnapshot,
  options: DiffOptions = {},
): PositionEvent[] {
  if (prev === null) return [];

  const minimo = options.minNotionalUsd ?? MINIMO_USD;
  const ratio = options.minChangeRatio ?? CAMBIO_MINIMO;

  // Por el mercado exacto y no por el simbolo comun: una wallet puede tener
  // NVDA en dos dexes HIP-3 a la vez, y por simbolo una pisaria a la otra.
  const clave = (p: Position) => (p.symbolNative === '' ? p.symbol : p.symbolNative);
  const antes = new Map(prev.positions.map((p) => [clave(p), p]));
  const ahora = new Map(next.positions.map((p) => [clave(p), p]));
  const eventos: PositionEvent[] = [];

  const base = (p: Position | undefined, otro: Position | undefined) => ({
    venue: next.venue,
    address: next.address,
    symbol: (p ?? otro)!.symbol,
    market: (p ?? otro)!.symbolNative,
    markPrice: (p === undefined ? null : precioDe(p)) ?? (otro === undefined ? null : precioDe(otro)),
    at: next.at,
  });

  for (const [symbol, p] of ahora) {
    const a = antes.get(symbol);

    if (a === undefined) {
      if (p.notionalUsd < minimo) continue;
      eventos.push({
        ...base(p, undefined), kind: 'opened', side: p.side,
        sizeBase: p.sizeBase, prevSizeBase: 0,
        notionalUsd: p.notionalUsd, deltaUsd: p.notionalUsd,
      });
      continue;
    }

    // Giro: de largo a corto o al reves. Es un caso propio y no dos avisos,
    // porque leer "cerro" y "abrio" por separado no dice lo que ha pasado.
    if (a.side !== p.side) {
      const movido = a.notionalUsd + p.notionalUsd;
      if (movido < minimo) continue;
      eventos.push({
        ...base(p, a), kind: 'flipped', side: p.side,
        sizeBase: p.sizeBase, prevSizeBase: a.sizeBase,
        notionalUsd: p.notionalUsd, deltaUsd: movido,
      });
      continue;
    }

    // Mismo lado: decide el TAMANO. El dinero solo sirve para contar cuanto se
    // ha movido, al precio de marca de esta lectura.
    const d = Math.abs(conSigno(p)) - Math.abs(conSigno(a));
    if (a.sizeBase === 0 || Math.abs(d) / a.sizeBase < ratio) continue;
    const precio = precioDe(p) ?? precioDe(a);
    const deltaUsd = precio === null
      ? Math.abs(p.notionalUsd - a.notionalUsd)
      : Math.abs(d) * precio;
    if (deltaUsd < minimo) continue;

    eventos.push({
      ...base(p, a), kind: d > 0 ? 'increased' : 'reduced', side: p.side,
      sizeBase: p.sizeBase, prevSizeBase: a.sizeBase,
      notionalUsd: p.notionalUsd, deltaUsd,
    });
  }

  for (const [symbol, a] of antes) {
    if (ahora.has(symbol)) continue;
    if (a.notionalUsd < minimo) continue;
    eventos.push({
      ...base(undefined, a), kind: 'closed', side: a.side,
      sizeBase: 0, prevSizeBase: a.sizeBase,
      notionalUsd: 0, deltaUsd: a.notionalUsd,
    });
  }

  // De mayor a menor: si llegan quince a la vez, el que mueve dinero va
  // primero.
  return eventos.sort((x, y) => y.deltaUsd - x.deltaUsd);
}
