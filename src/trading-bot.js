const {getOrdersPaginated} = require('./indexer-client.js')
const {pickCrossingOrderIds} = require('./orderbook-utils.js')
const {humanToRaw, displayPriceToContract} = require('./amount-format.js')
const {gaussRandom, uniform, randomInt, randomSide, sampleTwo} = require('./gauss-random.js')

/**
 * @typedef {Object} TradingBotDeps
 * @property {Object} axis         AxisContractClient instance
 * @property {Object} OrderKind    {Limit, Fill, FillOrKill}
 * @property {string} trader       G-address of the bot
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

    /** @param {TradingBotDeps} deps */
    constructor({axis, OrderKind, trader, config}) {
        this.axis = axis
        this.OrderKind = OrderKind
        this.trader = trader
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
        const [base, quote] = sampleTwo(tokens)
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
        const rawOrders = await this.fetchOrderbook(base.token, quote.token)
        const orders = pickCrossingOrderIds(rawOrders, side, price, base.token, quote.token)

        const payload = {
            kind: this.OrderKind.Limit,
            trader: this.trader,
            amount,
            selling,
            buying,
            price,
            orders
        }

        console.log(`[bot] ${side.toUpperCase()} ${amountStr} ${base.symbol} (~$${amountUsd.toFixed(4)})/${quote.symbol} @ ${priceStr} (ref ${referencePrice.toFixed(7)}, book: ${rawOrders.length}, crossings: ${orders.length})`)
        const [soldRaw, boughtRaw, newOrderId] = side === 'buy'
            ? await this.axis.buy(payload)
            : await this.axis.sell(payload)
        console.log(`[bot] result: sold=${soldRaw} bought=${boughtRaw} newOrderId=${newOrderId}`)

        await this.enforceMaxPositions()
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
        //sort oldest first by `created` (fallback to id since order ids are monotonic u64)
        active.sort((a, b) => {
            const ac = Number(a.created ?? a.id)
            const bc = Number(b.created ?? b.id)
            return ac - bc
        })
        const excess = active.length - this.cfg.maxPositions
        const toCancel = active.slice(0, excess).map(o => BigInt(o.id))
        console.log(`[bot] evicting ${toCancel.length} oldest orders: ${toCancel.map(String).join(',')}`)
        await this.axis.cancel(toCancel, this.trader)
    }
}

module.exports = TradingBot
