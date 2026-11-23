import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { writePoolDaily, readPoolMeans, prunePoolDaily, DIA_MS } from './pools.ts';

const HOY = 20_000 * DIA_MS + 15 * 3_600_000;

test('una lectura por hora deja UNA fila por pool y dia, con el ultimo valor', () => {
  const db = openDatabase({ path: ':memory:' });
  writePoolDaily(db, HOY - 3_600_000, [{ id: 'p', apy: 4, tvlUsd: 1e6 }]);
  writePoolDaily(db, HOY, [{ id: 'p', apy: 5, tvlUsd: 1e6 }]);
  const r = db.prepare('SELECT COUNT(*) AS n, MAX(apy) AS apy FROM pool_apy_daily').get() as { n: number; apy: number };
  assert.equal(r.n, 1);
  assert.equal(r.apy, 5);
});

test('ni APY desconocido ni pools pequenas entran', () => {
  const db = openDatabase({ path: ':memory:' });
  const n = writePoolDaily(db, HOY, [
    { id: 'sin-apy', apy: null, tvlUsd: 1e9 },
    { id: 'pequena', apy: 10, tvlUsd: 50_000 },
    { id: 'buena', apy: 3, tvlUsd: 200_000 },
  ]);
  assert.equal(n, 1);
});

test('la media de 7 dias necesita 5 dias; con menos es null y no la media de lo que haya', () => {
  const db = openDatabase({ path: ':memory:' });
  for (let i = 0; i < 4; i++) writePoolDaily(db, HOY - i * DIA_MS, [{ id: 'p', apy: 10, tvlUsd: 1e6 }]);
  assert.equal(readPoolMeans(db, HOY).porPool.get('p')?.d7.mean, null);
  writePoolDaily(db, HOY - 4 * DIA_MS, [{ id: 'p', apy: 20, tvlUsd: 1e6 }]);
  const m = readPoolMeans(db, HOY);
  assert.equal(m.porPool.get('p')?.d7.mean, 12, '(10*4 + 20) / 5');
  assert.equal(m.porPool.get('p')?.d7.days, 5);
  assert.equal(m.porPool.get('p')?.d15.mean, null, '5 de 15 dias no bastan');
  assert.equal(m.diasRecogidos, 5);
});

test('la ventana de 7 dias no mira mas atras de 7 dias', () => {
  const db = openDatabase({ path: ':memory:' });
  // Quince dias: los ocho viejos a 100, los siete recientes a 1.
  for (let i = 0; i < 15; i++) writePoolDaily(db, HOY - i * DIA_MS, [{ id: 'p', apy: i < 7 ? 1 : 100, tvlUsd: 1e6 }]);
  const m = readPoolMeans(db, HOY).porPool.get('p');
  assert.equal(m?.d7.mean, 1);
  assert.equal(m?.d15.days, 15);
  assert.ok(Math.abs((m?.d15.mean ?? 0) - (7 + 800) / 15) < 1e-9);
});

test('la purga borra solo lo anterior al corte', () => {
  const db = openDatabase({ path: ':memory:' });
  writePoolDaily(db, HOY - 500 * DIA_MS, [{ id: 'p', apy: 1, tvlUsd: 1e6 }]);
  writePoolDaily(db, HOY, [{ id: 'p', apy: 1, tvlUsd: 1e6 }]);
  assert.equal(prunePoolDaily(db, HOY - 400 * DIA_MS), 1);
});
