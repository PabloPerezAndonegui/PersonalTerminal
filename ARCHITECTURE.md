# Arquitectura

## Principios

1. **Las claves privadas viven en un proceso aparte.** Ningun modulo de datos,
   API o UI las ve nunca. Ver "Topologia de procesos".
2. **Un dato tiene un solo dueno.** Cada venue se normaliza una vez, en su
   adaptador. Nadie mas parsea respuestas crudas de un exchange.
3. **Nada se inventa.** Si un dato no se conoce (una fee, un funding), se
   propaga como `null` y la UI muestra "—". Nunca se asume 0.
4. **Los modulos se revisan solos.** Cada `packages/*` tiene una frontera
   explicita y no importa de sus hermanos salvo por su `index.ts` publico.
5. **Nada irreversible por defecto.** Toda ejecucion nace en `dryRun` y hay que
   desactivarlo a mano.

## Topologia de procesos

El corte importante es de seguridad, no de rendimiento:

```
  ┌─────────────┐   publico    ┌──────────────┐
  │  collector  │─────────────>│              │
  │ (sin claves)│  REST/WS de  │   storage    │
  └─────────────┘  los venues  │  (SQLite)    │
                               └──────┬───────┘
  ┌─────────────┐                     │
  │     api     │<────────────────────┘
  │ (sin claves)│──── WS/SSE ───> apps/web (Vite, estatico)
  └─────────────┘
                                ╔══════════════════════════╗
  ┌─────────────┐               ║  FRONTERA DE SEGURIDAD   ║
  │     bot     │──── orden ───>║  apps/signer             ║
  │ (sin claves)│               ║  unico proceso con       ║
  └─────────────┘               ║  claves. Escucha solo    ║
                                ║  en 127.0.0.1.           ║
                                ╚══════════════════════════╝
```

`collector` y `api` corren en el mismo proceso en local (menos piezas que
mantener); el limite esta en el codigo, asi que separarlos en AWS es cambiar
como se arranca, no reescribir.

`signer` es un proceso separado **desde el dia uno**. El bot le manda "abre
corto de 500 USD de BTC en Hyperliquid" y el signer decide si lo firma. El bot
nunca ve una clave. Si el bot se compromete, el atacante puede operar dentro de
los limites del signer, no vaciar la cuenta.

## Mapa de modulos

| Paquete | Responsabilidad | No hace |
|---|---|---|
| `packages/core` | Tipos del dominio, unidades, utilidades puras | I/O, red, estado |
| `packages/config` | Carga y valida configuracion y entorno | Guardar secretos |
| `packages/venues` | Un adaptador por venue -> datos normalizados | Decidir nada |
| `packages/collector` | Bucle de recogida, resiliencia, frescura y salud | Hablar con APIs |
| `packages/collector` · PollingSource | Fuentes que no son venues, con la misma salud | — |
| `packages/sources` | Catalogo de fuentes y que pestanas alimenta cada una | Medir |
| `packages/validation` | Plausibilidad de los datos en la ingesta | Corregir datos |
| `packages/storage` | Persistencia y series temporales | Logica de negocio |
| `packages/scanner` | Comparar venues, calcular spreads netos | Ejecutar |
| `apps/api` | HTTP + WS hacia la UI, API publica con keys | Firmar |
| `apps/web` | Vite + React, estatico. **Toda la UI en ingles** | Llamar a venues |
| `apps/signer` | Custodia de claves y firma | Estrategia |
| `apps/bot` | Estrategia delta-neutral, riesgo, kill switch | Custodiar claves |

## Tres areas, una sola aplicacion

Una terminal personal con dos areas. La portada es la eleccion entre ellas y
dentro de cualquiera hay un boton de Inicio.

| Area | Que es | Estado |
|---|---|---|
| **DeFi** | La terminal que ya existia: volumen, pools, bridges, explorer, parity, puntos, farming, ingresos y los registros propios | 12 secciones, todas construidas |
| **Trading** | Graficos, traders seguidos y comparacion de funding entre venues | 5 pestanas: Funding Screener y Compare operativos; Hyperliquid Tracker y Terminal parciales; Open Interest operativo con cobertura parcial CEX/DEX |

Hubo una tercera area, **Trenches**, para memecoins. Se retira el 5 de octubre
de 2026 sin llegar a construirse: primero se mejora lo que ya funciona y
despues, si acaso, se abre un area nueva.

**Solo consulta.** La aplicacion lee direcciones publicas y APIs publicas. No
conecta wallets, no firma y no opera. El signer, el motor de ejecucion y la
automatizacion quedan FUERA del alcance: las secciones 20 a 23 de la tabla de
abajo se mantienen documentadas pero no se van a construir mientras el objetivo
sea este.

### Que se movio y que no

El **Funding Screener** (id interno `funding-scanner`) pasa de DeFi a Trading.
Es la MISMA pantalla y los mismos servicios: solo cambia de menu. No hay un
segundo scanner.

El **Funding Tracker** se queda en DeFi. Es otra cosa: el registro manual de
arbitrajes propios, no la comparacion de tasas.

El estado de las fuentes se llega desde cualquier area: la barra de estado, que
sale en las tres, enlaza a Data Sources.

### Rutas

