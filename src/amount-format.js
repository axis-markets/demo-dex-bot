/**
 * Convert a human value to a raw bigint, given decimals.
 * String input preserves what was typed (no IEEE-754 drift at 10^18 scale).
 * Excess fractional digits are TRUNCATED.
 * @param {string|number} value
 * @param {number} decimals
 * @return {bigint}
 */
function humanToRaw(value, decimals) {
    if (value == null) return 0n
    const str = typeof value === 'string'
        ? value
        : (Number.isFinite(value) ? value.toFixed(decimals) : null)
    if (str == null) return 0n
    const trimmed = str.trim()
    if (!trimmed) return 0n
    const m = trimmed.match(/^(-)?(\d*)(?:\.(\d*))?$/)
    if (!m) return 0n
    const sign = m[1] ? -1n : 1n
    const whole = m[2] || '0'
    const frac = m[3] || ''
    const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals)
    return sign * BigInt(whole + paddedFrac)
}

/**
 * Convert a display price (quote-per-base) to the contract's i128 price.
 *   contract_price = displayPrice × 10^(18 + D_q − D_b)
 * Pass a string for `displayPrice` whenever precision matters.
 * @param {string|number} displayPrice
 * @param {number} baseDecimals
 * @param {number} quoteDecimals
 * @return {bigint}
 */
function displayPriceToContract(displayPrice, baseDecimals, quoteDecimals) {
    const totalExp = 18 + quoteDecimals - baseDecimals
    if (totalExp < 0) return 0n
    return humanToRaw(displayPrice, totalExp)
}

module.exports = {humanToRaw, displayPriceToContract}
