import type { DatabaseSync } from 'node:sqlite';
import type { AccountSnapshot } from '@defi/core';
import {
  insertAlertEvents, markAlertsNotified, listAlertEvents, trimAlertEvents,
  type AlertEvent, type Trader,
} from '@defi/storage';
import { diffPositions, type PositionEvent } from './positionEvents.ts';
import { TELEGRAM_APAGADO, type Telegram, type TelegramStatus } from './telegram.ts';

/**
 * De un cambio de posicion a un aviso.
 *
 * Junta las tres piezas: comparar dos lecturas, guardar lo que ha cambiado y
 * mandarlo por Telegram si esta configurado. Se guarda SIEMPRE, se mande o no:
 * asi la pantalla ensena la actividad reciente aunque no haya bot, y se puede
 * distinguir un aviso que no salio de un rato sin novedades.
 *
 * **Cuando NO se compara.** Si entre las dos lecturas ha pasado demasiado
 * tiempo, no se emite nada y esa lectura pasa a ser la nueva referencia. Es el
 * caso de un reinicio, de una pausa larga y de un corte de la API. Lo que se
 * evita es un mensaje que dice "ha abierto BTC" cuando lo que de verdad ha
 * pasado es que llevabamos tres dias sin mirar. Un aviso vale por cuando
 * ocurre; sin esa garantia, mejor callar.
 */

export interface AlertServiceOptions {
  readonly db: DatabaseSync;
  /** Sin bot configurado esto es null y no se manda nada. */
  readonly telegram?: Telegram | null;
  /** Por debajo de este tamano una posicion no genera avisos. */
  readonly minNotionalUsd?: number;
  /**
   * Distancia maxima entre dos lecturas para poder compararlas. Por encima,
   * se toma referencia nueva y no se avisa de nada.
   */
  readonly maxGapMs?: number;
  readonly clock?: () => number;
}

const HUECO_MAXIMO_MS = 5 * 60_000;

/** Lo que se le cuenta a la pantalla. Aqui no viaja ningun token. */
export interface AlertsStatus {
  readonly telegram: TelegramStatus;
  readonly minNotionalUsd: number;
  readonly maxGapMs: number;
  /** Avisos detectados desde que arranco el proceso. */
  readonly detected: number;
  /** De esos, los que se saltaron por no haber bot configurado. */
  readonly unsent: number;
}

const usd = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};

/** El alias lo escribe el usuario y acaba dentro de HTML. Se escapa. */
const escapar = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const VERBO: Record<PositionEvent['kind'], string> = {
  opened: 'OPENED',
  closed: 'CLOSED',
  increased: 'INCREASED',
  reduced: 'REDUCED',
  flipped: 'FLIPPED TO',
};

/**
 * Una linea por cambio.
 *
 * Dice el importe de LO QUE HA CAMBIADO y, cuando la posicion sigue abierta,
 * en cuanto se queda. Sin el segundo numero no se sabe si una subida de 12.000
 * dolares es una posicion nueva o el ultimo retoque de una de 500.000.
 */
export function formatEvent(e: PositionEvent): string {
  const lado = e.side.toUpperCase();
  // Un perp HIP-3 dice su dex: "NVDA (xyz)" no es el NVDA de otro dex.
  const dex = /^([a-z0-9]+):/i.exec(e.market ?? '')?.[1];
  const mercado = dex === undefined ? e.symbol : `${e.symbol} (${dex})`;
  const cabeza = `${VERBO[e.kind]} ${mercado} ${lado} ${usd(e.deltaUsd)}`;
  return e.kind === 'opened' || e.kind === 'closed'
    ? cabeza
    : `${cabeza} · now ${usd(e.notionalUsd)}`;
}

/** Un mensaje por trader y vuelta, no uno por posicion. Ver telegram.ts. */
export function formatMessage(trader: Trader, eventos: readonly PositionEvent[]): string {
  const nombre = escapar(trader.alias ?? trader.address);
  const corta = `${trader.address.slice(0, 6)}…${trader.address.slice(-4)}`;
  return [
    `<b>${nombre}</b>`,
    `${escapar(trader.venue)} · <code>${corta}</code>`,
    '',
    ...eventos.map((e) => escapar(formatEvent(e))),
  ].join('\n');
}

