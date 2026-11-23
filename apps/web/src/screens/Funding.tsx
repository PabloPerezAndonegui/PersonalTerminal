import { useState } from 'react';
import { FundingMatrix } from './FundingMatrix.tsx';
import { FundingScanner } from './FundingScanner.tsx';

/**
 * Pestana de funding con dos vistas.
 *
 *  - Screener: la matriz de simbolos por venues, con tasas brutas.
 *  - Net APR: el ranking de cruces con fees, slippage real y procedencia.
 *
 * Solo se monta una a la vez. No es por tidiness: la vista de APR neto pide los
 * libros de ordenes de los 40 mejores cruces en cada ciclo, y tenerla montada
 * de fondo mientras se mira la matriz serian 80 peticiones por minuto a los
 * venues para nada, desde la IP que compartes con tus bots.
 */

type Vista = 'screener' | 'net';

const CLAVE = 'funding.view';

export function Funding({ refreshKey }: { refreshKey: number }) {
  const [vista, setVista] = useState<Vista>(() => {
    try {
      return localStorage.getItem(CLAVE) === 'net' ? 'net' : 'screener';
    } catch {
      return 'screener';
    }
  });

  function cambiar(v: Vista) {
    setVista(v);
    try { localStorage.setItem(CLAVE, v); } catch { /* sin almacenamiento, no se recuerda */ }
  }

  return (
    <>
      <div className="view-switch segmented">
        <button className={vista === 'screener' ? 'seg seg-active' : 'seg'} onClick={() => cambiar('screener')}>
          Screener
        </button>
        <button className={vista === 'net' ? 'seg seg-active' : 'seg'} onClick={() => cambiar('net')}>
          Net APR
        </button>
      </div>
      {vista === 'screener' ? <FundingMatrix refreshKey={refreshKey} /> : <FundingScanner refreshKey={refreshKey} />}
    </>
  );
}