`/` la portada, `/<area>` entra a la seccion por defecto del area, y
`/<area>/<seccion>` una pantalla concreta. Son rutas reales, no hash: se puede
recargar, guardar la URL y usar atras y adelante.

Dos consecuencias que hay que tener presentes:

1. **Al desplegar, el servidor de estaticos tiene que devolver `index.html`
   para cualquier ruta que no sea un fichero.** El servidor de desarrollo de
   Vite ya lo hace. Sin eso, recargar `/defi/parity` da un 404.
2. Los enlaces viejos con hash (`#/parity`) se redirigen solos a su nueva ruta
   al abrirlos, con `replaceState` para no ensuciar el historial.

### Loris Tools, comprobado el 19 de septiembre de 2026

Fuente candidata para el funding, pendiente de decidir. Estado real:

- `GET https://api.loris.tools/funding` responde **401 "Missing API key"**.
  Hace falta una clave en la cabecera `X-Api-Key`, que no tenemos.
- Segun su documentacion, el nivel gratuito cubre **solo BTC y ETH**, eso si en
  los 43 venues que siguen (32 de ellos DEX). El resto de activos es de pago.
- Publica `/funding/historical` y, mas interesante, `/funding/settlement`: un
  punto por liquidacion real con su tasa y su intervalo. Eso es justo lo que
  hoy NO tenemos, porque todos nuestros adaptadores publican tasas vigentes
  o previstas, nunca liquidadas.
- **Sus tasas ya vienen normalizadas a bps a 8 horas.** Si algun dia se integra,
  no hay que volver a dividir por el intervalo: seria el error de normalizar dos
  veces.

Mientras tanto se conservan los adaptadores directos, que con los diez venues
cubren unos 2.150 mercados sin clave ni coste. Cambiar a Loris solo tiene
sentido con un plan de pago; con el gratuito la app pasaria de todos esos
cruces a dos, BTC y ETH.

## Secciones

Orden de construccion: cada una depende de las anteriores. La columna "fuentes"
dice de que depende la pestana, que es lo que luego cruza la seccion 8.

### Cimientos (sin pestana)

| # | Seccion | Estado |
|---|---|---|
| 0 | Base del repo y tipos del dominio | **hecha** |
| 1 | Registro de venues y adaptadores | **hecha** (10 venues, ~2.150 mercados) |
| 2 | Collector: ciclo, resiliencia, frescura y salud | **hecha** |
| 3 | Almacenamiento y series temporales (SQLite) | **hecha** |
| 4 | Scanner de funding: spreads, fees, slippage | **hecha** |
| 5 | API HTTP y feed en tiempo real | **hecha** |
| 6 | Shell de la web y sistema de diseno (ver DESIGN.md) | **hecha** |

### Pestanas

| # | Seccion | Pestana (en ingles) | Fuentes |
|---|---|---|---|
| 7 | Scanner de funding **(hecha)** | Funding Scanner | venues |
| 8 | Estado de fuentes de datos **(hecha)** | Data Sources | todas |
| 9 | Volumen por par y por venue **(hecha)** | DEX Volume | venues |
| 10 | Explorador de activos **(hecha, solo perps)** | Explorer | venues + spot CEX |
| 11 | Paridad de precios entre venues **(hecha)** | Parity | venues + historico |
| 12 | Pools y yields **(hecha)** | Pools & Yields | DefiLlama |
| 13 | Bridges entre redes **(hecha)** | Bridges | DefiLlama + tabla propia |
| 14 | Puntos y competiciones **(hecha)** | Points & Competitions | APIs de venue + manual |
| 15 | Wallets propias y posiciones **(hecha)** | Tracker | RPC/indexadores + venues |
| 16 | Registro de arbitrajes de funding **(hecha)** | Funding Tracker | manual + venues |
| 17 | Ingresos fuera del P&L **(hecha)** | Income | manual |
| 18 | Calculadora de eficiencia de farmeo **(hecha)** | Farming | manual + venues |
| 19 | Calendario economico **(hecha)** | Economic Calendar | TradingView |
| 19a | Interes abierto por venue y activo **(hecha, CEX parcial)** | Open Interest | venues + 5 CEX + DefiLlama |
| 19b | Comparador de protocolos **(hecha)** | Compare | DefiLlama + venues |
| 19c | Seguimiento de traders y avisos **(hecha, sin historico de ejecuciones)** | Hyperliquid Tracker | venues + Telegram |
| 19d | Grafico y mercados **(hecha)** | Terminal | Hyperliquid: core, HIP-3 y spot, con libro y cinta |

**Terminal: el catalogo de Hyperliquid bajo demanda (17 nov 2026).** El
Terminal ensena los mercados de Hyperliquid tal cual (perps del core, perps
HIP-3 de cada dex y spot, con sus nombres visibles de `perpConciseAnnotations`).
No pasa por el collector: `apps/api/src/hlCatalogo.ts` lo pide solo cuando
alguien mira el Terminal y lo cachea 90 s. Coste con el Terminal abierto: core,
spot y un `metaAndAssetCtxs` por dex con mercados vivos (6 peticiones de peso
20 cada 90 s, unas 80 unidades por minuto de las 1.200 por IP); dexes y
anotaciones, una vez por hora; libro (`l2Book`, peso 2) cache de 3 s; cinta
(`recentTrades`) cache de 5 s y solo con su pestana abierta. Ninguna peticion
sale con un `coin` que no este en el catalogo.

