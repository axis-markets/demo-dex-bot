const {Keypair} = require('@stellar/stellar-sdk')
const cfg = require('./config.js')
const {makeSignTransaction} = require('./sign-keypair.js')
const TradingBot = require('./trading-bot.js')

;(async () => {
    //the client is an ES module
    const {Axis, OrderKind} = await import('@axis-markets/client')
    const keypair = Keypair.fromSecret(cfg.traderSecret)
    const signer = {
        publicKey: keypair.publicKey(),
        signTransaction: makeSignTransaction(keypair, cfg.networkPassphrase)
    }
    //contract state and markets, pushed by the Aggregator over a WebSocket
    const axis = new Axis({
        apiUrl: cfg.indexerUrl,
        rpcUrl: cfg.sorobanRpcUrl,
        contractId: cfg.axisContractId,
        networkPassphrase: cfg.networkPassphrase,
        signer
    })
    axis.on('connection', open => console.log(`[bot] aggregator push connection ${open ? 'open' : 'lost, polling'}`))
    await axis.connect()
    //the bot's open orders and backing in memory; trades carry the approvals they need
    const account = axis.account(signer.publicKey, {signTransaction: signer.signTransaction})
    account.on('fill', ({order, sold, bought}) => console.log(`[bot] order ${order.id} partially filled: sold ${sold}, bought ${bought}`))
    account.on('filled', ({order, sold, bought}) => console.log(`[bot] order ${order.id} filled: sold ${sold}, bought ${bought}`))
    account.on('expire', order => console.log(`[bot] order ${order.id} expired`))
    await account.ready

    const bot = new TradingBot({axis, account, OrderKind, config: cfg})

    let shuttingDown = false
    function shutdown() {
        if (shuttingDown) return
        shuttingDown = true
        console.log('\n[bot] shutting down…')
        bot.stop()
        axis.close()
        setTimeout(() => process.exit(0), 100)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    console.log(`[bot] config=${cfg.configName} trader=${keypair.publicKey()}`)
    console.log(`[bot] tokens=${cfg.tokens.map(t => t.symbol).join(',')} stddev=${cfg.priceStddev} amount=(${cfg.amountMin}..${cfg.amountMax}) maxPositions=${cfg.maxPositions}`)
    console.log(`[bot] aggregator=${cfg.indexerUrl} rpc=${cfg.sorobanRpcUrl} contract=${cfg.axisContractId} markets=${axis.markets.size} open orders=${account.orders.size}`)
    bot.start()
})().catch(e => {
    console.error('[bot] fatal:', e)
    process.exit(1)
})
