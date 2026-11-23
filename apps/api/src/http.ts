import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Primitivas HTTP sin framework.
 *
 * No hay Express ni Fastify a proposito: lo que necesita esta API es enrutado
 * por prefijo, JSON y validacion de entrada. Anadir un framework y su arbol de
 * dependencias para eso no se justifica, y cada dependencia es
 * superficie de supply chain en una maquina que va a tener acceso a datos de
 * trading.
 */

/** Error con codigo HTTP. Lo demas es un 500 y no se filtra al cliente. */
export class HttpProblem extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpProblem';
    this.status = status;
  }
}

export const badRequest = (msg: string) => new HttpProblem(400, msg);
export const notFound = (msg = 'not found') => new HttpProblem(404, msg);

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // La API sirve datos, nunca HTML: si algo intenta interpretarla como
    // documento, que no adivine el tipo.
    'x-content-type-options': 'nosniff',
    // Sin esto el navegador cachea las respuestas por heuristica y la pantalla
    // muestra datos viejos con aspecto de recien llegados. Es exactamente el
    // fallo silencioso contra el que se construye toda esta aplicacion.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendProblem(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpProblem) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  // Un error inesperado puede llevar dentro rutas, consultas o respuestas de un
  // venue. Se registra entero en el servidor y al cliente le llega lo minimo.
  console.error('error no controlado:', err);
  sendJson(res, 500, { error: 'error interno' });
}

// --- Validacion de entrada ---------------------------------------------------
// Todo lo que llega por query string es texto no fiable. Cada lectura declara
// su rango, y fuera de rango es 400, no un valor recortado en silencio: si se
// pide un nocional de mil millones, hay que decirlo, no servir otra cosa.

export interface NumberRange {
  readonly def: number;
  readonly min: number;
  readonly max: number;
}

export function numberParam(url: URL, name: string, range: NumberRange): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return range.def;

  const value = Number(raw);
  if (!Number.isFinite(value)) throw badRequest(`${name} must be a number`);
  if (value < range.min || value > range.max) {
    throw badRequest(`${name} must be between ${range.min} and ${range.max}`);
  }
  return value;
}

export function enumParam<T extends string>(
  url: URL,
  name: string,
  allowed: readonly T[],
  def: T,
): T {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return def;
  const found = allowed.find((a) => a === raw);
  if (found === undefined) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return found;
}

export function stringParam(url: URL, name: string, maxLength = 64): string {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') throw badRequest(`${name} is required`);
  const value = raw.trim();
  if (value.length > maxLength) throw badRequest(`${name} is too long`);
  return value;
}

export function listParam(url: URL, name: string, maxItems = 40): string[] {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return [];
  const items = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (items.length > maxItems) throw badRequest(`${name} accepts at most ${maxItems} values`);
  return items;
}

/** Lee el cuerpo como JSON, con tope de tamano. */
export async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of req) {
    const buf = trozo as Buffer;
    total += buf.length;
    // Cortar en el limite en vez de acumular: si no, un cliente puede agotar la
    // memoria de la Pi mandando un cuerpo infinito.
    if (total > maxBytes) throw badRequest('the request body is too large');
    trozos.push(buf);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(trozos).toString('utf8'));
  } catch {
    throw badRequest('the body is not valid JSON');
  }
}

// --- SSE ---------------------------------------------------------------------

/**
 * Abre un flujo de eventos y devuelve las funciones para usarlo.
 *
 * SSE en lugar de WebSocket porque el flujo es unidireccional: el servidor
 * empuja, el navegador no responde por el mismo canal. A cambio no hace falta
 * ninguna dependencia, `EventSource` reconecta solo y atraviesa proxies.
 */
export function openEventStream(res: ServerResponse): {
  send: (event: string, data: unknown) => void;
  close: () => void;
} {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // Comentario inicial: fuerza el vaciado de los buffers intermedios para que
  // el cliente sepa que la conexion esta viva antes del primer evento real.
  res.write(': conectado\n\n');

  let abierto = true;
  return {
    send(event, data) {
      if (!abierto) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      abierto = false;
      res.end();
    },
  };
}
