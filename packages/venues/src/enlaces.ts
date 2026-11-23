/**
 * Web oficial de cada venue, para poder ir a operar con un clic.
 *
 * Un enlace equivocado en una herramienta de trading es una via de phishing,
 * asi que ninguno sale de memoria. Comprobados el 17 de noviembre de 2026 por
 * dos lados: la URL que publica DefiLlama para el protocolo y el dominio de la
 * API que este proyecto ya lee de ese venue. Coinciden en todos.
 *
 * Dos ajustes sobre lo de DefiLlama: Paradex trae su codigo de referido
 * (`/r/defillama`), que se quita; y de Perpl se usa la app, que es la que ya
 * estaba comprobada en el catalogo de puntos.
 *
 * Los cinco exchanges centralizados son sus dominios principales, los mismos
 * de sus APIs salvo Gate: su API sigue en `gateio.ws` y su web paso a
 * `gate.com` con el cambio de marca de 2025.
 */
export const ENLACE_OFICIAL: Readonly<Record<string, string>> = {
  hyperliquid: 'https://app.hyperliquid.xyz',
  variational: 'https://omni.variational.io',
  aster: 'https://www.asterdex.com',
  perpl: 'https://app.perpl.xyz',
  pacifica: 'https://app.pacifica.fi',
  backpack: 'https://backpack.exchange',
  paradex: 'https://app.paradex.trade',
  dydx: 'https://dydx.trade',
  extended: 'https://app.extended.exchange',
  orderly: 'https://orderly.network',
  qfex: 'https://www.qfex.com',
  phoenix: 'https://phoenix.trade',
  arcus: 'https://arcus.xyz',
  risex: 'https://www.rise.trade',
  entropy: 'https://entropy.io',
  lighter: 'https://app.lighter.xyz',
  bybit: 'https://www.bybit.com',
  okx: 'https://www.okx.com',
  bitget: 'https://www.bitget.com',
  gate: 'https://www.gate.com',
  kucoin: 'https://www.kucoin.com',
};

/** El enlace oficial de un venue, o null si no hay uno comprobado. */
export function enlaceOficial(venue: string): string | null {
  return ENLACE_OFICIAL[venue] ?? null;
}
