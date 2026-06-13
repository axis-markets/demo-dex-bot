const {pickCrossingOrderIds, MAX_CROSS_IDS} = require('../src/orderbook-utils.js')

const BASE = 'BASE_CONTRACT'
const QUOTE = 'QUOTE_CONTRACT'

function ask(id, price, status = 'ACTIVE') {
    //ask sells BASE for QUOTE → rprice is already quote-per-base (== price)
    return {id, status, selling: BASE, buying: QUOTE, rprice: price}
}
function bid(id, price, status = 'ACTIVE') {
    //bid sells QUOTE for BASE → rprice is base-per-quote (the inverse of price)
    return {id, status, selling: QUOTE, buying: BASE, rprice: 1 / price}
}

describe('pickCrossingOrderIds', () => {
    test('returns [] for empty / null input', () => {
        expect(pickCrossingOrderIds([], 'buy', 1.2, BASE, QUOTE)).toEqual([])
        expect(pickCrossingOrderIds(null, 'buy', 1.2, BASE, QUOTE)).toEqual([])
        expect(pickCrossingOrderIds(undefined, 'sell', 1.2, BASE, QUOTE)).toEqual([])
    })

    test('BUY matches asks with rprice ≤ limit, cheapest first', () => {
        const orders = [
            ask('a-high', 1.30),
            ask('a-mid', 1.20),
            ask('a-low', 1.15),
            ask('a-mid2', 1.18),
            bid('b-irrelevant', 1.10)
        ]
        expect(pickCrossingOrderIds(orders, 'buy', 1.20, BASE, QUOTE))
            .toEqual(['a-low', 'a-mid2', 'a-mid'])
    })

    test('SELL matches bids with price ≥ limit, highest first', () => {
        const orders = [
            bid('b-low', 1.15),
            bid('b-high', 1.30),
            bid('b-mid', 1.25),
            ask('a-irrelevant', 1.40)
        ]
        expect(pickCrossingOrderIds(orders, 'sell', 1.20, BASE, QUOTE))
            .toEqual(['b-high', 'b-mid'])
    })

    test('skips non-ACTIVE orders', () => {
        const orders = [
            ask('a1', 1.10, 'FILLED'),
            ask('a2', 1.15, 'CANCELED'),
            ask('a3', 1.18, 'ACTIVE')
        ]
        expect(pickCrossingOrderIds(orders, 'buy', 1.20, BASE, QUOTE)).toEqual(['a3'])
    })

    test('skips orders whose selling/buying don\'t match the pair', () => {
        const orders = [
            {id: 'x', status: 'ACTIVE', selling: 'OTHER', buying: QUOTE, rprice: 1.10},
            ask('a-good', 1.15)
        ]
        expect(pickCrossingOrderIds(orders, 'buy', 1.20, BASE, QUOTE)).toEqual(['a-good'])
    })

    test('drops zero / negative prices', () => {
        const orders = [
            ask('zero', 0),
            ask('neg', -0.1),
            ask('ok', 1.10)
        ]
        expect(pickCrossingOrderIds(orders, 'buy', 1.20, BASE, QUOTE)).toEqual(['ok'])
    })

    test('caps result at MAX_CROSS_IDS', () => {
        const orders = []
        for (let i = 0; i < MAX_CROSS_IDS + 5; i++)
            orders.push(ask(`a-${i}`, 1.0 + i * 0.001))
        const result = pickCrossingOrderIds(orders, 'buy', 5.0, BASE, QUOTE)
        expect(result.length).toBe(MAX_CROSS_IDS)
        //cheapest-first sort guarantees a-0 is first
        expect(result[0]).toBe('a-0')
    })

    test('Infinity as limit price grabs all asks (market buy semantics)', () => {
        const orders = [ask('a1', 1.1), ask('a2', 5), ask('a3', 100)]
        expect(pickCrossingOrderIds(orders, 'buy', Number.POSITIVE_INFINITY, BASE, QUOTE))
            .toEqual(['a1', 'a2', 'a3'])
    })

    test('0 as limit price grabs all bids (market sell semantics)', () => {
        const orders = [bid('b1', 1.1), bid('b2', 5), bid('b3', 100)]
        expect(pickCrossingOrderIds(orders, 'sell', 0, BASE, QUOTE))
            .toEqual(['b3', 'b2', 'b1'])
    })
})
