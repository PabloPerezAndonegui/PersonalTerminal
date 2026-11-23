/**
 * Comprueba, contra las APIs reales, si el interes abierto de cada venue viene
 * a UNA pata o a DOS.
 *
 * ## Por que hace falta un script y no basta leer la documentacion
 *
 * Casi ningun venue dice cual de las dos publica. Y el error no se ve: un
 * `open_interest` a dos patas tratado como una pata sale exactamente al doble,
 * que es una cifra plausible, con la forma correcta y la unidad correcta. En un
 * comparador de venues eso no es un detalle, es la mitad de la respuesta.
 *
 * ## El metodo, y lo que vale
 *
 * DefiLlama normaliza su dimension de interes abierto a UNA pata. Lo dice en el
 * codigo de sus adaptadores ("so halve it here to match the one-sided
 * convention used across perp OI"). Asi que el cociente entre su cifra y la
 * nuestra, sobre el MISMO venue, dice cual es la nuestra:
 *
 *   - cociente ~0,50  ->  ellos dividieron  ->  nuestra fuente da DOS patas.
 *   - cociente ~1,00  ->  no dividieron     ->  nuestra fuente da UNA pata.
 *
 * Esto NO es comparar cifras de venues distintos a ver si se parecen. Eso no
 * probaria nada: dos exchanges tienen el interes abierto que tienen. Aqui se
 * mide el mismo venue leido por dos vias, y lo que se interpreta es el salto
 * entre las dos, que solo puede venir del factor dos.
 *
 * ## Lo que este metodo NO demuestra
 *
 * 1. Depende de que el adaptador de DefiLlama para ESE venue aplique bien la
 *    convencion de la casa. Donde no la aplican, el cociente sale 1,00 sobre
 *    una fuente de dos patas y la lectura seria al reves. Ya hay un caso
 *    conocido y esta abajo: los perps HIP-3 de Hyperliquid, que pasan sin
 *    dividir. Por eso el script los mide aparte en vez de fiarse.
 * 2. Su cifra es diaria y la nuestra instantanea. Un venue cuyo interes
 *    abierto se haya movido mucho hoy cae fuera de las bandas sin que la
 *    convencion tenga nada que ver.
 * 3. Un cociente de 0,50 tambien saldria si leyeran un subconjunto que resulta
 *    ser la mitad. Es improbable con 0,50 clavado, pero no imposible.
 *
 * Por eso esto IMPRIME y no decide. Lo que entra en `FICHA_DEX` lo mete una
 * persona, con la prueba escrita al lado. Un venue cuyo unico aval sea este
 * cociente se anota como tal, no como verificado contra el propio venue.
 *
 * Uso:  npm run verify-oi
 */
import {
  createAdapters, activeVenueIds, REGISTRY, fetchLlamaOi, venueDeNombre, FICHA_DEX,
  HIP3_DE_HYPERLIQUID,
} from '@defi/venues';

/** Cociente al que se considera que DefiLlama dividio entre dos. */
const BANDA_DOBLE = [0.47, 0.53] as const;
/** Cociente al que se considera que paso la cifra tal cual. */
const BANDA_SIMPLE = [0.95, 1.05] as const;

/** Los perps que terceros despliegan sobre Hyperliquid, por su nombre corto. */
const URL_HL = 'https://api.hyperliquid.xyz/info';

