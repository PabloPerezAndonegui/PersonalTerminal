import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Economic Calendar.
 *
 * Dos vistas: la tabla de la semana por dias (ForexFactory, ver `TablaSemana`)
 * y el widget de TradingView, que es el que trae el dato real publicado.
 *
 * El widget es contenido que no produce esta app: lo pinta TradingView. Por eso se monta como iframe **directo** a su URL de widget, en
 * vez de cargar su script de embebido, que es lo que hace todo el mundo. La
 * diferencia importa: el script se ejecutaria dentro de nuestra pagina, con
 * acceso a su DOM y a su almacenamiento; el iframe queda al otro lado de la
 * frontera de origen que ya impone el navegador, y ademas va en `sandbox`, asi
 * que no puede sacarnos de la app ni enviar formularios.
 *
 * Como el widget lo carga el navegador y no el servidor, el servidor no puede
 * saber si aparecio. Se le reporta desde aqui, y por eso Data Sources puede
 * decir la verdad sobre esta fuente en vez de suponerla.
 */

const BASE = import.meta.env['DEV'] ? 'http://127.0.0.1:8080' : '';
const FUENTE = 'tradingview-calendar';

/**
 * Si no ha cargado en este tiempo, se da por caida y se dice.
 *
 * Holgado a proposito: medido, el widget tarda unos 11 s en pintarse con la
 * red de casa. Un umbral ajustado daria rojos falsos en cuanto la conexion
 * fuese algo peor, y un rojo falso en el semaforo es peor que un amarillo
 * lento — mientras tanto pone 'Loading', que es la verdad.
 */
const TIMEOUT_MS = 30_000;

const IMPORTANCIA = {
  all: { label: 'All', filter: '-1,0,1' },
  medium: { label: 'Medium & high', filter: '0,1' },
  high: { label: 'High only', filter: '1' },
} as const;

const REGION = {
  major: { label: 'Major', filter: 'us,eu,gb,jp,cn' },
  us: { label: 'US only', filter: 'us' },
  wide: { label: 'Wide', filter: 'us,eu,gb,jp,cn,de,fr,ca,au,ch,in,br,kr,mx' },
} as const;

type ImportanciaId = keyof typeof IMPORTANCIA;
type RegionId = keyof typeof REGION;

/**
 * URL del widget. Es la misma que construye el script de embebido de
 * TradingView: la configuracion viaja en el fragmento, codificada.
 */
function urlWidget(importancia: ImportanciaId, region: RegionId): string {
  const config = {
    colorTheme: 'dark',
    isTransparent: true,
    locale: 'en',
    countryFilter: REGION[region].filter,
    importanceFilter: IMPORTANCIA[importancia].filter,
    width: '100%',
    height: 640,
  };
  return `https://s.tradingview.com/embed-widget/events/?locale=en#${encodeURIComponent(JSON.stringify(config))}`;
}

