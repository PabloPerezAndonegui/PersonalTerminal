import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCandles } from './candles.ts';
const candle = { s: 'BTC', i: '1m', t: 60_000, o: '10', h: '12', l: '9', c: '11', v: '5', n: 4 };

test('rechaza OHLC imposibles, otro activo/intervalo y tiempos futuros', () => {
  const raw = [candle, { ...candle, h: '8' }, { ...candle, l: '12' },
    { ...candle, s: 'ETH' }, { ...candle, i: '1h' }, { ...candle, t: 180_000 }];
  assert.equal(parseCandles(raw, 'BTC', '1m', 0, 120_000).length, 1);
});

test('ausencia de volumen y operaciones sigue siendo null; cero real se conserva', () => {
  const rows = parseCandles([{ ...candle, v: null, n: -1 }, { ...candle, t: 120_000, v: '0', n: 0 }], 'BTC', '1m', 0, 120_000);
  assert.equal(rows[0]?.volume, null);
  assert.equal(rows[0]?.trades, null);
  assert.equal(rows[1]?.volume, 0);
  assert.equal(rows[1]?.trades, 0);
});

test('ordena sin duplicados y admite la vela que contiene el inicio de ventana', () => {
  const rows = parseCandles([{ ...candle, t: 120_000 }, candle, candle], 'BTC', '1m', 65_000, 120_000);
  assert.deepEqual(rows.map(r => r.t), [60_000, 120_000]);
});
