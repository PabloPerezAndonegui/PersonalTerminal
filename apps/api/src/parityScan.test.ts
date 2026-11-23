import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { escanearParidad, historiaParidad } from './parityScan.ts';

const AHORA = 1_000_000_000;

const snap = (venue: string, symbol: string, mid: number, o: { vol?: number | null; at?: number; fundingHourly?: number } = {}): MarketSnapshot => ({
  venue, symbol, symbolNative: symbol, contractMultiplier: 1, mid, bid: mid, ask: mid,
  funding: { rate: o.fundingHourly ?? 0, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 't' },
  book: null, openInterestUsd: null, volume24hUsd: o.vol === undefined ? 1e6 : o.vol, at: o.at ?? AHORA, sourceAt: null,
});

const meta = (id: string, takerBps: number | null): VenueMeta => ({
  id, label: id, kind: 'perp-dex', chain: null, collateral: 'USDC', fundingIntervalHours: 1,
  fees: { makerBps: 0, takerBps, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: true, publicPositions: false },
});

function mapa(...s: MarketSnapshot[]) {
  const m = new Map<string, Map<string, MarketSnapshot>>();
  for (const x of s) {
    const v = m.get(x.venue) ?? new Map<string, MarketSnapshot>();
    v.set(x.symbol, x);
    m.set(x.venue, v);
  }
  return m;
}

const OPC = { ahora: AHORA, minVolumeUsd: 250_000, maxAgeMs: 300_000, clase: null, q: '' };
const METAS = new Map([['a', meta('a', 5)], ['b', meta('b', 5)], ['c', meta('c', null)]]);

test('compra en el barato, vende en el caro, y descuenta las comisiones', () => {
  const [f] = escanearParidad(mapa(snap('a', 'SOL', 100), snap('b', 'SOL', 101)), METAS, new Map(), OPC);
  assert.equal(f?.cheap.venue, 'a');
  assert.equal(f?.rich.venue, 'b');
  assert.ok(Math.abs((f?.gapPct ?? 0) - 1) < 1e-9);
  // 5 bps de entrada y 5 de salida en cada pata: 0,2 %.
  assert.ok(Math.abs((f?.feesPct ?? 0) - 0.2) < 1e-9);
  assert.ok(Math.abs((f?.netAtZeroPct ?? 0) - 0.8) < 1e-9);
});

test('el ticker que es otro activo no cuenta como diferencia', () => {
  const filas = escanearParidad(
    mapa(snap('a', 'CAT', 400), snap('b', 'CAT', 401), snap('c', 'CAT', 0.02)), METAS, new Map(), OPC);
  assert.equal(filas[0]?.cheap.venue, 'a', 'el memecoin a 0,02 queda fuera');
  assert.equal(filas[0]?.venues, 2);
});

test('un precio viejo o un mercado sin volumen no entran', () => {
  const filas = escanearParidad(mapa(
    snap('a', 'ETH', 3000),
    snap('b', 'ETH', 3300, { at: AHORA - 600_000 }),
    snap('c', 'ETH', 3200, { vol: 10_000 }),
  ), METAS, new Map(), OPC);
  assert.equal(filas.length, 0, 'solo queda un venue valido');
});

test('sin comision conocida en una pata, el neto es null y no se inventa', () => {
  const [f] = escanearParidad(mapa(snap('a', 'BTC', 100), snap('c', 'BTC', 102)), METAS, new Map(), OPC);
  assert.equal(f?.feesPct, null);
  assert.equal(f?.netAtZeroPct, null);
});

test('el funding se cobra en el corto caro y se paga en el largo barato', () => {
  const [f] = escanearParidad(mapa(
    snap('a', 'SOL', 100, { fundingHourly: 0.0001 }),
    snap('b', 'SOL', 101, { fundingHourly: 0.0003 }),
  ), METAS, new Map(), OPC);
  // (0,0003 - 0,0001) * 24 h * 100 = 0,48 % al dia a favor.
  assert.ok(Math.abs((f?.carryPctPerDay ?? 0) - 0.48) < 1e-9);
});

test('la historia cruza por instante exacto y da la mediana', () => {
  const h = historiaParidad([
    { ts: 1, venue: 'a', mid: 100 }, { ts: 1, venue: 'b', mid: 101 },
    { ts: 2, venue: 'a', mid: 100 }, { ts: 2, venue: 'b', mid: 102 },
    { ts: 3, venue: 'a', mid: 100 }, { ts: 3, venue: 'b', mid: 103 },
    { ts: 4, venue: 'b', mid: 200 },
  ], 'a', 'b');
  assert.equal(h.samples, 3, 'el punto de b sin pareja en a no se usa');
  assert.ok(Math.abs((h.medianPct ?? 0) - 2) < 1e-9);
});

const cotizado = (venue: string, symbol: string, bid: number, ask: number): MarketSnapshot => ({
  ...snap(venue, symbol, (bid + ask) / 2), bid, ask,
});

test('con bid y ask reales, el neto descuenta tambien el spread de las dos patas', () => {
  const [f] = escanearParidad(mapa(cotizado('a', 'SOL', 99.95, 100.05), cotizado('b', 'SOL', 100.95, 101.05)), METAS, new Map(), OPC);
  // Spread: 0,1 % en cada pata. Comisiones: 0,2 %. Bruto: 1 %.
  assert.ok(Math.abs((f?.spreadPct ?? 0) - 0.1999) < 0.001);
  assert.ok(Math.abs((f?.netAtZeroPct ?? 0) - 0.6) < 0.001);
  assert.equal(f?.netIncludesSpread, true);
});

test('una pata sin cotizacion: neto sin spread, y se dice', () => {
  const [f] = escanearParidad(mapa(snap('a', 'SOL', 100), cotizado('b', 'SOL', 100.95, 101.05)), METAS, new Map(), OPC);
  assert.equal(f?.spreadPct, null);
  assert.equal(f?.netIncludesSpread, false);
});

test('la comision propia manda sobre la del registro, y rellena la que falta', () => {
  const [f] = escanearParidad(mapa(snap('a', 'BTC', 100), snap('c', 'BTC', 102)), METAS, new Map(),
    { ...OPC, misComisionesBps: new Map([['c', 2.5]]) });
  // a: 5 bps x2 = 0,1 %; c (sin registro): 2,5 bps x2 = 0,05 %.
  assert.ok(Math.abs((f?.feesPct ?? 0) - 0.15) < 1e-9);
});

test('por neto, lo que no tiene neto va al final', () => {
  const filas = escanearParidad(mapa(
    snap('a', 'SOL', 100), snap('b', 'SOL', 100.5),
    snap('a', 'ETH', 100), snap('c', 'ETH', 103),
  ), METAS, new Map(), { ...OPC, orden: 'net' });
  assert.deepEqual(filas.map((f) => f.symbol), ['SOL', 'ETH']);
});

test('cuantas veces la diferencia supero el coste', () => {
  const h = historiaParidad([
    { ts: 1, venue: 'a', mid: 100 }, { ts: 1, venue: 'b', mid: 100.1 },
    { ts: 2, venue: 'a', mid: 100 }, { ts: 2, venue: 'b', mid: 100.5 },
    { ts: 3, venue: 'a', mid: 100 }, { ts: 3, venue: 'b', mid: 101 },
    { ts: 4, venue: 'a', mid: 100 }, { ts: 4, venue: 'b', mid: 100.2 },
  ], 'a', 'b', 0.3);
  assert.equal(h.aboveCostPct, 50);
  assert.ok(Math.abs((h.maxPct ?? 0) - 1) < 1e-9);
});
