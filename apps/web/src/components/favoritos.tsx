import { useState } from 'react';

/**
 * Favoritos de una lista, para subir arriba lo que se usa a diario.
 *
 * Con cien exchanges y dos mil simbolos, el que se mira todos los dias esta
 * enterrado en mitad de una lista alfabetica. Marcarlo lo sube al principio y
 * ya no hay que buscarlo.
 *
 * **Son preferencia, no dato.** Viven en el navegador, cada lista con su clave,
 * y no tocan nada de lo que se selecciona ni de lo que se compara: un venue
 * marcado como favorito no queda seleccionado, solo sale antes.
 *
 * El mismo patron que ya usaba el screener para fijar simbolos, ahora
 * compartido para que todas las listas se comporten igual.
 */

function leer(clave: string): string[] {
  try {
    const v = localStorage.getItem(clave);
    if (v === null) return [];
    const p = JSON.parse(v) as unknown;
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface Favoritos {
  readonly lista: readonly string[];
  es(id: string): boolean;
  alternar(id: string): void;
  /** Los favoritos primero, conservando el orden de cada grupo. */
  ordenar<T>(items: readonly T[], id: (item: T) => string): T[];
}

export function useFavoritos(clave: string): Favoritos {
  const [lista, setLista] = useState<string[]>(() => leer(clave));

  /**
   * Se calcula sobre el valor ANTERIOR, no sobre el del render.
   *
   * Marcando dos seguidos, los dos clics leerian la misma lista y el segundo
   * borraria el primero. Con la forma funcional cada uno parte de lo que dejo
   * el anterior.
   */
  const alternar = (id: string) => {
    setLista((previo) => {
      const siguiente = previo.includes(id) ? previo.filter((x) => x !== id) : [...previo, id];
      try { localStorage.setItem(clave, JSON.stringify(siguiente)); } catch { /* preferencia */ }
      return siguiente;
    });
  };

  return {
    lista,
    es: (id) => lista.includes(id),
    alternar,
    // Estable: no reordena dentro de cada grupo, solo separa los dos.
    ordenar: (items, id) => [
      ...items.filter((x) => lista.includes(id(x))),
      ...items.filter((x) => !lista.includes(id(x))),
    ],
  };
}

/**
 * La estrella.
 *
 * Va como boton HERMANO del elemento de la lista, no dentro: un boton dentro
 * de otro no es HTML valido y ademas pulsar la estrella acabaria seleccionando
 * el elemento, que es justo lo que no se quiere.
 */
export function Estrella({ marcado, onClick, que }: {
  marcado: boolean;
  onClick: () => void;
  /** Que se esta marcando, para el titulo. */
  que: string;
}) {
  return (
    <button
      type="button"
      className={marcado ? 'star star-on' : 'star'}
      title={marcado ? `Unpin ${que}` : `Pin ${que} to the top`}
      aria-pressed={marcado}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {marcado ? '★' : '☆'}
    </button>
  );
}
