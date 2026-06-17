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

function makeBot(overrides = {}) {
    const axis = overrides.axis ?? makeAxisMock()
    const config = {...baseConfig, ...(overrides.config ?? {})}
    const bot = new TradingBot({
        axis,
        OrderKind,
        trader: 'GBOT',
        config
    })
    return {bot, axis, config}
}

/**
 * Build a getOrdersPaginated mock that branches on the `owner` arg:
 *   - presence of `owner` → own active orders (used by enforceMaxPositions)
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
        //amount in (0.01..0.2) × 10^7
        const amountHuman = Number(payload.amount) / 1e7
        expect(amountHuman).toBeGreaterThanOrEqual(0.01)
        expect(amountHuman).toBeLessThanOrEqual(0.2)
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
        //2 calls: one for the book (no owner), one for own orders (with owner)
        expect(getOrdersPaginated).toHaveBeenCalledTimes(2)
        const calls = getOrdersPaginated.mock.calls.map(c => c[0])
        expect(calls.some(c => !c.owner)).toBe(true)
        expect(calls.some(c => c.owner === 'GBOT')).toBe(true)
    })

    test('passes crossing order ids derived from the fresh orderbook fetch', async () => {
        const {bot, axis} = makeBot()
        pairBaseQuote(0.0) //pair [BASE, QUOTE], side='buy'
        mockIndexer({
            book: [
                {id: 'a1', status: 'ACTIVE', selling: BASE, buying: QUOTE, rprice: 0.9},
                {id: 'a2', status: 'ACTIVE', selling: BASE, buying: QUOTE, rprice: 10.0},  //too high
                {id: 'b1', status: 'ACTIVE', selling: QUOTE, buying: BASE, rprice: 1.0}    //wrong side
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
            {id: '1', status: 'ACTIVE', created: '100'},
            {id: '2', status: 'ACTIVE', created: '200'}
        ])
        await bot.enforceMaxPositions()
        expect(axis.cancel).not.toHaveBeenCalled()
    })

    test('cancels oldest by `created` when exceeding cap', async () => {
        const {bot, axis} = makeBot({config: {maxPositions: 2}})
        getOrdersPaginated.mockResolvedValue([
            {id: '10', status: 'ACTIVE', created: '300'},
            {id: '20', status: 'ACTIVE', created: '100'},   //oldest
            {id: '30', status: 'ACTIVE', created: '200'},   //2nd oldest
            {id: '40', status: 'ACTIVE', created: '400'}
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
            {id: '1', status: 'FILLED', created: '50'},
            {id: '2', status: 'ACTIVE', created: '100'},
            {id: '3', status: 'CANCELED', created: '200'}
        ])
        await bot.enforceMaxPositions()
        expect(axis.cancel).not.toHaveBeenCalled()
    })

    test('falls back to id ordering when created is missing', async () => {
        const {bot, axis} = makeBot({config: {maxPositions: 1}})
        getOrdersPaginated.mockResolvedValue([
            {id: '30', status: 'ACTIVE'},
            {id: '10', status: 'ACTIVE'},
            {id: '20', status: 'ACTIVE'}
        ])
        await bot.enforceMaxPositions()
        const [ids] = axis.cancel.mock.calls[0]
        expect(ids).toEqual([10n, 20n])  //oldest = lowest id
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
