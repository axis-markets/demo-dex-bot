const {getOrdersPaginated} = require('./indexer-client.js')
const {pickCrossingOrderIds} = require('./orderbook-utils.js')
const {humanToRaw, displayPriceToContract} = require('./amount-format.js')
const {gaussRandom, uniform, randomInt, randomSide, sampleTwo} = require('./gauss-random.js')
const {committedAmount, planApproval, maxQuoteSpend} = require('./allowance.js')

//contract error AssetPriceOracleFetchFailed: neither market asset has a fresh cached price
const PRICE_FETCH_FAILED = 722
//how long a market is left out after it failed with PRICE_FETCH_FAILED, in milliseconds
const UNPRICED_COOLDOWN = 5 * 60_000
//how long an order the bot created is counted before the indexer reports it, in milliseconds
const RECENT_ORDER_TTL = 2 * 60_000

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
 * @typedef {Object} TradingBotDeps
 * @property {Object} axis         AxisContractClient instance
 * @property {Object} OrderKind    {Limit, Fill, FillOrKill}
 * @property {string} trader       G-address of the bot
 * @property {Object} config       resolved config module
 * @property {{getAllowance: function(string, string): Promise<bigint>, getLatestLedger: function(): Promise<number>}} tokenState
 *   on-chain allowance reads (see token-state.js)
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
     * Markets left out until the given time (ms) after the contract found no oracle price for them
     * @type {Map<string, number>}
     * @private
     */
    unpriced = new Map()

    /**
     * Orders the bot created that the indexer may not report yet, by id: counted in the allowance of their selling
     * token, since an absolute approval sized without them would leave them unbacked
     * @type {Map<string, {selling: string, amount: bigint, created: number}>}
     * @private
     */
    recentOrders = new Map()

    /** @param {TradingBotDeps} deps */
    constructor({axis, OrderKind, trader, config, tokenState}) {
        this.axis = axis
        this.OrderKind = OrderKind
        this.trader = trader
        this.cfg = config
        this.tokenState = tokenState
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
        try {
            await this.tradeOnce()
        } catch (e) {
            console.error('[bot] trade failed:', e.message || e)
        }
        this.scheduleTrade(randomInt(this.cfg.tradeMin, this.cfg.tradeMax) * 1000)
    }

    /** @private */
    async tradeOnce() {
        const {tokens, decimals, priceStddev, amountMin, amountMax} = this.cfg

        //pick a random pair; reference price = USD cross price (quote per base)
        const pair = this.pickPair(tokens)
        if (!pair) {
            console.log('[bot] no market has an oracle price, skipping')
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

        //fetch a fresh orderbook snapshot right before computing crossings, so the
        //ids we send to buy()/sell() reflect the indexer's current state. Pass the
        //raw i128 `price` (not the float) so selection mirrors the contract exactly.
        //The contract holds no funds: the bot's allowance on the selling token must cover
        //this trade plus its resting orders selling that token, read alongside the book.
        const [rawOrders, ownSelling, allowance, ledger] = await Promise.all([
            this.fetchOrderbook(base.token, quote.token),
            getOrdersPaginated({owner: this.trader, asset: selling, maxTotal: 1000}),
            this.tokenState.getAllowance(selling, this.trader),
            this.tokenState.getLatestLedger()
        ])
        const orders = pickCrossingOrderIds(rawOrders, side, price, base.token, quote.token)
        //most of `selling` the trade may pull: the base amount for a sell, the ceiled quote cost for a buy
        const required = side === 'buy' ? maxQuoteSpend(amount, price) : amount
        const committed = committedAmount(ownSelling, selling) + this.unindexedAmount(ownSelling, selling)
        const approve = planApproval({required, committed, allowance, ledger})

        const payload = {
            kind: this.OrderKind.Limit,
            trader: this.trader,
            amount,
            selling,
            buying,
            price,
            orders,
            approve
        }

        console.log(`[bot] ${side.toUpperCase()} ${amountStr} ${base.symbol} (~$${amountUsd.toFixed(4)})/${quote.symbol} @ ${priceStr} (ref ${referencePrice.toFixed(7)}, book: ${rawOrders.length}, crossings: ${orders.length}${approve ? `, approving ${approve.amount}` : ''})`)
        const submit = () => side === 'buy' ? this.axis.buy(payload) : this.axis.sell(payload)
        let result
        try {
            result = await submit()
        } catch (e) {
            if (e?.code !== PRICE_FETCH_FAILED)
                throw e
            //limit orders are valued with a cached oracle price that expires after 72h and is
            //refreshed only by the permissionless `requote`: refresh it and retry once (the failed
            //attempt was rejected at simulation, nothing was sent)
            console.log(`[bot] no cached oracle price for ${base.symbol}/${quote.symbol}, requoting the market`)
            await this.axis.requote(selling, buying)
            try {
                result = await submit()
            } catch (retryError) {
                if (retryError?.code === PRICE_FETCH_FAILED) {
                    //the oracle has no usable price either: leave the market out for a while
                    console.log(`[bot] oracle has no price for ${base.symbol}/${quote.symbol}, pausing the market for ${UNPRICED_COOLDOWN / 60000} min`)
                    this.unpriced.set(pairKey(base, quote), Date.now() + UNPRICED_COOLDOWN)
                }
                throw retryError
            }
        }
        const [soldRaw, boughtRaw, newOrderId] = result
        console.log(`[bot] result: sold=${soldRaw} bought=${boughtRaw} newOrderId=${newOrderId}`)
        if (newOrderId) {
            //remainder left on the book, in `selling` units: a buy remainder is stored sell-equivalent (quote),
            //bounded by its cost at the limit price
            const rest = side === 'buy' ? maxQuoteSpend(amount - boughtRaw, price) : amount - soldRaw
            this.recentOrders.set(newOrderId.toString(), {selling, amount: rest, created: Date.now()})
        }

        await this.enforceMaxPositions()
    }

    /**
     * Remaining amount of the orders the bot created selling `asset` that the indexer does not report yet. Entries are
     * dropped once the indexer lists them, or after RECENT_ORDER_TTL (filled or removed before it caught up)
     * @private
     * @param {Array<{id: string}>} indexed - Own orders reported by the indexer for the asset
     * @param {string} asset - Token contract address
     * @return {bigint}
     */
    unindexedAmount(indexed, asset) {
        const now = Date.now()
        const known = new Set(indexed.map(o => o.id))
        let sum = 0n
        for (const [id, order] of this.recentOrders) {
            if (known.has(id) || now - order.created > RECENT_ORDER_TTL) {
                this.recentOrders.delete(id)
            } else if (order.selling === asset) {
                sum += order.amount
            }
        }
        return sum
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
     * Fetch the current active orderbook for a pair from the indexer.
     * Failures bubble up so `runTradeTick()`'s catch logs them and the loop reschedules.
     * @private
     * @param {string} baseToken
     * @param {string} quoteToken
     * @return {Promise<Array<import('./indexer-client.js').IndexerOrder>>}
     */
    fetchOrderbook(baseToken, quoteToken) {
        return getOrdersPaginated({
            asset: [baseToken, quoteToken],
            maxTotal: 1000
        })
    }

    /** @private */
    async enforceMaxPositions() {
        //count the bot's active orders across ALL pairs — the cap is global
        const own = await getOrdersPaginated({
            owner: this.trader,
            maxTotal: 1000
        })
        const active = own.filter(o => o.status === 'ACTIVE')
        if (active.length <= this.cfg.maxPositions) {
            console.log(`[bot] active positions: ${active.length}/${this.cfg.maxPositions}`)
            return
        }
        //oldest first: `cursor` is the order's creation position (monotonic), while ids are
        //hashes of owner and nonce and `created` only has second resolution
        active.sort((a, b) => {
            const ac = BigInt(a.cursor)
            const bc = BigInt(b.cursor)
            return ac < bc ? -1 : ac > bc ? 1 : 0
        })
        const excess = active.length - this.cfg.maxPositions
        const toCancel = active.slice(0, excess).map(o => BigInt(o.id))
        console.log(`[bot] evicting ${toCancel.length} oldest orders: ${toCancel.map(String).join(',')}`)
        await this.axis.cancel(toCancel, this.trader)
    }
}

module.exports = TradingBot
