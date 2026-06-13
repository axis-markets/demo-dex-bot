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

module.exports = {gaussRandom, uniform, randomInt, randomSide}
