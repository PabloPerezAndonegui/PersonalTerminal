import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, oiSeries } from '@defi/storage';
import type { MarketSnapshot } from '@defi/core';
import { OpenInterestService } from './openInterest.ts';

const T = 1_800_000_000_000;
const flush = () => new Promise<void>(r => setImmediate(r));

test('OI: origen atrasado y caida no suman ni crean puntos; recuperacion', async (t) => {
  const db = openDatabase({ path: ':memory:' });
  let now = T, origin = T, fail = false;
  const service = new OpenInterestService({ db, clock: () => now, intervalMs: 300000,
    dex: () => new Map(), dexMeta: () => new Map(), sources: [{ id: 'test', label: 'Test',
      fetch: async () => { if (fail) throw new Error('outage'); return { venue: 'test', label: 'Test', kind: 'cex', convention: 'single', coverage: 'test', at: now,
        markets: [{ symbol: 'BTC', symbolNative: 'BTC', openInterestUsd: 100, sourceAt: origin }] }; } }] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    service.start(); await flush(); service.sample();
    assert.equal(service.query({}).total.oiUsd, 100);
    now += 900000; fail = true; t.mock.timers.tick(300000); await flush();
    service.sample();
    assert.equal(service.query({}).total.oiUsd, null);
    assert.equal(service.query({}).total.partial, true);
    assert.equal(oiSeries(db, { from: 0, to: now, symbol: '*' }).length, 1);
    fail = false; t.mock.timers.tick(300000); await flush();
    assert.equal(service.query({}).total.oiUsd, null, 'HTTP correcto con origen antiguo sigue caducado');
    origin = now; t.mock.timers.tick(300000); await flush(); service.sample();
    assert.equal(service.query({}).total.oiUsd, 100);
    assert.equal(oiSeries(db, { from: 0, to: now, symbol: '*' }).length, 2);
  } finally { service.stop(); t.mock.timers.reset(); db.close(); }
});

test('OI: DEX caido permanece; cero, desconocido y no listado son distintos', () => {
  const db = openDatabase({ path: ':memory:' });
  const market = (symbol: string, oi: number | null) => ({ symbol, at: T, openInterestUsd: oi }) as MarketSnapshot;
  const service = new OpenInterestService({ db, clock: () => T, sources: [],
    dexMeta: () => new Map([['down', { label: 'Down', status: 'down' }], ['live', { label: 'Live', status: 'ok' }]]),
    dex: () => new Map([['live', new Map([['ZERO', market('ZERO', 0)], ['UNKNOWN', market('UNKNOWN', null)]])]]) });
  try {
    assert.equal(service.query({}).venues.length, 2);
    assert.equal(service.query({}).current.find(v => v.id === 'down')?.oiUsd, null);
    const zero = service.query({ venues: ['live'], symbol: 'ZERO' });
    assert.equal(zero.total.oiUsd, 0); assert.equal(zero.current[0]?.listed, true);
    const unknown = service.query({ venues: ['live'], symbol: 'UNKNOWN' });
    assert.equal(unknown.total.oiUsd, null); assert.equal(unknown.current[0]?.listed, true);
    assert.equal(service.query({ venues: ['live'], symbol: 'ABSENT' }).current[0]?.listed, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM oi_snapshot').get()?.['n'], 0, 'consultar no escribe');
  } finally { db.close(); }
});

test('OI: fallo al guardar visible y reintentable sin consumir la cadencia', () => {
  const db = openDatabase({ path: ':memory:' });
  const service = new OpenInterestService({ db, clock: () => T, sources: [],
    dexMeta: () => new Map([['live', { label: 'Live', status: 'ok' }]]),
    dex: () => new Map([['live', new Map([['BTC', { symbol: 'BTC', at: T, openInterestUsd: 2000000 } as MarketSnapshot]])]]) });
  try {
    db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON oi_snapshot BEGIN SELECT RAISE(FAIL, 'disk error'); END");
    assert.throws(() => service.sample()); assert.ok(service.query({}).storageError);
    db.exec('DROP TRIGGER fail_insert'); service.sample();
    assert.equal(service.query({}).storageError, null);
    assert.equal(oiSeries(db, { from: 0, to: T, symbol: '*' }).length, 1);
  } finally { db.close(); }
});

test('una tasa anualizada no es una cadencia de cobro', async () => {
  const { cadenciaDeCobro } = await import('./openInterest.ts');
  assert.equal(cadenciaDeCobro(8760), null, 'Variational: la tasa es anual, cobra cada 4 u 8 h');
  assert.equal(cadenciaDeCobro(1), 1);
  assert.equal(cadenciaDeCobro(8), 8);
  assert.equal(cadenciaDeCobro(undefined), null);
});

test('el historico de fuera solo se usa si mide lo mismo que lo nuestro', async () => {
  const { historicoCuadra } = await import('./openInterest.ts');
  assert.equal(historicoCuadra(11.08e9, 6.95e9), false, 'Hyperliquid: DefiLlama incluye los HIP-3');
  assert.equal(historicoCuadra(1.0e9, 1.1e9), true);
  assert.equal(historicoCuadra(undefined, 1e9), false);
  assert.equal(historicoCuadra(1e9, null), false);
});
