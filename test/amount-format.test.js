const {humanToRaw, displayPriceToContract} = require('../src/amount-format.js')

describe('humanToRaw', () => {
    test('parses decimal string at 7 decimals', () => {
        expect(humanToRaw('1.5', 7)).toBe(15_000_000n)
        expect(humanToRaw('0.05', 7)).toBe(500_000n)
        expect(humanToRaw('0.0000001', 7)).toBe(1n)
    })

    test('returns 0n for empty / null / invalid', () => {
        expect(humanToRaw(null, 7)).toBe(0n)
        expect(humanToRaw('', 7)).toBe(0n)
        expect(humanToRaw('   ', 7)).toBe(0n)
        expect(humanToRaw('abc', 7)).toBe(0n)
    })

    test('truncates excess fractional digits (does not round)', () => {
        expect(humanToRaw('0.123456789', 7)).toBe(1_234_567n)
        expect(humanToRaw('0.99999999', 7)).toBe(9_999_999n)
    })

    test('handles integer-only input', () => {
        expect(humanToRaw('42', 7)).toBe(420_000_000n)
        expect(humanToRaw('0', 7)).toBe(0n)
    })

    test('handles negative values', () => {
        expect(humanToRaw('-1.5', 7)).toBe(-15_000_000n)
    })

    test('accepts Number input via toFixed', () => {
        expect(humanToRaw(1.5, 7)).toBe(15_000_000n)
        expect(humanToRaw(0, 7)).toBe(0n)
    })

    test('rejects NaN / Infinity numbers', () => {
        expect(humanToRaw(NaN, 7)).toBe(0n)
        expect(humanToRaw(Infinity, 7)).toBe(0n)
    })
})

describe('displayPriceToContract', () => {
    test('equal decimals (7/7) → scale by 10^18', () => {
        expect(displayPriceToContract('1.2', 7, 7)).toBe(1_200_000_000_000_000_000n)
        expect(displayPriceToContract('1', 7, 7)).toBe(1_000_000_000_000_000_000n)
    })

    test('uses string path to avoid IEEE-754 drift at 10^18', () => {
        //Number 1.2 → toFixed(18) drifts; verify the string path stays exact.
        expect(displayPriceToContract('1.2', 7, 7)).toBe(1_200_000_000_000_000_000n)
    })

    test('asymmetric decimals adjust exponent', () => {
        //baseDec=7, quoteDec=6 → exp = 17 → 1.0 × 10^17
        expect(displayPriceToContract('1', 7, 6)).toBe(10n ** 17n)
        //baseDec=6, quoteDec=7 → exp = 19
        expect(displayPriceToContract('1', 6, 7)).toBe(10n ** 19n)
    })

    test('returns 0n when total exponent goes negative', () => {
        expect(displayPriceToContract('1', 30, 6)).toBe(0n)
    })
})
