import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esVolatil } from './defillama.ts';

test('una pool estable que DefiLlama marca como atipica NO se oculta', () => {
  // WETH-USDC de Uniswap v3 en Base el 17 nov 2026: 85,9 % hoy, 68,6 % de media.
  assert.equal(esVolatil(85.9, 68.6, true), false);
  assert.equal(esVolatil(4, 3.8, true), false, 'un 4 % no engana a nadie');
});

test('un pico contra su propia media si se oculta', () => {
  assert.equal(esVolatil(439_000, 12, false), true);
  assert.equal(esVolatil(150, 20, false), true);
});

test('alto pero sostenido no es un pico, salvo que DefiLlama ademas lo marque', () => {
  assert.equal(esVolatil(150, 120, false), false);
  assert.equal(esVolatil(150, 120, true), true);
});

test('sin APY no hay nada que ocultar', () => {
  assert.equal(esVolatil(null, 10, true), false);
});
