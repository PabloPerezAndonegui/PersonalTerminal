import type { MarketSnapshot, OrderBook } from '@defi/core';

/**
 * Mete un snapshot en el mapa SIN dejar que pise a otro en silencio.
 *
 * Dos simbolos nativos distintos pueden normalizar al mismo nombre, y con un
 * `Map.set` pelado el ultimo gana sin que nadie se entere. Paso de verdad:
 * Pacifica publica el perpetuo `SOL` y el spot `SOL-USDC` en la misma lista, y
 * el spot pisaba al perpetuo. La SOL de Pacifica aparecia con funding 0 —el
 * spot no tiene— y 130k de volumen en vez de 62 millones, y el scanner cruzaba
 * ese cero contra el funding real de los demas venues.
 *
 * Se queda el de mas volumen, que es el mercado de verdad, y la colision se
 * anota: el criterio puede acertar, pero que dos mercados choquen es siempre
 * algo que hay que mirar, no algo que resolver por defecto y callar.
 */
export function setSinPisar(
  destino: Map<string, MarketSnapshot>,
  snapshot: MarketSnapshot,
  colisiones: string[],
): void {
  const previo = destino.get(snapshot.symbol);
  if (previo === undefined) {
    destino.set(snapshot.symbol, snapshot);
    return;
  }

  // Un volumen desconocido no puede ganarle a uno conocido: null no es cero,
  // pero tampoco es un argumento para preferir ese mercado.
  const gana = (snapshot.volume24hUsd ?? -1) > (previo.volume24hUsd ?? -1);
  const ganador = gana ? snapshot : previo;
  const perdedor = gana ? previo : snapshot;

  colisiones.push(
    `${snapshot.symbol}: ${perdedor.symbolNative} y ${ganador.symbolNative} normalizan igual; ` +
      `se queda ${ganador.symbolNative} por volumen`,
  );
  destino.set(snapshot.symbol, ganador);
}

/**
 * Lleva los precios a UNIDADES DEL ACTIVO NORMALIZADO.
 *
 * Los venues no coinciden ni en el nombre ni en la unidad: dYdX publica PEPE
 * con su precio real (0,0000037) mientras Hyperliquid publica 'kPEPE', cuyo
 * precio es el de MIL PEPE (0,0037). `normalizeSymbol` ya unifica el nombre,
 * pero si el precio se deja en unidades del contrato, la pestana Parity
 * mostraria un arbitraje del 99.900 % que no existe, y el coste de ejecucion
 * saldria mal por un factor de mil.
 *
 * El nocional se conserva: al dividir el precio entre M hay que multiplicar el
 * tamano por M, asi que el USD por nivel del libro no cambia y el slippage en
 * bps sale identico. Por eso `openInterestUsd` y `volume24hUsd`, que ya vienen
 * en USD, no se tocan.
 *
 * Para operar se usan `symbolNative` y `contractMultiplier`, que siguen en el
 * snapshot: el signer necesita el tamano en unidades del venue, no en las
 * nuestras.
 */
export function toUnitPrices(snapshot: MarketSnapshot): MarketSnapshot {
  const m = snapshot.contractMultiplier;
  if (m === 1 || !Number.isFinite(m) || m <= 0) return snapshot;
  return {
    ...snapshot,
    mid: snapshot.mid / m,
    bid: snapshot.bid / m,
    ask: snapshot.ask / m,
    book: snapshot.book === null ? null : scaleBookToUnits(snapshot.book, m),
  };
}

/** Aplica `toUnitPrices` a un mapa entero de snapshots. */
export function mapToUnitPrices(
  snapshots: ReadonlyMap<string, MarketSnapshot>,
): Map<string, MarketSnapshot> {
  const out = new Map<string, MarketSnapshot>();
  for (const [symbol, snapshot] of snapshots) out.set(symbol, toUnitPrices(snapshot));
  return out;
}

/**
 * Reescala un libro a unidades del activo normalizado.
 * Precio entre M y tamano por M: el USD de cada nivel se conserva.
 */
export function scaleBookToUnits(book: OrderBook, multiplier: number): OrderBook {
  if (multiplier === 1 || !Number.isFinite(multiplier) || multiplier <= 0) return book;
  const lado = (levels: readonly { price: number; size: number }[]) =>
    levels.map((l) => ({ price: l.price / multiplier, size: l.size * multiplier }));
  return { bids: lado(book.bids), asks: lado(book.asks) };
}
