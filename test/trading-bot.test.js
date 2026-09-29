//Mock config and indexer-client BEFORE requiring trading-bot.
jest.mock('../src/config.js', () => ({indexerUrl: 'http://test.local'}), {virtual: false})
jest.mock('../src/indexer-client.js', () => ({
    getOrders: jest.fn(),
    getOrdersPaginated: jest.fn()
}))

const {getOrdersPaginated} = require('../src/indexer-client.js')
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

function makeAxisMock() {
    return {
        buy: jest.fn(async () => [0n, 0n, 42n]),
        sell: jest.fn(async () => [0n, 0n, 43n]),
        cancel: jest.fn(async () => undefined)
    }
}

const LEDGER = 1000

function makeTokenStateMock(allowance = 10n ** 30n) {
    return {
        getAllowance: jest.fn(async () => allowance),
        getLatestLedger: jest.fn(async () => LEDGER)
    }
}

function makeBot(overrides = {}) {
    const axis = overrides.axis ?? makeAxisMock()
    const tokenState = overrides.tokenState ?? makeTokenStateMock()
    const config = {...baseConfig, ...(overrides.config ?? {})}
    const bot = new TradingBot({
        axis,
        OrderKind,
        trader: 'GBOT',
        config,
        tokenState
    })
    return {bot, axis, config, tokenState}
}

/**
 * Build a getOrdersPaginated mock that branches on the `owner` arg:
 *   - presence of `owner` → own orders (the selling-asset lookup of tradeOnce and enforceMaxPositions)
 *   - absence of `owner`  → pair-wide orderbook (used by tradeOnce)
 */
function mockIndexer({book = [], own = []} = {}) {
    getOrdersPaginated.mockImplementation(async (opts) => opts?.owner ? own : book)
}

