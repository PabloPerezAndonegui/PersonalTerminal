import type { AccountSnapshot, AddressKind, MarketSnapshot, OrderBook, VenueMeta } from '@defi/core';

/**
 * Lo que cuesta mantener un adaptador vivo. Se declara, no se estima: la Pi
 * comparte IP publica con los otros bots, y el limite de conexiones y de rate
 * es por IP. Ver "Presupuesto de conexiones" en ARCHITECTURE.md.
 */
export interface AdapterCost {
  /** Conexiones WebSocket persistentes que abre en regimen estacionario. */
  readonly websockets: number;
  /** Peticiones REST por minuto en regimen estacionario. */
  readonly requestsPerMinute: number;
}

/**
 * Contrato de un venue. Cada adaptador traduce una API concreta al modelo del
 * dominio y no decide nada: no filtra oportunidades, no ordena, no puntua.
 *
 * `refresh()` PUEDE lanzar. La resiliencia (reintentos, salud, backoff) vive en
 * el collector, para no repetirla en veinte adaptadores.
 */
export interface VenueAdapter {
  readonly meta: VenueMeta;
  readonly cost: AdapterCost;

  /** Config estatica y conexiones persistentes. Opcional en venues REST puros. */
  start?(signal: AbortSignal): Promise<void>;
  stop?(): void;

  /** Refresca el estado interno. En adaptadores WS suele ser un no-op. */
  refresh(): Promise<void>;

  /** Estado actual por simbolo normalizado. Solo simbolos con datos validos. */
  snapshot(): ReadonlyMap<string, MarketSnapshot>;

  /**
   * Libro L2 de un simbolo concreto, bajo demanda.
   *
   * El escaneo va en dos fases a proposito: refresh() trae funding y precios
   * de TODOS los simbolos en una o dos peticiones baratas, y el libro solo se
   * pide para los pocos candidatos que superan el umbral. Pedir el libro de los
   * 233 perpetuos de Hyperliquid en cada ciclo son 233 peticiones: inviable en
   * una Pi y una forma rapida de comerse el rate limit de la IP.
   *
   * Ausente si el venue no expone profundidad.
   */
  fetchBook?(symbol: string): Promise<OrderBook | null>;

  /**
   * Formatos de direccion que este venue entiende.
   *
   * Consultar una direccion de Solana contra un venue EVM no devuelve "sin
   * posiciones": devuelve error, o un vacio que se lee como "esta wallet no
   * opera aqui", que es una afirmacion distinta y falsa.
   */
  readonly addressKinds?: readonly AddressKind[];

  /**
   * Posiciones y saldo de una direccion PUBLICA, sin credenciales.
   *
   * Ausente en los venues que exigen autenticacion para consultarlo. La UI lo
   * declara en lugar de dejar el hueco: que un venue no salga en el Tracker
   * tiene que distinguirse de que la wallet no opere alli.
   */
  fetchPositions?(address: string): Promise<AccountSnapshot | null>;

  /**
   * Otros contratos del MISMO activo en este venue, que no caben en
   * `snapshot()` porque el nombre ya lo tiene el perpetuo. Hoy solo los swaps
   * de Variational (`XAUS` junto a `XAU`). Los ensena el Explorer; Funding
   * Arb y Parity siguen con uno por activo.
   */
  otrosInstrumentos?(): readonly MarketSnapshot[];

  /**
   * Simbolos nativos distintos que normalizaron al mismo nombre en el ultimo
   * refresco, con cual se quedo y por que.
   *
   * Vacio es lo normal. Que deje de estarlo significa que el venue ha listado
   * algo que choca con otro mercado suyo — spot contra perpetuo, o dos
   * contratos del mismo activo — y que uno de los dos se esta descartando. El
   * criterio automatico puede acertar, pero la decision hay que verla.
   */
  readonly colisiones?: readonly string[];

  /**
   * Por que no se pueden leer posiciones aqui, cuando `fetchPositions` falta.
   *
   * Un motivo generico esconde una diferencia que importa: en Backpack los
   * datos de cuenta son privados y punto, mientras que en Paradex son estado
   * de Starknet y por tanto publicos en la cadena — lo que no hay es una via
   * por su API REST. Una se puede resolver algun dia y la otra no.
   */
  readonly noPositionsReason?: string;
}

/** Constructor perezoso: el registro no instancia nada hasta que hace falta. */
export type AdapterFactory = () => VenueAdapter;
