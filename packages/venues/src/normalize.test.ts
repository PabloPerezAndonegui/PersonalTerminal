import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketSnapshot } from '@defi/core';
import { walkBook } from '@defi/core';
import { toUnitPrices, scaleBookToUnits, mapToUnitPrices, setSinPisar } from './normalize.ts';

const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  venue: 'v',
  symbol: 'PEPE',
  symbolNative: 'kPEPE',
  contractMultiplier: 1000,
  mid: 0.0037,
  bid: 0.00369,
  ask: 0.00371,
  funding: { rate: 0.0001, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' },
  book: null,
  openInterestUsd: 1e6,
  volume24hUsd: 5e6,
  at: 1000,
  sourceAt: null,
  ...over,
});

test('el precio pasa a unidades del activo, no del contrato', () => {
  // 'kPEPE' cuesta 0.0037 porque son MIL pepes. Un PEPE vale 0.0000037.
  const s = toUnitPrices(snap());
  assert.ok(Math.abs(s.mid - 0.0000037) < 1e-12);
  assert.ok(Math.abs(s.bid - 0.00000369) < 1e-12);
  assert.ok(Math.abs(s.ask - 0.00000371) < 1e-12);
});

test('sin multiplicador el snapshot no se toca', () => {
  const original = snap({ contractMultiplier: 1, symbolNative: 'PEPE' });
  assert.equal(toUnitPrices(original), original, 'se devuelve el mismo objeto');
});

test('el volumen y el interes abierto NO se reescalan: ya vienen en USD', () => {
  const s = toUnitPrices(snap());
  assert.equal(s.openInterestUsd, 1e6);
  assert.equal(s.volume24hUsd, 5e6);
});

test('se conservan el simbolo nativo y el multiplicador para poder operar', () => {
  // El signer necesita el tamano en unidades del venue, no en las nuestras.
  const s = toUnitPrices(snap());
  assert.equal(s.symbolNative, 'kPEPE');
  assert.equal(s.contractMultiplier, 1000);
});

test('el libro conserva el USD de cada nivel al reescalarse', () => {
  const book = { bids: [{ price: 0.0037, size: 100 }], asks: [{ price: 0.0038, size: 200 }] };
  const usdAntes = book.bids[0]!.price * book.bids[0]!.size;

  const escalado = scaleBookToUnits(book, 1000);
  const usdDespues = escalado.bids[0]!.price * escalado.bids[0]!.size;

  assert.ok(Math.abs(usdAntes - usdDespues) < 1e-12, 'el nocional por nivel no cambia');
  assert.ok(Math.abs((escalado.bids[0]?.price ?? 0) - 0.0000037) < 1e-12);
  assert.equal(escalado.bids[0]?.size, 100_000);
});

test('el slippage en bps es identico antes y despues de reescalar', () => {
  // Es la comprobacion que justifica el diseno: si el nocional se conserva, el
  // coste de ejecucion no puede depender de en que unidades se mire el libro.
  const book = { bids: [], asks: [{ price: 0.0037, size: 1_000_000 }] };
  const antes = walkBook(book.asks, 0.0037, 1000);
  const escalado = scaleBookToUnits(book, 1000);
  const despues = walkBook(escalado.asks, 0.0037 / 1000, 1000);
  assert.ok(Math.abs(antes.slippageBps - despues.slippageBps) < 1e-9);
  assert.equal(antes.insufficientDepth, despues.insufficientDepth);
});

test('mapToUnitPrices aplica la conversion a todo el mapa', () => {
  const entrada = new Map([
    ['PEPE', snap()],
    ['BTC', snap({ symbol: 'BTC', symbolNative: 'BTC', contractMultiplier: 1, mid: 78_000 })],
  ]);
  const salida = mapToUnitPrices(entrada);
  assert.ok(Math.abs((salida.get('PEPE')?.mid ?? 0) - 0.0000037) < 1e-12);
  assert.equal(salida.get('BTC')?.mid, 78_000, 'los que no llevan multiplicador quedan igual');
});

test('un multiplicador invalido no destroza los precios', () => {
  for (const m of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const s = toUnitPrices(snap({ contractMultiplier: m }));
    assert.equal(s.mid, 0.0037, `multiplicador ${m}`);
  }
});

// --- Colisiones al normalizar ------------------------------------------------

test('el spot no pisa al perpetuo: gana el de mas volumen', () => {
  // Caso real de Pacifica: publica el perpetuo `SOL` y el spot `SOL-USDC` en
  // la misma lista, y los dos normalizan a `SOL`. El spot llegaba despues y se
  // quedaba el sitio, con funding 0 —no tiene— y 130k de volumen en vez de 62
  // millones. Ese cero acababa cruzandose contra el funding real de los demas.
  const mapa = new Map<string, MarketSnapshot>();
  const colisiones: string[] = [];

  const perp = snap({ symbol: 'SOL', symbolNative: 'SOL', contractMultiplier: 1, volume24hUsd: 62_270_991 });
  const spot = snap({
    symbol: 'SOL', symbolNative: 'SOL-USDC', contractMultiplier: 1, volume24hUsd: 130_310,
    funding: { rate: 0, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' },
  });

  setSinPisar(mapa, perp, colisiones);
  setSinPisar(mapa, spot, colisiones);

  assert.equal(mapa.get('SOL')?.symbolNative, 'SOL', 'gana el perpetuo, que es el mercado de verdad');
  assert.equal(mapa.get('SOL')?.funding.rate, 0.0001, 'con su funding, no con el cero del spot');
  assert.equal(colisiones.length, 1, 'y la colision queda anotada, no resuelta en silencio');
  assert.match(colisiones[0] ?? '', /SOL-USDC/);
});

test('el orden de llegada no decide', () => {
  // El bug original era exactamente esto: quien llegaba el ultimo ganaba.
  const alReves = new Map<string, MarketSnapshot>();
  const c: string[] = [];
  setSinPisar(alReves, snap({ symbol: 'SOL', symbolNative: 'SOL-USDC', volume24hUsd: 130_310 }), c);
  setSinPisar(alReves, snap({ symbol: 'SOL', symbolNative: 'SOL', volume24hUsd: 62_270_991 }), c);
  assert.equal(alReves.get('SOL')?.symbolNative, 'SOL');
});

test('un volumen desconocido no le gana a uno conocido', () => {
  const mapa = new Map<string, MarketSnapshot>();
  const c: string[] = [];
  setSinPisar(mapa, snap({ symbol: 'X', symbolNative: 'X-A', volume24hUsd: 1000 }), c);
  setSinPisar(mapa, snap({ symbol: 'X', symbolNative: 'X-B', volume24hUsd: null }), c);
  // null no es cero, pero tampoco es un argumento para preferir ese mercado.
  assert.equal(mapa.get('X')?.symbolNative, 'X-A');
});

test('sin colision no se anota nada', () => {
  const mapa = new Map<string, MarketSnapshot>();
  const c: string[] = [];
  setSinPisar(mapa, snap({ symbol: 'BTC' }), c);
  setSinPisar(mapa, snap({ symbol: 'ETH' }), c);
  assert.equal(mapa.size, 2);
  assert.equal(c.length, 0);
});
