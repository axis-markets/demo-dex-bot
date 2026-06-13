const {Keypair} = require('@stellar/stellar-sdk')
const cfg = require('./config.js')
const {makeSignTransaction} = require('./sign-keypair.js')
const TradingBot = require('./trading-bot.js')

;(async () => {
    //contract-client is published as ESM-only — load via dynamic import from CJS
    const {AxisContractClient, OrderKind} = await import('@axis-markets/contract-client/src/index.js')

    const keypair = Keypair.fromSecret(cfg.TRADER_SECRET)
    const axis = new AxisContractClient({
        publicKey: keypair.publicKey(),
        signTransaction: makeSignTransaction(keypair, cfg.NETWORK_PASSPHRASE),
        rpcUrl: cfg.SOROBAN_RPC_URL,
        contractId: cfg.AXIS_CONTRACT_ID,
        networkPassphrase: cfg.NETWORK_PASSPHRASE
    })

    const bot = new TradingBot({axis, OrderKind, trader: keypair.publicKey(), config: cfg})

    let shuttingDown = false
    function shutdown() {
        if (shuttingDown) return
        shuttingDown = true
        console.log('\n[bot] shutting down…')
        bot.stop()
        setTimeout(() => process.exit(0), 100)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    console.log(`[bot] trader=${keypair.publicKey()}`)
    console.log(`[bot] pair=EURC/USDC ref=${cfg.REFERENCE_PRICE} stddev=${cfg.PRICE_STDDEV} amount=(${cfg.AMOUNT_MIN}..${cfg.AMOUNT_MAX})`)
    console.log(`[bot] indexer=${cfg.INDEXER_URL} rpc=${cfg.SOROBAN_RPC_URL} contract=${cfg.AXIS_CONTRACT_ID}`)
    bot.start()
})().catch(e => {
    console.error('[bot] fatal:', e)
    process.exit(1)
})
