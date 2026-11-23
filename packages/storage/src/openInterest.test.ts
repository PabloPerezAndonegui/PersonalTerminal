import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { insertOiSnapshots, oiSeries, oiCoverage, pruneOi, TOTAL } from './openInterest.ts';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const DIA = 86_400_000;

function base() {
  return openDatabase({ path: ':memory:' });
}

test('guarda y devuelve una serie por venue', () => {
  const db = base();
  insertOiSnapshots(db, [
    { ts: T0, venue: 'bybit', symbol: TOTAL, oiUsd: 100 },
    { ts: T0, venue: 'okx', symbol: TOTAL, oiUsd: 200 },
    { ts: T0 + 15 * MIN, venue: 'bybit', symbol: TOTAL, oiUsd: 110 },
  ]);

  const s = oiSeries(db, { from: T0 - MIN, to: T0 + DIA, symbol: TOTAL });
  assert.equal(s.length, 3);
  assert.deepEqual(s.filter((p) => p.venue === 'bybit').map((p) => p.oiUsd), [100, 110]);
});

test('el total de un venue y el desglose por simbolo NO se mezclan', () => {
  // Es la misma tabla y el mismo venue: si se confundiesen, el total saldria
  // sumado dos veces o el simbolo se pintaria como si fuese todo el venue.
  const db = base();
  insertOiSnapshots(db, [
    { ts: T0, venue: 'bybit', symbol: TOTAL, oiUsd: 1_000 },
    { ts: T0, venue: 'bybit', symbol: 'BTC', oiUsd: 400 },
  ]);

  assert.deepEqual(oiSeries(db, { from: T0 - MIN, to: T0 + MIN, symbol: TOTAL }).map((p) => p.oiUsd), [1_000]);
  assert.deepEqual(oiSeries(db, { from: T0 - MIN, to: T0 + MIN, symbol: 'BTC' }).map((p) => p.oiUsd), [400]);
});

test('al agrupar se queda con el ULTIMO del cubo, no con la media', () => {
  // El interes abierto es un saldo, no un flujo. Promediar dos muestras
  // inventaria un valor que no existio en ningun instante.
  const db = base();
  insertOiSnapshots(db, [
    { ts: T0, venue: 'okx', symbol: TOTAL, oiUsd: 100 },
    { ts: T0 + MIN, venue: 'okx', symbol: TOTAL, oiUsd: 300 },
  ]);

  const s = oiSeries(db, { from: T0 - MIN, to: T0 + DIA, symbol: TOTAL, bucketMs: 60 * MIN });
  assert.equal(s.length, 1, 'las dos caen en el mismo cubo');
  assert.equal(s[0]?.oiUsd, 300, 'la ultima, no 200');
});

test('filtra por venue sin tocar el resto', () => {
  const db = base();
  insertOiSnapshots(db, [
    { ts: T0, venue: 'bybit', symbol: TOTAL, oiUsd: 100 },
    { ts: T0, venue: 'okx', symbol: TOTAL, oiUsd: 200 },
  ]);
  const s = oiSeries(db, { from: T0 - MIN, to: T0 + MIN, symbol: TOTAL, venues: ['okx'] });
  assert.deepEqual(s.map((p) => p.venue), ['okx']);
});

test('volver a escribir el mismo sello sustituye, no duplica', () => {
  // Al reiniciar el proceso, el primer ciclo cae en el mismo cuarto de hora
  // que el ultimo antes de parar. Sin esto habria dos puntos para el mismo
  // instante y la grafica daria un diente de sierra que no existio.
  const db = base();
  insertOiSnapshots(db, [{ ts: T0, venue: 'bybit', symbol: TOTAL, oiUsd: 100 }]);
  insertOiSnapshots(db, [{ ts: T0, venue: 'bybit', symbol: TOTAL, oiUsd: 150 }]);

  const s = oiSeries(db, { from: T0 - MIN, to: T0 + MIN, symbol: TOTAL });
  assert.equal(s.length, 1);
  assert.equal(s[0]?.oiUsd, 150);
});

test('la retencion se lleva antes el desglose que los totales', () => {
  const db = base();
  const ahora = T0 + 400 * DIA;
  insertOiSnapshots(db, [
    { ts: ahora - 60 * DIA, venue: 'okx', symbol: 'BTC', oiUsd: 1 },
    { ts: ahora - 60 * DIA, venue: 'okx', symbol: TOTAL, oiUsd: 2 },
    { ts: ahora - 2 * DIA, venue: 'okx', symbol: 'BTC', oiUsd: 3 },
  ]);

  assert.equal(pruneOi(db, { symbolDays: 30, totalDays: 365 }, ahora), 1, 'solo el BTC viejo');
  assert.equal(oiSeries(db, { from: 0, to: ahora, symbol: TOTAL }).length, 1, 'el total se queda');
  assert.equal(oiSeries(db, { from: 0, to: ahora, symbol: 'BTC' }).length, 1, 'y el BTC reciente');
});

test('la cobertura dice desde cuando hay historico', () => {
  const db = base();
  assert.deepEqual(oiCoverage(db), { from: null, to: null }, 'sin datos no se inventa un rango');
  insertOiSnapshots(db, [
    { ts: T0, venue: 'okx', symbol: TOTAL, oiUsd: 1 },
    { ts: T0 + DIA, venue: 'okx', symbol: TOTAL, oiUsd: 2 },
  ]);
  assert.deepEqual(oiCoverage(db), { from: T0, to: T0 + DIA });
});

test('retencion elimina totales de mas de un ano y cobertura respeta seleccion', () => {
  const db = base();
  try {
    const now = T0 + 500 * DIA;
    insertOiSnapshots(db, [
      { ts: now - 366 * DIA, venue: 'old', symbol: TOTAL, oiUsd: 1 },
      { ts: now - DIA, venue: 'recent', symbol: TOTAL, oiUsd: 2 },
    ]);
    assert.equal(pruneOi(db, undefined, now), 1);
    assert.deepEqual(oiCoverage(db, TOTAL, ['old']), { from: null, to: null });
    assert.deepEqual(oiCoverage(db, TOTAL, []), { from: null, to: null });
    assert.equal(oiCoverage(db, TOTAL, ['recent']).from, now - DIA);
  } finally { db.close(); }
});
