const TradingBot = require('../src/trading-bot.js')

const BASE = 'BASE_CONTRACT'
const QUOTE = 'QUOTE_CONTRACT'
const OTHER = 'OTHER_CONTRACT'

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

/**
 * AxisAccount double: trading calls, the open orders and the backing in memory
 * @param {Array} [open] - open orders, newest first
 * @param {Object<string, Object>} [backing] - getAllowance() overrides by token (every token is tradable by default)
 */
function makeAccountMock(open = [], backing = {}) {
    return {
        open,
        buy: jest.fn(async () => ({sold: 0n, bought: 0n, orderId: '42'})),
        sell: jest.fn(async () => ({sold: 0n, bought: 0n, orderId: '43'})),
        cancel: jest.fn(async () => undefined),
        getOrders: jest.fn(function () {
            return this.open
        }),
        getAllowance: jest.fn(asset => ({asset, known: true, authorized: true, balance: 10n, committed: 0n, ...backing[asset]}))
    }
}

function makeAxisMock() {
    const market = {requote: jest.fn(async () => undefined)}
    return {
        market,
        getMarket: jest.fn(() => market)
    }
}

function makeTrader(i, account = makeAccountMock()) {
    return {label: `trader ${i + 1}`, account, signer: {publicKey: `G_TRADER_${i + 1}`, signTransaction: jest.fn()}}
}

function makeBot(overrides = {}) {
    const accounts = overrides.accounts ?? [overrides.account ?? makeAccountMock()]
    const traders = accounts.map((account, i) => makeTrader(i, account))
    const axis = overrides.axis ?? makeAxisMock()
    const config = {...baseConfig, ...(overrides.config ?? {})}
    const bot = new TradingBot({axis, traders, OrderKind, config})
    return {bot, traders, trader: traders[0], account: accounts[0], axis, config}
}

/** Promise with its resolve/reject exposed */
function deferred() {
    let resolve, reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return {promise, resolve, reject}
}

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('TradingBot.tradeOnce', () => {
    test('buy: routes quote→base with base amount and contract-scale price', async () => {
        const {bot, trader, account} = makeBot()
        jest.spyOn(Math, 'random').mockReturnValue(0.1) //side='buy', stable randomness

        await bot.tradeOnce(trader)

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
        const {bot, trader, account} = makeBot()
        pairBaseQuote(0.9) //pair [BASE, QUOTE], side='sell'

        await bot.tradeOnce(trader)

        expect(account.sell).toHaveBeenCalledTimes(1)
        expect(account.buy).not.toHaveBeenCalled()
        const params = account.sell.mock.calls[0][0]
        expect(params.selling).toBe(BASE)
        expect(params.buying).toBe(QUOTE)
    })

    test('requotes the market with the trader signer when the cached oracle price is missing (722) and retries', async () => {
        const error = Object.assign(new Error('Contract execution error: #722 AssetPriceOracleFetchFailed'), {code: 722})
        const {bot, trader, account, axis} = makeBot()
        account.buy.mockRejectedValueOnce(error)
        pairBaseQuote(0.0) //buy BASE
        await bot.tradeOnce(trader)
        expect(axis.getMarket).toHaveBeenCalledWith(BASE, QUOTE)
        expect(axis.market.requote).toHaveBeenCalledTimes(1)
        expect(axis.market.requote).toHaveBeenCalledWith(trader.signer)
        expect(account.buy).toHaveBeenCalledTimes(2)
        expect(account.buy.mock.calls[1][0]).toBe(account.buy.mock.calls[0][0])
        expect(bot.unpriced.size).toBe(0)
        expect(bot.requotes.size).toBe(0)
    })

    test('pauses a market the requote could not price, then trades it again after the cooldown', async () => {
        const error = Object.assign(new Error('#722'), {code: 722})
        const {bot, trader, account} = makeBot()
        account.buy.mockRejectedValueOnce(error).mockRejectedValueOnce(error)
        jest.spyOn(Math, 'random').mockReturnValue(0.1) //always [BASE, QUOTE], buy
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)

        await expect(bot.tradeOnce(trader)).rejects.toBe(error)
        expect(account.buy).toHaveBeenCalledTimes(2)
        //the only market is paused: the tick is skipped without trading
        await bot.tradeOnce(trader)
        expect(account.buy).toHaveBeenCalledTimes(2)

        now.mockReturnValue(1_000_000 + 5 * 60_000)
        await bot.tradeOnce(trader)
        expect(account.buy).toHaveBeenCalledTimes(3)
    })

    test('does not requote on other contract errors', async () => {
        const {bot, trader, account, axis} = makeBot()
        account.buy.mockRejectedValue(Object.assign(new Error('x'), {code: 703}))
        pairBaseQuote(0.0)
        await expect(bot.tradeOnce(trader)).rejects.toThrow('x')
        expect(axis.market.requote).not.toHaveBeenCalled()
    })

    test('propagates trading failures so runTradeTick can log + reschedule', async () => {
        const {bot, trader, account} = makeBot()
        account.buy.mockRejectedValue(new Error('contract failed'))
        jest.spyOn(Math, 'random').mockReturnValue(0.1)
        await expect(bot.tradeOnce(trader)).rejects.toThrow('contract failed')
    })
})

