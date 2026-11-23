import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { addTrader, updateTrader, removeTrader } from './traders.ts';
import { insertFills, readFills, lastFillAt, pruneFills, type Fill } from './fills.ts';
import { insertAlertEvents, listAlertEvents } from './alerts.ts';

const DIR = '0x1111111111111111111111111111111111111111';

function base() {
  const db = openDatabase({ path: ':memory:' });
  const t = addTrader(db, { address: DIR });
  const fill = (tid: string, extra: Partial<Fill> = {}): Fill => ({
    tid, traderId: t.id, symbol: 'ETH', ts: 1_000, dir: 'Open Long', side: 'long',
    px: 3000, sz: 1, notionalUsd: 3000, closedPnl: 0, fee: 1, accountPct: 2, ...extra,
  });
  return { db, t, fill };
}

test('releer la misma ventana no duplica: manda tid', () => {
  const { db, fill } = base();
  assert.equal(insertFills(db, [fill('a'), fill('b')]), 2);
  // La recogida solapa cinco minutos a proposito. Los repetidos chocan contra
  // la primaria y se cuentan como cero nuevas.
  assert.equal(insertFills(db, [fill('b'), fill('c')]), 1);
  assert.equal(readFills(db).length, 3);
});

test('sin porcentaje conocido NO se pasa un minimo de conviccion', () => {
  const { db, fill } = base();
  insertFills(db, [
    fill('grande', { accountPct: 5 }),
    fill('pequena', { accountPct: 0.01 }),
    fill('desconocida', { accountPct: null }),
  ]);
  const r = readFills(db, { minAccountPct: 1 });
  // La desconocida queda fuera: no se sabe cuanto movia, y decir que supera
  // el umbral seria inventarselo.
  assert.deepEqual(r.map((f) => f.tid), ['grande']);
});

test('filtra por simbolo y por ventana, y ordena de reciente a antigua', () => {
  const { db, t, fill } = base();
  insertFills(db, [
    fill('1', { ts: 100 }), fill('2', { ts: 200, symbol: 'SOL' }), fill('3', { ts: 300 }),
  ]);
  assert.deepEqual(readFills(db, { symbol: 'ETH' }).map((f) => f.tid), ['3', '1']);
  assert.deepEqual(readFills(db, { from: 150, to: 250 }).map((f) => f.tid), ['2']);
  assert.equal(lastFillAt(db, t.id), 300);
});

test('quitar la wallet se lleva sus ejecuciones', () => {
  const { db, t, fill } = base();
  insertFills(db, [fill('a')]);
  removeTrader(db, t.id);
  assert.equal(readFills(db).length, 0, 'borrado en cascada: sin wallet no hay de quien son');
});

test('la retencion borra lo viejo y solo lo viejo', () => {
  const { db, fill } = base();
  insertFills(db, [fill('vieja', { ts: 100 }), fill('nueva', { ts: 900 })]);
  assert.equal(pruneFills(db, 500), 1);
  assert.deepEqual(readFills(db).map((f) => f.tid), ['nueva']);
});

test('los filtros por wallet: lista vacia y cero son "sin filtro"', () => {
  const { db, t } = base();
  let u = updateTrader(db, t.id, { symbols: ['sol', ' eth ', 'SOL'], minAccountPct: 1.5 });
  assert.deepEqual(u?.symbols, ['SOL', 'ETH'], 'mayusculas y sin repetidos');
  assert.equal(u?.minAccountPct, 1.5);
  // Lista vacia seria "ninguno" y dejaria la wallet muda: se guarda como null.
  u = updateTrader(db, t.id, { symbols: [], minAccountPct: 0 });
  assert.equal(u?.symbols, null);
  assert.equal(u?.minAccountPct, null);
  assert.throws(() => updateTrader(db, t.id, { minAccountPct: 150 }));
  assert.throws(() => updateTrader(db, t.id, { symbols: ['ETH,SOL'] }), 'la coma es el separador de guardado');
});

test('el coin exacto se guarda y se consulta: xyz:NVDA no es el NVDA de otro dex', () => {
  const { db, fill } = base();
  insertFills(db, [fill('x', { symbol: 'NVDA', coin: 'xyz:NVDA' }), fill('i', { symbol: 'NVDA', coin: 'io:NVDA' })]);
  assert.deepEqual(readFills(db, { coin: 'xyz:NVDA' }).map((f) => f.tid), ['x']);
  assert.equal(readFills(db, { symbol: 'NVDA' }).length, 2);
  // Lo guardado antes no traia coin: sale a null, no inventado.
  insertFills(db, [fill('viejo')]);
  assert.equal(readFills(db).find((f) => f.tid === 'viejo')?.coin, null);
});

test('quitar un trader se lleva sus avisos', () => {
  // Sin esto el panel de cambios seguia ensenando los de una wallet ya quitada.
  const { db, t } = base();
  insertAlertEvents(db, [{
    traderId: t.id, venue: 'hyperliquid', address: DIR, symbol: 'ETH', kind: 'opened', side: 'long',
    sizeBase: 1, prevSizeBase: 0, notionalUsd: 3000, deltaUsd: 3000, markPrice: 3000, at: 1_000,
  }]);
  assert.equal(listAlertEvents(db).length, 1);
  removeTrader(db, t.id);
  assert.equal(listAlertEvents(db).length, 0);
});
