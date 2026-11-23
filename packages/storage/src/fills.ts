import type { DatabaseSync } from 'node:sqlite';

/**
 * Ejecuciones de las wallets seguidas.
 *
 * ## Por que existe esta tabla
 *
 * Antes los movimientos se DEDUCIAN comparando fotos de posicion cada pocos
 * minutos. Eso tiene dos agujeros que no se ven mirando la pantalla: lo que se
 * abre y se cierra entre dos lecturas no existe, y un cambio de nocional por
 * movimiento de precio se confunde con una operacion. Un fill es un fill.
 *
 * ## La clave de duplicados
 *
 * `tid` es el identificador que da el venue a cada ejecucion. Al releer una
 * ventana que ya se habia leido, los repetidos chocan contra la primaria y se
 * descartan solos, asi que la recogida puede solaparse sin cuidado. Es lo que
 * permite pedir "desde hace una hora" cada pocos minutos sin llevar la cuenta.
 */

export interface Fill {
  readonly tid: string;
  readonly traderId: string;
  readonly symbol: string;
  readonly ts: number;
  /** Como lo publica el venue: 'Open Long', 'Close Short', 'Buy'... */
  readonly dir: string;
  readonly side: 'long' | 'short';
  readonly px: number;
  readonly sz: number;
  readonly notionalUsd: number;
  readonly closedPnl: number | null;
  readonly fee: number | null;
  /**
   * Que parte de SU cuenta movia, con el equity del momento de leerla.
   *
   * null cuando no se pudo leer el equity. No es cero: cero seria una
   * operacion que no mueve nada, y eso no es lo que ha pasado.
   */
  readonly accountPct: number | null;
  /**
   * El mercado tal como lo nombra Hyperliquid: `BTC`, `xyz:NVDA`, `@107`.
   * `symbol` es el normalizado, y en el no se distingue el NVDA de un dex
   * HIP-3 del de otro, ni el spot del perp. null en lo guardado antes.
   */
  readonly coin?: string | null;
}

export interface ConsultaFills {
  readonly traderIds?: readonly string[];
  readonly symbol?: string | undefined;
  /** El mercado exacto de Hyperliquid, en vez del simbolo normalizado. */
  readonly coin?: string | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  /** Solo las que muevan al menos este % de la cuenta. */
  readonly minAccountPct?: number | undefined;
  readonly limit?: number | undefined;
}

/**
 * Guarda ejecuciones, descartando las que ya estaban.
 *
 * Devuelve cuantas eran nuevas DE VERDAD, no cuantas se intentaron: es lo que
 * permite saber si una vuelta de recogida ha traido algo o esta releyendo lo
 * mismo, y por tanto si avisar o callarse.
 */
export function insertFills(db: DatabaseSync, fills: readonly Fill[]): number {
  if (fills.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO trader_fill
       (tid, trader_id, symbol, ts, dir, side, px, sz, notional_usd, closed_pnl, fee, account_pct, coin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let nuevas = 0;
  db.exec('BEGIN');
  try {
    for (const f of fills) {
      const r = stmt.run(
        f.tid, f.traderId, f.symbol, f.ts, f.dir, f.side,
        f.px, f.sz, f.notionalUsd, f.closedPnl, f.fee, f.accountPct, f.coin ?? null,
      );
      if (r.changes > 0) nuevas += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return nuevas;
}

/** Ejecuciones guardadas, de la mas reciente a la mas antigua. */
export function readFills(db: DatabaseSync, q: ConsultaFills = {}): Fill[] {
  const donde: string[] = [];
  const args: (string | number)[] = [];

  const ids = q.traderIds ?? [];
  if (ids.length > 0) {
    donde.push(`trader_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (q.symbol !== undefined && q.symbol !== '') { donde.push('symbol = ?'); args.push(q.symbol); }
  if (q.coin !== undefined && q.coin !== '') { donde.push('coin = ?'); args.push(q.coin); }
  if (q.from !== undefined) { donde.push('ts >= ?'); args.push(q.from); }
  if (q.to !== undefined) { donde.push('ts <= ?'); args.push(q.to); }
  // Una ejecucion sin porcentaje NO pasa el filtro de conviccion: no se sabe
  // cuanto movia, asi que afirmar que supera un umbral seria inventarselo.
  if (q.minAccountPct !== undefined) {
    donde.push('account_pct IS NOT NULL AND account_pct >= ?');
    args.push(q.minAccountPct);
  }

  const limite = Math.min(Math.max(q.limit ?? 500, 1), 5000);
  const rows = db
    .prepare(
      `SELECT tid, trader_id, symbol, ts, dir, side, px, sz, notional_usd, closed_pnl, fee, account_pct, coin
         FROM trader_fill
        ${donde.length > 0 ? `WHERE ${donde.join(' AND ')}` : ''}
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .all(...args, limite) as Record<string, unknown>[];

  return rows.map((r) => ({
    tid: String(r['tid']),
    traderId: String(r['trader_id']),
    symbol: String(r['symbol']),
    ts: Number(r['ts']),
    dir: String(r['dir']),
    side: r['side'] === 'short' ? 'short' : 'long',
    px: Number(r['px']),
    sz: Number(r['sz']),
    notionalUsd: Number(r['notional_usd']),
    closedPnl: r['closed_pnl'] === null ? null : Number(r['closed_pnl']),
    fee: r['fee'] === null ? null : Number(r['fee']),
    accountPct: r['account_pct'] === null ? null : Number(r['account_pct']),
    coin: typeof r['coin'] === 'string' ? r['coin'] : null,
  }));
}

/**
 * El sello de la ultima ejecucion guardada de una wallet.
 *
 * Es por donde sigue la recogida. null cuando no hay ninguna, y entonces quien
 * llama decide cuanto historico quiere traerse la primera vez.
 */
export function lastFillAt(db: DatabaseSync, traderId: string): number | null {
  const r = db
    .prepare('SELECT MAX(ts) AS ts FROM trader_fill WHERE trader_id = ?')
    .get(traderId) as { ts: number | null } | undefined;
  return r?.ts ?? null;
}

/**
 * Borra lo mas viejo que `before`.
 *
 * Una wallet muy activa puede dar miles de ejecuciones al dia: medido contra
 * una cuenta publica de Hyperliquid, 2.000 fills en UNA hora. Sin retencion,
 * seguir a un creador de mercado llena el disco.
 */
export function pruneFills(db: DatabaseSync, before: number): number {
  return db.prepare('DELETE FROM trader_fill WHERE ts < ?').run(before).changes as number;
}
