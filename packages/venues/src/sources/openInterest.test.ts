import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBybitOi, fetchOkxOi } from './openInterest.ts';
const T = 1_800_000_000_000;
test('OI parsers: cero y desconocido conservan el mercado; unidades single', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ retCode: 0, result: { list: [
    { symbol: 'BTCUSDT', deliveryTime: '0', singleOpenInterestValue: '0', openInterestValue: '0' },
    { symbol: 'ETHUSDT', deliveryTime: '0', singleOpenInterestValue: null },
    { symbol: 'SOLUSDT', deliveryTime: '0', singleOpenInterestValue: '10', openInterestValue: '20' },
  ] } })));
  const result = await fetchBybitOi(T);
  assert.deepEqual(result.markets.map(m => m.openInterestUsd), [0, null, 10]);
});
test('OKX: rechaza origen antiguo o futuro y acepta cero real', async t => {
  let ts = T;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: '0', data: [{ instId: 'BTC-USDT-SWAP', oiUsd: '0', ts: String(ts) }] })));
  assert.equal((await fetchOkxOi(T)).markets[0]?.openInterestUsd, 0);
  ts = T - 800000; await assert.rejects(fetchOkxOi(T), /timestamp/);
  ts = T + 31000; await assert.rejects(fetchOkxOi(T), /timestamp/);
});