La seccion 8 va deliberadamente **antes** que las demas pestanas: es la
herramienta con la que se depura todo lo que viene despues. Sin ella, cuando un
numero salga raro en la pestana 14 no habra forma de saber si es un dato o una
API rota.

"Mi Tier List" queda eliminada.

### Operar (no se empieza hasta que 1-11 lleven semanas dando datos correctos)

| # | Seccion | Estado |
|---|---|---|
| 20 | API publica de la app, con claves y rate limit | pendiente |
| 21 | Signer: custodia y firma | pendiente |
| 22 | Motor delta-neutral | pendiente |
| 23 | Riesgo, limites y kill switch | pendiente |
| 24 | Despliegue en la Pi y lo que vaya a AWS | pendiente |

## Que necesita cada pestana

Recogido de la version actual de la app. Lo que ya funciona bien alli se
conserva a proposito; se indica cuando es una decision consciente.

**Funding Screener.** Simbolos por fila, venues por columna. Los venues se
eligen en un desplegable con "select all" y "deselect all": con once, la fila de
botones ocupaba dos lineas y tapaba la tabla, y lo normal es mirar solo los dos
o tres que se estan usando. La eleccion se recuerda.

Cada simbolo abre su **historico de funding**, que es lo que distingue una
oportunidad de un pico: un diferencial del 80 % anual que lleva veinte minutos y
uno del 20 % que lleva tres dias se ven igual en la tabla. Ademas de las lineas
por venue y la del diferencial, da cuatro numeros del periodo: muestras, media,
el decil peor y **que porcentaje del tiempo el diferencial se mantuvo a favor**.
Esa ultima es la que hara falta para el backtesting.

El diferencial se cruza por sello EXACTO, sin interpolar, igual que Parity: un
punto inventado en una pantalla que busca desajustes es peligroso.

**Funding Scanner.** Spreads en vivo entre pares de venues, APR bruto y neto
tras fees, filtro por venue y por volumen, control de volumen 30d del usuario
para calcular su tramo de fees, y horizonte de dias para amortizar costes.

**Data Sources.** Ver "Estado de fuentes de datos" mas abajo.

**DEX Volume.** Volumen por par agregado y desglosado por venue, con interes
abierto. 24h es dato en vivo; 7d y 30d son **estimacion** (media del volumen
24h registrado x dias) y deben ir etiquetados como tal, nunca presentados como
dato medido. Grafico de evolucion por venue alimentado por el historico: **hecho**, con el
mismo componente que Parity.

**Explorer.** Buscar un activo y ver en que mercados cotiza, a que precio, con
que volumen y que fees. Hoy cubre **solo perps** de los venues admitidos y la
pantalla lo declara; el spot de los CEX grandes entrara como fuente aparte.
Incluye la dispersion de precio entre venues, que es lo que dice si merece la
pena mirar Parity.

**Parity.** Diferencia de precio del mismo activo entre dos venues a lo largo
del tiempo. Tres modos: paridad %, precios superpuestos, y todos los pares a la
vez con fees descontadas. Usa mark price, no bid/ask, y hay que decirlo en la
pantalla: no incluye slippage ni spread del libro.

**Pools & Yields.** Universo completo de DefiLlama desde 1K de TVL. Busqueda
por par ("eth/btc"), filtros por red, categoria y TVL. Cada pool con desglose
base + rewards, aviso de **APR volatil cuando es un pico de un dia** (esto
evita perseguir un 200000% que no existe) y enlace oficial anti-phishing.

**Bridges.** Origen y destino entre redes. La liquidez sale de DefiLlama en
vivo; **el endpoint dedicado de bridges devuelve 402 y es de pago**, asi que se
usa api.llama.fi/protocols, que es gratuito y trae TVL, categoria y las cadenas
de cada puente. Tiempos y comisiones se curan a mano con fecha de verificacion
y el resto queda en —. Se declaran aparte las rutas que no pueden salir en
una lista ordenada por liquidez porque no bloquean fondos (CCTP).

**Points & Competitions.** Decision conservada: **no se copian datos que
caducan** (fechas, premios y requisitos cambian cada semana); se enlaza a la
pagina oficial. Comprobado endpoint a endpoint el 2026-09-09: **ninguno de los
venues seguidos expone puntos sin autenticacion** (Paradex 401, Lighter 403, el
resto 404). Lo que si se guarda es el estado de cada API y cuando se comprobo,
que caduca solo a los 30 dias y pone la fuente en amarillo.

**Tracker.** Formatos de direccion admitidos: EVM (`0x…`), Solana y **dYdX v4
(`dydx1…`, que es bech32 de Cosmos, no EVM)**. Cada venue declara cual acepta y
los que no coinciden se omiten diciendolo: consultar una direccion EVM contra
dydx devuelve 404, y traducir eso a "sin posiciones" seria afirmar que la
wallet no opera alli.

**Tracker.** Dos cosas en una: registro manual de operaciones con calendario de
resultados, y **wallets propias**. Se meten direcciones y se leen posiciones y
saldos en todos los venues y redes. Solo lectura, sin claves privadas jamas.
Es la base para analizar lo propio y disenar bots encima.