describe('TradingBot tradable tokens', () => {
    const config = {tokens: [...baseConfig.tokens, {token: OTHER, symbol: 'OTHER', price: 0.5}]}

    test.each([
        ['no trustline', {authorized: false, balance: 0n}],
        ['a deauthorized trustline', {authorized: false, balance: 10n}],
        ['a zero balance', {balance: 0n}],
        ['unknown backing', {known: false, balance: undefined}]
    ])('leaves out a token with %s', async (_, backing) => {
        const {bot, trader, account} = makeBot({config, account: makeAccountMock([], {[OTHER]: backing})})
        expect(bot.tradableTokens(trader).map(t => t.token)).toEqual([BASE, QUOTE])
        for (let i = 0; i < 20; i++) {
            await bot.tradeOnce(trader)
        }
        const calls = [...account.buy.mock.calls, ...account.sell.mock.calls].map(([p]) => p)
        expect(calls).toHaveLength(20)
        for (const {selling, buying} of calls) {
            expect(selling).not.toBe(OTHER)
            expect(buying).not.toBe(OTHER)
        }
    })

    test('skips the trader with fewer than 2 tradable tokens', async () => {
        const account = makeAccountMock([], {[QUOTE]: {authorized: false, balance: 0n}})
        const {bot, trader} = makeBot({account})
        await bot.tradeOnce(trader)
        expect(account.buy).not.toHaveBeenCalled()
        expect(account.sell).not.toHaveBeenCalled()
        expect(account.cancel).not.toHaveBeenCalled()
    })

    test('each trader trades only its own tokens', async () => {
        const accounts = [
            makeAccountMock([], {[OTHER]: {authorized: false, balance: 0n}}),
            makeAccountMock([], {[BASE]: {balance: 0n}})
        ]
        const {bot, traders} = makeBot({config, accounts})
        expect(bot.tradableTokens(traders[0]).map(t => t.symbol)).toEqual(['BASE', 'QUOTE'])
        expect(bot.tradableTokens(traders[1]).map(t => t.symbol)).toEqual(['QUOTE', 'OTHER'])
    })
})

describe('TradingBot.runTradeTick', () => {
    test('trades with every trader in parallel, then reschedules once', async () => {
        const accounts = [makeAccountMock(), makeAccountMock(), makeAccountMock()]
        const pending = accounts.map(account => {
            const d = deferred()
            account.buy.mockReturnValueOnce(d.promise)
            account.sell.mockReturnValueOnce(d.promise)
            return d
        })
        const {bot} = makeBot({accounts})
        const schedule = jest.spyOn(bot, 'scheduleTrade').mockImplementation(() => {})

        const tick = bot.runTradeTick()
        await new Promise(resolve => setImmediate(resolve))
        //every trade started before any of them completed
        for (const account of accounts) {
            expect(account.buy.mock.calls.length + account.sell.mock.calls.length).toBe(1)
        }
        expect(schedule).not.toHaveBeenCalled()

        pending[0].resolve({sold: 0n, bought: 0n})
        pending[1].reject(new Error('trader 2 failed'))
        await new Promise(resolve => setImmediate(resolve))
        expect(schedule).not.toHaveBeenCalled()

        pending[2].resolve({sold: 0n, bought: 0n})
        await tick
        expect(schedule).toHaveBeenCalledTimes(1)
        expect(console.error).toHaveBeenCalledWith('[trader 2] trade failed:', 'trader 2 failed')
        //the failure did not prevent the others from finishing their trade
        expect(accounts[0].getOrders).toHaveBeenCalled()
        expect(accounts[2].getOrders).toHaveBeenCalled()
        expect(accounts[1].getOrders).not.toHaveBeenCalled()
    })

    test('traders hitting 722 on the same market share one requote', async () => {
        const error = Object.assign(new Error('#722'), {code: 722})
        const accounts = [makeAccountMock(), makeAccountMock()]
        for (const account of accounts) {
            account.buy.mockRejectedValueOnce(error)
        }
        const {bot, axis} = makeBot({accounts})
        jest.spyOn(bot, 'scheduleTrade').mockImplementation(() => {})
        jest.spyOn(Math, 'random').mockReturnValue(0.1) //[BASE, QUOTE], buy

        await bot.runTradeTick()

        expect(axis.market.requote).toHaveBeenCalledTimes(1)
        for (const account of accounts) {
            expect(account.buy).toHaveBeenCalledTimes(2)
        }
        expect(bot.requotes.size).toBe(0)
    })

    test('does nothing once stopped', async () => {
        const {bot, account} = makeBot()
        const schedule = jest.spyOn(bot, 'scheduleTrade')
        bot.stop()
        await bot.runTradeTick()
        expect(account.buy).not.toHaveBeenCalled()
        expect(schedule).not.toHaveBeenCalled()
    })
})

describe('TradingBot.enforceMaxPositions', () => {
    //open orders as the account lists them: newest first
    const orders = ids => ids.map(id => ({id}))

    test('does nothing when the open count ≤ maxPositions', async () => {
        const {bot, trader, account} = makeBot({config: {maxPositions: 3}, account: makeAccountMock(orders(['2', '1']))})
        await bot.enforceMaxPositions(trader)
        expect(account.cancel).not.toHaveBeenCalled()
    })

    test('cancels the oldest orders beyond the cap', async () => {
        const {bot, trader, account} = makeBot({config: {maxPositions: 2}, account: makeAccountMock(orders(['40', '10', '30', '20']))})
        await bot.enforceMaxPositions(trader)
        expect(account.cancel).toHaveBeenCalledTimes(1)
        expect(account.cancel.mock.calls[0][0]).toEqual(['30', '20'])
    })

    test('applies the cap to each trader separately', async () => {
        const accounts = [makeAccountMock(orders(['2', '1'])), makeAccountMock(orders(['6', '5', '4']))]
        const {bot, traders} = makeBot({config: {maxPositions: 2}, accounts})
        for (const trader of traders) {
            await bot.enforceMaxPositions(trader)
        }
        expect(accounts[0].cancel).not.toHaveBeenCalled()
        expect(accounts[1].cancel).toHaveBeenCalledWith(['4'])
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
