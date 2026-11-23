import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFavoritos, Estrella } from './favoritos.tsx';

/**
 * Desplegable con buscador, favoritos y orden por prioridad.
 *
 * ## Por que existe
 *
 * Habia dos formas de filtrar en esta app. Open Interest, Compare y la matriz
 * de funding tenian un menu propio con buscador y favoritos, copiado a mano
 * tres veces. Pools, Bridges, Funding arb y Parity tenian un `<select>` del
 * sistema: sin buscar, sin favoritos y con las cadenas en orden alfabetico, de
 * modo que para llegar a Arbitrum habia que pasar por Algorand y Aptos.
 *
 * Esto unifica las dos. Una sola implementacion, y anadir un filtro nuevo deja
 * de ser copiar cuarenta lineas de JSX.
 *
 * ## Las tres reglas del orden
 *
 * 1. **Los favoritos del usuario primero.** Siempre mandan: si alguien fija
 *    algo, es porque lo mira a diario.
 * 2. **Luego la prioridad del sitio**, que le pasa quien lo usa. En las
 *    cadenas son Arbitrum, Base, Ethereum y Solana, que es donde esta el
 *    dinero que mira este proyecto. Un orden alfabetico trata igual a
 *    Arbitrum y a Algorand, y no son iguales para nadie.
 * 3. **Y despues el orden que traia la lista**, que normalmente ya viene
 *    ordenado por tamano desde el servidor.
 *
 * El orden NO se recalcula mientras se escribe en el buscador: la lista se
 * filtra pero no se reordena, porque reordenar bajo el cursor hace que pulses
 * lo que no era.
 */

export interface OpcionSelector {
  readonly id: string;
  readonly label: string;
  /** Texto pequeno a la derecha: un tamano, un tipo, lo que sea. */
  readonly extra?: ReactNode;
  /** Se ve al pasar el cursor. Para lo que no cabe en una linea. */
  readonly title?: string;
}

/** Lo que se repite entre un selector de uno y uno de varios. */
interface Comun {
  /** Rotulo de la banda de controles. */
  readonly label: string;
  readonly opciones: readonly OpcionSelector[];
  /** Clave con la que se guardan los favoritos de ESTE filtro. */
  readonly claveFavoritos: string;
  /** Ids que suben al principio, tras los favoritos. En su propio orden. */
  readonly prioridad?: readonly string[];
  readonly placeholder?: string;
  /** Acciones extra arriba del todo: "All", "None", "DEX only"... */
  readonly acciones?: ReactNode;
}

type Props =
  | (Comun & { readonly modo: 'uno'; readonly valor: string; readonly onElegir: (id: string) => void })
  | (Comun & { readonly modo: 'varios'; readonly valores: readonly string[]; readonly onAlternar: (id: string) => void });

export function Selector(props: Props) {
  const { label, opciones, claveFavoritos, prioridad = [], placeholder, acciones } = props;
  const [abierto, setAbierto] = useState(false);
  const [buscar, setBuscar] = useState('');
  const ancla = useRef<HTMLDivElement>(null);
  const favoritos = useFavoritos(claveFavoritos);

  // Cerrar al pulsar fuera. Sin esto queda un menu abierto tapando la tabla.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (ancla.current !== null && !ancla.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [abierto]);

  const elegidos = props.modo === 'uno' ? [props.valor] : props.valores;

  /**
   * El orden, calculado SIN mirar el texto del buscador.
   *
   * Si se reordenase al escribir, la fila que estas a punto de pulsar se
   * movería bajo el cursor. Se ordena una vez y luego solo se filtra.
   */
  const rango = (o: OpcionSelector): number => {
    // La opcion sin filtro, por convenio la de id vacio, va SIEMPRE primera:
    // es el boton de volver atras, no una opcion mas. Con la prioridad por
    // delante, "All chains" acababa en el puesto doce, debajo de Berachain.
    if (o.id === '') return -10_000_000;
    if (favoritos.es(o.id)) return -1_000_000;
    const i = prioridad.indexOf(o.id);
    return i === -1 ? 0 : -100_000 + i;
  };
  const ordenadas = [...opciones]
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (rango(a.o) - rango(b.o)) || (a.i - b.i))
    .map((x) => x.o);

  const q = buscar.trim().toUpperCase();
  const visibles = q === ''
    ? ordenadas
    : ordenadas.filter((o) => o.label.toUpperCase().includes(q) || o.id.toUpperCase().includes(q));

  const resumen = props.modo === 'uno'
    ? opciones.find((o) => o.id === props.valor)?.label ?? props.valor
    : `${elegidos.length} of ${opciones.length}`;

  return (
    <div className="control-group menu-anclaje" ref={ancla}>
      <span className="label">{label}</span>
      <button className="seg seg-menu" aria-expanded={abierto}
        onClick={() => { setAbierto((v) => !v); setBuscar(''); }}>
        {resumen} {abierto ? '▴' : '▾'}
      </button>
      {abierto && (
        <div className="menu">
          <input className="menu-buscar" type="search" autoFocus value={buscar}
            placeholder={placeholder ?? `Filter ${label.toLowerCase()}`}
            aria-label={placeholder ?? `Filter ${label.toLowerCase()}`}
            onChange={(e) => setBuscar(e.target.value)} />
          {acciones !== undefined && <div className="menu-acciones">{acciones}</div>}
          {visibles.length === 0 && <div className="menu-vacio">No match.</div>}
          {visibles.map((o) => {
            const marcado = elegidos.includes(o.id);
            return (
              <div key={o.id} className="menu-fila">
                <Estrella marcado={favoritos.es(o.id)} que={o.label}
                  onClick={() => favoritos.alternar(o.id)} />
                <button
                  className={marcado ? 'menu-item menu-item-on' : 'menu-item'}
                  {...(o.title === undefined ? {} : { title: o.title })}
                  onClick={() => {
                    if (props.modo === 'uno') { props.onElegir(o.id); setAbierto(false); }
                    else props.onAlternar(o.id);
                  }}>
                  <span className="menu-check">{marcado ? '×' : ''}</span>
                  <span className="menu-label">{o.label}</span>
                  {o.extra !== undefined && <span className="menu-cifra">{o.extra}</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Las cadenas que suben al principio de cualquier filtro de red.
 *
 * No es una opinion sobre que cadena es mejor: es donde esta lo que mira este
 * proyecto. Los perps que leemos viven en Arbitrum, Base, Solana, Hyperliquid
 * y Starknet, y las pools que interesan estan en esas mismas mas Ethereum.
 *
 * Se declara una vez y la usan Pools y Bridges, para que la misma cadena no
 * salga en el puesto tres en una pantalla y en el treinta en otra.
 */
export const CADENAS_PRIORITARIAS: readonly string[] = [
  'Ethereum', 'Arbitrum', 'Base', 'Solana', 'Hyperliquid', 'Hyperliquid L1',
  'BSC', 'Optimism', 'Polygon', 'Avalanche', 'Starknet', 'Sui', 'Berachain',
];