describe('TradingBot.tradeOnce', () => {
    beforeEach(() => { getOrdersPaginated.mockReset() })
    afterEach(() => jest.restoreAllMocks())

    test('buy: payload routes quote→base with base amount and contract-scale price', async () => {
        const {bot, axis} = makeBot()
        jest.spyOn(Math, 'random').mockReturnValue(0.1) //side='buy', stable randomness
        mockIndexer({book: [], own: []})

        await bot.tradeOnce()

        expect(axis.buy).toHaveBeenCalledTimes(1)
        expect(axis.sell).not.toHaveBeenCalled()
        const payload = axis.buy.mock.calls[0][0]
        expect(payload.selling).toBe(QUOTE)
        expect(payload.buying).toBe(BASE)
        expect(payload.kind).toBe(OrderKind.Limit)
        expect(payload.trader).toBe('GBOT')
        expect(typeof payload.amount).toBe('bigint')
        expect(typeof payload.price).toBe('bigint')
        //price ≈ 1.2 × 10^18, with some noise — must stay within a reasonable band
        const ratio = Number(payload.price) / 1e18
        expect(ratio).toBeGreaterThan(0.8)
        expect(ratio).toBeLessThan(1.6)
        //amount = uniform(0.01..0.2) USD / base price (1.2) → base-token units × 10^7
        const amountHuman = Number(payload.amount) / 1e7
        expect(amountHuman).toBeGreaterThanOrEqual(0.01 / 1.2)
        expect(amountHuman).toBeLessThanOrEqual(0.2 / 1.2)
        //empty book → no crossings
        expect(payload.orders).toEqual([])
    })

    test('sell: payload routes base→quote', async () => {
        const {bot, axis} = makeBot()
        pairBaseQuote(0.9) //pair [BASE, QUOTE], side='sell'
        mockIndexer({book: [], own: []})

        await bot.tradeOnce()

        expect(axis.sell).toHaveBeenCalledTimes(1)
        expect(axis.buy).not.toHaveBeenCalled()
        const payload = axis.sell.mock.calls[0][0]
        expect(payload.selling).toBe(BASE)
        expect(payload.buying).toBe(QUOTE)
    })

    test('fetches orderbook fresh on every trade (no internal polling state)', async () => {
        const {bot} = makeBot()
        jest.spyOn(Math, 'random').mockReturnValue(0.1)
        mockIndexer({book: [], own: []})

        await bot.tradeOnce()
        //3 calls: the book (no owner), own orders selling the traded asset, own orders for the position cap
        expect(getOrdersPaginated).toHaveBeenCalledTimes(3)
        const calls = getOrdersPaginated.mock.calls.map(c => c[0])
        expect(calls.some(c => !c.owner)).toBe(true)
        expect(calls.some(c => c.owner === 'GBOT' && c.asset === QUOTE)).toBe(true)
        expect(calls.some(c => c.owner === 'GBOT' && c.asset === undefined)).toBe(true)
    })

    test('no approval when the current allowance covers the trade and resting orders', async () => {
        const {bot, axis, tokenState} = makeBot()
        pairBaseQuote(0.9) //sell BASE
        mockIndexer({book: [], own: []})

        await bot.tradeOnce()
        expect(tokenState.getAllowance).toHaveBeenCalledWith(BASE, 'GBOT')
        expect(axis.sell.mock.calls[0][0].approve).toBeUndefined()
    })

    test('sell: approves the amount plus resting orders selling the same asset', async () => {
        const {bot, axis} = makeBot({tokenState: makeTokenStateMock(0n)})
        pairBaseQuote(0.9) //sell BASE
        mockIndexer({
            book: [],
            own: [
                {id: '1', status: 'ACTIVE', selling: BASE, buying: QUOTE, amount: '5000000', cursor: '1'},
                {id: '2', status: 'ACTIVE', selling: QUOTE, buying: BASE, amount: '7000000', cursor: '2'} //other asset
            ]
        })

        await bot.tradeOnce()
        const payload = axis.sell.mock.calls[0][0]
        expect(payload.approve).toEqual({amount: payload.amount + 5000000n, liveUntil: LEDGER + 518400})
    })

    test('counts its own orders the indexer does not report yet in the next approval', async () => {
        const axis = makeAxisMock()
        axis.sell.mockImplementation(async p => [0n, 0n, 43n]) //nothing crossed, the whole amount rests
        const {bot} = makeBot({axis, tokenState: makeTokenStateMock(0n)})
        jest.spyOn(Math, 'random').mockReturnValue(0.9) //same pair and a sell every tick
        const own = []
        mockIndexer({book: [], own})

        await bot.tradeOnce()
        const first = axis.sell.mock.calls[0][0]
        //indexer lags: the first order is not listed yet
        await bot.tradeOnce()
        const second = axis.sell.mock.calls[1][0]
        expect(second.approve.amount).toBe(second.amount + first.amount)

        //once listed it is counted once, from the indexer
        own.push({id: '43', status: 'ACTIVE', selling: first.selling, buying: first.buying, amount: first.amount.toString(), cursor: '1'})
        await bot.tradeOnce()
        const third = axis.sell.mock.calls[2][0]
        //order 43 (listed) + the unlisted second order, which reused the same mocked id and was dropped with it
        expect(third.approve.amount).toBe(third.amount + first.amount)
    })

    test('forgets unlisted orders after the TTL', async () => {
        const axis = makeAxisMock()
        const {bot} = makeBot({axis, tokenState: makeTokenStateMock(0n)})
        jest.spyOn(Math, 'random').mockReturnValue(0.9)
        mockIndexer({book: [], own: []})
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
        await bot.tradeOnce()
        now.mockReturnValue(1_000_000 + 2 * 60_000 + 1)
        await bot.tradeOnce()
        const second = axis.sell.mock.calls[1][0]
        expect(second.approve.amount).toBe(second.amount)
    })

    test('buy: approves the ceiled quote cost at the limit price', async () => {
        const {bot, axis} = makeBot({tokenState: makeTokenStateMock(0n)})
        pairBaseQuote(0.0) //buy BASE, sells QUOTE
        mockIndexer({book: [], own: []})

        await bot.tradeOnce()
        const payload = axis.buy.mock.calls[0][0]
        const precision = 10n ** 18n
        const cost = (payload.amount * payload.price + precision - 1n) / precision
        expect(payload.approve.amount).toBe(cost)
    })

    test('requotes the market when the cached oracle price is missing (722) and retries the trade', async () => {
        const error = Object.assign(new Error('Contract execution error: #722 AssetPriceOracleFetchFailed'), {code: 722})
        const axis = {...makeAxisMock(), requote: jest.fn(async () => undefined)}
        axis.buy.mockRejectedValueOnce(error)
        const {bot} = makeBot({axis})
        pairBaseQuote(0.0) //buy BASE
        mockIndexer({book: [], own: []})
        await bot.tradeOnce()
        expect(axis.requote).toHaveBeenCalledWith(QUOTE, BASE)
        expect(axis.buy).toHaveBeenCalledTimes(2)
        expect(axis.buy.mock.calls[1][0]).toBe(axis.buy.mock.calls[0][0])
        expect(bot.unpriced.size).toBe(0)
    })

    test('pauses a market the requote could not price, then trades it again after the cooldown', async () => {
        const error = Object.assign(new Error('#722'), {code: 722})
        const axis = {...makeAxisMock(), requote: jest.fn(async () => undefined)}
        axis.buy.mockRejectedValueOnce(error).mockRejectedValueOnce(error)
        const {bot} = makeBot({axis})
        jest.spyOn(Math, 'random').mockReturnValue(0.1) //always [BASE, QUOTE], buy
        mockIndexer({book: [], own: []})
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)

        await expect(bot.tradeOnce()).rejects.toBe(error)
        expect(axis.buy).toHaveBeenCalledTimes(2)
        //the only market is paused: the tick is skipped without trading
        await bot.tradeOnce()
        expect(axis.buy).toHaveBeenCalledTimes(2)

        now.mockReturnValue(1_000_000 + 5 * 60_000)
        await bot.tradeOnce()
        expect(axis.buy).toHaveBeenCalledTimes(3)
    })

    test('does not requote on other contract errors', async () => {
        const axis = {...makeAxisMock(), buy: jest.fn(async () => { throw Object.assign(new Error('x'), {code: 703}) }), requote: jest.fn()}
        const {bot} = makeBot({axis})
        pairBaseQuote(0.0)
        mockIndexer({book: [], own: []})
        await expect(bot.tradeOnce()).rejects.toThrow('x')
        expect(axis.requote).not.toHaveBeenCalled()
    })

    test('propagates allowance read failures', async () => {
        const tokenState = makeTokenStateMock()
        tokenState.getAllowance.mockRejectedValue(new Error('rpc down'))
        const {bot, axis} = makeBot({tokenState})
        jest.spyOn(Math, 'random').mockReturnValue(0.1)
        mockIndexer({book: [], own: []})
        await expect(bot.tradeOnce()).rejects.toThrow('rpc down')
        expect(axis.buy).not.toHaveBeenCalled()
    })

    test('passes crossing order ids derived from the fresh orderbook fetch', async () => {
        const {bot, axis} = makeBot()
        pairBaseQuote(0.0) //pair [BASE, QUOTE], side='buy'
        //prices are raw i128 "buying per selling" (quote-per-base for asks); limit ≈ 1.17
        mockIndexer({
            book: [
                {id: 'a1', status: 'ACTIVE', selling: BASE, buying: QUOTE, price: '900000000000000000'},     //0.9 ≤ limit → cross
                {id: 'a2', status: 'ACTIVE', selling: BASE, buying: QUOTE, price: '10000000000000000000'},   //10 → too high
                {id: 'b1', status: 'ACTIVE', selling: QUOTE, buying: BASE, price: '1000000000000000000'}     //wrong side for a buy
            ],
            own: []
        })

        await bot.tradeOnce()
        const payload = axis.buy.mock.calls[0][0]
        expect(payload.orders).toContain('a1')
        expect(payload.orders).not.toContain('a2')
        expect(payload.orders).not.toContain('b1')
    })

    test('propagates contract failures so runTradeTick can log + reschedule', async () => {
        const axis = {
            buy: jest.fn(async () => { throw new Error('contract failed') }),
            sell: jest.fn(),
            cancel: jest.fn()
        }
        const {bot} = makeBot({axis})
        jest.spyOn(Math, 'random').mockReturnValue(0.1)
        mockIndexer({book: [], own: []})
        await expect(bot.tradeOnce()).rejects.toThrow('contract failed')
    })
})

