const {humanToRaw, displayPriceToContract} = require('./amount-format.js')
const {gaussRandom, uniform, randomInt, randomSide, sampleTwo} = require('./gauss-random.js')

//contract error AssetPriceOracleFetchFailed: neither market asset has a fresh cached price
const PRICE_FETCH_FAILED = 722
//how long a market is left out after it failed with PRICE_FETCH_FAILED, in milliseconds
const UNPRICED_COOLDOWN = 5 * 60_000

/**
 * Direction-independent market key
 * @param {{token: string}} a
 * @param {{token: string}} b
 * @return {string}
 */
function pairKey(a, b) {
    return a.token < b.token ? a.token + '/' + b.token : b.token + '/' + a.token
}

/**
 * @typedef {Object} Trader
 * @property {string} label   log prefix, e.g. "trader 1"
 * @property {import('@axis-markets/client').AxisAccount} account   the trader's account: open orders and backing in
 *   memory, trading with automatic crossing lookup and allowances
 * @property {import('@axis-markets/client').Signer} signer   the account signer, the source of its requotes
 */

/**
 * @typedef {Object} TradingBotDeps
 * @property {import('@axis-markets/client').Axis} axis   DEX state (markets, requote)
 * @property {Trader[]} traders   virtual traders, each trading from its own account
 * @property {Object} OrderKind    {Limit, Fill, FillOrKill}
 * @property {Object} config       resolved config module
 */

class TradingBot {
    /**
     * @type {NodeJS.Timeout | null}
     * @private
     */
    tradeTimer = null

    /**
     * @type {boolean}
     * @private
     */
    stopped = false

    /**
     * Markets left out until the given time (ms) after the contract found no oracle price for them, shared by all
     * traders: the price is a market property
     * @type {Map<string, number>}
     * @private
     */
    unpriced = new Map()

    /**
     * Requotes in flight by market key
     * @type {Map<string, Promise>}
     * @private
     */
    requotes = new Map()

    /** @param {TradingBotDeps} deps */
    constructor({axis, traders, OrderKind, config}) {
        this.axis = axis
        this.traders = traders
        this.OrderKind = OrderKind
        this.cfg = config
    }

    start() {
        this.stopped = false
        this.scheduleTrade(0)
    }

    stop() {
        this.stopped = true
        if (this.tradeTimer) clearTimeout(this.tradeTimer)
        this.tradeTimer = null
    }

    /** @private */
    scheduleTrade(delayMs) {
        if (this.stopped) return
        console.log(`[bot] next trade in ${Math.round(delayMs / 1000)}s`)
        this.tradeTimer = setTimeout(() => this.runTradeTick(), delayMs)
    }

    /** @private */
    async runTradeTick() {
        if (this.stopped) return
        //every trader trades on the same tick, in parallel: each one signs from its own account (own sequence)
        await Promise.all(this.traders.map(trader => this.tradeOnce(trader).catch(e => {
            console.error(`[${trader.label}] trade failed:`, e.message || e)
        })))
        this.scheduleTrade(randomInt(this.cfg.tradeMin, this.cfg.tradeMax) * 1000)
    }

    /**
     * Configured tokens the trader holds an authorized trustline to and a spendable balance in
     * @param {Trader} trader
     * @return {Array<{token: string, symbol: string, price: number}>}
     */
    tradableTokens(trader) {
        return this.cfg.tokens.filter(t => {
            const {known, authorized, balance} = trader.account.getAllowance(t.token)
            return known && authorized && balance > 0n
        })
    }

