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
5. **Picks an amount** — a **USD** value drawn uniformly from `[amountMin, amountMax]`, converted to base-token units by dividing by the base token's reference price.
6. **Submits a `Limit` order** through its `AxisAccount` (`@axis-markets/client`): `account.buy()` / `account.sell()` looks up the crossing orders with a direct-market Aggregator quote and sizes the allowance. The AXIS contract holds no funds: fills are settled with `transfer_from` against the maker's balance and the allowance granted to the contract. When the allowance on the selling token (pushed by the Aggregator, whose data source streams the bot account's balances and allowances per ledger; read over Stellar RPC only while that state is not current) is short of this trade plus the bot's open orders selling that token, the trade carries an `approve` for exactly that sum (about 30 days of ledgers).
7. **Enforces the position cap** — if its open orders **across all pairs** exceed `maxPositions`, it cancels the oldest ones (by creation position; order ids are not sequential).
8. **Reschedules** the next tick at a random delay between `tradeMin` and `tradeMax` seconds.

The open orders and the backing of the bot's account live in the `AxisAccount` memory, kept current by the Aggregator WebSocket push API (REST polling while it is down), so a tick makes no order-book or own-orders requests; orders the bot created count as committed until the indexer reports them. Fills and expirations of its orders are logged as they are pushed.

The traded universe is defined entirely by the `tokens` list in the config file (the testnet defaults are USDC, EURC, XLM, CETES). The process is stateless — all state lives in memory and on-chain; nothing is persisted to disk.

---

## Architecture

```
              ┌──────────────────────────────────┐
              │        src/index.js (entry)       │
              │  load config + keypair            │
              │  Axis (contract state, markets)   │
              │  AxisAccount (orders, allowances) │
              │  wire SIGINT/SIGTERM              │
              └────────────────┬─────────────────┘
                               │
              ┌────────────────▼─────────────────┐
              │        src/trading-bot.js         │
              │  TradingBot                       │
              │  schedule → trade → repeat        │
              └───┬──────────────┬───────────┬───┘
                  │              │           │
   ┌──────────────▼───────┐ ┌────▼─────────┐ ┌▼────────────────────┐
   │ src/gauss-random.js   │ │ src/amount-  │ │ src/sign-keypair.js  │
   │ side / price / amount │ │ format.js    │ │ tx signing callback  │
   │ / delay sampling      │ │ human → i128 │ │ (Stellar keypair)    │
   └───────────────────────┘ └──────────────┘ └─────────────────────┘
                               │
            ┌──────────────────▼──────────────┐      ┌──────────────┐
            │ AXIS Aggregator                  │      │ Stellar RPC  │
            │ WebSocket push (orders, backing) │      │ (contract,   │
            │ + REST (quotes)                  │      │  allowances) │
            └──────────────────────────────────┘      └──────────────┘
```

