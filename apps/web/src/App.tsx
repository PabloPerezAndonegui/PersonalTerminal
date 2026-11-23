import { TradersProvider } from './components/tradersState.tsx';
import { Terminal } from './screens/Terminal.tsx';
import { useCallback, useEffect, useState } from 'react';
import { getJson, subscribe, fmt, type Menu } from './api.ts';
import { href, navegar, redirigirRutaVieja, useRuta } from './router.ts';
import { Home, PanelDatos, PENDIENTES, PARCIALES } from './screens/Home.tsx';
import { DataSources } from './screens/DataSources.tsx';
import { Funding } from './screens/Funding.tsx';
import { DexVolume } from './screens/DexVolume.tsx';
import { Explorer } from './screens/Explorer.tsx';
import { Parity } from './screens/Parity.tsx';
import { PoolsYields } from './screens/PoolsYields.tsx';
import { Bridges } from './screens/Bridges.tsx';
import { Points } from './screens/Points.tsx';
import { Calendar } from './screens/Calendar.tsx';
import { Traders } from './screens/Traders.tsx';
import { OpenInterest } from './screens/OpenInterest.tsx';
import { ProtocolCompare } from './screens/ProtocolCompare.tsx';

/**
 * Shell de la aplicacion.
 *
 * Una terminal con dos areas: DeFi y Trading. La portada es la
 * eleccion entre ellas y dentro de cualquiera hay un boton de Inicio.
 *
 * La navegacion la sirve el backend en /api/sections, areas incluidas: anadir o
 * mover una pestana se hace en un solo sitio. El enrutado va por ruta real, no
 * por hash, para poder recargar y usar atras y adelante (ver router.ts).
 */

interface Health {
  readonly ok: boolean;
  readonly lastCycle: { at: number; ok: number; failed: number; freshSymbols: number; findings: number } | null;
  readonly venues: readonly string[];
  readonly sources: {
    readonly total: number;
    readonly ok: number;
    readonly degraded: readonly string[];
    readonly down: readonly string[];
    /** Del venue que lleva mas sin un ciclo bueno: la edad real de lo visible. */
    readonly oldestOkAt: number | null;
  };
}

export function App() {
  return <TradersProvider><AppContent /></TradersProvider>;
}

