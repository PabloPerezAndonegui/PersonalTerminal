import { isRecord, num } from '../http.ts';
import { normalizeSymbol } from '../symbols.ts';

/**
 * Las ejecuciones reales de una cuenta de Hyperliquid.
 *
 * ## Por que esto y no comparar fotos de posicion
 *
 * Comparando posiciones cada pocos minutos se pierde lo que se abre y se
 * cierra entre lecturas, y un cambio de nocional por movimiento de precio se
 * confunde con una operacion. `userFills` publica el fill: direccion, precio,
 * tamano, comision y PnL realizado, con su identificador.
 *
 * ## Lo que hay que mirar con cuidado
 *
 * **El tamano viene en unidades del activo, no en dolares.** El nocional es
 * `px * sz`, y hay que calcularlo aqui: pedirle a la pantalla que multiplique
 * es como acaban saliendo cifras mil veces mayores.
 *
 * **El simbolo viene en nombre nativo.** Hyperliquid llama `kPEPE` a los lotes
 * de mil PEPE, asi que el tamano y el precio son por lote. Se normalizan los
 * dos con el mismo multiplicador para que un fill de kPEPE se pueda comparar
 * con uno de PEPE en otro venue. El nocional no cambia: el multiplicador se
 * cancela entre precio y tamano, que es justo lo que lo hace facil de olvidar.
 *
 * **La direccion la da el venue.** `dir` viene como 'Open Long', 'Close Short'
 * y similares. No se deduce del signo de nada: deducirla es como se inventan
 * operaciones que no existieron.
 */

export interface FillCrudo {
  readonly tid: string;
  /** Simbolo normalizado, comparable entre venues. */
  readonly symbol: string;
  /** Como lo llama el venue, por si hay que volver a su API. */
  readonly symbolNative: string;
  readonly ts: number;
  readonly dir: string;
  readonly side: 'long' | 'short';
  /** Por unidad del activo normalizado, ya sin el multiplicador del lote. */
  readonly px: number;
  /** En unidades del activo normalizado. */
  readonly sz: number;
  readonly notionalUsd: number;
  readonly closedPnl: number | null;
  readonly fee: number | null;
}

const API = 'https://api.hyperliquid.xyz/info';

async function post(body: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) throw new Error(`hyperliquid: HTTP ${res.status}`);
  return res.json();
}

/**
 * De que lado queda la posicion despues del fill.
 *
 * Se lee de `dir`, que es lo que publica el venue, y NO del campo `side`, que
 * dice si la orden fue compra o venta. No son lo mismo: cerrar un corto es una
 * compra, y contarlo como largo pondria al trader del lado contrario del que
 * estaba. Es el error que convierte una salida en una entrada.
 */
function ladoDe(dir: string, side: string): 'long' | 'short' {
  const d = dir.toLowerCase();
  if (d.includes('long')) return 'long';
  if (d.includes('short')) return 'short';
  // Sin direccion declarada (spot, liquidaciones raras) queda el lado de la
  // orden, que al menos viene del venue y no de una suposicion nuestra.
  return side.toUpperCase() === 'A' ? 'short' : 'long';
}

/**
 * Ejecuciones de una cuenta desde un instante.
 *
 * `desde` en milisegundos. Sin el, el venue devuelve las mas recientes y ya.
 * Conviene solapar un poco la ventana al repetir: los duplicados los descarta
 * el almacenamiento por `tid`, asi que solapar es gratis y perder un fill no.
 *
 * El venue corta en 2.000 por respuesta. Si vuelven 2.000 exactos, es que
 * puede haber mas y quien llama deberia volver a pedir desde el ultimo sello;
 * se devuelve `completo` para que no haya que adivinarlo contando.
 */
export async function fetchHyperliquidFills(
  address: string,
  desde?: number,
  signal?: AbortSignal,
): Promise<{ fills: FillCrudo[]; completo: boolean }> {
  const raw = desde === undefined
    ? await post({ type: 'userFills', user: address }, signal)
    : await post({ type: 'userFillsByTime', user: address, startTime: desde }, signal);

  if (!Array.isArray(raw)) throw new Error('hyperliquid fills: respuesta inesperada');

  const fills: FillCrudo[] = [];
  for (const fila of raw) {
    if (!isRecord(fila)) continue;
    const tid = fila['tid'];
    const coin = typeof fila['coin'] === 'string' ? fila['coin'] : null;
    const px = num(fila['px']);
    const sz = num(fila['sz']);
    const ts = num(fila['time']);
    if (tid === undefined || tid === null || coin === null) continue;
    if (px === null || sz === null || ts === null) continue;
    if (px <= 0 || sz < 0) continue;

    const norm = normalizeSymbol(coin);
    const mult = norm.contractMultiplier > 0 ? norm.contractMultiplier : 1;

    fills.push({
      tid: String(tid),
      symbol: norm.symbol,
      symbolNative: coin,
      ts,
      dir: typeof fila['dir'] === 'string' ? fila['dir'] : '',
      side: ladoDe(typeof fila['dir'] === 'string' ? fila['dir'] : '', String(fila['side'] ?? '')),
      // Precio por unidad y tamano en unidades: el multiplicador se aplica a
      // los dos en sentidos contrarios, asi que el nocional no cambia.
      px: px / mult,
      sz: sz * mult,
      notionalUsd: px * sz,
      closedPnl: num(fila['closedPnl']),
      fee: num(fila['fee']),
    });
  }

  return { fills, completo: raw.length < 2000 };
}

/**
 * El valor de la cuenta, para saber que parte de ella movia cada operacion.
 *
 * Se lee aparte porque `userFills` no lo trae. Si falla, las ejecuciones se
 * guardan igual con el porcentaje a null: perder el contexto no justifica
 * perder el dato.
 */
export async function fetchHyperliquidEquity(
  address: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const raw = await post({ type: 'clearinghouseState', user: address }, signal);
  if (!isRecord(raw) || !isRecord(raw['marginSummary'])) return null;
  const v = num(raw['marginSummary']['accountValue']);
  return v !== null && v > 0 ? v : null;
}
