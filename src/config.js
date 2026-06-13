require('dotenv').config()

function env(name, fallback) {
    const v = process.env[name]
    if (v == null) return fallback
    const s = String(v).trim()
    return s.length ? s : fallback
}

function envNum(name, fallback) {
    const raw = env(name, null)
    if (raw == null) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n))
        throw new Error(`Invalid number for ${name}: ${raw}`)
    return n
}

const TRADER_SECRET = env('TRADER_SECRET', null)
if (!TRADER_SECRET)
    throw new Error('TRADER_SECRET is required (set it in .env or environment)')

const NETWORK_PASSPHRASE = env('NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015')
const SOROBAN_RPC_URL = env('SOROBAN_RPC_URL', 'https://soroban-testnet.stellar.org').replace(/\/$/, '')
const INDEXER_URL = env('INDEXER_URL', 'http://localhost:8070').replace(/\/$/, '')
const AXIS_CONTRACT_ID = env('AXIS_CONTRACT_ID', 'CBEZ2CDRLUBPDX5ML5TX6LR5L2SCQUXSMNIJFWC4QPKO4CS4I7E2LDFK')

const BASE_CONTRACT = env('BASE_CONTRACT', 'CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ')
const QUOTE_CONTRACT = env('QUOTE_CONTRACT', 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA')

const BASE_DECIMALS = envNum('BASE_DECIMALS', 7)
const QUOTE_DECIMALS = envNum('QUOTE_DECIMALS', 7)

const REFERENCE_PRICE = envNum('REFERENCE_PRICE', 1.2)
const PRICE_STDDEV = envNum('PRICE_STDDEV', 0.02)
const AMOUNT_MIN = envNum('AMOUNT_MIN', 0.01)
const AMOUNT_MAX = envNum('AMOUNT_MAX', 0.2)
const MAX_POSITIONS = envNum('MAX_POSITIONS', 15)

const TRADE_MIN = envNum('TRADE_MIN', 3 * 60)
const TRADE_MAX = envNum('TRADE_MAX', 5 * 60 * 1000)

module.exports = {
    TRADER_SECRET,
    NETWORK_PASSPHRASE,
    SOROBAN_RPC_URL,
    INDEXER_URL,
    AXIS_CONTRACT_ID,
    BASE_CONTRACT,
    QUOTE_CONTRACT,
    BASE_DECIMALS,
    QUOTE_DECIMALS,
    REFERENCE_PRICE,
    PRICE_STDDEV,
    AMOUNT_MIN,
    AMOUNT_MAX,
    MAX_POSITIONS,
    TRADE_MIN,
    TRADE_MAX
}
