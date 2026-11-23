import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoenixAdapter, phoenixMarket } from './phoenix.ts';

const at = 1790086000000;
const row = { symbol: 'SOL', timestamp: at / 1000, markPrice: 100, midPrice: 101,
  currentFundingRate: -0.001, annualizedFundingRate: -8.76, openInterest: 12, dayVolumeUsd: 345 };

test('Phoenix: porcentaje horario a decimal, OI base a USD y sellos reales', () => {
  const m = phoenixMarket(row, at);
  assert.ok(m);
  assert.equal(m.funding.rate, -0.00001);
  assert.equal(m.funding.intervalHours, 1);
  assert.equal(m.openInterestUsd, 1200);
  assert.equal(m.volume24hUsd, 345);
  assert.equal(m.mid, 101);
  assert.equal(m.sourceAt, at);
  assert.equal(m.funding.kind, 'current');
});

test('Phoenix: desconocidos no son ceros; cero real si se admite', () => {
  assert.equal(phoenixMarket({ ...row, currentFundingRate: null }, at), null);
  assert.equal(phoenixMarket({ ...row, currentFundingRate: 0, annualizedFundingRate: 0 }, at)?.funding.rate, 0);
  const m = phoenixMarket({ ...row, openInterest: null, dayVolumeUsd: null, midPrice: null }, at);
  assert.equal(m?.openInterestUsd, null);
  assert.equal(m?.volume24hUsd, null);
  assert.equal(m?.mid, 100);
});

test('Phoenix: rechaza atrasos, reloj futuro, precios invalidos y cambio de unidades', () => {
  assert.equal(phoenixMarket(row, at + 90001), null);
  assert.equal(phoenixMarket(row, at - 30001), null);
  assert.equal(phoenixMarket({ ...row, markPrice: 0 }, at), null);
  assert.equal(phoenixMarket({ ...row, annualizedFundingRate: -876 }, at), null);
});

test('Phoenix: error de socket recuperable; sin rejuvenecer copia; concurrencia y stop', async (t) => {
  let mode: 'ok' | 'error' | 'wait' | 'partial' = 'ok';
  let opened = 0, closed = 0;
  class FakeSocket {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { opened++; queueMicrotask(() => this.onopen?.()); }
    send(): void {
      if (mode === 'error') this.onerror?.();
      if (mode === 'partial') this.onmessage?.({ data: JSON.stringify({ channel: 'marketStatsV2', stats: [] }) });
      if (mode === 'ok') this.onmessage?.({ data: JSON.stringify({ channel: 'marketStatsV2', stats: [{ ...row, timestamp: Math.floor(Date.now() / 1000) }] }) });
    }
    close(): void { closed++; this.onclose?.(); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ markets: [{ symbol: 'SOL', marketStatus: 'active', fundingIntervalInSlots: 3600 }] })));
  const adapter = new PhoenixAdapter();
  await adapter.refresh();
  const first = adapter.snapshot();
  mode = 'error';
  await assert.rejects(adapter.refresh(), /WebSocket error/);
  assert.equal(adapter.snapshot(), first);
  mode = 'ok';
  const pending = adapter.refresh();
  assert.equal(pending, adapter.refresh());
  await pending;
  assert.notEqual(adapter.snapshot(), first);
  assert.equal(opened, 3);
  assert.equal(closed, 3);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mode = 'partial';
  const incomplete = adapter.refresh();
  const rejection = assert.rejects(incomplete, /timeout/);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  await rejection;
  assert.equal(closed, 4);
  mode = 'ok';
  await adapter.refresh();
  assert.equal(closed, 5);
  t.mock.timers.reset();
  mode = 'wait';
  const waiting = adapter.refresh();
  // Permite consumir el catalogo e instalar la cancelacion del socket.
  await new Promise<void>(resolve => setImmediate(resolve));
  adapter.stop();
  await assert.rejects(waiting, /stopped|abort/i);
  assert.equal(closed, 6);
  await assert.rejects(adapter.refresh());
});
