import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familiaDe, familiasDeBusqueda } from './familias.ts';

test('SPY lleva al S&P 500 y el S&P al SPY', () => {
  assert.deepEqual(familiasDeBusqueda('spy').map((f) => f.label), ['S&P 500']);
  assert.ok(familiasDeBusqueda('US500')[0]?.simbolos.includes('SPY'));
  assert.equal(familiaDe('SPY')?.label, 'S&P 500');
});

test('gold trae el oro y sus tokens; oil los dos crudos', () => {
  assert.deepEqual(familiasDeBusqueda('gold')[0]?.simbolos.slice(0, 3), ['XAU', 'PAXG', 'XAUT']);
  assert.deepEqual(familiasDeBusqueda('oil').map((f) => f.label), ['WTI crude', 'Brent crude']);
});

test('dos letras solo encuentran por coincidencia exacta', () => {
  // "SI" no puede traer la plata (SILVER) ni "ES" nada que empiece por ES.
  assert.deepEqual(familiasDeBusqueda('SI'), []);
  assert.deepEqual(familiasDeBusqueda('ES').map((f) => f.label), ['S&P 500']);
  assert.deepEqual(familiasDeBusqueda(''), []);
});

test('SPX a secas es el memecoin: busca el S&P pero no pertenece a la familia', () => {
  assert.equal(familiaDe('SPX'), null);
  assert.deepEqual(familiasDeBusqueda('SPX').map((f) => f.label), ['S&P 500']);
});