const dinero = (v: number | null): string =>
  v === null ? '—' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(1)}M`;

interface Medida {
  readonly venue: string;
  readonly nuestro: number | null;
  readonly mercados: number;
  readonly sinDato: number;
  readonly llama: number | null;
  readonly llamaLabel: string | null;
}

/**
 * Cuanto se espera a un venue antes de pasar al siguiente.
 *
 * Hace falta un limite: Aster pide los 572 simbolos uno a uno y su refresco se
 * va a muchos minutos, asi que sin esto el script se queda colgado en el
 * segundo venue y no llega a imprimir ni los que ya habia medido.
 */
const ESPERA_MAX_MS = 45_000;

/** Suma el interes abierto que lee nuestro propio adaptador. */
async function medirNuestro(id: string): Promise<{ oi: number | null; mercados: number; sinDato: number }> {
  const [adapter] = createAdapters([id]);
  if (adapter === undefined) return { oi: null, mercados: 0, sinDato: 0 };
  let reloj: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_r, reject) => {
    reloj = setTimeout(() => { reject(new Error(`sin respuesta en ${ESPERA_MAX_MS / 1000} s`)); }, ESPERA_MAX_MS);
  });
  try {
    await Promise.race([adapter.refresh(), limite]);
  } finally {
    if (reloj !== undefined) clearTimeout(reloj);
  }
  const snap = adapter.snapshot();
  let oi: number | null = null;
  let sinDato = 0;
  for (const m of snap.values()) {
    const v = m.openInterestUsd;
    if (v === null || !Number.isFinite(v)) { sinDato += 1; continue; }
    oi = (oi ?? 0) + v;
  }
  return { oi, mercados: snap.size, sinDato };
}

/**
 * Los HIP-3 de Hyperliquid, leidos directos.
 *
 * Van aparte porque son el caso que rompe el metodo del cociente: DefiLlama los
 * publica como "Interface" sobre Hyperliquid L1 y les pasa el campo sin
 * dividir, asi que su cifra coincide con la cruda. Medirlo es la unica forma de
 * saber que ese 1,00 significa "no dividieron una fuente de dos patas" y no
 * "la fuente ya venia a una pata".
 */
async function medirHip3(): Promise<Map<string, number>> {
  const post = async (body: unknown): Promise<unknown> => {
    const r = await fetch(URL_HL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
    return r.json();
  };
  const dexs = await post({ type: 'perpDexs' });
  if (!Array.isArray(dexs)) return new Map();
  const nombres = dexs
    .filter((d): d is { name: string } => d !== null && typeof d === 'object' && typeof (d as { name?: unknown }).name === 'string')
    .map((d) => d.name);

  const porDex = new Map<string, number>();
  for (const dex of nombres) {
    const res = await post({ type: 'metaAndAssetCtxs', dex });
    if (!Array.isArray(res) || res.length < 2) continue;
    const meta = res[0] as { universe?: readonly unknown[] };
    const ctxs = res[1];
    if (!Array.isArray(meta.universe) || !Array.isArray(ctxs)) continue;
    let oi = 0;
    meta.universe.forEach((_u, i) => {
      const c = ctxs[i] as { openInterest?: unknown; oraclePx?: unknown; markPx?: unknown } | undefined;
      if (c === undefined) return;
      const unidades = Number(c.openInterest);
      const precio = Number(c.oraclePx ?? c.markPx);
      if (!Number.isFinite(unidades) || !Number.isFinite(precio)) return;
      oi += unidades * precio;
    });
    porDex.set(dex, oi);
  }
  return porDex;
}

/** Como se lee el cociente, o por que no se puede leer. */
function veredicto(cociente: number | null): { convencion: string; nota: string } {
  if (cociente === null) return { convencion: '?', nota: 'falta una de las dos cifras' };
  if (cociente >= BANDA_DOBLE[0] && cociente <= BANDA_DOBLE[1]) {
    return { convencion: 'double', nota: 'ellos dividen: nuestra fuente da dos patas' };
  }
  if (cociente >= BANDA_SIMPLE[0] && cociente <= BANDA_SIMPLE[1]) {
    return { convencion: 'single', nota: 'no dividen: nuestra fuente da una pata' };
  }
  return { convencion: '?', nota: 'fuera de banda, no concluye' };
}

const ids = process.argv.slice(2);
// Todo lo que hay en el registro es un DEX: los CEX no tienen adaptador, se
// leen por `FUENTES_CEX` y su convencion se comprueba contra el propio venue.
const dexIds = (ids.length > 0 ? ids : activeVenueIds()).filter((id) => REGISTRY.has(id));

console.log('Leyendo DefiLlama...');
const llama = await fetchLlamaOi();
// Sus cifras por venue nuestro: `fetchLlamaOi` descarta los que ya leemos
// directos para no contarlos dos veces, asi que aqui hace falta la lista cruda.
const crudo = await (await fetch(
  'https://api.llama.fi/overview/open-interest'
  + '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true',
)).json() as { protocols?: readonly { name?: unknown; total24h?: unknown; category?: unknown; chains?: readonly unknown[] }[] };

const porVenue = new Map<string, { oi: number; label: string; esPerp: boolean }>();
for (const p of crudo.protocols ?? []) {
  if (typeof p.name !== 'string') continue;
  const venue = venueDeNombre(p.name);
  const oi = Number(p.total24h);
  if (venue === null || !Number.isFinite(oi)) continue;
  // Un venue puede tener VARIAS filas, y quedarse con la mayor no sirve: de
  // Paradex publican "Paradex Options" con 127 M y "Paradex Perps" con 9, y lo
  // que leemos nosotros son los perps. Se elige por categoria.
  const esPerp = p.category === 'Derivatives' || p.category === 'Interface';
  const previo = porVenue.get(venue);
  if (!esPerp && previo !== undefined) continue;
  if (previo === undefined || (esPerp && !previo.esPerp) || (esPerp === previo.esPerp && oi > previo.oi)) {
    porVenue.set(venue, { oi, label: p.name, esPerp });
  }
}

const medidas: Medida[] = [];
for (const id of dexIds) {
  try {
    const { oi, mercados, sinDato } = await medirNuestro(id);
    const l = porVenue.get(id);
    medidas.push({
      venue: id, nuestro: oi, mercados, sinDato,
      llama: l?.oi ?? null, llamaLabel: l?.label ?? null,
    });
  } catch (e) {
    console.log(`${id.padEnd(14)} ERROR  ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('');
