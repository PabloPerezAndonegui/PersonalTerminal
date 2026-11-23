import { pointsFreshness, POINTS_PROGRAMS } from '@defi/venues';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { MarketSnapshot, VenueMeta } from '@defi/core';
import type { VenueAdapter } from '@defi/venues';
import { openDatabase } from '@defi/storage';
import { createApi, type ApiDeps } from './server.ts';
import { numberParam, enumParam, stringParam, listParam, HttpProblem } from './http.ts';
import { WidgetHealth, WIDGET_REPORT_TTL_MS } from './widgetHealth.ts';

// --- Validacion de entrada ---------------------------------------------------

const url = (qs: string) => new URL(`http://x/api?${qs}`);

test('numberParam devuelve el valor por defecto si falta', () => {
  assert.equal(numberParam(url(''), 'n', { def: 10, min: 0, max: 100 }), 10);
});

test('numberParam rechaza texto y fuera de rango en vez de recortar', () => {
  // Recortar en silencio serviria un resultado distinto al pedido sin avisar.
  assert.throws(() => numberParam(url('n=abc'), 'n', { def: 1, min: 0, max: 10 }), HttpProblem);
  assert.throws(() => numberParam(url('n=999'), 'n', { def: 1, min: 0, max: 10 }), /between 0 and 10/);
  assert.throws(() => numberParam(url('n=-5'), 'n', { def: 1, min: 0, max: 10 }), /between 0 and 10/);
});

test('enumParam solo admite los valores declarados', () => {
  assert.equal(enumParam(url('m=maker'), 'm', ['taker', 'maker'] as const, 'taker'), 'maker');
  assert.throws(() => enumParam(url('m=otro'), 'm', ['taker', 'maker'] as const, 'taker'), /one of/);
});

test('stringParam exige valor y limita longitud', () => {
  assert.equal(stringParam(url('s=%20BTC%20'), 's'), 'BTC');
  assert.throws(() => stringParam(url(''), 's'), /s is required/);
  assert.throws(() => stringParam(url(`s=${'a'.repeat(100)}`), 's', 32), /is too long/);
});

test('listParam parte por comas y limita el numero de elementos', () => {
  assert.deepEqual(listParam(url('v=a,b, c'), 'v'), ['a', 'b', 'c']);
  assert.deepEqual(listParam(url(''), 'v'), []);
  assert.throws(() => listParam(url('v=' + Array(50).fill('x').join(',')), 'v', 40), /at most 40/);
});

// --- Servidor con dependencias falsas ----------------------------------------

const meta = (id: string, takerBps: number | null = 5): VenueMeta => ({
  id, label: id, kind: 'perp-dex', chain: null, collateral: 'USDC',
  fundingIntervalHours: 1,
  fees: { makerBps: 0, takerBps, freeClose: false },
  capabilities: { predictedFunding: false, orderBook: false, trading: true, publicPositions: false },
});

const snap = (venue: string, symbol: string, rate: number): MarketSnapshot => ({
  venue, symbol, symbolNative: symbol, contractMultiplier: 1,
  mid: 100, bid: 100, ask: 100,
  funding: { rate, intervalHours: 1, predicted: null, nextFundingAt: null, kind: 'current', sourceField: 'test' },
  book: null, openInterestUsd: null, volume24hUsd: null, at: 1000, sourceAt: null,
});

function deps(): ApiDeps {
  const snapshots = new Map([
    ['a', new Map([['BTC', snap('a', 'BTC', 0.0003)]])],
    ['b', new Map([['BTC', snap('b', 'BTC', 0.0001)]])],
  ]);
  return {
    collector: {
      snapshots: () => snapshots,
      health: () => [
        { venue: 'a', status: 'ok', reason: null, lastOkAt: 1, lastErrorAt: null, lastError: null,
          consecutiveFailures: 0, symbolCount: 1, baselineSymbolCount: null, coverageRatio: null,
          latencyP50Ms: 10, latencyP95Ms: 10, errorRatePct: 0, cyclesTotal: 1, declaredRequestsPerMinute: 4 },
        { venue: 'b', status: 'down', reason: 'timeout', lastOkAt: null, lastErrorAt: 2, lastError: 'timeout',
          consecutiveFailures: 3, symbolCount: 0, baselineSymbolCount: null, coverageRatio: null,
          latencyP50Ms: null, latencyP95Ms: null, errorRatePct: 100, cyclesTotal: 3, declaredRequestsPerMinute: 4 },
      ],
      venues: ['a', 'b'],
      rejected: [],
      lastCycle: { at: 1, durationMs: 5, ok: 2, failed: 0, freshSymbols: 2 },
      onCycle: () => () => {},
    },
    db: openDatabase({ path: ':memory:' }),
    metas: new Map([['a', meta('a')], ['b', meta('b')]]),
    adapters: new Map<string, VenueAdapter>(),
    collectIntervalMs: 60_000,
  };
}

