import { isRecord, num, postJson } from '../http.ts';

/**
 * Velas OHLC para el grafico de la Terminal.
 *
 * **Por que no se dibujan con lo que ya guardamos.** El historico propio son
 * fotos del mid cada seis minutos: da una linea, no una vela. Una vela necesita
 * apertura, maximo, minimo y cierre del intervalo, y el maximo de una hora no
 * se puede reconstruir con diez fotos sueltas; lo que saldria es el maximo de
 * esas diez, que no es lo mismo y encima se parece bastante, que es lo peligroso.
 *
 * **Por que no se guardan.** Se piden al abrir un activo y no se persisten: son
 * datos que el venue ya tiene completos y servidos, y duplicarlos nos obligaria
 * a mantenerlos al dia sin ganar nada. El historico propio existe para lo que
 * el venue NO guarda, que es el funding cruzado entre venues.
 *
 * **Coste.** Una peticion por activo y por intervalo que se mire, solo cuando
 * se mira. No entra en el ciclo del collector.
 */

/** Una vela, ya en numeros. */
export interface Candle {
  /** Apertura del intervalo, en milisegundos. */
  readonly t: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Volumen en unidades del subyacente, tal como lo publica el venue. */
  readonly volume: number | null;
  /** Operaciones dentro de la vela. null si el venue no lo dice. */
  readonly trades: number | null;
}

/**
 * Intervalos que admite Hyperliquid.
 *
 * Es una lista cerrada a proposito: su API acepta la cadena tal cual y un
 * intervalo que no conoce devuelve vacio, que en la pantalla se leeria como
 * "este activo no tiene historico" en vez de como lo que es.
 */
export const INTERVALOS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Intervalo = (typeof INTERVALOS)[number];

/** Cuanto dura cada intervalo, para pedir una ventana con sentido. */
const DURACION: Readonly<Record<Intervalo, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function esIntervalo(v: string): v is Intervalo {
  return (INTERVALOS as readonly string[]).includes(v);
}

const URL_HL = 'https://api.hyperliquid.xyz/info';

/**
 * Velas de Hyperliquid para un activo.
 *
 * `symbolNative` es el nombre que usa el venue, no el nuestro. Importa: nuestro
 * normalizador quita sufijos y resuelve colisiones, asi que pedirle "BTC"
 * cuando el venue lo llama de otra forma devolveria vacio.
 *
 * Los perps HIP-3 llevan el dex delante (`io:ETH`), y su `coin` es ese mismo
 * nombre compuesto, asi que no hay nada que traducir.
 */
export async function fetchHyperliquidCandles(
  symbolNative: string,
  interval: Intervalo,
  velas = 500,
  now: number = Date.now(),
): Promise<Candle[]> {
  const endTime = now;
  const startTime = endTime - DURACION[interval] * velas;

  const raw = await postJson(URL_HL, {
    type: 'candleSnapshot',
    req: { coin: symbolNative, interval, startTime, endTime },
  }, { timeoutMs: 8_000, retries: 1 });
  return parseCandles(raw, symbolNative, interval, startTime, endTime);
}

/** Valida geometria, identidad y ventana; los datos ausentes no son ceros. */
export function parseCandles(raw: unknown, symbol: string, interval: Intervalo, start: number, end: number): Candle[] {
  if (!Array.isArray(raw)) throw new Error('hyperliquid candles: respuesta inesperada');

  const out: Candle[] = [];
  for (const fila of raw) {
    if (!isRecord(fila)) continue;
    const t = num(fila['t']);
    const open = num(fila['o']);
    const high = num(fila['h']);
    const low = num(fila['l']);
    const close = num(fila['c']);
    // Una vela a la que le falte cualquiera de los cuatro precios NO se
    // completa con el anterior: un hueco dibujado es peor que un hueco.
    if (t === null || open === null || high === null || low === null || close === null) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    if (!Number.isSafeInteger(t) || t < Math.floor(start / DURACION[interval]) * DURACION[interval] || t > end) continue;
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) continue;
    if (fila['s'] !== symbol || fila['i'] !== interval) continue;
    const volume = num(fila['v']);
    const trades = num(fila['n']);
    out.push({
      t,
      open,
      high,
      low,
      close,
      volume: volume !== null && volume >= 0 ? volume : null,
      trades: trades !== null && Number.isSafeInteger(trades) && trades >= 0 ? trades : null,
    });
  }
  // Por orden y sin repetidos: el grafico exige tiempos crecientes y estrictos.
  out.sort((a, b) => a.t - b.t);
  return out.filter((c, i) => i === 0 || c.t !== out[i - 1]?.t);
}
