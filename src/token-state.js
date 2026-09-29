const {Account, Address, Contract, TransactionBuilder, rpc, scValToNative} = require('@stellar/stellar-sdk')

/**
 * Stellar RPC reads of token state the bot needs before trading: the allowance granted to the AXIS contract
 * (the contract holds no funds, fills settle with `transfer_from` against the maker's allowance) and the current
 * ledger, which anchors allowance expirations.
 */
class TokenState {
    /**
     * @param {{rpcUrl: string, networkPassphrase: string, spender: string}} options - `spender` is the AXIS contract
     */
    constructor({rpcUrl, networkPassphrase, spender}) {
        this.server = new rpc.Server(rpcUrl, {allowHttp: rpcUrl.startsWith('http://')})
        this.networkPassphrase = networkPassphrase
        this.spender = spender
    }

    /**
     * Allowance `owner` granted to the AXIS contract on a token; the token reports 0 once it expired
     * @param {string} token - Token contract address
     * @param {string} owner - Token holder address
     * @return {Promise<bigint>}
     */
    async getAllowance(token, owner) {
        const args = [new Address(owner).toScVal(), new Address(this.spender).toScVal()]
        const tx = new TransactionBuilder(new Account(owner, '0'), {fee: '100', networkPassphrase: this.networkPassphrase})
            .addOperation(new Contract(token).call('allowance', ...args))
            .setTimeout(30)
            .build()
        const sim = await this.server.simulateTransaction(tx)
        if (rpc.Api.isSimulationError(sim))
            throw new Error(`Allowance simulation failed for ${token}: ${sim.error}`)
        return BigInt(scValToNative(sim.result.retval))
    }

    /**
     * Latest closed ledger sequence
     * @return {Promise<number>}
     */
    async getLatestLedger() {
        const {sequence} = await this.server.getLatestLedger()
        return sequence
    }
}

module.exports = TokenState
