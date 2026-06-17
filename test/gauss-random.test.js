const {gaussRandom, uniform, randomInt, randomSide, sampleTwo} = require('../src/gauss-random.js')

describe('gaussRandom', () => {
    test('mean and stddev approach configured values over many samples', () => {
        const N = 20_000
        let sum = 0
        const samples = new Array(N)
        for (let i = 0; i < N; i++) {
            samples[i] = gaussRandom(1.2, 0.02)
            sum += samples[i]
        }
        const mean = sum / N
        const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / N
        const stddev = Math.sqrt(variance)
        expect(Math.abs(mean - 1.2)).toBeLessThan(0.005)
        expect(Math.abs(stddev - 0.02)).toBeLessThan(0.005)
    })

    test('handles edge case where Math.random returns 0', () => {
        const spy = jest.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValue(0.5)
        const v = gaussRandom(0, 1)
        expect(Number.isFinite(v)).toBe(true)
        spy.mockRestore()
    })
})

describe('uniform', () => {
    test('returns values within [min, max)', () => {
        for (let i = 0; i < 1000; i++) {
            const v = uniform(0.01, 0.2)
            expect(v).toBeGreaterThanOrEqual(0.01)
            expect(v).toBeLessThan(0.2)
        }
    })
})

describe('randomInt', () => {
    test('returns integers within [min, max] inclusive', () => {
        const seen = new Set()
        for (let i = 0; i < 1000; i++) {
            const v = randomInt(3, 7)
            expect(Number.isInteger(v)).toBe(true)
            expect(v).toBeGreaterThanOrEqual(3)
            expect(v).toBeLessThanOrEqual(7)
            seen.add(v)
        }
        //should hit every value in the range eventually
        expect(seen.size).toBe(5)
    })
})

describe('sampleTwo', () => {
    test('returns two distinct members of the input', () => {
        const arr = ['a', 'b', 'c', 'd']
        for (let i = 0; i < 1000; i++) {
            const [x, y] = sampleTwo(arr)
            expect(arr).toContain(x)
            expect(arr).toContain(y)
            expect(x).not.toBe(y)
        }
    })

    test('eventually covers every element across both positions', () => {
        const arr = ['a', 'b', 'c']
        const seen = new Set()
        for (let i = 0; i < 1000; i++) {
            const [x, y] = sampleTwo(arr)
            seen.add(x)
            seen.add(y)
        }
        expect(seen.size).toBe(3)
    })

    test('throws when fewer than 2 elements', () => {
        expect(() => sampleTwo(['only'])).toThrow()
        expect(() => sampleTwo([])).toThrow()
    })
})

describe('randomSide', () => {
    test('returns buy and sell with roughly 50/50 distribution', () => {
        const counts = {buy: 0, sell: 0}
        const N = 10_000
        for (let i = 0; i < N; i++) counts[randomSide()]++
        expect(counts.buy + counts.sell).toBe(N)
        //both within 5% of expected
        expect(Math.abs(counts.buy - N / 2)).toBeLessThan(N * 0.05)
    })
})