console.log('venue          nuestro     DefiLlama   cociente  mide      declarado  acuerdo');
console.log('-'.repeat(92));

const discrepancias: string[] = [];
for (const m of medidas.sort((a, b) => (b.nuestro ?? 0) - (a.nuestro ?? 0))) {
  const cociente = m.nuestro !== null && m.nuestro > 0 && m.llama !== null ? m.llama / m.nuestro : null;
  // En un HIP-3 el cociente no concluye: ellos no dividen esa fila, asi que un
  // 1,00 saldria igual con una pata que con dos. Se mide en la tabla de abajo.
  const hip3 = HIP3_DE_HYPERLIQUID.includes(m.venue);
  const v = hip3
    ? { convencion: '?', nota: 'HIP-3: ver la tabla de abajo' }
    : veredicto(cociente);
  const declarado = FICHA_DEX[m.venue]?.convention ?? 'unverified';
  const acuerdo = v.convencion === '?' ? '—'
    : declarado === 'unverified' ? 'SIN DECLARAR'
    : v.convencion === declarado ? 'si' : 'NO';
  if (acuerdo === 'NO') {
    discrepancias.push(`${m.venue}: declarado ${declarado}, el cociente dice ${v.convencion}`);
  }
  console.log(
    `${m.venue.padEnd(14)} ${dinero(m.nuestro).padStart(9)}  ${dinero(m.llama).padStart(10)}  `
    + `${(cociente === null ? '—' : cociente.toFixed(3)).padStart(8)}  ${v.convencion.padEnd(8)}  `
    + `${declarado.padEnd(10)} ${acuerdo}`,
  );
  if (m.sinDato > 0) {
    console.log(`${' '.repeat(15)}(${m.sinDato} de ${m.mercados} mercados sin interes abierto en nuestra lectura)`);
  }
}

console.log('');
console.log('Perps HIP-3 sobre Hyperliquid, leidos directos contra su API.');
console.log('DefiLlama los lista como "Interface" y les pasa el campo SIN dividir,');
console.log('asi que aqui un 1,00 significa dos patas, no una.');
console.log('');
const hip3 = await medirHip3();
const interfaces = new Map<string, number>();
for (const p of crudo.protocols ?? []) {
  if (typeof p.name !== 'string' || p.category !== 'Interface') continue;
  const chains = (p.chains ?? []).map(String);
  if (!chains.some((c) => c.toLowerCase().includes('hyperliquid'))) continue;
  const oi = Number(p.total24h);
  if (Number.isFinite(oi)) interfaces.set(p.name, oi);
}
console.log('dex        crudo (dos patas)   su fila en DefiLlama       cociente');
for (const [dex, oi] of [...hip3].sort((a, b) => b[1] - a[1])) {
  if (oi <= 0) continue;
  // Se empareja por cifra porque sus nombres no coinciden con el dex corto:
  // `xyz` es "tradeXYZ" y `io` es "entropy.io". El emparejamiento se imprime
  // para que se vea, no se usa para concluir nada por si solo.
  let mejor: { nombre: string; oi: number } | null = null;
  for (const [nombre, v] of interfaces) {
    const c = v / oi;
    if (c > 0.9 && c < 1.1 && (mejor === null || Math.abs(c - 1) < Math.abs(mejor.oi / oi - 1))) {
      mejor = { nombre, oi: v };
    }
  }
  console.log(
    `${dex.padEnd(10)} ${dinero(oi).padStart(10)}          `
    + `${(mejor?.nombre ?? '(sin fila)').padEnd(22)} ${mejor === null ? '—' : (mejor.oi / oi).toFixed(3)}`,
  );
}

console.log('');
if (discrepancias.length > 0) {
  console.log('DISCREPANCIAS con lo declarado en FICHA_DEX:');
  for (const d of discrepancias) console.log(`  - ${d}`);
  process.exitCode = 1;
} else {
  console.log('Ninguna discrepancia con lo declarado en FICHA_DEX.');
}
console.log(`DefiLlama: ${llama.protocols.length} protocolos utiles, ${llama.excluded} descartados por leerlos directos.`);
