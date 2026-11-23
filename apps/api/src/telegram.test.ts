import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, telegramFromEnv } from './telegram.ts';

const TOKEN = '123456:FAKE-TOKEN-DE-PRUEBA';

/** Respuesta de mentira con la forma que devuelve Telegram. */
function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('en dryRun no sale ninguna peticion, pero cuenta como enviado', async () => {
  let llamadas = 0;
  const t = new Telegram({
    token: TOKEN, chatId: '42', dryRun: true,
    fetchImpl: async () => { llamadas++; return respuesta(200, { ok: true }); },
  });

  await t.sendNow('hola');
  assert.equal(llamadas, 0, 'no se llama a Telegram');
  assert.equal(t.status().sent, 1);
  assert.equal(t.status().dryRun, true);
});

test('manda al endpoint correcto y con el chat', async () => {
  let url = '';
  let cuerpo: Record<string, unknown> = {};
  const t = new Telegram({
    token: TOKEN, chatId: '42',
    fetchImpl: async (u, init) => {
      url = String(u);
      cuerpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return respuesta(200, { ok: true });
    },
  });

  await t.sendNow('hola');
  assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(cuerpo['chat_id'], '42');
  assert.equal(cuerpo['text'], 'hola');
  assert.equal(t.status().sent, 1);
});

test('un 429 se espera lo que dice Telegram y se reintenta UNA vez', async () => {
  const esperas: number[] = [];
  let intentos = 0;
  const t = new Telegram({
    token: TOKEN, chatId: '42',
    sleep: async (ms) => { esperas.push(ms); },
    fetchImpl: async () => {
      intentos++;
      return intentos === 1
        ? respuesta(429, { ok: false, error_code: 429, parameters: { retry_after: 7 } })
        : respuesta(200, { ok: true });
    },
  });

  await t.sendNow('hola');
  assert.deepEqual(esperas, [7_000], 'le hace caso al retry_after');
  assert.equal(intentos, 2);
  assert.equal(t.status().sent, 1);
});

test('EL TOKEN NO PUEDE ACABAR EN EL ESTADO', async () => {
  // El estado lo sirve la API y se pinta en la pantalla. Telegram mete la URL
  // entera, con el token dentro, en algunos mensajes de error.
  const t = new Telegram({
    token: TOKEN, chatId: '42',
    fetchImpl: async () => { throw new Error(`falla https://api.telegram.org/bot${TOKEN}/sendMessage`); },
  });

  await assert.rejects(() => t.sendNow('hola'));
  const e = t.status();
  assert.equal(e.failed, 1);
  assert.ok(e.lastError !== null && !e.lastError.includes(TOKEN), 'tapado');
  assert.ok(e.lastError?.includes('***'));
});

test('el error de Telegram se cuenta y se conserva su descripcion', async () => {
  const t = new Telegram({
    token: TOKEN, chatId: '42',
    fetchImpl: async () => respuesta(400, { ok: false, description: 'chat not found' }),
  });

  await assert.rejects(() => t.sendNow('hola'), /chat not found/);
  assert.equal(t.status().lastError, 'chat not found');
});

test('un grupo tiene menos hueco que un chat privado', () => {
  const privado = new Telegram({ token: TOKEN, chatId: '42' });
  const grupo = new Telegram({ token: TOKEN, chatId: '-1001234567890' });
  assert.equal(privado.status().group, false);
  assert.equal(grupo.status().group, true, 'los grupos son negativos');
});

test('un mensaje gigante se corta antes de que lo corte Telegram', async () => {
  let texto = '';
  const t = new Telegram({
    token: TOKEN, chatId: '42',
    fetchImpl: async (_u, init) => {
      texto = (JSON.parse(String(init?.body)) as { text: string }).text;
      return respuesta(200, { ok: true });
    },
  });

  await t.sendNow('x'.repeat(9_000));
  assert.ok(texto.length <= 4_000, `quedo en ${texto.length}`);
});

test('sin las dos variables no hay bot', () => {
  assert.equal(telegramFromEnv({}), null);
  assert.equal(telegramFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN }), null, 'falta el chat');
  assert.equal(telegramFromEnv({ TELEGRAM_CHAT_ID: '42' }), null, 'falta el token');
  assert.equal(telegramFromEnv({ TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '42' }), null,
    'una variable vacia no cuenta como configurada');
  assert.notEqual(telegramFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' }), null);
});

test('TELEGRAM_DRY_RUN enciende el modo prueba', () => {
  const t = telegramFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', TELEGRAM_DRY_RUN: 'true' });
  assert.equal(t?.status().dryRun, true);
});
