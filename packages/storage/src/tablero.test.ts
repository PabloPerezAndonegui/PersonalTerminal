import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './db.ts';
import { addPointsProgram, listPointsPrograms, reorderPointsPrograms } from './farming.ts';

test('el tablero sale en el orden fijado y lo nuevo entra al final', () => {
  const db = openDatabase({ path: ':memory:' });
  const a = addPointsProgram(db, { venue: 'Variational', pointsPerEpoch: 150_000, epochLabel: 'weekly', note: '150k weekly' }, 1);
  const b = addPointsProgram(db, { venue: 'Perpl' }, 2);
  const c = addPointsProgram(db, { venue: 'Lighter' }, 3);
  assert.deepEqual(listPointsPrograms(db).map((p) => p.venue), ['Variational', 'Perpl', 'Lighter']);

  reorderPointsPrograms(db, [c.id, a.id, b.id]);
  assert.deepEqual(listPointsPrograms(db).map((p) => p.venue), ['Lighter', 'Variational', 'Perpl']);
  assert.equal(listPointsPrograms(db)[1]?.note, '150k weekly');

  addPointsProgram(db, { venue: 'Aster' }, 4);
  assert.equal(listPointsPrograms(db).at(-1)?.venue, 'Aster');
});

test('reordenar con un id que no existe falla entero y no deja medio orden', () => {
  const db = openDatabase({ path: ':memory:' });
  const a = addPointsProgram(db, { venue: 'A' }, 1);
  const b = addPointsProgram(db, { venue: 'B' }, 2);
  assert.throws(() => reorderPointsPrograms(db, [b.id, 'no-existe', a.id]), /unknown program/);
  assert.deepEqual(listPointsPrograms(db).map((p) => p.venue), ['A', 'B']);
});

test('una nota vacia es null, no una cadena vacia', () => {
  const db = openDatabase({ path: ':memory:' });
  assert.equal(addPointsProgram(db, { venue: 'A', note: '   ' }).note, null);
});
