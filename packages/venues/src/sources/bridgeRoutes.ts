import { getJson, isRecord, num } from '../http.ts';

/**
 * Que puentes conectan DE VERDAD dos redes, y cuanto mueven los agregadores.
 *
 * ## Por que hace falta ademas de DefiLlama
 *
 * La lista de DefiLlama (`api.llama.fi/protocols`) dice donde guarda liquidez
 * cada puente, no que redes conecta. Relay y Jumper tienen ahi 0 redes y no
 * salian nunca, y deBridge solo aparecia si las dos redes estaban entre las 6
 * donde tiene liquidez. Comprobado el 17 de noviembre de 2026.
 *
 * Dos fuentes publicas, sin clave, dicen las rutas reales:
 *
 * - **LI.FI** (`li.quest/v1/tools`), el motor de Jumper: 37 puentes, cada uno
 *   con la lista de pares origen/destino que sabe enrutar. Limite publicado en
 *   sus cabeceras: 200 peticiones por ventana; aqui se hacen dos por hora.
 * - **deBridge** (`dln.debridge.finance/v1.0/supported-chains-info`): sus redes.
 *   DLN conecta cualquiera con cualquiera de ellas, asi que basta la lista.
 *
 * Y el volumen de los agregadores (Jumper, LI.FI, Bungee, Rango...) sale de la
 * dimension `bridge-aggregators` de DefiLlama, que si es gratuita. La de
 * puentes (`bridges.llama.fi`) es de pago y no se usa.
 */

const URL_LIFI_TOOLS = 'https://li.quest/v1/tools';
const URL_LIFI_CHAINS = 'https://li.quest/v1/chains?chainTypes=EVM,SVM,UTXO,MVM';
const URL_DEBRIDGE = 'https://dln.debridge.finance/v1.0/supported-chains-info';
const URL_AGREGADORES =
  'https://api.llama.fi/overview/bridge-aggregators?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';

/**
 * chainId -> nombre de la red tal como la llama la lista de protocolos de
 * DefiLlama, que es la que puebla los selectores de la pantalla.
 *
 * Una tabla y no el `/v2/chains` de DefiLlama porque ese endpoint no usa los
 * mismos nombres que `/protocols`: tiene "BSC" y "Binance" con el mismo id 56,
 * y "ZKsync Era" donde `/protocols` dice "zkSync Era". Cada nombre de aqui esta
 * comprobado contra `/protocols` el 17 de noviembre de 2026. Lo que no este se
 * queda con el nombre de la fuente.
 */
const CADENA_POR_ID: ReadonlyMap<number, string> = new Map([
  [1, 'Ethereum'], [10, 'Optimism'], [14, 'Flare'], [25, 'Cronos'], [30, 'RSK'], [40, 'Telos'],
  [50, 'XDC'], [56, 'Binance'], [100, 'xDai'], [130, 'Unichain'], [137, 'Polygon'], [143, 'Monad'],
  [146, 'Sonic'], [196, 'X Layer'], [252, 'Fraxtal'], [324, 'zkSync Era'], [480, 'World Chain'],
  [747, 'Flow'], [988, 'Stable'], [1088, 'Metis'], [1329, 'Sei'], [1776, 'Injective'],
  [1868, 'Soneium'], [2020, 'Ronin'], [2741, 'Abstract'], [2818, 'Morph'], [4217, 'Tempo'],
  [4326, 'MegaETH'], [4663, 'Robinhood Chain'], [5000, 'Mantle'], [5031, 'Somnia'], [5042, 'Arc'],
  [8217, 'Klaytn'], [8453, 'Base'], [9745, 'Plasma'], [13371, 'Immutable zkEVM'], [16661, '0G'],
  [33139, 'ApeChain'], [34443, 'Mode'], [42161, 'Arbitrum'], [42170, 'Arbitrum Nova'],
  [42220, 'Celo'], [42793, 'Etherlink'], [43111, 'Hemi'], [43114, 'Avalanche'], [57073, 'Ink'],
  [59144, 'Linea'], [80094, 'Berachain'], [98866, 'Plume Mainnet'], [534352, 'Scroll'],
  [747474, 'Katana'],
  // HyperCore (1337) y HyperEVM (999) son, para quien elige ruta, "Hyperliquid".
  [999, 'Hyperliquid L1'], [1337, 'Hyperliquid L1'],
  // Redes que no son EVM: cada fuente les da su propio id.
  [1151111081099710, 'Solana'], [7565164, 'Solana'], [20000000000001, 'Bitcoin'],
  [20000000000005, 'Zcash'], [9270000000000000, 'Sui'], [728126428, 'Tron'],
]);