describe('TradingBot.enforceMaxPositions', () => {
    beforeEach(() => { getOrdersPaginated.mockReset() })
    afterEach(() => jest.restoreAllMocks())

    test('does nothing when active count ≤ MAX_POSITIONS', async () => {
        const {bot, axis} = makeBot({config: {maxPositions: 3}})
        getOrdersPaginated.mockResolvedValue([
            {id: '1', status: 'ACTIVE', cursor: '100'},
            {id: '2', status: 'ACTIVE', cursor: '200'}
        ])
        await bot.enforceMaxPositions()
        expect(axis.cancel).not.toHaveBeenCalled()
    })

    test('cancels oldest by creation `cursor` when exceeding cap', async () => {
        const {bot, axis} = makeBot({config: {maxPositions: 2}})
        getOrdersPaginated.mockResolvedValue([
            {id: '10', status: 'ACTIVE', cursor: '300'},
            {id: '20', status: 'ACTIVE', cursor: '100'},   //oldest
            {id: '30', status: 'ACTIVE', cursor: '200'},   //2nd oldest
            {id: '40', status: 'ACTIVE', cursor: '400'}
        ])
        await bot.enforceMaxPositions()
        expect(axis.cancel).toHaveBeenCalledTimes(1)
        const [ids, trader] = axis.cancel.mock.calls[0]
        expect(ids).toEqual([20n, 30n])
        expect(trader).toBe('GBOT')
    })

    test('ignores non-ACTIVE orders when counting', async () => {
        const {bot, axis} = makeBot({config: {maxPositions: 1}})
        getOrdersPaginated.mockResolvedValue([
            {id: '1', status: 'FILLED', cursor: '50'},
            {id: '2', status: 'ACTIVE', cursor: '100'},
            {id: '3', status: 'CANCELED', cursor: '200'}
        ])
        await bot.enforceMaxPositions()
        expect(axis.cancel).not.toHaveBeenCalled()
    })

    test('orders by cursor, not by the (random u128) id, beyond 2^53', async () => {
        const {bot, axis} = makeBot({config: {maxPositions: 1}})
        getOrdersPaginated.mockResolvedValue([
            {id: '1', status: 'ACTIVE', cursor: '423766206939842805766'},
            {id: '340282366920938463463374607431768211455', status: 'ACTIVE', cursor: '423766206939842805764'}, //oldest
            {id: '2', status: 'ACTIVE', cursor: '423766206939842805765'}
        ])
        await bot.enforceMaxPositions()
        const [ids] = axis.cancel.mock.calls[0]
        expect(ids).toEqual([340282366920938463463374607431768211455n, 2n])
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
