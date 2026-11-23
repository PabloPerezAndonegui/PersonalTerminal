/**
 * Catalogo de fuentes de informacion y que pestanas alimenta cada una.
 *
 * Es lo que convierte la pantalla de Data Sources en algo util: no solo "esta
 * API esta roja", sino "esta API esta roja Y por eso Pools & Yields esta vacia
 * y el Funding Scanner esta cruzando un venue menos".
 */

/**
 * Areas de la aplicacion.
 *
 * Una sola terminal con dos areas, cada una con su propio menu. La portada es
 * la eleccion entre ellas. El area es lo primero de la ruta (/defi/parity), asi
 * que mover una seccion de area le cambia la URL: ver la redireccion de rutas
 * viejas en el router de la web.
 *
 * Hubo una tercera, Trenches, para memecoins. Se retira el 5 de octubre de
 * 2026 sin construirla: primero se mejora lo que ya funciona y despues, si
 * acaso, se abre un area nueva.
 */
export type AreaId = 'defi' | 'trading' | 'data';

export interface AreaMeta {
  readonly id: AreaId;
  readonly label: string;
  /** Una linea para la tarjeta de la portada. */
  readonly tagline: string;
  /**
   * Seccion a la que se entra al pulsar el area.
   *
   * No es siempre la primera del menu: en Trading, Terminal y Traders estan
   * pendientes, asi que entrar ahi por defecto seria entrar a una pantalla
   * vacia teniendo otra que si funciona.
   */
  readonly defaultSection: SectionId;
}

export const AREAS: readonly AreaMeta[] = [
  { id: 'defi', label: 'DeFi', tagline: 'Funding, pools, bridges and your own records', defaultSection: 'dex-volume' },
  { id: 'trading', label: 'Trading', tagline: 'Charts, traders you follow and funding across venues', defaultSection: 'funding-scanner' },
  // No es un area de trabajo sino el control de todo lo demas: de donde llega
  // cada dato, cuando se refresco y que falla. La portada la ensena como panel
  // arriba a la derecha, no como tercera tarjeta.
  { id: 'data', label: 'Data', tagline: 'Sources, refresh times and failures', defaultSection: 'data-sources' },
];

/** Pestanas de la web. Los rotulos visibles van en ingles, ver DESIGN.md. */
export type SectionId =
  | 'funding-scanner'
  | 'data-sources'
  | 'dex-volume'
  | 'explorer'
  | 'parity'
  | 'pools-yields'
  | 'bridges'
  | 'points'
  | 'calendar'
  | 'terminal'
  | 'traders'
  | 'open-interest'
  | 'protocol-compare';

export const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  // El id se queda en 'funding-scanner' aunque el rotulo sea "Funding
  // Screener": es la clave con la que los cinco venues declaran a que pestana
  // alimentan, y renombrarla obligaria a tocar el catalogo de fuentes entero
  // sin ganar nada.
  'funding-scanner': 'Funding Arb',
  'data-sources': 'Data Sources',
  'dex-volume': 'DEX Volume',
  explorer: 'Explorer',
  parity: 'Parity',
  'pools-yields': 'Pools & Yields',
  bridges: 'Bridges',
  points: 'Points & Competitions',
  calendar: 'Economic Calendar',
  terminal: 'Terminal',
  traders: 'Hyperliquid Tracker',
  'open-interest': 'Open Interest',
  'protocol-compare': 'Compare',
};

/** A que area pertenece cada seccion. */
export const SECTION_AREA: Readonly<Record<SectionId, AreaId>> = {
  'dex-volume': 'defi',
  'pools-yields': 'defi',
  bridges: 'defi',
  explorer: 'defi',
  parity: 'defi',
  points: 'defi',
  calendar: 'defi',
  'data-sources': 'data',
  terminal: 'trading',
  traders: 'trading',
  'open-interest': 'trading',
  'protocol-compare': 'trading',
  // El screener de funding vive en Trading, no en DeFi. Es la misma pantalla y
  // los mismos servicios: solo cambia de menu.
  'funding-scanner': 'trading',
};

/**
 * Orden de las pestanas dentro de su area.
 *
 * Es una sola lista y no una por area para que el orden de `resolveImpact` y
 * el del menu no puedan separarse.
 */
export const SECTION_ORDER: readonly SectionId[] = [
  // DeFi
  'dex-volume',
  'pools-yields',
  'bridges',
  'explorer',
  'parity',
  'points',
  'calendar',
  // Trading
  'terminal',
  'traders',
  'funding-scanner',
  'open-interest',
  'protocol-compare',
  // Data
  'data-sources',
];

/** Secciones de un area, en el orden del menu. */
export function sectionsOfArea(area: AreaId): SectionId[] {
  return SECTION_ORDER.filter((s) => SECTION_AREA[s] === area);
}

export type SourceKind =
  /** API publica de un venue de perpetuos. */
  | 'venue'
  /** Agregador de terceros (DefiLlama y similares). */
  | 'aggregator'
  /** Widget embebido que se pinta solo (TradingView). */
  | 'widget'
  /** Datos introducidos a mano, con caducidad. */
  | 'manual';

/**
 * `critical`: sin esta fuente la pestana no tiene nada que mostrar.
 * `partial`: la pestana sigue sirviendo con menos datos (un venue de veinte).
 */
export type Criticality = 'critical' | 'partial';

export interface SourceFeed {
  readonly section: SectionId;
  readonly criticality: Criticality;
}

export interface DataSourceMeta {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly kind: SourceKind;
  /** Cadencia esperada, en texto para la UI ('cada 15 s', 'manual'). */
  readonly cadence: string;
  /** Documentacion publica, para poder comprobar un fallo sin buscarla. */
  readonly docsUrl: string | null;
  readonly feeds: readonly SourceFeed[];
}

/** Semaforo. El texto acompana siempre al color: hay daltonismo rojo-verde. */
export type TrafficLight = 'green' | 'yellow' | 'red';

/** Impacto de una fuente en una seccion, ya resuelto con su estado actual. */
export interface SectionImpact {
  readonly section: SectionId;
  readonly light: TrafficLight;
  /** Fuentes criticas caidas: la seccion no puede mostrar nada. */
  readonly brokenCritical: readonly string[];
  /** Fuentes parciales caidas o degradadas: la seccion muestra de menos. */
  readonly degraded: readonly string[];
}