const ES_TESTNET = /testnet|sepolia/i;

/** El nombre comun de una red, o null si es una testnet. */
function nombreRed(id: number, nombreFuente: string | undefined): string | null {
  const fijo = CADENA_POR_ID.get(id);
  if (fijo !== undefined) return fijo;
  if (nombreFuente === undefined || ES_TESTNET.test(nombreFuente)) return null;
  return nombreFuente;
}

export type ViaRuta = 'lifi' | 'debridge';

/** Un puente con las rutas que una fuente confirma que sabe hacer. */
export interface ProveedorRutas {
  /** Agrupa variantes: las cuatro de Mayan en LI.FI son una sola fila. */
  readonly id: string;
  readonly name: string;
  readonly via: ViaRuta;
  /** Su slug en DefiLlama, para unirlo con su TVL. null si no tiene. */
  readonly llamaSlug: string | null;
  readonly chains: readonly string[];
  /** Pares `origen|destino`. Vacio si `anyToAny`. */
  readonly pairs: ReadonlySet<string>;
  /** true si conecta cualquier par de sus redes (deBridge). */
  readonly anyToAny: boolean;
}

export function conecta(p: ProveedorRutas, from: string, to: string): boolean {
  if (from === to) return false;
  return p.anyToAny ? p.chains.includes(from) && p.chains.includes(to) : p.pairs.has(`${from}|${to}`);
}

/**
 * LI.FI publica cada variante de un puente como herramienta aparte (Mayan
 * Swift, Mayan Wormhole, CCTP + Mayan...). Para elegir ruta son el mismo
 * proveedor. Y el slug es el de DefiLlama, comprobado uno a uno en /protocols.
 */
const GRUPO_LIFI: Readonly<Record<string, { id: string; name: string; slug: string | null }>> = {
  across: { id: 'across', name: 'Across', slug: 'across' },
  stargateV2: { id: 'stargate-v2', name: 'Stargate V2', slug: 'stargate-v2' },
  symbiosis: { id: 'symbiosis', name: 'Symbiosis', slug: 'symbiosis' },
  allbridge: { id: 'allbridge-core', name: 'Allbridge', slug: 'allbridge-core' },
  relaydepository: { id: 'relay', name: 'Relay', slug: 'relay' },
  cctp: { id: 'circle-cctp', name: 'Circle CCTP', slug: 'circle-cctp' },
  near: { id: 'near-intents', name: 'NEAR Intents', slug: 'near-intents' },
  garden: { id: 'garden', name: 'Garden', slug: 'garden' },
  layerswap: { id: 'layerswap', name: 'Layerswap', slug: 'layerswap' },
  squid: { id: 'squid', name: 'Squid', slug: 'squid' },
  arbitrum: { id: 'arbitrum-bridge', name: 'Arbitrum Bridge', slug: 'arbitrum-bridge' },
  mayan: { id: 'mayan-bridge', name: 'Mayan', slug: 'mayan-bridge' },
  mayanWH: { id: 'mayan-bridge', name: 'Mayan', slug: 'mayan-bridge' },
  mayanMCTP: { id: 'mayan-bridge', name: 'Mayan', slug: 'mayan-bridge' },
  mayanFastMCTP: { id: 'mayan-bridge', name: 'Mayan', slug: 'mayan-bridge' },
  celercircle: { id: 'celer-cctp', name: 'Celer CCTP', slug: null },
  celercirclefast: { id: 'celer-cctp', name: 'Celer CCTP', slug: null },
  polymer: { id: 'polymer', name: 'Polymer', slug: null },
  polymerStandard: { id: 'polymer', name: 'Polymer', slug: null },
  hyperliquidSA: { id: 'hyperliquid-bridge', name: 'Hyperliquid Bridge', slug: null },
  hyperliquidNative: { id: 'hyperliquid-bridge', name: 'Hyperliquid Bridge', slug: null },
};

