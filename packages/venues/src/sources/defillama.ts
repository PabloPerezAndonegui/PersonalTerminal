import { getJson, isRecord, num } from '../http.ts';

/**
 * DefiLlama Yields.
 *
 * Un solo endpoint devuelve las ~17.000 pools con APY, TVL y desglose entre
 * base y recompensas. Se pide entero y se filtra en memoria: la API no admite
 * filtros y pedirla por trozos seria mas peticiones para el mismo dato.
 *
 * Se recalcula cada hora en origen, asi que consultarla mas a menudo no aporta
 * nada y solo gasta rate limit. Medido el 2026-09-21 por sus cabeceras: la
 * copia de la CDN caduca a los ~58 min (age 343 s, expires 52 min despues). Y
 * contrastado ese dia pool a pool: 17.189 en origen, 17.189 aqui, y 300 de
 * ellas identicas en APY y TVL.
 */

const URL_POOLS = 'https://yields.llama.fi/pools';

export interface Pool {
  readonly id: string;
  readonly chain: string;
  readonly project: string;
  readonly symbol: string;
  readonly poolMeta: string | null;
  readonly tvlUsd: number;
  /** APY total. null si DefiLlama no lo da: no se asume 0. */
  readonly apy: number | null;
  readonly apyBase: number | null;
  readonly apyReward: number | null;
  /** Media de 30 dias, para saber si el APY de hoy es un pico. */
  readonly apyMean30d: number | null;
  readonly stablecoin: boolean;
  /** 'no' | 'yes' | null. Riesgo de perdida impermanente. */
  readonly ilRisk: string | null;
  readonly exposure: string | null;
  /**
   * true si el APY de hoy no es representativo: o lo marca DefiLlama como
   * atipico, o se dispara muy por encima de su media de 30 dias. Es lo que
   * evita perseguir un 200.000 % que existio durante un dia.
   */
  readonly volatileApy: boolean;
  /** Pagina de DefiLlama para la pool. Enlace curado, no el del protocolo. */
  readonly url: string;
}

/**
 * Un APY no es representativo si es un PICO: mas del triple de su propia media
 * de 30 dias y por encima del 100 %. O si DefiLlama lo marca como atipico Y
 * ademas pasa del 100 %.
 *
 * La marca `outlier` de DefiLlama sola NO basta, y antes bastaba. Medido el 17
 * de noviembre de 2026: marca 3.111 pools, 1.707 de ellas con APY por debajo
 * del 20 % y 986 con el APY de hoy en linea con su media de 30 dias. Entre las
 * que se ocultaban estaban WETH-USDC de Uniswap v3 en Base (89 M$, 85,9 % hoy
 * y 68,6 % de media) y SOL-USDC de Orca: de las pools mas liquidas que hay.
 * La marca mide lo raro que es una pool frente al resto, no si su numero de
 * hoy es un pico, que es lo que esta pantalla necesita saber.
 */
export function esVolatil(apy: number | null, mean30d: number | null, outlier: boolean): boolean {
  if (apy === null) return false;
  if (outlier && apy >= 100) return true;
  if (mean30d === null || mean30d <= 0) return false;
  return apy > 100 && apy > mean30d * 3;
}

export async function fetchPools(): Promise<Pool[]> {
  const raw = await getJson(URL_POOLS, { timeoutMs: 30_000 });
  if (!isRecord(raw) || !Array.isArray(raw['data'])) {
    throw new Error('yields.llama.fi/pools: unexpected shape');
  }

  const out: Pool[] = [];
  for (const row of raw['data']) {
    if (!isRecord(row)) continue;
    const id = row['pool'];
    const chain = row['chain'];
    const project = row['project'];
    const symbol = row['symbol'];
    if (typeof id !== 'string' || typeof chain !== 'string') continue;
    if (typeof project !== 'string' || typeof symbol !== 'string') continue;

    const tvl = num(row['tvlUsd']);
    if (tvl === null) continue;

    const apy = num(row['apy']);
    const mean30d = num(row['apyMean30d']);

    out.push({
      id,
      chain,
      project,
      symbol,
      poolMeta: typeof row['poolMeta'] === 'string' ? row['poolMeta'] : null,
      tvlUsd: tvl,
      apy,
      apyBase: num(row['apyBase']),
      apyReward: num(row['apyReward']),
      apyMean30d: mean30d,
      stablecoin: row['stablecoin'] === true,
      ilRisk: typeof row['ilRisk'] === 'string' ? row['ilRisk'] : null,
      exposure: typeof row['exposure'] === 'string' ? row['exposure'] : null,
      volatileApy: esVolatil(apy, mean30d, row['outlier'] === true),
      // Se enlaza SIEMPRE a DefiLlama y nunca a la web del protocolo tal cual
      // viene en la respuesta: es la proteccion anti-phishing que ya tenia la
      // version anterior de la app y merece conservarse.
      url: `https://defillama.com/yields/pool/${encodeURIComponent(id)}`,
    });
  }

  if (out.length === 0) throw new Error('yields.llama.fi/pools: 0 pools validas');
  return out;
}
