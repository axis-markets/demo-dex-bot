const {getOrdersPaginated} = require('./indexer-client.js')
const {pickCrossingOrderIds} = require('./orderbook-utils.js')
const {humanToRaw, displayPriceToContract} = require('./amount-format.js')
const {gaussRandom, uniform, randomInt, randomSide} = require('./gauss-random.js')

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
        this.scheduleTrade(randomInt(this.cfg.TRADE_MIN, this.cfg.TRADE_MAX) * 1000)
    }

    /** @private */
    async tradeOnce() {
        const {BASE_CONTRACT, QUOTE_CONTRACT, BASE_DECIMALS, QUOTE_DECIMALS,
            REFERENCE_PRICE, PRICE_STDDEV, AMOUNT_MIN, AMOUNT_MAX} = this.cfg

        const side = randomSide()
        const priceNum = Math.max(0.0001, gaussRandom(REFERENCE_PRICE, PRICE_STDDEV))
        const amountNum = uniform(AMOUNT_MIN, AMOUNT_MAX)
        const priceStr = priceNum.toFixed(7)
        const amountStr = amountNum.toFixed(BASE_DECIMALS)

        const selling = side === 'buy' ? QUOTE_CONTRACT : BASE_CONTRACT
        const buying = side === 'buy' ? BASE_CONTRACT : QUOTE_CONTRACT

        //amount is always base raw — buy() takes "buying to acquire" (=base), sell() takes "selling to sell" (=base)
        const amount = humanToRaw(amountStr, BASE_DECIMALS)
        const price = displayPriceToContract(priceStr, BASE_DECIMALS, QUOTE_DECIMALS)

        //fetch a fresh orderbook snapshot right before computing crossings, so the
        //ids we send to buy()/sell() reflect the indexer's current state
        const rawOrders = await this.fetchOrderbook()
        const orders = pickCrossingOrderIds(rawOrders, side, priceNum, BASE_CONTRACT, QUOTE_CONTRACT)

        const payload = {
            kind: this.OrderKind.Limit,
            trader: this.trader,
            amount,
            selling,
            buying,
            price,
            orders
        }

        console.log(`[bot] ${side.toUpperCase()} ${amountStr} @ ${priceStr} (book: ${rawOrders.length}, crossings: ${orders.length})`)
        const [soldRaw, boughtRaw, newOrderId] = side === 'buy'
            ? await this.axis.buy(payload)
            : await this.axis.sell(payload)
        console.log(`[bot] result: sold=${soldRaw} bought=${boughtRaw} newOrderId=${newOrderId}`)

        await this.enforceMaxPositions()
    }

    /**
     * Fetch the current pair-wide active orderbook from the indexer.
     * Failures bubble up so `runTradeTick()`'s catch logs them and the loop reschedules.
     * @private
     * @return {Promise<Array<import('./indexer-client.js').IndexerOrder>>}
     */
    fetchOrderbook() {
        return getOrdersPaginated({
            asset: [this.cfg.BASE_CONTRACT, this.cfg.QUOTE_CONTRACT],
            maxTotal: 1000
        })
    }

    /** @private */
    async enforceMaxPositions() {
        const own = await getOrdersPaginated({
            owner: this.trader,
            asset: [this.cfg.BASE_CONTRACT, this.cfg.QUOTE_CONTRACT],
            maxTotal: 200
        })
        const active = own.filter(o => o.status === 'ACTIVE')
        if (active.length <= this.cfg.MAX_POSITIONS) {
            console.log(`[bot] active positions: ${active.length}/${this.cfg.MAX_POSITIONS}`)
            return
        }
        //sort oldest first by `created` (fallback to id since order ids are monotonic u64)
        active.sort((a, b) => {
            const ac = Number(a.created ?? a.id)
            const bc = Number(b.created ?? b.id)
            return ac - bc
        })
        const excess = active.length - this.cfg.MAX_POSITIONS
        const toCancel = active.slice(0, excess).map(o => BigInt(o.id))
        console.log(`[bot] evicting ${toCancel.length} oldest orders: ${toCancel.map(String).join(',')}`)
        await this.axis.cancel(toCancel, this.trader)
    }
}

module.exports = TradingBot