export async function fetchLifiRoutes(): Promise<ProveedorRutas[]> {
  const [tools, chains] = await Promise.all([
    getJson(URL_LIFI_TOOLS, { timeoutMs: 30_000 }),
    getJson(URL_LIFI_CHAINS, { timeoutMs: 30_000 }),
  ]);
  if (!isRecord(tools) || !Array.isArray(tools['bridges'])) throw new Error('li.quest/v1/tools: unexpected shape');
  if (!isRecord(chains) || !Array.isArray(chains['chains'])) throw new Error('li.quest/v1/chains: unexpected shape');

  const nombreFuente = new Map<number, string>();
  for (const c of chains['chains']) {
    if (isRecord(c) && typeof c['id'] === 'number' && typeof c['name'] === 'string') nombreFuente.set(c['id'], c['name']);
  }

  const grupos = new Map<string, { name: string; slug: string | null; chains: Set<string>; pairs: Set<string> }>();
  for (const b of tools['bridges']) {
    if (!isRecord(b) || typeof b['key'] !== 'string' || typeof b['name'] !== 'string') continue;
    if (!Array.isArray(b['supportedChains'])) continue;
    const g = GRUPO_LIFI[b['key']] ?? { id: b['key'].toLowerCase(), name: b['name'], slug: null };
    const grupo = grupos.get(g.id) ?? { name: g.name, slug: g.slug, chains: new Set<string>(), pairs: new Set<string>() };
    for (const par of b['supportedChains']) {
      if (!isRecord(par)) continue;
      const a = num(par['fromChainId']);
      const z = num(par['toChainId']);
      if (a === null || z === null) continue;
      const desde = nombreRed(a, nombreFuente.get(a));
      const hasta = nombreRed(z, nombreFuente.get(z));
      if (desde === null || hasta === null || desde === hasta) continue;
      grupo.chains.add(desde);
      grupo.chains.add(hasta);
      grupo.pairs.add(`${desde}|${hasta}`);
    }
    grupos.set(g.id, grupo);
  }

  const out = [...grupos.entries()]
    .filter(([, g]) => g.pairs.size > 0)
    .map(([id, g]): ProveedorRutas => ({
      id, name: g.name, via: 'lifi', llamaSlug: g.slug, chains: [...g.chains].sort(), pairs: g.pairs, anyToAny: false,
    }));
  if (out.length === 0) throw new Error('li.quest/v1/tools: 0 bridges with routes');
  return out;
}

export async function fetchDebridgeRoutes(): Promise<ProveedorRutas[]> {
  const raw = await getJson(URL_DEBRIDGE, { timeoutMs: 30_000 });
  if (!isRecord(raw) || !Array.isArray(raw['chains'])) throw new Error('dln.debridge.finance: unexpected shape');
  const chains = new Set<string>();
  for (const c of raw['chains']) {
    if (!isRecord(c)) continue;
    const id = num(c['originalChainId']);
    const nombre = id === null ? null : nombreRed(id, typeof c['chainName'] === 'string' ? c['chainName'] : undefined);
    if (nombre !== null) chains.add(nombre);
  }
  if (chains.size < 2) throw new Error('dln.debridge.finance: fewer than 2 chains');
  return [{
    id: 'debridge', name: 'deBridge', via: 'debridge', llamaSlug: 'debridge',
    chains: [...chains].sort(), pairs: new Set(), anyToAny: true,
  }];
}

/** Un agregador de puentes y lo que ha movido. Todo en USD; null si no se publica. */
export interface AgregadorBridge {
  readonly slug: string;
  readonly name: string;
  readonly volume24hUsd: number | null;
  readonly volume7dUsd: number | null;
  readonly volume30dUsd: number | null;
  /** Los siete dias anteriores a los ultimos siete: para el cambio semanal. */
  readonly previous7dUsd: number | null;
}

export async function fetchBridgeAggregators(): Promise<AgregadorBridge[]> {
  const raw = await getJson(URL_AGREGADORES, { timeoutMs: 30_000 });
  if (!isRecord(raw) || !Array.isArray(raw['protocols'])) throw new Error('overview/bridge-aggregators: unexpected shape');
  const out: AgregadorBridge[] = [];
  for (const p of raw['protocols']) {
    if (!isRecord(p) || typeof p['slug'] !== 'string') continue;
    const nombre = typeof p['displayName'] === 'string' ? p['displayName'] : typeof p['name'] === 'string' ? p['name'] : p['slug'];
    out.push({
      slug: p['slug'],
      name: nombre,
      volume24hUsd: num(p['total24h']),
      volume7dUsd: num(p['total7d']),
      volume30dUsd: num(p['total30d']),
      previous7dUsd: num(p['total14dto7d']),
    });
  }
  if (out.length === 0) throw new Error('overview/bridge-aggregators: 0 protocols');
  return out;
}
