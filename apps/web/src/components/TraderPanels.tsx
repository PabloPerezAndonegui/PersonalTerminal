import { traderConsensus } from './traderConsensus.ts';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { fmt, type TrackedTrader } from '../api.ts';
import { useTraders } from './tradersState.tsx';

/** Paneles de presentacion reutilizables en Traders y, despues, en Terminal.
 * No mantienen listas propias de traders ni abren conexiones. El futuro
 * estado de seguimiento sera compartido y persistido mediante la API.
 */
export const TRADER_PANELS = [
  { id: 'following', label: 'Following' },
  { id: 'assets', label: 'Assets' },
  { id: 'positions', label: 'Positions' },
  { id: 'consensus', label: 'Consensus' },
  { id: 'tape', label: 'Changes' },
  // Discover (ranking de wallets) y Trader profile (historico por wallet)
  // quedan fuera hasta tener fuente: eran maquetas con botones desactivados
  // y "Not connected", que en una herramienta de consulta se leen como rotas.
  { id: 'alerts', label: 'Alerts' },
] as const;
export type TraderPanelId = typeof TRADER_PANELS[number]['id'];

function Panel({ title, children, wide = false, status }: {
  title: string;
  children: ReactNode;
  wide?: boolean;
  /** Estado real del panel. Sin el se declara no conectado, como antes. */
  status?: ReactNode;
}) {
  const id = useId();
  return <section className={wide ? "trader-panel trader-panel-wide" : "trader-panel"} aria-labelledby={id}>
    <header className="trader-panel-heading">
      <h2 id={id}>{title}</h2>
      {status ?? <span className="light light-yellow">Not connected</span>}
    </header>
    {children}
  </section>;
}

/**
 * El mercado como lo ensena Hyperliquid: el activo y, si es un perp HIP-3, su
 * dex al lado (`xyz:NVDA` es NVDA con la etiqueta xyz). Sin la etiqueta, el
 * NVDA de xyz y el de otro dex se leian igual.
 */
export function NombreMercado({ symbol, native }: { symbol: string; native: string }) {
  const dex = /^([a-z0-9]+):/i.exec(native)?.[1];
  return <>{symbol}{dex !== undefined && <span className="hl-etiqueta" title={native}>{dex}</span>}</>;
}

/** Un unico espacio de contenido, sin tablas ni recuadros anidados. */
function EmptyContent({ message }: { message: string }) {
  return <div className="trader-empty">{message}</div>;
}

/** Controles no operativos declarados como tales hasta conectar el servicio. */
function PendingAction({ children }: { children: ReactNode }) {
  return <button type="button" disabled title="Available when trader tracking is connected">{children}</button>;
}

/** Como se lee cada estado. El color solo acompana, nunca va solo. */
const ESTADO: Record<TrackedTrader['status'], { texto: string; clase: string }> = {
  ok: { texto: 'Live', clase: 'light light-green' },
  waiting: { texto: 'No data yet', clase: 'light light-yellow' },
  stale: { texto: 'Stale', clase: 'light light-yellow' },
  failing: { texto: 'Failing', clase: 'light light-red' },
  paused: { texto: 'Paused', clase: 'none' },
};

const usd = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
};

/** Alta de un trader. Solo direcciones publicas: la API rechaza lo demas. */
function AddTrader() {
  const { add } = useTraders();
  const [address, setAddress] = useState('');
  const [alias, setAlias] = useState('');
  const [group, setGroup] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar() {
    setEnviando(true);
    try {
      await add({ address, ...(alias.trim() !== '' ? { alias } : {}), ...(group.trim() !== '' ? { group } : {}) });
      setAddress(''); setAlias(''); setGroup(''); setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnviando(false);
    }
  }

  return <>
    <div className="controls">
      <label className="grow">
        <span className="label">Public address</span>
        <input value={address} placeholder="0x…" onChange={(e) => setAddress(e.target.value)} />
      </label>
      <label><span className="label">Alias</span>
        <input value={alias} onChange={(e) => setAlias(e.target.value)} /></label>
      <label><span className="label">Group</span>
        <input value={group} onChange={(e) => setGroup(e.target.value)} /></label>
      <div className="control-group"><span className="label">&nbsp;</span>
        <button type="button" disabled={enviando || address.trim() === ''} onClick={() => void enviar()}>
          Follow
        </button></div>
    </div>
    {error !== null && <p className="light light-red">{error}</p>}
  </>;
}

