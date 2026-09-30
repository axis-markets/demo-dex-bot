const TradingBot = require('../src/trading-bot.js')

const BASE = 'BASE_CONTRACT'
const QUOTE = 'QUOTE_CONTRACT'

const OrderKind = {Limit: 1, Fill: 2, FillOrKill: 3}

const baseConfig = {
    decimals: 7,
    priceStddev: 0.02,
    amountMin: 0.01,
    amountMax: 0.2,
    maxPositions: 15,
    tradeMin: 180,
    tradeMax: 300,
    //BASE priced 1.2, QUOTE priced 1.0 → cross reference price 1.2 (quote per base)
    tokens: [
        {token: BASE, symbol: 'BASE', price: 1.2},
        {token: QUOTE, symbol: 'QUOTE', price: 1.0}
    ]
}

//With a 2-token array, sampleTwo draws two randoms: i = floor(r1*2), then j over
//[0..0] bumped past i. r=0.1 → i=0, j=1 → [BASE, QUOTE]; subsequent randoms drive
//side/price/amount. These helpers make the pair + side deterministic in tests.
function randoms(...seq) {
    const spy = jest.spyOn(Math, 'random')
    for (const v of seq) spy.mockReturnValueOnce(v)
    spy.mockReturnValue(seq.length ? seq[seq.length - 1] : 0.5)
    return spy
}
//pair = [BASE, QUOTE]; then `sideSeed` selects the side (<0.5 buy, else sell)
function pairBaseQuote(sideSeed) {
    return randoms(0.1, 0.1, sideSeed, 0.5)
}

/** AxisAccount double: trading calls and the open orders in memory */
function makeAccountMock(open = []) {
    return {
        open,
        buy: jest.fn(async () => ({sold: 0n, bought: 0n, orderId: '42'})),
        sell: jest.fn(async () => ({sold: 0n, bought: 0n, orderId: '43'})),
        cancel: jest.fn(async () => undefined),
        getOrders: jest.fn(function () {
            return this.open
        })
    }
}

function makeAxisMock() {
    const market = {requote: jest.fn(async () => undefined)}
    return {
        market,
        getMarket: jest.fn(() => market)
    }
}

function makeBot(overrides = {}) {
    const account = overrides.account ?? makeAccountMock()
    const axis = overrides.axis ?? makeAxisMock()
    const config = {...baseConfig, ...(overrides.config ?? {})}
    const bot = new TradingBot({axis, account, OrderKind, config})
    return {bot, account, axis, config}
}

