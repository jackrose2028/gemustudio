/**
 * EJS Utility Functions
 */


/**
 * Fast non-cryptographic hash that covers every byte of the input.
 * Reads 32-bit words (4x fewer iterations than a per-byte loop) and finishes with
 * an avalanche step, so similar inputs of the same length still produce different keys.
 * @param {Uint8Array} dataArray
 * @returns {number} Unsigned 32-bit hash.
 */
export function simpleHash(dataArray) {
    const len = dataArray.length;
    const words = len >>> 2;
    let h1 = 0x811c9dc5 ^ len;
    let h2 = 0x9e3779b9;
    if ((dataArray.byteOffset & 3) === 0) {
        const view = new Uint32Array(dataArray.buffer, dataArray.byteOffset, words);
        for (let i = 0; i < words; i++) {
            const w = view[i];
            h1 = Math.imul(h1 ^ w, 0x01000193);
            h2 = Math.imul(h2 + w, 0x85ebca6b) ^ (h2 >>> 15);
        }
    } else {
        for (let i = 0; i < words; i++) {
            const j = i << 2;
            const w = dataArray[j] | (dataArray[j + 1] << 8) | (dataArray[j + 2] << 16) | (dataArray[j + 3] << 24);
            h1 = Math.imul(h1 ^ w, 0x01000193);
            h2 = Math.imul(h2 + w, 0x85ebca6b) ^ (h2 >>> 15);
        }
    }
    for (let i = words << 2; i < len; i++) {
        h1 = Math.imul(h1 ^ dataArray[i], 0x01000193);
    }
    h1 ^= h2;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0xc2b2ae35);
    return (h1 ^ (h1 >>> 16)) >>> 0;
}
/**
 * Cyrb53 hash function adapted for buffers.
 * @param {*} charBuffer 
 * @param {*} seed 
 * @returns {string} Hexadecimal representation of the hash.
 */
export async function cyrb53(charBuffer, seed = 0) {
    // https://stackoverflow.com/questions/7616461
    // Modified to accept a buffer instead of a string and return hex instead of an int
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for(let i = 0, ch; i < charBuffer.length; i++) {
        ch = charBuffer[i];
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1  = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2  = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    // Cyrb53 is a 53-bit hash; we need 14 hex characters to represent it, and the first char will
    // always be 0 or 1 (since it is only 1 bit)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
/**
 * Generate a random GUID string.
 * @returns {string} A GUID in the format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
 */
export function guid() {
    const s4 = () => (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
    return s4() + s4() + "-" + s4() + "-" + s4() + "-" + s4() + "-" + s4() + s4() + s4();
}