**Funding Tracker.** Registro de arbitrajes de funding: coste real, funding
cobrado hora a hora, OI·h y volumen aportado por venue, y coste por 1k OI·h
para saber que venue sale mas barato de farmear.

**Income.** Ingresos fuera del P&L de trading: comisiones de referidos y
premios de competiciones, con sus enlaces de referido.

**Farming.** Calculadora de eficiencia: programas de puntos por epoch, acciones
propias, y coste por punto y rentabilidad neta tras fees. El numero que decide
es el **coste neto por punto**: `(fees - P&L) / puntos`. Si sale negativo, el
punto no ha costado nada, porque operando se gano mas de lo que se pago en
comisiones. Los puntos se estiman por cuota de volumen del epoch solo cuando se
conocen las tres cifras que hacen falta; si falta una, la pantalla lo marca en
vez de estimar sobre un hueco, y ademas dice que porcentaje del total viene de
una estimacion.

**Economic Calendar.** Macro y resultados, de TradingView. Es la unica
pantalla cuyo contenido no produce esta app, y por eso se monta distinto a como
lo monta todo el mundo:

- **Iframe directo a la URL del widget, no su script de embebido.** El script
  se ejecutaria dentro de nuestra pagina, con acceso a su DOM y a su
  almacenamiento. El iframe se queda al otro lado de la frontera de origen que
  ya impone el navegador. La URL es la misma que construiria el script, con la
  configuracion en el fragmento.
- **En `sandbox`, sin `allow-top-navigation` ni `allow-forms`**: el embebido
  no puede sacar al usuario de la app ni enviar nada desde ella.
- **Sin `loading="lazy"`.** El marco queda por debajo del pliegue y el
  navegador no lo cargaria hasta hacer scroll: el temporizador lo daria por
  caido sin que nada estuviese roto. Medido, ademas, con `lazy` el evento
  `load` salta enseguida sobre un documento vacio — un verde falso.
- **El refresco global de la app NO lo remonta.** Tarda unos 11 s en pintarse y
  no lo alimenta el collector: recargarlo en cada ciclo lo dejaria en "loading"
  para siempre. Se recarga con su propio boton.

Los eventos cripto (unlocks, cierres de epoch, listings) **no** estan aqui, y
la pantalla lo dice para que nadie de por hecho que si.

## Estado de fuentes de datos (seccion 8)

La app depende de mas de veinte APIs de terceros, cada una con su forma de
fallar. Esta pestana es la que permite depurar todo lo demas: cuando un numero
salga raro en cualquier pantalla, aqui se ve si es un dato o una API rota.

**Los widgets los mide el navegador, no el servidor.** Un embebido de terceros
lo carga el navegador del usuario: desde el servidor no hay forma de saber si
aparecio o si lo bloqueo una extension. Asi que lo reporta la propia pantalla
(`POST /api/widget-health`) y el semaforo dice lo que de verdad paso. Ese
reporte vive en memoria y **caduca a los 15 minutos**: "cargo bien" es una
afirmacion sobre hace un rato, no un hecho permanente, y sin reporte reciente la
fuente vuelve a amarillo en vez de quedarse verde por un exito de la semana
pasada. El endpoint solo admite ids que ya existen en el catalogo: desde el
cliente no se pueden inventar fuentes.

**El fallo que importa no es que una API se caiga.** Eso se ve al instante. El
peligroso es que responda 200 OK con datos viejos, con la mitad de los simbolos
o con un funding congelado. Es silencioso y envenena el scanner y, mas abajo,
al bot. Por eso no se mide disponibilidad, se mide **frescura y completitud**.

### Forma: una tabla, no un dashboard

Una fila por fuente, densa y ordenable, con un semaforo a la izquierda:

- **Verde**: responde, datos frescos y cobertura normal.
- **Amarillo**: sirve pero con reservas. Datos por encima del umbral de
  frescura, cobertura por debajo de su media, ultimo ciclo fallido, o fuera por
  presupuesto de conexiones. Siempre con el motivo escrito al lado.
- **Rojo**: caida. Varios fallos seguidos o ningun ciclo correcto todavia.

Columnas: fuente, proveedor, tipo, semaforo, motivo, ultima actualizacion
correcta, cadencia, cobertura frente a su media, latencia p50 y p95, tasa de
error, y **secciones afectadas**.

### Secciones afectadas: lo que hace util la pantalla

Cada fuente declara que pestanas alimenta y con que criticidad:

- `critical`: sin esta fuente, la pestana no tiene nada que mostrar. DefiLlama
  cae y Pools & Yields se queda vacia.
- `partial`: la pestana sigue funcionando con menos datos. Si Paradex falla, el
  Funding Scanner pierde ese venue pero los demas cruces siguen siendo validos.

Con eso, la pantalla responde en un vistazo a las dos preguntas reales: "esto
que veo raro, de donde viene" y "que me estoy perdiendo ahora mismo".

Y al reves: **la degradacion se ve donde ocurre**. Si el Funding Scanner esta
ocultando un venue porque su fuente esta amarilla, lo dice en esa misma
pantalla con enlace aqui. Nunca una tabla que parece completa y no lo esta.

### Fuentes manuales

