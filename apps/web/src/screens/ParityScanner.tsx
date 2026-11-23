import { useEffect, useMemo, useState } from 'react';
import { getJson, usd, type AssetClass } from '../api.ts';
import { Chart, SERIE_COLORS, type Serie } from '../components/Chart.tsx';
import { useTipoVenue, FiltroTipo } from '../components/tipoVenue.tsx';

/**
 * Escaner de paridad y simulador de convergencia.
 *
 * La tabla: para cada activo, donde esta mas barato y donde mas caro ahora,
 * entre todos los venues, con los filtros que la mantienen limpia (ver
 * `parityScan.ts` en la API). El neto descuenta comisiones de abrir y cerrar
 * las dos patas y el spread de las dos; las comisiones son las del usuario si
 * las ha puesto, porque las reales dependen de su nivel.
 *
 * El simulador recorre el LIBRO de las dos patas para el nocional elegido: lo
 * que se captura de verdad a ese tamano, no lo que dice el mid. Y dice cuantas
 * veces en siete dias la diferencia supero el coste, que es lo que decide si
 * merece la pena montarlo.
 */

interface Pata {
  readonly venue: string;
  readonly mid: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly volume24hUsd: number | null;
  readonly fundingHourly: number;
  readonly url: string | null;
  readonly feeBps?: number | null;
}

/** Spread de una pata en bps, o null si solo da mark. */
const spreadBps = (p: Pata) => (p.bid === null || p.ask === null ? null : ((p.ask - p.bid) / ((p.ask + p.bid) / 2)) * 10_000);
const bps = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1));

interface Fila {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly venues: number;
  readonly cheap: Pata;
  readonly rich: Pata;
  readonly gapPct: number;
  readonly feesPct: number | null;
  readonly spreadPct: number | null;
  readonly netAtZeroPct: number | null;
  readonly netIncludesSpread: boolean;
  readonly carryPctPerDay: number;
}

interface Historia {
  readonly samples: number;
  readonly medianPct: number | null;
  readonly p90Pct: number | null;
  readonly maxPct: number | null;
  readonly aboveCostPct: number | null;
  readonly points: readonly { readonly t: number; readonly gapPct: number }[];
}

type PataLibro = { venue: string; available: true; avgPrice: number; slippageBps: number; spreadBps: number }
  | { venue: string; available: false; reason: string };

interface Profundidad {
  readonly cheap: PataLibro;
  readonly rich: PataLibro;
  readonly executableGapPct: number | null;
}

const VOLUMENES = [
  { usd: 0, label: 'Any' },
  { usd: 100_000, label: '>$100K' },
  { usd: 250_000, label: '>$250K' },
  { usd: 1_000_000, label: '>$1M' },
];

const CLASES: readonly { id: AssetClass | null; label: string }[] = [
  { id: null, label: 'All' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'equity', label: 'Equities' },
  { id: 'index', label: 'Indices' },
  { id: 'commodity', label: 'Commodities' },
];

/** Venues que se pueden configurar: los que se leen directos. */
const VENUES_COMISION = [
  'hyperliquid', 'variational', 'aster', 'lighter', 'extended', 'paradex', 'pacifica', 'backpack',
  'dydx', 'orderly', 'perpl', 'qfex', 'phoenix', 'arcus', 'risex', 'entropy',
];

const CLAVE_COMISIONES = 'parity.fees';

/** Las comisiones taker del usuario, en bps, guardadas en el navegador. */
function leerComisiones(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(CLAVE_COMISIONES) ?? '{}') as unknown;
    return typeof v === 'object' && v !== null ? v as Record<string, string> : {};
  } catch {
    return {};
  }
}

