import { getJson, isRecord, num } from '../http.ts';

/**
 * Bridges, desde DefiLlama.
 *
 * OJO: el endpoint dedicado (bridges.llama.fi) devuelve 402 y es de pago. Se
 * usa `api.llama.fi/protocols`, que es gratuito y trae nombre, categoria, TVL
 * y la lista `chains`.
 *
 * **`chains` NO dice que redes conecta un puente, dice donde guarda liquidez.**
 * Para la mayoria coincide lo bastante, pero no para los de tipo hub: Across
 * tiene toda su liquidez en Ethereum y DefiLlama le cuenta UNA cadena, asi que
 * aqui no sale en ninguna ruta aunque sea de las mas usadas de Ethereum a
 * Arbitrum. Los casos conocidos se declaran en AUSENTES_POR_DISENO; una ruta
 * que falta en la tabla no demuestra que no exista.
 *
 * Cadencia medida el 2026-09-21 por sus cabeceras: /protocols se revalida cada
 * ~30 min (max-age 1798). Aqui se pide cada hora, que para TVL de puentes sobra.
 *
 * Que redes conecta cada puente de verdad lo dicen LI.FI y deBridge: ver
 * `bridgeRoutes.ts`. Tiempos y comisiones no se muestran: dependen del importe
 * y del momento, y una cifra fija curada a mano se leia como dato vivo.
 */

const URL_PROTOCOLS = 'https://api.llama.fi/protocols';

const CATEGORIAS = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Bridge Aggregator',
  'Bridge Aggregators',
]);

export type BridgeType = 'native' | 'bridge' | 'aggregator';

export interface Bridge {
  readonly id: string;
  readonly name: string;
  readonly type: BridgeType;
  readonly category: string;
  readonly tvlUsd: number | null;
  readonly chains: readonly string[];
  readonly url: string | null;
  readonly description: string | null;
}

/**
 * Rutas que NO aparecen en la lista aunque sean de las mejores.
 *
 * Un puente de mint/burn no bloquea fondos, asi que no tiene TVL y una tabla
 * ordenada por liquidez lo omite por completo. CCTP es el caso claro: para
 * mover USDC entre dos cadenas que ambos cubran es la opcion mas segura y no
 * saldria por ningun lado. Se declara aparte para que la pantalla lo diga en
 * vez de dejar un hueco silencioso.
 */
export const AUSENTES_POR_DISENO = [
  {
    name: 'Circle CCTP',
    // Tres palabras, no un parrafo: la pantalla es una tabla, no un articulo.
    reason: 'no TVL to rank by',
    url: 'https://www.circle.com/cross-chain-transfer-protocol',
  },
  // Los dos siguientes SI tienen TVL, pero DefiLlama solo les cuenta una
  // cadena, y `routesBetween` exige que el puente declare las dos. El campo
  // `chains` de /protocols dice donde guarda liquidez un protocolo, no que
  // redes conecta: Across la tiene toda en su pool de Ethereum y aun asi es de
  // las rutas mas usadas de Ethereum a Arbitrum. Comprobado el 2026-09-21:
  // across tiene 1 cadena y 21 M de TVL; usdt0, 1 cadena y 3.292 M. Los dos
  // estaban ademas en CURADOS con tiempos y comisiones que no podian salir
  // nunca en pantalla.
  {
    name: 'Across',
    reason: 'TVL on one chain only',
    url: 'https://across.to',
  },
  {
    name: 'USDT0',
    reason: 'TVL on one chain only',
    url: 'https://usdt0.to',
  },
] as const;

/** La categoria de DefiLlama dice si es puente nativo, normal o agregador. */
function tipoDe(categoria: string): BridgeType {
  if (categoria === 'Canonical Bridge') return 'native';
  if (categoria.startsWith('Bridge Aggregator')) return 'aggregator';
  return 'bridge';
}

export async function fetchBridges(): Promise<Bridge[]> {
  const raw = await getJson(URL_PROTOCOLS, { timeoutMs: 30_000 });
  if (!Array.isArray(raw)) throw new Error('api.llama.fi/protocols: unexpected shape');

  const out: Bridge[] = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    const categoria = row['category'];
    if (typeof categoria !== 'string' || !CATEGORIAS.has(categoria)) continue;

    const name = row['name'];
    const slug = row['slug'];
    if (typeof name !== 'string' || typeof slug !== 'string') continue;

    const chains = Array.isArray(row['chains'])
      ? row['chains'].filter((c): c is string => typeof c === 'string')
      : [];
    // Un puente que no declara cadenas no sirve para elegir ruta.
    if (chains.length === 0) continue;

    out.push({
      id: slug,
      name,
      type: tipoDe(categoria),
      category: categoria,
      tvlUsd: num(row['tvl']),
      chains,
      url: typeof row['url'] === 'string' ? row['url'] : null,
      description: typeof row['description'] === 'string' ? row['description'] : null,
    });
  }

  if (out.length === 0) throw new Error('api.llama.fi/protocols: 0 bridges');
  return out;
}

/** Cadenas que aparecen en al menos un puente, ordenadas. */
export function bridgeChains(bridges: readonly Bridge[]): string[] {
  const set = new Set<string>();
  for (const b of bridges) for (const c of b.chains) set.add(c);
  return [...set].sort();
}

/**
 * Puentes que conectan origen y destino, del mas liquido al menos.
 *
 * Se exige que el puente declare AMBAS cadenas: uno que solo cubre el origen no
 * te lleva a ninguna parte, y listarlo por si acaso seria hacerte perder el
 * tiempo comprobandolo tu.
 */
export function routesBetween(
  bridges: readonly Bridge[],
  from: string,
  to: string,
): Bridge[] {
  if (from === to) return [];
  return bridges
    .filter((b) => b.chains.includes(from) && b.chains.includes(to))
    .sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1));
}
