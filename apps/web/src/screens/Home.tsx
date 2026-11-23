import { useEffect, useState } from 'react';
import { href, navegar } from '../router.ts';
import { getJson, fmt, type Area, type Section, type SourcesResponse } from '../api.ts';

/**
 * Portada: la eleccion entre las dos areas, y nada mas.
 *
 * Cada tarjeta lleva el nombre del area y cuantas secciones tiene, con las
 * parciales contadas aparte. Se quito la frase descriptiva de cada area y se
 * quito la rejilla de fuentes que hubo debajo un rato: en una portada que solo
 * sirve para elegir entre dos sitios, todo lo demas es ruido. El estado de las
 * fuentes va en un panel pequeno arriba a la derecha (`PanelDatos`).
 */

/**
 * Panel de datos de la portada, arriba a la derecha.
 *
 * Cuantas fuentes estan bien y cuales fallan, con su motivo y cuando
 * respondieron por ultima vez. Es lo primero que hay que saber antes de fiarse
 * de cualquier pantalla. El detalle completo esta en Data, a un clic.
 */
export function PanelDatos({ area }: { area: Area | undefined }) {
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vivo = true;
    const leer = () => getJson<SourcesResponse>('/api/sources')
      .then((d) => { if (vivo) { setData(d); setError(false); } })
      .catch(() => { if (vivo) setError(true); });
    void leer();
    const t = setInterval(() => void leer(), 60_000);
    return () => { vivo = false; clearInterval(t); };
  }, []);

  if (area === undefined) return null;
  const fuentes = data?.sources ?? [];
  const mal = fuentes.filter((f) => f.light === 'red' || f.light === 'yellow')
    .sort((a, b) => (a.light === 'red' ? 0 : 1) - (b.light === 'red' ? 0 : 1));
  const bien = fuentes.filter((f) => f.light === 'green').length;
  // Sin reporte no es lo mismo que caida: un widget que nadie ha abierto.
  const sinReporte = fuentes.filter((f) => f.light === null).length;
  const destino = href(area.id, area.defaultSection);

  return (
    <a className="panel-datos" href={destino} onClick={(e) => { e.preventDefault(); navegar(destino); }}>
      <span className="panel-datos-titulo">{area.label}</span>
      {error ? (
        <span className="light light-red">API not answering</span>
      ) : data === null ? (
        <span className="none">Loading…</span>
      ) : (
        <>
          <span className={mal.some((f) => f.light === 'red') ? 'light light-red' : mal.length > 0 ? 'light light-yellow' : 'light light-green'}>
            {bien} of {fuentes.length} sources OK
          </span>
          {mal.slice(0, 4).map((f) => (
            <span key={f.id} className="panel-datos-fallo" title={f.health?.reason ?? undefined}>
              <span className={f.light === 'red' ? 'light-red' : 'light-yellow'}>{f.label}</span>
              <span className="none"> · last ok {fmt.ago(f.health?.lastOkAt ?? null)}</span>
            </span>
          ))}
          {mal.length > 4 && <span className="none">+{mal.length - 4} more</span>}
          {sinReporte > 0 && <span className="none">{sinReporte} not reporting</span>}
        </>
      )}
    </a>
  );
}

export function Home({ areas, sections }: { areas: readonly Area[]; sections: readonly Section[] }) {
  return (
    <div className="home">
      <div className="home-areas">
        {/* Data no es una tarjeta: va como panel en la cabecera. */}
        {areas.filter((a) => a.id !== 'data').map((a) => {
          const propias = sections.filter((s) => s.area === a.id);
          const parciales = propias.filter((s) => PARCIALES[s.id] !== undefined).length;
          return (
            <a
              key={a.id}
              className="home-card"
              href={href(a.id, a.defaultSection)}
              onClick={(e) => { e.preventDefault(); navegar(href(a.id, a.defaultSection)); }}
            >
              <span className="home-title">{a.label}</span>
              <span className="none">
                {`${propias.length} sections`}
                {parciales > 0 && `, ${parciales} partial`}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Secciones que funcionan pero les falta algo, con QUE les falta.
 *
 * Antes era una lista de ids sin mas y la portada las contaba como no
 * construidas, asi que Trading decia "2 of 5 sections built" teniendo cuatro en
 * pie. Ni Hyperliquid Tracker ni Open Interest son un hueco: funcionan y les
 * falta una pieza, que no es lo mismo y no se cuenta igual.
 *
 * El texto es el que sale en el menu al pasar por encima del punto, asi que
 * vive aqui y no repartido por un ternario en `App.tsx`.
 */
export const PARCIALES: Readonly<Record<string, string>> = {
  // El grafico del Terminal se cerro el 19 de octubre de 2026: velas de
  // Hyperliquid, indicadores y lista de mercados. Lo que le falta ahora es el
  // libro de ordenes, no el grafico.
  terminal: 'Chart, markets and order book connected; trades tape pending',
  traders: 'Tracker connected; execution history pending',
  'open-interest': 'DEX and five CEX connected; Binance pending',
};

/** Secciones que son un hueco declarado y no una pantalla. Hoy ninguna. */
export const PENDIENTES = new Set<string>([]);