/** Arranca la API en un puerto libre y devuelve el fetch ya con la base. */
async function servidor() {
  const d = deps();
  const server = createApi(d);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    d,
    get: (ruta: string) => fetch(`http://127.0.0.1:${port}${ruta}`),
    post: (ruta: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${ruta}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    patch: (ruta: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${ruta}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    del: (ruta: string) => fetch(`http://127.0.0.1:${port}${ruta}`, { method: 'DELETE' }),
    cerrar: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('/api/health responde con el ultimo ciclo', async () => {
  const s = await servidor();
  const r = await s.get('/api/health');
  assert.equal(r.status, 200);
  const body = await r.json() as { ok: boolean; venues: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.venues, ['a', 'b']);
  await s.cerrar();
});

test('/api/sections sirve el menu desde el backend', async () => {
  // Anadir o quitar una pestana se hace en un solo sitio, no en el front.
  const s = await servidor();
  // El cierre va en `finally`: un aserto que falla aqui dejaba el servidor
  // escuchando y `npm test` no terminaba nunca, asi que un fallo de una linea
  // se presentaba como una suite colgada. Ya habia pasado antes.
  try {
    const menu = await (await s.get('/api/sections')).json() as {
      areas: { id: string; label: string; defaultSection: string }[];
      sections: { id: string; label: string; area: string }[];
    };

    assert.deepEqual(menu.areas.map((a) => a.id), ['defi', 'trading', 'data']);
    // Data Sources vive en su propia entrada desde la portada, no en DeFi.
    assert.equal(menu.sections.find((x) => x.id === 'data-sources')?.area, 'data');
    assert.ok(menu.sections.length >= 12);
    assert.ok(menu.sections.every((x) => typeof x.label === 'string' && x.label !== ''));

    // Secciones retiradas. Si alguna reaparece es que alguien la ha vuelto a
    // declarar en `types.ts`, que es el unico sitio donde existe el menu.
    for (const ido of ['tier-list', 'trenches', 'tracker', 'funding-tracker', 'income', 'farming']) {
      assert.ok(!menu.sections.some((x) => x.id === ido), `${ido} quedo eliminada`);
    }

    // El screener de funding vive en Trading, no en DeFi.
    assert.equal(menu.sections.find((x) => x.id === 'funding-scanner')?.area, 'trading');
    assert.equal(menu.sections.find((x) => x.id === 'funding-scanner')?.label, 'Funding Arb');

    // Cada area tiene una seccion de entrada que existe de verdad.
    for (const a of menu.areas) {
      assert.ok(menu.sections.some((x) => x.id === a.defaultSection && x.area === a.id), a.id);
    }
  } finally {
    await s.cerrar();
  }
});

test('/api/scanner calcula oportunidades y respeta el limite', async () => {
  const s = await servidor();
  const body = await (await s.get('/api/scanner?limit=5')).json() as {
    total: number; opportunities: { shortVenue: string; longVenue: string }[];
  };
  assert.equal(body.total, 1);
  assert.equal(body.opportunities[0]?.shortVenue, 'a', 'el corto va donde el funding es mayor');
  assert.equal(body.opportunities[0]?.longVenue, 'b');
  await s.cerrar();
});

test('/api/scanner rechaza parametros fuera de rango con 400', async () => {
  const s = await servidor();
  const r = await s.get('/api/scanner?notional=999999999999');
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /notional/);
  await s.cerrar();
});

test('/api/sources cruza el estado con las pestanas afectadas', async () => {
  const s = await servidor();
  const body = await (await s.get('/api/sources')).json() as {
    sources: { id: string; light: string | null }[];
    impact: { section: string; light: string; degraded: string[] }[];
  };

  assert.equal(body.sources.find((x) => x.id === 'a')?.light, 'green');
  assert.equal(body.sources.find((x) => x.id === 'b')?.light, 'red');

  // Un venue caido degrada el scanner, no lo tumba: los demas cruces valen.
  const scanner = body.impact.find((i) => i.section === 'funding-scanner');
  assert.equal(scanner?.light, 'yellow');
  assert.ok(scanner?.degraded.includes('b'));

  // Y no arrastra a pestanas que no dependen de el.
  assert.equal(body.impact.find((i) => i.section === 'calendar')?.light, 'yellow');
  await s.cerrar();
});

test('ciclo completo de wallets por HTTP', async () => {
  const s = await servidor();

  const creada = await s.post('/api/wallets', { address: '0xabc', chain: 'base', label: 'mia' });
  assert.equal(creada.status, 201);
  const wallet = await creada.json() as { id: string };

  const lista = await (await s.get('/api/wallets')).json() as unknown[];
  assert.equal(lista.length, 1);

  assert.equal((await s.del(`/api/wallets/${encodeURIComponent(wallet.id)}`)).status, 200);
  assert.equal(((await (await s.get('/api/wallets')).json()) as unknown[]).length, 0);
  await s.cerrar();
});

test('la API rechaza una seed phrase pegada como direccion', async () => {
  const s = await servidor();
  const r = await s.post('/api/wallets', {
    address: 'witch collapse practice feed shame open despair creek road again ice least',
    chain: 'base',
  });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /seed phrase/);
  await s.cerrar();
});

test('una ruta desconocida es 404, no 500', async () => {
  const s = await servidor();
  assert.equal((await s.get('/api/no-existe')).status, 404);
  await s.cerrar();
});

test('/api/series exige simbolo y valida el rango', async () => {
  const s = await servidor();
  assert.equal((await s.get('/api/series')).status, 400);
  assert.equal((await s.get('/api/series?symbol=BTC&from=2000&to=1000')).status, 400);
  assert.equal((await s.get('/api/series?symbol=BTC')).status, 200);
  await s.cerrar();
});

test('el libro de un venue se pide una sola vez aunque cambien horizonte y fees', async () => {
  // Cambiar `days` o `feeMode` no cambia QUE libros hacen falta, solo la
  // aritmetica de amortizacion. Sin cache, cada clic dispararia decenas de
  // peticiones a los venues y en la Pi eso se come el rate limit de la IP.
  let peticiones = 0;
  const d = deps();
  const conLibro: VenueAdapter = {
    meta: meta('a'),
    cost: { websockets: 0, requestsPerMinute: 1 },
    refresh: async () => {},
    snapshot: () => new Map([['BTC', snap('a', 'BTC', 0.0003)]]),
    fetchBook: async () => {
      peticiones++;
      return { bids: [{ price: 100, size: 1e6 }], asks: [{ price: 100, size: 1e6 }] };
    },
  };
  const deps2: ApiDeps = {
    ...d,
    adapters: new Map([['a', conLibro], ['b', { ...conLibro, meta: meta('b') }]]),
  };

  const server = createApi(deps2);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const pedir = (qs: string) => fetch(`http://127.0.0.1:${port}/api/scanner?${qs}`);

  await pedir('days=7');
  const trasPrimera = peticiones;
  assert.ok(trasPrimera > 0, 'la primera consulta si pide libros');

  await pedir('days=30');
  await pedir('days=1&feeMode=maker');
  assert.equal(peticiones, trasPrimera, 'las siguientes reutilizan la cache');

  await new Promise<void>((r) => server.close(() => r()));
});

test('/api/volume declara si el dato es medido o estimado', async () => {
  const s = await servidor();
  try {
    const medido = await (await s.get('/api/volume?days=1')).json() as {
      period: { measured: boolean; coverageDays: number | null };
    };
    assert.equal(medido.period.measured, true, '24h es dato medido');
    assert.equal(medido.period.coverageDays, null, 'un dato medido no respalda ninguna estimacion');

    const estimado = await (await s.get('/api/volume?days=7')).json() as {
      period: { measured: boolean; coverageDays: number | null };
    };
    assert.equal(estimado.period.measured, false, '7d es estimacion y hay que decirlo');
    assert.equal(estimado.period.coverageDays, 0, 'sin historico, cero dias que la respalden');
  } finally {
    await s.cerrar();
  }
});

/** Un mercado con precio y volumen, para las pruebas de volumen. */
const conVolumen = (venue: string, symbol: string, mid: number, volume24hUsd: number): MarketSnapshot => ({
  ...snap(venue, symbol, 0), mid, bid: mid, ask: mid, volume24hUsd,
});

test('/api/volume no suma Caterpillar con el memecoin CAT', async () => {
  const s = await servidor();
  try {
    // QFEX lista Caterpillar a 400 $; Aster, un memecoin a centimos.
    const snaps = s.d.collector.snapshots();
    snaps.set('qfex', new Map([['CAT', conVolumen('qfex', 'CAT', 400, 1_000_000)]]));
    snaps.set('aster', new Map([['CAT', conVolumen('aster', 'CAT', 0.02, 50_000)]]));
    const body = await (await s.get('/api/volume?days=1&symbol=CAT')).json() as {
      pairs: { symbol: string; assetClass: string; totalUsd: number; venues: { venue: string }[] }[];
    };
    const accion = body.pairs.find((p) => p.assetClass === 'equity');
    const cripto = body.pairs.find((p) => p.assetClass === 'crypto');
    assert.equal(accion?.totalUsd, 1_000_000, 'Caterpillar solo con su volumen');
    assert.equal(cripto?.totalUsd, 50_000, 'el memecoin en su propia fila');

    const soloAcciones = await (await s.get('/api/volume?days=1&class=equity')).json() as {
      pairs: { symbol: string }[];
    };
    assert.deepEqual(soloAcciones.pairs.map((p) => p.symbol), ['CAT'], 'el filtro de clase deja solo acciones');
  } finally {
    await s.cerrar();
  }
});

test('/api/volume aparta el venue cuyo precio es de otro activo', async () => {
  const s = await servidor();
  try {
    // Tres venues cripto: dos cotizan QNT a 100 y uno a 1 (otro token).
    const snaps = s.d.collector.snapshots();
    snaps.set('a', new Map([['QNT', conVolumen('a', 'QNT', 100, 300)]]));
    snaps.set('b', new Map([['QNT', conVolumen('b', 'QNT', 101, 200)]]));
    snaps.set('c', new Map([['QNT', conVolumen('c', 'QNT', 1, 9_000)]]));
    const body = await (await s.get('/api/volume?days=1&symbol=QNT')).json() as {
      keptOutUsd: number;
      pairs: { totalUsd: number; keptOut: { venue: string }[] }[];
    };
    assert.equal(body.pairs[0]?.totalUsd, 500);
    assert.deepEqual(body.pairs[0]?.keptOut.map((k) => k.venue), ['c']);
    assert.equal(body.keptOutUsd, 9_000, 'lo apartado se dice, no se esconde');
  } finally {
    await s.cerrar();
  }
});

test('/api/volume/weekly solo da el cambio entre dos semanas completas', async () => {
  const s = await servidor();
  try {
    const DIA = 86_400_000;
    const SEMANA = 7 * DIA;
    const ahora = Date.now();
    const lunes = 4 * DIA + Math.floor((ahora - 4 * DIA) / SEMANA) * SEMANA;
    // Tres semanas atras completa (100/dia), dos atras completa (150/dia) y
    // la anterior con solo tres dias (200/dia).
    const escribir = (desde: number, dias: number, usd: number) => {
      for (let i = 0; i < dias; i++) {
        const ts = desde + i * DIA + 3_600_000;
        s.d.db.prepare(
          `INSERT INTO market_hourly (venue, symbol, hour, mid_avg, funding_hourly_avg, volume_24h_usd_avg, samples)
           VALUES ('a', 'BTC', ?, 100, 0, ?, 1)`,
        ).run(ts, usd);
      }
    };
    escribir(lunes - 3 * SEMANA, 7, 100);
    escribir(lunes - 2 * SEMANA, 7, 150);
    escribir(lunes - SEMANA, 3, 200);
    const body = await (await s.get('/api/volume/weekly?weeks=4')).json() as {
      estimated: boolean;
      weeks: {
        weekStart: number; totalUsd: number | null; avgDailyUsd: number | null;
        complete: boolean; changePct: number | null;
      }[];
    };
    assert.equal(body.estimated, true);
    const semana = (t: number) => body.weeks.find((w) => w.weekStart === t);
    assert.equal(semana(lunes - 3 * SEMANA)?.totalUsd, 700);
    assert.equal(semana(lunes - 2 * SEMANA)?.changePct, 50, 'de 700 a 1050 entre dos completas');
    assert.equal(semana(lunes - SEMANA)?.complete, false);
    assert.equal(semana(lunes - SEMANA)?.changePct, null, 'una semana a medias no se compara');
    assert.equal(semana(lunes - SEMANA)?.avgDailyUsd, 200, 'la media diaria si es comparable');
    assert.equal(semana(lunes)?.totalUsd, null, 'la semana en curso sin dato es null, no cero');
  } finally {
    await s.cerrar();
  }
});

test('/api/volume valida el periodo', async () => {
  const s = await servidor();
  assert.equal((await s.get('/api/volume?days=999')).status, 400);
  await s.cerrar();
});

test('/api/explorer declara su cobertura real en vez de aparentarla', async () => {
  const s = await servidor();
  const body = await (await s.get('/api/explorer')).json() as {
    coverage: { perpVenues: number; spotVenues: number };
    assets: { symbol: string; listings: { venue: string; takerBps: number | null }[] }[];
  };
  // Aun no hay fuentes de spot: se declara en cero para que la pantalla pueda
  // decir que un activo puede cotizar en sitios que esta tabla no ve.
  assert.equal(body.coverage.spotVenues, 0);
  assert.equal(body.coverage.perpVenues, 2);
  assert.equal(body.assets[0]?.listings.length, 2, 'BTC aparece en los dos venues');
  assert.equal(body.assets[0]?.listings[0]?.takerBps, 5, 'las fees salen de VenueMeta');
  await s.cerrar();
});

test('/api/explorer pone la coincidencia exacta primero', async () => {
  // Buscar "BTC" no puede enterrar BTC debajo de otro simbolo que lo contenga
  // solo porque ese tenga mas volumen.
  const s = await servidor();
  const body = await (await s.get('/api/explorer?q=BTC')).json() as { assets: { symbol: string }[] };
  assert.equal(body.assets[0]?.symbol, 'BTC');
  await s.cerrar();
});

test('/api/points no copia datos que caducan: solo enlaces y estado de la API', async () => {
  const s = await servidor();
  const body = await (await s.get('/api/points')).json() as {
    programs: { venue: string; url: string; apiStatus: string; daysSinceCheck: number | null }[];
    livePrograms: number;
    staleAfterDays: number;
  };
  assert.ok(body.programs.length > 0);
  for (const p of body.programs) {
    assert.ok(p.url.startsWith('https://'), `${p.venue} enlaza a su pagina oficial`);
    assert.ok(['public', 'auth-required', 'blocked', 'none'].includes(p.apiStatus));
    assert.equal(typeof p.daysSinceCheck, 'number');
    // Lo que de verdad defiende esta pantalla: que no se cuele nada que
    // caduque. Fechas de campana, premios o requisitos copiados aqui estarian
    // mal en una semana sin que nadie se entere, y para eso esta el enlace.
    assert.deepEqual(
      Object.keys(p).sort(),
      ['apiNote', 'apiStatus', 'daysSinceCheck', 'url', 'venue', 'venueId', 'verifiedAt'],
      `${p.venue} no trae campos que caduquen`,
    );
  }
  // Se contrasta contra la propia tabla y no contra un numero fijo: el dia que
  // un venue empiece a publicarlos, el test no debe ponerse rojo por eso.
  assert.equal(
    body.livePrograms,
    body.programs.filter((p) => p.apiStatus === 'public').length,
  );
  await s.cerrar();
});

test('la fuente manual de puntos se degrada sola al caducar', async (t) => {
  const s = await servidor();
  t.after(() => s.cerrar());
  const body = await (await s.get('/api/sources')).json() as {
    sources: { id: string; light: string | null; health: { symbolCount: number } | null }[];
  };
  const manual = body.sources.find((x) => x.id === 'points-manual');
  // Recien verificada esta en verde; el mecanismo que la pone amarilla es el
  // paso del tiempo, no una peticion, porque aqui no hay ninguna que hacer.
  assert.equal(manual?.light, pointsFreshness().stale.length > 0 ? 'yellow' : 'green');
  assert.ok((manual?.health?.symbolCount ?? 0) > 0);
});

test('/api/positions distingue "no opera aqui" de "no podemos mirar"', async () => {
  const s = await servidor();
  // Los adaptadores del doble no implementan fetchPositions.
  const body = await (await s.get('/api/positions?address=0x0000000000000000000000000000000000000000')).json() as {
    addressKind: string;
    venues: { venue: string; status: string; reason: string | null }[];
    positions: unknown[];
    exposure: unknown[];
  };
  assert.equal(body.addressKind, 'evm');
  assert.deepEqual(body.positions, []);
  await s.cerrar();
});

test('/api/positions rechaza lo que no es una direccion', async () => {
  const s = await servidor();
  const r = await s.get('/api/positions?address=noesunadireccion');
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /EVM, Solana or dYdX/);
  await s.cerrar();
});

