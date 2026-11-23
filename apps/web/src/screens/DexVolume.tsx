import { useEffect, useMemo, useState } from 'react';
import {
  getJson, usd,
  type AssetClass, type SeriesResponse, type VolumeResponse, type VolumeWeeklyResponse,
} from '../api.ts';
import { Chart, SERIE_COLORS, type Serie } from '../components/Chart.tsx';
import { CLASS_LABELS, CLASS_ORDER } from '../components/clases.ts';
import { FiltroTipo, useTipoVenue, type TipoVenue } from '../components/tipoVenue.tsx';

/**
 * DEX Volume.
 *
 * A 24 h el dato esta medido. A 7 y 30 dias es una ESTIMACION: la media diaria
 * del volumen 24 h registrado, sumada por los dias con dato. Va etiquetada como
 * tal y con los dias que la respaldan, porque una estimacion con dos dias no
 * vale lo mismo que una con treinta (ver DESIGN.md).
 *
 * Cada fila es un simbolo DE UNA CLASE: CAT accion y CAT memecoin son dos
 * filas. La clase la decide el servidor con QFEX como referencia y el precio
 * como prueba (`claseActivo.ts`).
 */

const PERIODS = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
];


/** "Nov 10", en UTC: las semanas del servidor empiezan el lunes 00:00 UTC. */
function fechaSemana(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Evolucion del volumen 24 h de un par, una linea por venue.
 *
 * Se carga solo al abrir el par: pedir el historico de todos los pares de golpe
 * seria descargar la base entera para mirar uno. Solo pinta los venues de la
 * fila: si el CAT memecoin de Aster se aparto, su linea tampoco sale.
 */
function VolumeHistory({ symbol, venues }: { symbol: string; venues: readonly string[] }) {
  const [data, setData] = useState<SeriesResponse | null>(null);

  useEffect(() => {
    let vivo = true;
    const to = Date.now();
    const p = new URLSearchParams({ symbol, from: String(to - 7 * 86_400_000), to: String(to) });
    getJson<SeriesResponse>(`/api/series?${p}`)
      .then((d) => { if (vivo) setData(d); })
      .catch(() => undefined);
    return () => { vivo = false; };
  }, [symbol]);

  const clave = venues.join(',');
  const series = useMemo((): Serie[] => {
    const permitidos = new Set(clave.split(','));
    const porVenue = new Map<string, { time: number; value: number }[]>();
    for (const p of data?.points ?? []) {
      // Un volumen desconocido se omite del punto en vez de dibujarse como
      // cero: una linea que cae a cero se lee como "dejo de haber volumen".
      if (p.volume24hUsd === null || !permitidos.has(p.venue)) continue;
      const lista = porVenue.get(p.venue) ?? [];
      lista.push({ time: Math.floor(p.ts / 1000), value: p.volume24hUsd });
      porVenue.set(p.venue, lista);
    }
    return [...porVenue.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([venue, puntos], i) => ({
        id: venue,
        label: venue,
        color: SERIE_COLORS[i % SERIE_COLORS.length] ?? '#4c9af8',
        points: puntos.sort((x, y) => x.time - y.time),
      }));
  }, [data, clave]);

  const puntos = series.reduce((a, s) => a + s.points.length, 0);
  const fmtUsd = useMemo(() => (v: number) => usd(v), []);

  if (data === null) return <p className="none">Loading history…</p>;
  if (puntos === 0) return <p className="none">No volume history recorded for {symbol} yet.</p>;

  return (
    <div className="history">
      <div className="label">24h volume over time · one line per venue</div>
      <Chart series={series} height={200} formatValue={fmtUsd} />
      <div className="legend">
        {series.map((s) => (
          <span key={s.id} className="legend-item">
            <span className="legend-dot" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Volumen semana a semana, todos los venues sumados.
 *
 * El cambio solo aparece entre dos semanas completas: el servidor lo deja en
 * null si a una de las dos le faltan dias, y aqui se pinta "—". Una semana con
 * la app apagada no es una semana en la que cayo el mercado.
 */
function WeeklyVolume({ assetClass, tipo, refreshKey }: { assetClass: AssetClass | null; tipo: TipoVenue; refreshKey: number }) {
  const [data, setData] = useState<VolumeWeeklyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const p = new URLSearchParams({ weeks: '12', venueKind: tipo });
    if (assetClass !== null) p.set('class', assetClass);
    getJson<VolumeWeeklyResponse>(`/api/volume/weekly?${p}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [assetClass, tipo, refreshKey]);

  // Se esconden las semanas antiguas sin un solo dato: son de antes de que la
  // app empezase a recoger, no semanas sin volumen.
  const semanas = useMemo(() => {
    const lista = data?.weeks ?? [];
    let ultimaConDato = -1;
    lista.forEach((w, i) => { if (w.totalUsd !== null) ultimaConDato = i; });
    return lista.slice(0, Math.max(ultimaConDato + 1, 1));
  }, [data]);
  // La barra mide la media diaria y no el total: una semana con un solo dia
  // recogido no es una semana floja.
  const maximo = Math.max(0, ...semanas.map((w) => w.avgDailyUsd ?? 0));

  return (
    <section className="bloque">
      <header className="bloque-cabecera">
        <h2>Weekly volume</h2>
        <span className="none">
          all venues{assetClass !== null ? ` · ${CLASS_LABELS[assetClass]}` : ''}
          <span className="estimated">est.</span>
        </span>
      </header>
      {error !== null ? (
        <p className="light light-red">Could not load weekly volume: {error}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Week of</th>
                <th>Daily average</th>
                <th className="num">Per day</th>
                <th className="num">Week total</th>
                <th className="num">Days recorded</th>
                <th className="num">Venues</th>
                <th className="num">vs prior week</th>
              </tr>
            </thead>
            <tbody>
              {data === null ? (
                <tr><td colSpan={7} className="none">Loading…</td></tr>
              ) : semanas.map((w) => (
                <tr key={w.weekStart}>
                  <td>
                    {fechaSemana(w.weekStart)}
                    {w.inProgress && <span className="none"> · in progress</span>}
                  </td>
                  <td>
                    <span className="bar">
                      <span
                        className="bar-fill"
                        style={{ width: `${maximo > 0 && w.avgDailyUsd !== null ? (w.avgDailyUsd / maximo) * 100 : 0}%` }}
                      />
                    </span>
                  </td>
                  <td className="num">{usd(w.avgDailyUsd)}</td>
                  <td className="num none">{usd(w.totalUsd)}</td>
                  <td className={w.daysWithData < w.daysElapsed ? 'num light-yellow' : 'num none'}>
                    {w.daysWithData}/{w.daysElapsed}
                  </td>
                  <td className="num none">{w.venueCount === 0 ? '—' : w.venueCount}</td>
                  <td className="num">
                    {w.changePct === null
                      ? <span className="none">—</span>
                      : <span className={w.changePct >= 0 ? 'pos' : 'neg'}>
                          {w.changePct >= 0 ? '+' : ''}{w.changePct.toFixed(1)}%
                        </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function DexVolume({ refreshKey }: { refreshKey: number }) {
  const [days, setDays] = useState(1);
  const [assetClass, setAssetClass] = useState<AssetClass | null>(null);
  const [symbol, setSymbol] = useState('');
  const [abierto, setAbierto] = useState<string | null>(null);
  const [data, setData] = useState<VolumeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tipo, setTipo] = useTipoVenue();

  useEffect(() => {
    let vivo = true;
    const p = new URLSearchParams({ days: String(days), limit: '60', venueKind: tipo });
    if (symbol.trim() !== '') p.set('symbol', symbol.trim());
    if (assetClass !== null) p.set('class', assetClass);
    getJson<VolumeResponse>(`/api/volume?${p}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [days, symbol, assetClass, tipo, refreshKey]);

  // Solo las clases que existen hoy en algun venue: un boton que siempre da
  // una tabla vacia no ayuda a nada.
  const clasesConMercados = useMemo(
    () => CLASS_ORDER.filter((c) => (data?.marketsByClass[c] ?? 0) > 0),
    [data],
  );

  if (error !== null) return <p className="light light-red">Could not load volume: {error}</p>;

  const maximo = data?.pairs[0]?.totalUsd ?? 0;
  const estimado = data !== null && !data.period.measured;
  const dias = data?.period.coverageDays ?? 0;
  const conClase = assetClass === null;
  const columnas = conClase ? 6 : 5;

  return (
    <>
      <div className="controls">
        <div className="control-group">
          <span className="label">Period</span>
          <div className="segmented">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                className={p.days === days ? 'seg seg-active' : 'seg'}
                onClick={() => setDays(p.days)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="label">Asset class</span>
          <div className="segmented">
            <button
              className={assetClass === null ? 'seg seg-active' : 'seg'}
              onClick={() => setAssetClass(null)}
            >
              All
            </button>
            {clasesConMercados.map((c) => (
              <button
                key={c}
                className={c === assetClass ? 'seg seg-active' : 'seg'}
                onClick={() => setAssetClass(c)}
              >
                {CLASS_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
        <label className="grow">
          <span className="label">Pair</span>
          <input
            type="search"
            value={symbol}
            placeholder="BTC, NVDA, XAU…"
            onChange={(e) => setSymbol(e.target.value)}
          />
        </label>
        <FiltroTipo tipo={tipo} onCambiar={setTipo} enControles />
      </div>

      {estimado && (
        // El aviso va arriba y no en una nota al pie: si el numero es estimado,
        // hay que verlo antes que el numero, no despues.
        <div className="degraded-note">
          Estimated from {dias} of {days} days recorded
        </div>
      )}

      <div className="stats">
        <div className="stat">
          <div className="label">Pairs with volume</div>
          <div className="stat-value">{data === null ? '—' : data.pairCount}</div>
        </div>
        <div className="stat">
          <div className="label">Period</div>
          <div className="stat-value">
            {PERIODS.find((p) => p.days === days)?.label}
            {estimado && <span className="estimated">est.</span>}
          </div>
        </div>
        <div className="stat">
          <div className="label">Total volume</div>
          <div className="stat-value">{data === null ? '—' : usd(data.totalUsd)}</div>
        </div>
        <div className="stat">
          <div className="label">Kept out · other asset</div>
          <div className="stat-value">
            {data === null || data.keptOutUsd === 0 ? <span className="none">—</span> : usd(data.keptOutUsd)}
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Pair</th>
              {conClase && <th>Class</th>}
              <th>Share of top pair</th>
              <th className="num">Volume</th>
              <th className="num">Venues</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={columnas} className="none">Loading…</td></tr>
            ) : data.pairs.length === 0 ? (
              <tr><td colSpan={columnas} className="none">No pair with recorded volume.</td></tr>
            ) : (
              data.pairs.flatMap((p, i) => {
                const id = `${p.symbol}|${p.assetClass}`;
                const filas = [
                  <tr
                    key={id}
                    className="clickable"
                    onClick={() => setAbierto((a) => (a === id ? null : id))}
                  >
                    <td className="none">#{i + 1}</td>
                    <td className="asset">{p.symbol}</td>
                    {conClase && <td className="none">{CLASS_LABELS[p.assetClass]}</td>}
                    <td>
                      <span className="bar">
                        <span
                          className="bar-fill"
                          style={{ width: `${maximo > 0 ? (p.totalUsd / maximo) * 100 : 0}%` }}
                        />
                      </span>
                    </td>
                    <td className="num">{usd(p.totalUsd)}</td>
                    <td className="num none">
                      {p.venueCount} {abierto === id ? '▾' : '▸'}
                    </td>
                  </tr>,
                ];

                if (abierto === id) {
                  filas.push(
                    <tr key={`${id}-detalle`} className="detail-row">
                      <td colSpan={columnas}>
                        <table className="detail">
                          <thead>
                            <tr>
                              <th>Venue</th>
                              <th>Share</th>
                              <th className="num">Volume</th>
                              <th className="num">%</th>
                              <th className="num">Open interest</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.venues.map((v) => (
                              <tr key={v.venue}>
                                <td>{v.venue}</td>
                                <td>
                                  <span className="bar">
                                    <span className="bar-fill" style={{ width: `${v.share * 100}%` }} />
                                  </span>
                                </td>
                                <td className="num">{usd(v.volumeUsd)}</td>
                                <td className="num none">{(v.share * 100).toFixed(0)}%</td>
                                <td className="num">
                                  {v.openInterestUsd === null
                                    ? <span className="none">—</span>
                                    : usd(v.openInterestUsd)}
                                </td>
                              </tr>
                            ))}
                            {p.keptOut.map((k) => (
                              <tr key={`fuera-${k.venue}`} className="none">
                                <td>{k.venue}</td>
                                <td className="light-yellow">other asset, not summed</td>
                                <td className="num">{usd(k.volumeUsd)}</td>
                                <td className="num">—</td>
                                <td className="num">—</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <VolumeHistory symbol={p.symbol} venues={p.venues.map((v) => v.venue)} />
                      </td>
                    </tr>,
                  );
                }
                return filas;
              })
            )}
          </tbody>
        </table>
      </div>

      <WeeklyVolume assetClass={assetClass} tipo={tipo} refreshKey={refreshKey} />
    </>
  );
}
