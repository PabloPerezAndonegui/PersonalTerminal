import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usd, usdExact } from './formato.ts';

/**
 * El formateador de dolares, que hasta el 5 de octubre de 2026 eran ONCE
 * copias repartidas por las pantallas con seis comportamientos distintos.
 * Estos casos son los que las separaban.
 */

test('la escalera de decimales es fija, que es lo que alinea una columna', () => {
  assert.equal(usd(1_500_000_000), '$1.50B');
  assert.equal(usd(2_500_000), '$2.5M');
  assert.equal(usd(842_000), '$842.0K');
  assert.equal(usd(500), '$500');
});

test('por debajo de mil NO se divide entre mil', () => {
  // El fallo de Bridges: sin rama para < 1e3, 500 salia "$1K" y 100 "$0K".
  assert.equal(usd(500), '$500');
  assert.equal(usd(100), '$100');
  assert.equal(usd(0), '$0');
});

test('el umbral se mira sobre el valor absoluto', () => {
  // Mirandolo con signo, -2.500.000 no llegaba a la rama de los millones.
  assert.equal(usd(-2_500_000), '$-2.5M');
  assert.equal(usd(-1_500_000_000), '$-1.50B');
});

test('un dato desconocido es "—", nunca cero', () => {
  assert.equal(usd(null), '—');
  assert.equal(usd(Number.NaN), '—');
  assert.equal(usd(Number.POSITIVE_INFINITY), '—');
  assert.equal(usdExact(null), '—');
});

test('lo que el usuario apunta va al centimo y con separadores', () => {
  // Un cobro tiene que poder cuadrarse contra un extracto.
  assert.equal(usdExact(1234.56), '$1,234.56');
  assert.equal(usdExact(-1234.56), '-$1,234.56');
  assert.equal(usdExact(1_000_000), '$1,000,000.00');
});

test('usdExact respeta los decimales que le pidan', () => {
  assert.equal(usdExact(1234.5678, 0), '$1,235');
  assert.equal(usdExact(0.0012345, 3), '$0.001');
});
