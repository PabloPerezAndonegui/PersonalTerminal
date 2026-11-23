import { useEffect, useMemo, useState } from 'react';
import { getJson, type SeriesResponse, type VenueMeta } from '../api.ts';
import { Selector } from '../components/Selector.tsx';
import { Chart, SERIE_COLORS, type Serie } from '../components/Chart.tsx';
import { ParityScanner } from './ParityScanner.tsx';

/**
 * Parity.
 *
 * Tres vistas. El escaner (por defecto) mira todos los activos a la vez y
 * simula la convergencia: ver `ParityScanner.tsx`. Las otras dos miran un
 * activo a lo largo del tiempo: la diferencia entre dos venues y los precios.
 *
 * Usa el mark price, no bid/ask, y por tanto **no incluye slippage ni el spread
 * del libro**. Se dice en pantalla: un desajuste que parece ejecutable en este
 * grafico puede no serlo cuando cruzas el libro de verdad. Para eso esta el
 * Funding Scanner, que si pasea el libro.
 */

type Modo = 'scanner' | 'parity' | 'prices';

const RANGOS = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
];

/**
 * Un venue que ya no se recoge sigue en el historico y se puede comparar, pero
 * su serie se corta el dia que se apago. Se dice en el propio desplegable para
 * que un hueco no parezca un fallo.
 */
function etiquetaVenue(venue: string, activos: ReadonlySet<string>): string {
  return activos.has(venue) ? venue : `${venue} (history only)`;
}

