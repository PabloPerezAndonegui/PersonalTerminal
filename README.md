# DeFi Terminal

A self-hosted, **read-only** terminal for perpetual futures and DeFi data:
funding across venues, price gaps between exchanges, open interest, pools,
bridges and public Hyperliquid wallets.

It runs on your own machine. Your followed wallets, notes and history live in a
local SQLite file that never leaves it.

## What it does

**Trading**

| Section | What you get |
|---|---|
| Terminal | A Hyperliquid frontend built on its public API: every perp, HIP-3 and spot market, candles, order book and trades |
| Hyperliquid Tracker | Follow public wallets: positions (HIP-3 included), fills on the chart and optional Telegram alerts |
| Funding Arb | Funding rates of the same asset across 16 venues, normalised to the same period, with how sustained each spread has been |
| Open Interest | Open interest across 14 exchanges, with each venue's convention shown |
| Compare | Volume, open interest and revenue per protocol, side by side |

**DeFi**

| Section | What you get |
|---|---|
| DEX Volume | Perp DEX volume by venue and asset class, daily and weekly |
| Pools & Yields | Pools from DefiLlama, sortable by 7, 15 and 30 day yield |
| Bridges | Routes and live quotes from several bridges for the same transfer |
| Explorer | Search any asset across every venue, with equivalent tickers matched (SPY / US500, XAU / GOLD...) |
| Parity | Where an asset is cheapest and most expensive right now, net of fees and spread, plus a simulator that walks both order books |
| Points & Competitions | Running campaigns and points programs |
| Economic Calendar | Macro events that move the market |

**Data Sources**: freshness, coverage, latency and errors of every source,
which tabs each one feeds, and the data issues detected in the last cycle.

## Principles

- **Read-only.** It never connects a wallet, never signs and never trades. It
  only asks for public addresses, and it rejects a seed phrase pasted by
  mistake.
- **Unknown is unknown.** A missing value is shown as "—", never as 0.
  Estimates are labelled as estimates.
- **Every number has a source** you can check in Data Sources, with its age.
- **Polite with APIs.** Polling intervals stay well inside each venue's rate
  limits, so it can share an IP with other tools.

## Quick start

Requires **Node 24** or newer. Nothing else: no Docker, no external database,
no build step for the backend (Node runs the TypeScript directly).

```bash
git clone https://github.com/PabloPerezAndonegui/PersonalTerminal.git
cd PersonalTerminal
npm ci
```

Then, in two terminals:

```bash
npm run api                       # API and collectors on http://127.0.0.1:8080
npm run dev --workspace @defi/web # web on http://localhost:5173
```

The first cycle takes a minute to fill every tab. Data accumulates from then
on: history based views (funding persistence, charts) get better the longer it
runs.

## Updating

```bash
npm run backup   # optional: export your data to data/backups/ first
git pull
npm ci
```

Then restart the API and the web. Your data is safe across updates:
`data/` and `.env` are git-ignored, so `git pull` never touches them, and the
database schema migrates itself on startup.

To be notified of new versions, use **Watch → Custom → Releases** on GitHub.
If you want to change the code yourself, fork the repo and pull from this one
when you want the updates.

## Configuration

Everything works without configuration. To change something, create a `.env`
file in the project root (it is git-ignored, see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `API_HOST` | `127.0.0.1` | Address the API listens on |
| `API_PORT` | `8080` | API port |
| `DB_PATH` | `./data/defi.db` | Where your local database lives |
| `VENUES` | all | Comma separated venue ids to collect, e.g. `hyperliquid,lighter` |
| `TELEGRAM_BOT_TOKEN` | none | Your own bot, for position alerts |
| `TELEGRAM_CHAT_ID` | none | Chat that receives the alerts (`npm run telegram-id` finds it) |
| `TELEGRAM_DRY_RUN` | `false` | `true` logs alerts instead of sending them |
| `ALERT_MIN_USD` | `500` | Smallest position change that triggers an alert |

## Your data and your security

- Everything you add (wallets, notes, settings) is stored in `data/defi.db`,
  which is git-ignored. `npm run backup` exports it to JSON.
- The only outgoing traffic is requests to public market APIs, plus Telegram if
  you configure it.
- The API listens on `127.0.0.1` only. Do not expose it to the internet: there
  is no login. To reach it from your phone, use a private network such as
  Tailscale or a VPN.
- No private key, seed phrase or API secret is ever needed. If something asks
  for one, it is not this project.

## Development

```bash
npm run typecheck  # strict TypeScript over the whole monorepo
npm test           # test suite (node:test)
npm run smoke      # checks every venue adapter against the live API
npm run verify-oi  # checks each venue's open interest convention
```

```
apps/api        HTTP API, collectors and alerts
apps/web        React + Vite interface
packages/core   domain types and shared utilities
packages/venues one adapter per exchange, plus other public sources
packages/*      collector, scanner, storage, validation, source catalogue
```

Stack: Node 24 with native TypeScript, `node:sqlite`, React 19, Vite and
lightweight-charts. The backend has no runtime dependencies.

Design notes and the architecture are in [ARCHITECTURE.md](ARCHITECTURE.md)
and [DESIGN.md](DESIGN.md) (in Spanish).

## Disclaimer

This is a personal research tool, not financial advice. Data comes from third
party public APIs and can be wrong, delayed or incomplete. Not affiliated with
any of the venues it reads. Use it at your own risk.

## License

[MIT](LICENSE)