const pct = (v: number | null, d = 3) => (v === null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}%`);
const precio = (v: number) => (v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
const clave = (f: Fila) => `${f.symbol}|${f.assetClass}`;

/** Nombre del venue con enlace a su web oficial, si hay una comprobada. */
function Venue({ p }: { p: Pata }) {
  return p.url === null
    ? <>{p.venue}</>
    : <a href={p.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{p.venue} ↗</a>;
}

function Simulador({ fila }: { fila: Fila }) {
  const [nocional, setNocional] = useState('10000');
  const [objetivo, setObjetivo] = useState<'zero' | 'median'>('median');
  const [dias, setDias] = useState('1');
  const [hist, setHist] = useState<Historia | null>(null);
  const [libro, setLibro] = useState<Profundidad | null>(null);

  const n = Number(nocional);
  // Coste de ida y vuelta conocido: comisiones mas spread de las dos patas.
  const coste = fila.feesPct === null ? null : fila.feesPct + (fila.spreadPct ?? 0);

  useEffect(() => {
    let vivo = true;
    setHist(null);
    const p = new URLSearchParams({ symbol: fila.symbol, cheap: fila.cheap.venue, rich: fila.rich.venue, days: '7' });
    if (coste !== null) p.set('cost', String(coste));
    getJson<Historia>(`/api/parity/pair?${p}`).then((d) => { if (vivo) setHist(d); }).catch(() => undefined);
    return () => { vivo = false; };
  }, [fila.symbol, fila.cheap.venue, fila.rich.venue, coste]);

  useEffect(() => {
    if (!Number.isFinite(n) || n < 100) return undefined;
    let vivo = true;
    setLibro(null);
    const p = new URLSearchParams({ symbol: fila.symbol, cheap: fila.cheap.venue, rich: fila.rich.venue, notional: String(n) });
    // Un poco de espera: no pedir dos libros por cada tecla del nocional.
    const t = setTimeout(() => {
      getJson<Profundidad>(`/api/parity/depth?${p}`).then((d) => { if (vivo) setLibro(d); }).catch(() => undefined);
    }, 400);
    return () => { vivo = false; clearTimeout(t); };
  }, [fila.symbol, fila.cheap.venue, fila.rich.venue, n]);

  const d = Number(dias);
  const meta = objetivo === 'zero' ? 0 : hist?.medianPct ?? null;
  // La diferencia de partida es la ejecutable si hay libro de las dos patas;
  // si no, la del mid menos el spread conocido.
  const partida = libro?.executableGapPct ?? null;
  const bruto = Number.isFinite(n) && meta !== null ? (n * ((partida ?? fila.gapPct) - meta)) / 100 : null;
  const comisiones = Number.isFinite(n) && fila.feesPct !== null ? (n * fila.feesPct) / 100 : null;
  // Con libro, el spread de entrada ya esta en la partida y queda el de salida
  // (la mitad); sin libro, el spread entero de las dos patas si se conoce.
  const spreadUsd = !Number.isFinite(n) || fila.spreadPct === null ? null
    : (n * fila.spreadPct * (partida !== null ? 0.5 : 1)) / 100;
  const funding = Number.isFinite(n) && Number.isFinite(d) ? (n * fila.carryPctPerDay * d) / 100 : null;
  const neto = bruto === null || comisiones === null || funding === null ? null : bruto - comisiones - (spreadUsd ?? 0) + funding;

  const serie = useMemo((): Serie[] => [{
    id: 'gap', label: `${fila.rich.venue} over ${fila.cheap.venue}`, color: SERIE_COLORS[0] ?? '#4c9af8',
    points: (hist?.points ?? []).map((p) => ({ time: Math.floor(p.t / 1000), value: p.gapPct })),
  }], [hist, fila.rich.venue, fila.cheap.venue]);
  const fmtPct = useMemo(() => (v: number) => `${v.toFixed(3)}%`, []);
  const motivo = (p: PataLibro) => (p.available ? null : `${p.venue}: ${p.reason}`);

  return (
    <section className="bloque">
      <header className="bloque-cabecera">
        <h2>{fila.symbol}: long <Venue p={fila.cheap} />, short <Venue p={fila.rich} /></h2>
        <span className="estimated">est.</span>
      </header>

      <div className="controls">
        <label>
          <span className="label">Notional per leg</span>
          <input value={nocional} inputMode="decimal" onChange={(e) => setNocional(e.target.value)} />
        </label>
        <div className="control-group">
          <span className="label">Gap returns to</span>
          <div className="segmented">
            <button className={objetivo === 'median' ? 'seg seg-active' : 'seg'} onClick={() => setObjetivo('median')}>7d median</button>
            <button className={objetivo === 'zero' ? 'seg seg-active' : 'seg'} onClick={() => setObjetivo('zero')}>Zero</button>
          </div>
        </div>
        <label>
          <span className="label">Days held</span>
          <input value={dias} inputMode="decimal" onChange={(e) => setDias(e.target.value)} />
        </label>
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Gap at mid</div><div className="stat-value">{pct(fila.gapPct)}</div></div>
        <div className="stat">
          <div className="label">Executable at size</div>
          <div className="stat-value" title={libro === null ? undefined : [motivo(libro.cheap), motivo(libro.rich)].filter(Boolean).join(' · ')}>
            {libro === null ? '…' : pct(libro.executableGapPct)}
          </div>
        </div>
        <div className="stat"><div className="label">7d median</div><div className="stat-value">{hist === null ? '…' : pct(hist.medianPct)}</div></div>
        <div className="stat"><div className="label">7d max</div><div className="stat-value">{hist === null ? '…' : pct(hist.maxPct)}</div></div>
        <div className="stat">
          <div className="label">Above costs, 7d</div>
          <div className="stat-value">{hist === null ? '…' : hist.aboveCostPct === null ? '—' : `${hist.aboveCostPct.toFixed(0)}% of time`}</div>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Gross</div><div className="stat-value">{usd(bruto)}</div></div>
        <div className="stat"><div className="label">Fees</div><div className="stat-value">{comisiones === null ? '—' : `-${usd(comisiones)}`}</div></div>
        <div className="stat"><div className="label">Spread</div><div className="stat-value">{spreadUsd === null ? '—' : `-${usd(spreadUsd)}`}</div></div>
        <div className="stat"><div className="label">Funding</div><div className="stat-value">{usd(funding)}</div></div>
        <div className="stat">
          <div className="label">Net</div>
          <div className="stat-value">
            {neto === null ? '—' : <strong className={neto >= 0 ? 'pos' : 'neg'}>{usd(neto)}</strong>}
          </div>
        </div>
      </div>

      {hist !== null && hist.samples > 0 && (
        <div className="chart-wrap">
          <Chart series={serie} height={200} formatValue={fmtPct} baseline={coste ?? undefined} />
        </div>
      )}
      {hist !== null && hist.samples === 0 && <p className="none">No shared history for these two venues yet.</p>}
    </section>
  );
}

/** Las comisiones del usuario, venue a venue. */
function MisComisiones({ valores, onCambiar }: { valores: Record<string, string>; onCambiar: (v: Record<string, string>) => void }) {
  return (
    <section className="bloque">
      <header className="bloque-cabecera">
        <h2>My taker fees</h2>
        <span className="none">bps, blank uses the published fee</span>
      </header>
      <div className="comisiones-rejilla">
        {VENUES_COMISION.map((v) => (
          <label key={v} className="control-group">
            <span className="label">{v}</span>
            <input value={valores[v] ?? ''} inputMode="decimal" placeholder="—"
              onChange={(e) => onCambiar({ ...valores, [v]: e.target.value })} />
          </label>
        ))}
      </div>
    </section>
  );
}

export function ParityScanner({ refreshKey }: { refreshKey: number }) {
  const [minVol, setMinVol] = useState(250_000);
  const [clase, setClase] = useState<AssetClass | null>(null);
  const [q, setQ] = useState('');
  const [orden, setOrden] = useState<'net' | 'gap'>('net');
  const [tipo, setTipo] = useTipoVenue();
  const [comisiones, setComisiones] = useState<Record<string, string>>(leerComisiones);
  const [verComisiones, setVerComisiones] = useState(false);
  const [data, setData] = useState<{ total: number; rows: Fila[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elegida, setElegida] = useState<string | null>(null);

  function guardarComisiones(v: Record<string, string>) {
    setComisiones(v);
    try { localStorage.setItem(CLAVE_COMISIONES, JSON.stringify(v)); } catch { /* preferencia */ }
  }

  // Solo las que son un numero valido viajan al servidor.
  const parametroComisiones = Object.entries(comisiones)
    .filter(([, bps]) => bps.trim() !== '' && Number.isFinite(Number(bps)))
    .map(([v, bps]) => `${v}:${Number(bps)}`)
    .join(',');

  useEffect(() => {
    let vivo = true;
    const p = new URLSearchParams({ minVolume: String(minVol), limit: '60', sort: orden, venueKind: tipo });
    if (clase !== null) p.set('class', clase);
    if (q.trim() !== '') p.set('q', q.trim());
    if (parametroComisiones !== '') p.set('fees', parametroComisiones);
    getJson<{ total: number; rows: Fila[] }>(`/api/parity/scan?${p}`)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [minVol, clase, q, orden, tipo, parametroComisiones, refreshKey]);

  const fila = data?.rows.find((f) => clave(f) === elegida) ?? null;

  if (error !== null) return <p className="light light-red">Could not load the scanner: {error}</p>;

  return (
    <>
      <div className="controls">
        <label>
          <span className="label">Asset</span>
          <input type="search" value={q} placeholder="BTC, NVDA…" onChange={(e) => setQ(e.target.value.toUpperCase())} />
        </label>
        <FiltroTipo tipo={tipo} onCambiar={setTipo} enControles />
        <div className="control-group">
          <span className="label">Class</span>
          <div className="segmented">
            {CLASES.map((c) => (
              <button key={c.label} className={c.id === clase ? 'seg seg-active' : 'seg'} onClick={() => setClase(c.id)}>{c.label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="label">Min volume per leg</span>
          <div className="segmented">
            {VOLUMENES.map((v) => (
              <button key={v.usd} className={v.usd === minVol ? 'seg seg-active' : 'seg'} onClick={() => setMinVol(v.usd)}>{v.label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="label">Sort by</span>
          <div className="segmented">
            <button className={orden === 'net' ? 'seg seg-active' : 'seg'} onClick={() => setOrden('net')}>Net after costs</button>
            <button className={orden === 'gap' ? 'seg seg-active' : 'seg'} onClick={() => setOrden('gap')}>Gross gap</button>
          </div>
        </div>
        <div className="control-group">
          <span className="label">Fees</span>
          <button className={verComisiones ? 'seg seg-active' : 'seg'} onClick={() => setVerComisiones((v) => !v)}>My fees</button>
        </div>
      </div>

      {verComisiones && <MisComisiones valores={comisiones} onCambiar={guardarComisiones} />}
      {fila !== null && <Simulador fila={fila} />}

      {/* Cada pata es un bloque: donde, a que precio y lo que cuesta alli
          (comision taker y spread, en bps). Comprar en verde y vender en rojo,
          como los largos y cortos del resto de la app. */}
      <div className="table-wrap parity-tabla">
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>Asset</th>
              <th colSpan={3} className="pack-buy">Buy on</th>
              <th colSpan={3} className="pack-sell">Sell on</th>
              <th rowSpan={2} className="num col-resultado col-gap">Gap</th>
              <th rowSpan={2} className="num col-resultado">Net <span className="estimated">est.</span></th>
              <th rowSpan={2} className="num col-resultado">Funding / day</th>
            </tr>
            <tr>
              <th className="pack-buy">Venue</th>
              <th className="num pack-buy">Ask</th>
              <th className="num pack-buy" title="Taker fee / spread, in bps">Fee / spread</th>
              <th className="pack-sell">Venue</th>
              <th className="num pack-sell">Bid</th>
              <th className="num pack-sell" title="Taker fee / spread, in bps">Fee / spread</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={10} className="none">Loading…</td></tr>
            ) : data.rows.length === 0 ? (
              <tr><td colSpan={10} className="none">No asset trades on two venues with these filters.</td></tr>
            ) : data.rows.map((f) => (
              <tr key={clave(f)} className={clave(f) === elegida ? 'clickable fila-elegida' : 'clickable'}
                onClick={() => setElegida((e) => (e === clave(f) ? null : clave(f)))}>
                <td className="asset">{f.symbol}</td>
                <td className="pack-buy"><Venue p={f.cheap} /></td>
                {/* Se compra al ask si el venue lo publica; si no, al mark. */}
                <td className="num pack-buy" title={f.cheap.ask === null ? 'mark price, no live quote' : 'ask'}>
                  {precio(f.cheap.ask ?? f.cheap.mid)}{f.cheap.ask === null && ' *'}
                </td>
                <td className="num pack-buy pack-costes">{bps(f.cheap.feeBps)} / {bps(spreadBps(f.cheap))}</td>
                <td className="pack-sell"><Venue p={f.rich} /></td>
                <td className="num pack-sell" title={f.rich.bid === null ? 'mark price, no live quote' : 'bid'}>
                  {precio(f.rich.bid ?? f.rich.mid)}{f.rich.bid === null && ' *'}
                </td>
                <td className="num pack-sell pack-costes">{bps(f.rich.feeBps)} / {bps(spreadBps(f.rich))}</td>
                <td className="num col-resultado col-gap"><strong>{pct(f.gapPct)}</strong></td>
                <td className="num col-resultado" title={f.netIncludesSpread ? 'After fees and spread' : 'After fees; spread not included, a leg has no live quote'}>
                  {f.netAtZeroPct === null ? <span className="none">—</span>
                    : <span className={f.netAtZeroPct >= 0 ? 'pos' : 'neg'}>{pct(f.netAtZeroPct)}{!f.netIncludesSpread && ' *'}</span>}
                </td>
                <td className="num col-resultado">
                  <span className={f.carryPctPerDay >= 0 ? 'pos' : 'neg'}>{pct(f.carryPctPerDay)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="none parity-nota">* mark price, no live quote on that venue: spread not counted</p>
    </>
  );
}
