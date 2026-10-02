require('dotenv').config()

const fs = require('fs')
const path = require('path')

function env(name, fallback) {
    const v = process.env[name]
    if (v == null) return fallback
    const s = String(v).trim()
    return s.length ? s : fallback
}

//most virtual traders the bot runs, one account each
const MAX_TRADERS = 10

const TRADER_SECRETS = env('TRADER_SECRETS', '').split(/[\s,]+/).filter(Boolean)
if (!TRADER_SECRETS.length)
    throw new Error('TRADER_SECRETS is required (comma-separated secret keys, set it in .env or environment)')
if (TRADER_SECRETS.length > MAX_TRADERS)
    throw new Error(`TRADER_SECRETS lists ${TRADER_SECRETS.length} keys, at most ${MAX_TRADERS} traders are supported`)
//a duplicate would share one account and its transaction sequence with another trader
if (new Set(TRADER_SECRETS).size !== TRADER_SECRETS.length)
    throw new Error('TRADER_SECRETS lists the same key more than once')

const CONFIG_NAME = env('CONFIG_NAME', 'testnet')
const configPath = path.resolve(process.cwd(), `${CONFIG_NAME}.config.json`)

let parsed
try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (e) {
    throw new Error(`Cannot load config "${CONFIG_NAME}" from ${configPath}: ${e.message}`)
}

function num(name, value) {
    const n = Number(value)
    if (!Number.isFinite(n))
        throw new Error(`Invalid number for "${name}" in ${configPath}: ${value}`)
    return n
}

if (typeof parsed.axisContractId !== 'string' || !parsed.axisContractId)
    throw new Error(`axisContractId is required in ${configPath}`)

const decimals = num('decimals', parsed.decimals)

if (!Array.isArray(parsed.tokens) || parsed.tokens.length < 2)
    throw new Error(`config "${CONFIG_NAME}" must define at least 2 tokens`)

const tokens = parsed.tokens.map((t, i) => {
    if (!t || typeof t.token !== 'string' || !t.token)
        throw new Error(`tokens[${i}].token is required in ${configPath}`)
    if (typeof t.symbol !== 'string' || !t.symbol)
        throw new Error(`tokens[${i}].symbol is required in ${configPath}`)
    const price = num(`tokens[${i}].price`, t.price)
    if (price <= 0)
        throw new Error(`tokens[${i}].price must be > 0 in ${configPath}`)
    return {token: t.token, symbol: t.symbol, price}
})

module.exports = {
    configName: CONFIG_NAME,
    traderSecrets: TRADER_SECRETS,
    networkPassphrase: parsed.networkPassphrase || 'Test SDF Network ; September 2015',
    sorobanRpcUrl: (parsed.sorobanRpcUrl || 'https://soroban-testnet.stellar.org').replace(/\/$/, ''),
    indexerUrl: env('INDEXER_URL', parsed.indexerUrl || 'http://localhost:8070').replace(/\/$/, ''),
    axisContractId: parsed.axisContractId,
    decimals,
    priceStddev: num('priceStddev', parsed.priceStddev),
    amountMin: num('amountMin', parsed.amountMin),
    amountMax: num('amountMax', parsed.amountMax),
    maxPositions: num('maxPositions', parsed.maxPositions),
    tradeMin: num('tradeMin', parsed.tradeMin),
    tradeMax: num('tradeMax', parsed.tradeMax),
    tokens
}