function AppContent() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const ruta = useRuta();
  const [health, setHealth] = useState<Health | null>(null);
  const [live, setLive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<Menu>('/api/sections')
      .then((m) => {
        setMenu(m);
        // Enlaces guardados de antes de dividir en areas: #/parity -> /defi/parity.
        redirigirRutaVieja((id) => m.sections.find((s) => s.id === id)?.area ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const recargar = useCallback(() => {
    setRefreshKey((k) => k + 1);
    getJson<Health>('/api/health').then(setHealth).catch(() => undefined);
  }, []);

  useEffect(() => {
    recargar();
    return subscribe(recargar, setLive);
  }, [recargar]);

  if (error !== null) {
    return (
      <main className="shell">
        <p className="light light-red">
          Cannot reach the API: {error}. Start it with <code>npm run api</code>.
        </p>
      </main>
    );
  }

  if (menu === null) return <main className="shell"><p className="none carga-inicial">Loading…</p></main>;

  const area = menu.areas.find((a) => a.id === ruta.area) ?? null;

  // Portada: sin area, o con un area que no existe.
  if (area === null) {
    return (
      <div className="shell">
        <header className="topbar">
          <div className="topbar-row">
            <span className="brand">Terminal</span>
          </div>
        </header>
        {/* El panel de datos debajo de la franja, en su esquina derecha: dentro
            de la franja se montaba encima del borde. */}
        <div className="portada-datos">
          <PanelDatos area={menu.areas.find((a) => a.id === 'data')} />
        </div>
        <main>
          <Home areas={menu.areas} sections={menu.sections} />
        </main>
      </div>
    );
  }

  const propias = menu.sections.filter((s) => s.area === area.id);
  // Entrar al area sin seccion, o con una que no es suya, lleva a su entrada.
  const actual = propias.find((s) => s.id === ruta.section) ?? propias.find((s) => s.id === area.defaultSection) ?? propias[0] ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-row">
          <a className="home-link" href="/" onClick={(e) => { e.preventDefault(); navegar('/'); }}>← Home</a>
          <span className="brand">{area.label}</span>
        </div>
        {/* Un area de una sola seccion no necesita menu. */}
        {propias.length > 1 && (
          <nav>
            {propias.map((s) => (
              <a
                key={s.id}
                href={href(area.id, s.id)}
                className={s.id === actual?.id ? 'tab tab-active' : 'tab'}
                onClick={(e) => { e.preventDefault(); navegar(href(area.id, s.id)); }}
              >
                {s.label}
                {(PARCIALES[s.id] !== undefined || PENDIENTES.has(s.id)) && (
                  <span className="tab-pending" title={PARCIALES[s.id] ?? 'Not built yet'}> ·</span>
                )}
              </a>
            ))}
          </nav>
        )}
      </header>

      <Barra health={health} live={live} />

      <main>{actual === null ? <p className="none">Unknown section.</p> : <Pantalla id={actual.id} refreshKey={refreshKey} />}</main>
    </div>
  );
}

/** Que pantalla corresponde a cada seccion. */
function Pantalla({ id, refreshKey }: { id: string; refreshKey: number }) {
  if (id === 'terminal') return <Terminal />;
  if (id === 'traders') return <Traders />;
  if (id === 'open-interest') return <OpenInterest refreshKey={refreshKey} />;
  if (id === 'protocol-compare') return <ProtocolCompare refreshKey={refreshKey} />;
  switch (id) {
    case 'funding-scanner': return <Funding refreshKey={refreshKey} />;
    case 'dex-volume': return <DexVolume refreshKey={refreshKey} />;
    case 'explorer': return <Explorer refreshKey={refreshKey} />;
    case 'parity': return <Parity refreshKey={refreshKey} />;
    case 'pools-yields': return <PoolsYields refreshKey={refreshKey} />;
    case 'bridges': return <Bridges refreshKey={refreshKey} />;
    case 'points': return <Points refreshKey={refreshKey} />;
    case 'calendar': return <Calendar />;
    case 'data-sources': return <DataSources refreshKey={refreshKey} />;
    default: return <p className="none">Unknown section.</p>;
  }
}

/**
 * Barra de estado. Va en todas las areas: el estado de las fuentes no es de
 * DeFi, es de la aplicacion.
 */
function Barra({ health, live }: { health: Health | null; live: boolean }) {
  const cycle = health?.lastCycle ?? null;
  const fuentes = health?.sources;

  return (
    <div className="statusbar">
      {/*
        Si el flujo se corta, hay que decirlo. Una pantalla que aparenta estar
        en vivo mientras muestra datos congelados es peor que una que avisa.
      */}
      <span className={live ? 'light light-green' : 'light light-yellow'}>
        {live ? 'Live' : 'Reconnecting, data may be stale'}
      </span>
      {/*
        "Live" solo dice que el flujo esta abierto. Un venue congelado no lo
        corta, asi que el estado de las FUENTES va aparte, y enlaza a la
        pantalla que lo explica, este uno en el area que este.
      */}
      <a
        className="estado-fuentes"
        href={href('defi', 'data-sources')}
        onClick={(e) => { e.preventDefault(); navegar(href('defi', 'data-sources')); }}
      >
        {fuentes === undefined ? (
          <span className="none">{health?.venues.length ?? 0} venues</span>
        ) : fuentes.down.length > 0 ? (
          <span className="light light-red" title={`Down: ${fuentes.down.join(', ')}`}>
            {fuentes.down.length} of {fuentes.total} sources down
          </span>
        ) : fuentes.degraded.length > 0 ? (
          <span className="light light-yellow" title={`Degraded: ${fuentes.degraded.join(', ')}`}>
            {fuentes.degraded.length} of {fuentes.total} sources degraded
          </span>
        ) : (
          <span className="light light-green">{fuentes.ok} of {fuentes.total} sources OK</span>
        )}
      </a>
      <span className="none">{fmt.int(cycle?.freshSymbols ?? null)} symbols</span>
      {cycle !== null && cycle.findings > 0 && (
        <span className="light light-yellow">{cycle.findings} data issues</span>
      )}
      <span className="none">cycle {fmt.ago(cycle?.at ?? null)}</span>
      {/* La edad que importa no es la del ciclo, sino la del dato mas viejo
          que sigue en pantalla: un venue puede llevar horas sin refrescar
          mientras el ciclo va puntual. */}
      {fuentes?.oldestOkAt != null && (
        <span className={Date.now() - fuentes.oldestOkAt > 10 * 60_000 ? 'light light-yellow' : 'none'}>
          oldest data {fmt.ago(fuentes.oldestOkAt)}
        </span>
      )}
    </div>
  );
}