| File | Responsibility |
|------|----------------|
| [src/index.js](src/index.js) | Entry point. Loads config, builds the Stellar keypair, dynamically imports the ESM `@axis-markets/client`, connects an `Axis` instance (contract state, markets) and the bot's `AxisAccount`, starts the bot, and handles graceful shutdown on `SIGINT`/`SIGTERM`. |
| [src/trading-bot.js](src/trading-bot.js) | The `TradingBot` class — the scheduling loop, single-trade logic (`tradeOnce`), the 722 requote-and-retry, and global `maxPositions` enforcement over the account's open orders. |
| [src/config.js](src/config.js) | Resolves the config name from `CONFIG_NAME` (env), loads & validates `./<name>.config.json`, and reads `TRADER_SECRET` from env. Throws on a missing secret, unreadable file, or invalid tokens. |
| [src/amount-format.js](src/amount-format.js) | Decimal ↔ raw integer conversion. `humanToRaw` (truncating, string-safe) and `displayPriceToContract` (scales a quote-per-base price to the contract's i128 representation). |
| [src/gauss-random.js](src/gauss-random.js) | Random samplers: `gaussRandom`, `uniform`, `randomInt`, `randomSide`, and `sampleTwo` (random distinct pair). |
| [src/sign-keypair.js](src/sign-keypair.js) | Builds the `signTransaction` callback backed by a Stellar `Keypair` and network passphrase. |

### Notable implementation details

- **Price scaling** (`displayPriceToContract`): `contract_price = displayPrice × 10^(18 + quoteDecimals − baseDecimals)`. All tokens share a single `decimals`, so this reduces to `× 10^18`. Pass prices as strings to avoid IEEE-754 drift at large scale.
- **Crossing and allowances**: handled by `AxisAccount`. The crossing orders come from a direct-market Aggregator quote for the trade amount (orders beyond the limit price are skipped by the contract). An approval is absolute, so it is sized to this trade plus every open order selling the same token; otherwise it would leave those orders unbacked. For a buy the trade needs at most `ceil(amount × price / 10^18)` quote tokens.
- **Amount semantics**: the order `amount` is always expressed in **base** raw units for both `buy()` and `sell()`.
- **Resilience**: a failed trade tick is caught and logged; the loop reschedules and continues. Limit orders are valued with an oracle price the contract caches for 72 h and refreshes only on `requote`/`subsidize`: when a trade fails with `AssetPriceOracleFetchFailed` (722), the bot calls the permissionless `requote` for the market (`AxisMarket.requote()`) (sent only when it caches a newer price) and retries the trade once; when that fails too, it leaves the market out for 5 minutes, so an oracle that stops publishing an asset does not turn every tick into a failure.

---

## Requirements

- **Node.js 22+** (required by `@axis-markets/client`; uses the global `fetch` API).
- **pnpm** (recommended) or npm.
- Access to a running **AXIS aggregator/indexer** (default `http://localhost:8070`) and a **Soroban RPC** endpoint, for AXIS contract v0.5 (no-custody, allowance-based settlement).
- A funded **Stellar account** secret key for the bot to trade with, holding the configured tokens (the bot grants the AXIS contract allowances on them as it trades). The market of every configured pair must be open (`subsidize`), otherwise limit orders fail with `AssetsNotVerifiedByOracle`.

---

## Installation

```bash
pnpm install
```

The AXIS contract client (`@axis-markets/client`) is linked from the sibling checkout `../axis-contract-client`. `@stellar/stellar-sdk` 17 is required (it replaced `@stellar/stellar-base`).

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
| `INDEXER_URL` | *(config `indexerUrl`)* | Overrides the aggregator/indexer base URL of the config file, e.g. `http://localhost:8070` for a local aggregator. |

### Config file (`./<name>.config.json`)

The selected file (e.g. [testnet.config.json](testnet.config.json)) holds all non-secret settings. It is committed to the repo, so **never put secrets in it**.

| Key | Example | Description |
|-----|---------|-------------|
| `axisContractId` | `CBEZ…LDFK` | AXIS DEX contract ID. |
| `networkPassphrase` | `Test SDF Network ; September 2015` | Stellar network passphrase (defaults to testnet if omitted). |
| `sorobanRpcUrl` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint. Defaults to testnet; trailing slash stripped. |
| `indexerUrl` | `http://localhost:8070` | AXIS Aggregator base URL (REST; the WebSocket push API is `<indexerUrl>/ws`). Defaults shown; trailing slash stripped. |
| `decimals` | `7` | Decimal precision **shared by all tokens**. |
| `priceStddev` | `0.04` | **Relative** standard deviation of the price distribution (fraction of the reference price). |
| `amountMin` / `amountMax` | `0.01` / `0.2` | Order-size range in **USD**, sampled uniformly, then converted to base-token units by dividing by the base token's reference price. |
| `maxPositions` | `40` | Max concurrent active orders **across all pairs** before the oldest are cancelled. |
| `tradeMin` / `tradeMax` | `5` / `10` | Delay range between trades, in **seconds**. |
| `tokens` | *(array, ≥ 2)* | Tradable tokens. Each: `{ "token": "C…", "symbol": "USDC", "price": 1 }` — contract address, friendly symbol for logs, and indicative **USD** price used to derive cross prices. |

Validation runs at startup: the config file must be readable JSON with an `axisContractId`, `tokens` must hold at least two entries, and each token needs a `token`, `symbol`, and finite `price > 0`.

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
[bot] BUY 0.1234567 EURC (~$0.1481)/USDC @ 1.2050000 (ref 1.2000000, book: 8, crossings: 2, approving 1693542)
[bot] result: sold=1487654 bought=1234567 newOrderId=undefined
[bot] active positions: 8/40
[bot] next trade in 7s
```

Stop with **Ctrl+C** (`SIGINT`); the bot cancels its timer and exits cleanly.

---

## Testing

Tests use [Jest](https://jestjs.io/), run through `node --experimental-vm-modules` because `@stellar/stellar-sdk` 17 pulls in ESM-only dependencies:

```bash
pnpm test
```

Coverage spans the core modules:

| Test file | Focus |
|-----------|-------|
| [test/config.test.js](test/config.test.js) | Config-name selection, file load, defaults, and validation (missing secret, unreadable file, bad tokens). |
| [test/trading-bot.test.js](test/trading-bot.test.js) | Random-pair selection, buy/sell routing through the account, 722 requote-and-retry and market pause, global position-cap enforcement, lifecycle. |
| [test/amount-format.test.js](test/amount-format.test.js) | Decimal-to-raw scaling, price conversion, truncation behavior. |
| [test/gauss-random.test.js](test/gauss-random.test.js) | Statistical properties of the samplers, including `sampleTwo` distinctness. |
| [test/sign-keypair.test.js](test/sign-keypair.test.js) | Transaction signing. |

---

## Dependencies

| Package | Purpose                                                    |
|---------|------------------------------------------------------------|
| `@axis-markets/client` | AXIS DEX client: `Axis` / `AxisAccount` (ESM; imported dynamically, linked from `../axis-contract-client`). |
| `@stellar/stellar-sdk` | Stellar crypto, keypair, transactions, signing, RPC.       |
| `dotenv` | Loads `.env` into `process.env`.                           |
| `jest` *(dev)* | Test runner.                                               |

---

## Security

- Never commit your `.env` or `TRADER_SECRET`. The `*.config.json` files are committed, so keep secrets out of them — the trader secret lives only in env.
- Use a dedicated, low-balance account — this is demo software.
- Default endpoints target Stellar **testnet**; double-check `networkPassphrase`, RPC, and contract IDs in your config file before pointing at mainnet.