export function TraderPanel({ panel }: { panel: TraderPanelId }) {
  switch (panel) {
    case 'following': return <FollowingPanel />;
    case 'positions': return <PositionsPanel />;
    case 'assets': return <AssetPanel />;
    case 'consensus': return <ConsensusPanel />;
    case 'tape': return <ChangesPanel />;
    case 'alerts': return <AlertsPanel />;
  }
}

/** Como se lee cada tipo de cambio, y de que lado esta. */
const CAMBIO: Record<string, { texto: string; clase: string }> = {
  opened: { texto: 'OPENED', clase: 'pos' },
  increased: { texto: 'INCREASED', clase: 'pos' },
  reduced: { texto: 'REDUCED', clase: 'neg' },
  closed: { texto: 'CLOSED', clase: 'neg' },
  flipped: { texto: 'FLIPPED', clase: 'none' },
};

/**
 * Lo que ha cambiado en las posiciones seguidas.
 *
 * **No son ejecuciones.** Salen de comparar dos lecturas separadas por el
 * intervalo de sondeo, asi que dicen como ha quedado la cuenta, no que ordenes
 * se han mandado: quien abre y cierra dentro del mismo minuto no aparece aqui.
 * Las ejecuciones de verdad estan en `userFills` y son otra fase. Se dice en
 * el panel para que nadie lea esto como un registro de operaciones.
 */
function ChangesPanel() {
  const { alerts, data, asset, traderId, group } = useTraders();
  const traders = data?.traders ?? [];
  const nombre = (id: string) => {
    const t = traders.find((x) => x.id === id);
    return t === undefined ? id.slice(0, 16) : t.alias ?? t.address.slice(0, 10);
  };

  const eventos = (alerts?.events ?? []).filter((e) => {
    if (asset !== '' && e.symbol !== asset) return false;
    if (traderId !== '' && e.traderId !== traderId) return false;
    if (group !== '' && traders.find((t) => t.id === e.traderId)?.group !== group) return false;
    return true;
  });

  return <Panel
    title="Position changes"
    wide
    status={alerts?.available === false
      ? <span className="light light-yellow">Not running</span>
      : <span className="none">{eventos.length} shown</span>}
  >
    <div className="degraded-note">From polling, not executions</div>
    {eventos.length === 0 && <EmptyContent message="No change recorded yet." />}
    {eventos.length > 0 && <div className="trader-scroll">
      {eventos.map((e) => (
        <div key={e.id} className="trader-row trader-pos">
          <span className="none">{fmt.ago(e.at)}</span>
          <span className="trader-name">{nombre(e.traderId)}</span>
          <span className={CAMBIO[e.kind]?.clase ?? 'none'}>{CAMBIO[e.kind]?.texto ?? e.kind}</span>
          <span className="asset">{e.symbol}</span>
          <span className={e.side === 'long' ? 'pos' : 'neg'}>{e.side.toUpperCase()}</span>
          <span className="num">{usd(e.deltaUsd)}</span>
          <span className="num none">
            {e.kind === 'opened' || e.kind === 'closed' ? '—' : `now ${usd(e.notionalUsd)}`}
          </span>
          {e.notifiedAt === null && <span className="none">not sent</span>}
        </div>
      ))}
    </div>}
  </Panel>;
}

/**
 * El bot de Telegram.
 *
 * Es un bot PROPIO y solo manda texto. El token y el chat viven en el `.env`
 * real, fuera del repo, y no llegan hasta aqui: lo unico que viaja es si esta
 * configurado y como fue el ultimo envio.
 */
