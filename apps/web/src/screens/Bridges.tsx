import { useEffect, useState } from 'react';
import { getJson, fmt, type BridgesResponse, usd } from '../api.ts';
import { Selector, CADENAS_PRIORITARIAS } from '../components/Selector.tsx';

/**
 * Bridges.
 *
 * Tres fuentes y cada una dice una cosa distinta:
 *
 * - **LI.FI** (el motor de Jumper) y **deBridge** dicen que rutas existen: son
 *   quienes las enrutan. Con ellas aparecen Relay, Across o CCTP, que DefiLlama
 *   no podia ensenar porque no tienen liquidez en las dos redes.
 * - **DefiLlama** da la liquidez (TVL) de cada puente y, aparte, el volumen de
 *   los agregadores.
 *
 * Tiempos y comisiones no se muestran: dependen del importe y del momento, y
 * una cifra fija se leia como dato vivo.
 */

const TIPO: Record<string, string> = {
  native: 'Native',
  bridge: 'Bridge',
  aggregator: 'Aggregator',
};

const VIA: Record<string, string> = {
  lifi: 'LI.FI',
  debridge: 'deBridge',
  liquidity: 'TVL on both',
};

function cambio(v: number | null) {
  if (v === null) return <span className="none">—</span>;
  return <span className={v >= 0 ? 'pos' : 'neg'}>{v >= 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

export function Bridges({ refreshKey }: { refreshKey: number }) {
  const [from, setFrom] = useState('Ethereum');
  const [to, setTo] = useState('Arbitrum');
  const [data, setData] = useState<BridgesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const p = new URLSearchParams({ from, to, limit: '40' });
    getJson<BridgesResponse>(`/api/bridges?${p}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [from, to, refreshKey]);

  if (error !== null) return <p className="light light-red">Could not load bridges: {error}</p>;

  if (data !== null && !data.available) {
    return (
      <div className="degraded-note">
        Bridges source not answering: {data.reason}
      </div>
    );
  }

  const cadenas = data?.chains ?? [];
  const rutas = data?.routes ?? [];
  const agregadores = data?.aggregators;

  return (
    <>
      <div className="controls">
        {/* Los favoritos se comparten entre origen y destino a proposito: las
            cadenas que usas son las mismas vayas o vengas. */}
        <Selector modo="uno" label="From" claveFavoritos="bridges.fav.chains"
          prioridad={CADENAS_PRIORITARIAS} valor={from} onElegir={setFrom}
          opciones={cadenas.map((c) => ({ id: c, label: c }))} />
        <div className="control-group">
          <span className="label">&nbsp;</span>
          <button className="seg" onClick={() => { setFrom(to); setTo(from); }}>⇄ Swap</button>
        </div>
        <Selector modo="uno" label="To" claveFavoritos="bridges.fav.chains"
          prioridad={CADENAS_PRIORITARIAS} valor={to} onElegir={setTo}
          opciones={cadenas.map((c) => ({ id: c, label: c }))} />
        <div className="control-group">
          <span className="label">Routes found</span>
          <div className="stat-inline">{data === null ? '—' : rutas.length}</div>
        </div>
      </div>

      {/* Lo que sigue sin poder salir: un puente sin liquidez que ninguna de
          las dos fuentes de rutas cubre (hoy USDT0). Una sola linea. */}
      {(data?.alwaysConsider ?? []).length > 0 && (
        <div className="degraded-note">
          <span>
            Not ranked here:{' '}
            {(data?.alwaysConsider ?? []).map((x, i) => (
              <span key={x.name}>
                {i > 0 && ', '}
                <a href={x.url} target="_blank" rel="noreferrer" title={x.reason}>{x.name}</a>
              </span>
            ))}
          </span>
        </div>
      )}

      {data?.stale === true && (
        <div className="degraded-note">Liquidity from {fmt.ago(data.asOf ?? null)}</div>
      )}

      {from === to ? (
        <p className="none">Pick two different networks.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Bridge</th>
                <th>Type</th>
                <th className="num">Liquidity (TVL)</th>
                <th>Route confirmed by</th>
                <th className="num">Networks</th>
              </tr>
            </thead>
            <tbody>
              {data === null ? (
                <tr><td colSpan={5} className="none">Loading…</td></tr>
              ) : rutas.length === 0 ? (
                <tr><td colSpan={5} className="none">No known route from {from} to {to}.</td></tr>
              ) : (
                rutas.map((r) => (
                  <tr key={r.id}>
                    <td className="asset" title={r.description ?? undefined}>
                      {r.url === null ? r.name : <a href={r.url} target="_blank" rel="noreferrer">{r.name}</a>}
                    </td>
                    <td className="none">{TIPO[r.type] ?? r.type}</td>
                    <td className="num">{usd(r.tvlUsd)}</td>
                    <td className={r.via.includes('liquidity') && r.via.length === 1 ? 'none' : ''}>
                      {r.via.map((v) => VIA[v] ?? v).join(' · ')}
                    </td>
                    <td className="num none">{r.networks}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <section className="bloque">
        <header className="bloque-cabecera">
          <h2>Bridge aggregators</h2>
          <span className="none">volume · DefiLlama</span>
        </header>
        {agregadores?.stale === true && (
          <div className="degraded-note">Volume from {fmt.ago(agregadores.asOf)}</div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Aggregator</th>
                <th className="num">24h</th>
                <th className="num">7 days</th>
                <th className="num">30 days</th>
                <th className="num">7d vs prior 7d</th>
              </tr>
            </thead>
            <tbody>
              {agregadores === undefined ? (
                <tr><td colSpan={5} className="none">Loading…</td></tr>
              ) : !agregadores.available ? (
                <tr><td colSpan={5} className="none">DefiLlama aggregators not answering.</td></tr>
              ) : (
                agregadores.rows.map((a) => (
                  <tr key={a.slug}>
                    <td className="asset">
                      <a href={`https://defillama.com/protocol/${encodeURIComponent(a.slug)}`} target="_blank" rel="noreferrer">
                        {a.name}
                      </a>
                    </td>
                    <td className="num">{usd(a.volume24hUsd)}</td>
                    <td className="num">{usd(a.volume7dUsd)}</td>
                    <td className="num">{usd(a.volume30dUsd)}</td>
                    <td className="num">{cambio(a.change7dPct)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
