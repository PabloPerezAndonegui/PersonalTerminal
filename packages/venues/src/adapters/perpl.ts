import type { MarketSnapshot, VenueMeta } from '@defi/core';
import { now } from '@defi/core';
import { getJson, isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';
import { mapToUnitPrices, setSinPisar } from '../normalize.ts';
import type { AdapterCost, VenueAdapter } from '../types.ts';

const BASE = 'https://app.perpl.xyz/api/v1';

export const PERPL_META: VenueMeta = {
  id: 'perpl',
  label: 'Perpl',
  kind: 'perp-dex',
  chain: 'Perpl',
  collateral: 'USDC',
  // Perpl no liquida por horas redondas: su intervalo son 2580 segundos, o sea
  // 43 minutos. El de cada mercado se lee de `funding_interval_sec`; esto es
  // solo el respaldo si faltara.
  fundingIntervalHours: 2580 / 3600,
  // Del propio contexto: `config.maker_fee` y `config.taker_fee` por mercado,
  // en micros, o sea 1 bps = 100 micros.
  //
  // CORREGIDO el 9 de octubre de 2026, con `npm run smoke` avisando. Aqui
  // ponia 0,9 y 6,9 bps y su API publica 45 y 345 micros, que son 0,45 y 3,45:
  // justo la mitad. Medido sobre sus once mercados abiertos, los once dan el
  // mismo par, y sus tramos por volumen empiezan en [45, ...] y [345, ...], asi
  // que 45/345 es el tramo de partida y no una tarifa rebajada de nadie.
  //
  // No es cosmetico: el taker entra dos veces en un arbitraje de funding, una
  // por pata, asi que cobrarse 6,9 en vez de 3,45 hundia el APR neto de Perpl y
  // alargaba su punto de equilibrio. Un numero desfasado aqui no se ve raro al
  // mirarlo, que es justo por lo que el smoke contrasta las comisiones.
  //
  // Los tramos por volumen van en `maker_fees` y `taker_fees` y dependen de la
  // cuenta, asi que no se aplican aqui.
  fees: { makerBps: 0.45, takerBps: 3.45, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: true, publicPositions: false },
};

/** Los enteros de Perpl son micros: 10^-6. Documentado en sus tipos. */
const MICROS = 1e6;

/**
 * Perpl. `/pub/context` devuelve en una llamada la configuracion entera del
 * protocolo: mercados, precios, funding y comisiones.
 *
 * Todo viene en enteros de coma fija y hay que escalar dos cosas distintas:
 *
 *  - Los precios, con `config.price_decimals` de cada mercado. ETH a 262965
 *    con 2 decimales son 2629,65 USD.
 *  - El funding, en MICROS (10^-6), que es lo que declaran sus tipos. La tasa
 *    cubre un `funding_interval_sec`, no una hora.
 *
 * Se leen ambos del propio mercado en vez de fijarlos aqui: si Perpl cambia los
 * decimales de un simbolo, el precio saldria mal por un factor de diez sin que
 * nada fallase.
 *
 * Las dos escalas estan CONTRASTADAS contra su propia interfaz: con `rate: -20`
 * en ETH, la web mostraba "Funding -0.0020% / 02:18". O sea que -20 micros son
 * -2e-5 por periodo, y el periodo que faltaba por cerrarse eran 2 min 18 s de
 * los 43 min que declara `funding_interval_sec`. El intervalo sale igual por la
 * cadena: 8571 bloques a 302 ms medidos son 2588 s, contra los 2580 declarados.
 *
 * Su APR anualizado es alto comparado con los venues grandes (ETH -24 %, SOL
 * -49 % el 20 de septiembre de 2026) y eso NO es un error de escala: es un
 * venue con 2 M USD de volumen diario donde el funding se despega de verdad.
 * Los factores no coinciden entre simbolos, que es lo que distingue una
 * divergencia real de un intervalo mal declarado.
 */
export class PerplAdapter implements VenueAdapter {
  readonly meta = PERPL_META;
  readonly cost: AdapterCost = { websockets: 0, requestsPerMinute: 2 };
  readonly noPositionsReason = 'account endpoints need an enrolled API key';

  #snapshot = new Map<string, MarketSnapshot>();
  #colisiones: string[] = [];

  async refresh(): Promise<void> {
    const raw = await getJson(`${BASE}/pub/context`);
    if (!isRecord(raw) || !Array.isArray(raw['markets'])) {
      throw new Error('pub/context: unexpected shape');
    }

    const next = new Map<string, MarketSnapshot>();
    const colisiones: string[] = [];
    const at = now();

    for (const row of raw['markets']) {
      if (!isRecord(row)) continue;
      // `symbol` viene VACIO en algunos mercados vivos, y `name` es el que
      // siempre esta. Fiarse solo de `symbol` costaba los dos mercados con mas
      // volumen del venue: BTC, con 31 M USD en 24 h, y MON. Los dos con
      // `symbol: ""`, `name: "BTC"` y `is_open: true`. Se vio comparando los 6
      // simbolos que salian aqui contra los 8 de su propia interfaz.
      const etiqueta = typeof row['symbol'] === 'string' && row['symbol'].trim() !== ''
        ? row['symbol']
        : row['name'];
      if (typeof etiqueta !== 'string' || etiqueta.trim() === '') continue;
      const nativeName = etiqueta;

      const config = isRecord(row['config']) ? row['config'] : null;
      const state = isRecord(row['state']) ? row['state'] : null;
      const funding = isRecord(row['funding']) ? row['funding'] : null;
      if (config === null || state === null || funding === null) continue;
      if (config['is_open'] === false) continue;

      const decimales = num(config['price_decimals']);
      const escala = decimales === null ? null : 10 ** decimales;
      const mrk = num(state['mrk']);
      const tasa = num(funding['rate']);
      if (escala === null || mrk === null || tasa === null || mrk <= 0) continue;

      const intervalo = num(row['funding_interval_sec']);
      const { symbol, contractMultiplier } = normalizeSymbol(nativeName.trim());

      const bid = num(state['bid']);
      const ask = num(state['ask']);
      const mid = num(state['mid']);
      const precio = mrk / escala;

      setSinPisar(next, {
        venue: this.meta.id,
        symbol,
        symbolNative: nativeName.trim(),
        contractMultiplier,
        mid: mid === null ? precio : mid / escala,
        bid: bid === null ? precio : bid / escala,
        ask: ask === null ? precio : ask / escala,
        funding: {
          rate: tasa / MICROS,
          intervalHours:
            intervalo !== null && intervalo > 0 ? intervalo / 3600 : this.meta.fundingIntervalHours,
          predicted: null,
          nextFundingAt: null,
          kind: 'current',
          sourceField: 'pub/context -> markets[].funding.rate (micros)',
        },
        book: null,
        // `oi` va en unidades del activo, con los decimales de TAMANO, no los
        // de precio. Confundirlos daria un interes abierto mil veces mayor.
        openInterestUsd: (() => {
          const oi = num(state['oi']);
          const sizeDec = num(config['size_decimals']);
          if (oi === null || sizeDec === null) return null;
          return (oi / 10 ** sizeDec) * precio;
        })(),
        // `dva` es el volumen de 24 h acumulado en micros de USD.
        volume24hUsd: (() => {
          const dva = num(state['dva']);
          return dva === null ? null : dva / MICROS;
        })(),
        at,
        // El propio bloque de funding lleva su sello.
        sourceAt: isRecord(funding['at']) ? num(funding['at']['t']) : null,
      }, colisiones);
    }

    if (next.size === 0) throw new Error('pub/context: 0 open markets');
    this.#snapshot = mapToUnitPrices(next);
    this.#colisiones = colisiones;
  }

  get colisiones(): readonly string[] {
    return this.#colisiones;
  }

  snapshot(): ReadonlyMap<string, MarketSnapshot> {
    return this.#snapshot;
  }
}