Las que se publican a diario o semanalmente y no tienen API (campanas,
competiciones) no se quedan fuera del semaforo: llevan fecha de verificacion y
caducidad. Pasada la caducidad se ponen en amarillo por si solas, con el motivo
"sin verificar desde X". Asi un dato viejo no se disfraza de dato vivo.

### Alertas

Cambio de estado a amarillo o rojo, aviso por Telegram, reutilizando el canal
que ya existe en el bot anterior. Solo en las transiciones, no en cada ciclo.

### Avisos de posicion por Telegram (23 de septiembre de 2026)

Bot **propio**, no el de un tercero. Solo manda texto: no lee comandos, no
opera y no toca los venues. Se decidio asi porque los bots publicos tipo
"Hyperliquid Data Tracker" no tienen API, y lo unico que quedaria seria leer
sus mensajes con una cuenta de usuario y parsearlos, lo que rompe la regla de
no ensenar datos derivados sin poder decir de donde salen. Para posiciones no
aportan nada: ya leemos Hyperliquid directamente.

- `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` viven en el `.env` real, **fuera
  del repo**. Sin las dos no se envia nada y la pantalla lo declara. Ponerlas
  es el acto manual que enciende el envio. `TELEGRAM_DRY_RUN=true` prepara los
  mensajes sin mandarlos.
- El token **no sale nunca por la API**: el estado que sirve `/api/alerts` no
  lo incluye, y si aparece dentro de un mensaje de error se tapa antes de
  guardarlo.
- Lo que se avisa sale de **comparar dos lecturas de posiciones**, no de
  ejecuciones. Dice como ha quedado la cuenta, no que ordenes se mandaron.
  Quien abre y cierra dentro de la misma vuelta no aparece. Las ejecuciones de
  verdad son `userFills`, en la fase 4.
- **El tamano manda, no el nocional.** El nocional se mueve solo con el precio
  y avisar por el convertiria cada vela en una racha de mensajes.
- Con mas de dos vueltas de hueco entre dos lecturas no se avisa: se toma
  referencia nueva. Cubre el reinicio, la pausa larga y el corte de API, donde
  un "ha abierto BTC" significaria en realidad "llevabamos horas sin mirar".
- Un mensaje por trader y vuelta, no uno por posicion. Limites medidos: **uno
  por segundo en un chat, 20 por minuto en un grupo**. Un 429 trae
  `retry_after` y se respeta, con un solo reintento.
- Los cambios se guardan en `alert_event` **aunque no haya bot**, con tope de
  filas. `notified_at` a null distingue "no ha pasado nada" de "paso y no te
  llego".

## Venues escritos y venues activos

Se recogen **diez**, todos gratis y sin clave, unos 2.150 mercados. Son dos
cosas distintas y conviene no confundirlas:

- **Lo que se RECOGE** son todos los venues que se puedan leer sin pagar. El
  volumen, el explorador y la paridad viven de la amplitud.
- **Lo que compara el screener de funding** son los venues que el usuario
  OPERA, que es `VENUES_DEL_USUARIO`. Comparar la tasa de un sitio donde no vas
  a abrir nada solo anade columnas. El usuario puede cambiar la seleccion en la
  pantalla y se le recuerda.

Coste: cero en dinero y unas 22 peticiones por minuto en total, contra un
presupuesto de 240, en una IP publica que puede compartirse con otros procesos.

| Venue | Simbolos | Notas |
|---|---|---|
| hyperliquid | 178 | Unico con posiciones publicas y libro |
| aster | 570 | Fees sin contrastar: van a `null` |
| variational | 552 | Su `funding_rate` es el **APR**, no la tasa del periodo |
| extended | 326 | Liquida cada hora. Fees sin contrastar |
| orderly | 139 | 80 mercados liquidan a 8 h y 59 a 4 h |
| backpack | 92 | |
| dydx | 78 | Direcciones `dydx1…` de Cosmos |
| pacifica | 76 | |
| paradex | 63 | |
| qfex | 188 | Acciones, materias primas y divisas de EEUU. **Solo por WebSocket** |
| perpl | 8 | Liquida cada 43 min, no en horas redondas |

Se cambia con la variable `VENUES` separada por comas. El valor por defecto
esta en `VENUES_POR_DEFECTO`, en `packages/venues/src/registry.ts`, y lo leen la
API, el collector, el scanner y el smoke por la misma funcion: `activeVenueIds()`.

**Phoenix integrado (22 septiembre 2026).** Un lote agregado de
`marketStatsV2` por ciclo, con socket acotado a 20 s y cerrado al recibir
la cobertura completa. El catalogo REST filtra mercados activos y comprueba
el intervalo horario. Por defecto se lee cada 120 s y se persiste cada 360 s.
La tasa publica es un porcentaje horario: se divide entre 100 para el modelo.
Se preserva el sello del origen; no se publican lotes incompletos o atrasados.
Cada ciclo abre una conexion nueva y recupera fallos del ciclo anterior.
Libro L2 bajo demanda; comisiones desconocidas y posiciones no integradas.

### Un ticker puede significar dos cosas

Con QFEX al lado de los venues de cripto esto deja de ser teorico: **CAT** es
Caterpillar a 807 USD y un memecoin a 0,0000020; **BB** es BlackBerry y
BounceBit; **PURR** es el memecoin de Hyperliquid y otra cosa en QFEX; **B** y
**RTX** lo mismo. De 506 simbolos presentes en dos venues o mas, 9 son asi.

