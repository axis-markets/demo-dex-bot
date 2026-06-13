//Cap on crossing order IDs passed to buy()/sell() — bounds Soroban tx size.
const MAX_CROSS_IDS = 20

/**
 * Pick IDs of resting orders that cross the trader's price.
 *   - BUY  at P → asks with rprice ≤ P (selling=base, buying=quote)
 *   - SELL at P → bids with rprice ≥ P (selling=quote, buying=base)
 * Best-first sort (cheapest ask / highest bid), capped at MAX_CROSS_IDS.
 * @param {Array<{id:string,status:string,selling:string,buying:string,rprice:number}>} rawOrders
 * @param {'buy'|'sell'} side
 * @param {number} limitPrice
 * @param {string} baseContract
 * @param {string} quoteContract
 * @return {string[]}
 */
function pickCrossingOrderIds(rawOrders, side, limitPrice, baseContract, quoteContract) {
    if (!rawOrders?.length)
        return []
    const crossing = []
    for (const o of rawOrders) {
        if (o.status !== 'ACTIVE')
            continue
        const isAsk = o.selling === baseContract && o.buying === quoteContract
        const isBid = o.selling === quoteContract && o.buying === baseContract

        if (side === 'buy' && isAsk) {
            if (o.rprice > 0 && o.rprice <= limitPrice)
                crossing.push({id: o.id, price: o.rprice})
        } else if (side === 'sell' && isBid) {
            const orderPrice = 1 / o.rprice
            if (orderPrice >= limitPrice)
                crossing.push({id: o.id, price: orderPrice})
        }
    }
    crossing.sort((a, b) => side === 'buy' ? a.price - b.price : b.price - a.price)
    return crossing.slice(0, MAX_CROSS_IDS).map(x => x.id)
}

module.exports = {pickCrossingOrderIds, MAX_CROSS_IDS}
