import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const MDS = 'wss://mds.qfex.com';
const API = 'https://api.qfex.com';

export const QFEX_META: VenueMeta = {
  id: 'qfex',
  label: 'QFEX',
  kind: 'perp-dex',
  chain: 'QFEX',
  collateral: 'USDC',
  // Liquida CADA HORA, y no es una suposicion.
  //
  // Vuelto a medir el 9 de octubre de 2026 sobre sus 221 mercados, con un
  // argumento mas solido que el de antes: cada fila trae un `time_remaining`
  // en segundos, y **ninguna pasa de 3.456 s, o sea 57,6 minutos**. Si el
  // intervalo fuese de dos horas o de ocho, habria mercados a noventa o a
  // cuatrocientos minutos de su proxima liquidacion. No hay ninguno, asi que
  // el intervalo es de una hora. Las cuentas atras van escalonadas dentro de
  // la hora, no todas en punto, pero eso cambia CUANDO cobra cada mercado, no
  // cada cuanto.
  //
  // Lo que NO sirve para esto es su `annualised_funding_rate`: el campo
  // `funding_rate` viene cuantizado a 1e-5 y las 34 tasas distintas de cero
  // valian todas exactamente eso, asi que dividir una entre otra mide el
  // redondeo y no el intervalo. El smoke lo detecta y lo dice en vez de dar
  // una falsa alarma.
  fundingIntervalHours: 1,
  // QFEX publica la tarifa POR MERCADO, y son tres: 5/10 bps en las 193
  // acciones, 2/5 en los 19 indices y materias primas y 1/2 en los 4 pares de
  // divisas. El modelo de este proyecto tiene una sola tarifa por venue, asi
  // que se declara la de las acciones, que es el 89 % de sus mercados. Se
  // equivoca en los otros 23 y lo hace SOBREESTIMANDO el coste, que es el
  // lado seguro: encoge una oportunidad, nunca la infla.
  fees: { makerBps: 5, takerBps: 10, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: true, trading: true, publicPositions: false },
};

/** Sin mensaje nuevo en este tiempo, el socket se da por muerto. */
const SIN_NOTICIAS_MS = 90_000;
/** Espera maxima a la primera foto al conectar. */
const ESPERA_INICIAL_MS = 20_000;

/**
 * QFEX. Bolsa de acciones de EEUU, materias primas y divisas, abierta 24/7, con
 * perpetuos sobre cada subyacente.
 *
 * **Es el primer venue que no se lee por REST.** Sus precios y su funding solo
 * viajan por WebSocket: `/refdata` da la ficha de los 216 mercados pero trae
 * `underlier_price` vacio en todos, y los endpoints REST de mercado responden
 * 401. Lo que si es publico y sin clave es el canal `market_stats` de
 * `wss://mds.qfex.com`, que con una sola suscripcion manda precio de marca,
 * mejor bid y ask, funding, interes abierto y volumen de TODOS los simbolos.
 *
 * El collector no arranca los adaptadores, asi que la conexion se abre sola en
 * el primer `refresh()`. A partir de ahi `refresh()` no pide nada: solo
 * comprueba que el socket sigue vivo y que la ultima foto no esta rancia. Si lo
 * esta, LANZA, que es como el collector se entera de que el venue esta caido.
 * Devolver la foto vieja en silencio seria lo peligroso.
 *
 * **Lo que queda sin verificar, y hay que volver:** el 20 de septiembre de 2026
 * los 188 mercados con funding publicaban exactamente cero, que es coherente
 * con ser domingo y tener la bolsa americana cerrada, pero deja sin comprobar
 * la escala de la tasa. Con todo a cero no se puede distinguir un tanto por uno
 * de un tanto por ciento. QFEX publica ademas `annualised_funding_rate`, asi
 * que en cuanto una tasa se mueva el cociente entre las dos tiene que dar 8760
 * exactamente: es lo que comprueba el smoke, y hasta entonces lo dice.
 */
export class QfexAdapter implements VenueAdapter {
  readonly meta = QFEX_META;
  // Un socket, cero peticiones por ciclo. La de tarifas es una sola al arrancar.
  readonly cost: AdapterCost = { websockets: 1, requestsPerMinute: 0 };
  readonly noPositionsReason = 'account data needs a signed session';

  #ws: WebSocket | null = null;
  #conectando: Promise<void> | null = null;
  #ultimoMensaje = 0;