Se detectan por el PRECIO, que es lo que no miente: entre venues de verdad el
mismo activo cotiza a menos de un 1 % de diferencia, mientras que el funding SI
diverge y por eso existe esta aplicacion. Un factor de 1,5 no lo produce ningun
mercado.

Dos consecuencias, en dos sitios distintos:

1. **La matriz de funding los aparta.** Con tres venues o mas manda la mediana
   y se aparta el que se salga; con solo dos no hay forma de saber cual es el
   bueno, asi que se apartan los dos y el simbolo desaparece de la comparacion.
   Mejor ninguna senal que una inventada. La pantalla lo marca con "≠".
2. **No ponen el venue en amarillo.** No es un fallo de nadie. Se distingue de
   un multiplicador mal aplicado, que SI es fallo nuestro, por dos senales a la
   vez: que el factor sea redondo (10, 100, 1000) **y** que el nombre nativo
   lleve prefijo. Hacen falta las dos, porque el BB de Aster contra el de
   Extended son 999,9x de pura casualidad. Solo los errores encienden la luz;
   los avisos se siguen contando en la barra de estado.

## Cobertura de simbolos, y por que no coincide con la API

La regla es explicar toda diferencia entre lo que devuelve la API en crudo y
lo que acaba en el snapshot. Lo comprueba `npm run smoke` en cada ejecucion,
restando los descartes uno a uno y exigiendo que cuadre con lo que publica el
adaptador. A 20 de septiembre de 2026:

| Venue | Crudo | Nuestro | Diferencia |
|---|---|---|---|
| hyperliquid | 234 | 178 | 56 con `isDelisted` |
| variational | 552 | 552 | ninguna |
| aster | 752 | 570 | 151 ya no estan en `/exchangeInfo`, 20 sin `status: TRADING`, 11 el mismo activo en otra moneda |
| perpl | 8 | 8 | ninguna |
| qfex | 219 | 188 | 31 sin funding publicado |
| pacifica | 77 | 76 | 1 mercado de SPOT (`SOL-USDC`) |
| extended | 400 | 326 | 3 de SPOT, 61 `DELISTED`, 9 `PRELISTED`, 1 `REDUCE_ONLY` |
| orderly | 139 | 139 | ninguna |
| backpack | 92 | 92 | ninguna en `/markPrices`, que es de donde se lee |
| paradex | 3147 | 63 | solo `asset_kind: PERP`; el resto son opciones y spot |
| dydx | 296 | 78 | solo `status: ACTIVE`; el resto en `FINAL_SETTLEMENT` |

Aster tiene la resta mas larga y la mas peligrosa. `/premiumIndex` sigue
publicando precio de mercados ya retirados, **76 de ellos con funding
exactamente 0**, y al normalizar el nombre competian con el mercado vivo:
`BTCUSD` contra `BTCUSDT`. Si ganaba el resto, 'BTC' figuraba con un funding de
cero que nadie puede cobrar. Por eso la lista de mercados la manda
`/exchangeInfo` y no `/premiumIndex`. De paso da `baseAsset` y `quoteAsset`, que
evitan adivinar la moneda recortando el nombre: `VUSDT` es la base V, no VUSDT.

Y cuando un mismo activo tiene varios mercados vivos a la vez (BTC cotiza en
USDT, en USD1 y en U, con funding distinto en cada uno) se queda **siempre el de
USDT**, no el de mas volumen. Un criterio que cambia solo mezclaria dos mercados
distintos en la misma serie historica el dia que el volumen se diera la vuelta.

Perpl enseno la otra cara del mismo problema: contar de menos y no notarlo.
Publicaba 8 mercados y el adaptador sacaba 6, porque los dos que faltaban traen
`symbol: ""` y el nombre solo en `name`. Eran **BTC y MON**, justo los de mas
volumen del venue. Seis parecia un numero razonable para un venue nuevo y ahi se
quedo hasta que se conto contra su propia interfaz. De esa se saca la
comprobacion de cobertura del smoke: la cuenta la hace el script contra la API
en crudo, no la memoria de quien escribio el adaptador.

El de Pacifica costo caro y merece la pena contarlo: `/info/prices` mezcla
perpetuos y spot en la misma lista sin ningun campo que los distinga, y
`SOL-USDC` normalizaba al mismo nombre que el perpetuo `SOL`. Llegaba despues,
asi que **lo pisaba**: la SOL de Pacifica figuraba con funding 0 —el spot no
tiene— y 130.000 de volumen en vez de 62 millones, y el scanner cruzaba ese
cero contra el funding real de los demas venues.

De ahi salen dos defensas, y se quedan las dos:

1. El adaptador descarta los simbolos con moneda de cotizacion, que en Pacifica
   son los de spot.
2. `setSinPisar` sustituye al `Map.set` pelado en todos los adaptadores: ante
   una colision se queda el de mas volumen —el mercado de verdad— y **anota la
   colision**. El criterio automatico puede acertar, pero que dos mercados
   choquen es siempre algo que mirar, no algo que resolver por defecto y callar.
   El smoke las saca en cada ejecucion.

## Decisiones tecnicas