function AlertsPanel() {
  const { alerts, testTelegram } = useTraders();
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const t = alerts?.telegram;

  async function probar() {
    setEnviando(true);
    try { await testTelegram(); setError(null); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setEnviando(false); }
  }

  const estado = t === undefined || !t.configured
    ? <span className="light light-yellow">Not connected</span>
    : t.dryRun
      ? <span className="light light-yellow">Dry run</span>
      : t.failed > 0 && t.lastError !== null
        ? <span className="light light-red">Last send failed</span>
        : <span className="light light-green">Connected</span>;

  return <Panel title="Telegram alerts" status={estado}>
    <div className="controls">
      <button type="button" disabled={t === undefined || !t.configured || enviando} onClick={() => void probar()}>
        Send test message
      </button>
    </div>

    {t !== undefined && !t.configured && (
      <EmptyContent message="Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to receive alerts." />
    )}

    {t !== undefined && t.configured && <>
      <div className="trader-row">
        <span className="label">Chat</span>
        <span className="none">{t.group ? 'Group' : 'Private'}</span>
        <span className="label">Sent</span><span className="num">{t.sent}</span>
        <span className="label">Failed</span>
        <span className={t.failed > 0 ? 'num neg' : 'num none'}>{t.failed}</span>
        <span className="label">Queued</span><span className="num none">{t.queued}</span>
      </div>
      <div className="trader-row">
        <span className="label">Last sent</span>
        <span className="none">{t.lastOkAt === null ? 'never' : fmt.ago(t.lastOkAt)}</span>
        <span className="label">Min size</span>
        <span className="num none">
          {alerts?.minNotionalUsd === undefined ? '—' : usd(alerts.minNotionalUsd)}
        </span>
      </div>
      {t.lastError !== null && <div className="degraded-note">{t.lastError}</div>}
    </>}

    {alerts?.unsent !== undefined && alerts.unsent > 0 && (
      <div className="degraded-note">
        {alerts.unsent} {alerts.unsent === 1 ? 'change' : 'changes'} detected with no bot connected
      </div>
    )}
    {error !== null && <p className="light light-red">{error}</p>}
  </Panel>;
}

/**
 * Lista de traders seguidos.
 *
 * Una fila por trader, sin tabla ni recuadro dentro del recuadro: es la
 * preferencia registrada en DESIGN.md para estos paneles.
 */
/**
 * Los filtros de UNA wallet: que pares interesan de ella y a partir de que
 * tamano, medido como parte de SU cuenta.
 *
 * No todas las wallets interesan por lo mismo. De una se quiere saber solo lo
 * que hace en SOL; de otra, solo las operaciones en las que se juega algo. El
 * minimo va en porcentaje de su cuenta y no en dolares a proposito: diez mil
 * dolares son una apuesta seria para una cuenta de cien mil y ruido para una
 * de cincuenta millones.
 *
 * Los filtros se aplican al LEER (graficos, tabla y avisos), no al guardar:
 * las ejecuciones se guardan todas, asi que cambiar un filtro no pierde nada
 * y lo que antes quedaba fuera vuelve a verse.
 */
function FiltrosWallet({ trader, onGuardar }: {
  trader: TrackedTrader;
  onGuardar: (cambios: { symbols: string[] | null; minAccountPct: number | null }) => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [pares, setPares] = useState((trader.symbols ?? []).join(', '));
  const [minimo, setMinimo] = useState(trader.minAccountPct === null ? '' : String(trader.minAccountPct));
  const [fallo, setFallo] = useState<string | null>(null);

  const resumen = [
    trader.symbols === null ? 'all pairs' : trader.symbols.join(', '),
    trader.minAccountPct === null ? null : `≥ ${trader.minAccountPct}% of account`,
  ].filter((x) => x !== null).join(' · ');

  async function guardar() {
    const lista = pares.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter((x) => x !== '');
    const n = minimo.trim() === '' ? null : Number(minimo);
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100)) { setFallo('The minimum must be between 0 and 100'); return; }
    try {
      await onGuardar({ symbols: lista.length === 0 ? null : lista, minAccountPct: n });
      setFallo(null);
      setAbierto(false);
    } catch (e) {
      setFallo(e instanceof Error ? e.message : String(e));
    }
  }

  return <>
    <button type="button" aria-expanded={abierto} title="Which trades of this wallet matter"
      onClick={() => setAbierto((v) => !v)}>{resumen}</button>
    {abierto && (
      <div className="trader-filtros">
        <label><span className="label">Pairs</span>
          <input value={pares} placeholder="SOL, ETH, HYPE (empty = all)" onChange={(e) => setPares(e.target.value)} /></label>
        <label><span className="label">Min % of account</span>
          <input type="number" min={0} max={100} step="any" value={minimo} placeholder="none"
            onChange={(e) => setMinimo(e.target.value)} /></label>
        <button type="button" onClick={() => void guardar()}>Save</button>
        {fallo !== null && <span className="warn-text">{fallo}</span>}
      </div>
    )}
  </>;
}

