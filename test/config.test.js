//Isolate config.js: stub dotenv (no real .env), drive fs + env per test.
let mockReadFile
jest.mock('fs', () => ({readFileSync: (...args) => mockReadFile(...args)}))
jest.mock('dotenv', () => ({config: () => ({})}))

const VALID = {
    axisContractId: 'C_AXIS',
    networkPassphrase: 'Test SDF Network ; September 2015',
    sorobanRpcUrl: 'https://rpc.example/',
    indexerUrl: 'http://indexer.example/',
    decimals: 7,
    priceStddev: 0.04,
    amountMin: 0.01,
    amountMax: 0.2,
    maxPositions: 40,
    tradeMin: 5,
    tradeMax: 10,
    tokens: [
        {token: 'C_USDC', symbol: 'USDC', price: 1},
        {token: 'C_EURC', symbol: 'EURC', price: 1.2}
    ]
}

const OLD_ENV = process.env

function load(json, {secret = 'SABC', name} = {}) {
    jest.resetModules()
    process.env = {...OLD_ENV}
    delete process.env.CONFIG_NAME
    if (secret == null) delete process.env.TRADER_SECRET
    else process.env.TRADER_SECRET = secret
    if (name) process.env.CONFIG_NAME = name
    mockReadFile = () => {
        if (json instanceof Error) throw json
        return JSON.stringify(json)
    }
    return require('../src/config.js')
}

afterAll(() => { process.env = OLD_ENV })

describe('config loader', () => {
    test('loads JSON values, exposes camelCase keys, strips trailing slashes', () => {
        const cfg = load(VALID)
        expect(cfg.configName).toBe('testnet')
        expect(cfg.traderSecret).toBe('SABC')
        expect(cfg.axisContractId).toBe('C_AXIS')
        expect(cfg.sorobanRpcUrl).toBe('https://rpc.example')
        expect(cfg.indexerUrl).toBe('http://indexer.example')
        expect(cfg.decimals).toBe(7)
        expect(cfg.priceStddev).toBe(0.04)
        expect(cfg.maxPositions).toBe(40)
        expect(cfg.tokens).toHaveLength(2)
        expect(cfg.tokens[1]).toEqual({token: 'C_EURC', symbol: 'EURC', price: 1.2})
    })

    test('selects the config file by CONFIG_NAME', () => {
        let pathArg
        jest.resetModules()
        process.env = {...OLD_ENV, TRADER_SECRET: 'SABC', CONFIG_NAME: 'mainnet'}
        mockReadFile = (p) => { pathArg = p; return JSON.stringify(VALID) }
        const cfg = require('../src/config.js')
        expect(cfg.configName).toBe('mainnet')
        expect(String(pathArg)).toContain('mainnet.config.json')
    })

    test('applies URL/passphrase defaults when absent', () => {
        const {networkPassphrase, ...rest} = VALID
        const cfg = load({...rest, sorobanRpcUrl: undefined, indexerUrl: undefined})
        expect(cfg.networkPassphrase).toBe('Test SDF Network ; September 2015')
        expect(cfg.sorobanRpcUrl).toBe('https://soroban-testnet.stellar.org')
        expect(cfg.indexerUrl).toBe('http://localhost:8070')
    })

    test('throws when TRADER_SECRET is missing', () => {
        expect(() => load(VALID, {secret: null})).toThrow(/TRADER_SECRET/)
    })

    test('throws a clear error when the config file cannot be read', () => {
        expect(() => load(new Error('ENOENT'))).toThrow(/Cannot load config "testnet"/)
    })

    test('throws when fewer than 2 tokens', () => {
        expect(() => load({...VALID, tokens: [VALID.tokens[0]]})).toThrow(/at least 2 tokens/)
    })

    test('throws when a token price is not a positive number', () => {
        expect(() => load({...VALID, tokens: [VALID.tokens[0], {token: 'C_X', symbol: 'X', price: 0}]}))
            .toThrow(/price must be > 0/)
    })
})
