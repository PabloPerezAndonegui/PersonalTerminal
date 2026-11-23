import { useEffect, useState } from 'react';
import { getJson, writeJson, usd, type FarmingProgram, type PointsResponse } from '../api.ts';

/**
 * Points & Competitions.
 *
 * Tres bloques, de lo mas personal a lo mas general:
 *
 * 1. **El tablero**: lo que el usuario farmea, en tarjetas que se arrastran.
 *    El orden es la prioridad y se guarda en la base.
 * 2. **Campanas en vivo**: las que el venue PUBLICA, leidas de su API. Hoy
 *    solo Perpl lo hace sin clave; no se copian a mano porque caducan.
 * 3. **Que venue expone sus puntos**: la referencia comprobada a mano, con su
 *    fecha, que caduca sola.
 */

const ESTADO: Record<string, { texto: string; clase: string }> = {
  public: { texto: 'Public API', clase: 'light light-green' },
  'auth-required': { texto: 'Login required', clase: 'light light-yellow' },
  blocked: { texto: 'Bot wall', clase: 'light light-yellow' },
  none: { texto: 'No public API', clase: 'none' },
};

const PERIODOS = ['weekly', 'daily', 'monthly', 'season', 'one-off'];

const ESTADO_CAMPANA: Record<string, { texto: string; clase: string }> = {
  live: { texto: 'Live', clase: 'light light-green' },
  upcoming: { texto: 'Upcoming', clase: 'light light-yellow' },
  ended: { texto: 'Ended', clase: 'none' },
};

