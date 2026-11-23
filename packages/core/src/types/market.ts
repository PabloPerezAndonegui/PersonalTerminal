import type { VenueId } from './venue.ts';

/** Nivel de libro. `size` en unidades del subyacente, no en USD. */
export interface BookLevel {
  readonly price: number;
  readonly size: number;
}

/** Libro L2 normalizado: bids de mayor a menor, asks de menor a mayor. */
export interface OrderBook {
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}

/**
 * Funding tal y como lo publica el venue, sin normalizar.
 * La normalizacion a horaria/APR se hace con los helpers de `util/funding.ts`,
 * para que el dato crudo siga siendo auditable.
 */
/**
 * Que representa exactamente una tasa de funding.
 *
 * Mezclar estimaciones con pagos realizados es el error que hace inservible un
 * analisis de estrategia: se comparan dos cosas distintas creyendo que son la
 * misma. Ninguno de los cinco venues publica lo mismo en el mismo campo.
 *
 *  - `current`: tasa vigente del periodo EN CURSO. Todavia puede moverse antes
 *    de liquidarse. Es lo que publican Hyperliquid, Pacifica, Backpack y
 *    Paradex.
 *  - `predicted`: tasa que el venue anuncia para el proximo periodo, sin
 *    liquidar aun. Es lo que publica dydx en `nextFundingRate`, y difiere de
 *    verdad de lo liquidado: medido, 3.45e-7 frente a 1.375e-6 por hora.
 *  - `settled`: tasa de un pago YA realizado. Hoy no se usa en el snapshot en
 *    vivo; sale de los endpoints de historico de cada venue.
 */
export type FundingKind = 'current' | 'predicted' | 'settled';

export interface FundingRate {
  /** Tasa del intervalo, en decimal. 0.0001 = 0.01%. >0: los longs pagan. */
  readonly rate: number;
  /** Horas que cubre `rate`. Tipico: 1, 4 u 8. */
  readonly intervalHours: number;
  /** Tasa prevista del proximo intervalo, o null si el venue no la publica. */
  readonly predicted: number | null;
  /** Epoch ms del proximo cobro, o null si no se conoce. */
  readonly nextFundingAt: number | null;
  /** Que es `rate`: estimacion del periodo en curso, del proximo, o liquidado. */
  readonly kind: FundingKind;
  /**
   * Campo exacto de la API del que sale `rate`, con su endpoint.
   *
   * Existe para poder rastrear cualquier cifra de la pantalla hasta la
   * respuesta cruda del venue sin abrir el codigo.
   */
  readonly sourceField: string;
}

/**
 * Foto de un simbolo en un venue en un instante.
 * `symbol` ya viene normalizado ('BTC', 'ETH'), sin el sufijo de cada venue.
 */
export interface MarketSnapshot {
  readonly venue: VenueId;
  /** Simbolo normalizado y comparable entre venues: 'BTC', 'PEPE'. */
  readonly symbol: string;
  /** Como lo llama este venue: 'BTC-PERP', 'kPEPE'. Necesario para operar. */
  readonly symbolNative: string;
  /**
   * Unidades del activo normalizado por unidad de contrato del venue.
   * 1000 para un 'kPEPE'. Los ratios de funding no dependen de esto, pero los
   * TAMANOS de orden si: sin esto, una pata sale mil veces mas grande que otra.
   */
  readonly contractMultiplier: number;
  readonly mid: number;
  readonly bid: number;
  readonly ask: number;
  readonly funding: FundingRate;
  /** null si el venue no expone libro (capabilities.orderBook === false). */
  readonly book: OrderBook | null;
  readonly openInterestUsd: number | null;
  readonly volume24hUsd: number | null;
  /**
   * Precio de cierre de ayer, si el venue lo publica.
   *
   * Es OPCIONAL y no `number | null` a secas porque los dos casos no son el
   * mismo: ausente es "este adaptador no lo trae", null seria "el venue lo
   * publica vacio". Hoy solo lo pone Hyperliquid, en el `prevDayPx` del mismo
   * `assetCtx` del que ya sale todo lo demas, asi que no cuesta una peticion.
   *
   * Lo usa el cambio de 24 h de la Terminal. La alternativa era sacarlo de
   * nuestro historico, y no vale: el historico tiene huecos de los dias en que
   * la app no estuvo corriendo, asi que la columna se vaciaba entera.
   */
  readonly prevDayPrice?: number | null;
  /**
   * Que contrato es. Ausente = perpetuo, que es casi todo.
   *
   * Variational lista ademas "swaps" sobre indices y materias primas
   * (`US500S`, `XAUS`, `USOILP`): sin funding (`funding_interval_s` 0) y
   * pegados al spot. No son un perpetuo con funding cero, son otro producto:
   * quien los muestra lo dice, y su funding no se pinta como si fuera un 0 %
   * medido.
   */
  readonly instrument?: 'perp' | 'swap';
  /**
   * Epoch ms en que NOSOTROS lo recibimos. Base de todo control de frescura.
   *
   * No es lo mismo que la hora del dato en origen: entre una y otra hay la
   * latencia de la peticion y, sobre todo, lo que el venue tardase en generar
   * ese dato. Para saber lo segundo esta `sourceAt`.
   */
  readonly at: number;
  /**
   * Epoch ms que el propio venue declara para el dato, o null si no lo publica.
   *
   * Solo Pacifica (`timestamp`) y Paradex (`created_at`) lo dan. Hyperliquid,
   * Backpack y dydx no publican ninguno, asi que de esos tres **no se puede
   * saber** si el dato es de hace un segundo o de hace diez minutos: lo unico
   * medible es cuando llego. Eso es una limitacion de la fuente, no del
   * recolector, y la pantalla lo dice en vez de disimularlo.
   */
  readonly sourceAt: number | null;
}

/** Estado de salud de un adaptador, para el chip de "venues activos". */
export interface VenueHealth {
  readonly venue: VenueId;
  readonly ok: boolean;
  /** Epoch ms del ultimo refresco correcto, o null si nunca respondio. */
  readonly lastOkAt: number | null;
  readonly symbolCount: number;
  readonly error: string | null;
}