export function Parity({ refreshKey }: { refreshKey: number }) {
  const [symbol, setSymbol] = useState('BTC');
  const [consulta, setConsulta] = useState('BTC');
  const [days, setDays] = useState(7);
  const [modo, setModo] = useState<Modo>('scanner');
  const [a, setA] = useState('');
  const [b, setB] = useState('');

  const [metas, setMetas] = useState<readonly VenueMeta[]>([]);
  const [data, setData] = useState<SeriesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<VenueMeta[]>('/api/venues').then(setMetas).catch(() => undefined);
  }, []);

  useEffect(() => {
    let vivo = true;
    const to = Date.now();
    const p = new URLSearchParams({
      symbol: consulta,
      from: String(to - days * 86_400_000),
      to: String(to),
    });
    getJson<SeriesResponse>(`/api/series?${p}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [consulta, days, refreshKey]);

  /** Puntos agrupados por venue, ordenados por tiempo. */
  const porVenue = useMemo(() => {
    const out = new Map<string, { time: number; value: number }[]>();
    for (const p of data?.points ?? []) {
      const lista = out.get(p.venue) ?? [];
      lista.push({ time: Math.floor(p.ts / 1000), value: p.mid });
      out.set(p.venue, lista);
    }
    for (const lista of out.values()) lista.sort((x, y) => x.time - y.time);
    return out;
  }, [data]);

  /** Los que se siguen recogiendo. El resto solo existe en el historico. */
  const activos = useMemo(() => new Set(metas.map((m) => m.id)), [metas]);

  // Primero los que se siguen recogiendo y, dentro de cada grupo, los que mas
  // puntos tienen. No por nombre: el historico conserva venues apagados y por
  // orden alfabetico la pantalla abria en "aster vs backpack", dos series que
  // apenas se solapan, asi que lo primero que se veia era "No history for BTC
  // in this range" con el activo mas liquido que existe. Y no solo por puntos,
  // porque un venue recien activado siempre tendra menos que uno que lleva
  // semanas apagandose.
  const venues = useMemo(
    () => [...porVenue.entries()]
      .sort((x, y) =>
        Number(activos.has(y[0])) - Number(activos.has(x[0])) ||
        y[1].length - x[1].length ||
        x[0].localeCompare(y[0]))
      .map(([v]) => v),
    [porVenue, activos],
  );

  // Al cambiar de activo, los venues elegidos pueden no existir en el nuevo.
  useEffect(() => {
    if (venues.length === 0) return;
    if (!venues.includes(a)) setA(venues[0] ?? '');
    if (!venues.includes(b)) setB(venues[1] ?? venues[0] ?? '');
  }, [venues, a, b]);

  /** Serie de diferencia porcentual entre dos venues, alineada por instante. */
  const serieParidad = useMemo((): Serie[] => {
    const pa = porVenue.get(a);
    const pb = porVenue.get(b);
    if (pa === undefined || pb === undefined || a === b) return [];

    // Se cruza por instante exacto: interpolar inventaria puntos que nadie
    // midio, y en una pantalla que busca desajustes eso es peligroso.
    const mapaB = new Map(pb.map((p) => [p.time, p.value]));
    const puntos = pa
      .filter((p) => mapaB.has(p.time))
      .map((p) => ({ time: p.time, value: ((p.value - (mapaB.get(p.time) ?? 0)) / (mapaB.get(p.time) ?? 1)) * 100 }));

    return [{ id: 'parity', label: `${a} vs ${b}`, color: SERIE_COLORS[0] ?? '#4c9af8', points: puntos }];
  }, [porVenue, a, b]);

  const seriesPrecios = useMemo((): Serie[] =>
    venues.map((v, i) => ({
      id: v,
      label: v,
      color: SERIE_COLORS[i % SERIE_COLORS.length] ?? '#4c9af8',
      points: porVenue.get(v) ?? [],
    })), [venues, porVenue]);

  /**
   * Muestras de la serie que se esta DIBUJANDO, no del total descargado.
   *
   * 45 puntos repartidos entre cinco venues son nueve por venue, que no es una
   * tendencia. Contar el total daba por bueno un grafico que no lo es.
   */
  const muestras = useMemo(() => {
    if (modo === 'parity') return serieParidad[0]?.points.length ?? 0;
    if (modo === 'prices') return Math.min(...(seriesPrecios.map((s) => s.points.length).concat([0])));
    return data?.points.length ?? 0;
  }, [modo, serieParidad, seriesPrecios, data]);

  const selectorModo = (
    <div className="control-group">
      <span className="label">Mode</span>
      <div className="segmented">
        <button className={modo === 'scanner' ? 'seg seg-active' : 'seg'} onClick={() => setModo('scanner')}>Scanner</button>
        <button className={modo === 'parity' ? 'seg seg-active' : 'seg'} onClick={() => setModo('parity')}>Parity %</button>
        <button className={modo === 'prices' ? 'seg seg-active' : 'seg'} onClick={() => setModo('prices')}>Prices</button>
      </div>
    </div>
  );

  if (modo === 'scanner') {
    return (
      <>
        <div className="controls">{selectorModo}</div>
        <ParityScanner refreshKey={refreshKey} />
      </>
    );
  }
  const fmtPct = useMemo(() => (v: number) => `${v.toFixed(3)}%`, []);
  const fmtPrecio = useMemo(() => (v: number) => (v >= 1 ? v.toFixed(2) : v.toExponential(2)), []);

  if (error !== null) return <p className="light light-red">Could not load history: {error}</p>;

  return (
    <>

      <div className="controls">
        <label>
          <span className="label">Asset</span>
          <input
            type="search"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') setConsulta(symbol); }}
          />
        </label>
        <div className="control-group">
          <span className="label">&nbsp;</span>
          <button className="seg seg-active" onClick={() => setConsulta(symbol)}>Load</button>
        </div>

        {selectorModo}

        <div className="control-group">
          <span className="label">Range</span>
          <div className="segmented">
            {RANGOS.map((r) => (
              <button key={r.days} className={r.days === days ? 'seg seg-active' : 'seg'} onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {modo === 'parity' && venues.length > 1 && (
          <>
            {/* Misma clave de favoritos en los dos lados: el venue que fijas es
                el mismo mires la pata que mires. */}
            <Selector modo="uno" label="Compare" claveFavoritos="parity.fav.venues"
              valor={a} onElegir={setA}
              opciones={venues.map((v) => ({ id: v, label: etiquetaVenue(v, activos) }))} />
            <Selector modo="uno" label="against" claveFavoritos="parity.fav.venues"
              valor={b} onElegir={setB}
              opciones={venues.map((v) => ({ id: v, label: etiquetaVenue(v, activos) }))} />
          </>
        )}
      </div>

      {/*
        Cuantas muestras respaldan lo que se ve. El collector guarda cada cinco
        minutos, asi que un rango recien empezado tiene pocos puntos y hay que
        decirlo en vez de dibujar cuatro puntos como si fueran una tendencia.
      */}
      {muestras === 0 ? (
        <div className="degraded-note">
          No history for {consulta} in this range
        </div>
      ) : muestras < 30 && (
        <div className="degraded-note">
          Only {muestras} points per venue, too few for a trend
        </div>
      )}

        <>
          <div className="chart-wrap">
            <Chart
              series={modo === 'parity' ? serieParidad : seriesPrecios}
              formatValue={modo === 'parity' ? fmtPct : fmtPrecio}
            />
          </div>
          <div className="legend">
            {(modo === 'parity' ? serieParidad : seriesPrecios).map((s) => (
              <span key={s.id} className="legend-item">
                <span className="legend-dot" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        </>
    </>
  );
}
