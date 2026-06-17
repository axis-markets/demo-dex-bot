/**
 * Box-Muller normal sample.
 * @param {number} mean
 * @param {number} stddev
 * @return {number}
 */
function gaussRandom(mean, stddev) {
    let u1 = Math.random()
    if (u1 < 1e-12) u1 = 1e-12
    const u2 = Math.random()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return mean + z * stddev
}

/**
 * Uniform float in [min, max).
 * @param {number} min
 * @param {number} max
 * @return {number}
 */
function uniform(min, max) {
    return min + Math.random() * (max - min)
}

/**
 * Inclusive integer in [min, max].
 * @param {number} min
 * @param {number} max
 * @return {number}
 */
function randomInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1))
}

/** @return {'buy'|'sell'} */
function randomSide() {
    return Math.random() < 0.5 ? 'buy' : 'sell'
}

/**
 * Pick two distinct elements from an array, in random order.
 * @template T
 * @param {T[]} arr  array with at least 2 elements
 * @return {[T, T]}
 */
function sampleTwo(arr) {
    if (!Array.isArray(arr) || arr.length < 2)
        throw new Error('sampleTwo requires an array of at least 2 elements')
    const i = randomInt(0, arr.length - 1)
    let j = randomInt(0, arr.length - 2)
    if (j >= i) j++ //skip i so j != i, keeping a uniform distinct pick
    return [arr[i], arr[j]]
}

module.exports = {gaussRandom, uniform, randomInt, randomSide, sampleTwo}
