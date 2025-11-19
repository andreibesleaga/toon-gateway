/**
 * TOON Format Encoder/Decoder
 * Uses the official @toon-format/toon reference implementation
 */

const toon = require('@toon-format/toon');

/**
 * Encodes a JavaScript value to TOON format
 * @param {any} data - JavaScript value (object, array, primitive)
 * @param {object} options - Encoding options
 * @param {string} options.delimiter - Delimiter: ',' (default), '\t', or '|'
 * @param {number} options.indent - Indentation spaces (default: 2)
 * @param {string} options.keyFolding - Key folding mode: 'off' or 'safe' (default: 'off')
 * @param {number} options.flattenDepth - Max depth for key folding (default: Infinity)
 * @returns {string} TOON formatted string
 */
function encodeToToon(data, options = {}) {
    return toon.encode(data, options);
}

/**
 * Decodes a TOON formatted string to JavaScript value
 * @param {string} toonString - TOON formatted string
 * @param {object} options - Decoding options
 * @param {boolean} options.strict - Enable strict mode validation (default: true)
 * @param {string} options.expandPaths - Path expansion mode: 'off' or 'safe' (default: 'off')
 * @param {number} options.indentSize - Expected indentation size (default: 2)
 * @returns {any} JavaScript value
 */
function decodeFromToon(toonString, options = {}) {
    return toon.decode(toonString, options);
}

module.exports = { 
    encodeToToon, 
    decodeFromToon,
    // Export the toon module for advanced usage
    toon
};
