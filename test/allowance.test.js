const {APPROVAL_TTL_LEDGERS, committedAmount, planApproval, maxQuoteSpend} = require('../src/allowance.js')

describe('committedAmount', () => {
    test('sums the remaining amount of active orders selling the asset', () => {
        const orders = [
            {status: 'ACTIVE', selling: 'A', amount: '10'},
            {status: 'ACTIVE', selling: 'A', amount: '5'},
            {status: 'ACTIVE', selling: 'B', amount: '100'},
            {status: 'FILLED', selling: 'A', amount: '0'},
            {status: 'EXPIRED', selling: 'A', amount: '7'}
        ]
        expect(committedAmount(orders, 'A')).toBe(15n)
        expect(committedAmount([], 'A')).toBe(0n)
    })
})

describe('planApproval', () => {
    test('no approval when the allowance covers the trade and resting orders', () => {
        expect(planApproval({required: 10n, committed: 5n, allowance: 15n, ledger: 1})).toBeUndefined()
    })

    test('absolute approval of trade plus resting orders when short', () => {
        expect(planApproval({required: 10n, committed: 5n, allowance: 14n, ledger: 100}))
            .toEqual({amount: 15n, liveUntil: 100 + APPROVAL_TTL_LEDGERS})
    })
})

describe('maxQuoteSpend', () => {
    test('ceils amount × price / 10^18', () => {
        expect(maxQuoteSpend(10n, 15n * 10n ** 17n)).toBe(15n)
        expect(maxQuoteSpend(3n, 5n * 10n ** 17n)).toBe(2n) //1.5 → 2
    })
})