// --- Salud de los widgets ----------------------------------------------------

test('un widget sin reportar no es verde ni rojo: no se sabe', () => {
  const w = new WidgetHealth(['tradingview-calendar']);
  // null lo pinta Data Sources como amarillo "sin reportar". Verde seria
  // afirmar que cargo sin que nadie lo haya abierto nunca.
  assert.equal(w.health('tradingview-calendar'), null);
});

test('el reporte del navegador se refleja tal cual', () => {
  const w = new WidgetHealth(['tradingview-calendar']);
  w.report('tradingview-calendar', { ok: true, loadMs: 11_300 });
  assert.equal(w.health('tradingview-calendar')?.status, 'ok');
  assert.equal(w.health('tradingview-calendar')?.latencyP50Ms, 11_300);

  w.report('tradingview-calendar', { ok: false, reason: 'blocked by an extension' });
  assert.equal(w.health('tradingview-calendar')?.status, 'down');
  assert.equal(w.health('tradingview-calendar')?.reason, 'blocked by an extension');
});

test('un reporte viejo caduca en vez de quedarse verde para siempre', () => {
  const w = new WidgetHealth(['tradingview-calendar']);
  w.report('tradingview-calendar', { ok: true });
  const futuro = Date.now() + WIDGET_REPORT_TTL_MS + 1;
  // "Cargo bien" es una afirmacion sobre hace un rato, no un hecho permanente.
  assert.equal(w.health('tradingview-calendar', futuro), null);
});

