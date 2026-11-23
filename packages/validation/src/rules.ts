import type { MarketSnapshot } from '@defi/core';
import { fundingAprPct, agruparPrecios, precioDeReferencia } from '@defi/core';

/**
 * Validacion de plausibilidad en la INGESTA.
 *
 * El typecheck y los tests unitarios no ven un dato absurdo: el bug que hacia
 * que Paradex publicase 290.000 millones de volumen diario en BTC pasaba las
 * dos cosas. Se encontro mirando los numeros a mano, y eso no escala a veinte
 * venues. Estas reglas lo convierten en una propiedad del sistema: un venue que
 * publica valores imposibles se marca degradado solo, con el motivo visible en
 * Data Sources.
 *
 * Son puras y no hacen I/O: se ejecutan en cada ciclo sobre datos en memoria.
 */

export type FindingSeverity = 'error' | 'warning';

export interface Finding {
  readonly venue: string;
  /** null cuando el hallazgo afecta al venue entero, no a un simbolo. */
  readonly symbol: string | null;
  /** Identificador estable de la regla, para poder silenciar una en concreto. */
  readonly rule: string;
  readonly severity: FindingSeverity;
  readonly message: string;
}

export interface ValidationThresholds {
  /** Techo de volumen 24 h y de interes abierto para UN simbolo en UN venue. */
  readonly maxNotionalUsd: number;
  /** APR de funding por encima del cual se sospecha error de intervalo. */
  readonly maxFundingAprPct: number;
  /** Desviacion de precio frente a la mediana que se considera sospechosa. */
  readonly priceWarnRatio: number;
  /** Desviacion que ya no puede ser mercado: es un bug. */
  readonly priceErrorRatio: number;
  /** Venues minimos con el simbolo para que la mediana signifique algo. */
  readonly minVenuesForPriceCheck: number;
}

export const DEFAULT_THRESHOLDS: ValidationThresholds = {
  // El volumen diario de TODO el mercado cripto ronda los 100.000 millones.
  // Un solo simbolo en un solo venue por encima de eso es un error de unidades.
  maxNotionalUsd: 100e9,
  // La app ha llegado a mostrar 1716 % reales, asi que el techo va muy alto: se
  // busca lo imposible, no lo llamativo.
  maxFundingAprPct: 20_000,
  priceWarnRatio: 1.1,
  // Dos venues no pueden diferir el doble en el precio del mismo activo. Si
  // ocurre, o hay un multiplicador mal aplicado, o son activos distintos con el
  // mismo ticker.
  priceErrorRatio: 2,
  minVenuesForPriceCheck: 3,
};

/** Reglas que solo miran un snapshot aislado. */
function validateSingle(s: MarketSnapshot, t: ValidationThresholds): Finding[] {
  const out: Finding[] = [];
  const base = { venue: s.venue, symbol: s.symbol };

  if (!Number.isFinite(s.mid) || s.mid <= 0) {
    out.push({ ...base, rule: 'precio-invalido', severity: 'error', message: `invalid mid: ${s.mid}` });
    // Sin precio valido, el resto de comprobaciones no significan nada.
    return out;
  }

  if (Number.isFinite(s.bid) && Number.isFinite(s.ask) && s.bid > 0 && s.ask > 0 && s.bid > s.ask) {
    out.push({
      ...base,
      rule: 'libro-invertido',
      severity: 'error',
      message: `bid ${s.bid} above ask ${s.ask}: crossed book`,
    });
  }

  if (s.volume24hUsd !== null && s.volume24hUsd > t.maxNotionalUsd) {
    out.push({
      ...base,
      rule: 'volumen-imposible',
      severity: 'error',
      message:
        `24h volume of $${(s.volume24hUsd / 1e9).toFixed(0)}B, above the ` +
        `$${(t.maxNotionalUsd / 1e9).toFixed(0)}B ceiling: likely a unit error (base vs USD)`,
    });
  }

  if (s.openInterestUsd !== null && s.openInterestUsd > t.maxNotionalUsd) {
    out.push({
      ...base,
      rule: 'oi-imposible',
      severity: 'error',
      message:
        `open interest of $${(s.openInterestUsd / 1e9).toFixed(0)}B: likely a unit error`,
    });
  }

  if (s.volume24hUsd !== null && s.volume24hUsd < 0) {
    out.push({ ...base, rule: 'volumen-negativo', severity: 'error', message: 'negative volume' });
  }

  const apr = fundingAprPct(s.funding);
  if (Math.abs(apr) > t.maxFundingAprPct) {
    out.push({
      ...base,
      rule: 'funding-imposible',
      severity: 'error',
      message: `funding of ${apr.toFixed(0)}% a year: likely a wrong funding interval`,
    });
  }

  if (s.funding.intervalHours <= 0) {
    out.push({
      ...base,
      rule: 'intervalo-invalido',
      severity: 'error',
      message: `invalid funding interval: ${s.funding.intervalHours}h`,
    });
  }

  return out;
}