describe('TradingBot.tradeOnce', () => {
    afterEach(() => jest.restoreAllMocks())

    test('buy: routes quote→base with base amount and contract-scale price', async () => {
        const {bot, account} = makeBot()
        jest.spyOn(Math, 'random').mockReturnValue(0.1) //side='buy', stable randomness

        await bot.tradeOnce()

        expect(account.buy).toHaveBeenCalledTimes(1)
        expect(account.sell).not.toHaveBeenCalled()
        const params = account.buy.mock.calls[0][0]
        expect(params.selling).toBe(QUOTE)
        expect(params.buying).toBe(BASE)
        expect(params.kind).toBe(OrderKind.Limit)
        expect(typeof params.amount).toBe('bigint')
        expect(typeof params.price).toBe('bigint')
        //price ≈ 1.2 × 10^18, with some noise — must stay within a reasonable band
        const ratio = Number(params.price) / 1e18
        expect(ratio).toBeGreaterThan(0.8)
        expect(ratio).toBeLessThan(1.6)
        //amount = uniform(0.01..0.2) USD / base price (1.2) → base-token units × 10^7
        const amountHuman = Number(params.amount) / 1e7
        expect(amountHuman).toBeGreaterThanOrEqual(0.01 / 1.2)
        expect(amountHuman).toBeLessThanOrEqual(0.2 / 1.2)
        //crossing orders and approvals are the account's job
        expect(params.orders).toBeUndefined()
        expect(params.approve).toBeUndefined()
    })

    test('sell: routes base→quote', async () => {
        const {bot, account} = makeBot()
        pairBaseQuote(0.9) //pair [BASE, QUOTE], side='sell'

        await bot.tradeOnce()

        expect(account.sell).toHaveBeenCalledTimes(1)
        expect(account.buy).not.toHaveBeenCalled()
        const params = account.sell.mock.calls[0][0]
        expect(params.selling).toBe(BASE)
        expect(params.buying).toBe(QUOTE)
    })

    test('requotes the market when the cached oracle price is missing (722) and retries the trade', async () => {
        const error = Object.assign(new Error('Contract execution error: #722 AssetPriceOracleFetchFailed'), {code: 722})
        const {bot, account, axis} = makeBot()
        account.buy.mockRejectedValueOnce(error)
        pairBaseQuote(0.0) //buy BASE
        await bot.tradeOnce()
        expect(axis.getMarket).toHaveBeenCalledWith(QUOTE, BASE)
        expect(axis.market.requote).toHaveBeenCalledTimes(1)
        expect(account.buy).toHaveBeenCalledTimes(2)
        expect(account.buy.mock.calls[1][0]).toBe(account.buy.mock.calls[0][0])
        expect(bot.unpriced.size).toBe(0)
    })

    test('pauses a market the requote could not price, then trades it again after the cooldown', async () => {
        const error = Object.assign(new Error('#722'), {code: 722})
        const {bot, account} = makeBot()
        account.buy.mockRejectedValueOnce(error).mockRejectedValueOnce(error)
        jest.spyOn(Math, 'random').mockReturnValue(0.1) //always [BASE, QUOTE], buy
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)

        await expect(bot.tradeOnce()).rejects.toBe(error)
        expect(account.buy).toHaveBeenCalledTimes(2)
        //the only market is paused: the tick is skipped without trading
        await bot.tradeOnce()
        expect(account.buy).toHaveBeenCalledTimes(2)

        now.mockReturnValue(1_000_000 + 5 * 60_000)
        await bot.tradeOnce()
        expect(account.buy).toHaveBeenCalledTimes(3)
    })

    test('does not requote on other contract errors', async () => {
        const {bot, account, axis} = makeBot()
        account.buy.mockRejectedValue(Object.assign(new Error('x'), {code: 703}))
        pairBaseQuote(0.0)
        await expect(bot.tradeOnce()).rejects.toThrow('x')
        expect(axis.market.requote).not.toHaveBeenCalled()
    })

    test('propagates trading failures so runTradeTick can log + reschedule', async () => {
        const {bot, account} = makeBot()
        account.buy.mockRejectedValue(new Error('contract failed'))
        jest.spyOn(Math, 'random').mockReturnValue(0.1)
        await expect(bot.tradeOnce()).rejects.toThrow('contract failed')
    })
})

describe('TradingBot.enforceMaxPositions', () => {
    //open orders as the account lists them: newest first
    const orders = ids => ids.map(id => ({id}))

    test('does nothing when the open count ≤ maxPositions', async () => {
        const {bot, account} = makeBot({config: {maxPositions: 3}, account: makeAccountMock(orders(['2', '1']))})
        await bot.enforceMaxPositions()
        expect(account.cancel).not.toHaveBeenCalled()
    })

    test('cancels the oldest orders beyond the cap', async () => {
        const {bot, account} = makeBot({config: {maxPositions: 2}, account: makeAccountMock(orders(['40', '10', '30', '20']))})
        await bot.enforceMaxPositions()
        expect(account.cancel).toHaveBeenCalledTimes(1)
        expect(account.cancel.mock.calls[0][0]).toEqual(['30', '20'])
    })
})

describe('TradingBot lifecycle', () => {
    test('stop() prevents any further scheduling', () => {
        const {bot} = makeBot()
        bot.start()
        bot.stop()
        //after stop, scheduling helpers must no-op even if called directly
        bot.scheduleTrade(0)
        expect(bot.tradeTimer).toBeNull()
    })
})
