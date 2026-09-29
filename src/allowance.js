/**
 * Allowance lifetime granted with a trade, in ledgers: ~30 days at 5 s per ledger (the network caps an allowance
 * TTL at the maximum entry TTL, ~180 days)
 */
const APPROVAL_TTL_LEDGERS = 518_400

/**
 * Remaining amount of the owner's active orders selling `asset`, across every market
 * @param {Array<{status: string, selling: string, amount: string}>} orders - Owner's orders from the indexer
 * @param {string} asset - Token contract address
 * @return {bigint}
 */
function committedAmount(orders, asset) {
    let sum = 0n
    for (const order of orders) {
        if (order.status === 'ACTIVE' && order.selling === asset) {
            sum += BigInt(order.amount)
        }
    }
    return sum
}

/**
 * Decide whether a trade needs an in-call approval and size it. The approval amount is absolute, so it has to cover
 * this trade plus every resting order selling the same asset, otherwise it would leave those orders unbacked.
 * @param {{required: bigint, committed: bigint, allowance: bigint, ledger: number}} params - `required` is the most
 * of the selling asset the trade may spend, `committed` the resting orders selling it, `allowance` the current one
 * @return {{amount: bigint, liveUntil: number}|undefined} - Approval to pass with the trade, undefined when the current
 * allowance covers it
 */
function planApproval({required, committed, allowance, ledger}) {
    const target = required + committed
    if (allowance >= target)
        return undefined
    return {amount: target, liveUntil: ledger + APPROVAL_TTL_LEDGERS}
}

/**
 * Upper bound of the quote tokens a buy may spend: `ceil(amount × price / 10^18)`, the contract rounds the taker's
 * cost up at the maker's price and never fills above the limit price
 * @param {bigint} amount - Base amount, raw units
 * @param {bigint} price - Limit price, contract scale (quote per base)
 * @return {bigint}
 */
function maxQuoteSpend(amount, price) {
    const precision = 10n ** 18n
    return (amount * price + precision - 1n) / precision
}

module.exports = {APPROVAL_TTL_LEDGERS, committedAmount, planApproval, maxQuoteSpend}
