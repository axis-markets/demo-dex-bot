const {Keypair, TransactionBuilder, Account, Operation, Asset, Networks} = require('@stellar/stellar-sdk')
const {makeSignTransaction} = require('../src/sign-keypair.js')

function buildSampleXdr(keypair, networkPassphrase) {
    //Build a trivial classic tx so we have a real XDR to sign.
    const account = new Account(keypair.publicKey(), '0')
    const tx = new TransactionBuilder(account, {fee: '100', networkPassphrase})
        .addOperation(Operation.payment({
            destination: keypair.publicKey(),
            asset: Asset.native(),
            amount: '1'
        }))
        .setTimeout(60)
        .build()
    return tx.toXDR()
}

describe('makeSignTransaction', () => {
    const passphrase = Networks.TESTNET

    test('returns an envelope with a signature attached', async () => {
        const keypair = Keypair.random()
        const xdr = buildSampleXdr(keypair, passphrase)
        const sign = makeSignTransaction(keypair, passphrase)
        const {signedTxXdr, signerAddress} = await sign(xdr)

        expect(signerAddress).toBe(keypair.publicKey())
        expect(typeof signedTxXdr).toBe('string')
        const signedTx = TransactionBuilder.fromXDR(signedTxXdr, passphrase)
        expect(signedTx.signatures.length).toBe(1)
    })

    test('uses ctx.networkPassphrase override when provided', async () => {
        const keypair = Keypair.random()
        const xdr = buildSampleXdr(keypair, Networks.PUBLIC)
        //pass the wrong default — override via ctx
        const sign = makeSignTransaction(keypair, Networks.TESTNET)
        const {signedTxXdr} = await sign(xdr, {networkPassphrase: Networks.PUBLIC})
        const signedTx = TransactionBuilder.fromXDR(signedTxXdr, Networks.PUBLIC)
        expect(signedTx.signatures.length).toBe(1)
    })
})
