import { Fragment, useEffect, useState } from 'react';
import { getJson, fmt, type AssetClass, type ExplorerResponse, usd } from '../api.ts';
import { CLASS_LABELS, CLASS_ORDER } from '../components/clases.ts';
import { FiltroTipo, useTipoVenue } from '../components/tipoVenue.tsx';

/**
 * Explorer.
 *
 * Buscar un activo y ver donde cotiza, a que precio, con que volumen y con que
 * fees. Incluye la dispersion de precio entre venues porque es el dato que dice
 * si merece la pena mirar Parity: si todos coinciden, no hay nada que arbitrar;
 * si uno se sale, o hay oportunidad o hay un problema de datos.
 *
 * La busqueda va por el simbolo comun, por el nombre de cada venue y por lo que
 * sigue: "SPY" trae tambien el S&P 500, "gold" el oro, PAXG y XAUT. Son filas
 * distintas (otro precio, otro contrato), pero juntas.
 */

/** Precio con decimales utiles: un token a 0,0000037 no puede salir como 0,00. */
function precio(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(6);
  return v.toExponential(4);
}

const bps = (v: number | null) => (v === null ? '—' : `${v} bps`);

/** Desvio frente a la mediana: a partir de 0,5 % ya es algo que mirar. */
function desvio(v: number | null) {
  if (v === null) return <span className="none">—</span>;
  const t = `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  return Math.abs(v) >= 0.5 ? <span className="warn-text">{t}</span> : <span className="none">{t}</span>;
}

export function Explorer({ refreshKey }: { refreshKey: number }) {
  const [q, setQ] = useState('');
  const [clase, setClase] = useState<AssetClass | null>(null);
  const [tipo, setTipo] = useTipoVenue();
  const [abierto, setAbierto] = useState<string | null>(null);
  const [data, setData] = useState<ExplorerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const p = new URLSearchParams({ limit: '60', venueKind: tipo });
    if (q.trim() !== '') p.set('q', q.trim());
    if (clase !== null) p.set('class', clase);
    getJson<ExplorerResponse>(`/api/explorer?${p}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [q, clase, tipo, refreshKey]);

  if (error !== null) return <p className="light light-red">Could not load assets: {error}</p>;

  const conSigue = data?.assets.some((a) => a.tracks !== null) ?? false;
  const columnas = conSigue ? 7 : 6;

  return (
    <>
      <div className="controls">
        <label className="grow">
          <span className="label">Asset</span>
          <input
            type="search"
            value={q}
            placeholder="BTC, SPY, gold…"
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </label>
        <div className="control-group">
          <span className="label">Asset class</span>
          <div className="segmented">
            <button className={clase === null ? 'seg seg-active' : 'seg'} onClick={() => setClase(null)}>All</button>
            {CLASS_ORDER.map((c) => (
              <button key={c} className={c === clase ? 'seg seg-active' : 'seg'} onClick={() => setClase(c)}>
                {CLASS_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
        <FiltroTipo tipo={tipo} onCambiar={setTipo} enControles />
        <div className="control-group">
          <span className="label">Results</span>
          <div className="stat-inline">{data === null ? '—' : data.total}</div>
        </div>
      </div>

      <div className="table-wrap explorer-tabla">
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              {conSigue && <th>Tracks</th>}
              <th>Class</th>
              <th className="num">Price</th>
              <th className="num">24h volume</th>
              <th className="num" title="Gap between the most expensive and the cheapest venue">Venue spread</th>
              <th className="num">Markets</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={columnas} className="none">Loading…</td></tr>
            ) : data.assets.length === 0 ? (
              <tr><td colSpan={columnas} className="none">No asset matches “{q}”.</td></tr>
            ) : (
              data.assets.map((a) => {
                const id = `${a.symbol}|${a.assetClass}`;
                return (
                  <Fragment key={id}>
                    <tr className="clickable" onClick={() => setAbierto((x) => (x === id ? null : id))}>
                      <td className="asset">{a.symbol}</td>
                      {conSigue && <td>{a.tracks ?? <span className="none">—</span>}</td>}
                      <td>{CLASS_LABELS[a.assetClass]}</td>
                      <td className="num">{precio(a.price)}</td>
                      <td className="num">{usd(a.volume24hUsd)}</td>
                      <td className="num">
                        {a.priceSpreadPct === null ? (
                          <span className="none">—</span>
                        ) : (
                          // Por encima del 1 % entre venues del mismo activo, o
                          // hay algo que arbitrar o hay un problema de datos.
                          <span className={a.priceSpreadPct > 1 ? 'warn-text' : undefined}>
                            {a.priceSpreadPct.toFixed(2)}%
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {a.perpVenues} perp{a.swapVenues > 0 ? ` · ${a.swapVenues} swap` : ''} {abierto === id ? '▾' : '▸'}
                      </td>
                    </tr>

                    {abierto === id && (
                      <tr className="detail-row">
                        <td colSpan={columnas}>
                          {a.related.length > 0 && (
                            <div className="control-group detail-relacionados">
                              <span className="label">Same exposure</span>
                              <div className="segmented">
                                {a.related.map((r) => (
                                  <button key={r} className="seg" onClick={() => { setQ(r); setAbierto(null); }}>{r}</button>
                                ))}
                              </div>
                            </div>
                          )}
                          <table className="detail">
                            <thead>
                              <tr>
                                <th>Venue</th>
                                <th>Type</th>
                                <th>Native symbol</th>
                                <th className="num">Price</th>
                                <th className="num" title="Distance from the median price of all venues">vs median</th>
                                <th className="num">Funding APR</th>
                                <th className="num">24h volume</th>
                                <th className="num">Open interest</th>
                                <th className="num">Maker</th>
                                <th className="num">Taker</th>
                              </tr>
                            </thead>
                            <tbody>
                              {a.listings.map((l) => (
                                <tr key={`${l.venue}-${l.instrument}`}>
                                  <td>
                                    {l.url === null
                                      ? l.label
                                      : <a href={l.url} target="_blank" rel="noreferrer noopener">{l.label} ↗</a>}
                                  </td>
                                  <td>{l.instrument === 'swap' ? 'Swap' : 'Perp'}</td>
                                  <td className="nativo">
                                    {l.symbolNative}
                                    {l.contractMultiplier !== 1 && <span className="crit-mark"> ×{l.contractMultiplier}</span>}
                                  </td>
                                  <td className="num">{precio(l.mid)}</td>
                                  <td className="num">{desvio(l.vsMedianPct)}</td>
                                  <td
                                    className={l.fundingAprPct === null ? 'num none' : l.fundingAprPct >= 0 ? 'num pos' : 'num neg'}
                                    title={l.fundingAprPct === null ? 'A swap has no funding' : undefined}
                                  >
                                    {l.fundingAprPct === null ? '—' : fmt.pct(l.fundingAprPct)}
                                  </td>
                                  <td className="num">{usd(l.volume24hUsd)}</td>
                                  <td className="num">{usd(l.openInterestUsd)}</td>
                                  <td className="num">{bps(l.makerBps)}</td>
                                  <td className="num">{bps(l.takerBps)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
