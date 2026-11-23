import { PhoenixAdapter, PHOENIX_META } from './adapters/phoenix.ts';
import { ArcusAdapter, ARCUS_META } from './adapters/arcus.ts';
import { RisexAdapter, RISEX_META } from './adapters/risex.ts';
import { EntropyAdapter, ENTROPY_META } from './adapters/entropy.ts';
import type { VenueMeta } from '@defi/core';
import { HyperliquidAdapter, HYPERLIQUID_META } from './adapters/hyperliquid.ts';
import { PacificaAdapter, PACIFICA_META } from './adapters/pacifica.ts';
import { BackpackAdapter, BACKPACK_META } from './adapters/backpack.ts';
import { ParadexAdapter, PARADEX_META } from './adapters/paradex.ts';
import { DydxAdapter, DYDX_META } from './adapters/dydx.ts';
import { AsterAdapter, ASTER_META } from './adapters/aster.ts';
import { VariationalAdapter, VARIATIONAL_META } from './adapters/variational.ts';
import { PerplAdapter, PERPL_META } from './adapters/perpl.ts';
import { ExtendedAdapter, EXTENDED_META } from './adapters/extended.ts';
import { OrderlyAdapter, ORDERLY_META } from './adapters/orderly.ts';
import { QfexAdapter, QFEX_META } from './adapters/qfex.ts';
import { LighterAdapter, LIGHTER_META } from './adapters/lighter.ts';
import type { AdapterFactory } from './types.ts';

interface RegistryEntry {
  readonly meta: VenueMeta;
  readonly create: AdapterFactory;
}

/**
 * Unica fuente de verdad de que venues existen.
 *
 * Las factorias son perezosas: enumerar el registro para pintar la UI no abre
 * ni una conexion. El collector instancia solo los que admite el presupuesto.
 */
export const REGISTRY: ReadonlyMap<string, RegistryEntry> = new Map<string, RegistryEntry>([
  ['hyperliquid', { meta: HYPERLIQUID_META, create: () => new HyperliquidAdapter() }],
  ['pacifica', { meta: PACIFICA_META, create: () => new PacificaAdapter() }],
  ['backpack', { meta: BACKPACK_META, create: () => new BackpackAdapter() }],
  ['paradex', { meta: PARADEX_META, create: () => new ParadexAdapter() }],
  ['dydx', { meta: DYDX_META, create: () => new DydxAdapter() }],
  ['aster', { meta: ASTER_META, create: () => new AsterAdapter() }],
  ['variational', { meta: VARIATIONAL_META, create: () => new VariationalAdapter() }],
  ['perpl', { meta: PERPL_META, create: () => new PerplAdapter() }],
  ['extended', { meta: EXTENDED_META, create: () => new ExtendedAdapter() }],
  ['orderly', { meta: ORDERLY_META, create: () => new OrderlyAdapter() }],
  ['phoenix', { meta: PHOENIX_META, create: () => new PhoenixAdapter() }],
  ['qfex', { meta: QFEX_META, create: () => new QfexAdapter() }],
  ['arcus', { meta: ARCUS_META, create: () => new ArcusAdapter() }],
  ['risex', { meta: RISEX_META, create: () => new RisexAdapter() }],
  ['entropy', { meta: ENTROPY_META, create: () => new EntropyAdapter() }],
  ['lighter', { meta: LIGHTER_META, create: () => new LighterAdapter() }],
]);

/**
 * Venues que se recogen por defecto.
 *
 * El registro de arriba es lo que la app SABE leer; esto es lo que lee. Los que
 * no estan aqui siguen en el codigo, probados y listos, pero no gastan
 * peticiones: la IP se comparte con otros bots.
 *
 * Se cambia con la variable de entorno VENUES (separados por comas).
 */
export const VENUES_POR_DEFECTO: readonly string[] = [
  'hyperliquid',
  'variational',
  'aster',
  'perpl',
  'pacifica',
  'backpack',
  'paradex',
  'dydx',
  'extended',
  'orderly',
  'qfex',
  'phoenix',
  'arcus',
  'risex',
  'entropy',
  'lighter',
];

/**
 * Los venues que OPERA el usuario.
 *
 * No es lo mismo que recoger: el volumen, el explorador y la paridad quieren
 * todos los venues que se puedan leer gratis, porque ahi la gracia es la
 * amplitud. El screener de funding no: comparar tasas de un sitio donde no vas
 * a abrir una posicion es ruido. Asi que se recogen todos y el screener llega
 * preseleccionado con estos, que el usuario puede cambiar y se le recuerda.
 */
export const VENUES_DEL_USUARIO: readonly string[] = [
  'hyperliquid',
  'variational',
  'aster',
  'perpl',
  'qfex',
  'phoenix',
  // Pedidos expresamente para el screener el 25 de septiembre de 2026.
  'arcus',
  'risex',
  'entropy',
];

/** Los venues activos: los de VENUES si esta puesta, y si no los de arriba. */
export function activeVenueIds(env: string | undefined = process.env['VENUES']): string[] {
  const pedidos = (env ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '');
  return pedidos.length > 0 ? pedidos : [...VENUES_POR_DEFECTO];
}

/** Ids de todos los venues conocidos. */
export const allVenueIds = (): string[] => [...REGISTRY.keys()];

/** Metadatos de todos los venues conocidos, sin instanciar nada. */
export const allVenueMeta = (): VenueMeta[] => [...REGISTRY.values()].map((e) => e.meta);

/** Instancia los venues pedidos, respetando el orden recibido como prioridad. */
export function createAdapters(ids: readonly string[]) {
  const out = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const entry = REGISTRY.get(id);
    if (entry === undefined) unknown.push(id);
    else out.push(entry.create());
  }
  if (unknown.length > 0) {
    // Fallar ruidosamente: un venue mal escrito en la configuracion
    // desapareceria en silencio y la UI mostraria una tabla incompleta con
    // aspecto de estar completa.
    throw new Error(`venues desconocidos en la configuracion: ${unknown.join(', ')}`);
  }
  return out;
}