test('no se pueden inventar fuentes desde el cliente', () => {
  const w = new WidgetHealth(['tradingview-calendar']);
  assert.equal(w.admite('inventada'), false);
  assert.throws(() => w.report('inventada', { ok: true }), /unknown widget source/);
});

test('el OI-hora por venue no se parte a la mitad', async () => {
  const s = await servidor();

  // 10.000 por pata durante 10 h: CADA venue ve 100.000 OI-h suyos.
  const abierta = await s.post('/api/funding-positions', {
    symbol: 'BTC', longVenue: 'a', shortVenue: 'b',
    notionalUsd: 10_000, openedAt: Date.now() - 10 * 3_600_000,
  });
  assert.equal(abierta.status, 201);
  const pos = (await abierta.json()) as { id: string };
  await s.patch(`/api/funding-positions/${pos.id}`, {
    closedAt: Date.now(), feesPaidUsd: 40, fundingCollectedUsd: 100,
  });

  const body = (await (await s.get('/api/funding-positions')).json()) as {
    positions: { metrics: { oiHours: number } }[];
    byVenue: { venue: string; oiHours: number }[];
  };

  const oiPosicion = body.positions[0]!.metrics.oiHours;
  assert.ok(Math.abs(oiPosicion - 100_000) < 1, 'la posicion: 10.000 x 10 h');

  // Se repartia a medias, dejando 50.000 por venue: el denominador a la mitad y
  // el coste por 1k OI-h del doble de lo real, que es el numero con el que se
  // comparan venues.
  for (const v of body.byVenue) {
    assert.ok(Math.abs(v.oiHours - 100_000) < 1, `${v.venue} ve su nocional entero, no la mitad`);
  }
  await s.cerrar();
});

