import type { TradersResponse } from '../api.ts';

/** Solo cuentas activas con lectura vigente; nunca se arrastran fallos al consenso. */
export function traderConsensus(data: TradersResponse | null, now: number, filters: { asset: string; traderId: string; group: string }, failed = false) {
  const selected = (data?.traders ?? []).filter(t => (!filters.traderId || t.id === filters.traderId) && (!filters.group || t.group === filters.group));
  const fresh = selected.filter(t => !failed && data?.tracking && t.active && t.status === 'ok' && t.updatedAt !== null && data.staleAfterMs !== null && now - t.updatedAt >= 0 && now - t.updatedAt <= data.staleAfterMs);
  const rows = new Map<string, { symbol: string; longs: Set<string>; shorts: Set<string>; longUsd: number; shortUsd: number }>();
  for (const trader of fresh) for (const position of trader.positions) {
    if (filters.asset && filters.asset !== position.symbol) continue;
    if (!Number.isFinite(position.notionalUsd) || position.notionalUsd < 0) continue;
    const row = rows.get(position.symbol) ?? { symbol: position.symbol, longs: new Set<string>(), shorts: new Set<string>(), longUsd: 0, shortUsd: 0 };
    if (position.side === 'long') { row.longs.add(trader.id); row.longUsd += position.notionalUsd; }
    else { row.shorts.add(trader.id); row.shortUsd += position.notionalUsd; }
    rows.set(position.symbol, row);
  }
  return { included: fresh.length, excluded: selected.length - fresh.length, rows: [...rows.values()].sort((a,b) => b.longUsd + b.shortUsd - a.longUsd - a.shortUsd) };
}
