import { useEffect, useState } from 'react';
import { getJson, fmt, type PoolsResponse, usd } from '../api.ts';
import { Selector, CADENAS_PRIORITARIAS } from '../components/Selector.tsx';

/**
 * Pools & Yields.
 *
 * Universo completo de DefiLlama. Lo importante de esta pantalla no es enseñar
 * el APY mas alto: es NO enseñarlo cuando no significa nada. Un 439.000 % que
 * existio durante un dia es la trampa clasica de estas tablas, asi que los APY
 * no representativos se ocultan por defecto y hay que pedirlos a proposito.
 *
 * Las medias de 7, 15 y 30 dias estan al lado del APY de hoy por lo mismo: lo
 * que se quiere saber es lo que la pool PAGA, no lo que paga esta hora. La de
 * 30 es de DefiLlama; las de 7 y 15 se calculan con el historico propio y salen
 * "—" hasta tener los dias minimos.
 */

/**
 * "aave-v3" -> "Aave V3". DefiLlama identifica los protocolos por slug; para
 * leer una tabla el nombre basta, y el slug sigue en el enlace.
 */
function nombreVenue(slug: string): string {
  return slug
    .split('-')
    .map((w) => (/^v\d+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}


function apy(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k%`;
  return `${v.toFixed(2)}%`;
}

const TVL_OPTIONS = [
  { usd: 0, label: 'Any' },
  { usd: 100_000, label: '>$100K' },
  { usd: 1_000_000, label: '>$1M' },
  { usd: 10_000_000, label: '>$10M' },
];

/**
 * Columnas por las que se puede ordenar, y el nombre que entiende la API.
 *
 * El orden lo hace el SERVIDOR, no esta pantalla: aqui solo llegan 80 filas de
 * las 13.000 que pasan el filtro, asi que ordenar aqui daria "el TVL mas bajo
 * de las 80 con mas APY", que no responde a ninguna pregunta.
 */
const COLUMNAS = {
  pool: 'Pool',
  project: 'Venue',
  chain: 'Chain',
  tvl: 'TVL',
  apy: 'APY now',
  mean7d: '7d avg',
  mean15d: '15d avg',
  mean30d: '30d avg',
  rewards: 'Rewards',
} as const;

/** Las columnas de texto se alinean a la izquierda; el resto son cifras. */
const TEXTO: ReadonlySet<Columna> = new Set(['pool', 'project', 'chain']);

type Columna = keyof typeof COLUMNAS;

/** Orden actual. `clave` a null es el tercer estado: sin ordenar. */
interface Orden {
  readonly clave: Columna | null;
  readonly dir: 'desc' | 'asc';
}

export function PoolsYields({ refreshKey }: { refreshKey: number }) {
  const [q, setQ] = useState('');
  const [chain, setChain] = useState('');
  const [project, setProject] = useState('');
  const [minTvl, setMinTvl] = useState(100_000);
  const [orden, setOrden] = useState<Orden>({ clave: 'apy', dir: 'desc' });
  const [stable, setStable] = useState(false);
  const [volatile, setVolatile] = useState(false);
  const [data, setData] = useState<PoolsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const p = new URLSearchParams({
      sort: orden.clave ?? 'none',
      dir: orden.dir,
      limit: '80',
      minTvl: String(minTvl),
    });
    if (q.trim() !== '') p.set('q', q.trim());
    if (chain !== '') p.set('chain', chain);
    if (project !== '') p.set('project', project);
    if (stable) p.set('stable', '1');
    if (volatile) p.set('volatile', '1');
    getJson<PoolsResponse>(`/api/pools?${p}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [q, chain, project, minTvl, orden, stable, volatile, refreshKey]);

  /**
   * Tres estados por columna: primero de mayor a menor, luego de menor a
   * mayor, y al tercer clic se quita el orden. Cambiar de columna empieza de
   * nuevo por el descendente, que es lo que casi siempre se quiere ver.
   */
  function ordenarPor(clave: Columna) {
    setOrden((o) => {
      if (o.clave !== clave) return { clave, dir: 'desc' };
      if (o.dir === 'desc') return { clave, dir: 'asc' };
      return { clave: null, dir: 'desc' };
    });
  }

  const flecha = (clave: Columna) =>
    orden.clave === clave ? (orden.dir === 'desc' ? ' ↓' : ' ↑') : '';

  if (error !== null) return <p className="light light-red">Could not load pools: {error}</p>;

  if (data !== null && !data.available) {
    // No se pinta una tabla vacia, que se leeria como "no hay pools".
    return (
      <div className="degraded-note">
        DefiLlama not answering: {data.reason}
      </div>
    );
  }

  return (
    <>

      <div className="controls">
        <label className="grow">
          <span className="label">Pair or protocol</span>
          <input
            type="search"
            value={q}
            placeholder="eth/btc, usdc, steth…"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>

        <Selector
          modo="uno"
          label="Venue"
          claveFavoritos="pools.fav.projects"
          valor={project}
          onElegir={setProject}
          opciones={[
            { id: '', label: 'All venues' },
            ...(data?.projects ?? []).map((v) => ({ id: v.id, label: nombreVenue(v.id), extra: usd(v.tvlUsd) })),
          ]}
        />

        {/* Con buscador, favoritos y las cadenas que importan arriba. Antes era
            un `<select>` alfabetico: para llegar a Arbitrum habia que pasar por
            Algorand y Aptos, y DefiLlama publica mas de cien cadenas. */}
        <Selector
          modo="uno"
          label="Chain"
          claveFavoritos="pools.fav.chains"
          prioridad={CADENAS_PRIORITARIAS}
          valor={chain}
          onElegir={setChain}
          opciones={[
            { id: '', label: 'All chains' },
            ...(data?.chains ?? []).map((c) => ({ id: c, label: c })),
          ]}
        />

        <div className="control-group">
          <span className="label">Min TVL</span>
          <div className="segmented">
            {TVL_OPTIONS.map((o) => (
              <button key={o.usd} className={o.usd === minTvl ? 'seg seg-active' : 'seg'} onClick={() => setMinTvl(o.usd)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="label">Show</span>
          <div className="segmented">
            <button className={stable ? 'seg seg-active' : 'seg'} onClick={() => setStable((v) => !v)}>
              Stablecoins only
            </button>
            <button className={volatile ? 'seg seg-active' : 'seg'} onClick={() => setVolatile((v) => !v)}>
              Include unstable APY
            </button>
          </div>
        </div>
      </div>

      {volatile && (
        <div className="degraded-note">
          Showing non-representative APYs
        </div>
      )}

      {/* Copia vieja. DefiLlama renueva sus pools cada hora y aqui se piden a
          esa misma cadencia; si deja de responder se sigue sirviendo la ultima
          copia buena, pero un APY de hace seis horas no puede leerse como el
          de ahora. Solo sale cuando pasa, asi que no es ruido. */}
      {data?.stale === true && (
        <div className="degraded-note">APYs from {fmt.ago(data.asOf ?? null)}</div>
      )}

      <div className="stats">
        <div className="stat">
          <div className="label">Pools matching</div>
          <div className="stat-value">{data === null ? '—' : data.total.toLocaleString('en-US')}</div>
        </div>
        <div className="stat">
          <div className="label">Tracked by DefiLlama</div>
          <div className="stat-value">{data === null ? '—' : data.totalUnfiltered.toLocaleString('en-US')}</div>
        </div>
        <div className="stat">
          <div className="label">Hidden as unstable APY</div>
          <div className="stat-value">{data === null ? '—' : data.hiddenVolatile.toLocaleString('en-US')}</div>
        </div>
        <div className="stat">
          <div className="label">Own APY history</div>
          <div className="stat-value">
            {data?.history === undefined ? '—' : `${data.history.daysRecorded} of 15 days`}
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {(Object.keys(COLUMNAS) as Columna[]).map((c) => (
                <th
                  key={c}
                  className={TEXTO.has(c) ? 'clickable' : 'clickable num'}
                  title="Sort descending, ascending, then off"
                  onClick={() => ordenarPor(c)}
                >
                  {COLUMNAS[c]}{flecha(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={9} className="none">Loading…</td></tr>
            ) : data.pools.length === 0 ? (
              <tr><td colSpan={9} className="none">No pool matches these filters.</td></tr>
            ) : (
              data.pools.map((p) => (
                <tr key={p.id}>
                  {/* El tramo de la pool (poolMeta) va en el titulo: es el
                      matiz, no el dato, y en linea propia duplicaba la fila. */}
                  <td className="asset" title={p.poolMeta ?? undefined}>
                    <a href={p.url} target="_blank" rel="noreferrer">{p.symbol}</a>
                  </td>
                  <td>{nombreVenue(p.project)}</td>
                  <td className="none">{p.chain}</td>
                  <td className="num">{usd(p.tvlUsd)}</td>
                  <td className="num">
                    <strong
                      className={p.volatileApy ? 'warn-text' : 'pos'}
                      title={p.volatileApy ? 'Unstable APY: spike or outlier' : undefined}
                    >
                      {apy(p.apy)}
                    </strong>
                  </td>
                  <td className="num">{apy(p.apyMean7d)}</td>
                  <td className="num">{apy(p.apyMean15d)}</td>
                  <td className="num">{apy(p.apyMean30d)}</td>
                  <td className="num none">{apy(p.apyReward)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
