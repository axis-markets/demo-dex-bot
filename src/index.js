const {Keypair} = require('@stellar/stellar-sdk')
const cfg = require('./config.js')
const {makeSignTransaction} = require('./sign-keypair.js')
const TradingBot = require('./trading-bot.js')
const TokenState = require('./token-state.js')

;(async () => {
    //the client is an ES module; its CJS bundle is a build artifact of the linked checkout
    const {AxisContractClient, OrderKind} = await import('@axis-markets/client')
    const keypair = Keypair.fromSecret(cfg.traderSecret)
    const axis = new AxisContractClient({
        publicKey: keypair.publicKey(),
        signTransaction: makeSignTransaction(keypair, cfg.networkPassphrase),
        rpcUrl: cfg.sorobanRpcUrl,
        contractId: cfg.axisContractId,
        networkPassphrase: cfg.networkPassphrase
    })
    const tokenState = new TokenState({
        rpcUrl: cfg.sorobanRpcUrl,
        networkPassphrase: cfg.networkPassphrase,
        spender: cfg.axisContractId
    })

    const bot = new TradingBot({axis, OrderKind, trader: keypair.publicKey(), config: cfg, tokenState})

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

    console.log(`[bot] config=${cfg.configName} trader=${keypair.publicKey()}`)
    console.log(`[bot] tokens=${cfg.tokens.map(t => t.symbol).join(',')} stddev=${cfg.priceStddev} amount=(${cfg.amountMin}..${cfg.amountMax}) maxPositions=${cfg.maxPositions}`)
    console.log(`[bot] indexer=${cfg.indexerUrl} rpc=${cfg.sorobanRpcUrl} contract=${cfg.axisContractId}`)
    bot.start()
})().catch(e => {
    console.error('[bot] fatal:', e)
    process.exit(1)
})