export class AlertService {
  readonly #db: DatabaseSync;
  readonly #telegram: Telegram | null;
  readonly #minNotionalUsd: number;
  readonly #maxGapMs: number;
  readonly #clock: () => number;

  #detected = 0;
  #unsent = 0;

  constructor(options: AlertServiceOptions) {
    this.#db = options.db;
    this.#telegram = options.telegram ?? null;
    this.#minNotionalUsd = options.minNotionalUsd ?? 500;
    this.#maxGapMs = options.maxGapMs ?? HUECO_MAXIMO_MS;
    this.#clock = options.clock ?? Date.now;
  }

  get enabled(): boolean {
    return this.#telegram !== null;
  }

  status(): AlertsStatus {
    return {
      telegram: this.#telegram?.status() ?? TELEGRAM_APAGADO,
      minNotionalUsd: this.#minNotionalUsd,
      maxGapMs: this.#maxGapMs,
      detected: this.#detected,
      unsent: this.#unsent,
    };
  }

  recent(limit = 100, traderId?: string): AlertEvent[] {
    return listAlertEvents(this.#db, limit, traderId);
  }

  /**
   * Lo llama el seguidor con cada lectura BUENA.
   *
   * Devuelve lo que ha detectado, que es lo que usan las pruebas. Nunca lanza:
   * un fallo aqui no puede tumbar la vuelta de lectura de posiciones.
   */
  onRead(trader: Trader, prev: AccountSnapshot | null, next: AccountSnapshot): PositionEvent[] {
    try {
      if (prev === null || next.at - prev.at > this.#maxGapMs) return [];

      // Los filtros de ESTA wallet, antes de guardar ni avisar. De una se
      // quiere saber solo lo que hace en SOL; de otra, solo las operaciones en
      // las que se juega una parte seria de su cuenta. Lo que no los pasa no
      // genera aviso ni fila: no es un aviso perdido, es uno que no se pidio.
      const equity = next.equityUsd;
      const eventos = diffPositions(prev, next, { minNotionalUsd: this.#minNotionalUsd }).filter((e) => {
        if (trader.symbols !== null && !trader.symbols.includes(e.symbol)) return false;
        if (trader.minAccountPct !== null) {
          // Sin equity no se sabe que parte de la cuenta movia, y sin saberlo
          // no se puede afirmar que supere el minimo.
          if (equity === null || equity <= 0) return false;
          if ((Math.abs(e.deltaUsd) / equity) * 100 < trader.minAccountPct) return false;
        }
        return true;
      });
      if (eventos.length === 0) return [];

      this.#detected += eventos.length;
      const ids = insertAlertEvents(this.#db, eventos.map((e) => ({
        traderId: trader.id, venue: e.venue, address: e.address, symbol: e.symbol,
        kind: e.kind, side: e.side, sizeBase: e.sizeBase, prevSizeBase: e.prevSizeBase,
        notionalUsd: e.notionalUsd, deltaUsd: e.deltaUsd, markPrice: e.markPrice, at: e.at,
      })));
      trimAlertEvents(this.#db);

      if (this.#telegram === null) {
        // Sin bot no se marcan como enviados. La pantalla los ensena igual y
        // dice que Telegram no esta conectado.
        this.#unsent += eventos.length;
        return eventos;
      }

      this.#telegram.send(formatMessage(trader, eventos));
      // Se marca al encolar, no al entregar: la cola es de este proceso y el
      // fallo de envio queda en el estado de Telegram, que la pantalla ve.
      markAlertsNotified(this.#db, ids, this.#clock());
      return eventos;
    } catch {
      return [];
    }
  }

  /** Mensaje de prueba. Lo dispara el usuario desde la pantalla, nunca solo. */
  async test(): Promise<void> {
    if (this.#telegram === null) throw new Error('Telegram is not configured');
    await this.#telegram.sendNow('<b>DeFi terminal</b>\nTest message. Alerts are wired.');
  }
}