/**
 * Coherencia de precio entre venues.
 *
 * Es la regla que mas cubre con menos codigo. El mismo activo no puede valer el
 * doble en un venue que en otro; cuando ocurre, la causa esta casi siempre en
 * una de estas cuatro:
 *
 *   - Un multiplicador mal aplicado ('kPEPE' tratado como 'PEPE' da 1000x).
 *   - Un error de decimales al parsear.
 *   - Un precio congelado que se quedo de un ciclo viejo.
 *   - **El mismo ticker siendo activos distintos en dos venues.** Este es el
 *     peligroso: el scanner calcularia un diferencial de funding entre dos cosas
 *     que no son la misma, y eso se traduce en dinero perdido.
 *
 * Necesita al menos tres venues: con dos no se puede saber cual de los dos miente.
 */
/**
 * Multiplicadores que existen. Un desajuste de precio CERCANO a uno de estos es
 * casi seguro un multiplicador mal aplicado, que es un error nuestro.
 */
const MULTIPLICADORES = [10, 100, 1000, 10_000, 100_000, 1_000_000];

/** Si el desajuste se explica por un multiplicador, con un 5 % de margen. */
function pareceMultiplicador(desviacion: number): boolean {
  return MULTIPLICADORES.some((k) => Math.abs(desviacion - k) / k < 0.05);
}

/**
 * Si el nombre nativo lleva prefijo de multiplicador.
 *
 * Es la otra mitad de la pregunta, y hace falta: el factor redondo por si solo
 * no basta. El BB de Aster es BounceBit a 0,00806 y el de Extended es
 * BlackBerry a 8,06, o sea 999,9x de pura casualidad, y ahi no hay ningun
 * multiplicador que aplicar ni que olvidar. Un multiplicador solo se puede
 * equivocar donde el venue PONE uno en el nombre.
 */
function tienePrefijoDeMultiplicador(nativo: string): boolean {
  const s = nativo.toUpperCase();
  // '1000PEPEUSDT', 'PERP_1000BONK_USDC', 'KPEPE', 'kNOT-USD'.
  return /(?:^|[^A-Z0-9])(10{1,6})[A-Z]/.test(s) || /(?:^|[^A-Z0-9])K[A-Z]{2,}/.test(s);
}

