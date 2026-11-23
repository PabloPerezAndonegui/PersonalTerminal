export type { VenueAdapter, AdapterFactory, AdapterCost } from './types.ts';
export type { ResourceBudget, BudgetPlan } from './budget.ts';
export { planBudget } from './budget.ts';
export { normalizeSymbol, type NormalizedSymbol } from './symbols.ts';
export { getJson, postJson, num, isRecord, HttpError, type HttpOptions } from './http.ts';
export {
  REGISTRY,
  allVenueIds,
  activeVenueIds,
  VENUES_POR_DEFECTO,
  VENUES_DEL_USUARIO,
  allVenueMeta,
  createAdapters,
} from './registry.ts';
export { HyperliquidAdapter, HYPERLIQUID_META } from './adapters/hyperliquid.ts';
export { PacificaAdapter, PACIFICA_META } from './adapters/pacifica.ts';
export { BackpackAdapter, BACKPACK_META } from './adapters/backpack.ts';
export { ParadexAdapter, PARADEX_META } from './adapters/paradex.ts';
export { DydxAdapter, DYDX_META } from './adapters/dydx.ts';
export { toUnitPrices, mapToUnitPrices, scaleBookToUnits } from './normalize.ts';
export { fetchPools, type Pool } from './sources/defillama.ts';
export { fetchBridges, bridgeChains, routesBetween, AUSENTES_POR_DISENO, type Bridge, type BridgeType } from './sources/bridges.ts';
export {
  fetchLifiRoutes, fetchDebridgeRoutes, fetchBridgeAggregators, conecta,
  type ProveedorRutas, type ViaRuta, type AgregadorBridge,
} from './sources/bridgeRoutes.ts';
export { fetchPerplCampaigns, estadoCampana, type Campana } from './sources/campaigns.ts';
export { ENLACE_OFICIAL, enlaceOficial } from './enlaces.ts';
export { fetchEconomicCalendar, type EventoEconomico, type Impacto } from './sources/calendar.ts';
export {
  POINTS_PROGRAMS, POINTS_STALE_AFTER_DAYS, pointsFreshness, daysSince,
  type PointsProgram, type PointsApiStatus, type PointsFreshness,
} from './sources/points.ts';
export { PhoenixAdapter, PHOENIX_META } from './adapters/phoenix.ts';

export {
  fetchBybitOi, fetchOkxOi, fetchBitgetOi, fetchGateOi, fetchKucoinOi, FUENTES_CEX,
  type OiMarket, type VenueOi, type OiConvention,
} from './sources/openInterest.ts';

export { FICHA_DEX, HIP3_DE_HYPERLIQUID, type FichaOi } from './sources/oiConvention.ts';
export {
  fetchHyperliquidFills, fetchHyperliquidEquity, type FillCrudo,
} from './sources/fills.ts';
export {
  fetchHyperliquidCandles, esIntervalo, INTERVALOS,
  type Candle, type Intervalo,
} from './sources/candles.ts';

export {
  fetchLlamaOi, fetchLlamaRevenue, fetchLlamaTvl, comoVenueOi, esDuplicado, claveProtocolo, venueDeNombre,
  COBERTURA_LLAMA, COBERTURA_HIP3, YA_LEIDOS_DIRECTOS, type LlamaRevenue, type LlamaInstrument,
  type LlamaOi, type LlamaProtocolOi,
} from './sources/llamaOi.ts';
export { fetchLlamaOiHistorico, fetchBybitOiHistorico, type DiaLlama } from './sources/oiHistorico.ts';
export {
  fetchCatalogoHl, fetchAnotacionesHl, fetchDexesHl, fetchLibroHl, fetchTradesHl,
  type MercadoHl, type CatalogoHl, type TradeHl,
} from './sources/hyperliquidMercados.ts';
