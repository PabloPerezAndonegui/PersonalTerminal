/**
 * Cliente HTTP minimo para adaptadores.
 *
 * En una Pi con conexion domestica los cortes de red son rutina, asi que
 * timeout y reintentos no son opcionales. Se reintenta solo lo que tiene
 * sentido reintentar: errores de red y 5xx/429. Un 4xx es un bug nuestro y
 * repetirlo solo gasta rate limit.
 */
export interface HttpOptions {
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly signal?: AbortSignal;
}

export class HttpError extends Error {
  // Campos declarados y asignados a mano: Node ejecuta TypeScript borrando
  // tipos, sin transformarlos, asi que las parameter properties de TS no
  // existen aqui. `erasableSyntaxOnly` en tsconfig lo caza en el typecheck.
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} en ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once(url: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''));
  return res.json();
}

async function request(url: string, init: RequestInit, opts: HttpOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(url, init, timeoutMs, opts.signal);
    } catch (err) {
      lastError = err;
      const retryable = !(err instanceof HttpError) || RETRYABLE_STATUS.has(err.status);
      if (!retryable || attempt === retries) break;
      // Backoff exponencial con jitter: si veinte venues fallan a la vez por un
      // corte de red, no quiero que reintenten todos en el mismo milisegundo.
      await sleep(2 ** attempt * 250 + Math.random() * 250);
    }
  }
  throw lastError;
}

export const getJson = (url: string, opts: HttpOptions = {}): Promise<unknown> =>
  request(url, { method: 'GET', headers: { accept: 'application/json' } }, opts);

export const postJson = (url: string, body: unknown, opts: HttpOptions = {}): Promise<unknown> =>
  request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  }, opts);

/**
 * Convierte a numero finito o devuelve null. Las APIs de exchange mandan los
 * numeros como string y ocasionalmente mandan '', null o 'NaN'. Nunca se
 * devuelve 0 por defecto: un 0 inventado se propaga como si fuera un dato real.
 */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
