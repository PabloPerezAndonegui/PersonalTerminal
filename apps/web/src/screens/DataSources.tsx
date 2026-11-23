import { useEffect, useState } from 'react';
import { getJson, fmt, type SourcesResponse, type TrafficLight } from '../api.ts';

/**
 * Data Sources.
 *
 * La pantalla con la que se depura todo lo demas. No mide disponibilidad, mide
 * frescura y completitud: el fallo peligroso no es que una API se caiga, sino
 * que responda 200 OK con datos viejos o incompletos.
 *
 * Toda la interfaz en ingles.
 */

const LIGHT_TEXT: Record<TrafficLight, string> = {
  green: 'OK',
  yellow: 'Degraded',
  red: 'Down',
};

function Light({ light, text }: { light: TrafficLight | null; text?: string }) {
  // El color nunca va solo: siempre lleva texto, porque el daltonismo
  // rojo-verde es justo el que rompe un semaforo.
  if (light === null) return <span className="light none">No data yet</span>;
  return <span className={`light light-${light}`}>{text ?? LIGHT_TEXT[light]}</span>;
}

/**
 * Que pestanas alimenta una fuente.
 *
 * Las criticas van por su nombre; las que solo se degradan se resumen en un
 * recuento. Listar las siete pestanas en cada fila de venue son cuatro lineas
 * de ruido identico por fila, y lo que hay que ver de un vistazo es si esta
 * fuente rompe algo del todo. El detalle queda en el title, al pasar el raton.
 */
function Feeds({ sections }: { sections: SourcesResponse['sources'][number]['sections'] }) {
  const criticas = sections.filter((f) => f.criticality === 'critical');
  const parciales = sections.filter((f) => f.criticality === 'partial');
  const todas = sections.map((f) => f.label).join(', ');

  return (
    <span title={todas}>
      {criticas.map((f) => (
        <span key={f.id} className="feed-critical">
          {f.label}
          <span className="crit-mark"> (critical)</span>
        </span>
      ))}
      {criticas.length > 0 && parciales.length > 0 && <span className="none">, </span>}
      {parciales.length > 0 && (
        <span className="none">
          {parciales.length === 1 ? parciales[0]?.label : `${parciales.length} tabs`}
        </span>
      )}
    </span>
  );
}

export function DataSources({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    getJson<SourcesResponse>('/api/sources')
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [refreshKey]);

  if (error !== null) return <p className="light light-red">Could not load sources: {error}</p>;
  if (data === null) return <p className="none">Loading…</p>;

  // Que quiere decir cada regla, en corto. El mensaje completo va al lado.
  const REGLA: Record<string, string> = {
    'ticker-ambiguo': 'Same ticker, other asset',
    'precio-incoherente': 'Price out of line',
  };
  const hallazgos = data.findings ?? [];

  // Bloques como en el resto de pantallas, con su cabecera, en vez de
  // rotulos sueltos entre tablas.
  return (
    <div className="bloques">
      <section className="bloque">
      <header className="bloque-cabecera"><h2>Sources</h2></header>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Source</th>
              <th>Kind</th>
              <th>Cadence</th>
              <th className="num">Symbols</th>
              <th className="num">Coverage</th>
              <th className="num">p50</th>
              <th className="num">p95</th>
              <th className="num">Errors</th>
              <th>Last OK</th>
              <th>Feeds</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => (
              <tr key={s.id}>
                <td><Light light={s.light} /></td>
                {/* El proveedor iba debajo del nombre en letra pequena y casi
                    siempre repetia lo mismo: "Hyperliquid / Hyperliquid". Va
                    al titulo, donde no estorba. */}
                <td className="asset" title={s.provider}>
                  {s.docsUrl === null ? s.label : <a href={s.docsUrl} target="_blank" rel="noreferrer">{s.label}</a>}
                </td>
                <td className="none">{s.kind}</td>
                <td className="none">{s.cadence}</td>
                <td className="num">{s.health === null ? <span className="none">—</span> : fmt.int(s.health.symbolCount)}</td>
                <td className="num">
                  {s.health?.coverageRatio == null
                    ? <span className="none">—</span>
                    : `${Math.round(s.health.coverageRatio * 100)}%`}
                </td>
                <td className="num">{s.health === null ? <span className="none">—</span> : fmt.ms(s.health.latencyP50Ms)}</td>
                <td className="num">{s.health === null ? <span className="none">—</span> : fmt.ms(s.health.latencyP95Ms)}</td>
                <td className="num">
                  {s.health === null
                    ? <span className="none">—</span>
                    : <span className={s.health.errorRatePct > 0 ? 'neg' : undefined}>{s.health.errorRatePct.toFixed(0)}%</span>}
                </td>
                <td className="none">{fmt.ago(s.health?.lastOkAt ?? null)}</td>
                <td className="feeds"><Feeds sections={s.sections} /></td>
                <td className="none reason">{s.health?.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </section>

      <section className="bloque">
        <header className="bloque-cabecera">
          <h2>Data issues</h2>
          <span className="none">{hallazgos.length === 0 ? 'none in the last cycle' : `${hallazgos.length} in the last cycle, kept out of comparisons`}</span>
        </header>
        {hallazgos.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Venue</th><th>Symbol</th><th>Issue</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {hallazgos.map((f) => (
                  <tr key={`${f.venue}-${f.symbol ?? ''}-${f.rule}`}>
                    <td className="asset">{f.venue}</td>
                    <td>{f.symbol ?? '—'}</td>
                    <td className={f.severity === 'error' ? 'neg' : 'warn-text'}>{REGLA[f.rule] ?? f.rule}</td>
                    <td className="none detalle-hallazgo">{f.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bloque">
      <header className="bloque-cabecera"><h2>Impact by tab</h2></header>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Tab</th>
              <th>Unavailable</th>
              <th>Degraded by</th>
            </tr>
          </thead>
          <tbody>
            {data.impact.map((i) => (
              <tr key={i.section}>
                <td><Light light={i.light} /></td>
                <td>{i.label}</td>
                <td className={i.brokenCritical.length > 0 ? 'neg' : 'none'}>
                  {i.brokenCritical.length > 0 ? i.brokenCritical.join(', ') : '—'}
                </td>
                <td className="none">{i.degraded.length > 0 ? i.degraded.join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </section>
    </div>
  );
}