function WidgetTradingView({ vista }: { vista: ReactNode }) {
  const [importancia, setImportancia] = useState<ImportanciaId>('medium');
  const [region, setRegion] = useState<RegionId>('major');
  const [estado, setEstado] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [tardo, setTardo] = useState<number | null>(null);
  const desde = useRef(Date.now());

  const [intento, setIntento] = useState(0);

  const url = useMemo(() => urlWidget(importancia, region), [importancia, region]);
  // Remontar el iframe es la unica forma de reconfigurarlo: el widget lee el
  // fragmento una sola vez, al cargarse.
  //
  // Deliberadamente NO entra aqui el refresco global de la app. El embebido
  // tarda segundos en pintarse y no lo alimenta nuestro collector: recargarlo
  // en cada ciclo lo dejaria en "loading" para siempre.
  const clave = `${url}|${intento}`;

  useEffect(() => {
    desde.current = Date.now();
    setEstado('loading');
    setTardo(null);
  }, [clave]);

  useEffect(() => {
    if (estado !== 'loading') return undefined;
    const t = setTimeout(() => {
      setEstado('failed');
      void reportar(false, null, `the widget did not load within ${TIMEOUT_MS / 1000} s`);
    }, TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [estado, clave]);

  function alCargar() {
    const ms = Date.now() - desde.current;
    setTardo(ms);
    setEstado('ok');
    void reportar(true, ms, null);
  }

  return (
    <>

      <div className="controls">
        {vista}
        <div className="control-group">
          <span className="label">Importance</span>
          <div className="segmented">
            {(Object.keys(IMPORTANCIA) as ImportanciaId[]).map((k) => (
              <button key={k} type="button" className={k === importancia ? 'seg seg-active' : 'seg'}
                onClick={() => setImportancia(k)}>{IMPORTANCIA[k].label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="label">Countries</span>
          <div className="segmented">
            {(Object.keys(REGION) as RegionId[]).map((k) => (
              <button key={k} type="button" className={k === region ? 'seg seg-active' : 'seg'}
                onClick={() => setRegion(k)}>{REGION[k].label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="label">Embed</span>
          {/*
            Un widget de terceros que no carga deja un hueco en blanco, y un
            hueco en blanco se lee como "no hay eventos hoy". Por eso el estado
            se dice, y con texto ademas de color.
          */}
          <span className={estado === 'ok' ? 'light light-green' : estado === 'failed' ? 'light light-red' : 'light light-yellow'}>
            {estado === 'ok' ? `Loaded in ${(tardo ?? 0) < 1000 ? `${tardo} ms` : `${((tardo ?? 0) / 1000).toFixed(1)} s`}`
              : estado === 'failed' ? 'Did not load' : 'Loading…'}
          </span>
          <button type="button" className="seg" onClick={() => setIntento((n) => n + 1)}>Reload</button>
        </div>
      </div>

      {estado === 'failed' && (
        <div className="degraded-note">
          Calendar did not load.{' '}
          <a href="https://www.tradingview.com/economic-calendar/" target="_blank" rel="noreferrer noopener">
            Open on TradingView
          </a>
        </div>
      )}

      <div className="embed-frame">
        <iframe
          key={clave}
          src={url}
          title="Economic calendar"
          onLoad={alCargar}
          // Sin loading="lazy": el marco queda bajo el pliegue y el navegador
          // no lo cargaria hasta hacer scroll, asi que el timeout lo daria por
          // caido sin que nada estuviese roto.
          // Sin `allow-top-navigation` ni `allow-forms`: el embebido no puede
          // sacarnos de la app ni mandar nada a ningun sitio desde aqui.
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
        />
      </div>
    </>
  );
}

/**
 * Le dice al servidor si el widget se pinto. El fallo al reportar se ignora a
 * proposito: es telemetria de salud, y no tiene sentido que romperla rompa
 * ademas la pantalla que estaba funcionando.
 */
async function reportar(ok: boolean, loadMs: number | null, reason: string | null): Promise<void> {
  try {
    await fetch(`${BASE}/api/widget-health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: FUENTE, ok, loadMs, reason }),
    });
  } catch {
    // Sin API no hay a quien reportar; la pantalla sigue igual de util.
  }
}

interface CalendarResponse {
  readonly available: boolean;
  readonly reason: string | null;
  readonly asOf: number | null;
  readonly stale: boolean;
  readonly events: readonly {
    readonly id: string;
    readonly title: string;
    readonly currency: string;
    readonly at: number;
    readonly impact: 'high' | 'medium' | 'low' | 'holiday';
    readonly forecast: string | null;
    readonly previous: string | null;
  }[];
}

const IMPACTO_TABLA = {
  high: { label: 'High only', incluye: ['high'] as readonly string[] },
  medium: { label: 'Medium & high', incluye: ['high', 'medium'] as readonly string[] },
  all: { label: 'All', incluye: ['high', 'medium', 'low', 'holiday'] as readonly string[] },
} as const;

const DIVISAS = {
  major: { label: 'Major', incluye: ['USD', 'EUR', 'GBP', 'JPY', 'CNY'] as readonly string[] | null },
  usd: { label: 'USD only', incluye: ['USD'] as readonly string[] | null },
  all: { label: 'All', incluye: null as readonly string[] | null },
} as const;

const IMPACTO_CELDA: Record<string, { texto: string; clase: string }> = {
  high: { texto: 'High', clase: 'light light-red' },
  medium: { texto: 'Medium', clase: 'light light-yellow' },
  low: { texto: 'Low', clase: 'light' },
  holiday: { texto: 'Holiday', clase: 'none' },
};

/** "Tuesday, Nov 17" en la hora local de quien mira. */
const diaLocal = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const horaLocal = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

type Evento = CalendarResponse['events'][number];

/**
 * La semana agrupada por dias, en la hora local del navegador.
 *
 * Lo pasado se atenua y el siguiente evento se marca: lo que se viene a mirar
 * es que queda por salir hoy y que mueve el mercado esta semana.
 */
function TablaSemana({ vista }: { vista: ReactNode }) {
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [impacto, setImpacto] = useState<keyof typeof IMPACTO_TABLA>('medium');
  const [divisas, setDivisas] = useState<keyof typeof DIVISAS>('major');

  useEffect(() => {
    let vivo = true;
    fetch(`${BASE}/api/calendar`)
      .then((r) => r.json() as Promise<CalendarResponse>)
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, []);

  const dias = useMemo(() => {
    const imp = IMPACTO_TABLA[impacto].incluye;
    const div = DIVISAS[divisas].incluye;
    const grupos: { dia: string; eventos: Evento[] }[] = [];
    for (const e of data?.events ?? []) {
      if (!imp.includes(e.impact) || (div !== null && !div.includes(e.currency))) continue;
      const dia = diaLocal(e.at);
      const ultimo = grupos.at(-1);
      if (ultimo?.dia === dia) ultimo.eventos.push(e);
      else grupos.push({ dia, eventos: [e] });
    }
    return grupos;
  }, [data, impacto, divisas]);

  const ahora = Date.now();
  const siguiente = dias.flatMap((g) => g.eventos).find((e) => e.at > ahora)?.id ?? null;
  const hoy = diaLocal(ahora);

  if (error !== null) return <>{vista}<p className="light light-red">Could not load the calendar: {error}</p></>;
  if (data !== null && !data.available) return <>{vista}<div className="degraded-note">Calendar source not answering: {data.reason}</div></>;

  return (
    <>
      <div className="controls">
        {vista}
        <div className="control-group">
          <span className="label">Impact</span>
          <div className="segmented">
            {(Object.keys(IMPACTO_TABLA) as (keyof typeof IMPACTO_TABLA)[]).map((k) => (
              <button key={k} type="button" className={k === impacto ? 'seg seg-active' : 'seg'}
                onClick={() => setImpacto(k)}>{IMPACTO_TABLA[k].label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="label">Currencies</span>
          <div className="segmented">
            {(Object.keys(DIVISAS) as (keyof typeof DIVISAS)[]).map((k) => (
              <button key={k} type="button" className={k === divisas ? 'seg seg-active' : 'seg'}
                onClick={() => setDivisas(k)}>{DIVISAS[k].label}</button>
            ))}
          </div>
        </div>
      </div>

      {data?.stale === true && (
        <div className="degraded-note">Calendar from {new Date(data.asOf ?? 0).toLocaleString()}</div>
      )}

      <div className="table-wrap calendario">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Currency</th>
              <th>Impact</th>
              <th>Event</th>
              <th>Forecast</th>
              <th>Previous</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={6} className="none">Loading…</td></tr>
            ) : dias.length === 0 ? (
              <tr><td colSpan={6} className="none">No event matches these filters this week.</td></tr>
            ) : dias.flatMap((g) => [
              <tr key={g.dia} className="cal-dia">
                <td colSpan={6}>{g.dia}{g.dia === hoy && <span className="cal-hoy"> · today</span>}</td>
              </tr>,
              ...g.eventos.map((e) => {
                const imp = IMPACTO_CELDA[e.impact] ?? IMPACTO_CELDA['low'];
                const clase = e.at <= ahora ? 'cal-pasado' : e.id === siguiente ? 'cal-siguiente' : undefined;
                return (
                  <tr key={e.id} className={clase}>
                    <td className="num">{horaLocal(e.at)}</td>
                    <td><strong>{e.currency}</strong></td>
                    <td><span className={imp?.clase}>{imp?.texto}</span></td>
                    <td className="cal-evento">{e.title}</td>
                    <td className="num">{e.forecast ?? <span className="none">—</span>}</td>
                    <td className="num">{e.previous ?? <span className="none">—</span>}</td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
      </div>
    </>
  );
}

const VISTAS = {
  table: 'This week',
  widget: 'TradingView, with actuals',
} as const;

/**
 * Dos vistas. La tabla propia es la de leer la semana: agrupada por dias y con
 * columnas propias. El widget de TradingView se queda porque es el unico que
 * trae el dato real publicado.
 */
export function Calendar() {
  const [vista, setVista] = useState<keyof typeof VISTAS>('table');
  // El selector de vista va DENTRO del panel de controles de cada vista: un
  // solo panel por pantalla, como en el resto de secciones.
  const selector = (
    <div className="control-group">
      <span className="label">View</span>
      <div className="segmented">
        {(Object.keys(VISTAS) as (keyof typeof VISTAS)[]).map((k) => (
          <button key={k} type="button" className={k === vista ? 'seg seg-active' : 'seg'}
            onClick={() => setVista(k)}>{VISTAS[k]}</button>
        ))}
      </div>
    </div>
  );
  return vista === 'table' ? <TablaSemana vista={selector} /> : <WidgetTradingView vista={selector} />;
}
