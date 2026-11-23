import { useEffect, useMemo, useRef, useState } from 'react';
import { BASE } from '../api.ts';
import { CandleChart, type Vela, type Indicador, type Marca, type Apariencia } from '../components/CandleChart.tsx';
import { SERIE_COLORS } from '../components/Chart.tsx';
import { ema, sma, rsi, macd, bollinger, vwap } from '@defi/core';
import { useFavoritos, Estrella } from '../components/favoritos.tsx';
import { usd } from '../formato.ts';
import { TraderPanel } from '../components/TraderPanels.tsx';
import { useTraders } from '../components/tradersState.tsx';
import { href, navegar } from '../router.ts';

/**
 * Terminal: un mercado de Hyperliquid, entero y a la vista.
 *
 * Es otra cara de Hyperliquid: sus mercados tal cual,
 * con sus nombres y sus pestanas. Perps del core, perps HIP-3 de cada dex
 * (`xyz:SP500` se ve como S&P500-USDC, con su etiqueta xyz) y spot (`@107` es
 * HYPE/USDC). Asi lo que opera una wallet seguida se lee igual que en su web.
 *
 * Arriba el par en grande, que abre el selector, y sus cifras: mark, oraculo,
 * cambio, volumen, interes abierto y funding con su cuenta atras. En medio el
 * grafico, con el libro y la cinta de operaciones a la derecha. Abajo, las
 * ejecuciones de las wallets seguidas (marcadas tambien sobre las velas), sus
 * posiciones, el consenso y los activos.
 *
 * Solo consulta. No hay panel de ordenes ni lo va a haber: esta aplicacion no
 * conecta wallets, no firma y no opera.
 */

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
const DURACION: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

/** Un mercado de Hyperliquid, como lo sirve `/api/hl/markets`. */
interface Mercado {
  /** Lo que entiende su API: `BTC`, `xyz:XYZ100`, `@107`. */
  readonly coin: string;
  /** El simbolo comun de la app, para cruzar con las wallets seguidas. */
  readonly symbol: string;
  /** Como lo ensena Hyperliquid: `BTC-USDC`, `S&P500-USDC`, `HYPE/USDC`. */
  readonly name: string;
  readonly base: string;
  readonly quote: string;
  readonly kind: 'perp' | 'spot';
  readonly dex: string | null;
  readonly dexName: string | null;
  readonly category: string;
  readonly keywords: readonly string[];
  readonly maxLeverage: number | null;
  readonly onlyIsolated: boolean;
  readonly mark: number | null;
  readonly oracle: number | null;
  readonly prevDayPx: number | null;
  readonly change24hPct: number | null;
  readonly volume24hUsd: number | null;
  readonly openInterestUsd: number | null;
  readonly fundingHourly: number | null;
}
interface Markets { at: number; nextFundingAt: number; failed: string[]; markets: Mercado[] }
interface Trade { readonly ts: number; readonly side: 'buy' | 'sell'; readonly px: number; readonly sz: number; readonly tid: string }
interface Trades { at: number; trades: Trade[] }

/** Columnas del selector de mercados, las mismas que ensena Hyperliquid. */
const COLUMNAS_MERCADO = [
  { id: 'name', label: 'Market' },
  { id: 'mark', label: 'Last price' },
  { id: 'change24hPct', label: '24h change' },
  { id: 'fundingHourly', label: '8h funding' },
  { id: 'volume24hUsd', label: 'Volume' },
  { id: 'openInterestUsd', label: 'Open interest' },
] as const;
type ColumnaMercado = typeof COLUMNAS_MERCADO[number]['id'];

/** Lo que Hyperliquid llama Tradfi: todo lo HIP-3 que no es cripto ni pre-IPO. */
const TRADFI = new Set(['stocks', 'indices', 'commodities', 'fx', 'rates']);

/**
 * Sus pestanas. Trending y Strict no estan: Hyperliquid no publica con que
 * criterio salen, y uno inventado aqui se leeria como el suyo. Favoritos si,
 * que es nuestro.
 */
const PESTANAS_MERCADO: readonly { id: string; label: string; es: (m: Mercado) => boolean }[] = [
  { id: 'all', label: 'All', es: () => true },
  { id: 'perps', label: 'Perps', es: (m) => m.kind === 'perp' },
  { id: 'spot', label: 'Spot', es: (m) => m.kind === 'spot' },
  { id: 'crypto', label: 'Crypto', es: (m) => m.kind === 'perp' && m.category === 'crypto' },
  { id: 'tradfi', label: 'Tradfi', es: (m) => m.kind === 'perp' && TRADFI.has(m.category) },
  { id: 'hip3', label: 'HIP-3', es: (m) => m.dex !== null },
  { id: 'preipo', label: 'Pre-IPO', es: (m) => m.category === 'preipo' },
];

/**
 * El aspecto del grafico, a gusto de quien lo mira.
 * Fondos y juegos de velas con nombre, mas un color de fondo libre. Se guarda
 * en el navegador: es una preferencia de vista, no un dato.
 */
