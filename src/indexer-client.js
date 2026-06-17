const {indexerUrl} = require('./config.js')

/**
 * @typedef {Object} IndexerOrder
 * @property {string} id
 * @property {'ACTIVE'|'FILLED'|'CANCELED'} status
 * @property {'LIMIT'} kind
 * @property {string} buying
 * @property {string} selling
 * @property {string} price
 * @property {number} rprice
 * @property {string} quote
 * @property {string} amount
 * @property {string} owner
 * @property {string} expires
 * @property {string} [created]
 * @property {string} [updated]
 * @property {string} cursor
 */

async function request(path, params, signal) {
    const url = new URL(indexerUrl + path)
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v == null) continue
            if (Array.isArray(v)) {
                for (const item of v) url.searchParams.append(k, item)
            } else {
                url.searchParams.set(k, String(v))
            }
        }
    }
    const res = await fetch(url, {signal})
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Indexer ${res.status} on ${path}: ${text || res.statusText}`)
    }
    return res.json()
}

/**
 * @param {{owner?: string, asset?: string|string[], limit?: number, cursor?: string}} [opts]
 * @param {AbortSignal} [signal]
 * @return {Promise<IndexerOrder[]>}
 */
function getOrders(opts = {}, signal) {
    return request('/order', opts, signal)
}

/**
 * Page through `/order` until `maxTotal` orders collected or server runs out.
 * @param {{owner?: string, asset?: string|string[], maxTotal?: number, pageSize?: number}} [opts]
 * @param {AbortSignal} [signal]
 * @return {Promise<IndexerOrder[]>}
 */
async function getOrdersPaginated(opts = {}, signal) {
    const maxTotal = opts.maxTotal ?? 1000
    const pageSize = Math.min(opts.pageSize ?? 200, 200)
    const out = []
    let cursor
    while (out.length < maxTotal) {
        const page = await getOrders({
            owner: opts.owner,
            asset: opts.asset,
            limit: Math.min(pageSize, maxTotal - out.length),
            cursor
        }, signal)
        if (!page.length) break
        out.push(...page)
        if (page.length < pageSize) break
        cursor = page[page.length - 1].cursor
    }
    return out
}

module.exports = {getOrders, getOrdersPaginated}
