import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traderConsensus } from './traderConsensus.ts';
import type { TradersResponse, TrackedTrader } from '../api.ts';
const position = { symbol: 'SOL', side: 'long' as const, sizeBase: 2, notionalUsd: 300, entryPrice: 140, markPrice: 150, unrealizedPnlUsd: 20, leverage: 2, liquidationPrice: null };
const trader: TrackedTrader = { id: 'a', venue: 'hyperliquid', address: 'public', alias: null, color: null, group: 'test', notes: null, active: true, createdAt: 0, status: 'ok', updatedAt: 1000, error: null, errorAt: null, failures: 0, equityUsd: 1000, marginUsedUsd: 150, positions: [position] };
const data: TradersResponse = { tracking: true, intervalMs: 1000, staleAfterMs: 2000, traders: [trader] };
const filters = { asset: '', traderId: '', group: '' };
test('consenso excluye cuentas pausadas, atrasadas y fallidas', () => {
  const result = traderConsensus({ ...data, traders: [trader, { ...trader, id: 'b', active: false }, { ...trader, id: 'c', updatedAt: 0 }, { ...trader, id: 'd', status: 'failing' }] }, 2500, filters);
  assert.equal(result.included, 1);
  assert.equal(result.excluded, 3);
  assert.equal(result.rows[0]?.longUsd, 300);
});
test('un fallo de API o seguimiento parado no se presenta como consenso actual', () => {
  assert.equal(traderConsensus(data, 1500, filters, true).included, 0);
  assert.equal(traderConsensus({ ...data, tracking: false }, 1500, filters).included, 0);
});
test('cuenta wallets una vez y respeta activo, wallet y grupo', () => {
  const result = traderConsensus({ ...data, traders: [{ ...trader, positions: [position, position] }] }, 1500, filters);
  assert.equal(result.rows[0]?.longs.size, 1);
  assert.equal(result.rows[0]?.longUsd, 600);
  assert.equal(traderConsensus(data, 1500, { ...filters, asset: 'BTC' }).rows.length, 0);
  assert.equal(traderConsensus(data, 1500, { ...filters, group: 'other' }).included, 0);
  assert.equal(traderConsensus(data, 1500, { ...filters, traderId: 'other' }).included, 0);
});