function FollowingPanel() {
  const { data, error, loading, patch, remove } = useTraders();
  const traders = data?.traders ?? [];

  const estado = error !== null
    ? <span className="light light-red">API unreachable</span>
    : data !== null && !data.tracking
      ? <span className="light light-yellow">Not tracking</span>
      : <span className="light light-green">
        {traders.filter((t) => t.active).length} active of {traders.length}
      </span>;

  return <Panel title="Followed traders" wide status={estado}>
    <AddTrader />
    {loading && <div className="trader-empty">Loading…</div>}
    {!loading && traders.length === 0 && <EmptyContent message="No trader followed yet." />}
    {traders.map((t) => (
      <div key={t.id} className="trader-row">
        <span className="trader-dot" style={t.color === null ? undefined : { background: t.color }} />
        <span className="trader-name">{t.alias ?? t.address.slice(0, 10)}</span>
        <span className="none trader-addr">{t.address}</span>
        <span className="none">{t.group ?? '—'}</span>
        <TraderStatus trader={t} />
        <span className="none">
          {t.status === 'paused' ? '—' : t.updatedAt === null ? 'never' : fmt.ago(t.updatedAt)}
        </span>
        <FiltrosWallet trader={t} onGuardar={(cambios) => patch(t.id, cambios)} />
        <button type="button" onClick={() => void patch(t.id, { active: !t.active })}>
          {t.active ? 'Pause' : 'Resume'}
        </button>
        <button type="button" onClick={() => void remove(t.id)}>Remove</button>
      </div>
    ))}
    {traders.some((t) => t.error !== null) && (
      <div className="degraded-note">
        {traders.filter((t) => t.error !== null).map((t) => (
          <span key={t.id}>{t.alias ?? t.address.slice(0, 10)}: {t.error}</span>
        ))}
      </div>
    )}
  </Panel>;
}

/** Por quien se agrupan las posiciones. Es preferencia de vista, va al navegador. */
type Agrupacion = 'trader' | 'asset';
const CLAVE_AGRUPACION = 'traders.positions.groupBy';

function leerAgrupacion(): Agrupacion {
  try {
    return localStorage.getItem(CLAVE_AGRUPACION) === 'asset' ? 'asset' : 'trader';
  } catch { return 'trader'; }
}

/** Una posicion con el trader al que pertenece, para poder reordenarlas. */
interface Fila {
  readonly traderId: string;
  readonly trader: string;
  readonly color: string | null;
  readonly p: TrackedTrader['positions'][number];
}

/**
 * Posiciones abiertas de cada trader activo.
 *
 * Lo importante aqui es lo que NO se hace: un fallo no se pinta como "sin
 * posiciones". Se conserva la ultima lectura buena, se dice de cuando es y se
 * marca si ya no vale como actual. Sin posiciones y sin datos son dos frases
 * distintas porque son dos cosas distintas.
 *
 * Se agrupa por trader o por activo. Por trader responde "que tiene abierto
 * este", y por activo "quien esta en BTC y de que lado", que con varios
 * seguidos es la pregunta que de verdad se hace. Dentro de cada grupo mandan
 * los tamanos, de mayor a menor: una posicion de 40.000 dolares y otra de 200
 * no se leen igual de rapido si van mezcladas.
 *
 * La lista va dentro de su propio espacio con barra: un vault con 177
 * posiciones empujaba el resto de la pantalla fuera de la vista.
 */
