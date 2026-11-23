import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHourly, toAprPct, fundingAprPct } from './util/funding.ts';
import { walkBook } from './util/book.ts';
import { isFresh, HOUR } from './util/time.ts';
import { addressKind } from './types/portfolio.ts';
import type { FundingRate, BookLevel } from './index.ts';

const funding = (rate: number, intervalHours: number): FundingRate => ({
  rate, intervalHours, predicted: null, nextFundingAt: null,
  kind: 'current',
  sourceField: 'test',
});

test('toHourly normaliza intervalos distintos a la misma base', () => {
  // 0.01% cada 1h y 0.08% cada 8h son exactamente el mismo funding.
  assert.equal(toHourly(funding(0.0001, 1)), 0.0001);
  assert.equal(toHourly(funding(0.0008, 8)), 0.0001);
  assert.equal(toHourly(funding(0.0004, 4)), 0.0001);
});

test('toHourly no divide por cero si un venue reporta intervalo invalido', () => {
  assert.equal(toHourly(funding(0.0001, 0)), 0);
  assert.equal(toHourly(funding(0.0001, -1)), 0);
});

test('toAprPct anualiza sin capitalizar', () => {
  // 0.01%/h * 8760h = 87.6% anual
  assert.ok(Math.abs(toAprPct(0.0001) - 87.6) < 1e-9);
});

test('fundingAprPct compara bien dos venues con intervalos distintos', () => {
  assert.ok(Math.abs(fundingAprPct(funding(0.0008, 8)) - fundingAprPct(funding(0.0001, 1))) < 1e-9);
});

test('el funding negativo se propaga con signo (lo cobran los longs)', () => {
  assert.ok(fundingAprPct(funding(-0.0001, 1)) < 0);
});

const level = (price: number, size: number): BookLevel => ({ price, size });

test('walkBook: libro profundo al mid da coste casi nulo', () => {
  const cost = walkBook([level(100, 1000)], 100, 1000);
  assert.equal(cost.insufficientDepth, false);
  assert.ok(cost.slippageBps < 1e-9);
});

test('walkBook: un nivel un 1% por encima del mid cuesta 100 bps', () => {
  const cost = walkBook([level(101, 1000)], 100, 1000);
  assert.equal(cost.insufficientDepth, false);
  assert.ok(Math.abs(cost.slippageBps - 100) < 1e-6);
});

test('walkBook: promedia ponderando por tamano al barrer varios niveles', () => {
  // 500 USD a 0 bps + 500 USD a 200 bps => 100 bps de media
  const cost = walkBook([level(100, 5), level(102, 100)], 100, 1000);
  assert.ok(Math.abs(cost.slippageBps - 100) < 1e-6);
});

test('walkBook: marca falta de profundidad en vez de dar un numero optimista', () => {
  const cost = walkBook([level(100, 1)], 100, 1000);
  assert.equal(cost.insufficientDepth, true);
  assert.equal(cost.slippageBps, Infinity);
});

test('walkBook: entradas degeneradas no revientan', () => {
  assert.equal(walkBook([], 100, 1000).insufficientDepth, true);
  assert.equal(walkBook([level(100, 10)], 0, 1000).insufficientDepth, true);
  assert.equal(walkBook([level(100, 10)], 100, 0).insufficientDepth, true);
});

test('isFresh usa una referencia inyectable, no el reloj real', () => {
  const t = 1_000_000;
  assert.equal(isFresh(t, HOUR, t + 30 * 60 * 1000), true);
  assert.equal(isFresh(t, HOUR, t + 2 * HOUR), false);
});

test('addressKind distingue EVM de Solana y rechaza lo demas', () => {
  // Importa porque consultar una direccion de Solana contra un venue EVM
  // devolveria un vacio que se lee como "esta wallet no opera aqui".
  assert.equal(addressKind('0x0000000000000000000000000000000000000000'), 'evm');
  assert.equal(addressKind('11111111111111111111111111111111'), 'solana');
  assert.equal(addressKind('0x123'), 'unknown', 'demasiado corta para ser EVM');
  assert.equal(addressKind(''), 'unknown');
  // Una seed phrase lleva espacios: nunca puede pasar por direccion.
  assert.equal(addressKind('witch collapse practice feed shame open'), 'unknown');
});

test('addressKind reconoce las cuentas de dydx v4, que no son EVM', () => {
  // dYdX v4 corre sobre Cosmos. Sin esto la direccion no se podia ni introducir
  // (salia como formato desconocido) y, peor, el adaptador declaraba aceptar
  // EVM: con una 0x el indexer devuelve 404 y la wallet aparecia como que no
  // opera en dydx. Comprobado contra el indexer real.
  assert.equal(addressKind('dydx1zs8daxg80sv5865mldnhc9wehdm0jhcxpvfrp7'), 'cosmos');
  assert.equal(addressKind('dydx1n88uc38xhjgxzw9nwre4ep2c8ga4fjxc575lnf'), 'cosmos');

  // bech32 no es base58: lleva 0 y l, y no lleva b, i ni o. Si se comprobase
  // Solana primero, algunas cuentas de dydx pasarian por solanas.
  assert.equal(addressKind('dydx1qm0m2mmvpvhqzwqj8ked9jtm9d4lg4hcnkqmzq'), 'cosmos');

  // El prefijo tiene que ser el de dydx: otras cadenas Cosmos no las
  // consultamos, y decir que si seria prometer algo que no hacemos.
  assert.equal(addressKind('cosmos1zs8daxg80sv5865mldnhc9wehdm0jhcxpvfrp7'), 'unknown');
  assert.equal(addressKind('dydx1corta'), 'unknown');
});
