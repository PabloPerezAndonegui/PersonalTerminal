/**
 * Avisos por Telegram.
 *
 * Bot PROPIO, no el de un tercero. Lo unico que hace es mandar texto a un chat
 * del usuario: no lee ordenes, no responde comandos y no toca nada del venue.
 *
 * **El token es un secreto y vive fuera del repo**, en el `.env` real, igual
 * que el resto. Aqui solo se lee de `process.env` y nunca se escribe en un log
 * ni se devuelve por la API: un token filtrado deja a cualquiera escribir en
 * el chat haciendose pasar por este bot.
 *
 * Sin `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` no se manda nada y la pantalla
 * lo declara. Ponerlos es el acto manual y explicito que enciende el envio.
 *
 * Limites, medidos en la documentacion de Telegram el 23 de septiembre de
 * 2026: **un mensaje por segundo en un chat**, **20 por minuto en un grupo** y
 * unos 30 por segundo en total. Por eso los avisos se AGRUPAN en un mensaje
 * por trader y vuelta, en vez de uno por posicion: una cuenta que mueve quince
 * posiciones a la vez agotaria el limite del grupo en menos de un minuto y
 * Telegram empezaria a devolver 429.
 */

/** Lo que Telegram contesta cuando algo va mal. */
interface RespuestaTelegram {
  readonly ok: boolean;
  readonly description?: string;
  readonly error_code?: number;
  /** En un 429 trae `retry_after` con los segundos que hay que esperar. */
  readonly parameters?: { readonly retry_after?: number };
}

export interface TelegramOptions {
  readonly token: string;
  readonly chatId: string;
  /** Prepara el mensaje y lo da por bueno sin enviarlo. Para probar. */
  readonly dryRun?: boolean;
  /** Inyectable para las pruebas. Por defecto, el `fetch` de Node. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Como fue el ultimo envio. Es lo que ve la pantalla, sin el token. */
export interface TelegramStatus {
  readonly configured: boolean;
  readonly dryRun: boolean;
  /** Un grupo aguanta menos mensajes por minuto que un chat privado. */
  readonly group: boolean;
  readonly lastOkAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
  readonly sent: number;
  readonly failed: number;
  readonly queued: number;
}

/** Tope de Telegram por mensaje. Se corta antes de que lo corte el servidor. */
const LIMITE_TEXTO = 4_000;

const espera = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

export class Telegram {
  readonly #token: string;
  readonly #chatId: string;
  readonly #dryRun: boolean;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Hueco minimo entre mensajes. En grupo, 20 por minuto. */
  readonly #huecoMs: number;

  #cola: string[] = [];
  #enviando = false;
  #ultimoEnvio = 0;
  #estado = { lastOkAt: null as number | null, lastError: null as string | null,
    lastErrorAt: null as number | null, sent: 0, failed: 0 };

  constructor(options: TelegramOptions) {
    this.#token = options.token;
    this.#chatId = options.chatId;
    this.#dryRun = options.dryRun ?? false;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? espera;
    // Los identificadores de grupo y canal son negativos. Uno privado no.
    this.#huecoMs = options.chatId.startsWith('-') ? 3_000 : 1_000;
  }

  status(): TelegramStatus {
    return {
      configured: true,
      dryRun: this.#dryRun,
      group: this.#huecoMs > 1_000,
      ...this.#estado,
      queued: this.#cola.length,
    };
  }

  /**
   * Encola un mensaje. No espera a que salga.
   *
   * Un aviso que tarda no puede frenar la vuelta de lectura de posiciones, que
   * es lo que de verdad tiene que llegar a su hora.
   */
  send(text: string): void {
    this.#cola.push(text.length > LIMITE_TEXTO ? `${text.slice(0, LIMITE_TEXTO)}\n…` : text);
    void this.#vaciar();
  }

  /** Manda uno y espera respuesta. Es lo que usa el boton de prueba. */
  async sendNow(text: string): Promise<void> {
    await this.#entregar(text.length > LIMITE_TEXTO ? text.slice(0, LIMITE_TEXTO) : text);
  }

  async #vaciar(): Promise<void> {
    if (this.#enviando) return;
    this.#enviando = true;
    try {
      while (this.#cola.length > 0) {
        const pendiente = Date.now() - this.#ultimoEnvio;
        if (pendiente < this.#huecoMs) await this.#sleep(this.#huecoMs - pendiente);
        const texto = this.#cola.shift();
        if (texto === undefined) break;
        try {
          await this.#entregar(texto);
        } catch {
          // Ya queda anotado en el estado. Un aviso perdido no puede parar la
          // cola entera ni tumbar el proceso.
        }
      }
    } finally {
      this.#enviando = false;
    }
  }

  async #entregar(text: string): Promise<void> {
    this.#ultimoEnvio = Date.now();
    if (this.#dryRun) {
      this.#estado.lastOkAt = Date.now();
      this.#estado.sent++;
      return;
    }

    for (let intento = 0; intento < 2; intento++) {
      try {
        const r = await this.#fetch(`https://api.telegram.org/bot${this.#token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.#chatId,
            text,
            parse_mode: 'HTML',
            // Un aviso no tiene que abrir tarjetas de enlaces ni sonar.
            link_preview_options: { is_disabled: true },
            disable_notification: false,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        const d = (await r.json().catch(() => null)) as RespuestaTelegram | null;
        if (r.ok && d?.ok === true) {
          this.#estado.lastOkAt = Date.now();
          this.#estado.lastError = null;
          this.#estado.sent++;
          return;
        }

        // 429: Telegram dice cuanto hay que esperar. Se le hace caso y se
        // reintenta UNA vez; insistir mas es lo que acaba en un bloqueo.
        const reintentar = d?.parameters?.retry_after;
        if (r.status === 429 && typeof reintentar === 'number' && intento === 0) {
          await this.#sleep(Math.min(reintentar, 60) * 1_000);
          continue;
        }
        throw new Error(d?.description ?? `HTTP ${r.status}`);
      } catch (err) {
        if (intento === 0 && err instanceof Error && err.name === 'TimeoutError') continue;
        this.#estado.failed++;
        this.#estado.lastErrorAt = Date.now();
        // El token puede venir dentro de la URL en el mensaje de error de la
        // red. Se tapa antes de guardarlo, porque este texto acaba en la API.
        this.#estado.lastError = (err instanceof Error ? err.message : String(err))
          .split(this.#token).join('***');
        throw err;
      }
    }
  }
}

/** Sin configurar. Todo lo demas funciona igual y la pantalla lo declara. */
export const TELEGRAM_APAGADO: TelegramStatus = {
  configured: false, dryRun: false, group: false, lastOkAt: null,
  lastError: null, lastErrorAt: null, sent: 0, failed: 0, queued: 0,
};

/**
 * Lo construye desde el entorno, o devuelve null si no esta configurado.
 *
 * No se inventa ningun valor por defecto: sin las dos variables, no hay envio.
 */
export function telegramFromEnv(env: NodeJS.ProcessEnv = process.env): Telegram | null {
  const token = env['TELEGRAM_BOT_TOKEN']?.trim();
  const chatId = env['TELEGRAM_CHAT_ID']?.trim();
  if (token === undefined || token === '' || chatId === undefined || chatId === '') return null;
  return new Telegram({
    token, chatId,
    dryRun: (env['TELEGRAM_DRY_RUN'] ?? '').toLowerCase() === 'true',
  });
}
