/**
 * TOON Format Encoder/Decoder
 * Uses the official @toon-format/toon reference implementation
 *
 * The reference implementation is published as an ES module only, so it is
 * loaded once with a dynamic import() at startup (initToon) instead of
 * require(). This keeps the gateway working on every supported Node version
 * rather than depending on require(esm) support.
 */

let toon = null;

/**
 * Loads the TOON reference implementation. Must complete before
 * encodeToToon/decodeFromToon are called.
 * @returns {Promise<object>} the loaded @toon-format/toon module
 */
async function initToon() {
    if (!toon) {
        toon = await import('@toon-format/toon');
    }
    return toon;
}

function getToon() {
    if (!toon) {
        throw new Error('TOON codec not initialized: await initToon() first');
    }
    return toon;
}

/**
 * Encodes a JavaScript value to TOON format
 * @param {any} data - JavaScript value (object, array, primitive)
 * @param {object} options - Encoding options
 * @param {string} options.delimiter - Delimiter: ',' (default), '\t', or '|'
 * @param {number} options.indent - Indentation spaces (default: 2)
 * @param {Function} options.replacer - Transforms or omits values while encoding
 * @returns {string} TOON formatted string
 */
function encodeToToon(data, options = {}) {
    return getToon().encode(data, options);
}

/**
 * Decodes a TOON formatted string to JavaScript value
 * @param {string} toonString - TOON formatted string
 * @param {object} options - Decoding options
 * @param {boolean} options.strict - Enable strict mode validation (default: true)
 * @param {number} options.indent - Expected indentation size (default: 2)
 * @returns {any} JavaScript value
 */
function decodeFromToon(toonString, options = {}) {
    return getToon().decode(toonString, options);
}

module.exports = {
    initToon,
    encodeToToon,
    decodeFromToon,
    // Access the loaded toon module for advanced usage (after initToon)
    getToon
};
