import { getJson, isRecord, num } from '../http.ts';

/**
 * Historico de interes abierto de fuera, para no depender de que la app haya
 * estado encendida.
 *
 * Dos fuentes, comprobadas el 17 nov 2026:
 *
 * - **DefiLlama**, totales por protocolo y por DIA: `overview/open-interest`
 *   con desglose trae 2.092 dias de todos los protocolos en una sola peticion.
 *   Las cifras van a una pata salvo los HIP-3, que van a dos; quien guarda las
 *   convierte a la convencion de cada venue.
 * - **Bybit**, por ACTIVO y por HORA: `/v5/market/open-interest` da 200 horas
 *   con `singleOpenInterest` (una pata, en unidades del activo; su campo
 *   `openInterest` es el doble). Se multiplica por el cierre de la vela de esa
 *   misma hora, que es lo que hace su propia cifra en dolares.
 *
 * OKX tambien publica historico, pero no coincide con lo que leemos de el en
 * vivo (243,6 M contra 278,8 en SOL), asi que no se mezcla.
 */

const URL_LLAMA = 'https://api.llama.fi/overview/open-interest?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=false';
const BYBIT = 'https://api.bybit.com/v5/market';

export interface DiaLlama {
  /** Inicio del dia UTC, en ms. */
  readonly dia: number;
  /** Nombre del protocolo en DefiLlama -> interes abierto en USD. */
  readonly porProtocolo: Readonly<Record<string, number>>;
}

/** Los ultimos `dias` dias de OI por protocolo, de DefiLlama. */
export async function fetchLlamaOiHistorico(dias = 365, ahora = Date.now()): Promise<DiaLlama[]> {
  const raw = await getJson(URL_LLAMA, { timeoutMs: 60_000 });
  if (!isRecord(raw) || !Array.isArray(raw['totalDataChartBreakdown'])) {
    throw new Error('overview/open-interest: no daily breakdown');
  }
  const desde = ahora - dias * 86_400_000;
  const out: DiaLlama[] = [];
  for (const fila of raw['totalDataChartBreakdown']) {
    if (!Array.isArray(fila) || !isRecord(fila[1])) continue;
    const segundos = num(fila[0]);
    if (segundos === null || segundos * 1000 < desde) continue;
    const porProtocolo: Record<string, number> = {};
    for (const [nombre, v] of Object.entries(fila[1])) {
      const n = num(v);
      if (n !== null && n > 0) porProtocolo[nombre] = n;
    }
    out.push({ dia: segundos * 1000, porProtocolo });
  }
  return out;
}

/**
 * OI horario de un activo en Bybit, a una pata y en USD. Vacio si Bybit no
 * lista `${symbol}USDT`, que no es un error: muchos activos no estan.
 */
export async function fetchBybitOiHistorico(symbol: string): Promise<{ ts: number; oiUsd: number }[]> {
  const nativo = `${symbol}USDT`;
  const [oi, velas] = await Promise.all([
    getJson(`${BYBIT}/open-interest?category=linear&symbol=${encodeURIComponent(nativo)}&intervalTime=1h&limit=200`),
    getJson(`${BYBIT}/kline?category=linear&symbol=${encodeURIComponent(nativo)}&interval=60&limit=200`),
  ]);
  if (!isRecord(oi) || oi['retCode'] !== 0 || !isRecord(oi['result']) || !Array.isArray(oi['result']['list'])) return [];
  if (!isRecord(velas) || velas['retCode'] !== 0 || !isRecord(velas['result']) || !Array.isArray(velas['result']['list'])) return [];

  const cierre = new Map<number, number>();
  for (const v of velas['result']['list']) {
    if (!Array.isArray(v)) continue;
    const t = num(v[0]);
    const c = num(v[4]);
    if (t !== null && c !== null && c > 0) cierre.set(t, c);
  }
  const out: { ts: number; oiUsd: number }[] = [];
  for (const p of oi['result']['list']) {
    if (!isRecord(p)) continue;
    const ts = num(p['timestamp']);
    const una = num(p['singleOpenInterest']);
    // Sin el campo a una pata no se adivina: el otro es el doble.
    if (ts === null || una === null) continue;
    const precio = cierre.get(ts);
    if (precio !== undefined) out.push({ ts, oiUsd: una * precio });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