    /**
     * @param {Trader} trader
     * @private
     */
    async tradeOnce(trader) {
        const {decimals, priceStddev, amountMin, amountMax} = this.cfg
        const {label, account} = trader

        const tokens = this.tradableTokens(trader)
        if (tokens.length < 2) {
            console.log(`[${label}] needs 2+ tradable tokens (trustline and balance), has: ${tokens.map(t => t.symbol).join(',') || 'none'}, skipping`)
            return
        }
        //pick a random pair; reference price = USD cross price (quote per base)
        const pair = this.pickPair(tokens)
        if (!pair) {
            console.log(`[${label}] no market has an oracle price, skipping`)
            return
        }
        const [base, quote] = pair
        const referencePrice = base.price / quote.price
        const stddev = referencePrice * priceStddev //priceStddev is relative to the reference

        const side = randomSide()
        const priceNum = Math.max(0.0001, gaussRandom(referencePrice, stddev))
        //amountMin/amountMax are in USD; convert to base-token units via the base reference price
        const amountUsd = uniform(amountMin, amountMax)
        const amountNum = amountUsd / base.price
        const priceStr = priceNum.toFixed(7)
        const amountStr = amountNum.toFixed(decimals)

        const selling = side === 'buy' ? quote.token : base.token
        const buying = side === 'buy' ? base.token : quote.token

        //amount is always base raw — buy() takes "buying to acquire" (=base), sell() takes "selling to sell" (=base)
        const amount = humanToRaw(amountStr, decimals)
        const price = displayPriceToContract(priceStr, decimals, decimals)

        //the account looks up the crossing orders (Aggregator quote) and sizes the approval to cover this trade plus
        //every resting order selling the same token (the contract holds no funds)
        const params = {kind: this.OrderKind.Limit, selling, buying, amount, price}

        console.log(`[${label}] ${side.toUpperCase()} ${amountStr} ${base.symbol} (~$${amountUsd.toFixed(4)})/${quote.symbol} @ ${priceStr} (ref ${referencePrice.toFixed(7)})`)
        const submit = () => side === 'buy' ? account.buy(params) : account.sell(params)
        let result
        try {
            result = await submit()
        } catch (e) {
            if (e?.code !== PRICE_FETCH_FAILED)
                throw e
            //limit orders are valued with a cached oracle price that expires after 72h and is
            //refreshed only by the permissionless `requote`: refresh it and retry once (the failed
            //attempt was rejected at simulation, nothing was sent)
            console.log(`[${label}] no cached oracle price for ${base.symbol}/${quote.symbol}, requoting the market`)
            await this.requote(trader, base, quote)
            try {
                result = await submit()
            } catch (retryError) {
                if (retryError?.code === PRICE_FETCH_FAILED) {
                    //the oracle has no usable price either: leave the market out for a while
                    console.log(`[${label}] oracle has no price for ${base.symbol}/${quote.symbol}, pausing the market for ${UNPRICED_COOLDOWN / 60000} min`)
                    this.unpriced.set(pairKey(base, quote), Date.now() + UNPRICED_COOLDOWN)
                }
                throw retryError
            }
        }
        const {sold, bought, orderId, approve} = result
        console.log(`[${label}] result: sold=${sold} bought=${bought} newOrderId=${orderId}${approve ? ` approved=${approve.amount}` : ''}`)

        await this.enforceMaxPositions(trader)
    }

    /**
     * Refresh the cached oracle prices of the market, signed by the trader: another trader's account may be sending a
     * transaction at the same time. Traders requoting the same market concurrently share one call.
     * @param {Trader} trader
     * @param {{token: string}} base
     * @param {{token: string}} quote
     * @private
     */
    async requote(trader, base, quote) {
        const key = pairKey(base, quote)
        let pending = this.requotes.get(key)
        if (!pending) {
            const market = this.axis.getMarket(base.token, quote.token)
            if (!market)
                throw new Error('The market is not open')
            pending = market.requote(trader.signer).finally(() => this.requotes.delete(key))
            this.requotes.set(key, pending)
        }
        await pending
    }

    /**
     * Random [base, quote] pair, skipping markets paused after a missing oracle price
     * @private
     * @param {Array<{token: string}>} tokens
     * @return {Array<{token: string}>|null} - null when every sampled market is paused
     */
    pickPair(tokens) {
        const now = Date.now()
        for (const [key, until] of this.unpriced) {
            if (until <= now) {
                this.unpriced.delete(key)
            }
        }
        //random sampling with a bounded number of attempts keeps the pair distribution uniform over the rest
        for (let attempt = 0; attempt < 20; attempt++) {
            const pair = sampleTwo(tokens)
            if (!this.unpriced.has(pairKey(...pair)))
                return pair
        }
        return null
    }

    /**
     * Cancel the trader's oldest open orders beyond the position cap (across all markets). The open orders come from
     * the account memory, which includes the orders just created and not reported by the indexer yet.
     * @param {Trader} trader
     * @private
     */
    async enforceMaxPositions(trader) {
        const {label, account} = trader
        //newest first: by creation position (`cursor`), unconfirmed ones on top
        const open = account.getOrders()
        if (open.length <= this.cfg.maxPositions) {
            console.log(`[${label}] active positions: ${open.length}/${this.cfg.maxPositions}`)
            return
        }
        const toCancel = open.slice(this.cfg.maxPositions).map(o => o.id)
        console.log(`[${label}] evicting ${toCancel.length} oldest orders: ${toCancel.join(',')}`)
        await account.cancel(toCancel)
    }
}

module.exports = TradingBot