test('un aumento de tamano se refleja en el OI-hora', async () => {
  const s = await servidor();
  const abierta = await s.post('/api/funding-positions', {
    symbol: 'ETH', longVenue: 'a', shortVenue: 'b',
    notionalUsd: 10_000, openedAt: Date.now() - 20 * 3_600_000,
  });
  const pos = (await abierta.json()) as { id: string };

  const cambio = await s.post('/api/size-changes', {
    positionId: pos.id, at: Date.now() - 10 * 3_600_000, notionalUsd: 30_000, note: 'aumento',
  });
  assert.equal(cambio.status, 201);

  const body = (await (await s.get('/api/funding-positions')).json()) as {
    positions: { metrics: { oiHours: number }; sizeChanges: unknown[] }[];
  };
  const p = body.positions[0]!;
  assert.equal(p.sizeChanges.length, 1, 'el cambio viaja con la posicion');
  // 10.000x10 + 30.000x10 = 400.000, no 10.000x20 = 200.000.
  assert.ok(Math.abs(p.metrics.oiHours - 400_000) < 2000, `oiHours ${p.metrics.oiHours}`);
  await s.cerrar();
});

test('/api/funding-matrix compara solo los venues pedidos', async () => {
  const s = await servidor();

  const todos = (await (await s.get('/api/funding-matrix')).json()) as {
    venues: { id: string; selected: boolean }[];
    rows: { symbol: string; longVenue: string | null; shortVenue: string | null }[];
  };
  assert.equal(todos.rows[0]?.shortVenue, 'a', 'a paga mas funding: ahi va el corto');
  assert.equal(todos.rows[0]?.longVenue, 'b');
  assert.ok(todos.venues.every((v) => v.selected));

  await s.cerrar();
});

