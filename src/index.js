const {Keypair} = require('@stellar/stellar-sdk')
const cfg = require('./config.js')
const {makeSignTransaction} = require('./sign-keypair.js')
const TradingBot = require('./trading-bot.js')

;(async () => {
    //the client is an ES module
    const {Axis, OrderKind} = await import('@axis-markets/client')
    //no default signer: every transaction, requotes included, is signed by the trader that sends it
    //the contract address comes from the aggregator unless the config pins it
    const axis = new Axis({
        apiUrl: cfg.indexerUrl,
        rpcUrl: cfg.sorobanRpcUrl,
        contractId: cfg.axisContractId,
        networkPassphrase: cfg.networkPassphrase
    })
    axis.on('connection', open => console.log(`[bot] aggregator push connection ${open ? 'open' : 'lost, polling'}`))
    await axis.connect()
    //each trader's open orders and backing in memory, over the shared connection; trades carry the approvals they need
    const traders = cfg.traderSecrets.map((secret, i) => {
        const keypair = Keypair.fromSecret(secret)
        const signer = {
            publicKey: keypair.publicKey(),
            signTransaction: makeSignTransaction(keypair, cfg.networkPassphrase)
        }
        const label = `trader ${i + 1}`
        const account = axis.account(signer.publicKey, {signTransaction: signer.signTransaction})
        account.on('fill', ({order, sold, bought}) => console.log(`[${label}] order ${order.id} partially filled: sold ${sold}, bought ${bought}`))
        account.on('filled', ({order, sold, bought}) => console.log(`[${label}] order ${order.id} filled: sold ${sold}, bought ${bought}`))
        account.on('expire', order => console.log(`[${label}] order ${order.id} expired`))
        return {label, account, signer}
    })
    await Promise.all(traders.map(t => t.account.ready))

    const bot = new TradingBot({axis, traders, OrderKind, config: cfg})

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

    console.log(`[bot] config=${cfg.configName} traders=${traders.length}`)
    console.log(`[bot] tokens=${cfg.tokens.map(t => t.symbol).join(',')} stddev=${cfg.priceStddev} amount=(${cfg.amountMin}..${cfg.amountMax}) maxPositions=${cfg.maxPositions} per trader`)
    console.log(`[bot] aggregator=${cfg.indexerUrl} rpc=${cfg.sorobanRpcUrl} contract=${axis.contractId} markets=${axis.markets.size}`)
    for (const trader of traders) {
        const tradable = bot.tradableTokens(trader).map(t => t.symbol).join(',') || 'none'
        console.log(`[${trader.label}] address=${trader.account.address} open orders=${trader.account.orders.size} tradable=${tradable}`)
    }
    bot.start()
})().catch(e => {
    console.error('[bot] fatal:', e)
    process.exit(1)
})
