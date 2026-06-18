//Cap on crossing order IDs passed to buy()/sell() — bounds Soroban tx size.
const MAX_CROSS_IDS = 20

//Fixed-point scale the AXIS contract uses for prices (PRECISION in orderbook.rs).
const PRECISION = 10n ** 18n

/**
 * Invert a fixed-point price, mirroring the contract's `invert_price`:
 *   PRECISION^2 / price
 * @param {bigint} price  raw i128 price (PRECISION fixed point), must be > 0
 * @return {bigint}
 */
function invertPrice(price) {
    return (PRECISION * PRECISION) / price
}

/**
 * Pick IDs of resting orders that cross the taker's price.
 *
 * This mirrors the contract's matching rule in `orderbook.rs::match_orders`
 * exactly, so the ids we send only ever include orders the contract will
 * actually fill — no dependency on the indexer's `rprice` convention:
 *
 *   - A maker order is eligible only when its assets mirror the taker's:
 *     `maker.selling === taker.buying` and `maker.buying === taker.selling`
 *     (the contract panics with InvalidMatch otherwise).
 *   - Every resting order stores `price` as a raw i128 "buying per selling" in
 *     its own orientation. The taker's `limitPrice` is the same i128 we pass to
 *     buy()/sell() ("buying per selling" for the taker). The contract crosses when:
 *       Sell: order.price <= invert_price(limitPrice)
 *       Buy : order.price <= limitPrice
 *
 * Results are best-first: the lowest maker `price` is the most favorable fill
 * for the taker on both sides (it maximizes tokens received per token sent).
 * Capped at MAX_CROSS_IDS to bound transaction size.
 *
 * @param {Array<{id:string,status:string,selling:string,buying:string,price:string|bigint}>} rawOrders
 * @param {'buy'|'sell'} side
 * @param {bigint} limitPrice  taker limit as raw i128 — the exact value sent to buy()/sell()
 * @param {string} baseContract
 * @param {string} quoteContract
 * @return {string[]}
 */
function pickCrossingOrderIds(rawOrders, side, limitPrice, baseContract, quoteContract) {
    if (!rawOrders?.length || limitPrice == null)
        return []
    //taker orientation: a buy sells quote to acquire base; a sell sells base to acquire quote
    const takerSelling = side === 'buy' ? quoteContract : baseContract
    const takerBuying = side === 'buy' ? baseContract : quoteContract
    //price-acceptance threshold compared against the maker's stored price.
    //a sell limit of 0 means "accept any price" (market sell) → no upper bound.
    const maxExecPrice = side === 'sell'
        ? (limitPrice > 0n ? invertPrice(limitPrice) : null)
        : limitPrice

    const crossing = []
    for (const o of rawOrders) {
        if (o.status !== 'ACTIVE')
            continue
        //the contract requires the maker order to mirror the taker's assets
        if (o.selling !== takerBuying || o.buying !== takerSelling)
            continue
        let price
        try {
            price = BigInt(o.price)
        } catch {
            continue //unparseable price → skip rather than crash the tick
        }
        if (price <= 0n)
            continue
        if (maxExecPrice !== null && price > maxExecPrice)
            continue
        crossing.push({id: o.id, price})
    }
    //lowest maker price first — the most favorable fill for the taker on both sides
    crossing.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0))
    return crossing.slice(0, MAX_CROSS_IDS).map(x => x.id)
}

module.exports = {pickCrossingOrderIds, invertPrice, MAX_CROSS_IDS, PRECISION}
