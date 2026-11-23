import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clasificar, claseDeSimbolo } from './claseActivo.ts';

const m = (venue: string, symbol: string, mid: number | null) => ({ venue, symbol, mid });

test('lo de QFEX es TradFi, y el tipo sale de las listas cortas', () => {
  const r = clasificar([m('qfex', 'NVDA', 180), m('qfex', 'US500', 6800), m('qfex', 'XAU', 4000), m('qfex', 'SPY', 680), m('qfex', 'EUR', 1.16)]);
  const q = r.get('qfex');
  assert.equal(q?.get('NVDA'), 'equity');
  assert.equal(q?.get('US500'), 'index');
  assert.equal(q?.get('XAU'), 'commodity');
  assert.equal(q?.get('SPY'), 'etf');
  assert.equal(q?.get('EUR'), 'fx');
});

test('fuera de QFEX hereda la clase solo si el precio cuadra', () => {
  const r = clasificar([
    m('qfex', 'NVDA', 180), m('arcus', 'NVDA', 181),
    // CAT: Caterpillar en QFEX y un memecoin en Aster. Mismo nombre.
    m('qfex', 'CAT', 847), m('aster', 'CAT', 0.0000023),
  ]);
  assert.equal(r.get('arcus')?.get('NVDA'), 'equity');
  assert.equal(r.get('aster')?.get('CAT'), 'crypto', 'el precio dice que es otro activo');
});

test('sin precio no se puede comprobar, y queda como cripto', () => {
  const r = clasificar([m('qfex', 'NVDA', 180), m('arcus', 'NVDA', null)]);
  assert.equal(r.get('arcus')?.get('NVDA'), 'crypto');
});

test('indices y oro se reconocen fuera de QFEX; las acciones no', () => {
  const r = clasificar([m('variational', 'US500', 6800), m('ext', 'PAXG', 4000), m('ast', 'BB', 0.01)]);
  assert.equal(r.get('variational')?.get('US500'), 'index');
  assert.equal(r.get('ext')?.get('PAXG'), 'commodity', 'oro tokenizado');
  assert.equal(r.get('ast')?.get('BB'), 'crypto', 'BB no esta en QFEX aqui: es BounceBit');
});

test('lo desconocido es cripto, que es de lo que estan hechos estos venues', () => {
  assert.equal(clasificar([m('hyperliquid', 'BTC', 90000)]).get('hyperliquid')?.get('BTC'), 'crypto');
});

test('una fila de varios venues es TradFi si alguno lo comprueba', () => {
  assert.equal(claseDeSimbolo(['crypto', 'equity', 'crypto']), 'equity');
  assert.equal(claseDeSimbolo(['crypto', 'crypto']), 'crypto');
});

test('un venue solo-TradFi clasifica aunque QFEX lo llame distinto', () => {
  // entropy.io llama ANTH a Anthropic; QFEX, ANTHROPIC y a otro precio.
  const r = clasificar([m('qfex', 'ANTHROPIC', 97), m('entropy', 'ANTH', 1692), m('entropy', 'TCNT', 48)]);
  assert.equal(r.get('entropy')?.get('ANTH'), 'equity');
  assert.equal(r.get('entropy')?.get('TCNT'), 'equity');
});

test('si un venue solo-TradFi lista cripto, Hyperliquid lo delata por precio', () => {
  const r = clasificar([m('hyperliquid', 'BTC', 90000), m('entropy', 'BTC', 90100)]);
  assert.equal(r.get('entropy')?.get('BTC'), 'crypto');
});

test('un venue cripto hereda la clase del venue solo-TradFi si el precio cuadra', () => {
  // QFEX no lista TCNT; entropy si. Otro venue que lo liste al mismo precio
  // es la misma accion.
  const r = clasificar([m('entropy', 'TCNT', 48), m('variational', 'TCNT', 47.9), m('aster', 'TCNT', 0.01)]);
  assert.equal(r.get('variational')?.get('TCNT'), 'equity');
  assert.equal(r.get('aster')?.get('TCNT'), 'crypto');
});