function PositionsPanel() {
  const { data, loading, error, asset, traderId, group } = useTraders();
  const [grupo, setGrupo] = useState<Agrupacion>(leerAgrupacion);
  const traders = (data?.traders ?? []).filter((t) => t.active && (!traderId || t.id === traderId) && (!group || t.group === group));

  function cambiar(a: Agrupacion) {
    setGrupo(a);
    try { localStorage.setItem(CLAVE_AGRUPACION, a); } catch { /* preferencia, no dato */ }
  }

  const filas: Fila[] = traders.flatMap((t) => t.positions.filter((p) => !asset || p.symbol === asset).map((p) => ({
    traderId: t.id, trader: t.alias ?? t.address.slice(0, 10), color: t.color, p,
  })));

  // Los traders que no estan ensenando posiciones por algo que no es "no
  // tiene ninguna". Agrupando por activo no tienen fila propia donde decirlo,
  // asi que se declara arriba: un trader sin datos no puede desaparecer.
  const avisos = traders.filter((t) => t.status === 'waiting' || t.status === 'failing'
    || t.status === 'stale' || (t.updatedAt !== null && t.positions.length === 0));

  // Por mercado: cada uno con lo que suma, y dentro quien lo tiene. Por el
  // mercado exacto, no por el simbolo: NVDA en xyz y en otro dex son dos.
  const porActivo = new Map<string, Fila[]>();
  for (const f of filas) porActivo.set(f.p.symbolNative, [...(porActivo.get(f.p.symbolNative) ?? []), f]);
  const activos = [...porActivo.entries()]
    .map(([native, fs]) => ({
      native,
      symbol: fs[0]?.p.symbol ?? native,
      filas: [...fs].sort((a, b) => b.p.notionalUsd - a.p.notionalUsd),
      total: fs.reduce((a, f) => a + f.p.notionalUsd, 0),
    }))
    .sort((a, b) => b.total - a.total);

  return <Panel
    title="Positions"
    wide
    status={error !== null ? <span className="light light-red">API unreachable</span> : data?.intervalMs == null
      ? <span className="light light-yellow">Not tracking</span>
      : <span className="none">every {Math.round(data.intervalMs / 1000)}s</span>}
  >
    <div className="controls">
      <div className="control-group">
        <span className="label">Group by</span>
        <div className="segmented">
          <button type="button" aria-pressed={grupo === 'trader'}
            className={grupo === 'trader' ? 'seg seg-active' : 'seg'}
            onClick={() => cambiar('trader')}>Trader</button>
          <button type="button" aria-pressed={grupo === 'asset'}
            className={grupo === 'asset' ? 'seg seg-active' : 'seg'}
            onClick={() => cambiar('asset')}>Asset</button>
        </div>
      </div>
      <span className="label">
        {filas.length} shown · {porActivo.size} {porActivo.size === 1 ? 'asset' : 'assets'}
      </span>
    </div>

    {loading && <div className="trader-empty">Loading…</div>}
    {!loading && traders.length === 0 && <EmptyContent message="No active trader." />}

    {grupo === 'asset' && avisos.map((t) => (
      <div key={t.id} className="trader-row trader-note">
        <span className="trader-name">{t.alias ?? t.address.slice(0, 10)}</span>
        <span className={ESTADO[t.status].clase}>{ESTADO[t.status].texto}</span>
        <span className="none">
          {t.status === 'waiting' ? 'Waiting for the first read.'
            : t.status === 'failing' ? `No data yet: ${t.error}`
              : t.positions.length === 0 ? 'No open positions.'
                : `From ${fmt.ago(t.updatedAt)}`}
        </span>
      </div>
    ))}

    {traders.length > 0 && <div className="trader-scroll">
      {grupo === 'trader' && traders.map((t) => (
        <div key={t.id} className="trader-block">
          <div className="trader-row trader-row-head">
            <span className="trader-name">{t.alias ?? t.address.slice(0, 10)}</span>
            <span className="none">{usd(t.equityUsd)}</span>
            <span className={ESTADO[t.status].clase}>{ESTADO[t.status].texto}</span>
            <span className="none">{t.updatedAt === null ? 'never' : fmt.ago(t.updatedAt)}</span>
          </div>

          {t.status === 'waiting' && <div className="trader-empty">Waiting for the first read.</div>}
          {t.status === 'failing' && <div className="trader-empty">No data yet: {t.error}</div>}
          {t.updatedAt !== null && t.positions.length === 0 && (
            <div className="trader-empty">No open positions.</div>
          )}

          {t.positions.filter((p) => !asset || p.symbol === asset).sort((a, b) => b.notionalUsd - a.notionalUsd).map((p) => (
            <div key={p.symbolNative} className="trader-row trader-pos">
              <span className="asset"><NombreMercado symbol={p.symbol} native={p.symbolNative} /></span>
              <span className={p.side === 'long' ? 'pos' : 'neg'}>{p.side.toUpperCase()}</span>
              <span className="num">{usd(p.notionalUsd)}</span>
              <span className="num none">Entry {p.entryPrice === null ? '—' : p.entryPrice}</span>
              <span className={`num ${(p.unrealizedPnlUsd ?? 0) >= 0 ? 'pos' : 'neg'}`}>
                PnL {usd(p.unrealizedPnlUsd)}
              </span>
              <span className="num none">{p.leverage === null ? '—' : `${p.leverage}x`}</span>
            </div>
          ))}
        </div>
      ))}

      {grupo === 'asset' && activos.map((a) => (
        <div key={a.native} className="trader-block">
          <div className="trader-row trader-row-head">
            <span className="asset"><NombreMercado symbol={a.symbol} native={a.native} /></span>
            <span className="num">{usd(a.total)}</span>
            <span className="none">{a.filas.length} {a.filas.length === 1 ? 'trader' : 'traders'}</span>
          </div>
          {a.filas.map((f) => (
            <div key={`${f.traderId}:${f.p.symbolNative}`} className="trader-row trader-pos">
              <span className="trader-dot" style={f.color === null ? undefined : { background: f.color }} />
              <span className="trader-name">{f.trader}</span>
              <TraderStatus trader={traders.find(t => t.id === f.traderId)!} />
              <span className={f.p.side === 'long' ? 'pos' : 'neg'}>{f.p.side.toUpperCase()}</span>
              <span className="num">{usd(f.p.notionalUsd)}</span>
              <span className="num none">Entry {f.p.entryPrice === null ? '—' : f.p.entryPrice}</span>
              <span className={`num ${(f.p.unrealizedPnlUsd ?? 0) >= 0 ? 'pos' : 'neg'}`}>
                PnL {usd(f.p.unrealizedPnlUsd)}
              </span>
              <span className="num none">{f.p.leverage === null ? '—' : `${f.p.leverage}x`}</span>
            </div>
          ))}
        </div>
      ))}

      {activos.length === 0 && !loading && (
        <div className="trader-empty">{asset ? 'No positions matching this asset in the available data.' : 'No positions in the available data.'}</div>
      )}
    </div>}
  </Panel>;
}

