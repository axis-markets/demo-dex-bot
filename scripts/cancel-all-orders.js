const {Keypair} = require('@stellar/stellar-sdk')
const cfg = require('../src/config.js')
const {makeSignTransaction} = require('../src/sign-keypair.js')

//cancels every open order of each trader account listed in TRADER_SECRETS
;(async () => {
    //the client is an ES module
    const {Axis} = await import('@axis-markets/client')
    const axis = new Axis({
        apiUrl: cfg.indexerUrl,
        rpcUrl: cfg.sorobanRpcUrl,
        contractId: cfg.axisContractId,
        networkPassphrase: cfg.networkPassphrase
    })
    await axis.connect()
    console.log(`[cancel] config=${cfg.configName} traders=${cfg.traderSecrets.length} contract=${axis.contractId}`)

    const traders = cfg.traderSecrets.map((secret, i) => {
        const keypair = Keypair.fromSecret(secret)
        const account = axis.account(keypair.publicKey(), {
            signTransaction: makeSignTransaction(keypair, cfg.networkPassphrase)
        })
        return {label: `trader ${i + 1}`, account}
    })

    //each trader signs from its own account (own sequence), so they cancel in parallel
    const results = await Promise.all(traders.map(async ({label, account}) => {
        try {
            await account.ready
            console.log(`[${label}] address=${account.address} open orders=${account.orders.size}`)
            const ids = await account.cancelAll()
            console.log(`[${label}] cancelled ${ids.length} orders${ids.length ? ': ' + ids.join(',') : ''}`)
            return true
        } catch (e) {
            console.error(`[${label}] cancel failed:`, e.message || e)
            return false
        }
    }))

    axis.close()
    const failed = results.filter(ok => !ok).length
    if (failed) {
        console.error(`[cancel] ${failed} of ${traders.length} traders failed`)
        process.exit(1)
    }
    console.log('[cancel] done')
    process.exit(0)
})().catch(e => {
    console.error('[cancel] fatal:', e)
    process.exit(1)
})
