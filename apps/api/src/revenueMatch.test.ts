import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revenueDe } from './openInterest.ts';
import type { LlamaRevenue } from '@defi/venues';

/**
 * De donde salen los ingresos de cada protocolo.
 *
 * Primero el identificador de DefiLlama, que es exacto. Solo si no lo hay se
 * adivina por el nombre, y ahi la tabla esta filtrada a derivados: cruzar
 * "Bybit" a ciegas en una lista de 2.400 protocolos encuentra "Bybit Staked
 * SOL", que no tiene nada que ver. Equivocarse aqui no da un error, da los
 * ingresos de OTRO en la fila de comparacion.
 */
const rev = (revenue30dUsd: number, label = 'x'): LlamaRevenue =>
  ({ label, revenue24hUsd: null, revenue30dUsd, fees24hUsd: null, fees30dUsd: null });

const porId = new Map<string, LlamaRevenue>([
  ['7010', rev(2_240_000, 'tradeXYZ')],
  ['1', rev(56_900_000, 'Hyperliquid Perps')],
]);

const porProtocolo = new Map<string, LlamaRevenue>([
  ['hyperliquidperps', rev(56_900_000, 'Hyperliquid Perps')],
  ['hyperliquidhlp', rev(0, 'Hyperliquid HLP')],
  ['dydxv3', rev(0, 'dYdX V3')],
  ['dydxv4', rev(250_000, 'dYdX V4')],
  ['gmxv2perps', rev(500_000, 'GMX V2 Perps')],
  ['bybit', rev(1, 'Bybit')],
]);

const tablas = { porId, porProtocolo };

test('el identificador manda sobre el nombre', () => {
  // tradeXYZ esta clasificado como "Interface", asi que NO aparece en la tabla
  // por nombre, que solo lleva derivados. Por identificador si.
  assert.equal(revenueDe('tradeXYZ', tablas, '7010')?.label, 'tradeXYZ');
  assert.equal(revenueDe('tradeXYZ', tablas), null, 'sin identificador no lo encuentra');
});

test('sin identificador se cae al nombre', () => {
  assert.equal(revenueDe('Hyperliquid', tablas)?.label, 'Hyperliquid Perps');
});

test('un identificador que no esta NO impide buscar por nombre', () => {
  assert.equal(revenueDe('Hyperliquid', tablas, '99999')?.label, 'Hyperliquid Perps');
});

test('entre varias versiones se queda con la que de verdad ingresa', () => {
  // dYdX V3 esta retirada y declara cero. Quedarse con ella daria "sin
  // ingresos" para un protocolo que si los tiene.
  assert.equal(revenueDe('dYdX', tablas)?.label, 'dYdX V4');
});

test('el nombre exacto manda sobre el prefijo', () => {
  assert.equal(revenueDe('Bybit', tablas)?.label, 'Bybit');
});

test('un prefijo corto NO arrastra media lista', () => {
  assert.equal(revenueDe('GMX', tablas), null);
});

test('sin coincidencia devuelve null, no la primera fila', () => {
  assert.equal(revenueDe('Backpack', tablas), null);
  assert.equal(revenueDe('Hyperliquid', undefined), null);
});