test('/api/funding-matrix con UN venue busca los cruces que pasan por el', async () => {
  const s = await servidor();

  // Con uno solo la pregunta no es "el mejor cruce entre los elegidos", que no
  // existe, sino "el mejor que puedo montar desde aqui". Se compara contra los
  // demas y se exige que una de las dos patas caiga en el elegido.
  const uno = (await (await s.get('/api/funding-matrix?venues=a')).json()) as {
    anchor: string | null;
    venues: { id: string; selected: boolean }[];
    rows: { longVenue: string | null; shortVenue: string | null; cells: Record<string, unknown> }[];
  };

  assert.equal(uno.anchor, 'a');
  assert.ok(uno.rows.length > 0, 'salen cruces, no una tabla vacia');
  for (const r of uno.rows) {
    assert.ok(
      r.longVenue === 'a' || r.shortVenue === 'a',
      'una de las dos patas tiene que estar en el venue elegido',
    );
  }
  // Y se ensenan las columnas de todos, porque si no no se ve la contraparte.
  assert.ok(uno.venues.every((v) => v.selected));
  await s.cerrar();
});

// --- Frescura de las fuentes de DefiLlama ------------------------------------

test('/api/pools dice de cuando es su copia y avisa si se ha quedado vieja', async () => {
  // Si DefiLlama deja de responder, la API sigue sirviendo la ultima copia
  // buena. Eso esta bien, pero la pantalla tiene que poder decirlo: una tabla
  // de APYs de hace seis horas sin aviso se lee como actual.
  const saludDe = (status: 'ok' | 'degraded') => ({
    venue: 'defillama-pools', status, reason: status === 'ok' ? null : 'stale data: 9000 s without a successful refresh',
    lastOkAt: 1_000, lastErrorAt: null, lastError: null, consecutiveFailures: 0, symbolCount: 1,
    baselineSymbolCount: null, coverageRatio: null, latencyP50Ms: null, latencyP95Ms: null,
    errorRatePct: 0, cyclesTotal: 1, declaredRequestsPerMinute: 0,
  });
  const pool = {
    id: 'p1', chain: 'Ethereum', project: 'x', symbol: 'ETH-USDC', poolMeta: null, tvlUsd: 1e6,
    apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: false, ilRisk: 'yes',
    exposure: 'multi', volatileApy: false, url: 'https://defillama.com/yields/pool/p1',
  };

  for (const [status, esperado] of [['ok', false], ['degraded', true]] as const) {
    const d = deps();
    const server = createApi({ ...d, pools: { data: [pool], health: () => saludDe(status) } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const body = await (await fetch(`http://127.0.0.1:${port}/api/pools?minTvl=0`)).json() as {
      asOf: number | null; stale: boolean;
    };
    assert.equal(body.asOf, 1_000, 'la fecha es la de la ultima descarga buena');
    assert.equal(body.stale, esperado, `con la fuente en ${status}`);
    await new Promise<void>((r) => server.close(() => r()));
  }
});


test('OI admite 100 venues y conserva un limite acotado', async () => {
  const d = deps();
  const server = createApi({ ...d, openInterest: { query: (o) => ({ requested: o.venues, symbol: o.symbol }) } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const venues = Array.from({ length: 100 }, (_, i) => 'venue' + i);
    const response = await fetch('http://127.0.0.1:' + port + '/api/open-interest?symbol=SOL&venues=' + venues.join(','));
    assert.equal(response.status, 200);
    const body = await response.json() as { requested: string[]; symbol: string };
    assert.deepEqual(body.requested, venues);
    assert.equal(body.symbol, 'SOL');
    const excessive = await fetch('http://127.0.0.1:' + port + '/api/open-interest?venues=' + Array(501).fill('x').join(','));
    assert.equal(excessive.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    d.db.close();
  }
});


test('caducidad de puntos con reloj fijo', () => {
  const program = POINTS_PROGRAMS[0];
  assert.ok(program);
  const fixture = [{ ...program, verifiedAt: '2026-01-01' }];
  assert.equal(pointsFreshness(fixture, Date.parse('2026-01-31')).stale.length, 0);
  assert.equal(pointsFreshness(fixture, Date.parse('2026-02-01')).stale.length, 1);
});


test('/api/candles normaliza contratos y declara la hora de lectura', async (t) => {
  const s = await servidor();
  t.after(() => s.cerrar());
  s.d.collector.snapshots().set('hyperliquid', new Map([['PEPE', { ...snap('hyperliquid', 'PEPE', 0), symbolNative: 'kPEPE', contractMultiplier: 1000 }]]));
  const original = globalThis.fetch;
  const stamp = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === 'https://api.hyperliquid.xyz/info') {
      return Response.json([{ s: 'kPEPE', i: '1h', t: stamp, o: '10', h: '12', l: '9', c: '11', v: '2', n: 1 }]);
    }
    return original(input, init);
  });
  const response = await s.get('/api/candles?symbol=PEPE&interval=1h');
  assert.equal(response.status, 200);
  const body = await response.json() as { fetchedAt: number; candles: { close: number; volume: number }[] };
  assert.ok(Number.isFinite(body.fetchedAt));
  assert.equal(body.candles[0]?.close, 0.011);
  assert.equal(body.candles[0]?.volume, 2000);
});

test('/api/bridges une liquidez de DefiLlama con rutas de LI.FI y deBridge', async () => {
  const d = deps();
  const salud = () => ({ status: 'ok' }) as never;
  const llama = (id: string, name: string, chains: string[], tvlUsd: number | null) => ({
    id, name, type: 'bridge' as const, category: 'Bridge', tvlUsd, chains, url: null, description: null,
  });
  const server = createApi({
    ...d,
    bridges: {
      data: [
        llama('stargate-v2', 'Stargate V2', ['Ethereum', 'Arbitrum'], 70e6),
        // Relay: DefiLlama no le ve ninguna red, y antes no salia nunca.
        llama('relay', 'Relay', ['Ethereum'], null),
      ],
      health: salud,
    },
    bridgeRoutes: [
      {
        id: 'lifi-routes',
        data: [
          { id: 'stargate-v2', name: 'Stargate V2', via: 'lifi', llamaSlug: 'stargate-v2', chains: ['Ethereum', 'Arbitrum'], pairs: new Set(['Ethereum|Arbitrum']), anyToAny: false },
          { id: 'relay', name: 'Relay', via: 'lifi', llamaSlug: 'relay', chains: ['Ethereum', 'Arbitrum'], pairs: new Set(['Ethereum|Arbitrum']), anyToAny: false },
          // Solo de Arbitrum a Ethereum: en el sentido pedido no vale.
          { id: 'ida', name: 'Solo vuelta', via: 'lifi', llamaSlug: null, chains: ['Ethereum', 'Arbitrum'], pairs: new Set(['Arbitrum|Ethereum']), anyToAny: false },
        ],
        health: salud,
      },
      {
        id: 'debridge-routes',
        data: [{ id: 'debridge', name: 'deBridge', via: 'debridge', llamaSlug: 'debridge', chains: ['Arbitrum', 'Ethereum', 'Solana'], pairs: new Set(), anyToAny: true }],
        health: salud,
      },
    ],
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/bridges?from=Ethereum&to=Arbitrum`)).json() as {
      chains: string[];
      routes: { id: string; tvlUsd: number | null; via: string[] }[];
    };
    const ruta = (id: string) => body.routes.find((r) => r.id === id);
    assert.deepEqual(ruta('stargate-v2')?.via, ['liquidity', 'lifi'], 'una fila, con las dos confirmaciones');
    assert.equal(ruta('relay')?.tvlUsd, null, 'Relay aparece, sin TVL inventado');
    assert.deepEqual(ruta('debridge')?.via, ['debridge']);
    assert.equal(ruta('ida'), undefined, 'una ruta solo de vuelta no sirve para ir');
    assert.ok(body.chains.includes('Solana'), 'las redes de deBridge entran en los selectores');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