function validateCrossVenue(
  porSimbolo: ReadonlyMap<string, readonly MarketSnapshot[]>,
  t: ValidationThresholds,
): Finding[] {
  const out: Finding[] = [];

  for (const [symbol, listados] of porSimbolo) {
    if (listados.length < t.minVenuesForPriceCheck) continue;

    const precios = listados.map((s) => s.mid).filter((m) => Number.isFinite(m) && m > 0);

    // La referencia es el grupo mayoritario, no la mediana. Con QNT en cuatro
    // venues, dos a 252 y dos a 46,5, la mediana salia 149,41 y los CUATRO se
    // desviaban de ella: cuatro hallazgos contra un precio que no cotiza
    // nadie. Ahora se dice lo que de verdad pasa, una vez, y con los grupos.
    const referencia = precioDeReferencia(precios, t.priceWarnRatio);
    if (referencia === null) {
      const grupos = agruparPrecios(precios, t.priceWarnRatio);
      // Un solo grupo que no da mayoria no existe, asi que si no hay
      // referencia es que hay varios: el ticker significa varias cosas.
      if (grupos.length > 1) {
        const resumen = grupos
          .map((g) => `${g.length} at ~${(g[Math.floor(g.length / 2)] ?? 0).toPrecision(4)}`)
          .join(', ');
        out.push({
          venue: listados[0]?.venue ?? '-',
          symbol,
          rule: 'ticker-ambiguo',
          severity: 'warning',
          message:
            `${listados.length} venues split into ${grupos.length} price groups (${resumen}) `
            + 'with no majority: the same ticker is more than one asset, kept out of the comparison',
        });
      }
      continue;
    }
    const mediana = referencia.precio;

    for (const s of listados) {
      if (!Number.isFinite(s.mid) || s.mid <= 0) continue;
      const ratio = s.mid / mediana;
      const desviacion = ratio >= 1 ? ratio : 1 / ratio;
      if (desviacion < t.priceWarnRatio) continue;

      // Dos causas muy distintas con la misma pinta, y se separan por el
      // FACTOR. Un multiplicador mal aplicado da exactamente 10, 100 o 1000,
      // porque eso es lo que es. Un ticker que significa dos cosas da un
      // numero cualquiera: 115.5x entre el PURR de Hyperliquid y otro PURR,
      // 212.8x entre la accion B y el token B, 395 millones entre Caterpillar
      // y el memecoin CAT.
      //
      // Lo primero es un fallo nuestro y tiene que poner el venue en amarillo.
      // Lo segundo no lo es: son dos activos distintos que se llaman igual, y
      // de eso ya se encarga la matriz apartandolos de la comparacion. Con
      // venues de acciones al lado de los de cripto pasa a menudo, y degradar
      // por ello dejaba cuatro de once fuentes en amarillo permanente.
      const grande = desviacion >= t.priceErrorRatio;
      // Culpa nuestra solo si se dan las DOS cosas: que el hueco sea un
      // multiplicador redondo y que el nombre nativo lleve uno. Con una sola
      // de las dos, el 999,9x entre BounceBit y BlackBerry nos acusaba de un
      // fallo que no existe.
      const culpaNuestra = pareceMultiplicador(desviacion) && tienePrefijoDeMultiplicador(s.symbolNative);
      // Un hueco grande que NO es un multiplicador redondo son dos activos
      // distintos con el mismo nombre. Eso no es un fallo del venue ni
      // nuestro, asi que se anota pero no lo pone en amarillo.
      const ambiguo = grande && !culpaNuestra;
      const severity: FindingSeverity = grande && culpaNuestra ? 'error' : 'warning';
      out.push({
        venue: s.venue,
        symbol,
        rule: ambiguo ? 'ticker-ambiguo' : 'precio-incoherente',
        severity,
        message:
          `price ${s.mid} against a median of ${mediana.toFixed(6)} across ${listados.length} venues ` +
          `(${desviacion.toFixed(1)}x)` +
          (ambiguo
            ? ': the same ticker is a different asset here, kept out of the comparison'
            : grande
              ? ': the gap is a round multiplier, so it looks like ours'
              : ''),
      });
    }
  }

  return out;
}

/**
 * Valida un ciclo completo. Devuelve los hallazgos ordenados con los errores
 * primero, para que el motivo que se muestre sea el mas grave.
 */
export function validateCycle(
  snapshots: ReadonlyMap<string, ReadonlyMap<string, MarketSnapshot>>,
  thresholds: ValidationThresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const out: Finding[] = [];
  const porSimbolo = new Map<string, MarketSnapshot[]>();

  for (const bySymbol of snapshots.values()) {
    for (const s of bySymbol.values()) {
      out.push(...validateSingle(s, thresholds));
      const lista = porSimbolo.get(s.symbol);
      if (lista === undefined) porSimbolo.set(s.symbol, [s]);
      else lista.push(s);
    }
  }

  out.push(...validateCrossVenue(porSimbolo, thresholds));
  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return out;
}

/** Agrupa hallazgos por venue, para que el collector degrade a quien toca. */
export function findingsByVenue(findings: readonly Finding[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of findings) {
    const lista = out.get(f.venue);
    if (lista === undefined) out.set(f.venue, [f]);
    else lista.push(f);
  }
  return out;
}
