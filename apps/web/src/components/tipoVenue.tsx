import { useEffect, useState } from 'react';

/**
 * Filtro DEX / CEX / All de los desplegables de venues.
 *
 * Una sola preferencia para toda la app. Quien la cambia en Compare la tiene igual en Funding Arb y
 * en Open Interest, porque la pregunta es la misma en todas: que tipo de venue
 * se quiere mirar. Por defecto DEX, que es lo que se compara.
 *
 * Solo filtra la LISTA del desplegable, nunca la seleccion: cambiarlo no marca
 * ni desmarca nada, igual que el buscador.
 */

export type TipoVenue = 'dex' | 'cex' | 'all';

const CLAVE = 'venues.kind';
const EVENTO = 'tipo-venue';

function leer(): TipoVenue {
  try {
    const v = localStorage.getItem(CLAVE);
    return v === 'cex' || v === 'all' ? v : 'dex';
  } catch {
    return 'dex';
  }
}

/** El tipo elegido, compartido entre pantallas y entre desplegables abiertos. */
export function useTipoVenue(): [TipoVenue, (t: TipoVenue) => void] {
  const [tipo, setTipo] = useState<TipoVenue>(leer);
  useEffect(() => {
    const oir = () => setTipo(leer());
    window.addEventListener(EVENTO, oir);
    return () => window.removeEventListener(EVENTO, oir);
  }, []);
  const cambiar = (t: TipoVenue) => {
    try { localStorage.setItem(CLAVE, t); } catch { /* preferencia */ }
    setTipo(t);
    window.dispatchEvent(new Event(EVENTO));
  };
  return [tipo, cambiar];
}

/**
 * Si un venue entra con el filtro. Acepta los dos vocabularios de la app:
 * 'dex'/'cex' (Open Interest) y 'perp-dex'/'perp-cex' (registro de venues).
 */
export function deTipo(kind: string | null | undefined, tipo: TipoVenue): boolean {
  if (tipo === 'all') return true;
  return kind != null && kind.endsWith(tipo);
}

const TIPOS: readonly { id: TipoVenue; label: string }[] = [
  { id: 'dex', label: 'DEX' },
  { id: 'cex', label: 'CEX' },
  { id: 'all', label: 'All' },
];

/**
 * Los tres botones. Por defecto van bajo el buscador de un desplegable; con
 * `enControles` van en la banda de controles de la pantalla, con su rotulo.
 */
export function FiltroTipo({ tipo, onCambiar, enControles = false }: {
  tipo: TipoVenue;
  onCambiar: (t: TipoVenue) => void;
  enControles?: boolean;
}) {
  const botones = TIPOS.map((t) => (
    <button key={t.id} type="button" className={t.id === tipo ? 'seg seg-active' : 'seg'} onClick={() => onCambiar(t.id)}>
      {t.label}
    </button>
  ));
  if (!enControles) return <div className="menu-acciones">{botones}</div>;
  return (
    <div className="control-group">
      <span className="label">Venues</span>
      <div className="segmented">{botones}</div>
    </div>
  );
}
