const {pickCrossingOrderIds, invertPrice, MAX_CROSS_IDS} = require('../src/orderbook-utils.js')

const BASE = 'BASE_CONTRACT'
const QUOTE = 'QUOTE_CONTRACT'

//Exact human→raw i128 conversion (PRECISION = 10^18), no float drift.
function raw(human) {
    const [w, f = ''] = String(human).split('.')
    return BigInt(w + (f + '0'.repeat(18)).slice(0, 18))
}

//An ask sells BASE for QUOTE → on-chain price is "buying per selling" = quote-per-base.
function ask(id, quotePerBase, status = 'ACTIVE') {
    return {id, status, selling: BASE, buying: QUOTE, price: raw(quotePerBase).toString()}
}
//A bid sells QUOTE for BASE → on-chain price is base-per-quote = the inverse of quote-per-base.
function bid(id, quotePerBase, status = 'ACTIVE') {
    return {id, status, selling: QUOTE, buying: BASE, price: invertPrice(raw(quotePerBase)).toString()}
}

describe('pickCrossingOrderIds', () => {
    test('returns [] for empty / null input', () => {
        expect(pickCrossingOrderIds([], 'buy', raw('1.2'), BASE, QUOTE)).toEqual([])
        expect(pickCrossingOrderIds(null, 'buy', raw('1.2'), BASE, QUOTE)).toEqual([])
        expect(pickCrossingOrderIds(undefined, 'sell', raw('1.2'), BASE, QUOTE)).toEqual([])
    })

    test('BUY matches asks with price ≤ limit, cheapest first', () => {
        const orders = [
            ask('a-high', '1.30'),
            ask('a-mid', '1.20'),
            ask('a-low', '1.15'),
            ask('a-mid2', '1.18'),
            bid('b-irrelevant', '1.10')
        ]
        expect(pickCrossingOrderIds(orders, 'buy', raw('1.20'), BASE, QUOTE))
            .toEqual(['a-low', 'a-mid2', 'a-mid'])
    })

    test('SELL matches bids that cross invert(limit), best (highest quote-per-base) first', () => {
        const orders = [
            bid('b-low', '1.15'),
            bid('b-high', '1.30'),
            bid('b-mid', '1.25'),
            ask('a-irrelevant', '1.40')
        ]
        expect(pickCrossingOrderIds(orders, 'sell', raw('1.20'), BASE, QUOTE))
            .toEqual(['b-high', 'b-mid'])
    })

    test('matches the contract cross condition at the boundary (order-19 scenario)', () => {
        //taker SELLs base (USDC) priced quote-per-base = 0.8169164 EURC/USDC.
        //invert(limit) ≈ 1.2241 → a maker bid priced 1.25 base-per-quote does NOT cross, 1.20 does.
        const limit = raw('0.8169164')
        const justOut = {id: 'out', status: 'ACTIVE', selling: QUOTE, buying: BASE, price: raw('1.25').toString()}
        const justIn = {id: 'in', status: 'ACTIVE', selling: QUOTE, buying: BASE, price: raw('1.20').toString()}
        expect(pickCrossingOrderIds([justOut, justIn], 'sell', limit, BASE, QUOTE)).toEqual(['in'])
    })

    test('skips non-ACTIVE orders', () => {
        const orders = [
            ask('a1', '1.10', 'FILLED'),
            ask('a2', '1.15', 'CANCELED'),
            ask('a3', '1.18', 'ACTIVE')
        ]
        expect(pickCrossingOrderIds(orders, 'buy', raw('1.20'), BASE, QUOTE)).toEqual(['a3'])
    })

    test('skips orders whose selling/buying don\'t mirror the taker', () => {
        const orders = [
            {id: 'x', status: 'ACTIVE', selling: 'OTHER', buying: QUOTE, price: raw('1.10').toString()},
            ask('a-good', '1.15')
        ]
        expect(pickCrossingOrderIds(orders, 'buy', raw('1.20'), BASE, QUOTE)).toEqual(['a-good'])
    })

    test('drops zero / negative / unparseable prices', () => {
        const orders = [
            {id: 'zero', status: 'ACTIVE', selling: BASE, buying: QUOTE, price: '0'},
            {id: 'neg', status: 'ACTIVE', selling: BASE, buying: QUOTE, price: '-100000000000000000'},
            {id: 'nan', status: 'ACTIVE', selling: BASE, buying: QUOTE, price: 'not-a-number'},
            ask('ok', '1.10')
        ]
        expect(pickCrossingOrderIds(orders, 'buy', raw('1.20'), BASE, QUOTE)).toEqual(['ok'])
    })

    test('caps result at MAX_CROSS_IDS', () => {
        const orders = []
        for (let i = 0; i < MAX_CROSS_IDS + 5; i++)
            orders.push(ask(`a-${i}`, `1.${String(i).padStart(3, '0')}`))
        const result = pickCrossingOrderIds(orders, 'buy', raw('5.0'), BASE, QUOTE)
        expect(result.length).toBe(MAX_CROSS_IDS)
        //cheapest-first sort guarantees a-0 is first
        expect(result[0]).toBe('a-0')
    })

    test('a very high limit grabs all asks (cheapest first)', () => {
        const orders = [ask('a1', '1.1'), ask('a2', '5'), ask('a3', '100')]
        expect(pickCrossingOrderIds(orders, 'buy', raw('1000000'), BASE, QUOTE))
            .toEqual(['a1', 'a2', 'a3'])
    })

    test('0 as limit price grabs all bids (market sell semantics)', () => {
        const orders = [bid('b1', '1.1'), bid('b2', '5'), bid('b3', '100')]
        expect(pickCrossingOrderIds(orders, 'sell', 0n, BASE, QUOTE))
            .toEqual(['b3', 'b2', 'b1'])
    })
})
