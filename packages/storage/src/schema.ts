/**
 * Esquema y migraciones.
 *
 * Dos dominios que NO se mezclan (ver ARCHITECTURE.md):
 *
 *   - Mercado: recolectado, reproducible, enorme. Tiene retencion y purga.
 *   - Usuario: introducido a mano, irreemplazable, minusculo. Nunca se purga y
 *     es lo unico que entra en la copia de seguridad.
 *
 * Las migraciones son una lista ordenada de sentencias. `user_version` de
 * SQLite guarda cuantas se han aplicado, asi que arrancar sobre una base ya
 * existente solo ejecuta lo que falte. Sin ORM y sin magia.
 */

export interface Migration {
  readonly name: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: '001-inicial',
    statements: [
      // --- Mercado -------------------------------------------------------
      // Una fila por (instante, venue, simbolo). WITHOUT ROWID porque la clave
      // primaria ya es el indice natural y ahorra una escritura por fila, que
      // en una SD se nota.
      `CREATE TABLE IF NOT EXISTS market_snapshot (
         ts                INTEGER NOT NULL,
         venue             TEXT    NOT NULL,
         symbol            TEXT    NOT NULL,
         mid               REAL    NOT NULL,
         funding_hourly    REAL    NOT NULL,
         open_interest_usd REAL,
         volume_24h_usd    REAL,
         PRIMARY KEY (ts, venue, symbol)
       ) WITHOUT ROWID`,

      // Consulta tipica de Parity y del historico de funding: un simbolo a lo
      // largo del tiempo, en todos los venues.
      `CREATE INDEX IF NOT EXISTS idx_snapshot_symbol_ts
         ON market_snapshot (symbol, ts)`,

      // Consulta tipica de DEX Volume: un venue a lo largo del tiempo.
      `CREATE INDEX IF NOT EXISTS idx_snapshot_venue_ts
         ON market_snapshot (venue, ts)`,

      // Agregados por hora. Es lo que leen los graficos de evolucion cuando se
      // pide mas rango del que cubre la resolucion completa.
      `CREATE TABLE IF NOT EXISTS market_hourly (
         hour              INTEGER NOT NULL,
         venue             TEXT    NOT NULL,
         symbol            TEXT    NOT NULL,
         mid_avg           REAL    NOT NULL,
         funding_hourly_avg REAL   NOT NULL,
         open_interest_usd_avg REAL,
         volume_24h_usd_avg REAL,
         samples           INTEGER NOT NULL,
         PRIMARY KEY (hour, venue, symbol)
       ) WITHOUT ROWID`,

      // Historico de salud, para el uptime de 24 h y 7 d de Data Sources.
      `CREATE TABLE IF NOT EXISTS source_health (
         ts             INTEGER NOT NULL,
         source         TEXT    NOT NULL,
         status         TEXT    NOT NULL,
         reason         TEXT,
         symbol_count   INTEGER,
         latency_p50_ms REAL,
         PRIMARY KEY (ts, source)
       ) WITHOUT ROWID`,

      // --- Usuario -------------------------------------------------------
      // Nada de esto se purga jamas, y es lo que se respalda.
      `CREATE TABLE IF NOT EXISTS wallet (
         id         TEXT PRIMARY KEY,
         address    TEXT    NOT NULL,
         chain      TEXT    NOT NULL,
         label      TEXT,
         notes      TEXT,
         created_at INTEGER NOT NULL,
         UNIQUE (address, chain)
       )`,
    ],
  },
  {
    name: '002-arbitrajes-de-funding',
    statements: [
      // Dato del usuario: irreemplazable, sin purga y con copia de seguridad.
      //
      // Los importes son NULL cuando no se conocen, nunca 0: la diferencia
      // entre "no he cobrado funding" y "no se cuanto he cobrado" es justo lo
      // que hace util este registro.
      `CREATE TABLE IF NOT EXISTS funding_position (
         id                    TEXT    PRIMARY KEY,
         symbol                TEXT    NOT NULL,
         long_venue            TEXT    NOT NULL,
         short_venue           TEXT    NOT NULL,
         notional_usd          REAL    NOT NULL,
         opened_at             INTEGER NOT NULL,
         closed_at             INTEGER,
         fees_paid_usd         REAL,
         funding_collected_usd REAL,
         notes                 TEXT,
         created_at            INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_funding_position_abiertas
         ON funding_position (closed_at, opened_at)`,
    ],
  },
  {
    name: '003-ingresos',
    statements: [
      // Ingresos FUERA del P&L de trading: comisiones de referidos y premios de
      // competiciones. Se guardan aparte de funding_position a proposito: no
      // son resultado de operar, y mezclarlos falsearia las dos cifras.
      `CREATE TABLE IF NOT EXISTS income_entry (
         id          TEXT    PRIMARY KEY,
         kind        TEXT    NOT NULL CHECK (kind IN ('referral', 'competition')),
         venue       TEXT    NOT NULL,
         amount_usd  REAL    NOT NULL,
         received_at INTEGER NOT NULL,
         -- Solo para competiciones; en un referido se quedan en NULL.
         competition TEXT,
         placement   TEXT,
         period      TEXT,
         note        TEXT,
         created_at  INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_income_entry_fecha
         ON income_entry (received_at DESC)`,

      // Enlaces de referido propios. Se guardan para tenerlos a mano al
      // compartirlos, no para calcular nada.
      `CREATE TABLE IF NOT EXISTS referral_link (
         venue      TEXT PRIMARY KEY,
         url        TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    ],
  },
  {
    name: '004-farmeo',
    statements: [
      // Programa de puntos de un venue, tal y como el usuario lo entiende:
      // cuantos puntos reparte por epoch y cuanto volumen mueve ese epoch.
      // Ambos son NULL mientras no se sepan: sin ellos no se puede estimar, y
      // eso hay que decirlo en vez de calcular con un cero.
      `CREATE TABLE IF NOT EXISTS points_program (
         id               TEXT    PRIMARY KEY,
         venue            TEXT    NOT NULL,
         points_per_epoch REAL,
         epoch_label      TEXT    NOT NULL,
         epoch_volume_usd REAL,
         created_at       INTEGER NOT NULL
       )`,

      // Una accion de farmeo: lo que moviste, lo que te costo y lo que sacaste.
      // `points_earned` NULL = se estima por tu cuota de volumen del epoch.
      `CREATE TABLE IF NOT EXISTS farming_action (
         id            TEXT    PRIMARY KEY,
         program_id    TEXT    NOT NULL REFERENCES points_program(id) ON DELETE CASCADE,
         description   TEXT,
         volume_usd    REAL,
         fees_paid_usd REAL,
         pnl_usd       REAL,
         points_earned REAL,
         occurred_at   INTEGER NOT NULL,
         created_at    INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_farming_action_programa
         ON farming_action (program_id, occurred_at DESC)`,
    ],
  },
  {
    name: '005-cambios-de-tamano',
    statements: [
      // Una posicion no se abre y se cierra sin mas: se aumenta y se reduce.
      // Con un solo `notional_usd` fijo, el OI-hora de una posicion que paso
      // de 10k a 30k salia calculado con 10k todo el rato, y el coste por
      // 1k OI-h con el que se comparan venues quedaba inflado al triple.
      //
      // Cada fila es el nocional POR PATA que pasa a estar vigente desde `at`.
      // El tramo inicial no se guarda aqui: sale de funding_position.
      `CREATE TABLE IF NOT EXISTS position_size_change (
         id           TEXT    PRIMARY KEY,
         position_id  TEXT    NOT NULL REFERENCES funding_position(id) ON DELETE CASCADE,
         at           INTEGER NOT NULL,
         notional_usd REAL    NOT NULL,
         note         TEXT,
         created_at   INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_size_change_posicion
         ON position_size_change (position_id, at)`,
    ],
  },
  {
    name: '006-traders-seguidos',
    statements: [
      // Traders que se siguen. Dato del usuario: no se purga y entra en la
      // copia de seguridad, como las wallets propias.
      //
      // Es una tabla APARTE de `wallet` a proposito: `wallet` son las
      // direcciones del usuario y esto son las de terceros. Mezclarlas
      // pondria las cuentas que sigues dentro de tu propio Tracker.
      //
      // `venue` va desde el principio aunque hoy solo haya Hyperliquid: la
      // unicidad de una direccion es POR VENUE, y anadir la columna despues
      // obligaria a migrar la clave.
      `CREATE TABLE IF NOT EXISTS trader (
         id         TEXT    PRIMARY KEY,
         venue      TEXT    NOT NULL,
         address    TEXT    NOT NULL,
         alias      TEXT,
         color      TEXT,
         group_name TEXT,
         notes      TEXT,
         active     INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         UNIQUE (venue, address)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_trader_activo ON trader (active)`,
    ],
  },
  {
    name: '007-avisos-de-posicion',
    statements: [
      // Lo que ha cambiado en las posiciones de un trader entre dos lecturas.
      //
      // Es un REGISTRO DE OBSERVACION, no un dato del usuario: se guarda para
      // poder ver la actividad reciente tras reiniciar y para no repetir un
      // aviso ya mandado. Tiene tope de filas, a diferencia de las wallets y
      // las operaciones, que no se purgan nunca.
      //
      // `notified_at` a null significa que el aviso se detecto pero no salio
      // por Telegram, sea porque no esta configurado o porque fallo el envio.
      // Distinguirlo importa: "no ha pasado nada" y "paso y no te llego" no
      // son lo mismo.
      `CREATE TABLE IF NOT EXISTS alert_event (
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         trader_id      TEXT    NOT NULL,
         venue          TEXT    NOT NULL,
         address        TEXT    NOT NULL,
         symbol         TEXT    NOT NULL,
         kind           TEXT    NOT NULL,
         side           TEXT    NOT NULL,
         size_base      REAL    NOT NULL,
         prev_size_base REAL    NOT NULL,
         notional_usd   REAL    NOT NULL,
         delta_usd      REAL    NOT NULL,
         mark_price     REAL,
         at             INTEGER NOT NULL,
         notified_at    INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS idx_alert_event_at ON alert_event (at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_alert_event_trader ON alert_event (trader_id, at DESC)`,
    ],
  },
  {
    name: '008-interes-abierto',
    statements: [
      // Historico de interes abierto, en dolares y por venue.
      //
      // **`symbol = '*'` es el TOTAL del venue**, y no es la suma de las filas
      // por simbolo que hay aqui: el total se calcula sobre todos los mercados
      // y las filas por simbolo solo se guardan para los que pasan un minimo.
      // La cola de mercados de veinte mil dolares multiplicada por doce venues
      // y por una muestra cada hora se come la SD de la Raspberry sin aportar
      // nada. Asi el total siempre es completo y el desglose dice hasta donde
      // llega.
      //
      // Dos cadencias por el mismo motivo: el total es barato y se guarda cada
      // cuarto de hora, el desglose por simbolo cada hora.
      `CREATE TABLE IF NOT EXISTS oi_snapshot (
         ts      INTEGER NOT NULL,
         venue   TEXT    NOT NULL,
         symbol  TEXT    NOT NULL,
         oi_usd  REAL    NOT NULL,
         PRIMARY KEY (ts, venue, symbol)
       ) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS idx_oi_symbol_ts ON oi_snapshot (symbol, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_oi_venue_ts ON oi_snapshot (venue, ts)`,
    ],
  },
  {
    name: '009-indice-simbolo-venue',
    statements: [
      // El indice que le faltaba a la sostenibilidad del screener.
      //
      // Su consulta busca por (symbol, venue, ts) y no habia ningun indice con
      // esas tres. SQLite elegia `idx_snapshot_venue_ts` y **escaneaba todos
      // los datos de ese venue por cada uno de los 985 pares**. Medido el 25
      // de septiembre de 2026 con 1,24 millones de filas: 96 segundos, que
      // ademas bloqueaban el hilo de la API entera. Con este indice la misma
      // consulta tarda 2,0 segundos, cuarenta y ocho veces menos.
      `CREATE INDEX IF NOT EXISTS idx_snapshot_symbol_venue_ts
         ON market_snapshot (symbol, venue, ts)`,
    ],
  },
  {
    name: '010-ejecuciones-de-traders',
    statements: [
      // Las EJECUCIONES de las wallets seguidas, no sus posiciones.
      //
      // Hasta ahora los movimientos se DEDUCIAN comparando fotos de posicion
      // cada pocos minutos: si entre dos lecturas el tamano cambiaba, se
      // infería una operacion. Eso pierde todo lo que se abre y se cierra
      // entre lecturas, y no distingue una operacion de un movimiento de
      // precio. Hyperliquid publica los fills de verdad en `userFills`, con
      // direccion, precio, tamano, comision y PnL realizado.
      //
      // `tid` es el identificador del fill en el venue y es la clave que evita
      // duplicar: al releer una ventana que ya se habia leido, los repetidos
      // chocan contra la primaria y se descartan solos.
      `CREATE TABLE IF NOT EXISTS trader_fill (
         tid          TEXT    PRIMARY KEY,
         trader_id    TEXT    NOT NULL,
         symbol       TEXT    NOT NULL,
         ts           INTEGER NOT NULL,
         dir          TEXT    NOT NULL,
         side         TEXT    NOT NULL,
         px           REAL    NOT NULL,
         sz           REAL    NOT NULL,
         notional_usd REAL    NOT NULL,
         closed_pnl   REAL,
         fee          REAL,
         -- Que parte de SU cuenta movia esa operacion, calculado con el equity
         -- del momento de leerla. Se guarda y no se recalcula: con el equity de
         -- hoy, una operacion de hace un mes daria un porcentaje que nunca fue.
         -- null cuando no se pudo leer el equity, que no es lo mismo que cero.
         account_pct  REAL,
         FOREIGN KEY (trader_id) REFERENCES trader (id) ON DELETE CASCADE
       )`,
      `CREATE INDEX IF NOT EXISTS idx_fill_trader_ts ON trader_fill (trader_id, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_fill_symbol_ts ON trader_fill (symbol, ts)`,

      // Filtros POR WALLET: no todas interesan por lo mismo.
      //
      // `symbols` es una lista separada por comas, y null significa "todos".
      // La diferencia importa: una lista vacia seria "ninguno", que no es lo
      // que quiere decir no haber elegido nada.
      //
      // `min_account_pct` filtra por conviccion: una operacion que mueve el
      // 5 % de su cuenta dice mas que una que mueve el 0,1 %.
      `ALTER TABLE trader ADD COLUMN symbols TEXT`,
      `ALTER TABLE trader ADD COLUMN min_account_pct REAL`,
    ],
  },
  {
    name: '011-entropy-sin-prefijo-hip3',
    statements: [
      // entropy.io manda sus mercados como `io:NVDA`, y hasta el 17 de
      // noviembre de 2026 se guardaban como `IO:NVDA`. Con el prefijo dentro,
      // su NVDA no se cruzaba con el de ningun otro venue. El normalizador ya
      // lo quita; esto renombra lo guardado para que la serie no se corte.
      //
      // `OR IGNORE` y luego `DELETE`: si en la misma hora ya hay fila con el
      // nombre nuevo (la API se reinicio con el normalizador nuevo antes de
      // migrar), gana la nueva y la vieja sobra.
      ...['market_snapshot', 'market_hourly', 'oi_snapshot'].flatMap((t) => [
        `UPDATE OR IGNORE ${t} SET symbol = substr(symbol, 4) WHERE venue = 'entropy' AND symbol LIKE 'IO:%'`,
        `DELETE FROM ${t} WHERE venue = 'entropy' AND symbol LIKE 'IO:%'`,
        // El alias OAI -> OPENAI llego el mismo dia.
        `UPDATE OR IGNORE ${t} SET symbol = 'OPENAI' WHERE venue = 'entropy' AND symbol = 'OAI'`,
        `DELETE FROM ${t} WHERE venue = 'entropy' AND symbol = 'OAI'`,
      ]),
    ],
  },
  {
    name: '012-apy-diario-de-pools',
    statements: [
      // El APY de cada pool, un valor por dia. DefiLlama da la media de 30
      // dias pero no la de 7 ni la de 15; salen de aqui. Ver `pools.ts`.
      //
      // La primaria empieza por el dia: las dos consultas son "desde tal dia"
      // (las medias y la purga), y asi ninguna recorre la tabla entera.
      `CREATE TABLE IF NOT EXISTS pool_apy_daily (
         day     INTEGER NOT NULL,
         pool    TEXT    NOT NULL,
         apy     REAL    NOT NULL,
         tvl_usd REAL    NOT NULL,
         PRIMARY KEY (day, pool)
       ) WITHOUT ROWID`,
    ],
  },
  {
    name: '013-prioridad-de-programas',
    statements: [
      // El tablero de Points: lo que se farmea, en el orden en que importa.
      // `priority` 1 es lo primero; NULL para filas de antes, que van al final
      // en orden de creacion. `note` es el texto libre de la tarjeta
      // ("150k weekly, needs 50k volume").
      `ALTER TABLE points_program ADD COLUMN priority INTEGER`,
      `ALTER TABLE points_program ADD COLUMN note TEXT`,
    ],
  },
  {
    name: '014-segunda-tanda-de-alias',
    statements: [
      // Los alias del 17 nov 2026 (ver `symbols.ts`): el mismo contrato con
      // otro ticker. Se renombra lo guardado para que cada serie siga entera;
      // como en la 011, si ya hay fila con el nombre nuevo, gana la nueva.
      ...['market_snapshot', 'market_hourly', 'oi_snapshot'].flatMap((t) => [
        ['CL (WTI CRUDE OIL)', 'WTI', null],
        ['BZ', 'BRENT', null], ['XBR', 'BRENT', null], ['BRENTOIL', 'BRENT', null],
        ['NG', 'NATGAS', null], ['XNG', 'NATGAS', null],
        ['BRKB', 'BRK.B', null], ['VISA', 'V', null], ['BBX', 'BB', 'variational'],
        ['VANATOKEN', 'VANA', null], ['ANTH', 'ANTHROPIC', null], ['ANTHROP', 'ANT', null],
        ['SKHX', 'SKHYNIX', null],
        // Swaps de Variational que no tienen perp al lado y pasan a llamarse
        // como el activo que siguen.
        ['DXIP', 'DXY', 'variational'], ['VXIP', 'VIX', 'variational'],
      ].flatMap(([viejo, nuevo, venue]) => {
        const donde = `symbol = '${viejo}'${venue === null ? '' : ` AND venue = '${venue}'`}`;
        return [
          `UPDATE OR IGNORE ${t} SET symbol = '${nuevo}' WHERE ${donde}`,
          `DELETE FROM ${t} WHERE ${donde}`,
        ];
      })),
    ],
  },
  {
    name: '015-mercado-exacto-del-fill',
    statements: [
      // El `coin` de Hyperliquid tal cual (`xyz:NVDA`, `@107`). Con el simbolo
      // normalizado no se sabia si una ejecucion era del NVDA de xyz o del de
      // otro dex HIP-3, ni si era spot o perp. Lo de antes queda a null.
      `ALTER TABLE trader_fill ADD COLUMN coin TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_fill_coin_ts ON trader_fill (coin, ts)`,
    ],
  },
  {
    name: '016-avisos-huerfanos',
    statements: [
      // Avisos de wallets que ya no se siguen: quitar un trader no los borraba.
      `DELETE FROM alert_event WHERE trader_id NOT IN (SELECT id FROM trader)`,
    ],
  },
];