**TypeScript nativo en Node 24.** Node ejecuta `.ts` directamente. No hay
bundler ni `ts-node` en el backend; `tsc --noEmit` solo comprueba tipos. Menos
piezas, menos superficie.

**SQLite (`node:sqlite`, integrado en Node).** Sin Docker, sin dependencias
nativas, sin servidor. La capa `storage` expone una interfaz, asi que migrar a
Postgres/Timescale cuando algo vaya a AWS es implementar la interfaz, no tocar
el resto.

**Sin ORM.** SQL explicito y revisable. Un ORM aqui esconde el coste de las
consultas de series temporales, que es justo lo que hay que vigilar.

**`number` para tasas, strings nativos para tamanos.** Los funding rates y APRs
son `number` (se comparan y se pintan, el error de coma flotante es
irrelevante). Los **tamanos de orden y precios** viajan como string en el
formato que pide cada venue, sin pasar por float, hasta el signer. Ahi un
redondeo si cuesta dinero.

**`ignore-scripts=true` y `save-exact=true` en npm.** Instalar una dependencia
no ejecuta codigo de terceros, y las versiones quedan clavadas.

## Que historico se puede recuperar y cual no

Comprobado fuente por fuente el 17 de septiembre de 2026. Importa porque
condiciona que se puede dejar de guardar y que no: lo que no se puede volver a
bajar, si se pierde, se perdio.

| Dato | ¿Se recupera de la fuente? | Como |
|---|---|---|
| Funding LIQUIDADO, por hora | **Si**, en 4 de 5 | Hyperliquid `fundingHistory`, Pacifica `funding_rate/history`, Backpack `fundingRates`, dydx `historicalFunding` |
| Funding liquidado en Paradex | **No** | publica un indice continuo, no liquidaciones discretas |
| Funding VIGENTE o PREVISTO | **No** | es una foto del instante; ningun venue publica el historico de sus propias estimaciones |
| Precio, OI y volumen por minuto | **No** | los agregados dan el estado actual, no series |
| Libros de ordenes | **No** | solo el estado actual, y ni eso se guarda |
| Pools y bridges de DefiLlama | Parcialmente | su historico existe pero su endpoint de series ya es de pago |

**Lo que guardamos es funding VIGENTE, no liquidado**, y esa es la distincion
que no se puede perder de vista al analizar una estrategia: una serie de
estimaciones no es una serie de pagos. Coinciden a veces y a veces no — medido
en dydx el mismo instante daba 3.45e-7 estimado frente a 1.375e-6 liquidado.

De ahi salen dos consecuencias practicas:

1. **Los snapshots de precio, OI y volumen son irrecuperables.** Si se purgan
   sin agregar, ese periodo no vuelve. Por eso la retencion comprime a
   agregados horarios en vez de borrar, y por eso importa que se ejecute.
2. **El funding liquidado se puede rellenar hacia atras** en cuatro venues el
   dia que haga falta una serie de pagos de verdad. No esta hecho, pero la
   puerta esta abierta y conviene no darla por cerrada.

## Antes de desplegar: lo que falta y lo que hay que decidir

Anotado al cerrar la auditoria del 11 de septiembre de 2026, para que el
despliegue no empiece descubriendolo.

**0. La web usa rutas reales.** Al servir `dist/` hay que devolver
`index.html` para cualquier ruta que no sea un fichero, o recargar
`/defi/parity` dara 404. Es una linea en nginx o un `fallback` en el servidor
que se elija.

**1. Nadie sirve la web compilada.** `apps/web` se compila a `dist/`, pero la
API solo responde `/api/*`: no hay servidor de estaticos. En desarrollo lo tapa
Vite. En la Pi hay que decidir entre que la API sirva `dist/` o poner un nginx
delante. Es lo primero con lo que se tropieza.

**2. `DB_PATH` es relativo al directorio de trabajo** (`./data/defi.db`). Con
systemd hay que fijar `WorkingDirectory`, o la base acabara donde no toca. Y si
`data/` va al SSD por USB, mejor pasar la ruta por `DB_PATH` que enlazarla.

**3. El scanner no sabe nada de los hallazgos de validacion.** Si un venue
publica un precio o un funding que la validacion marca como `error` —o sea,
seguro equivocado— ese dato sigue entrando en el ranking de oportunidades. La
politica documentada es "marcar, no borrar", y la barra de estado avisa con
"N data issues" en todas las pantallas, pero conviene decidir a proposito si un
cruce construido sobre un numero que sabemos malo debe seguir puntuando. No se
ha cambiado porque es una decision de diseno, no un fallo.

**4. Node 24 obligatorio.** Ejecuta TypeScript sin compilar y usa
`node:sqlite`. Ya esta en `engines` y con `engine-strict=true`, asi que el
`npm ci` fallara claro en vez de romper luego al arrancar.

## Despliegue objetivo: Raspberry Pi

La Pi es el destino principal (con alguna pieza suelta en AWS). Esto no es una
nota al final: condiciona decisiones desde la seccion 1.

**1. Cero dependencias nativas.** Nada que haya que compilar en ARM. Ya cubierto
por `node:sqlite` integrado, sin ORM y sin Docker.

**2. Cero build step en el dispositivo.** Node ejecuta TypeScript directamente,
asi que desplegar es copiar fuente y `npm ci --omit=dev`. No hay artefacto que
construir en la Pi.