/** Estado local tambien se degrada si deja de responder la API. */
function TraderStatus({ trader }: { trader: TrackedTrader }) {
  const { error, data } = useTraders();
  const expired = trader.updatedAt !== null && data?.staleAfterMs != null && Date.now() - trader.updatedAt > data.staleAfterMs;
  const state = !trader.active ? ESTADO.paused : error !== null || (trader.status === 'ok' && expired) ? ESTADO.stale : ESTADO[trader.status];
  return <span className={state.clase}>{state.texto}</span>;
}

function AssetPanel() {
  const { data, asset, setAsset, traderId, setTraderId, group, setGroup } = useTraders();
  const traders = data?.traders ?? [];
  // Son activos observados en posiciones, no un catalogo completo del mercado.
  const assets = [...new Set(traders.flatMap(t => t.positions.map(p => p.symbol)))].sort();
  const groups = [...new Set(traders.flatMap(t => t.group ? [t.group] : []))].sort();
  return <Panel title="Assets & wallets" wide status={<span className="none">Tracked wallets only</span>}>
    <div className="controls">
      <label><span className="label">Asset</span><select value={asset} onChange={e => setAsset(e.target.value)}>
        <option value="">All observed assets</option>
        {asset && !assets.includes(asset) && <option value={asset}>{asset} (no positions)</option>}
        {assets.map(a => <option key={a} value={a}>{a}</option>)}
      </select></label>
      <label><span className="label">Wallet</span><select value={traderId} onChange={e => setTraderId(e.target.value)}>
        <option value="">All wallets</option>
        {traderId && !traders.some(t => t.id === traderId) && <option value={traderId}>Removed wallet</option>}
        {traders.map(t => <option key={t.id} value={t.id}>{t.alias ?? t.address.slice(0, 10)}{t.active ? '' : ' (paused)'}</option>)}
      </select></label>
      <label><span className="label">Group</span><select value={group} onChange={e => setGroup(e.target.value)}>
        <option value="">All groups</option>
        {group && !groups.includes(group) && <option value={group}>{group} (unavailable)</option>}
        {groups.map(g => <option key={g} value={g}>{g}</option>)}
      </select></label>
      <button type="button" onClick={() => { setAsset(''); setTraderId(''); setGroup(''); }}>Reset filters</button>
    </div>
  </Panel>;
}

/** Consenso de las wallets elegidas, no del mercado completo. */
function ConsensusPanel() {
  const { data, error, asset, traderId, group } = useTraders();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5_000); return () => clearInterval(timer); }, []);
  const result = traderConsensus(data, now, { asset, traderId, group }, error !== null);
  return <Panel title="Wallet consensus" status={<span className="none">{result.included} included · {result.excluded} excluded</span>}>
    <p className="none">Tracked wallets only · current positions</p>
    {result.rows.map(row => <div className="trader-row" key={row.symbol}>
      <strong>{row.symbol}</strong>
      <span className="pos">{row.longs.size} long · {usd(row.longUsd)}</span>
      <span className="neg">{row.shorts.size} short · {usd(row.shortUsd)}</span>
      <span>Net {usd(row.longUsd - row.shortUsd)}</span>
    </div>)}
    {result.rows.length === 0 && <EmptyContent message={result.included > 0 ? 'No positions match these filters.' : 'No current wallet data available.'} />}
    {result.excluded > 0 && <p className="none">Paused, unavailable or outdated wallets are excluded.</p>}
  </Panel>;
}
