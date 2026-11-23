import { useEffect, useRef, useState } from 'react';
import { getJson, fmt, type OpenInterestResponse, usd } from '../api.ts';
import { useFavoritos, Estrella } from '../components/favoritos.tsx';
import { useTipoVenue, deTipo, FiltroTipo } from '../components/tipoVenue.tsx';

/**
 * Comparador de dos protocolos.
 *
 * Cuantas veces es uno mayor que el otro, metrica a metrica. Vive en su propia
 * pestana y no dentro de Open Interest porque son dos preguntas distintas:
 * alli se mira donde esta el riesgo abierto, y aqui se comparan dos casas.
 *
 * **Cada metrica viene de un sitio distinto y eso importa.** El interes
 * abierto es de la API del venue o de DefiLlama segun la fila; el volumen solo
 * existe donde venia en la MISMA respuesta que el interes abierto, porque el
 * endpoint de volumen de derivados de DefiLlama paso a plan de pago; y los
 * ingresos son de DefiLlama, cruzados por su IDENTIFICADOR y no por el nombre.
 * Lo que no se sabe sale como hueco y nunca como cero, y cada fila lleva su
 * procedencia en el titulo.
 *
 * **Cada venue tiene su color**: su nombre, su columna
 * y el ratio de las filas que gana. Asi se ve de un vistazo quien gana en que.
 */

const CLAVE = 'compare.pair';

/**
 * Cuantas veces es uno mayor que el otro.
 *
 * null si falta cualquiera de los dos o si el segundo es cero: una division
 * por cero no es "infinitamente mayor", es que no se puede comparar.
 */
function veces(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b === 0) return null;
  return a / b;
}

/**
 * La pareja con la que se abre la pantalla. dYdX es un DEX que leemos directo
 * y del que tenemos todas las metricas, asi que la comparacion de partida
 * ensena la pantalla haciendo lo que sabe hacer.
 */
const PAREJA_POR_DEFECTO: [string, string] = ['hyperliquid', 'dydx'];

function leer(): [string, string] {
  try {
    const v = localStorage.getItem(CLAVE);
    if (v === null) return PAREJA_POR_DEFECTO;
    const p = JSON.parse(v) as unknown;
    return Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string'
      ? [p[0], p[1]]
      : PAREJA_POR_DEFECTO;
  } catch {
    return PAREJA_POR_DEFECTO;
  }
}

/**
 * El interes abierto A DOS PATAS, siempre.
 *
 * Cada venue publica el suyo con una convencion: Variational a una pata,
 * Hyperliquid a dos. Comparar las cifras tal cual daria la mitad o el doble.
 * Se llevan todas a dos patas porque es como lo ensenan la mayoria de las
 * webs; el ratio sale igual que a una pata, que es
 * lo que importa, y la cifra se lee como la que publica el venue.
 *
 * Un venue cuya convencion no se conoce da null y la fila sale vacia: lo que
 * falta ahi no es el numero, es saber que significa.
 */
const dosPatas = (p: { oiUsd: number | null; convention: string }): number | null => {
  if (p.oiUsd === null) return null;
  if (p.convention === 'single') return p.oiUsd * 2;
  if (p.convention === 'double') return p.oiUsd;
  return null;
};

/** Que valor gana en cada fila: el mayor, el menor (comisiones) o ninguno. */
type Mejor = 'mayor' | 'menor' | null;

interface Metrica {
  readonly label: string;
  readonly a: number | null;
  readonly b: number | null;
  readonly dinero: boolean;
  readonly mejor: Mejor;
  readonly fuente: string;
}

