//Stub out config.js so indexer-client can require it without TRADER_SECRET.
jest.mock('../src/config.js', () => ({indexerUrl: 'http://test.local'}), {virtual: false})

const {getOrders, getOrdersPaginated} = require('../src/indexer-client.js')

describe('getOrders', () => {
    afterEach(() => { delete global.fetch })

    test('builds query string from params and returns parsed JSON', async () => {
        let receivedUrl
        global.fetch = jest.fn(async (url) => {
            receivedUrl = url
            return {ok: true, status: 200, json: async () => [{id: '1'}]}
        })
        const result = await getOrders({owner: 'G123', limit: 10})
        expect(result).toEqual([{id: '1'}])
        expect(receivedUrl.toString()).toBe('http://test.local/order?owner=G123&limit=10')
    })

    test('appends array params as repeated keys', async () => {
        let receivedUrl
        global.fetch = jest.fn(async (url) => {
            receivedUrl = url
            return {ok: true, status: 200, json: async () => [] }
        })
        await getOrders({asset: ['A', 'B']})
        expect(receivedUrl.search).toBe('?asset=A&asset=B')
    })

    test('throws with status + body on non-OK response', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 500,
            statusText: 'Server Error',
            text: async () => 'boom'
        }))
        await expect(getOrders({})).rejects.toThrow(/Indexer 500.*boom/)
    })

    test('skips null/undefined params', async () => {
        let receivedUrl
        global.fetch = jest.fn(async (url) => {
            receivedUrl = url
            return {ok: true, status: 200, json: async () => []}
        })
        await getOrders({owner: undefined, limit: null, cursor: 'c1'})
        expect(receivedUrl.search).toBe('?cursor=c1')
    })
})

describe('getOrdersPaginated', () => {
    afterEach(() => { delete global.fetch })

    test('stops when a short page is returned', async () => {
        const pages = [
            Array.from({length: 200}, (_, i) => ({id: String(i), cursor: `c${i}`})),
            Array.from({length: 50}, (_, i) => ({id: String(200 + i), cursor: `c${200 + i}`}))
        ]
        const calls = []
        global.fetch = jest.fn(async (url) => {
            calls.push(url.toString())
            return {ok: true, status: 200, json: async () => pages.shift() ?? []}
        })
        const out = await getOrdersPaginated({asset: ['A', 'B'], maxTotal: 1000})
        expect(out.length).toBe(250)
        expect(calls.length).toBe(2)
        //second call must carry the cursor from the last item of page 1
        expect(calls[1]).toContain('cursor=c199')
    })

    test('stops at maxTotal (mocks honor limit param)', async () => {
        global.fetch = jest.fn(async (url) => {
            const limit = Number(url.searchParams.get('limit'))
            const cursor = Number(url.searchParams.get('cursor') ?? '-1')
            const start = cursor + 1
            const page = Array.from({length: limit}, (_, i) => ({id: String(start + i), cursor: String(start + i)}))
            return {ok: true, status: 200, json: async () => page}
        })
        const out = await getOrdersPaginated({maxTotal: 350})
        expect(out.length).toBe(350)
    })

    test('returns [] when first page is empty', async () => {
        global.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => []}))
        const out = await getOrdersPaginated({})
        expect(out).toEqual([])
    })
})