/** "150k" -> 150000, "1.5m" -> 1500000. Vacio o ilegible: null, no cero. */
function leerCantidad(texto: string): number | null {
  const m = /^\s*([\d.,]+)\s*([km]?)\s*$/i.exec(texto);
  if (m === null) return null;
  const n = Number((m[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const sufijo = (m[2] ?? '').toLowerCase();
  return n * (sufijo === 'k' ? 1e3 : sufijo === 'm' ? 1e6 : 1);
}

function cantidad(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1)}K`;
  return String(v);
}

function fecha(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "in 6d", "2d ago": lo que importa de una fecha de cierre es cuanto falta. */
function relativo(ms: number | null): string {
  if (ms === null) return '';
  const dias = Math.round((ms - Date.now()) / 86_400_000);
  if (dias === 0) return 'today';
  return dias > 0 ? `in ${dias}d` : `${-dias}d ago`;
}

/** Tablero de tarjetas arrastrables. */
function Tablero() {
  const [programas, setProgramas] = useState<readonly FarmingProgram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [arrastrado, setArrastrado] = useState<string | null>(null);
  const [destino, setDestino] = useState<string | null>(null);
  const [venue, setVenue] = useState('');
  const [premio, setPremio] = useState('');
  const [periodo, setPeriodo] = useState('weekly');
  const [nota, setNota] = useState('');

  const cargar = () => getJson<{ programs: FarmingProgram[] }>('/api/farming')
    .then((d) => { setProgramas(d.programs); setError(null); })
    .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => { void cargar(); }, []);

  async function anadir() {
    try {
      await writeJson('POST', '/api/farming/programs', {
        venue, pointsPerEpoch: leerCantidad(premio), epochLabel: periodo, note: nota,
      });
      setVenue(''); setPremio(''); setNota('');
      await cargar();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function quitar(id: string) {
    try {
      await writeJson('DELETE', `/api/farming/programs/${encodeURIComponent(id)}`);
      await cargar();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Suelta `id` en el sitio de `sobre`. El orden se pinta al momento y luego
   * se guarda; si el guardado falla se recarga el de la base, para no dejar
   * en pantalla un orden que no existe.
   */
  async function soltar(id: string, sobre: string) {
    if (programas === null || id === sobre) return;
    const ids = programas.map((p) => p.id).filter((x) => x !== id);
    ids.splice(ids.indexOf(sobre), 0, id);
    const porId = new Map(programas.map((p) => [p.id, p]));
    setProgramas(ids.flatMap((x) => porId.get(x) ?? []));
    try {
      const r = await writeJson<{ programs: FarmingProgram[] }>('PUT', '/api/farming/order', { ids });
      setProgramas(r.programs);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      await cargar();
    }
  }

  return (
    <section className="bloque">
      <header className="bloque-cabecera">
        <h2>Farming board</h2>
        <span className="none">drag to set priority</span>
      </header>

      <div className="controls">
        <label>
          <span className="label">Venue</span>
          <input value={venue} placeholder="Variational" onChange={(e) => setVenue(e.target.value)} />
        </label>
        <label>
          <span className="label">Points</span>
          <input value={premio} placeholder="150k" onChange={(e) => setPremio(e.target.value)} />
        </label>
        <label>
          <span className="label">Period</span>
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
            {PERIODOS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="grow">
          <span className="label">Note</span>
          <input value={nota} placeholder="min 50k volume" maxLength={120} onChange={(e) => setNota(e.target.value)} />
        </label>
        <div className="control-group">
          <span className="label">&nbsp;</span>
          <button type="button" disabled={venue.trim() === ''} onClick={() => void anadir()}>Add</button>
        </div>
      </div>

      {error !== null && <p className="light light-red">{error}</p>}

      {programas === null ? (
        <p className="none">Loading…</p>
      ) : programas.length === 0 ? (
        <p className="none">Nothing on the board yet.</p>
      ) : (
        <div className="tablero">
          {programas.map((p, i) => (
            <div
              key={p.id}
              className={`tarjeta${arrastrado === p.id ? ' arrastrando' : ''}${destino === p.id && arrastrado !== p.id ? ' destino' : ''}`}
              draggable
              onDragStart={(e) => { setArrastrado(p.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { setArrastrado(null); setDestino(null); }}
              onDragOver={(e) => { e.preventDefault(); setDestino(p.id); }}
              onDrop={(e) => {
                e.preventDefault();
                if (arrastrado !== null) void soltar(arrastrado, p.id);
                setArrastrado(null); setDestino(null);
              }}
            >
              <button type="button" className="tarjeta-quitar" title="Remove" onClick={() => void quitar(p.id)}>×</button>
              <span className="tarjeta-rango">#{i + 1}</span>
              <span className="tarjeta-venue">{p.venue}</span>
              <span className="tarjeta-premio">
                {p.pointsPerEpoch === null ? '—' : `${cantidad(p.pointsPerEpoch)} pts`} · {p.epochLabel}
              </span>
              {p.note !== null && <span className="tarjeta-nota">{p.note}</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function Points({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<PointsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    getJson<PointsResponse>('/api/points')
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [refreshKey]);

  return (
    <div className="bloques">
      <Tablero />

      <section className="bloque">
        <header className="bloque-cabecera">
          <h2>Live campaigns</h2>
          <span className="none">read from the venue API</span>
        </header>
        {error !== null ? (
          <p className="light light-red">Could not load campaigns: {error}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th className="num">Ends</th>
                  <th className="num">Prize pool</th>
                  <th className="num">Min volume</th>
                  <th>Page</th>
                </tr>
              </thead>
              <tbody>
                {data === null ? (
                  <tr><td colSpan={7} className="none">Loading…</td></tr>
                ) : data.campaigns.rows.length === 0 ? (
                  <tr><td colSpan={7} className="none">
                    {data.campaigns.available ? 'No live or recent campaign.' : 'Campaign source not answering.'}
                  </td></tr>
                ) : data.campaigns.rows.map((c) => {
                  const e = ESTADO_CAMPANA[c.status] ?? ESTADO_CAMPANA['ended'];
                  return (
                    <tr key={c.id}>
                      <td className="asset">{c.venue}</td>
                      <td>
                        {c.name}
                        {c.kind === 'points' && c.pointsPerEpoch !== null && (
                          <span className="none"> · {cantidad(c.pointsPerEpoch)} pts every {c.epochDays ?? '—'}d</span>
                        )}
                      </td>
                      <td><span className={e?.clase}>{e?.texto}</span></td>
                      <td className="num">
                        {c.endsAt === null ? <span className="none">—</span> : <>{fecha(c.endsAt)} <span className="none">{relativo(c.endsAt)}</span></>}
                      </td>
                      <td className="num">{usd(c.poolUsd)}</td>
                      <td className="num">{usd(c.minVolumeUsd)}</td>
                      <td><a href={c.url} target="_blank" rel="noreferrer">Open ↗</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bloque">
        <header className="bloque-cabecera">
          <h2>Points APIs</h2>
          <span className="none">checked by hand</span>
        </header>
        {data !== null && data.stale.length > 0 && (
          <div className="degraded-note">{data.stale.length} unverified for over {data.staleAfterDays} days</div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Venue</th>
                <th>Points API</th>
                <th>Observed response</th>
                <th className="num">Last checked</th>
                <th>Official page</th>
              </tr>
            </thead>
            <tbody>
              {(data?.programs ?? []).map((p) => {
                const estado = ESTADO[p.apiStatus] ?? ESTADO['none'];
                const caducado = data !== null && p.daysSinceCheck !== null && p.daysSinceCheck > data.staleAfterDays;
                return (
                  <tr key={p.venueId}>
                    <td className="asset">{p.venue}</td>
                    <td><span className={estado?.clase}>{estado?.texto}</span></td>
                    <td className="none">{p.apiNote ?? '—'}</td>
                    <td className="num">
                      {p.daysSinceCheck === null ? <span className="none">—</span> : (
                        <span className={caducado ? 'warn-text' : 'none'}>
                          {p.daysSinceCheck === 0 ? 'today' : `${p.daysSinceCheck}d ago`}
                        </span>
                      )}
                    </td>
                    <td><a href={p.url} target="_blank" rel="noreferrer">Open ↗</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
