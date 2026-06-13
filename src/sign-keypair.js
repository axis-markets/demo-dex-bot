const {TransactionBuilder} = require('@stellar/stellar-sdk')

/**
 * Build a contract-client signTransaction callback backed by a local keypair.
 * Matches the SignTransactionCallback shape used by AssembledTransaction.signAndSend().
 * @param {import('@stellar/stellar-sdk').Keypair} keypair
 * @param {string} defaultPassphrase
 * @return {(xdr: string, ctx?: {networkPassphrase?: string}) => Promise<{signedTxXdr: string, signerAddress: string}>}
 */
function makeSignTransaction(keypair, defaultPassphrase) {
    return async (xdr, ctx) => {
        const passphrase = ctx?.networkPassphrase ?? defaultPassphrase
        const tx = TransactionBuilder.fromXDR(xdr, passphrase)
        tx.sign(keypair)
        return {signedTxXdr: tx.toXDR(), signerAddress: keypair.publicKey()}
    }
}

module.exports = {makeSignTransaction}
