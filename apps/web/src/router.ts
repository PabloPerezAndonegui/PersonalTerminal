import { useEffect, useState } from 'react';

/**
 * Enrutado por ruta real, no por hash.
 *
 * `/`, `/defi`, `/defi/parity`, `/trading/funding-scanner`. Se puede recargar,
 * guardar la URL y usar atras y adelante del navegador.
 *
 * Coste de hacerlo asi: servido como estatico, el servidor tiene que devolver
 * `index.html` para cualquier ruta que no sea un fichero. El servidor de
 * desarrollo de Vite ya lo hace; queda anotado en ARCHITECTURE.md para el
 * despliegue.
 *
 * Sin dependencia de router: son dos niveles de ruta y un `popstate`.
 */

export interface Ruta {
  /** null en la portada. */
  readonly area: string | null;
  /** null al entrar a un area sin seccion: el area decide su seccion de entrada. */
  readonly section: string | null;
}

export function parseRuta(pathname: string): Ruta {
  const partes = pathname.split('/').filter((p) => p !== '');
  return { area: partes[0] ?? null, section: partes[1] ?? null };
}

export function href(area: string, section?: string): string {
  return section === undefined ? `/${area}` : `/${area}/${section}`;
}

/**
 * Navega sin recargar y avisa a la app.
 *
 * `popstate` solo salta con atras y adelante, no con `pushState`, asi que hace
 * falta un evento propio para que el shell se entere de sus propios enlaces.
 */
export function navegar(to: string, reemplazar = false): void {
  if (reemplazar) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Redirige las URL viejas de una sola pestana (`#/parity`) a la nueva ruta.
 *
 * Los enlaces guardados de antes de dividir la app en areas tienen que seguir
 * funcionando. Se hace con `replaceState` para no dejar basura en el historial.
 */
export function redirigirRutaVieja(areaDe: (section: string) => string | null): void {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash === '') return;
  const area = areaDe(hash);
  navegar(area === null ? '/' : `/${area}/${hash}`, true);
}

export function useRuta(): Ruta {
  const [ruta, setRuta] = useState<Ruta>(() => parseRuta(window.location.pathname));

  useEffect(() => {
    const alCambiar = () => setRuta(parseRuta(window.location.pathname));
    window.addEventListener('popstate', alCambiar);
    return () => window.removeEventListener('popstate', alCambiar);
  }, []);

  return ruta;
}