const FONDOS: readonly { id: string; label: string; color: string }[] = [
  { id: 'app', label: 'App', color: '' },
  { id: 'black', label: 'Black', color: '#000000' },
  { id: 'tv', label: 'TradingView', color: '#131722' },
  { id: 'navy', label: 'Navy', color: '#0b1730' },
  { id: 'graphite', label: 'Graphite', color: '#1c1c1f' },
  { id: 'white', label: 'White', color: '#ffffff' },
];
const VELAS: readonly { id: string; label: string; subida: string; bajada: string }[] = [
  { id: 'app', label: 'Green / red', subida: '', bajada: '' },
  { id: 'tv', label: 'TradingView', subida: '#26a69a', bajada: '#ef5350' },
  { id: 'vivid', label: 'Vivid', subida: '#2ebd85', bajada: '#f6465d' },
  { id: 'mono', label: 'Mono', subida: '#d1d5db', bajada: '#5b6578' },
];
const APARIENCIA_INICIAL: Apariencia = { fondo: '', rejilla: true, subida: '', bajada: '' };
const CLAVE_APARIENCIA = 'terminal:apariencia';
function leerApariencia(): Apariencia {
  try {
    const v = JSON.parse(localStorage.getItem(CLAVE_APARIENCIA) ?? 'null') as Partial<Apariencia> | null;
    if (v === null || typeof v !== 'object') return APARIENCIA_INICIAL;
    const color = (x: unknown) => (typeof x === 'string' && /^(#[0-9a-f]{6})?$/i.test(x) ? x : '');
    return { fondo: color(v.fondo), rejilla: v.rejilla !== false, subida: color(v.subida), bajada: color(v.bajada) };
  } catch { return APARIENCIA_INICIAL; }
}

const CLAVE_COIN = 'terminal:coin';
function leerCoin(): string | null {
  try { return localStorage.getItem(CLAVE_COIN); } catch { return null; }
}

const PESTANAS = [
  { id: 'fills', label: 'Followed trades' },
  { id: 'positions', label: 'Positions' },
  { id: 'consensus', label: 'Consensus' },
  { id: 'assets', label: 'Assets' },
] as const;
type Pestana = typeof PESTANAS[number]['id'];
interface Candles { candles: Vela[]; fetchedAt: number; symbolNative: string }
interface Nivel { readonly price: number; readonly size: number }
interface Libro {
  readonly available: boolean;
  readonly at: number;
  readonly bids: Nivel[];
  readonly asks: Nivel[];
}
interface Ejecucion {
  readonly tid: string;
  readonly traderId: string;
  readonly symbol: string;
  readonly ts: number;
  readonly dir: string;
  readonly side: 'long' | 'short';
  readonly px: number;
  readonly sz: number;
  readonly notionalUsd: number;
  readonly closedPnl: number | null;
  readonly accountPct: number | null;
}
interface Ejecuciones {
  readonly traders: readonly { id: string; alias: string | null; address: string }[];
  readonly fills: readonly Ejecucion[];
}

/**
 * Los indicadores encendidos, como una lista de claves.
 *
 * Las medias llevan su periodo en la clave ('ema-21', 'sma-200'), asi que se
 * puede tener cualquier periodo y varias a la vez, como en TradingView. El
 * resto son unicos: 'bb', 'vwap', 'rsi', 'macd'.
 *
 * NO hay formulas propias, y fue una decision: con medias de cualquier
 * periodo, bandas, VWAP, RSI y MACD esta cubierto lo que se mira a diario, y
 * un interprete de formulas es mucha superficie para lo que aporta.
 */
const CLAVE_INDICADORES = 'terminal:indicadores';
const FIJOS = [
  { id: 'bb', label: 'Bollinger 20' },
  { id: 'vwap', label: 'VWAP' },
  { id: 'rsi', label: 'RSI 14' },
  { id: 'macd', label: 'MACD' },
] as const;

function claveValida(x: unknown): x is string {
  return typeof x === 'string' && (/^(ema|sma)-\d{1,3}$/.test(x) || FIJOS.some((f) => f.id === x));
}

function leerIndicadores(): string[] {
  try {
    const v = localStorage.getItem(CLAVE_INDICADORES);
    if (v === null) return [];
    const p = JSON.parse(v) as unknown;
    if (!Array.isArray(p)) return [];
    // Las claves de la version anterior venian sin guion ('ema21'). Se
    // traducen en vez de tirarse, para no borrarle la configuracion a nadie.
    return p
      .map((x) => (typeof x === 'string' ? x.replace(/^(ema|sma)(\d+)$/, '$1-$2') : x))
      .filter(claveValida);
  } catch { return []; }
}

function etiqueta(id: string): string {
  const m = /^(ema|sma)-(\d+)$/.exec(id);
  if (m !== null) return `${(m[1] ?? '').toUpperCase()} ${m[2]}`;
  return FIJOS.find((f) => f.id === id)?.label ?? id;
}

/**
 * Calcula los indicadores encendidos sobre las velas que hay.
 *
 * Los colores NO salen de los tokens de estado: verde, ambar y rojo significan
 * estado en esta app, y una media no es un estado. Van de la paleta de series,
 * por orden de encendido, para que dos medias nunca compartan color.
 */
function calcular(velas: readonly Vela[], activos: readonly string[], decimales: number): Indicador[] {
  if (velas.length === 0) return [];
  const cierres = velas.map((v) => v.close);
  const conVolumen = velas.map((v) => ({ ...v, volume: v.volume ?? 0 }));
  const out: Indicador[] = [];
  const color = (i: number) => SERIE_COLORS[i % SERIE_COLORS.length] ?? '#4c9af8';
  const gris = '#7d8da3';

  activos.forEach((id, i) => {
    const media = /^(ema|sma)-(\d+)$/.exec(id);
    if (media !== null) {
      const periodo = Number(media[2]);
      const f = media[1] === 'ema' ? ema : sma;
      out.push({ id, label: etiqueta(id), tipo: 'linea', color: color(i), grupo: null, puntos: f(cierres, periodo) });
    } else if (id === 'vwap') {
      out.push({ id, label: 'VWAP', tipo: 'linea', color: color(i), grupo: null, puntos: vwap(conVolumen) });
    } else if (id === 'bb') {
      const b = bollinger(cierres, 20, 2);
      out.push({ id: 'bb-alta', label: 'BB up', tipo: 'linea', color: color(i), grupo: null, puntos: b.alta });
      out.push({ id: 'bb-media', label: 'mid', tipo: 'linea', color: gris, grupo: null, puntos: b.media });
      out.push({ id: 'bb-baja', label: 'low', tipo: 'linea', color: color(i), grupo: null, puntos: b.baja });
    } else if (id === 'rsi') {
      out.push({ id, label: 'RSI 14', tipo: 'linea', color: color(i), grupo: 'rsi', puntos: rsi(cierres, 14), decimales: 2 });
    } else if (id === 'macd') {
      const m = macd(cierres, 12, 26, 9);
      out.push({ id: 'macd-linea', label: 'MACD', tipo: 'linea', color: color(i), grupo: 'macd', puntos: m.macd, decimales });
      out.push({ id: 'macd-senal', label: 'signal', tipo: 'linea', color: color(i + 3), grupo: 'macd', puntos: m.senal, decimales });
      out.push({ id: 'macd-hist', label: 'hist', tipo: 'histograma', color: gris, grupo: 'macd', puntos: m.histograma, decimales });
    }
  });
  // Lo del precio primero y cada panel despues: es el orden de la leyenda.
  return [...out.filter((x) => x.grupo === null), ...out.filter((x) => x.grupo !== null)];
}

/** Una consulta activa por pantalla; al cambiar de activo se cancela la anterior. */
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(BASE + path, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Market data unavailable');
  return body;
}

/** Repite una carga mientras la pantalla siga montada y la pestana visible. */
function useSondeo(cargar: (signal: AbortSignal) => Promise<void>, cadaMs: number, deps: readonly unknown[]) {
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function vuelta() {
      try {
        // Con la pestana de fondo no se pide: la IP se comparte con otros bots.
        if (document.visibilityState !== 'hidden') await cargar(controller.signal);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void vuelta(), cadaMs);
      }
    }
    void vuelta();
    return () => { controller.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Lo que falta para la proxima liquidacion de funding.
 *
 * Componente aparte con su propio segundero: si el reloj de un segundo viviese
 * en la pantalla, toda ella, tablas incluidas, se repintaria cada segundo para
 * mover dos cifras.
 */
function CuentaAtras({ hasta }: { hasta: number | null }) {
  const [ahora, setAhora] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  if (hasta === null) return <>—</>;
  const s = Math.max(0, Math.floor((hasta - ahora) / 1000));
  const dos = (n: number) => String(n).padStart(2, '0');
  return <>{dos(Math.floor(s / 3600))}:{dos(Math.floor((s % 3600) / 60))}:{dos(s % 60)}</>;
}

const precio = (v: number | null): string => v === null ? '—' : v.toLocaleString('en-US', {
  maximumFractionDigits: Math.min(10, Math.max(2, 5 - Math.floor(Math.log10(Math.max(v, 1e-12))))),
});

/**
 * El nombre del selector con sus etiquetas EN COLUMNA: el apalancamiento
 * siempre en el mismo hueco y el dex en el siguiente, haya o no haya, para que
 * se lean de arriba abajo como en una tabla.
 */
function NombreConEtiquetas({ m }: { m: Mercado }) {
  return (
    <span className="hl-celda">
      <span className="hl-nombre" title={m.coin}>{m.name}</span>
      <span className="hl-hueco">{m.maxLeverage !== null && <span className="hl-etiqueta">{m.maxLeverage}x</span>}</span>
      <span className="hl-hueco">
        {m.dex !== null && <span className="hl-etiqueta" title={m.dexName ?? m.dex}>{m.dex}</span>}
        {m.kind === 'spot' && <span className="hl-etiqueta">spot</span>}
      </span>
    </span>
  );
}

/** Las etiquetas de su web: apalancamiento maximo y dex HIP-3. */
function Etiquetas({ m }: { m: Mercado }) {
  return (
    <>
      {m.maxLeverage !== null && <span className="hl-etiqueta">{m.maxLeverage}x</span>}
      {m.dex !== null && <span className="hl-etiqueta" title={m.dexName ?? m.dex}>{m.dex}</span>}
      {m.kind === 'spot' && <span className="hl-etiqueta">spot</span>}
    </>
  );
}

export function Terminal() {
  const { asset, setAsset } = useTraders();
  const [coin, setCoinValue] = useState<string>(() => leerCoin() ?? (asset || 'BTC'));
  const [interval, setIntervalValue] = useState('1h');
  const [catalogo, setCatalogo] = useState<Markets | null>(null);
  const [buscar, setBuscar] = useState('');
  const [libro, setLibro] = useState<Libro | null>(null);
  const [cinta, setCinta] = useState<Trades | null>(null);
  const [panelLibro, setPanelLibro] = useState<'book' | 'trades'>('book');
  const favoritos = useFavoritos('terminal.fav.assets');
  const [data, setData] = useState<Candles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [ejecuciones, setEjecuciones] = useState<Ejecuciones | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [activos, setActivos] = useState<string[]>(leerIndicadores);
  const [log, setLog] = useState(false);
  const [nuevoTipo, setNuevoTipo] = useState<'ema' | 'sma'>('ema');
  const [nuevoPeriodo, setNuevoPeriodo] = useState('21');
  const [selector, setSelector] = useState(false);
  const [pestanaMercados, setPestanaMercados] = useState<string>('all');
  // Por volumen de mayor a menor, que es como abre el de Hyperliquid.
  const [ordenMercados, setOrdenMercados] = useState<{ col: ColumnaMercado; dir: 'desc' | 'asc' }>({ col: 'volume24hUsd', dir: 'desc' });
  const [pestana, setPestana] = useState<Pestana>('fills');
  const selectorRef = useRef<HTMLDivElement>(null);
  const [apariencia, setApariencia] = useState<Apariencia>(leerApariencia);
  const [estilo, setEstilo] = useState(false);
  const estiloRef = useRef<HTMLDivElement>(null);

  function cambiarApariencia(cambio: Partial<Apariencia>) {
    setApariencia((a) => {
      const siguiente = { ...a, ...cambio };
      try { localStorage.setItem(CLAVE_APARIENCIA, JSON.stringify(siguiente)); } catch { /* preferencia */ }
      return siguiente;
    });
  }
  useEffect(() => {
    if (!estilo) return undefined;
    const fuera = (e: MouseEvent) => {
      if (estiloRef.current !== null && !estiloRef.current.contains(e.target as Node)) setEstilo(false);
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [estilo]);

  const markets = catalogo?.markets ?? [];
  const mercado = markets.find((m) => m.coin === coin) ?? null;
  const symbol = mercado?.symbol ?? coin;

  /** Cambia de mercado y lo recuerda; el resto de la app sigue al simbolo comun. */
  function elegir(m: Mercado) {
    setCoinValue(m.coin);
    try { localStorage.setItem(CLAVE_COIN, m.coin); } catch { /* preferencia */ }
    setAsset(m.symbol);
    setSelector(false);
  }

  // Si otra pantalla elige un activo (el Tracker, un clic en una posicion), el
  // Terminal lo sigue: su perp del core si lo hay, y si no el primero que se
  // llame asi. Elegir aqui pone el mismo simbolo, asi que no hay vaiven.
  useEffect(() => {
    if (asset === '' || markets.length === 0 || mercado?.symbol === asset) return;
    const m = markets.find((x) => x.coin === asset)
      ?? markets.find((x) => x.symbol === asset && x.kind === 'perp')
      ?? markets.find((x) => x.symbol === asset);
    if (m !== undefined) setCoinValue(m.coin);
  }, [asset, markets, mercado?.symbol]);

  // Un clic fuera cierra el selector, como en el resto de la aplicacion; y
  // Ctrl+K (Cmd+K) lo abre, como en Hyperliquid.
  useEffect(() => {
    const atajo = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setBuscar(''); setSelector(true); }
    };
    document.addEventListener('keydown', atajo);
    return () => document.removeEventListener('keydown', atajo);
  }, []);
  useEffect(() => {
    if (!selector) return undefined;
    const fuera = (e: MouseEvent) => {
      if (selectorRef.current !== null && !selectorRef.current.contains(e.target as Node)) setSelector(false);
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [selector]);

  /** Primera vez de mayor a menor; la segunda, al reves. */
  function ordenarMercados(col: ColumnaMercado) {
    setOrdenMercados((o) => (o.col === col ? { col, dir: o.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: col === 'name' ? 'asc' : 'desc' }));
  }

  /**
   * Cambia la lista de indicadores sobre el valor ANTERIOR, no el del render.
   *
   * Con dos clics seguidos, por ejemplo anadir una media y encender el MACD,
   * los dos leian la misma lista y el segundo borraba lo del primero. Es el
   * mismo fallo que ya se corrigio en los favoritos, y se vio aqui al probarlo:
   * la EMA 200 desaparecia al encender el MACD justo despues.
   */
  function cambiar(f: (previos: string[]) => string[]) {
    setActivos((previos) => {
      const siguiente = f(previos);
      try { localStorage.setItem(CLAVE_INDICADORES, JSON.stringify(siguiente)); } catch { /* preferencia */ }
      return siguiente;
    });
  }
  const alternar = (id: string) => cambiar((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  function anadirMedia() {
    const n = Math.round(Number(nuevoPeriodo));
    // De 2 a 500: por debajo no es una media y por encima no hay velas que
    // la llenen, y saldria una linea entera en blanco sin explicar por que.
    if (!Number.isFinite(n) || n < 2 || n > 500) return;
    const id = `${nuevoTipo}-${n}`;
    cambiar((p) => (p.includes(id) ? p : [...p, id]));
  }

  // El catalogo entero de Hyperliquid. El servidor lo cachea 90 s.
  useSondeo(async (signal) => {
    try {
      const r = await read<Markets>('/api/hl/markets', signal);
      if (!signal.aborted) { setCatalogo(r); setMarketError(null); }
    } catch (e) {
      if (!signal.aborted) setMarketError(e instanceof Error ? e.message : String(e));
    }
  }, 60_000, []);

  useEffect(() => { setData(null); setError(null); setEjecuciones(null); }, [coin, interval]);
  useSondeo(async (signal) => {
    try {
      const r = await read<Candles>('/api/candles?venue=hyperliquid&coin=' + encodeURIComponent(coin) + '&interval=' + interval + '&limit=1000', signal);
      if (!signal.aborted) { setData(r); setError(null); }
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : String(e));
    }
  }, 30_000, [coin, interval]);

  // El libro cada 5 s y la cinta cada 5 s solo mientras se ve. El servidor
  // cachea los dos, asi que dos pantallas abiertas no son dos peticiones.
  useEffect(() => { setLibro(null); setCinta(null); }, [coin]);
  useSondeo(async (signal) => {
    if (panelLibro !== 'book') return;
    try {
      const r = await read<Libro>('/api/hl/book?levels=12&coin=' + encodeURIComponent(coin), signal);
      if (!signal.aborted) setLibro(r);
    } catch {
      // Un libro que no se puede leer deja el panel diciendolo, y no rompe el
      // grafico, que es lo que de verdad se esta mirando.
      if (!signal.aborted) setLibro(null);
    }
  }, 5_000, [coin, panelLibro]);
  useSondeo(async (signal) => {
    if (panelLibro !== 'trades') return;
    try {
      const r = await read<Trades>('/api/hl/trades?coin=' + encodeURIComponent(coin), signal);
      if (!signal.aborted) setCinta(r);
    } catch {
      if (!signal.aborted) setCinta(null);
    }
  }, 5_000, [coin, panelLibro]);

  // Las ejecuciones de las wallets seguidas en ESTE mercado, ya filtradas con
  // lo que cada wallet tiene configurado. Salen de nuestra base, no del venue.
  // Los perps del core van por simbolo (lo guardado antes no traia el `coin`);
  // HIP-3 y spot, por su `coin` exacto, que es lo que los distingue.
  const desde = data?.candles[0]?.t ?? null;
  const filtroFills = mercado === null || (mercado.kind === 'perp' && mercado.dex === null)
    ? `symbol=${encodeURIComponent(symbol)}` : `coin=${encodeURIComponent(coin)}`;
  useSondeo(async (signal) => {
    if (desde === null) return;
    try {
      const r = await read<Ejecuciones>(`/api/fills?respectFilters=1&limit=2000&${filtroFills}&from=${desde}`, signal);
      if (!signal.aborted) setEjecuciones(r);
    } catch {
      if (!signal.aborted) setEjecuciones(null);
    }
  }, 30_000, [filtroFills, desde]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const velas = data?.candles ?? [];
  const latest = velas.at(-1);
  const precision = latest ? Math.min(10, Math.max(2, 5 - Math.floor(Math.log10(latest.close)))) : 2;
  const age = data && Number.isFinite(data.fetchedAt) ? Math.max(0, Math.floor((clock - data.fetchedAt) / 1000)) : null;
  const oldCandle = latest !== undefined && clock - latest.t > 2 * (DURACION[interval] ?? 3_600_000);

  // Memoizados: la pantalla se repinta cada 5 s por el reloj de "hace Xs", y
  // sin esto cada repintado recalculaba todas las medias sobre mil velas y
  // volvia a empujar todas las series al grafico sin que hubiese cambiado nada.
  const indicadores = useMemo(() => calcular(velas, activos, precision), [velas, activos, precision]);
  const priceFormat = useMemo(() => ({ precision, minMove: 10 ** -precision }), [precision]);

  /**
   * Las ejecuciones, agrupadas por vela, lado y si abren o cierran.
   *
   * Una marca por grupo y no por fill: una entrada se parte muchas veces en
   * decenas de ejecuciones seguidas, y pintarlas todas deja la vela tapada por
   * una pila de flechas iguales. La marca dice cuantos dolares suman.
   */
  const marcas: Marca[] = useMemo(() => {
    const fills = ejecuciones?.fills ?? [];
    if (fills.length === 0 || velas.length === 0) return [];
    const alias = new Map((ejecuciones?.traders ?? []).map((t) => [t.id, t.alias ?? t.address.slice(0, 6)]));
    const grupos = new Map<string, { t: number; lado: 'long' | 'short'; tipo: 'abre' | 'cierra'; usd: number; quien: Set<string> }>();
    for (const f of fills) {
      // La vela a la que pertenece: la ultima que empieza antes del fill.
      let lo = 0;
      let hi = velas.length - 1;
      if (f.ts < (velas[0]?.t ?? Infinity)) continue;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((velas[mid]?.t ?? Infinity) <= f.ts) lo = mid; else hi = mid - 1;
      }
      const t = velas[lo]?.t;
      if (t === undefined) continue;
      const tipo = f.dir.toLowerCase().includes('close') ? 'cierra' : 'abre';
      const k = `${t}|${f.side}|${tipo}`;
      const g = grupos.get(k) ?? { t, lado: f.side, tipo, usd: 0, quien: new Set<string>() };
      g.usd += f.notionalUsd;
      g.quien.add(alias.get(f.traderId) ?? '?');
      grupos.set(k, g);
    }
    return [...grupos.values()].map((g) => ({
      t: g.t, lado: g.lado, tipo: g.tipo,
      texto: `${g.quien.size === 1 ? [...g.quien][0] : `${g.quien.size} wallets`} ${usd(g.usd)}`,
    }));
  }, [ejecuciones, velas]);

  // El grafico crece con los paneles de indicador que haya, en vez de
  // repartir los mismos pixeles entre mas cosas.
  const paneles = new Set(indicadores.filter((i) => i.grupo !== null).map((i) => i.grupo)).size;
  const altoGrafico = 620 + paneles * 140;

  /**
   * El libro con su acumulado. La barra mide el acumulado hasta ese nivel, no
   * el nivel suelto, sobre una escala comun a los dos lados.
   */
  const profundidad = useMemo(() => {
    if (libro === null || !libro.available) return null;
    const acumular = (niveles: readonly Nivel[]) => {
      let total = 0;
      return niveles.map((n) => { total += n.size; return { ...n, total }; });
    };
    const bids = acumular(libro.bids);
    const asks = acumular(libro.asks);
    const mayor = Math.max(bids.at(-1)?.total ?? 0, asks.at(-1)?.total ?? 0);
    const mejorBid = bids[0]?.price ?? null;
    const mejorAsk = asks[0]?.price ?? null;
    return {
      bids, asks, mayor,
      spread: mejorBid !== null && mejorAsk !== null ? mejorAsk - mejorBid : null,
      spreadPct: mejorBid !== null && mejorAsk !== null && mejorBid > 0 ? ((mejorAsk - mejorBid) / mejorBid) * 100 : null,
    };
  }, [libro]);
  const ancho = (total: number) => profundidad === null || profundidad.mayor <= 0 ? '0%' : `${(total / profundidad.mayor) * 100}%`;

  const visibles = useMemo(() => {
    const q = buscar.trim().toLowerCase();
    const pestanaSel = PESTANAS_MERCADO.find((p) => p.id === pestanaMercados);
    // El buscador mira lo mismo que el de Hyperliquid: el nombre visible, el
    // de su API y sus palabras clave ("nasdaq" encuentra XYZ100).
    const filtrados = markets.filter((m) => (pestanaMercados === 'fav' ? favoritos.es(m.coin) : pestanaSel?.es(m) ?? true)
      && (q === '' || m.name.toLowerCase().includes(q) || m.coin.toLowerCase().includes(q)
        || (m.dex ?? '').toLowerCase() === q || m.keywords.some((k) => k.includes(q))));
    const { col, dir } = ordenMercados;
    // Lo desconocido va al final se ordene como se ordene.
    return [...filtrados].sort((a, b) => {
      if (col === 'name') return dir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      const va = a[col];
      const vb = b[col];
      if (va === null) return vb === null ? 0 : 1;
      if (vb === null) return -1;
      return dir === 'desc' ? vb - va : va - vb;
    });
  }, [markets, buscar, favoritos, pestanaMercados, ordenMercados]);

  const signo = (v: number | null) => v === null ? 'none' : v >= 0 ? 'pos' : 'neg';
  const recientes = (ejecuciones?.fills ?? []).slice(0, 40);
  const nombre = (id: string) => {
    const t = ejecuciones?.traders.find((x) => x.id === id);
    return t === undefined ? '?' : t.alias ?? `${t.address.slice(0, 6)}…${t.address.slice(-4)}`;
  };
  /** Como en Hyperliquid: cuanto se ha movido y en que porcentaje. */
  const cambio = (m: Mercado | null) => {
    if (m === null || m.change24hPct === null) return '—';
    const abs = m.mark !== null && m.prevDayPx !== null ? m.mark - m.prevDayPx : null;
    const pct = `${m.change24hPct >= 0 ? '+' : ''}${m.change24hPct.toFixed(2)}%`;
    return abs === null ? pct : `${abs >= 0 ? '+' : ''}${precio(abs)} / ${pct}`;
  };
  const funding8h = (v: number | null) => v === null ? '—' : `${(v * 8 * 100).toFixed(4)}%`;
  const titulo = mercado?.name ?? coin;

  return <div className="traders-screen">
    <section className="trader-panel terminal-principal" aria-label="Hyperliquid chart">
      {/* La barra del mercado, como la de Hyperliquid: el par en grande, que
          abre el selector de mercados, y sus cifras del dia en la misma linea. */}
      <div className="terminal-barra">
        <div className="terminal-par-anclaje" ref={selectorRef}>
          <div className="terminal-par">
            <Estrella marcado={favoritos.es(coin)} que={titulo} onClick={() => favoritos.alternar(coin)} />
            <button className="terminal-par-boton" onClick={() => { setSelector((v) => !v); setBuscar(''); }}
              aria-expanded={selector} title="Ctrl+K">
              {titulo} <span className="terminal-par-flecha">{selector ? '▴' : '▾'}</span>
            </button>
            {mercado !== null && <Etiquetas m={mercado} />}
          </div>
          {selector && (
            <div className="terminal-selector" role="dialog" aria-label="Select market">
              <input className="terminal-selector-buscar" autoFocus value={buscar} placeholder="Search"
                onChange={(e) => setBuscar(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSelector(false);
                  // Intro elige el primero de la lista, como en su web.
                  if (e.key === 'Enter' && visibles[0] !== undefined) elegir(visibles[0]);
                }} />
              <div className="terminal-selector-pestanas">
                {[...PESTANAS_MERCADO, { id: 'fav', label: 'Favorites' }].map((p) => (
                  <button key={p.id} className={pestanaMercados === p.id ? 'active' : ''} onClick={() => setPestanaMercados(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="terminal-selector-tabla">
                <table>
                  <thead>
                    <tr>
                      <th />
                      {COLUMNAS_MERCADO.map((c) => (
                        <th key={c.id} className={c.id === 'name' ? 'clickable' : 'clickable num'} onClick={() => ordenarMercados(c.id)}>
                          {c.label}{ordenMercados.col === c.id ? (ordenMercados.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.length === 0 && (
                      <tr><td colSpan={7} className="none">{markets.length === 0 ? 'Loading markets…' : 'No market matches.'}</td></tr>
                    )}
                    {visibles.slice(0, 300).map((m) => (
                      <tr key={m.coin} className={m.coin === coin ? 'terminal-asset-on clickable' : 'clickable'}
                        onClick={() => elegir(m)}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <Estrella marcado={favoritos.es(m.coin)} que={m.name} onClick={() => favoritos.alternar(m.coin)} />
                        </td>
                        <td className="asset hl-mercado"><NombreConEtiquetas m={m} /></td>
                        <td className="num">{precio(m.mark)}</td>
                        <td className={`num ${signo(m.change24hPct)}`}>{cambio(m)}</td>
                        <td className={`num ${signo(m.fundingHourly)}`}>{funding8h(m.fundingHourly)}</td>
                        <td className="num">{usd(m.volume24hUsd)}</td>
                        <td className="num">{usd(m.openInterestUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="stat"><div className="label">Mark</div>
          <div className="stat-value">{precio(mercado?.mark ?? latest?.close ?? null)}</div></div>
        {mercado?.kind !== 'spot' && (
          <div className="stat"><div className="label">Oracle</div>
            <div className="stat-value">{precio(mercado?.oracle ?? null)}</div></div>
        )}
        <div className="stat"><div className="label">24h change</div>
          <div className={`stat-value ${signo(mercado?.change24hPct ?? null)}`}>{cambio(mercado)}</div></div>
        <div className="stat"><div className="label">24h volume</div>
          <div className="stat-value">{usd(mercado?.volume24hUsd ?? null)}</div></div>
        {mercado?.kind !== 'spot' && (
          <>
            <div className="stat"><div className="label">Open interest</div>
              <div className="stat-value" title="As Hyperliquid publishes it">{usd(mercado?.openInterestUsd ?? null)}</div></div>
            <div className="stat"><div className="label">Funding / countdown</div>
              <div className="stat-value">
                <span className={signo(mercado?.fundingHourly ?? null)}>
                  {mercado?.fundingHourly == null ? '—' : `${(mercado.fundingHourly * 100).toFixed(4)}%`}
                </span>{' '}<CuentaAtras hasta={catalogo?.nextFundingAt ?? null} />
              </div></div>
          </>
        )}
      </div>

      {marketError && <p className="degraded-note">Market list unavailable: {marketError}</p>}
      {(catalogo?.failed.length ?? 0) > 0 && <p className="degraded-note">Not answering now: {catalogo?.failed.join(', ')}</p>}

      {/* Grafico a la izquierda y libro a la derecha, como en Hyperliquid. */}
      <div className="terminal-grid">
        <div className="terminal-grafico">
          <div className="controls terminal-mandos">
            <div className="terminal-intervals" aria-label="Candle interval">
              {INTERVALS.map((v) => <button key={v} aria-pressed={interval === v} className={interval === v ? 'active' : ''} onClick={() => setIntervalValue(v)}>{v}</button>)}
            </div>
            <span className="terminal-sep" aria-hidden="true" />
            {/* Medias de cualquier periodo, y varias a la vez. Se calculan sobre
                las velas que ya estan en memoria: anadir una no pide nada. */}
            <div className="terminal-intervals" aria-label="Add moving average">
              <button aria-pressed={nuevoTipo === 'ema'} className={nuevoTipo === 'ema' ? 'active' : ''} onClick={() => setNuevoTipo('ema')}>EMA</button>
              <button aria-pressed={nuevoTipo === 'sma'} className={nuevoTipo === 'sma' ? 'active' : ''} onClick={() => setNuevoTipo('sma')}>SMA</button>
              <input className="terminal-periodo" type="number" min={2} max={500} value={nuevoPeriodo} aria-label="Period"
                onChange={(e) => setNuevoPeriodo(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') anadirMedia(); }} />
              <button onClick={anadirMedia}>Add</button>
            </div>
            <span className="terminal-sep" aria-hidden="true" />
            <div className="terminal-intervals" aria-label="Indicators">
              {FIJOS.map((f) => (
                <button key={f.id} aria-pressed={activos.includes(f.id)} className={activos.includes(f.id) ? 'active' : ''} onClick={() => alternar(f.id)}>{f.label}</button>
              ))}
              <button aria-pressed={log} className={log ? 'active' : ''} onClick={() => setLog((v) => !v)} title="Logarithmic price scale">Log</button>
            </div>
            <span className="terminal-sep" aria-hidden="true" />
            {/* El aspecto del grafico: fondo, velas y rejilla. */}
            <div className="terminal-intervals menu-anclaje" ref={estiloRef}>
              <button aria-expanded={estilo} className={estilo ? 'active' : ''} onClick={() => setEstilo((v) => !v)}>Style {estilo ? '▴' : '▾'}</button>
              {estilo && (
                <div className="terminal-estilo" role="dialog" aria-label="Chart style">
                  <span className="label">Background</span>
                  <div className="terminal-muestras">
                    {FONDOS.map((f) => (
                      <button key={f.id} className={apariencia.fondo === f.color ? 'active' : ''} onClick={() => cambiarApariencia({ fondo: f.color })}>
                        <span className="terminal-muestra" style={{ background: f.color || 'var(--bg)' }} />{f.label}
                      </button>
                    ))}
                    <label className="terminal-color" title="Any color">
                      <input type="color" value={apariencia.fondo || '#010612'} onChange={(e) => cambiarApariencia({ fondo: e.target.value })} />
                      Custom
                    </label>
                  </div>
                  <span className="label">Candles</span>
                  <div className="terminal-muestras">
                    {VELAS.map((v) => (
                      <button key={v.id} className={apariencia.subida === v.subida && apariencia.bajada === v.bajada ? 'active' : ''}
                        onClick={() => cambiarApariencia({ subida: v.subida, bajada: v.bajada })}>
                        <span className="terminal-muestra" style={{ background: v.subida || 'var(--pos)' }} />
                        <span className="terminal-muestra" style={{ background: v.bajada || 'var(--neg)' }} />{v.label}
                      </button>
                    ))}
                  </div>
                  <span className="label">Grid</span>
                  <div className="terminal-muestras">
                    <button className={apariencia.rejilla ? 'active' : ''} onClick={() => cambiarApariencia({ rejilla: true })}>On</button>
                    <button className={!apariencia.rejilla ? 'active' : ''} onClick={() => cambiarApariencia({ rejilla: false })}>Off</button>
                    <button onClick={() => cambiarApariencia(APARIENCIA_INICIAL)}>Reset</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          {activos.some((id) => /^(ema|sma)-/.test(id)) && (
            <div className="terminal-chips" aria-label="Active moving averages">
              {activos.filter((id) => /^(ema|sma)-/.test(id)).map((id) => (
                <button key={id} className="terminal-chip" title={`Remove ${etiqueta(id)}`} onClick={() => alternar(id)}>
                  <span className="legend-dot" style={{ background: indicadores.find((i) => i.id === id)?.color ?? 'transparent' }} />
                  {etiqueta(id)} ×
                </button>
              ))}
            </div>
          )}

          {(error || (age !== null && age > 90)) && <p className="degraded-note">Chart not current. {error ?? 'Updates delayed.'} {data && 'Showing the last successful snapshot.'}</p>}
          {oldCandle && <p className="degraded-note">No recent candle from the venue. Last candle opened {new Date(latest.t).toISOString()}.</p>}
          {latest === undefined && <p className="none">{error ? 'Data unavailable' : 'Loading candles…'}</p>}
          {data && velas.length === 0 && <p className="none">No candles available for this market.</p>}

          <CandleChart key={coin + interval} velas={velas} height={altoGrafico} priceFormat={priceFormat}
            indicadores={indicadores} marcas={marcas} escalaLog={log} titulo={`${titulo} · ${interval}`} apariencia={apariencia} />
          <p className="none">
            {age !== null ? `${age}s ago` : 'loading'} · UTC · latest candle may still be open
            {marcas.length > 0 && ' · arrows mark entries and circles mark exits of followed wallets'}
          </p>
        </div>

        <section className="terminal-book" aria-label="Order book and trades">
          <div className="terminal-pestanas terminal-pestanas-libro" role="tablist">
            <button role="tab" aria-selected={panelLibro === 'book'} className={panelLibro === 'book' ? 'active' : ''} onClick={() => setPanelLibro('book')}>Order book</button>
            <button role="tab" aria-selected={panelLibro === 'trades'} className={panelLibro === 'trades' ? 'active' : ''} onClick={() => setPanelLibro('trades')}>Trades</button>
          </div>
          {panelLibro === 'book' && (profundidad === null ? (
            <p className="none">{libro === null ? 'Loading book…' : 'No book from this venue.'}</p>
          ) : (
            <table>
              <thead>
                <tr><th className="num">Price</th><th className="num">Size ({mercado?.base ?? ''})</th><th className="num">Total ({mercado?.base ?? ''})</th></tr>
              </thead>
              <tbody>
                {[...profundidad.asks].reverse().map((n) => (
                  <tr key={'a' + n.price} className="book-ask">
                    <td className="num neg">{precio(n.price)}</td>
                    <td className="num">{n.size.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    <td className="num none">{n.total.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    <td className="book-barra" style={{ width: ancho(n.total) }} />
                  </tr>
                ))}
                <tr className="book-spread">
                  <td colSpan={3} className="num">
                    {profundidad.spread === null ? '—' : `Spread ${precio(profundidad.spread)} · ${profundidad.spreadPct?.toFixed(3)}%`}
                  </td>
                </tr>
                {profundidad.bids.map((n) => (
                  <tr key={'b' + n.price} className="book-bid">
                    <td className="num pos">{precio(n.price)}</td>
                    <td className="num">{n.size.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    <td className="num none">{n.total.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    <td className="book-barra" style={{ width: ancho(n.total) }} />
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          {panelLibro === 'trades' && (cinta === null ? (
            <p className="none">Loading trades…</p>
          ) : cinta.trades.length === 0 ? (
            <p className="none">No recent trades.</p>
          ) : (
            <div className="terminal-cinta">
              <table>
                <thead>
                  <tr><th className="num">Price</th><th className="num">Size ({mercado?.base ?? ''})</th><th className="num">Time</th></tr>
                </thead>
                <tbody>
                  {cinta.trades.map((t) => (
                    <tr key={t.tid}>
                      <td className={`num ${t.side === 'buy' ? 'pos' : 'neg'}`}>{precio(t.px)}</td>
                      <td className="num">{t.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                      <td className="num none">{new Date(t.ts).toLocaleTimeString('en-GB', { hour12: false })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {panelLibro === 'book' && libro !== null && <div className="none">{Math.max(0, Math.round((clock - libro.at) / 1000))}s ago</div>}
        </section>
      </div>
    </section>

    {/* Abajo, pestanas como las de Hyperliquid. Aqui no hay cuenta propia:
        son las wallets que sigues. */}
    <section className="trader-panel">
      <div className="terminal-pestanas" role="tablist">
        {PESTANAS.map((p) => (
          <button key={p.id} role="tab" aria-selected={pestana === p.id} className={pestana === p.id ? 'active' : ''}
            onClick={() => setPestana(p.id)}>{p.id === 'fills' ? `Followed trades on ${titulo}` : p.label}</button>
        ))}
      </div>
      {pestana === 'fills' && (
        ejecuciones !== null && ejecuciones.traders.length === 0 ? (
          <p className="none">
            No wallet followed yet.{' '}
            <a href={href('trading', 'traders')} onClick={(e) => { e.preventDefault(); navegar(href('trading', 'traders')); }}>Add one in Hyperliquid Tracker</a>
          </p>
        ) : recientes.length === 0 ? (
          <p className="none">{ejecuciones === null ? 'Loading executions…' : `No execution on ${titulo} in this window that passes each wallet's filters.`}</p>
        ) : (
          <div className="table-wrap terminal-fills">
            <table>
              <thead>
                <tr><th>Time (UTC)</th><th>Wallet</th><th>Action</th><th className="num">Price</th><th className="num">Size</th><th className="num">Notional</th><th className="num">% of account</th><th className="num">Realised PnL</th></tr>
              </thead>
              <tbody>
                {recientes.map((f) => (
                  <tr key={f.tid}>
                    <td className="num none">{new Date(f.ts).toISOString().slice(5, 19).replace('T', ' ')}</td>
                    <td className="asset">{nombre(f.traderId)}</td>
                    <td className={f.side === 'long' ? 'pos' : 'neg'}>{f.dir === '' ? f.side : f.dir}</td>
                    <td className="num">{precio(f.px)}</td>
                    <td className="num">{f.sz.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                    <td className="num">{usd(f.notionalUsd)}</td>
                    {/* Por debajo de una centesima se dice "<0.01%" y no "0.00%":
                        cero seria una operacion que no mueve nada, y no es eso. */}
                    <td className="num">{f.accountPct === null ? '—' : f.accountPct < 0.01 ? '<0.01%' : `${f.accountPct.toFixed(2)}%`}</td>
                    <td className={`num ${f.closedPnl === null || f.closedPnl === 0 ? 'none' : f.closedPnl > 0 ? 'pos' : 'neg'}`}>
                      {f.closedPnl === null || f.closedPnl === 0 ? '—' : usd(f.closedPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {pestana === 'positions' && <TraderPanel panel="positions" />}
      {pestana === 'consensus' && <TraderPanel panel="consensus" />}
      {pestana === 'assets' && <TraderPanel panel="assets" />}
    </section>
  </div>;
}
