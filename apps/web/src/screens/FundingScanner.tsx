import { Fragment, useEffect, useMemo, useState } from 'react';
import { getJson, fmt, type FundingProvenance, type Opportunity, type ScannerResponse, type VenueMeta, usd } from '../api.ts';

/**
 * Funding Scanner.
 *
 * La pantalla principal. Lo unico sobre lo que se decide es el APR NETO: el
 * bruto siempre parece mejor de lo que es, porque no ha pagado las cuatro patas
 * de fees ni el coste de cruzar el libro. Por eso el neto manda en el orden y
 * el bruto va al lado, en gris, como referencia.
 *
 * Toda la interfaz en ingles.
 */

/** Que significa cada tipo de tasa. Corto: es una etiqueta, no una explicacion. */
const KIND_LABEL: Record<FundingProvenance['kind'], string> = {
  current: 'current period, can still move',
  predicted: 'next period, not settled',
  settled: 'settled payment',
};

function edad(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * De donde sale el funding de una pata.
 *
 * Se ensena el numero NATIVO y su intervalo ademas del horario, que es lo que
 * permite rehacer la division a mano y comprobar que cuadra con lo que devuelve
 * el venue.
 */
/**
 * La ventana que cubre la tasa nativa, escrita como se lee.
 *
 * Sin esto, Variational imprimia "/ 8760h" (su tasa viene anualizada) y Perpl
 * "/ 0.7166666666666667h". Los dos son el numero correcto y los dos se leen
 * mal.
 */
function ventana(h: number): string {
  if (h >= 8760) return 'year';
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${Number(h.toFixed(2))}h`;
}

function Procedencia({ p, lado, ahora }: { p: FundingProvenance; lado: string; ahora: number }) {
  return (
    <div className="prov-leg">
      <div className="label">{lado} · {p.venue}</div>
      <div className="prov-line"><code>{p.sourceField}</code></div>
      <div className="prov-line none">{KIND_LABEL[p.kind]}</div>
      <div className="prov-line">
        {p.nativeRate.toExponential(4)} / {ventana(p.intervalHours)}
        {' → '}
        <strong>{p.hourlyRate.toExponential(4)}</strong> / h
        {' → '}
        {fmt.pct(p.hourlyRate * 24 * 365 * 100, 2)} APR
      </div>
      <div className="prov-line none">
        received {edad(ahora - p.observedAt)} ago
        {' · '}
        {p.sourceAt === null ? 'no source timestamp' : `stamped ${edad(ahora - p.sourceAt)} ago`}
        {p.nextFundingAt !== null && ` · next payment ${new Date(p.nextFundingAt).toISOString().slice(11, 16)} UTC`}
      </div>
    </div>
  );
}

/** Todo lo que hay detras de una fila, incluidos los supuestos del calculo. */
function Detalle({ op, holdHours }: { op: Opportunity; holdHours: number }) {
  const ahora = Date.now();
  const libros = op.provenance.books;
  const horizonte = holdHours >= 24 ? `${holdHours / 24}d` : `${holdHours}h`;

  return (
    <td colSpan={8} className="prov">
      <div className="prov-grid">
        <Procedencia p={op.provenance.long} lado="Long" ahora={ahora} />
        <Procedencia p={op.provenance.short} lado="Short" ahora={ahora} />
      </div>

      <div className="prov-line">
        <span className="label">Cost</span>{' '}
        {op.feesPct === null ? (
          <span className="light light-yellow">fee unknown, no net APR</span>
        ) : (
          <>
            fees {op.feesPct.toFixed(3)}% (4 fills)
            {op.slippagePct !== null && (
              <> · slippage {op.slippagePct.toFixed(3)}% (${op.notionalPerLegUsd.toLocaleString('en-US')}/leg, open ×2)</>
            )}
          </>
        )}
      </div>

      <div className="prov-line">
        <span className="label">Books</span>{' '}
        {libros === null ? (
          <span className="none">not fetched</span>
        ) : (
          <>
            long {edad(libros.longAgeMs)} · short {edad(libros.shortAgeMs)} ·{' '}
            <span className={libros.skewMs > 30_000 ? 'warn-text' : 'none'}>
              {edad(libros.skewMs)} apart{libros.skewMs > 30_000 && ', not simultaneous'}
            </span>
          </>
        )}
      </div>

      <div className="prov-line">
        <span className="label">Breakeven</span>{' '}
        {op.breakevenHours === null ? (
          <span className="none">not computable</span>
        ) : (
          <>
            {op.breakevenHours.toFixed(1)}h if the spread holds
            {op.amortizesWithinHold === false && (
              <span className="light light-red"> not recovered in {horizonte}</span>
            )}
          </>
        )}
      </div>
    </td>
  );
}

const HOLD_OPTIONS = [
  { days: 0.25, label: '6h' },
  { days: 1, label: '1d' },
  { days: 3, label: '3d' },
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
];

const VOLUME_OPTIONS = [
  { usd: 0, label: 'Any' },
  { usd: 1e6, label: '>$1M' },
  { usd: 10e6, label: '>$10M' },
  { usd: 50e6, label: '>$50M' },
];


function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={tone === undefined ? 'stat-value' : `stat-value ${tone}`}>{value}</div>
    </div>
  );
}

export function FundingScanner({ refreshKey }: { refreshKey: number }) {
  const [notional, setNotional] = useState(10_000);
  const [days, setDays] = useState(7);
  const [feeMode, setFeeMode] = useState<'taker' | 'maker'>('taker');
  const [symbol, setSymbol] = useState('');
  const [minVolume, setMinVolume] = useState(0);
  // Solo una fila abierta a la vez: el detalle es denso y dos a la vez tapan
  // la tabla, que es lo que se estaba mirando.
  const [abierta, setAbierta] = useState<string | null>(null);
  const [venues, setVenues] = useState<readonly string[]>([]);

  const [metas, setMetas] = useState<readonly VenueMeta[]>([]);
  const [data, setData] = useState<ScannerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    getJson<VenueMeta[]>('/api/venues').then(setMetas).catch(() => undefined);
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams({
      notional: String(notional),
      days: String(days),
      feeMode,
      limit: '40',
    });
    if (symbol.trim() !== '') p.set('symbol', symbol.trim());
    if (minVolume > 0) p.set('minVolume', String(minVolume));
    if (venues.length > 0) p.set('venues', venues.join(','));
    return p.toString();
  }, [notional, days, feeMode, symbol, minVolume, venues]);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    getJson<ScannerResponse>(`/api/scanner?${query}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [query, refreshKey]);

  const alternarVenue = (id: string) =>
    setVenues((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));

  if (error !== null) return <p className="light light-red">Could not load opportunities: {error}</p>;

  const stats = data?.stats ?? null;

  return (
    <>
      <div className="stats">
        <Stat label="Live spreads" value={data === null ? '—' : `${data.shown} / ${data.totalUnfiltered}`} />
        <Stat
          label="Best net APR"
          value={fmt.pct(stats?.bestNetAprPct ?? null)}
          tone={(stats?.bestNetAprPct ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <Stat label="Aggregate OI" value={usd(stats?.totalOiUsd ?? null)} />
        <Stat label="Active venues" value={stats === null ? '—' : String(stats.venues)} />
      </div>


      <div className="controls">
        <label>
          <span className="label">Size per leg</span>
          <input
            type="number"
            value={notional}
            min={100}
            step={1000}
            onChange={(e) => setNotional(Math.max(100, Number(e.target.value) || 100))}
          />
        </label>

        <label>
          <span className="label">Fees</span>
          <select value={feeMode} onChange={(e) => setFeeMode(e.target.value === 'maker' ? 'maker' : 'taker')}>
            <option value="taker">Taker (conservative)</option>
            <option value="maker">Maker (optimistic)</option>
          </select>
        </label>

        <div className="control-group">
          <span className="label">Hold for</span>
          <div className="segmented">
            {HOLD_OPTIONS.map((o) => (
              <button
                key={o.days}
                className={o.days === days ? 'seg seg-active' : 'seg'}
                onClick={() => setDays(o.days)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="label">24h volume</span>
          <div className="segmented">
            {VOLUME_OPTIONS.map((o) => (
              <button
                key={o.usd}
                className={o.usd === minVolume ? 'seg seg-active' : 'seg'}
                onClick={() => setMinVolume(o.usd)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <label className="grow">
          <span className="label">Asset</span>
          <input
            type="search"
            value={symbol}
            placeholder="BTC, SOL, PEPE…"
            onChange={(e) => setSymbol(e.target.value)}
          />
        </label>
      </div>

      <div className="controls">
        <div className="control-group grow">
          <span className="label">Venues</span>
          <div className="segmented">
            {metas.map((m) => (
              <button
                key={m.id}
                className={venues.includes(m.id) ? 'seg seg-active' : 'seg'}
                onClick={() => alternarVenue(m.id)}
              >
                {m.label}
              </button>
            ))}
            {venues.length > 0 && (
              <button className="seg seg-clear" onClick={() => setVenues([])}>Clear</button>
            )}
          </div>
        </div>
      </div>

      {data !== null && data.total > data.shown && (
        <p className="section-heading none">Top {data.shown} of {data.total}</p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th>Long (pays)</th>
              <th>Short (earns)</th>
              <th className="num">Gross APR</th>
              <th className="num">Net APR</th>
              <th className="num">Round-trip cost</th>
              <th className="num">Breakeven</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={8} className="none">Loading…</td></tr>
            ) : data.opportunities.length === 0 ? (
              <tr><td colSpan={8} className="none">No pair matches these filters.</td></tr>
            ) : (
              data.opportunities.map((op) => {
                const clave = `${op.symbol}-${op.longVenue}-${op.shortVenue}`;
                return (
                <Fragment key={clave}>
                <tr>
                  <td className="asset">{op.symbol}</td>
                  <td>
                    {op.longVenue}
                    <span className="none leg-rate"> {fmt.pct(op.longFundingHourly * 24 * 365 * 100)}</span>
                  </td>
                  <td>
                    {op.shortVenue}
                    <span className="none leg-rate"> {fmt.pct(op.shortFundingHourly * 24 * 365 * 100)}</span>
                  </td>
                  <td className="num none">{fmt.pct(op.grossAprPct)}</td>
                  <td className="num">
                    {op.insufficientDepth ? (
                      // Una oportunidad que no se puede ejecutar al tamano
                      // pedido no es una oportunidad: se dice, no se estima.
                      <span className="light light-yellow" title="The visible book cannot absorb this size">
                        no depth
                      </span>
                    ) : op.netAprPct === null ? (
                      <span className="none" title="A fee for one of these venues is unknown">—</span>
                    ) : (
                      <strong className={op.netAprPct >= 0 ? 'pos' : 'neg'}>{fmt.pct(op.netAprPct)}</strong>
                    )}
                  </td>
                  <td className="num none">
                    {op.totalCostPct === null ? '—' : `${op.totalCostPct.toFixed(3)}%`}
                  </td>
                  <td className="num none">
                    {op.breakevenHours === null ? '—' : `${op.breakevenHours.toFixed(0)}h`}
                    {/* Que no amortice en el horizonte elegido es una conclusion,
                        no un detalle: se ve sin desplegar nada. */}
                    {op.amortizesWithinHold === false && (
                      <span className="light light-red" title="Does not pay for itself within the chosen horizon"> ✕</span>
                    )}
                  </td>
                  <td className="num">
                    <button
                      className="seg"
                      title="Where these numbers come from"
                      onClick={() => setAbierta(abierta === clave ? null : clave)}
                    >
                      {abierta === clave ? '−' : '?'}
                    </button>
                  </td>
                </tr>
                {abierta === clave && <tr><Detalle op={op} holdHours={days * 24} /></tr>}
                </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {cargando && <p className="none loading-note">Refreshing…</p>}
    </>
  );
}
