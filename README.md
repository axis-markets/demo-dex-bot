# AXIS Demo DEX Bot

A demo automated trading bot for [AXIS DEX](https://github.com/axis-markets), a decentralized exchange built on the Stellar **Soroban** smart-contract platform.

The bot runs a simple, non-directional market-making loop: at randomized intervals it picks a random pair from a configured token list, prices a limit order around the pair's USD cross price, automatically crosses favorable resting orders from the live order book, and keeps its own open positions under a cap.

> ⚠️ **Demo / reference implementation.** It is meant to illustrate how to drive the AXIS contract client and indexer, not to be a profitable strategy. Run it on **testnet**.

---

## What it does

On each trade tick the bot:

1. **Picks a pair** — two distinct tokens chosen at random from the configured `tokens` list, assigned as base/quote.
2. **Derives a reference price** — the USD cross price of the pair, `base.price / quote.price` (quote per base), using the indicative USD prices in config.
3. **Picks a side** — buy or sell, 50/50 at random (no directional bias).
4. **Picks a price** — drawn from a Gaussian (normal) distribution centered on the reference price with a **relative** standard deviation `referencePrice × priceStddev` (clamped to a small positive minimum).
5. **Picks an amount** — drawn uniformly from `[amountMin, amountMax]`, denominated in the base asset.
6. **Fetches a fresh order book** snapshot for the pair from the AXIS indexer.
7. **Selects crossing orders** — resting orders that cross its limit price (cheapest asks when buying, highest bids when selling), best-first, capped at **20** order IDs to bound transaction size.
8. **Submits the order** via `axis.buy()` / `axis.sell()` as a `Limit` order, passing the crossing IDs to fill against.
9. **Enforces the position cap** — if its active orders **across all pairs** exceed `maxPositions`, it cancels the oldest ones.
10. **Reschedules** the next tick at a random delay between `tradeMin` and `tradeMax` seconds.

The traded universe is defined entirely by the `tokens` list in the config file (the testnet defaults are USDC, EURC, XLM, CETES). The process is stateless — all state lives in memory and on-chain; nothing is persisted to disk.

---

## Architecture

```
                         ┌──────────────────────────┐
                         │   src/index.js (entry)    │
                         │  load config + keypair    │
                         │  init AxisContractClient   │
                         │  wire SIGINT/SIGTERM       │
                         └────────────┬──────────────┘
                                      │
                         ┌────────────▼──────────────┐
                         │   src/trading-bot.js       │
                         │   TradingBot               │
                         │   schedule → trade → repeat │
                         └───┬───────────┬─────────┬──┘
                             │           │         │
        ┌────────────────────▼──┐  ┌─────▼──────┐ ┌▼───────────────────┐
        │ src/gauss-random.js    │  │ src/       │ │ src/orderbook-     │
        │ side / price / amount  │  │ indexer-   │ │ utils.js           │
        │ / delay sampling       │  │ client.js  │ │ pick crossing IDs  │
        └────────────────────────┘  │ HTTP /order│ └────────────────────┘
                                     │ pagination │
        ┌────────────────────────┐  └────────────┘ ┌────────────────────┐
        │ src/amount-format.js   │                 │ src/sign-keypair.js │
        │ human → raw i128       │                 │ tx signing callback │
        │ display price → i128   │                 │ (Stellar keypair)   │
        └────────────────────────┘                 └────────────────────┘
                                     │
                              ┌──────▼──────┐        ┌──────────────┐
                              │ AXIS indexer │        │ Soroban RPC  │
                              │ (order book) │        │ (contract)   │
                              └──────────────┘        └──────────────┘
```

| File | Responsibility |
|------|----------------|
| [src/index.js](src/index.js) | Entry point. Loads config, builds the Stellar keypair, dynamically imports the ESM-only `@axis-markets/contract-client`, constructs `AxisContractClient`, starts the bot, and handles graceful shutdown on `SIGINT`/`SIGTERM`. |
| [src/trading-bot.js](src/trading-bot.js) | The `TradingBot` class — the scheduling loop, single-trade logic (`tradeOnce`), order-book fetch, and global `maxPositions` enforcement. |
| [src/config.js](src/config.js) | Resolves the config name from `CONFIG_NAME` (env), loads & validates `./<name>.config.json`, and reads `TRADER_SECRET` from env. Throws on a missing secret, unreadable file, or invalid tokens. |
| [src/indexer-client.js](src/indexer-client.js) | HTTP client for the AXIS indexer's `/order` endpoint, with cursor-based pagination (`getOrdersPaginated`). |
| [src/orderbook-utils.js](src/orderbook-utils.js) | `pickCrossingOrderIds` — filters resting orders that cross the bot's price, sorts best-first, caps at `MAX_CROSS_IDS` (20). |
| [src/amount-format.js](src/amount-format.js) | Decimal ↔ raw integer conversion. `humanToRaw` (truncating, string-safe) and `displayPriceToContract` (scales a quote-per-base price to the contract's i128 representation). |
| [src/gauss-random.js](src/gauss-random.js) | Random samplers: `gaussRandom`, `uniform`, `randomInt`, `randomSide`, and `sampleTwo` (random distinct pair). |
| [src/sign-keypair.js](src/sign-keypair.js) | Builds the `signTransaction` callback backed by a Stellar `Keypair` and network passphrase. |

### Notable implementation details

- **Price scaling** (`displayPriceToContract`): `contract_price = displayPrice × 10^(18 + quoteDecimals − baseDecimals)`. All tokens share a single `decimals`, so this reduces to `× 10^18`. Pass prices as strings to avoid IEEE-754 drift at large scale.
- **Crossing logic**: a *buy* at price `P` crosses asks with `rprice ≤ P`; a *sell* at `P` crosses bids whose effective price (`1 / rprice`) is `≥ P`. See [src/orderbook-utils.js](src/orderbook-utils.js).
- **Amount semantics**: the order `amount` is always expressed in **base** raw units for both `buy()` and `sell()`.
- **Resilience**: a failed trade tick is caught and logged; the loop reschedules and continues.

---

## Requirements

- **Node.js 18+** (uses the global `fetch` API).
- **pnpm** (recommended) or npm.
- Access to a running **AXIS indexer** (default `http://localhost:8070`) and a **Soroban RPC** endpoint.
- A funded **Stellar account** secret key for the bot to trade with.

---

## Installation

```bash
pnpm install
```

The AXIS contract client (`@axis-markets/contract-client`) is installed from GitHub and built locally (listed under `pnpm.onlyBuiltDependencies`).

---

## Configuration

Configuration is split between **two env vars** (loaded from `.env` via [dotenv](https://www.npmjs.com/package/dotenv)) and a **committed JSON config file** at the project root.

### Environment variables

Copy the template and edit it:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADER_SECRET` | *(required)* | Secret key (`S…`) of the bot's Stellar account. Kept in env (not the committed config). The bot throws on startup if unset. |
| `CONFIG_NAME` | `testnet` | Selects which config file to load — `./<CONFIG_NAME>.config.json` from the project root. |

### Config file (`./<name>.config.json`)

The selected file (e.g. [testnet.config.json](testnet.config.json)) holds all non-secret settings. It is committed to the repo, so **never put secrets in it**.

| Key | Example | Description |
|-----|---------|-------------|
| `axisContractId` | `CBEZ…LDFK` | AXIS DEX contract ID. |
| `networkPassphrase` | `Test SDF Network ; September 2015` | Stellar network passphrase (defaults to testnet if omitted). |
| `sorobanRpcUrl` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint. Defaults to testnet; trailing slash stripped. |
| `indexerUrl` | `http://localhost:8070` | AXIS indexer base URL. Defaults shown; trailing slash stripped. |
| `decimals` | `7` | Decimal precision **shared by all tokens**. |
| `priceStddev` | `0.04` | **Relative** standard deviation of the price distribution (fraction of the reference price). |
| `amountMin` / `amountMax` | `0.01` / `0.2` | Order-size range (base units), sampled uniformly. |
| `maxPositions` | `40` | Max concurrent active orders **across all pairs** before the oldest are cancelled. |
| `tradeMin` / `tradeMax` | `5` / `10` | Delay range between trades, in **seconds**. |
| `tokens` | *(array, ≥ 2)* | Tradable tokens. Each: `{ "token": "C…", "symbol": "USDC", "price": 1 }` — contract address, friendly symbol for logs, and indicative **USD** price used to derive cross prices. |

Validation runs at startup: the config file must be readable JSON, `tokens` must hold at least two entries, and each token needs a `token`, `symbol`, and finite `price > 0`.

---

## Running

```bash
pnpm start        # node src/index.js
```

On startup the bot logs the loaded config name, trader address, token list, and endpoints, then begins the loop. Sample output:

```
[bot] config=testnet trader=GBOT...ADDRESS
[bot] tokens=USDC,EURC,XLM,CETES stddev=0.04 amount=(0.01..0.2) maxPositions=40
[bot] indexer=http://localhost:8070 rpc=https://soroban-testnet.stellar.org contract=CBEZ...LDFK
[bot] next trade in 0s
[bot] BUY 0.1234567 EURC/USDC @ 1.2050000 (ref 1.2000000, book: 8, crossings: 2)
[bot] result: sold=0 bought=5000000 newOrderId=42
[bot] active positions: 8/40
[bot] next trade in 7s
```

Stop with **Ctrl+C** (`SIGINT`); the bot cancels its timer and exits cleanly.

---

## Testing

Tests use [Jest](https://jestjs.io/):

```bash
pnpm test
```

Coverage spans the core modules:

| Test file | Focus |
|-----------|-------|
| [test/config.test.js](test/config.test.js) | Config-name selection, file load, defaults, and validation (missing secret, unreadable file, bad tokens). |
| [test/trading-bot.test.js](test/trading-bot.test.js) | Random-pair selection, buy/sell payload routing, order-book fetch, global position-cap enforcement, lifecycle. |
| [test/orderbook-utils.test.js](test/orderbook-utils.test.js) | Crossing-order selection, side filtering, price thresholds, ID cap. |
| [test/amount-format.test.js](test/amount-format.test.js) | Decimal-to-raw scaling, price conversion, truncation behavior. |
| [test/gauss-random.test.js](test/gauss-random.test.js) | Statistical properties of the samplers, including `sampleTwo` distinctness. |
| [test/indexer-client.test.js](test/indexer-client.test.js) | Query building, pagination, error handling. |
| [test/sign-keypair.test.js](test/sign-keypair.test.js) | Transaction signing. |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@axis-markets/contract-client` | AXIS DEX contract client (ESM-only; imported dynamically). |
| `@stellar/stellar-sdk` | Keypair, transactions, signing, RPC. |
| `@stellar/stellar-base` | Stellar crypto / XDR primitives. |
| `dotenv` | Loads `.env` into `process.env`. |
| `jest` *(dev)* | Test runner. |

---

## Security

- Never commit your `.env` or `TRADER_SECRET`. The `*.config.json` files are committed, so keep secrets out of them — the trader secret lives only in env.
- Use a dedicated, low-balance account — this is demo software.
- Default endpoints target Stellar **testnet**; double-check `networkPassphrase`, RPC, and contract IDs in your config file before pointing at mainnet.