**3. Frontend estatico.** Un `next build` en una Pi con poca RAM se queda sin
memoria. La UI se compila en la maquina de desarrollo y la Pi solo sirve
archivos estaticos mas el WebSocket. Como todos los datos llegan en vivo por WS,
el render en servidor no aporta nada aqui.

**4. Presupuesto de conexiones, declarado por adaptador.** La Pi puede compartir
IP publica con otros procesos que usan las mismas APIs. Cada
adaptador declara cuantas conexiones WS y cuantas peticiones por minuto
consume; hay un presupuesto global configurable. Un venue que se pase se
degrada a polling REST espaciado en vez de tumbar la IP para todo lo demas.
Sin esto, anadir el venue numero 15 rompe los 14 anteriores.

**5. Desgaste de la tarjeta SD.** Escribir series temporales cada 15 segundos en
una SD la destruye en meses. Mitigacion en tres frentes:
   - SQLite en modo WAL y **un commit por ciclo de recogida**, no por fila.
   - Politica de retencion: resolucion completa N dias, agregados por hora a
     partir de ahi, y purga automatica.
   - Recomendacion operativa: `data/` en un SSD por USB, no en la SD.

**6. Coste de CPU del scanner.** 20 venues son 190 pares por simbolo; con varios
cientos de simbolos son decenas de miles de comparaciones por ciclo. El scanner
trabaja sobre arrays planos preasignados y no crea objetos por par: solo
materializa las oportunidades que superan el umbral. En una Pi esto es la
diferencia entre un ciclo de 200 ms y uno de 6 segundos.

**7. Arranque como servicio.** Unidades systemd.

## Donde vive cada cosa: Pi frente a AWS

**Todo en la Pi.** El cuello de botella no es el host sino las APIs de los
venues: un ciclo tarda 500-700 ms y casi todo es esperar a la red. Eso no
mejora pagando un servidor. La UI es estatica y se sirve desde la propia Pi.

**Acceso desde fuera: Tailscale.** Red privada, sin abrir puertos en el router
y sin exponer nada a internet. Desde el movil o desde fuera de casa se ve igual
que en local.

**AWS solo si hace falta**: si se quiere que la herramienta siga en pie con
internet de casa caido, o si se abre la API publica a terceros.

**La excepcion son las copias de seguridad, y no es opcional.** Los datos del
usuario van a vivir en una tarjeta SD que se desgasta. Copia cifrada de la base
de datos a S3 cada noche. Es el unico uso de AWS que entra desde el principio.

## Dos dominios de datos, y no se mezclan

| | Datos de mercado | Datos del usuario |
|---|---|---|
| Origen | recolectados de APIs | introducidos a mano |
| Si se pierden | se vuelven a recoger | **no hay vuelta atras** |
| Tamano | cientos de miles de filas | cientos de filas |
| Retencion | si, con purga automatica | nunca se purgan |
| Copia de seguridad | no hace falta | obligatoria, cifrada, fuera de la Pi |

Esta separacion es la que decide la politica de copias: respaldar series
temporales de mercado seria caro e inutil, y no respaldar el journal de
operaciones seria perderlo el dia que muera la tarjeta.

**Los datos del usuario se guardan en el servidor, no en el navegador.** Es un
cambio consciente respecto a la version anterior de la app: lo que vive en
`localStorage` desaparece al cambiar de navegador o al borrar datos del sitio, y
no se puede consultar desde el movil.

## Cadencia de escritura, calculada para la SD

No hacen falta datos al segundo. El funding se liquida cada hora, asi que
muestrear cada dos minutos permite estudiar tendencias de horas y dias.

- **Recogida cada 2 min**, en memoria, para la vista en vivo.
- **Persistencia cada 6 min**: una muestra por cada tres ciclos aproximadamente,
  con un commit por escritura. El total de filas depende de los mercados activos. A 15 s y guardando cada ciclo serian 2,8 millones de filas
  diarias, lo que mata una tarjeta SD en meses.

El beneficio principal de la cadencia lenta no es el disco sino el **rate limit
por IP**, que es el recurso escaso: la Pi puede compartir IP publica con
otros procesos. A 120 s se reduce aproximadamente a la mitad el polling frente a 60 s.
El margen de frescura es 5 min; un fallo de consulta se avisa en su ciclo.
QFEX mantiene su socket: esta cadencia limita la publicacion del snapshot,
no la frecuencia de mensajes que decide enviar el proveedor.

Esto **no limita a un bot de ejecucion**: nunca se opera contra un precio de
hace un minuto. El bot vuelve a consultar precio y libro en el momento de
ejecutar, sea cual sea la cadencia del collector.

Retencion: resolucion completa 14 dias, agregados por hora a partir de ahi, y
purga automatica. Los graficos de evolucion (DEX Volume, Parity) leen de los
agregados, que es exactamente la "foto cada 2 h" de la version anterior.

## Lo que NO se hace

- No se guardan claves privadas ni seed phrases en el repo, ni en `.env` dentro
  del repo, ni en la base de datos.
- No se firma nada fuera de `apps/signer`.
- No se muestran datos derivados sin marcar de donde salen.
- No se anaden dependencias sin mirar quien las mantiene.