export function ProtocolCompare({ refreshKey }: { refreshKey: number }) {
  const [pareja, setPareja] = useState<[string, string]>(leer);
  const [data, setData] = useState<OpenInterestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Cual de los dos desplegables esta abierto, si alguno. */
  const [abierto, setAbierto] = useState<0 | 1 | null>(null);
  const [buscar, setBuscar] = useState<[string, string]>(['', '']);
  const [tipo, setTipo] = useTipoVenue();
  // La misma lista para los dos selectores: es el mismo catalogo.
  const favoritos = useFavoritos('compare.fav');
  const primeroRef = useRef<HTMLDivElement>(null);
  const segundoRef = useRef<HTMLDivElement>(null);

  function cambiarBuscar(i: 0 | 1, v: string) {
    setBuscar((b) => (i === 0 ? [v, b[1]] : [b[0], v]));
  }

  // Un clic fuera cierra el desplegable, como en el resto de la aplicacion.
  useEffect(() => {
    if (abierto === null) return;
    const fuera = (e: MouseEvent) => {
      const n = e.target as Node;
      const caja = abierto === 0 ? primeroRef.current : segundoRef.current;
      if (caja !== null && !caja.contains(n)) setAbierto(null);
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [abierto]);

  useEffect(() => {
    let vivo = true;
    getJson<OpenInterestResponse>('/api/open-interest?range=1d')
      .then((d) => { if (vivo) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (vivo) setError(e instanceof Error ? e.message : String(e)); });
    return () => { vivo = false; };
  }, [refreshKey]);

  function elegir(i: 0 | 1, id: string) {
    const siguiente: [string, string] = i === 0 ? [id, pareja[1]] : [pareja[0], id];
    setPareja(siguiente);
    try { localStorage.setItem(CLAVE, JSON.stringify(siguiente)); } catch { /* preferencia */ }
  }

  // Ordenados por la cifra comparable, no por la cruda: ordenando por la cruda
  // un venue de dos patas se cuela por delante de otro del mismo tamano real.
  const protocolos = [...(data?.protocols ?? [])]
    .sort((x, y) => (dosPatas(y) ?? -1) - (dosPatas(x) ?? -1));
  const a = protocolos.find((p) => p.id === pareja[0]) ?? protocolos[0];
  const b = protocolos.find((p) => p.id === pareja[1]) ?? protocolos[1];

  const oiA = a === undefined ? null : dosPatas(a);
  const oiB = b === undefined ? null : dosPatas(b);

  const metricas: Metrica[] = a === undefined || b === undefined ? [] : [
    { label: 'Open interest, both sides', a: oiA, b: oiB, dinero: true, mejor: 'mayor',
      fuente: 'Venue API, or DefiLlama for protocols we do not read directly. A venue that reports one side is doubled' },
    { label: 'Volume 24h', a: a.volume24hUsd, b: b.volume24hUsd, dinero: true, mejor: 'mayor',
      fuente: 'Same response as open interest. Missing where the venue does not publish it' },
    { label: 'Revenue 24h', a: a.revenue24hUsd, b: b.revenue24hUsd, dinero: true, mejor: 'mayor',
      fuente: `DefiLlama, joined by its protocol id, updated ${fmt.ago(data?.revenueAsOf ?? null)}. Missing where DefiLlama has no revenue for the venue` },
    { label: 'Revenue 30d', a: a.revenue30dUsd, b: b.revenue30dUsd, dinero: true, mejor: 'mayor',
      fuente: 'DefiLlama, joined by its protocol id' },
    { label: 'Fees 24h', a: a.fees24hUsd, b: b.fees24hUsd, dinero: true, mejor: 'mayor',
      fuente: 'What users pay, not what the protocol keeps. DefiLlama, joined by its protocol id' },
    { label: 'Fees 30d', a: a.fees30dUsd, b: b.fees30dUsd, dinero: true, mejor: 'mayor',
      fuente: 'What users pay, not what the protocol keeps. DefiLlama, joined by its protocol id' },
    { label: 'TVL', a: a.tvlUsd, b: b.tvlUsd, dinero: true, mejor: 'mayor',
      fuente: 'DefiLlama, adding every entry that shares the same parent protocol' },
    { label: 'Markets', a: a.markets === 0 ? null : a.markets, b: b.markets === 0 ? null : b.markets,
      dinero: false, mejor: 'mayor', fuente: 'Markets we read from each venue, not its full catalogue' },
    // Comisiones: gana la mas BAJA. Es lo que paga quien opera.
    { label: 'Taker fee (bps)', a: a.takerBps, b: b.takerBps, dinero: false, mejor: 'menor',
      fuente: 'From our own registry, verified when the venue was integrated' },
    { label: 'Maker fee (bps)', a: a.makerBps, b: b.makerBps, dinero: false, mejor: 'menor',
      fuente: 'From our own registry, verified when the venue was integrated' },
    { label: 'Funding every (h)', a: a.fundingIntervalHours, b: b.fundingIntervalHours, dinero: false, mejor: null,
      fuente: 'Funding interval declared by the venue' },
    // Derivadas: dicen algo que ninguna de las dos dice por separado.
    { label: 'Open interest per market', dinero: true, mejor: 'mayor',
      a: oiA === null || a.markets === 0 ? null : oiA / a.markets,
      b: oiB === null || b.markets === 0 ? null : oiB / b.markets,
      fuente: 'Open interest (both sides) divided by the markets we read' },
    { label: 'Volume over open interest', dinero: false, mejor: null,
      a: a.volume24hUsd === null || oiA === null || oiA === 0 ? null : a.volume24hUsd / oiA,
      b: b.volume24hUsd === null || oiB === null || oiB === 0 ? null : b.volume24hUsd / oiB,
      fuente: 'Daily volume over open interest (both sides): how fast the book turns over' },
    { label: 'Open interest over TVL', dinero: false, mejor: null,
      a: oiA === null || a.tvlUsd === null || a.tvlUsd === 0 ? null : oiA / a.tvlUsd,
      b: oiB === null || b.tvlUsd === null || b.tvlUsd === 0 ? null : oiB / b.tvlUsd,
      fuente: 'Open risk per dollar of collateral sitting in the protocol' },
    { label: 'Revenue over open interest, annualised', dinero: false, mejor: 'mayor',
      a: a.revenue30dUsd === null || oiA === null || oiA === 0 ? null : (a.revenue30dUsd * 12) / oiA,
      b: b.revenue30dUsd === null || oiB === null || oiB === 0 ? null : (b.revenue30dUsd * 12) / oiB,
      fuente: 'Thirty day revenue times twelve, over open interest (both sides). What the venue earns per dollar of risk' },
  ];

  return (
    <div className="oi-pantalla">
      {/* Los dos selectores SON las fichas: el nombre grande, en su color. */}
      <div className="cmp-cabecera">
        {([0, 1] as const).map((i) => {
          const elegido = protocolos.find((p) => p.id === pareja[i]);
          const q = buscar[i].trim().toLowerCase();
          // El filtro de tipo solo afecta a lo que se lista: lo ya elegido se
          // queda aunque sea de otro tipo, para no cambiar la comparacion sola.
          const lista = favoritos.ordenar(
            protocolos.filter((p) => deTipo(p.kind, tipo)
              && (q === '' || p.label.toLowerCase().includes(q))),
            (p) => p.id,
          ).slice(0, 60);
          return (
            <div key={i} className="menu-anclaje cmp-lado" ref={i === 0 ? primeroRef : segundoRef}>
              {i === 1 && <span className="cmp-vs">vs</span>}
              <button
                className={`cmp-venue ${i === 0 ? 'cmp-a' : 'cmp-b'}`}
                title={elegido === undefined ? undefined : `${elegido.coverage}${elegido.fromDefillama ? ' · from DefiLlama' : ''}`}
                onClick={() => { setAbierto(abierto === i ? null : i); cambiarBuscar(i, ''); }}>
                {/* Mientras llegan los datos, "Pick one" haria creer que no hay nada elegido. */}
                {elegido?.label ?? (data === null ? 'Loading…' : 'Pick one')} <span className="cmp-flecha">{abierto === i ? '▴' : '▾'}</span>
              </button>
              {elegido?.url != null && (
                <a className="cmp-enlace" href={elegido.url} target="_blank" rel="noreferrer noopener"
                  title={`Open ${elegido.label}`}>↗</a>
              )}
              {abierto === i && (
                <div className="menu">
                  <input className="menu-buscar" type="search" autoFocus value={buscar[i]}
                    placeholder="Filter protocols"
                    onChange={(e) => cambiarBuscar(i, e.target.value)} />
                  <FiltroTipo tipo={tipo} onCambiar={setTipo} />
                  {lista.length === 0 && <div className="menu-vacio">No protocol matches.</div>}
                  {lista.map((p) => (
                    <div key={p.id} className="menu-fila">
                      <Estrella marcado={favoritos.es(p.id)} que={p.label}
                        onClick={() => favoritos.alternar(p.id)} />
                      <button
                        className={p.id === pareja[i] ? 'menu-item menu-item-on' : 'menu-item'}
                        onClick={() => { elegir(i, p.id); setAbierto(null); }}>
                        <span className="menu-check">{p.id === pareja[i] ? '×' : ''}</span>
                        <span className="menu-label">{p.label}</span>
                        <span className="menu-cifra">{usd(dosPatas(p))}</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error !== null && <p className="light light-red">{error}</p>}
      {data !== null && protocolos.length === 0 && <p className="none">No protocol data yet.</p>}

      {a !== undefined && b !== undefined && (
        <div className="table-wrap cmp-tabla">
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th className="num cmp-col-a">{a.label}</th>
                <th className="num cmp-col-b">{b.label}</th>
                <th className="num ratio-col">Ratio</th>
              </tr>
            </thead>
            <tbody>
              {metricas.map((m) => {
                const r = veces(m.a, m.b);
                const texto = (v: number | null) => (m.dinero
                  ? usd(v)
                  : v === null ? '—' : v < 10 ? v.toFixed(2) : fmt.int(v));
                // Quien gana la fila. Empate o sin criterio: nadie.
                const gana: 'a' | 'b' | null = r === null || r === 1 || m.mejor === null
                  ? null
                  : (r > 1) === (m.mejor === 'mayor') ? 'a' : 'b';
                const factor = r === null ? null : r >= 1 ? r : 1 / r;
                const quien = r === null ? null : r >= 1 ? a.label : b.label;
                return (
                  <tr key={m.label}>
                    <td className="asset" title={m.fuente}>{m.label}</td>
                    {/* Cada columna lleva su color de fondo entero; la cifra
                        que gana la fila, ademas, el color fuerte. */}
                    <td className={`num cmp-col-a${gana === 'a' ? ' cmp-gana' : ''}`}>{texto(m.a)}</td>
                    <td className={`num cmp-col-b${gana === 'b' ? ' cmp-gana' : ''}`}>{texto(m.b)}</td>
                    {/* Siempre el mayor sobre el menor, con el nombre delante:
                        un 0,37 obliga a darle la vuelta mentalmente. En
                        comisiones el mayor es el que pierde, y el color lo dice. */}
                    <td className={`num ratio-col${factor === null ? ' none' : ''}${gana === 'a' ? ' cmp-a' : gana === 'b' ? ' cmp-b' : ''}`}>
                      {factor === null ? '—' : `${factor.toFixed(factor >= 10 ? 0 : 1)}× ${quien}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data?.revenueStale === true && (
        <div className="degraded-note">Revenue and fees from {fmt.ago(data.revenueAsOf ?? null)}</div>
      )}
      {a !== undefined && b !== undefined && (a.fromDefillama || b.fromDefillama) && (
        <div className="degraded-note">DefiLlama figure against a venue API figure: indicative</div>
      )}
    </div>
  );
}
