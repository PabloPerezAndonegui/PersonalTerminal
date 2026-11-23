import { useState } from 'react';
import { TRADER_PANELS, TraderPanel, type TraderPanelId } from '../components/TraderPanels.tsx';

const LAYOUT_KEY = 'traders.visiblePanels';
const allPanels = TRADER_PANELS.map((p) => p.id);

/** Solo se recuerda la disposicion visual. Las direcciones y el seguimiento
 * no se guardan en localStorage: pertenecen al futuro servicio compartido.
 */
function readLayout(): TraderPanelId[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
    if (Array.isArray(value)) return allPanels.filter((id) => value.includes(id));
  } catch { /* Sin preferencia valida se muestran todos los paneles. */ }
  return allPanels;
}

export function Traders() {
  const [visible, setVisible] = useState<TraderPanelId[]>(readLayout);
  const [layoutError, setLayoutError] = useState(false);
  function update(next: TraderPanelId[]) {
    setVisible(next);
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)); setLayoutError(false); }
    catch { setLayoutError(true); }
  }
  // Sin linea de titulo propia: el menu ya dice en que seccion se esta, y
  // ninguna otra pantalla la lleva. Los paneles, como cualquier otro control:
  // el rotulo encima y los botones debajo.
  return <div className="traders-screen">
    <div className="controls" role="group" aria-label="Visible trader panels">
      <div className="control-group">
        <span className="label">Panels</span>
        <div className="segmented">{TRADER_PANELS.map((p) =>
          <button type="button" key={p.id} aria-pressed={visible.includes(p.id)}
            className={visible.includes(p.id) ? 'seg seg-active' : 'seg'}
            onClick={() => update(visible.includes(p.id) ? visible.filter((id) => id !== p.id) : [...visible, p.id])}>
            {p.label}
          </button>)}<button type="button" className="seg seg-clear" onClick={() => update(allPanels)}>Show all</button></div>
      </div>
    </div>
    {layoutError && <p className="light light-yellow">Panel layout could not be saved in this browser.</p>}
    {visible.length === 0 && <p className="trader-empty">All panels hidden. Select a panel above.</p>}
    <div className="trader-panels">{TRADER_PANELS.filter((p) => visible.includes(p.id)).map((p) =>
      <TraderPanel key={p.id} panel={p.id} />)}</div>
  </div>;
}
