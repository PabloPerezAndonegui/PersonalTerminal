import type { DataSourceMeta, SectionId, SourceFeed } from './types.ts';

/**
 * Que pestanas alimenta un venue de perpetuos. Es el mismo conjunto para todos,
 * y siempre `partial`: perder un venue empobrece esas pantallas pero no las
 * deja inservibles, porque los cruces entre los demas siguen siendo validos.
 */
const VENUE_FEEDS: readonly SourceFeed[] = [
  { section: 'funding-scanner', criticality: 'partial' },
  { section: 'dex-volume', criticality: 'partial' },
  { section: 'explorer', criticality: 'partial' },
  { section: 'parity', criticality: 'partial' },
];

const venue = (id: string, label: string, docsUrl: string | null, cadence: string): DataSourceMeta => ({
  id,
  label,
  provider: label,
  kind: 'venue',
  cadence,
  docsUrl,
  feeds: VENUE_FEEDS,
});

/**
 * Catalogo de fuentes.
 *
 * Los venues se generan a partir del registro de adaptadores en tiempo de
 * ejecucion (ver `sourcesForVenues`), para que anadir un venue no obligue a
 * tocar dos sitios y arriesgarse a que se olvide uno.
 */
export const NON_VENUE_SOURCES: readonly DataSourceMeta[] = [
  {
    id: 'defillama-pools',
    label: 'DefiLlama Yields',
    provider: 'DefiLlama',
    kind: 'aggregator',
    cadence: 'hourly at source',
    docsUrl: 'https://defillama.com/docs/api',
    // Sin esto, Pools & Yields no tiene absolutamente nada que mostrar.
    feeds: [{ section: 'pools-yields', criticality: 'critical' }],
  },
  {
    id: 'defillama-bridges',
    label: 'DefiLlama Bridges',
    provider: 'DefiLlama',
    kind: 'aggregator',
    cadence: 'hourly at source',
    docsUrl: 'https://defillama.com/docs/api',
    // Sin DefiLlama, LI.FI y deBridge siguen diciendo que rutas existen: la
    // pestana pierde liquidez y TVL, no las rutas.
    feeds: [{ section: 'bridges', criticality: 'partial' }],
  },
  {
    // Que puentes enrutan cada par de redes. Es lo que hace aparecer Relay,
    // Across o CCTP, que en DefiLlama no tienen liquidez en las dos redes.
    id: 'lifi-routes',
    label: 'LI.FI routes',
    provider: 'LI.FI',
    kind: 'aggregator',
    cadence: 'hourly',
    docsUrl: 'https://docs.li.fi/api-reference/get-information-about-available-bridges-and-exchanges',
    feeds: [{ section: 'bridges', criticality: 'partial' }],
  },
  {
    id: 'debridge-routes',
    label: 'deBridge chains',
    provider: 'deBridge',
    kind: 'aggregator',
    cadence: 'hourly',
    docsUrl: 'https://docs.debridge.finance/',
    feeds: [{ section: 'bridges', criticality: 'partial' }],
  },
  {
    id: 'defillama-bridge-aggregators',
    label: 'DefiLlama Bridge Aggregators',
    provider: 'DefiLlama',
    kind: 'aggregator',
    cadence: 'hourly',
    docsUrl: 'https://defillama.com/docs/api',
    feeds: [{ section: 'bridges', criticality: 'partial' }],
  },
  {
    // El unico venue que publica sus competiciones y puntos sin clave.
    id: 'perpl-campaigns',
    label: 'Perpl campaigns',
    provider: 'Perpl',
    kind: 'aggregator',
    cadence: 'hourly',
    docsUrl: null,
    feeds: [{ section: 'points', criticality: 'partial' }],
  },
  // Open Interest. Las cinco CEX se leen por su API publica y DefiLlama da el
  // resto, mas los ingresos y el TVL de Compare. Faltaban aqui: su salud ya se
  // media, pero Data Sources no las ensenaba (hallazgo de la auditoria).
  ...(['Bybit', 'OKX', 'Bitget', 'Gate', 'KuCoin'] as const).map((label): DataSourceMeta => ({
    id: `oi-${label.toLowerCase()}`,
    label: `${label} open interest`,
    provider: label,
    kind: 'venue',
    cadence: 'every 15 min',
    docsUrl: null,
    feeds: [{ section: 'open-interest', criticality: 'partial' }, { section: 'protocol-compare', criticality: 'partial' }],
  })),
  {
    id: 'oi-defillama',
    label: 'DefiLlama open interest',
    provider: 'DefiLlama',
    kind: 'aggregator',
    cadence: 'every 15 min',
    docsUrl: 'https://defillama.com/docs/api',
    feeds: [{ section: 'open-interest', criticality: 'partial' }, { section: 'protocol-compare', criticality: 'partial' }],
  },
  {
    id: 'oi-defillama-revenue',
    label: 'DefiLlama fees and revenue',
    provider: 'DefiLlama',
    kind: 'aggregator',
    cadence: 'hourly',
    docsUrl: 'https://defillama.com/docs/api',
    feeds: [{ section: 'protocol-compare', criticality: 'partial' }],
  },
  {
    id: 'oi-defillama-tvl',
    label: 'DefiLlama TVL',
    provider: 'DefiLlama',
    kind: 'aggregator',
    cadence: 'hourly',
    docsUrl: 'https://defillama.com/docs/api',
    feeds: [{ section: 'protocol-compare', criticality: 'partial' }],
  },
  {
    id: 'forexfactory-calendar',
    label: 'ForexFactory calendar',
    provider: 'ForexFactory',
    kind: 'aggregator',
    cadence: 'hourly',
    docsUrl: 'https://www.forexfactory.com/calendar',
    // La tabla por dias sale de aqui; sin ella queda el widget de TradingView.
    feeds: [{ section: 'calendar', criticality: 'partial' }],
  },
  {
    id: 'tradingview-calendar',
    label: 'TradingView Economic Calendar',
    provider: 'TradingView',
    kind: 'widget',
    cadence: 'live (widget)',
    docsUrl: 'https://www.tradingview.com/widget-docs/',
    feeds: [{ section: 'calendar', criticality: 'partial' }],
  },
  {
    id: 'points-manual',
    label: 'Manually verified points campaigns',
    provider: 'manual',
    kind: 'manual',
    // Caduca sola: pasada la fecha se pone amarilla con "sin verificar desde X"
    // para que un dato viejo no se disfrace de dato vivo.
    cadence: 'manual, expires',
    docsUrl: null,
    feeds: [
      { section: 'points', criticality: 'partial' },
    ],
  },
];

/** Metadatos de fuente para cada venue admitido, a partir del registro. */
export function sourcesForVenues(
  venues: readonly { id: string; label: string; docsUrl?: string | null }[],
  cadence = 'every 60s',
): DataSourceMeta[] {
  return venues.map((v) => venue(v.id, v.label, v.docsUrl ?? null, cadence));
}

/** Catalogo completo: venues mas el resto. */
export function allSources(
  venues: readonly { id: string; label: string; docsUrl?: string | null }[],
  venueCadence = 'every 60s',
): DataSourceMeta[] {
  return [...sourcesForVenues(venues, venueCadence), ...NON_VENUE_SOURCES];
}

/** Fuentes que alimentan una seccion concreta. */
export function sourcesForSection(
  sources: readonly DataSourceMeta[],
  section: SectionId,
): DataSourceMeta[] {
  return sources.filter((s) => s.feeds.some((f) => f.section === section));
}
