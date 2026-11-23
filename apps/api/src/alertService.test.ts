import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountSnapshot, Position, PositionSide } from '@defi/core';
import { openDatabase, addTrader, updateTrader, listAlertEvents } from '@defi/storage';
import { AlertService, formatEvent, formatMessage } from './alertService.ts';
import { Telegram } from './telegram.ts';

const DIR = '0x1111111111111111111111111111111111111111';

function pos(symbol: string, side: PositionSide, sizeBase: number, mark: number): Position {
  return {
    venue: 'hyperliquid', symbol, symbolNative: symbol, side, sizeBase,
    notionalUsd: sizeBase * mark, entryPrice: mark, markPrice: mark,
    unrealizedPnlUsd: 0, leverage: 5, liquidationPrice: null,
  };
}

function foto(positions: Position[], at: number): AccountSnapshot {
  return { venue: 'hyperliquid', address: DIR, equityUsd: 1e6, marginUsedUsd: 1e5, positions, at };
}

/** Bot de mentira que apunta lo que se le manda. */
function bot(): { t: Telegram; mensajes: string[] } {
  const mensajes: string[] = [];
  const t = new Telegram({
    token: 'x:y', chatId: '42',
    fetchImpl: async (_u, init) => {
      mensajes.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { t, mensajes };
}

test('guarda lo que cambia aunque no haya Telegram, y lo deja sin marcar', () => {
  const db = openDatabase({ path: ':memory:' });
  const trader = addTrader(db, { address: DIR, alias: 'Uno' });
  const s = new AlertService({ db });

  s.onRead(trader, foto([], 1_000), foto([pos('BTC', 'long', 1, 80_000)], 61_000));

  const filas = listAlertEvents(db);
  assert.equal(filas.length, 1);
  assert.equal(filas[0]?.kind, 'opened');
  assert.equal(filas[0]?.notifiedAt, null, 'detectado pero NO enviado, y se distingue');
  assert.equal(s.status().telegram.configured, false);
  assert.equal(s.status().unsent, 1);
});

test('con bot configurado se manda un solo mensaje con todos los cambios', async () => {
  const db = openDatabase({ path: ':memory:' });
  const trader = addTrader(db, { address: DIR, alias: 'Uno' });
  const { t, mensajes } = bot();
  const s = new AlertService({ db, telegram: t });

  s.onRead(
    trader,
    foto([pos('BTC', 'long', 1, 80_000), pos('ETH', 'long', 10, 3_000)], 1_000),
    foto([pos('BTC', 'long', 2, 80_000), pos('SOL', 'long', 500, 200)], 61_000),
  );

  // La cola deja pasar un mensaje por segundo; el primero sale enseguida.
  await new Promise((r) => { setTimeout(r, 50); });

  assert.equal(mensajes.length, 1, 'uno por trader y vuelta, no uno por posicion');
  const m = mensajes[0] ?? '';
  assert.ok(m.includes('INCREASED BTC LONG'), m);
  assert.ok(m.includes('CLOSED ETH LONG'), m);
  assert.ok(m.includes('OPENED SOL LONG'), m);
  assert.equal(listAlertEvents(db).every((e) => e.notifiedAt !== null), true);
});

test('NO avisa si las dos lecturas estan demasiado separadas', () => {
  // Reinicio, pausa larga o corte de la API. Decir "ha abierto BTC" cuando lo
  // que ha pasado es que llevabamos horas sin mirar es un aviso falso.
  const db = openDatabase({ path: ':memory:' });
  const trader = addTrader(db, { address: DIR });
  const s = new AlertService({ db, maxGapMs: 120_000 });

  s.onRead(trader, foto([], 1_000), foto([pos('BTC', 'long', 1, 80_000)], 1_000 + 3_600_000));

  assert.deepEqual(listAlertEvents(db), []);
  assert.equal(s.status().detected, 0);
});

test('la primera lectura de un trader no avisa de nada', () => {
  const db = openDatabase({ path: ':memory:' });
  const trader = addTrader(db, { address: DIR });
  const s = new AlertService({ db });

  s.onRead(trader, null, foto([pos('BTC', 'long', 1, 80_000)], 1_000));
  assert.deepEqual(listAlertEvents(db), []);
});

test('un fallo del bot no rompe la lectura ni pierde el registro', async () => {
  const db = openDatabase({ path: ':memory:' });
  const trader = addTrader(db, { address: DIR });
  const roto = new Telegram({
    token: 'x:y', chatId: '42',
    fetchImpl: async () => { throw new Error('sin red'); },
  });
  const s = new AlertService({ db, telegram: roto });

  assert.doesNotThrow(() => {
    s.onRead(trader, foto([], 1_000), foto([pos('BTC', 'long', 1, 80_000)], 61_000));
  });
  await new Promise((r) => { setTimeout(r, 50); });

  assert.equal(listAlertEvents(db).length, 1, 'el cambio queda registrado igual');
  assert.equal(s.status().telegram.failed, 1);
});

test('el texto dice el importe del cambio y en cuanto queda la posicion', () => {
  assert.equal(
    formatEvent({
      venue: 'hyperliquid', address: DIR, symbol: 'BTC', kind: 'increased', side: 'long',
      sizeBase: 2, prevSizeBase: 1, notionalUsd: 160_000, deltaUsd: 80_000,
      markPrice: 80_000, at: 1,
    }),
    'INCREASED BTC LONG $80.0K · now $160.0K',
  );
  assert.equal(
    formatEvent({
      venue: 'hyperliquid', address: DIR, symbol: 'BTC', kind: 'closed', side: 'short',
      sizeBase: 0, prevSizeBase: 1, notionalUsd: 0, deltaUsd: 80_000, markPrice: 80_000, at: 1,
    }),
    'CLOSED BTC SHORT $80.0K',
    'al cerrar no se dice "now 0"',
  );
});

test('un alias con HTML dentro no rompe el mensaje', () => {
  const db = openDatabase({ path: ':memory:' });
  const trader = addTrader(db, { address: DIR, alias: '<b>ojo</b>' });
  const m = formatMessage(trader, [{
    venue: 'hyperliquid', address: DIR, symbol: 'BTC', kind: 'opened', side: 'long',
    sizeBase: 1, prevSizeBase: 0, notionalUsd: 80_000, deltaUsd: 80_000, markPrice: 80_000, at: 1,
  }]);
  assert.ok(m.includes('&lt;b&gt;ojo&lt;/b&gt;'), m);
  assert.ok(!m.includes('<b>ojo</b>'));
});

test('los filtros de la wallet deciden que avisa: pares', () => {
  const db = openDatabase({ path: ':memory:' });
  const creado = addTrader(db, { address: DIR, alias: 'Uno' });
  // De esta wallet solo interesa lo que haga en SOL.
  const trader = updateTrader(db, creado.id, { symbols: ['SOL'] })!;
  const s = new AlertService({ db });

  s.onRead(trader, foto([], 1_000), foto([
    pos('BTC', 'long', 1, 80_000),
    pos('SOL', 'short', 1_000, 150),
  ], 61_000));

  const filas = listAlertEvents(db);
  assert.deepEqual(filas.map((f) => f.symbol), ['SOL'], 'BTC no se pidio: ni aviso ni fila');
});

test('los filtros de la wallet deciden que avisa: parte de la cuenta', () => {
  const db = openDatabase({ path: ':memory:' });
  const creado = addTrader(db, { address: DIR, alias: 'Uno' });
  // Solo lo que mueva al menos el 5 % de su cuenta, que aqui es de un millon.
  const trader = updateTrader(db, creado.id, { minAccountPct: 5 })!;
  const s = new AlertService({ db });

  s.onRead(trader, foto([], 1_000), foto([
    pos('BTC', 'long', 1, 80_000),      // 8 % de la cuenta: pasa
    pos('ETH', 'long', 10, 3_000),      // 3 %: no pasa
  ], 61_000));
  assert.deepEqual(listAlertEvents(db).map((f) => f.symbol), ['BTC']);
});

test('sin equity conocido no se puede afirmar que algo supere el minimo', () => {
  const db = openDatabase({ path: ':memory:' });
  const creado = addTrader(db, { address: DIR, alias: 'Uno' });
  const trader = updateTrader(db, creado.id, { minAccountPct: 1 })!;
  const s = new AlertService({ db });
  const sinEquity = (positions: Position[], at: number): AccountSnapshot => ({ ...foto(positions, at), equityUsd: null });

  s.onRead(trader, sinEquity([], 1_000), sinEquity([pos('BTC', 'long', 10, 80_000)], 61_000));
  // No se sabe que parte de la cuenta era. Avisar seria inventarse que pasa
  // el filtro; el dato sigue estando en las ejecuciones guardadas.
  assert.equal(listAlertEvents(db).length, 0);
});