  #marks = new Map<string, number>();
  #bids = new Map<string, number>();
  #asks = new Map<string, number>();
  #funding = new Map<string, { rate: number; anual: number; restanS: number; at: number }>();
  #oi = new Map<string, number>();
  #volumen = new Map<string, number>();

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];

  /** Precio y tamano del mejor nivel. QFEX manda [[precio, tamano], …]. */
  #mejorNivel(lado: unknown): number | null {
    if (!Array.isArray(lado) || lado.length === 0) return null;
    const nivel = lado[0];
    return Array.isArray(nivel) ? num(nivel[0]) : null;
  }

  #aplicar(msg: Record<string, unknown>): void {
    const filas = (clave: string): Record<string, unknown>[] => {
      const v = msg[clave];
      if (!Array.isArray(v)) return [];
      return v.filter((x): x is Record<string, unknown> => isRecord(x) && typeof x['symbol'] === 'string');
    };

    for (const f of filas('mark_prices')) {
      const p = num(f['price']);
      if (p !== null && p > 0) this.#marks.set(f['symbol'] as string, p);
    }
    for (const f of filas('bbos')) {
      const bid = this.#mejorNivel(f['bid']);
      const ask = this.#mejorNivel(f['ask']);
      const s = f['symbol'] as string;
      if (bid !== null) this.#bids.set(s, bid);
      if (ask !== null) this.#asks.set(s, ask);
    }
    for (const f of filas('funding_rates')) {
      const rate = num(f['funding_rate']);
      const anual = num(f['annualised_funding_rate']);
      const restan = num(f['time_remaining']);
      if (rate === null) continue;
      this.#funding.set(f['symbol'] as string, {
        rate,
        anual: anual ?? Number.NaN,
        restanS: restan ?? Number.NaN,
        at: Date.parse(String(f['time'] ?? '')) || now(),
      });
    }
    for (const f of filas('open_interests')) {
      const oi = num(f['open_interest']);
      if (oi !== null) this.#oi.set(f['symbol'] as string, oi);
    }
    // `daily_volumes` va en unidades del activo; el que ya viene en dolares es
    // `daily_volumes_notional`. Para AAPL eran 543 acciones contra 181.793 USD.
    for (const f of filas('daily_volumes_notional')) {
      const v = num(f['volume']);
      if (v !== null) this.#volumen.set(f['symbol'] as string, v);
    }

    this.#ultimoMensaje = now();
  }

  async #conectar(): Promise<void> {
    if (this.#conectando !== null) return this.#conectando;

    this.#conectando = new Promise<void>((resolve, reject) => {
      let resuelto = false;
      const ws = new WebSocket(MDS);
      this.#ws = ws;

      const fallar = (motivo: string) => {
        if (resuelto) return;
        resuelto = true;
        this.#conectando = null;
        try { ws.close(); } catch { /* ya estaba cerrado */ }
        if (this.#ws === ws) this.#ws = null;
        reject(new Error(motivo));
      };

      const reloj = setTimeout(() => fallar('mds: no llego la primera foto'), ESPERA_INICIAL_MS);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', channels: ['market_stats'], symbols: ['*'] }));
      };

      ws.onmessage = (e) => {
        let d: unknown;
        try { d = JSON.parse(String(e.data)); } catch { return; }
        if (!isRecord(d)) return;
        // El primer mensaje es el acuse de la suscripcion, sin datos.
        if (!Array.isArray(d['mark_prices'])) return;

        this.#aplicar(d);
        if (!resuelto) {
          resuelto = true;
          clearTimeout(reloj);
          this.#conectando = null;
          resolve();
        }
      };

      ws.onerror = () => fallar('mds: error de socket');
      ws.onclose = () => {
        if (this.#ws === ws) this.#ws = null;
        fallar('mds: el socket se cerro');
      };
    });

    return this.#conectando;
  }

  /** Tarifas publicadas por mercado. Solo para contrastar, no se guardan. */
  static async fetchFees(): Promise<Map<string, { makerBps: number; takerBps: number }>> {
    const raw = await getJson(`${API}/fees`);
    const out = new Map<string, { makerBps: number; takerBps: number }>();
    if (!isRecord(raw) || !isRecord(raw['fees'])) return out;
    for (const [sym, v] of Object.entries(raw['fees'])) {
      if (!isRecord(v)) continue;
      const maker = num(v['maker_fee']);
      const taker = num(v['taker_fee']);
      if (maker === null || taker === null) continue;
      out.set(sym, { makerBps: maker * 10_000, takerBps: taker * 10_000 });
    }
    return out;
  }

  async refresh(): Promise<void> {
    if (this.#ws === null || this.#ws.readyState > 1) {
      this.#marks.clear();
      await this.#conectar();
    }

    const edad = now() - this.#ultimoMensaje;
    if (this.#ultimoMensaje === 0 || edad > SIN_NOTICIAS_MS) {
      throw new Error(`mds: sin mensajes desde hace ${Math.round(edad / 1000)} s`);
    }

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const [nativeName, mark] of this.#marks) {
      const f = this.#funding.get(nativeName);
      // Sin funding no se publica el mercado. Poner cero seria inventarselo, y
      // aqui un cero es un dato: hay mercados que de verdad estan a cero.
      if (f === undefined) continue;

      const { symbol, contractMultiplier } = normalizeSymbol(nativeName);
      const bid = this.#bids.get(nativeName);
      const ask = this.#asks.get(nativeName);
      const oi = this.#oi.get(nativeName);

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName,
        contractMultiplier,
        mid: mark,
        bid: bid ?? mark,
        ask: ask ?? mark,
        funding: {
          rate: f.rate,
          intervalHours: this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: Number.isFinite(f.restanS) ? at + f.restanS * 1000 : null,
          kind: 'current',
          sourceField: 'mds market_stats -> funding_rates.funding_rate',
        },
        book: null,
        // Viene en unidades del activo.
        openInterestUsd: oi === undefined ? null : oi * mark,
        volume24hUsd: this.#volumen.get(nativeName) ?? null,
        at,
        // El sello del propio venue para esa fila de funding.
        sourceAt: f.at,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('mds: 0 mercados con funding');
    this.#snapshot = mapToUnitPrices(next);
    this.#colisiones = colisiones;
  }

  get colisiones(): readonly string[] {
    return this.#colisiones;
  }

  snapshot(): ReadonlyMap<string, MarketSnapshot> {
    return this.#snapshot;
  }

  stop(): void {
    try { this.#ws?.close(); } catch { /* ya estaba cerrado */ }
    this.#ws = null;
  }
}
